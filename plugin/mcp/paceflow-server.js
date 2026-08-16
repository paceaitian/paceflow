#!/usr/bin/env node
// PACEflow MCP artifact server(CHG-20260815-02):Codex CLI 上 artifact 写入的唯一入口——用「确定性 artifact-writer」
// 取代 Claude 宿主里的 artifact-writer 子代理(Codex 子代理 prompt 加密 + 子代理内 hooks 零触发,隔离层无法照搬,
// 见 docs/research-2026-08-15-codex-port-feasibility.md)。
//   - 传输:手写 JSON-RPC 2.0 over stdio(newline-delimited),零 npm 依赖(marketplace 安装零步骤);
//   - 上下文:session/cwd 取自 Codex `_meta["x-codex-turn-metadata"]` 或 PACEflow PreToolUse hook 注入参数(lib/context.js);
//   - 写入:lib/artifact-ops.js 按 artifact-writer 指令生成 Write/Edit 操作,lib/writer-pipeline.js 以 artifact-writer
//     身份跑真 pre-tool-use.js / post-tool-use.js 落盘——reservation / owner / 锁 / 完整性门 / schema WARN 全部复用;
//   - 门:调用本 server 的 mcp__paceflow__* 工具在 Codex 侧还先过 hooks/codex-adapter.js 桥接的派遣门(agent-lifecycle-guard)。
// 启动方式(.codex-plugin/plugin.json):{ command: "node", args: ["mcp/paceflow-server.js"], cwd: "." }。
'use strict';
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const paceUtils = require('../hooks/pace-utils');
const { resolveCallContext, businessArgs } = require('./lib/context');
const pipeline = require('./lib/writer-pipeline');
const ops = require('./lib/artifact-ops');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const RESERVE_HELPER = path.join(HOOKS_DIR, 'reserve-artifact-id.js');
const SERVER_NAME = 'paceflow';
const PROTOCOL_VERSION = '2025-06-18';

// ---------------------------------------------------------------------------------------------
// 工具定义(inputSchema 字段名与 artifact-writer prompt 字段同名,下划线代替连字符;hooks/codex-adapter.js
// 把它们序列化回 `key: value` 文本喂派遣门)
// ---------------------------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'get_context',
    description: 'PACEflow 项目上下文(只读):artifact 目录、Project Root、活跃 CHG 列表(id/status/tasks)。写 artifact 前先调用它拿到准确的 CHG-ID。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'reserve_artifact_id',
    description: '原子预留 artifact 编号(等价于 reserve-artifact-id.js helper)。创建 CHG/HOTFIX 前必须先调用,再把返回的 reserved_id 传给 create_chg。同一 session 未消费的预留会被复用;要新编号传 new=true。',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create-chg', 'record-correction'], description: '默认 create-chg' },
        type: { type: 'string', enum: ['change', 'hotfix'], description: 'create-chg 时:change(默认)或 hotfix' },
        count: { type: 'integer', minimum: 1, maximum: 20, description: '一次预留 N 个连号(batch)' },
        new: { type: 'boolean', description: '强制预留新编号(不复用本 session 未消费预留)' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'create_chg',
    description: '创建一个 CHG/HOTFIX:写 changes/<id>-<slug>.md 详情文件 + task.md 索引行(planned,无 APPROVED)。字段与 artifact-writer create-chg 同名。',
    inputSchema: {
      type: 'object',
      required: ['reserved_id', 'title', 'tasks'],
      properties: {
        reserved_id: { type: 'string', description: 'reserve_artifact_id 返回的 CHG-YYYYMMDD-NN / HOTFIX-YYYYMMDD-NN' },
        reserved_file_prefix: { type: 'string', description: 'reserve_artifact_id 返回的 changes/chg-yyyymmdd-nn-<slug>.md(原样)' },
        title: { type: 'string', description: '变更标题(人读,中文)' },
        slug: { type: 'string', description: '英文 kebab-case 文件名 slug(≤50 字符,按 title 语义概括;不给则从 title 的 ASCII 词推导)' },
        tasks: { type: 'array', items: { type: 'string' }, minItems: 1, description: '任务列表,每项 "T-001: 任务标题与验收"(编号可省,按顺序分配)' },
        background: { type: 'string', description: 'Why' },
        scope: { type: 'string', description: 'What' },
        technical_decision: { type: 'string', description: 'How' },
        related_finding: { type: 'string', description: '关联 finding wikilink,如 [[finding-2026-08-15-xxx]]' },
        execution_context: { type: 'string', description: '如 [worktree:: main] [branch:: feat/x];不给则按项目 cwd 推导' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'update_chg',
    description: '更新既有 CHG/HOTFIX:approve(仅批准)/ approve-and-start(批准并开始,需 task_id)/ update-status(改任务状态,联动 frontmatter 与 task.md)/ append(向 implementation / work-record / research 段追加)/ verify(写 VERIFIED)/ review(写 REVIEWED)。字段与 artifact-writer update-chg 同名。',
    inputSchema: {
      type: 'object',
      required: ['target', 'action'],
      properties: {
        target: { type: 'string', description: 'CHG-YYYYMMDD-NN / HOTFIX-YYYYMMDD-NN' },
        action: { type: 'string', enum: ['approve', 'approve-and-start', 'update-status', 'append', 'verify', 'review'] },
        task_id: { type: 'string', description: 'T-NNN(approve-and-start / update-status 必填)' },
        new_status: { type: 'string', description: 'update-status:[ ] / [/] / [x] / [-] / [!]' },
        status_reason: { type: 'string', description: 'new_status=[!] 必填:暂停/阻塞原因' },
        section: { type: 'string', enum: ['tasks', 'implementation', 'work-record', 'research'], description: 'update-status 固定 tasks;append 必填' },
        content: { type: 'string', description: 'append 的内容(work-record 可给纯文本,自动包成表格行)' },
        approval_confirmed: { type: 'boolean', description: 'approve / approve-and-start 必须为 true' },
        approval_source: { type: 'string', enum: ['user-directive', 'ask-user-question', 'accepted-plan', 'prior-approved-plan'] },
        approval_evidence: { type: 'string', description: '用户原话或已确认方案摘要' },
        verify_summary: { type: 'string', description: 'verify:已运行并读取的验证结果' },
        review_confirmed: { type: 'boolean', description: 'review 必须为 true' },
        review_source: { type: 'string', description: 'review:manual 或所选 review agent 名' },
        review_findings: { type: 'string', description: 'review:P0/P1/P2/P3 计数 + 各自处置 wikilink' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'close_chg',
    description: '收口 CHG/HOTFIX(默认收尾路径,一把梭):[ ]/[/] 任务收口为 [x] → 写 implementation_notes 到 ## 实施详情 各 ### T-NNN → status completed → VERIFIED → REVIEWED + ## 审查记录 → status archived + task.md 索引移到 ARCHIVE 下方 + walkthrough.md 新增一行。前提:主 session 已运行并读取验证结果、已编排对抗审计并路由 findings。字段与 artifact-writer close-chg 同名。',
    inputSchema: {
      type: 'object',
      required: ['target', 'verification_confirmed', 'complete_open_tasks', 'review_confirmed', 'review_source', 'review_findings', 'verify_summary', 'implementation_notes', 'walkthrough_summary'],
      properties: {
        target: { type: 'string', description: 'CHG-YYYYMMDD-NN / HOTFIX-YYYYMMDD-NN' },
        verification_confirmed: { type: 'boolean', description: '必须为 true:主 session 已运行并读取验证结果' },
        complete_open_tasks: { type: 'boolean', description: '必须为 true:允许把 [ ]/[/] 任务收口为 [x]' },
        review_confirmed: { type: 'boolean', description: '必须为 true:对抗审计已跑并路由 findings' },
        review_source: { type: 'string', description: 'manual 或所选 review agent 名' },
        review_findings: { type: 'string', description: 'P0/P1/P2/P3 计数 + 各自处置 wikilink' },
        verify_summary: { type: 'string', description: '已运行并读取的验证结果' },
        implementation_notes: { type: 'array', items: { type: 'string' }, description: '每项 "T-NNN: 该任务实际改动(文件/关键实现/commit)"' },
        walkthrough_summary: { type: 'string', description: '一行完成摘要(写入 walkthrough.md)' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'record_finding',
    description: '记录调研/观察/对比/bug-report finding:写 changes/findings/finding-yyyy-mm-dd-<slug>.md(body 原样)+ findings.md 索引行(最新在顶)。字段与 artifact-writer record-finding 同名。',
    inputSchema: {
      type: 'object',
      required: ['title', 'summary', 'type', 'impact', 'body'],
      properties: {
        title: { type: 'string' },
        summary: { type: 'string', description: '≤200 字符' },
        type: { type: 'string', enum: ['research', 'observation', 'comparison', 'bug-report'] },
        impact: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        body: { type: 'string', description: '完整 Markdown 正文(原样写入)' },
        slug: { type: 'string', description: '英文 kebab-case slug(不给则从 title 推导)' },
        status: { type: 'string', enum: ['open', 'investigating', 'accepted', 'rejected', 'merged', 'blocked'], description: '默认 open;rejected 需 rejection_reason' },
        rejection_reason: { type: 'string', description: 'status=rejected 时必填(≥10 字符)' },
        related_changes: { type: 'array', items: { type: 'string' }, description: '关联 CHG wikilink 列表' },
        merges: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: true,
    },
  },
];

const NOT_IMPLEMENTED = {
  archive_chg: '后续版本', update_finding: '后续版本', record_correction: '后续版本', update_index: '后续版本',
};

// ---------------------------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------------------------

function ok(text, structured) {
  return { content: [{ type: 'text', text }], structuredContent: structured, isError: false };
}
function fail(code, message, extra = {}) {
  return { content: [{ type: 'text', text: `## artifact-writer 报告\n\n**状态**：FAILED\n**失败原因**：\`${code}\`\n\n${message}` }], structuredContent: { status: 'FAILED', code, message, ...extra }, isError: true };
}

function baseCtx(call) {
  const artDir = paceUtils.getArtifactDir(call.cwd);
  return { sessionId: call.sessionId, cwd: call.cwd, turnId: call.turnId, artDir, host: 'codex' };
}

function toolGetContext(call) {
  const ctx = baseCtx(call);
  let active = [];
  try {
    const entries = paceUtils.getActiveChangeEntries(call.cwd) || [];
    active = entries.map((e) => {
      const c = paceUtils.classifyChange(e) || {};
      return { id: e.id, checkbox: e.taskCheckbox, status: c.status || '', category: c.category || '', approved: !!c.approved, verified: !!c.verified, tasks: c.tasks || null, detail: e.detail && !e.detail.missing ? path.relative(paceUtils.getArtifactDir(call.cwd), e.detail.path) : '(missing)' };
    });
  } catch (e) { active = [{ error: String(e.message || e) }]; }
  const info = {
    artifact_dir: ctx.artDir,
    project_root: paceUtils.resolveEffectiveProjectRoot ? paceUtils.resolveEffectiveProjectRoot(call.cwd) : '',
    cwd: call.cwd,
    session_id: call.sessionId,
    execution_context: (paceUtils.executionContextForCwd(call.cwd) || {}).text || '',
    active_changes: active,
  };
  return ok(JSON.stringify(info, null, 2), info);
}

function toolReserve(call, args) {
  const cliArgs = ['--operation', String(args.operation || 'create-chg'), '--cwd', call.cwd];
  if (args.type) cliArgs.push('--type', String(args.type));
  if (args.count) cliArgs.push('--count', String(args.count));
  if (args.new === true) cliArgs.push('--new');
  const r = spawnSync(process.execPath, [RESERVE_HELPER, ...cliArgs], {
    cwd: call.cwd, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: call.sessionId, PACE_HOST: 'codex' },
  });
  const out = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
  if (r.status !== 0) return fail('reserve-failed', out || `reserve helper exit ${r.status}`);
  const reserved = [];
  const blocks = out.split(/# --- reserved \d+\/\d+ ---/).filter((b) => /reserved-id:/.test(b));
  for (const b of (blocks.length ? blocks : [out])) {
    const id = (b.match(/reserved-id:\s*(\S+)/) || [])[1];
    const prefix = (b.match(/reserved-file-prefix:\s*(\S+)/) || [])[1];
    const execCtx = (b.match(/execution-context:\s*([^\n]+)/) || [])[1];
    if (id) reserved.push({ reserved_id: id, reserved_file_prefix: prefix || '', execution_context: (execCtx || '').trim() });
  }
  return ok(`${out}\n\n把 reserved_id / reserved_file_prefix / execution_context 原样传给 create_chg。`, { reserved, raw: out });
}

function runOps(call, build) {
  const ctx = baseCtx(call);
  let plan;
  try { plan = build(ctx); } catch (e) {
    if (e instanceof ops.OpError) return fail(e.code, e.message);
    return fail('internal-error', String(e && e.stack || e));
  }
  if (plan.idempotent) return ok(report({ operation: plan.operation, target: plan.id, status: 'SUCCESS', note: plan.note || 'no change', files: { created: [], modified: [] }, hookNotes: [] }), { status: 'SUCCESS', target: plan.id, idempotent: true });
  const r = pipeline.runPipeline(ctx, plan.ops);
  if (!r.ok) return fail(r.code, `${r.reason}${r.partial ? '\n\n⚠️ 部分写入已落盘(Edit 阶段失败),请人工核对上述文件。' : ''}`, { files: r.files });
  const relFiles = { created: r.files.created.map((f) => path.relative(ctx.artDir, f)), modified: r.files.modified.map((f) => path.relative(ctx.artDir, f)) };
  return ok(report({ operation: plan.operation, target: plan.id, status: 'SUCCESS', files: relFiles, hookNotes: r.hookNotes, extra: plan.extra }), { status: 'SUCCESS', target: plan.id, files: relFiles, hookNotes: r.hookNotes });
}

function report({ operation, target, status, files, hookNotes, note, extra }) {
  const lines = ['## artifact-writer 报告', '', `**操作**：${operation}`, `**Target**：${target}`, `**状态**：${status}`];
  if (note) lines.push(`**说明**：${note}`);
  lines.push('', `**新建文件**：${files.created.length ? files.created.map((f) => `\`${f}\``).join(', ') : '无'}`);
  lines.push(`**修改文件**：${files.modified.length ? files.modified.map((f) => `\`${f}\``).join(', ') : '无'}`);
  if (extra) lines.push('', extra);
  if (hookNotes && hookNotes.length) lines.push('', '**Hook 反馈**：', ...hookNotes.map((n) => `- ${String(n).replace(/\s+/g, ' ').slice(0, 400)}`));
  return lines.join('\n');
}

const TOOL_IMPL = {
  get_context: (call) => toolGetContext(call),
  reserve_artifact_id: (call, args) => toolReserve(call, args),
  create_chg: (call, args) => runOps(call, (ctx) => {
    const plan = ops.buildCreateChg(ctx, args);
    return { ...plan, operation: 'create-chg', extra: `索引行：\`${plan.indexLine}\`\n下一步:用户批准后调 update_chg action=approve-and-start target=${plan.id} task_id=T-001。` };
  }),
  update_chg: (call, args) => runOps(call, (ctx) => ({ ...ops.buildUpdateChg(ctx, args), operation: `update-chg action=${args.action}` })),
  close_chg: (call, args) => runOps(call, (ctx) => ({ ...ops.buildCloseChg(ctx, args), operation: 'close-chg' })),
  record_finding: (call, args) => runOps(call, (ctx) => ({ ...ops.buildRecordFinding(ctx, args), operation: 'record-finding' })),
};

// ---------------------------------------------------------------------------------------------
// JSON-RPC 传输
// ---------------------------------------------------------------------------------------------

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message, data) { send({ jsonrpc: '2.0', id, error: { code, message, data } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: paceUtils.PACE_VERSION || '0.0.0' } });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const rawArgs = (params && params.arguments) || {};
    if (NOT_IMPLEMENTED[name]) return reply(id, fail('not-implemented', `${name} 在 Codex MVP 尚未实现(排期:${NOT_IMPLEMENTED[name]});Claude Code 宿主请派 artifact-writer 子代理执行对应 operation。`));
    const impl = TOOL_IMPL[name];
    if (!impl) return replyError(id, -32602, `unknown tool: ${name}`);
    const call = resolveCallContext(params);
    if (name !== 'get_context' && !call.ok) return reply(id, fail('no-context', call.reason));
    if (!call.ok) return reply(id, fail('no-context', call.reason));
    try {
      const result = impl(call, businessArgs(rawArgs));
      if (call.warnings.length && result && result.structuredContent) result.structuredContent.contextWarnings = call.warnings;
      return reply(id, result);
    } catch (e) {
      return reply(id, fail('internal-error', String(e && e.stack || e)));
    }
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    try { handle(msg); } catch (e) { if (msg && msg.id !== undefined) replyError(msg.id, -32603, String(e && e.message || e)); }
  });
  rl.on('close', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { TOOLS, TOOL_IMPL, handle, NOT_IMPLEMENTED };
