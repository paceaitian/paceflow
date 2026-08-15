// SubagentStop hook：artifact-writer 报告协议观察器（不阻断，只提示/记录）
const fs = require('fs');
const path = require('path');
let paceUtils;
try { paceUtils = require('./pace-utils'); } catch(e) {
  process.stderr.write(`PACE: pace-utils.js 加载失败: ${e.message}\n`);
  process.exit(0);
}

const {
  isPaceProject,
  getProjectName,
  resolveProjectCwd,
  createLogger,
  logEntry,
  isArtifactWriterAgentType,
  normalizeLineEndings,
} = paceUtils;

const EXPECTED_TITLE = '## artifact-writer 报告';
const TIMESTAMP_LINE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/;
const LOG = paceUtils.defaultLogPath();
const log = createLogger(LOG);
const cwd = resolveProjectCwd();
const proj = getProjectName(cwd);
const PACE_RUNTIME = paceUtils.getProjectRuntimeDir(cwd);

function firstNonEmptyLines(message) {
  return normalizeLineEndings(message)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function reportStatus(message) {
  const m = normalizeLineEndings(message).match(/(?:\*\*)?状态(?:\*\*)?\s*[：:]\s*(SUCCESS|FAILED)/i);
  return m ? m[1].toUpperCase() : '';
}

// CHG-20260814-02:transcript 兜底只提取 user / assistant 消息的文本内容(dispatch prompt 是
// user 消息、agent 报告是 assistant 消息);tool_result / tool_use 载荷刻意排除——agent Read 的
// 文件内容经 tool_result 进 transcript,曾把读到的旧 CHG 文案误配为 archive-chg 操作并试图关
// 无关 owner(2026-08-14 实锤,仅因 owner 恰好不存在未成事故)。非 JSON 行同步不再收集:格式
// 异常时宁可 SKIP 走 30min TTL 兜底(漏关自愈),不冒误关活跃 owner 的险。
function messageTextsFromTranscriptLine(parsed) {
  const out = [];
  if (!parsed || typeof parsed !== 'object') return out;
  if (parsed.type !== 'user' && parsed.type !== 'assistant') return out;
  const content = parsed.message && parsed.message.content;
  if (typeof content === 'string') { out.push(content); return out; }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') { out.push(block); continue; }
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') out.push(block.text);
    }
  }
  return out;
}

function readTranscriptStrings(transcriptPath) {
  if (!transcriptPath) return [];
  try {
    const stat = fs.statSync(transcriptPath);
    const maxBytes = 200000;
    const len = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      // 读头部而非尾部:权威信号(dispatch prompt 的 user 消息)恒在 transcript 第 0 行;
      // 读尾部会在超长 transcript 截掉 prompt、把权威落到 assistant 自述文案(CHG-20260814-02 审计 P3-3)
      fs.readSync(fd, buf, 0, len, 0);
      const raw = buf.toString('utf8');
      const strings = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { strings.push(...messageTextsFromTranscriptLine(JSON.parse(line))); }
        catch(e) { /* 非 JSON 行不收集(见上方注释) */ }
      }
      return strings;
    } finally {
      fs.closeSync(fd);
    }
  } catch(e) {
    return [];
  }
}

function uniqueChangeIdFromText(text) {
  const matches = String(text || '').match(/\b(?:CHG|HOTFIX)-\d{8}-\d{2}\b/gi) || [];
  const ids = [...new Set(matches.map(id => id.toUpperCase()))];
  return ids.length === 1 ? ids[0] : '';
}

// PSP-02：operation 与 target 必须同源——target 只从产出 close-chg/archive-chg 的同一 candidate
// 取（显式 target 或唯一 CHG ID），不遍历其他 candidate 借 target，避免 operation 在 prompt、
// target 在 transcript/lastMessage 指向另一个 CHG 时关错 change-owner。同源无 target 时降级 SKIP。
// 命中返回 {operation,target,reason}（target 可空=missing-target）；无 close/archive operation 返回 null。
function matchCloseTargetFromCandidates(candidates) {
  for (const text of candidates.filter(Boolean)) {
    const operation = paceUtils.operationFromAgentPrompt(text);
    if (operation !== 'close-chg' && operation !== 'archive-chg') continue;
    const target = paceUtils.explicitChangeTargetFromAgentPrompt(text) || uniqueChangeIdFromText(text);
    if (target) return { operation, target, reason: '' };
    return { operation, target: '', reason: 'missing-target' };
  }
  return null;
}

function inferCloseTarget(stdin) {
  // 先试廉价 candidate（stdin 已解析字段），命中 close/archive operation 即返回——避免每次
  // SubagentStop 都无谓读 transcript（readTranscriptStrings 可达 200KB 磁盘 I/O）。廉价 candidate 顺序
  // 与原合并数组前 5 项一致，故同源命中优先级不变；仅把 transcript 读取推迟到廉价全 miss 时。
  const cheap = matchCloseTargetFromCandidates([
    stdin.toolInput && stdin.toolInput.prompt,
    stdin.raw && stdin.raw.tool_input && stdin.raw.tool_input.prompt,
    stdin.raw && stdin.raw.prompt,
    stdin.raw && stdin.raw.agent_prompt,
    stdin.lastMessage,
  ]);
  if (cheap) return cheap;
  // 廉价 candidate 全不含 close/archive operation 时，才惰性读 transcript 兜底。
  const fromTranscript = matchCloseTargetFromCandidates(readTranscriptStrings(stdin.agentTranscriptPath));
  if (fromTranscript) return fromTranscript;
  return { operation: '', target: '', reason: 'missing-operation' };
}

function closeOwnerIfArchived(stdin, status, t0) {
  // HOTFIX-20260815-01(codex P2-1):SubagentStop 在 v2.1.232 起每轮 idle 触发(非仅完成),
  // resume 场景的中间轮没有终态报告——只有 lastMessage 报出 SUCCESS 终态才允许关闭 owner,
  // 否则 agent 仍在继续工作时 owner 被提前关闭,fresh writer 可经 owner 门并发接手。
  // 非终态直接 skip(也省去 transcript 读取);漏关由 30min TTL sweep 自愈,方向 fail-safe。
  if (status !== 'SUCCESS') {
    log(logEntry('SubagentStop', 'CHANGE_OWNER_CLOSE_SKIP', {
      proj,
      operation: '-',
      target: '-',
      reason: 'non-terminal-status',
      status: status || '-',
      dur: Date.now() - t0,
    }));
    return;
  }
  const inferred = inferCloseTarget(stdin);
  if (!inferred.operation || !inferred.target) {
    log(logEntry('SubagentStop', 'CHANGE_OWNER_CLOSE_SKIP', {
      proj,
      operation: inferred.operation || '-',
      target: inferred.target || '-',
      reason: inferred.reason,
      dur: Date.now() - t0,
    }));
    return;
  }
  const stillActive = paceUtils.getActiveChangeEntries(cwd).some(entry => entry.id === inferred.target);
  if (stillActive) {
    log(logEntry('SubagentStop', 'CHANGE_OWNER_CLOSE_SKIP', {
      proj,
      operation: inferred.operation,
      target: inferred.target,
      reason: 'target-still-active',
      dur: Date.now() - t0,
    }));
    return;
  }
  const closed = paceUtils.markChangeOwnerClosed(cwd, inferred.target, {
    sessionId: stdin.sessionId,
    agentId: stdin.agentId,
    operation: inferred.operation,
  });
  log(logEntry('SubagentStop', closed.ok ? 'CHANGE_OWNER_CLOSED' : 'CHANGE_OWNER_CLOSE_SKIP', {
    proj,
    operation: inferred.operation,
    target: inferred.target,
    status: status || '-',
    reason: closed.reason || '',
    dur: Date.now() - t0,
  }));
}

function writeContext(message) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SubagentStop',
      additionalContext: paceUtils.appendArtifactDirHint(cwd, message),
    },
  }));
}

// require.main 守卫：顶层 parseStdinSync()（同步读 stdin）仅在作为 hook 主程序运行时执行；
// 被 require（如单元测试）时跳过，使内部纯函数（inferCloseTarget 等）可直接单测。
if (require.main === module) {
try {
  const t0 = Date.now();
  const stdin = paceUtils.parseStdinSync();
  if (!isPaceProject(cwd)) {
    log(logEntry('SubagentStop', 'SKIP', { proj, reason: 'non-pace', dur: Date.now() - t0 }));
    process.exit(0);
  }

  const agentType = stdin.agentType || stdin.raw.agent_name || '';
  if (!isArtifactWriterAgentType(agentType)) {
    log(logEntry('SubagentStop', 'SKIP', { proj, agent_type: agentType || '-', reason: 'not-artifact-writer', dur: Date.now() - t0 }));
    process.exit(0);
  }

  if (stdin.agentTranscriptPath) {
    try {
      fs.mkdirSync(PACE_RUNTIME, { recursive: true });
      fs.writeFileSync(path.join(PACE_RUNTIME, 'last-artifact-writer-transcript'), stdin.agentTranscriptPath, 'utf8');
    } catch(e) {}
  }

  const releasedResources = paceUtils.releaseArtifactResourcesForOwner(cwd, { sessionId: stdin.sessionId, agentId: stdin.agentId });
  log(logEntry('SubagentStop', 'RELEASE_ARTIFACT_RESOURCES', {
    proj,
    agent_type: agentType,
    agent_id: stdin.agentId,
    resource_locks: releasedResources.length,
    dur: Date.now() - t0,
  }));

  const lines = firstNonEmptyLines(stdin.lastMessage);
  const first = lines[0] || '';
  const second = lines[1] || '';
  const hasTitle = lines.includes(EXPECTED_TITLE);
  const allowedTimestampPrefix = TIMESTAMP_LINE.test(first) && second === EXPECTED_TITLE;
  const status = reportStatus(stdin.lastMessage);
  closeOwnerIfArchived(stdin, status, t0);

  if (!hasTitle && !status) {
    const ctx = 'PACE artifact-writer 报告未能解析：缺少标准报告标题和状态行。请检查 agent 实际是否完成 artifact 写入；需要修复时重新派 artifact-writer 按同一指令修复，不要由主 session 手写 C/V/归档标记。';
    writeContext(ctx);
    log(logEntry('SubagentStop', 'WARN', { proj, agent_type: agentType, issue: 'missing-title-status', transcript: stdin.agentTranscriptPath || '-', dur: Date.now() - t0 }));
  } else if (!hasTitle) {
    const ctx = 'PACE artifact-writer 报告未能解析：缺少标准报告标题。请检查 agent 实际是否完成 artifact 写入；需要修复时重新派 artifact-writer 按同一指令修复，不要由主 session 手写 C/V/归档标记。';
    writeContext(ctx);
    log(logEntry('SubagentStop', 'WARN', { proj, agent_type: agentType, issue: 'missing-title', transcript: stdin.agentTranscriptPath || '-', dur: Date.now() - t0 }));
  } else if (first !== EXPECTED_TITLE && !allowedTimestampPrefix) {
    const ctx = 'PACE artifact-writer 报告未能解析：标题前有额外内容或使用了标题变体。请在下一次派遣时要求 agent 只输出标准报告。';
    writeContext(ctx);
    log(logEntry('SubagentStop', 'WARN', { proj, agent_type: agentType, issue: 'title-prefix', first: first.slice(0, 80), dur: Date.now() - t0 }));
  } else if (!status) {
    const ctx = 'PACE artifact-writer 报告未能解析：缺少状态行。请确认 artifact 落盘结果；需要修复时重新派 artifact-writer，不要主 session 直接补写 artifact 状态。';
    writeContext(ctx);
    log(logEntry('SubagentStop', 'WARN', { proj, agent_type: agentType, issue: 'missing-status', dur: Date.now() - t0 }));
  } else {
    log(logEntry('SubagentStop', allowedTimestampPrefix ? 'WARN_PREFIX' : 'PASS', {
      proj,
      agent_type: agentType,
      status,
      transcript: stdin.agentTranscriptPath || '-',
      dur: Date.now() - t0,
    }));
  }
} catch(e) {
  try { log(logEntry('SubagentStop', 'ERROR', { proj, error: e.message })); } catch(e2) {}
}
}

module.exports = { inferCloseTarget, uniqueChangeIdFromText };
