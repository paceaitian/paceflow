// MCP 调用上下文解析(CHG-20260815-02):server 进程的 cwd 是插件根(探针 M4),项目 cwd 与 session 只能从
// 调用元数据取:① Codex 原生 `_meta["x-codex-turn-metadata"]`(session_id / thread_id / turn_id / workspaces,探针 M6)
// ② PACEflow PreToolUse hook 经 updatedInput 注入的 `_pace_session_id / _pace_cwd / _pace_turn_id`(可信来源,探针 M5)
// ③ 环境变量兜底(CODEX_THREAD_ID / CLAUDE_CODE_SESSION_ID;cwd 无兜底)。
// 优先级:hook 注入 > _meta > env——hook 注入是 PACEflow 自己的门写的,最可信;两者不一致时以 hook 为准并记 warning。
'use strict';
const path = require('path');

/**
 * @param {object} params - tools/call 的 params(含 _meta / arguments)
 * @returns {{ ok: boolean, sessionId: string, cwd: string, turnId: string, source: string, warnings: string[], reason?: string }}
 */
function resolveCallContext(params) {
  const args = (params && params.arguments) || {};
  const meta = (params && params._meta) || {};
  const turnMeta = meta['x-codex-turn-metadata'] || {};
  const warnings = [];

  const hookSession = str(args._pace_session_id);
  const hookCwd = str(args._pace_cwd);
  const hookTurn = str(args._pace_turn_id);
  const metaSession = str(turnMeta.session_id || turnMeta.thread_id || meta.threadId);
  const metaTurn = str(turnMeta.turn_id);
  const workspaces = turnMeta.workspaces && typeof turnMeta.workspaces === 'object' ? Object.keys(turnMeta.workspaces) : [];
  const metaCwd = workspaces.length ? workspaces[0] : '';
  const envSession = str(process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID);

  let sessionId = hookSession || metaSession || envSession;
  let cwd = hookCwd || metaCwd;
  let source = hookSession ? 'hook' : (metaSession ? 'meta' : (envSession ? 'env' : 'none'));
  if (hookSession && metaSession && hookSession !== metaSession) warnings.push(`session 不一致:hook=${hookSession} meta=${metaSession},以 hook 为准`);
  if (hookCwd && metaCwd && path.resolve(hookCwd) !== path.resolve(metaCwd)) warnings.push(`cwd 不一致:hook=${hookCwd} meta=${metaCwd},以 hook 为准`);
  if (workspaces.length > 1) warnings.push(`多 workspace(${workspaces.length}),取第一个:${metaCwd}`);
  if (!sessionId) return { ok: false, reason: '无法确定 session:调用缺 _meta.x-codex-turn-metadata 与 hook 注入参数,且无 CODEX_THREAD_ID/CLAUDE_CODE_SESSION_ID', sessionId: '', cwd: '', turnId: '', source, warnings };
  if (!cwd) return { ok: false, reason: '无法确定项目 cwd:调用缺 _meta.workspaces 与 hook 注入的 _pace_cwd', sessionId, cwd: '', turnId: '', source, warnings };
  return { ok: true, sessionId, cwd: path.resolve(cwd), turnId: hookTurn || metaTurn, source, warnings };
}

function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }

/** 去掉宿主/hook 注入的 `_` 前缀元数据,得到工具真正的业务参数 */
function businessArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) if (!k.startsWith('_')) out[k] = v;
  return out;
}

module.exports = { resolveCallContext, businessArgs };
