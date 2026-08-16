#!/usr/bin/env node
// Codex CLI 宿主适配层(CHG-20260815-01):把 Codex hook 事件翻译成 PACEflow 真 hook 认识的形态后转发,
// 再把真 hook 的输出翻译回 Codex 接受的形态。决策逻辑 100% 在真 hook 里,本文件只做 I/O 翻译:
//   - apply_patch(Codex 唯一的文件写入工具,tool_input.command 是 patch 文本)→ 逐文件合成 Write/Edit 事件,
//     任一 deny 即整体 deny(fail-closed);
//   - mcp__paceflow__<tool>(artifact 写入走 MCP)→ 把结构化参数序列化成 artifact-writer 字段文本,合成
//     Agent 派遣事件转发,原样复用 agent-lifecycle-guard 的全部派遣门;
//   - SessionStart / UserPromptSubmit 的纯文本 stdout 包成 hookSpecificOutput.additionalContext(Codex 要求 JSON);
//   - exit 2 + stderr(Stop 阻断)原样透传;其余非 JSON stdout 包成 systemMessage。
// 用法(hooks.codex.json):node "${CLAUDE_PLUGIN_ROOT}/hooks/codex-adapter.js" <event> [hook 额外参数...]
//   event ∈ session-start | user-prompt-submit | pre-tool-use | post-tool-use | stop | pre-compact | session-end
// 探针依据:docs/research/codex-port/mvp-probes-2026-08-15.md(M1-M8)与 research-2026-08-15-codex-port-feasibility.md(E1-E6)。
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_FILES = {
  'session-start': 'session-start.js',
  'user-prompt-submit': 'user-prompt-submit.js',
  'pre-tool-use': 'pre-tool-use.js',
  'post-tool-use': 'post-tool-use.js',
  'stop': 'stop.js',
  'pre-compact': 'pre-compact.js',
  'session-end': 'session-end.js',
};
const EVENT_NAMES = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse',
  'stop': 'Stop',
  'pre-compact': 'PreCompact',
  'session-end': 'SessionEnd',
};
// MCP 工具名 → artifact-writer operation(白名单外的 mcp__paceflow__* 一律不合成派遣事件,原样转发给真 hook
// 让其按 DENY_BAD_TOOL fail-closed)
const MCP_TOOL_OPERATIONS = {
  create_chg: 'create-chg',
  update_chg: 'update-chg',
  close_chg: 'close-chg',
  archive_chg: 'archive-chg',
  record_finding: 'record-finding',
  update_finding: 'update-finding',
  record_correction: 'record-correction',
  update_index: 'update-index',
};
// 不经派遣门的 MCP 辅助工具(等价于主 session 直接跑 helper 脚本)
const MCP_PASSTHROUGH_TOOLS = new Set(['reserve_artifact_id', 'get_context']);
const MCP_TOOL_PREFIX = 'mcp__paceflow__';
const SPAWN_TIMEOUT_MS = 25000;
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * 解析 apply_patch 文本为文件级操作列表(Add / Update / Delete,含 Move to)。
 * 返回 [{ op, file, moveTo, added, removed }],路径为 patch 原文(相对路径由调用方按 cwd 解析)。
 * 解析不出任何文件头 → 返回空数组(调用方 fail-closed)。
 */
function parseApplyPatch(text) {
  const lines = String(text || '').split(/\r?\n/);
  const files = [];
  let cur = null;
  const headerRe = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
  for (const line of lines) {
    const h = line.match(headerRe);
    if (h) {
      cur = { op: h[1], file: h[2].trim(), moveTo: '', added: [], removed: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    const mv = line.match(/^\*\*\* Move to: (.+)$/);
    if (mv) { cur.moveTo = mv[1].trim(); continue; }
    if (/^\*\*\* (Begin|End) Patch/.test(line) || /^@@/.test(line)) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

/**
 * 把一个 apply_patch 事件展开为 PACEflow 认识的 Write/Edit 事件列表(每文件一个;Move 目标额外一个 Write)。
 */
function applyPatchToClaudeEvents(event) {
  const cwd = event.cwd || process.cwd();
  const files = parseApplyPatch(event.tool_input && event.tool_input.command);
  const out = [];
  for (const f of files) {
    const filePath = path.resolve(cwd, f.file);
    if (f.op === 'Add') {
      out.push({ ...event, tool_name: 'Write', tool_input: { file_path: filePath, content: f.added.join('\n') } });
    } else {
      // Update / Delete 都是对既有文件的变更:Edit 门(含 artifact 完整性门)照常裁判;Delete 的 new_string 为空
      out.push({ ...event, tool_name: 'Edit', tool_input: { file_path: filePath, old_string: f.removed.join('\n'), new_string: f.op === 'Delete' ? '' : f.added.join('\n') } });
    }
    if (f.moveTo) {
      out.push({ ...event, tool_name: 'Write', tool_input: { file_path: path.resolve(cwd, f.moveTo), content: f.added.join('\n') } });
    }
  }
  return out;
}

/**
 * MCP 工具参数 → artifact-writer prompt 字段文本(key_with_underscore → key-with-hyphen;数组/对象展开为缩进列表)。
 * `_` 开头的参数是宿主/hook 注入的元数据,不进 prompt。
 */
function serializeMcpArgs(args, { operation, artifactDir }) {
  const lines = [];
  if (artifactDir) lines.push(`artifact_dir: ${artifactDir}`);
  lines.push(`operation: ${operation}`);
  // 派遣门解析器对同名字段取「第一次出现」:①单行标量先于数组/对象/多行值序列化,防止多行正文里的
  // 「target: X」被先读到;②多行值续行加 `| ` 前缀、列表项带 `- ` 前缀,使 `\n\s*<field>\s*:` 形态的字段
  // 正则不可能命中正文行;③key 只接受 [a-zA-Z][\w-]*,且大小写/连字符归一后等于 operation / artifact_dir
  // 或 `_` 前缀(宿主注入元数据)的一律跳过——保证 operation/artifact_dir 只有 adapter 写的那一行。
  const entries = Object.entries(args || {}).filter(([rawKey, value]) => {
    if (value === undefined || value === null) return false;
    if (!/^[a-zA-Z][\w-]*$/.test(rawKey)) return false;
    const norm = rawKey.toLowerCase().replace(/-/g, '_');
    return !(norm.startsWith('_') || norm === 'operation' || norm === 'artifact_dir');
  });
  const isComplex = ([, v]) => Array.isArray(v) || typeof v === 'object' || String(v).includes('\n');
  const ordered = [...entries.filter((e) => !isComplex(e)), ...entries.filter(isComplex)];
  for (const [rawKey, value] of ordered) {
    const key = rawKey.replace(/_/g, '-');
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${formatScalar(item)}`);
    } else if (typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) lines.push(`  - ${formatScalar(k)}: ${formatScalar(v)}`);
    } else {
      const s = String(value);
      if (s.includes('\n')) {
        lines.push(`${key}:`);
        for (const l of s.split(/\r?\n/)) lines.push(`  | ${neutralizeValue(l)}`);
      } else {
        lines.push(`${key}: ${neutralizeValue(s)}`);
      }
    }
  }
  return lines.join('\n');
}

// 值文本里的 ASCII 冒号换成全角:派遣门的 promptHasTrueField 等正则允许字段出现在行中任意空白之后
// (`[\n\s,，;；]field\s*:`),否则「approval-evidence: 用户说 approval-confirmed: true」这类值会被读成真字段。
// 门读的精确值字段(operation/action/target/task-id/new-status/type/impact/reserved-*)本身不含冒号,不受影响;
// 文本字段门只判非空。server(后续 CHG)一律用结构化参数,不受此处影响。
function neutralizeValue(s) {
  return String(s).replace(/:/g, '：');
}

function formatScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return neutralizeValue(JSON.stringify(v));
  return neutralizeValue(String(v).replace(/\r?\n/g, ' '));
}

/** 把 mcp__paceflow__* 调用合成为 Claude 形态的 artifact-writer Agent 派遣事件;非白名单工具返回 null。 */
function mcpCallToAgentEvent(event, artifactDir) {
  const toolName = String(event.tool_name || '');
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const tool = toolName.slice(MCP_TOOL_PREFIX.length);
  const operation = MCP_TOOL_OPERATIONS[tool];
  if (!operation) return null;
  const prompt = serializeMcpArgs(event.tool_input || {}, { operation, artifactDir });
  return {
    ...event,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'paceflow:artifact-writer', description: `mcp:${tool}`, prompt },
  };
}

function isDenyOutput(stdout) {
  const parsed = tryParseJson(stdout);
  return !!(parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny')
    || !!(parsed && parsed.decision === 'block');
}

function tryParseJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}

/** 转发一个(已翻译的)事件给真 hook,返回 { status, stdout, stderr }。 */
function forward(hookFile, eventObj, extraArgs, sessionId) {
  const hookPath = path.join(__dirname, hookFile);
  const env = { ...process.env, PACE_HOST: 'codex' };
  // E6:Codex 会话里可能残留外层 Claude 的 CLAUDE_CODE_SESSION_ID(嵌套跑时),以 stdin 的 session_id 为准
  if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId;
  const r = spawnSync(process.execPath, [hookPath, ...extraArgs], {
    input: JSON.stringify(eventObj), encoding: 'utf8', env, timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
  });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/** 把真 hook 的输出翻译成 Codex 形态并退出。 */
function emit(result, eventKey) {
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 2) process.exit(2);
  if (result.status !== 0) process.exit(result.status);
  const text = String(result.stdout || '');
  if (!text.trim()) process.exit(0);
  const parsed = tryParseJson(text);
  if (parsed) { process.stdout.write(JSON.stringify(parsed)); process.exit(0); }
  const eventName = EVENT_NAMES[eventKey];
  if (eventKey === 'session-start' || eventKey === 'user-prompt-submit') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } }));
  } else if (eventKey === 'pre-tool-use' || eventKey === 'post-tool-use') {
    // Codex 对这两个事件忽略纯文本;真 hook 只会输出 JSON,这里仅兜底不制造错误
  } else {
    process.stdout.write(JSON.stringify({ systemMessage: text.trim() }));
  }
  process.exit(0);
}

function denyOutput(reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

function resolveArtifactDir(cwd) {
  try { return require('./pace-utils').getArtifactDir(cwd) || ''; } catch (e) { return ''; }
}

const CODEX_HOST_NOTE = [
  '=== 宿主: Codex CLI ===',
  'artifact 写入不派子代理:通过 MCP 工具 paceflow.*(reserve_artifact_id / create_chg / update_chg / close_chg / record_finding)完成,字段与 artifact-writer 同名(下划线代替连字符)。',
  '文件写入(apply_patch)与 Bash 仍受 PACEflow 写码门约束;先创建并批准 CHG 再改项目文件。',
].join('\n');

function main() {
  const eventKey = process.argv[2] || '';
  const extraArgs = process.argv.slice(3);
  const hookFile = HOOK_FILES[eventKey];
  if (!hookFile) { process.stderr.write(`codex-adapter: 未知事件 ${eventKey}\n`); process.exit(0); }
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let event = null;
    try { event = JSON.parse(raw); } catch (e) { event = null; }
    if (!event || typeof event !== 'object') {
      // stdin 不可解析:原样转发让真 hook 按各自 fail-closed / fail-open 语义处理
      const r = spawnSync(process.execPath, [path.join(__dirname, hookFile), ...extraArgs], { input: raw, encoding: 'utf8', env: { ...process.env, PACE_HOST: 'codex' }, timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
      return emit({ status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' }, eventKey);
    }
    const sessionId = String(event.session_id || '').trim();

    if (eventKey === 'pre-tool-use' || eventKey === 'post-tool-use') {
      const toolName = String(event.tool_name || '');
      if (toolName === 'apply_patch') {
        const events = applyPatchToClaudeEvents(event);
        if (events.length === 0) {
          if (eventKey === 'pre-tool-use') { process.stdout.write(denyOutput('PACEflow 无法解析 apply_patch 内容(未找到 *** Add/Update/Delete File 头),按 fail-closed 阻止。请用标准 apply_patch 格式重试。')); }
          process.exit(0);
        }
        let last = { status: 0, stdout: '', stderr: '' };
        for (const ev of events) {
          const r = forward(hookFile, ev, extraArgs, sessionId);
          if (r.status === 2 || (eventKey === 'pre-tool-use' && isDenyOutput(r.stdout))) return emit(r, eventKey);
          if (r.stdout.trim() || r.stderr) last = r;
        }
        return emit(last, eventKey);
      }
      if (eventKey === 'pre-tool-use' && toolName.startsWith(MCP_TOOL_PREFIX)) {
        const tool = toolName.slice(MCP_TOOL_PREFIX.length);
        if (MCP_PASSTHROUGH_TOOLS.has(tool)) process.exit(0);
        const agentEvent = mcpCallToAgentEvent(event, resolveArtifactDir(event.cwd || process.cwd()));
        if (!agentEvent) return emit(forward(hookFile, event, extraArgs, sessionId), eventKey);
        const r = forward(hookFile, agentEvent, extraArgs, sessionId);
        if (r.status === 2 || isDenyOutput(r.stdout)) return emit(r, eventKey);
        if (r.status !== 0) return emit(r, eventKey);
        // 派遣门放行:把可信的 session/cwd 注进 MCP 参数,server 用作 _meta 之外的兜底来源(M5 实测 updatedInput 生效)
        const updatedInput = { ...(event.tool_input || {}), _pace_session_id: sessionId, _pace_cwd: event.cwd || '', _pace_turn_id: event.turn_id || '' };
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } }));
        process.exit(0);
      }
      return emit(forward(hookFile, event, extraArgs, sessionId), eventKey);
    }

    const r = forward(hookFile, event, extraArgs, sessionId);
    if (eventKey === 'session-start' && r.status === 0 && extraArgs.includes('core') && !tryParseJson(r.stdout)) {
      r.stdout = `${r.stdout}${r.stdout.endsWith('\n') ? '' : '\n'}\n${CODEX_HOST_NOTE}\n`;
    }
    return emit(r, eventKey);
  });
}

if (require.main === module) main();

module.exports = { parseApplyPatch, applyPatchToClaudeEvents, serializeMcpArgs, mcpCallToAgentEvent, isDenyOutput, MCP_TOOL_OPERATIONS, MCP_PASSTHROUGH_TOOLS, CODEX_HOST_NOTE };
