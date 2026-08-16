// 虚拟 artifact-writer 写盘管线(CHG-20260815-02):MCP server 的每一次 artifact 文件写入都以
// agent_type=paceflow:artifact-writer 身份合成 Claude 形态的 Write/Edit 事件,先跑真 pre-tool-use.js
// (reservation / owner / 资源锁 / 完整性门全部复用),任一 deny 即整体中止且零写入;全部预检通过后再落盘,
// 落盘后逐文件跑 post-tool-use.js(索引联动 / owner heartbeat / schema WARN 等副作用与 Claude 宿主一致)。
// 两阶段的意义:artifact-writer(LLM)在 Claude 里是逐文件写、中途 deny 就留下半套产物;这里先把全部
// 事件过一遍门再动盘,让「一次 MCP 调用」尽量原子。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', '..', 'hooks');
const PRE_HOOK = path.join(HOOKS_DIR, 'pre-tool-use.js');
const POST_HOOK = path.join(HOOKS_DIR, 'post-tool-use.js');
const HOOK_TIMEOUT_MS = 25000;
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * 一个写盘操作。
 * @typedef {{ kind: 'write', file: string, content: string } | { kind: 'edit', file: string, oldString: string, newString: string }} WriteOp
 */

function agentIdFor(ctx) {
  return `mcp-artifact-writer:${String(ctx.sessionId || '').slice(0, 12)}`;
}

/** 合成 artifact-writer 身份的 Claude 形态 hook 事件 */
function syntheticEvent(ctx, op, hookEventName) {
  const base = {
    session_id: ctx.sessionId,
    transcript_path: null,
    cwd: ctx.cwd,
    hook_event_name: hookEventName,
    permission_mode: 'default',
    agent_id: agentIdFor(ctx),
    agent_type: 'paceflow:artifact-writer',
    tool_use_id: `mcp-${Date.now().toString(36)}`,
  };
  if (op.kind === 'write') {
    return { ...base, tool_name: 'Write', tool_input: { file_path: op.file, content: op.content } };
  }
  return { ...base, tool_name: 'Edit', tool_input: { file_path: op.file, old_string: op.oldString, new_string: op.newString } };
}

function runHook(hookPath, event, ctx) {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: ctx.sessionId, PACE_HOST: ctx.host || 'codex' };
  if (ctx.logPath) env.PACE_LOG_PATH = ctx.logPath;
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(event), encoding: 'utf8', env, timeout: HOOK_TIMEOUT_MS, maxBuffer: MAX_BUFFER, cwd: ctx.cwd,
  });
  let parsed = null;
  try { parsed = r.stdout && r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch (e) { parsed = null; }
  const hso = parsed && parsed.hookSpecificOutput ? parsed.hookSpecificOutput : {};
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    deny: hso.permissionDecision === 'deny' || (parsed && parsed.decision === 'block') || r.status === 2,
    denyReason: hso.permissionDecisionReason || (parsed && parsed.reason) || (r.status === 2 ? (r.stderr || '').trim() : ''),
    additionalContext: hso.additionalContext || '',
    systemMessage: parsed && parsed.systemMessage ? parsed.systemMessage : '',
  };
}

/** 应用 Edit:old_string 必须在文件中恰好出现一次(与 Claude Edit 工具语义一致) */
function applyEdit(file, oldString, newString) {
  const raw = fs.readFileSync(file, 'utf8');
  const first = raw.indexOf(oldString);
  if (first < 0) return { ok: false, reason: `old_string 未命中:${path.basename(file)}` };
  if (raw.indexOf(oldString, first + oldString.length) >= 0) return { ok: false, reason: `old_string 命中多处(不唯一):${path.basename(file)}` };
  fs.writeFileSync(file, raw.slice(0, first) + newString + raw.slice(first + oldString.length), 'utf8');
  return { ok: true };
}

/**
 * 干跑(不碰盘、不调 hook):Edit 的 old_string 必须唯一命中,Write 的目标不得已存在(与 artifact-writer 的
 * file-conflict 规则一致,除非 op.overwrite=true——只用于本管线内先建后改的同文件场景)。
 */
function dryCheck(ops) {
  const seenWrites = new Set();
  for (const op of ops) {
    if (op.kind === 'write') {
      if (fs.existsSync(op.file) && !op.overwrite) return { ok: false, code: 'file-conflict', reason: `目标文件已存在:${op.file}` };
      seenWrites.add(op.file);
    } else {
      if (!fs.existsSync(op.file) && !seenWrites.has(op.file)) return { ok: false, code: 'target-not-found', reason: `文件不存在:${op.file}` };
      if (fs.existsSync(op.file)) {
        const raw = fs.readFileSync(op.file, 'utf8');
        const first = raw.indexOf(op.oldString);
        if (first < 0) return { ok: false, code: 'edit-mismatch', reason: `old_string 未命中:${path.basename(op.file)}` };
        if (raw.indexOf(op.oldString, first + op.oldString.length) >= 0) return { ok: false, code: 'edit-mismatch', reason: `old_string 命中多处:${path.basename(op.file)}` };
      }
    }
  }
  return { ok: true };
}

/**
 * 跑管线。返回 { ok, code, reason, files: {created:[], modified:[]}, hookNotes: [] }。
 * 阶段 0 干跑 → 阶段 1 全部 PreToolUse(deny 即止,零写入)→ 阶段 2 落盘 → 阶段 3 逐个 PostToolUse。
 */
function runPipeline(ctx, ops) {
  const files = { created: [], modified: [] };
  const hookNotes = [];
  if (!Array.isArray(ops) || ops.length === 0) return { ok: true, code: 'noop', reason: '无写入', files, hookNotes };
  const dry = dryCheck(ops);
  if (!dry.ok) return { ok: false, code: dry.code, reason: dry.reason, files, hookNotes };
  // 阶段 1:全部预检
  for (const op of ops) {
    const r = runHook(PRE_HOOK, syntheticEvent(ctx, op, 'PreToolUse'), ctx);
    if (r.deny) return { ok: false, code: 'hook-deny', reason: r.denyReason || '(hook deny,无文案)', files, hookNotes };
    if (r.status !== 0) return { ok: false, code: 'hook-error', reason: `pre-tool-use exit ${r.status}: ${r.stderr.slice(0, 500)}`, files, hookNotes };
    if (r.additionalContext) hookNotes.push(r.additionalContext);
  }
  // 阶段 2:落盘
  for (const op of ops) {
    if (op.kind === 'write') {
      fs.mkdirSync(path.dirname(op.file), { recursive: true });
      const existed = fs.existsSync(op.file);
      fs.writeFileSync(op.file, op.content, 'utf8');
      (existed ? files.modified : files.created).push(op.file);
    } else {
      const a = applyEdit(op.file, op.oldString, op.newString);
      if (!a.ok) return { ok: false, code: 'edit-mismatch', reason: a.reason, files, hookNotes, partial: true };
      if (!files.modified.includes(op.file) && !files.created.includes(op.file)) files.modified.push(op.file);
    }
  }
  // 阶段 3:PostToolUse(副作用:索引联动/owner/WARN),不阻断
  for (const op of ops) {
    const ev = syntheticEvent(ctx, op, 'PostToolUse');
    ev.tool_response = op.kind === 'write' ? { filePath: op.file, type: 'create' } : { filePath: op.file, type: 'update' };
    const r = runHook(POST_HOOK, ev, ctx);
    if (r.additionalContext) hookNotes.push(r.additionalContext);
    if (r.systemMessage) hookNotes.push(r.systemMessage);
    if (r.status === 2 && r.stderr) hookNotes.push(r.stderr.trim());
  }
  return { ok: true, code: 'ok', reason: '', files, hookNotes };
}

module.exports = { runPipeline, dryCheck, syntheticEvent, runHook, agentIdFor, PRE_HOOK, POST_HOOK };
