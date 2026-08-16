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
    name: 'archive_chg',
    description: '归档/取消归档已终态的 CHG/HOTFIX(index-only):status=completed 且已 VERIFIED+REVIEWED → status archived + task.md 索引移 ARCHIVE + walkthrough 行;status=cancelled(全部任务 [-])→ 取消式归档([-] 行移 ARCHIVE);已 archived → 只修复索引/walkthrough。刚验证完的默认走 close_chg。',
    inputSchema: {
      type: 'object',
      required: ['target', 'walkthrough_summary'],
      properties: { target: { type: 'string' }, walkthrough_summary: { type: 'string', description: '一行完成/取消摘要(写入 walkthrough.md)' } },
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
  update_finding: '后续版本', record_correction: '后续版本', update_index: '后续版本',
};
// MCP 规范:不支持客户端提的协议版本时回自己支持的版本(审计 P3-11),不无条件回显
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);

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
  // 长驻进程:pace-utils 的 artifact-dir 缓存 / execution-context memo 是按「hook 进程短命」设计的,每次调用先清
  //(审计 P1-3:否则 mid-session set-artifact-root / git checkout 后写错根目录或 [branch::])
  try { paceUtils._clearArtifactDirCache(); } catch (e) { /* 老版本无此导出时忽略 */ }
  try { paceUtils._clearExecCtxMemo(); } catch (e) { /* 同上 */ }
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
    project_root: paceUtils.resolveEffectiveProjectRoot ? (paceUtils.resolveEffectiveProjectRoot(call.cwd) || {}).projectRoot || '' : '',
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
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: call.sessionId, CODEX_THREAD_ID: call.sessionId, PACE_HOST: 'codex' },
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
  const rel = (list) => (list || []).map((f) => path.relative(ctx.artDir, f));
  // 前置管线(如补 task.md 的 ARCHIVE 标记)必须先落盘,后续主管线的 hook 预检才能看到
  if (Array.isArray(plan.prelude) && plan.prelude.length) {
    const pre = pipeline.runPipeline(ctx, plan.prelude);
    if (!pre.ok) return fail(pre.code, `前置修复失败:${pre.reason}`, { files: { created: rel(pre.files.created), modified: rel(pre.files.modified) } });
  }
  const r = pipeline.runPipeline(ctx, plan.ops);
  if (!r.ok) {
    const partialNote = r.partial ? `\n\n⚠️ 部分写入已落盘(Edit 阶段失败),请人工核对:${rel(r.files.modified).join(', ') || '(无)'}` : '';
    return fail(r.code, `${r.reason}${partialNote}`, { files: { created: rel(r.files.created), modified: rel(r.files.modified) } });
  }
  const relFiles = { created: rel(r.files.created), modified: rel(r.files.modified) };
  if (plan.closeOwner) {
    // 收口后把 change owner 记录标 closed(Claude 侧由 SubagentStop 做,Codex 侧无该事件——审计 P3-16)
    try { paceUtils.markChangeOwnerClosed(ctx.cwd, plan.id, { sessionId: ctx.sessionId, operation: 'close-chg' }); } catch (e) { /* owner 记录缺失时忽略 */ }
  }
  const notes = [...(plan.warnings || []).map((w) => `⚠️ ${w}`), ...(r.hookNotes || [])];
  return ok(report({ operation: plan.operation, target: plan.id, status: 'SUCCESS', files: relFiles, hookNotes: notes, extra: plan.extra }), { status: 'SUCCESS', target: plan.id, files: relFiles, hookNotes: r.hookNotes, warnings: plan.warnings || [] });
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
  close_chg: (call, args) => runOps(call, (ctx) => ({ ...ops.buildCloseChg(ctx, args), operation: 'close-chg', closeOwner: true })),
  archive_chg: (call, args) => runOps(call, (ctx) => ({ ...ops.buildArchiveChg(ctx, args), operation: 'archive-chg', closeOwner: true })),
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
    const asked = params && params.protocolVersion;
    return reply(id, { protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: paceUtils.PACE_VERSION || '0.0.0' } });
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
    if (!call.ok) {
      // 诊断信息:把宿主实际给的 _meta 形态回给模型/用户(不同 Codex 版本/平台的 _meta 字段可能不同)
      const metaPreview = JSON.stringify(params && params._meta ? params._meta : null).slice(0, 600);
      return reply(id, fail('no-context', `${call.reason}\n\n宿主提供的 _meta:${metaPreview}\n若 PACEflow hooks 未启用/未信任(Codex /hooks),hook 注入的 _pace_cwd 也不会有——请先信任 hooks 再重试。`));
    }
    try {
      const result = impl(call, businessArgs(rawArgs));
      if (call.warnings.length && result) {
        if (result.structuredContent) result.structuredContent.contextWarnings = call.warnings;
        // 上下文告警(如 hook 注入与宿主 _meta 的 session/cwd 不一致)必须让人读报告可见(审计 P2-5)
        if (result.content && result.content[0] && typeof result.content[0].text === 'string') result.content[0].text += `\n\n**上下文告警**：\n${call.warnings.map((w) => `- ${w}`).join('\n')}`;
      }
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
