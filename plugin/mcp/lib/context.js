// MCP 调用上下文解析(CHG-20260815-02):server 进程的 cwd 是插件根(探针 M4),项目 cwd 与 session 只能从
// 调用元数据取:① Codex 原生 `_meta["x-codex-turn-metadata"]`(session_id / thread_id / turn_id / workspaces,探针 M6)
// ② PACEflow PreToolUse hook 经 updatedInput 注入的 `_pace_session_id / _pace_cwd / _pace_turn_id`(可信来源,探针 M5)
// ③ 环境变量兜底(CODEX_THREAD_ID / CLAUDE_CODE_SESSION_ID;cwd 无兜底)。
// 优先级:hook 注入 > _meta > env——hook 注入是 PACEflow 自己的门写的,最可信;两者不一致时以 hook 为准并记 warning。
'use strict';
const path = require('path');
const fs = require('fs');

// cwd 归一为 realpath:macOS 的 os.tmpdir()/var/… 是 /private/var/… 的符号链接,hook 子进程的 process.cwd()
// 返回真实路径而 server 传入的 file_path 若按未解析路径拼出,artifact 完整性门会判「文件不在项目内」而放行
// (PR #6 macOS CI:MS-E3 缺 reservation 的 create_chg 未被 deny)。所有路径以 realpath 为准即可消除该分叉。
function realpathSafe(p) {
  try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); }
}

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
  // `_pace_*` 与模型自填参数走同一通道(hook 注入时会覆盖模型值,但 hooks 未启用/未信任时模型值原样到达);
  // 与宿主 _meta 冲突即 fail-closed——不给「以哪个为准」留口子(审计 P2-5:否则可指到别的项目/别的 session)
  if (hookSession && metaSession && hookSession !== metaSession) return { ok: false, reason: `session 不一致:hook 注入=${hookSession},宿主 _meta=${metaSession}——疑似参数伪造或 hooks 未生效,拒绝执行`, sessionId: '', cwd: '', turnId: '', source, warnings };
  if (hookCwd && metaCwd && realpathSafe(path.resolve(hookCwd)) !== realpathSafe(path.resolve(metaCwd))) return { ok: false, reason: `cwd 不一致:hook 注入=${hookCwd},宿主 _meta workspace=${metaCwd}——拒绝跨项目写入`, sessionId: '', cwd: '', turnId: '', source, warnings };
  if (workspaces.length > 1) warnings.push(`多 workspace(${workspaces.length}),取第一个:${metaCwd}`);
  if (!sessionId) return { ok: false, reason: '无法确定 session:调用缺 _meta.x-codex-turn-metadata 与 hook 注入参数,且无 CODEX_THREAD_ID/CLAUDE_CODE_SESSION_ID', sessionId: '', cwd: '', turnId: '', source, warnings };
  if (!cwd) return { ok: false, reason: '无法确定项目 cwd:调用缺 _meta.workspaces 与 hook 注入的 _pace_cwd', sessionId, cwd: '', turnId: '', source, warnings };
  return { ok: true, sessionId, cwd: realpathSafe(path.resolve(cwd)), turnId: hookTurn || metaTurn, source, warnings };
}

function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }

/** 去掉宿主/hook 注入的 `_` 前缀元数据,得到工具真正的业务参数 */
function businessArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) if (!k.startsWith('_')) out[k] = v;
  return out;
}

module.exports = { resolveCallContext, businessArgs };
