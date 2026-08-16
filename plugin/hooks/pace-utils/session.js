const fs = require('fs');

function isTeammate() {
  return !!process.env.CLAUDE_CODE_TEAM_NAME;
}

function isArtifactWriterAgentType(agentType) {
  const type = String(agentType || '').toLowerCase();
  return type === 'artifact-writer' || type === 'paceflow:artifact-writer' || type.endsWith(':artifact-writer');
}

let _lastHookSessionId = '';

function normalizeSessionId(sessionId) {
  return String(sessionId || '').trim();
}

// 宿主注入的 session 身份环境变量(CHG-20260815-01):Codex CLI 在 Bash 工具环境里给的是 CODEX_THREAD_ID
// (= hook stdin 的 session_id,探针 M7);Claude Code 给 CLAUDE_CODE_SESSION_ID。Codex 嵌套跑在 Claude 里时两者
// 并存,CODEX_THREAD_ID 才是当前会话,故优先——否则 reserve helper 与 hook 的 owner 身份会错位(研究 E6)。
function hostSessionEnv() {
  return process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || '';
}

function currentSessionId() {
  return normalizeSessionId(hostSessionEnv() || _lastHookSessionId);
}

function parseHookStdin(rawInput) {
  let parsed = {};
  let ok = false;
  try { parsed = JSON.parse(rawInput); ok = true; } catch(e) {}
  // PUC-02/ROB-01：JSON.parse 对字面量 null/数组/数字返回非对象真值（ok=true），
  // 后续 parsed.session_id 等属性访问会对 null 抛 TypeError；归一为空对象并置 ok=false。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { parsed = {}; ok = false; }
  const sessionId = normalizeSessionId(parsed.session_id || parsed.sessionId || hostSessionEnv());
  if (sessionId) _lastHookSessionId = sessionId;
  return {
    ok,
    sessionId,
    toolName: parsed.tool_name || '',
    filePath: (parsed.tool_input?.file_path || '').replace(/\\/g, '/'),
    oldString: parsed.tool_input?.old_string || '',
    newString: parsed.tool_input?.new_string || '',
    content: parsed.tool_input?.content || '',
    toolInput: parsed.tool_input || {},
    type: parsed.source || parsed.type || '',
    agentId: parsed.agent_id || parsed.subagent_id || '',
    agentType: parsed.agent_type || parsed.subagent_type || parsed.tool_input?.subagent_type || '',
    lastMessage: parsed.last_assistant_message || parsed.last_message || parsed.message || '',
    agentTranscriptPath: parsed.agent_transcript_path || parsed.transcript_path || '',
    error: parsed.error || parsed.error_type || '',
    isInterrupt: parsed.is_interrupt === true || parsed.is_interrupt === 'true' || parsed.isInterrupt === true,
    durationMs: Number(parsed.duration_ms || parsed.durationMs || 0) || 0,
    raw: parsed,
  };
}

function withStdinParsed(callback) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    // ROB-01：纵深防御，parseHookStdin 异常时以空输入兜底，避免异步入口未捕获异常致进程崩溃 fail-open
    let parsed;
    try { parsed = parseHookStdin(input); } catch (e) { parsed = parseHookStdin(''); }
    callback(parsed, input);
  });
}

function parseStdinSync() {
  try { return parseHookStdin(fs.readFileSync(0, 'utf8')); }
  catch(e) { return parseHookStdin(''); }
}

module.exports = {
  isTeammate,
  isArtifactWriterAgentType,
  normalizeSessionId,
  currentSessionId,
  parseHookStdin,
  withStdinParsed,
  parseStdinSync,
};
