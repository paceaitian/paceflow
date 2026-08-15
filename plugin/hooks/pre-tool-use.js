// PreToolUse hook：多信号三级触发 + 懒创建模板 + C 阶段批准 + E 阶段就绪检查
const fs = require('fs');
const path = require('path');
let paceUtils;
try { paceUtils = require('./pace-utils'); } catch(e) {
  process.stderr.write(`PACE: pace-utils.js 加载失败: ${e.message}\n`);
  process.exit(0);
}
const {
  CODE_EXTS,
  ARTIFACT_FILES,
  VAULT_PATH,
  FORMAT_SNIPPETS,
  ARCHIVE_MARKER,
} = paceUtils;
const {
  isPaceProject,
  countCodeFiles,
  isTeammate,
  getArtifactDir,
  getProjectName,
  displayDir,
  artifactRootChoiceNeeded,
  artifactRootChoiceMessage,
  getV5MigrationInfo,
} = paceUtils;
const {
  hasUnsyncedPlanFiles,
  createTemplates,
  readActive,
  getNativePlanPath,
  getActiveChangeEntries,
  isChangeApproved,
  summarizeActiveChanges,
} = paceUtils;

// v7（CHG-20260611-08 T-003）：写保护集合改用 constants 单源导出（含退役的 impl_plan tombstone 保护）。
const { PROTECTED_ARTIFACTS } = paceUtils;

const LOG = paceUtils.defaultLogPath();
// W-8: 使用共享日志轮转函数
const log = paceUtils.createLogger(LOG);
const cwd = paceUtils.resolveProjectCwd();
const proj = getProjectName(cwd);
const projectLogEntry = (hook, action, fields = {}) => paceUtils.projectLogEntry(cwd, hook, action, fields);
const {
  bashCommandLooksMutating,
  bashCommandMutatesArtifact,
  bashCommandMutatesArtifactRuntimeControl,
  bashCommandMutatesLocalArtifactRootChoice,
  bashCommandMutatesProjectRootMarker,
  bashArtifactRuntimeControlDenyReason,
  bashArtifactDenyReason,
} = require('./pre-tool-use/bash-guard');
const {
  powershellCommandLooksMutating,
  powershellCommandMutatesArtifact,
  powershellCommandMutatesArtifactRuntimeControl,
  powershellCommandMutatesLocalArtifactRootChoice,
  powershellCommandMutatesProjectRootMarker,
  powershellArtifactRuntimeControlDenyReason,
  powershellArtifactDenyReason,
} = require('./pre-tool-use/powershell-guard');
const {
  monitorArtifactRuntimeControlDenyReason,
  monitorArtifactDenyReason,
} = require('./pre-tool-use/monitor-guard');
const {
  isArtifactWriterAgentTool,
  extractPromptArtifactDir,
  promptHasExactArtifactDir,
  promptDeclaredAction,
  promptUpdateStatusValue,
  explicitReservationFromPrompt,
  parseBatchBlocks,
  reservationRelForLookup,
  reservationMatchesExplicit,
  promptTemplateForOperation,
  artifactWriterCreateChgHint,
  reservationRequiredReason,
  reservationExplicitMissingReason,
  agentLifecyclePromptDenyReason,
  legacyArtifactWriterLockDenyReason,
  artifactResourceLockDenyReason,
  artifactReservationDenyReason,
  agentArtifactDirDenyReason,
} = require('./pre-tool-use/agent-lifecycle-guard');
const {
  isArtifactWriterManagedRel,
  directArtifactMutationDenyReason,
  isChangeDetailArtifactRel,
  detectChangeDetailMarkerMutation,
  markerMutationDenyReason,
} = require('./pre-tool-use/marker-guard');

// DENY_REASONS（CHG-20260614-13 T-002/T-003）：deny action code → 富化与分类元数据。
// emitDeny 据此对 reason 做表驱动富化（dirHint 内层、escapeHatch 外层，复刻 denyOrHint 顺序）
// 再写 stdout + log。reason 文案仍在各 call site 构造（不搬家 → 文案零漂移）。
// 字段：
//   category    —— 语义分类（仅文档/审计用，不影响行为）。
//   escapeHatch —— 是否追加 PACE 退出提示（/paceflow:disable|pause）。流程门与 hardDeny 保护门为 true；
//                  raw（数据错误/完整性/并发/派发正确性/内部 fail-closed）为 false（disable 修不了这些）。
//   dirHint     —— 是否追加 appendArtifactDirHint（artifact 根目录说明）。denyOrHint 流程门为 true；
//                  hardDeny 默认 false，例外 DENY_DIRECT_ARTIFACT_EDIT（原 caller 预包）为 true。
//   teammateMode—— 'hard'（hardDeny/raw：硬 deny 无 note）| 'hard-note'（denyOrHint hardInTeammate：硬 deny+回报 note）
//                  | 'soft'（denyOrHint：teammate 转 additionalContext 提示，避免死锁流程引导类门）。
// 黄金基线锁（tests/golden/deny-outlets.snapshot.json）逐字验证可达出口；难达出口由本表 + 结构测试守完整性。
const DENY_REASONS = {
  // —— 流程门 soft（denyOrHint 无 hardInTeammate）——
  DENY_AGENT_ARTIFACT_ROOT_CHOICE: { category: 'flow-gate', escapeHatch: true, dirHint: true, teammateMode: 'soft' },
  DENY_ARTIFACT_ROOT_CHOICE:       { category: 'flow-gate', escapeHatch: true, dirHint: true, teammateMode: 'soft' },
  DENY_NATIVE_PLAN:                { category: 'flow-gate', escapeHatch: true, dirHint: true, teammateMode: 'soft' },
  DENY:                            { category: 'flow-gate', escapeHatch: true, dirHint: true, teammateMode: 'soft' },
  // —— 流程门 hard-note（denyOrHint hardInTeammate:true）——
  DENY_BASH_ARTIFACT:              { category: 'integrity', escapeHatch: true, dirHint: true, teammateMode: 'hard-note' },
  DENY_POWERSHELL_ARTIFACT:        { category: 'integrity', escapeHatch: true, dirHint: true, teammateMode: 'hard-note' },
  DENY_MONITOR_ARTIFACT:           { category: 'integrity', escapeHatch: true, dirHint: true, teammateMode: 'hard-note' },
  DENY_V6_INDEX_MALFORMED:         { category: 'flow-gate', escapeHatch: true, dirHint: true, teammateMode: 'hard-note' },
  DENY_V6_DETAIL_MISSING:          { category: 'flow-gate', escapeHatch: true, dirHint: true, teammateMode: 'hard-note' },
  DENY_V6_NO_ACTIVE:               { category: 'flow-gate', escapeHatch: true, dirHint: true, teammateMode: 'hard-note' },
  DENY_V6_C_PHASE:                 { category: 'flow-gate', escapeHatch: true, dirHint: true, teammateMode: 'hard-note' },
  DENY_V6_E_PHASE:                 { category: 'flow-gate', escapeHatch: true, dirHint: true, teammateMode: 'hard-note' },
  // —— hardDeny（escapeHatch only, teammate hard）——
  DENY_BAD_STDIN:                  { category: 'fail-closed',    escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_ARTIFACT_ROOT_CONFIG:       { category: 'config-error',   escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_BASH_LOCAL_ARTIFACT_ROOT_CHOICE:       { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_POWERSHELL_LOCAL_ARTIFACT_ROOT_CHOICE: { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_MONITOR_LOCAL_ARTIFACT_ROOT_CHOICE:    { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_BASH_PROJECT_ROOT_MARKER:       { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_POWERSHELL_PROJECT_ROOT_MARKER: { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_MONITOR_PROJECT_ROOT_MARKER:    { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_BASH_ARTIFACT_RUNTIME:       { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_POWERSHELL_ARTIFACT_RUNTIME: { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_MONITOR_ARTIFACT_RUNTIME:    { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_BAD_TOOL:                   { category: 'fail-closed',    escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_MISSING_FILE_PATH:          { category: 'fail-closed',    escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_LOCAL_ARTIFACT_ROOT_CHOICE: { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_PROJECT_ROOT_MARKER:        { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_ARTIFACT_RUNTIME_CONTROL:   { category: 'runtime-control', escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_DIRECT_ARTIFACT_WRITE:      { category: 'integrity',      escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  DENY_DIRECT_ARTIFACT_EDIT:       { category: 'integrity',      escapeHatch: true, dirHint: true,  teammateMode: 'hard' }, // 例外：原 caller 预包 dirHint
  DENY_V6_MARKER:                  { category: 'integrity',      escapeHatch: true, dirHint: false, teammateMode: 'hard' },
  // —— raw（无富化, teammate hard）——
  DENY_AGENT_NEWER_SCHEMA:           { category: 'schema-version', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_NAMED_DISPATCH:         { category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_ARTIFACT_DIR:           { category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_LIFECYCLE_PROMPT:       { category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_LEGACY_ARTIFACT_LOCK:   { category: 'concurrency',    escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_ARTIFACT_BASE:          { category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_BATCH_RESERVED_MISMATCH:{ category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_ID_RESERVATION:         { category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_RESERVED_PROMPT_REQUIRED:{ category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_RESERVED_PROMPT_MISMATCH:{ category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_TARGET_REQUIRED:        { category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_CHANGE_OWNER:           { category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_AGENT_CHANGE_OWNER_STALE:     { category: 'agent-dispatch', escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_WRITE_FOREIGN_OWNER:          { category: 'integrity',      escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_ARCHIVE_WITHOUT_INDEX_MARKER: { category: 'integrity',      escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_ARTIFACT_STATUS_INVALID:      { category: 'data-error',     escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_ARTIFACT_RESERVATION_MISSING: { category: 'data-error',     escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_ARTIFACT_RESERVATION_MISMATCH:{ category: 'data-error',     escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_ARTIFACT_RESOURCE_LOCK:       { category: 'concurrency',    escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_ARTIFACT_CONCURRENT_WRITE:    { category: 'concurrency',    escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_REDIRECT:                     { category: 'integrity',      escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_WRITE_EXISTING_ARTIFACT:      { category: 'integrity',      escapeHatch: false, dirHint: false, teammateMode: 'hard' },
  DENY_WRITE_ARTIFACT:               { category: 'integrity',      escapeHatch: false, dirHint: false, teammateMode: 'hard' },
};

function isArtifactWriterAgent(stdin) {
  return paceUtils.isArtifactWriterAgentType(stdin.agentType);
}

function isFileMutationTool(toolName) {
  return ['Write', 'Edit', 'MultiEdit'].includes(toolName);
}

function isEditMutationTool(toolName) {
  return ['Edit', 'MultiEdit'].includes(toolName);
}

function isAgentTool(toolName) {
  return toolName === 'Agent';
}

function isBashTool(toolName) {
  return toolName === 'Bash';
}

function isPowerShellTool(toolName) {
  return toolName === 'PowerShell';
}

function isMonitorTool(toolName) {
  return toolName === 'Monitor';
}

function isCommandExecutionTool(toolName) {
  return isBashTool(toolName) || isPowerShellTool(toolName) || isMonitorTool(toolName);
}

function commandExecutionLooksMutating(toolName, command) {
  if (isPowerShellTool(toolName)) return powershellCommandLooksMutating(command);
  return bashCommandLooksMutating(command);
}

function getArtifactRelIfRelevant(toolName, paceSignal, artDir, filePath) {
  if (!isFileMutationTool(toolName) || !paceSignal) return null;
  return paceUtils.artifactRelativePathForFile(artDir, filePath);
}

function isUnderDir(baseDir, targetPath) {
  const base = paceUtils.normalizePath(path.resolve(baseDir || ''));
  const target = paceUtils.normalizePath(path.resolve(targetPath || ''));
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
  return !!base && (target === base || target.startsWith(baseWithSlash));
}

function worktreeHostNonArtifactWriteNote(cwd, artDir, filePath, artifactRel) {
  if (!filePath || artifactRel) return '';
  const context = paceUtils.executionContextForCwd(cwd);
  if (!context.isWorktree) return '';
  if (!isUnderDir(context.stateDir, filePath)) return '';
  if (isUnderDir(cwd, filePath)) return '';
  const relToHost = path.relative(context.stateDir, filePath).replace(/\\/g, '/');
  return [
    `当前 cwd 是 worktree：${displayDir(cwd)}；本次普通文件目标在宿主 checkout：${filePath}`,
    `artifact_dir=${displayDir(artDir)} 仅用于 PaceFlow artifacts；${relToHost} 不是 artifact。`,
    '如果用户要求修改当前 worktree，请改用当前 worktree 下的对应路径；如果用户明确要求修改宿主 checkout，可继续使用该路径。'
  ].join('\n');
}

// S-1: 统一 stdin 解析
// 命令工具（Bash/PowerShell/Monitor）改 local-artifact-root-choice / project-root-marker 的 deny 判定。
// CHG-20260615-02（structure-backlog 1.3）：这两组各 3 个守卫原在 paceEntrySignal 块内（signal 路径，
// 命令分支前）与块外（区 B，无 signal 时命令工具落此兜底）逐字写两遍、靠人工同步。抽成命名 helper 供两
// 路径共用消漂移。hardDeny 是主函数局部闭包，故 helper 只返 {reason,action,fields} 描述符，调用点调 hardDeny。
// 返回首个命中守卫的描述符，无命中返回 null。
function commandLocalArtifactRootChoiceDeny(toolName, bashCommand, powershellCommand, cwd) {
  if (isBashTool(toolName) && bashCommandMutatesLocalArtifactRootChoice(bashCommand, cwd)) {
    return { reason: paceUtils.localArtifactRootChoiceDenyReason(cwd, `被拦截的命令：${String(bashCommand || '').slice(0, 500)}`), action: 'DENY_BASH_LOCAL_ARTIFACT_ROOT_CHOICE', fields: { command: String(bashCommand).slice(0, 160).replace(/\n/g, ' '), authoritative: paceUtils.getArtifactRootChoicePath(cwd) } };
  }
  if (isPowerShellTool(toolName) && powershellCommandMutatesLocalArtifactRootChoice(powershellCommand, cwd)) {
    return { reason: paceUtils.localArtifactRootChoiceDenyReason(cwd, `被拦截的命令：${String(powershellCommand || '').slice(0, 500)}`), action: 'DENY_POWERSHELL_LOCAL_ARTIFACT_ROOT_CHOICE', fields: { command: String(powershellCommand).slice(0, 160).replace(/\n/g, ' '), authoritative: paceUtils.getArtifactRootChoicePath(cwd) } };
  }
  if (isMonitorTool(toolName) && bashCommandMutatesLocalArtifactRootChoice(bashCommand, cwd)) {
    return { reason: paceUtils.localArtifactRootChoiceDenyReason(cwd, `被拦截的命令：${String(bashCommand || '').slice(0, 500)}`), action: 'DENY_MONITOR_LOCAL_ARTIFACT_ROOT_CHOICE', fields: { command: String(bashCommand).slice(0, 160).replace(/\n/g, ' '), authoritative: paceUtils.getArtifactRootChoicePath(cwd) } };
  }
  return null;
}
function commandProjectRootMarkerDeny(toolName, bashCommand, powershellCommand, cwd) {
  if (isBashTool(toolName) && bashCommandMutatesProjectRootMarker(bashCommand, cwd)) {
    return { reason: paceUtils.projectRootMarkerDenyReason(cwd, `被拦截的命令：${String(bashCommand || '').slice(0, 500)}`), action: 'DENY_BASH_PROJECT_ROOT_MARKER', fields: { command: String(bashCommand).slice(0, 160).replace(/\n/g, ' ') } };
  }
  if (isPowerShellTool(toolName) && powershellCommandMutatesProjectRootMarker(powershellCommand, cwd)) {
    return { reason: paceUtils.projectRootMarkerDenyReason(cwd, `被拦截的命令：${String(powershellCommand || '').slice(0, 500)}`), action: 'DENY_POWERSHELL_PROJECT_ROOT_MARKER', fields: { command: String(powershellCommand).slice(0, 160).replace(/\n/g, ' ') } };
  }
  if (isMonitorTool(toolName) && bashCommandMutatesProjectRootMarker(bashCommand, cwd)) {
    return { reason: paceUtils.projectRootMarkerDenyReason(cwd, `被拦截的命令：${String(bashCommand || '').slice(0, 500)}`), action: 'DENY_MONITOR_PROJECT_ROOT_MARKER', fields: { command: String(bashCommand).slice(0, 160).replace(/\n/g, ' ') } };
  }
  return null;
}

paceUtils.withStdinParsed((stdin) => {
  try {
  const t0 = Date.now();
  const { toolName, content } = stdin;
  const editList = Array.isArray(stdin.toolInput.edits) ? stdin.toolInput.edits : [];
  const oldString = stdin.oldString || editList.map(e => e.old_string || '').join('\n');
  const newString = stdin.newString || editList.map(e => e.new_string || '').join('\n');
  const commandInput = stdin.toolInput.command || stdin.toolInput.script || stdin.toolInput.cmd || '';
  const bashCommand = commandInput;
  const powershellCommand = commandInput;
  const rawFilePath = stdin.filePath || '';
  const filePath = paceUtils.resolveToolFilePath(cwd, rawFilePath);
  log(projectLogEntry('PreToolUse', 'ENTRY', { proj, tool: toolName, file: filePath, stdin_ok: stdin.ok }));

  // v4.7: teammate 降级——PACE 流程 deny → additionalContext 提醒
  // CHG-D D1：所有 PACE deny 文案统一追加逃生口（spec §5.1 不变量 2：指向用户决策，
  //   deny 主信息仍引导走 PACE 流程；disable 是给真不想用 PACEflow 的用户的退出，不是 AI 绕过单次 deny 的手段）。
  //   幂等守卫：reason 已含 /paceflow:disable 时不重复追加。
  // CHG-20260611-04：双出口——项目级 disable + session 级 pause（同目录多 session 场景更对症）。
  const PACE_ESCAPE_HATCH = '若你（用户）不需要 PACEflow 管理本项目，可运行 /paceflow:disable 停用；仅本 session 临时停用可运行 /paceflow:pause。';
  function withEscapeHatch(reason) {
    const r = String(reason || '');
    // 幂等守卫升级（CHG-20260611-04）：reason 已含任一出口命令即不再追加（防半截重复——
    // 旧版只查 disable，已含 pause 指引的文案会被叠加第二条逃生口）。
    return (r.includes('/paceflow:disable') || r.includes('/paceflow:pause')) ? r : `${r}\n${PACE_ESCAPE_HATCH}`;
  }
  // 原 denyOrHint 三族富化逻辑（CHG-20260614-13 起）已吸收进 emitDeny + DENY_REASONS 表。
  // teammate 语义保留：teammate = 纯执行者，任务管理归主 session（单一权威源）。流程引导类 deny
  // （artifact-root 选择/迁移/桥接，需主 session 与用户交互完成）对 teammate 软化为提示（teammateMode:'soft'）
  // 避免死锁；写代码门 / 完整性门即使 teammate 也硬阻断 + 回报引导（teammateMode:'hard-note'），避免
  // teammate 在未批准/无活跃 CHG/索引损坏时越界写代码绕过 PACE。
  // hardDeny（CHG-20260614-13 起）：薄包装委托 emitDeny，保留 24 个调用点不变。原 hardDeny 语义
  // = withEscapeHatch(reason) + 硬 deny + log{proj,tool,file,...fields,dur}，对应 DENY_REASONS 里
  // escapeHatch:true / dirHint:false / teammateMode:'hard'（DIRECT_ARTIFACT_EDIT 例外 dirHint:true，
  // 其 2 个调用点已去 caller 预包，交 emitDeny 的 dh:true 富化）。tool/file 在此显式补入 fields。
  function hardDeny(reason, action, fields = {}) {
    return emitDeny(action, reason, { tool: toolName, file: filePath, ...fields });
  }
  // emitDeny（CHG-20260614-13）：表驱动单 deny 出口，收敛原 hardDeny/denyOrHint/raw 三族。
  // action 查 DENY_REASONS 决定富化（dirHint 内层 + escapeHatch 外层，复刻 denyOrHint 顺序）与
  // teammate 行为（hard / hard-note / soft）；reason 文案仍由各 call site 构造（不搬家→零漂移）。
  // log 只自动注入 proj + dur（真正普适字段）；tool/file 由 caller 按原 log 形态传入 fields，
  // 保各出口 log 逐字保真（hardDeny/raw 写盘出口原带 tool/file，agent 派发/denyOrHint 出口原不带）。
  // action 可带 ${teammateTag} 后缀（仅 log 用），查表用去后缀的 base code。未登记 code 直接抛错
  // （fail-fast，防新出口漏登记）。
  function emitDeny(action, reason, fields = {}) {
    const baseCode = String(action).replace(/_TEAMMATE$/, '');
    const meta = DENY_REASONS[baseCode];
    if (!meta) throw new Error(`emitDeny: 未在 DENY_REASONS 登记的 deny action code: ${baseCode}`);
    let r = String(reason);
    if (meta.dirHint) r = paceUtils.appendArtifactDirHint(cwd, r);
    if (meta.escapeHatch) r = withEscapeHatch(r);
    let output;
    if (meta.teammateMode === 'soft' && isTeammate()) {
      output = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `PACE 提醒（teammate 模式）：${r}` } };
    } else {
      const finalReason = (meta.teammateMode === 'hard-note' && isTeammate())
        ? `${r}\n（teammate 模式：任务管理归主 session，请回报 team-lead 先完成批准/编排再执行，不要由 teammate 直接写代码或改 artifact。）`
        : r;
      output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: finalReason } };
    }
    process.stdout.write(JSON.stringify(output));
    log(projectLogEntry('PreToolUse', action, { proj, ...fields, dur: Date.now() - t0 }));
    return output;
  }
  function heartbeatChangeOwners(reason) {
    if (paceSignal !== 'artifact' || !stdin.sessionId) return;
    // CHG-20260611-02：同 session resume 后把本 session 的 detached 记录升回 active，
    // 防 sibling 在原 session 活跃时误判「可接手」（spec §3.2 revive）。
    paceUtils.reviveDetachedChangeOwnersForSession(cwd, { sessionId: stdin.sessionId });
    const touched = paceUtils.touchChangeOwnersForSession(cwd, {
      sessionId: stdin.sessionId,
      // CHG-20260614-02 T-001：刷新本 session 所有非-detached/非-closed owner（detached 故意 aging 作 takeover 窗口，不刷）。
      states: ['active', 'closing', 'backlog', 'ready', 'blocked'],
    });
    if (touched.length > 0) {
      log(projectLogEntry('PreToolUse', 'CHANGE_OWNER_HEARTBEAT', {
        proj,
        reason,
        changes: touched.join(','),
        dur: Date.now() - t0,
      }));
    }
  }
  const teammateTag = isTeammate() ? '_TEAMMATE' : '';

  // W-3: 缓存 isPaceProject 结果（避免多次调用）
  const paceSignal = isPaceProject(cwd);
  const artifactWriterAgentRequested = isAgentTool(toolName) && isArtifactWriterAgentTool(stdin);
  const paceEntrySignal = paceSignal || (artifactWriterAgentRequested ? 'artifact-writer-agent' : false);
  const artDir = getArtifactDir(cwd);
  const rootConfigError = paceEntrySignal ? paceUtils.artifactRootConfigError(cwd) : null;
  const needsArtifactRootChoice = artifactRootChoiceNeeded(cwd);
  const artifactRootChoiceReason = needsArtifactRootChoice ? artifactRootChoiceMessage(cwd) : '';
  // CHG-20260612-02：v5 布局只剩检测事实（W11 守卫 / 激活信号用），迁移门控随 v5 迁移路径退役。
  const v5MigrationInfo = getV5MigrationInfo(cwd);
  const artifactRootHint = paceUtils.artifactDirRuntimeHint(cwd);
  log(projectLogEntry('PreToolUse', 'ROUTE', {
    proj,
    signal: paceEntrySignal || 'none',
    artifact_dir: displayDir(artDir),
    choice: paceUtils.readArtifactRootChoice(cwd) || 'auto',
    choice_pending: needsArtifactRootChoice,
    legacy_v5: v5MigrationInfo.detected,
  }));
  if (paceSignal === 'artifact' && (isFileMutationTool(toolName) || isCommandExecutionTool(toolName))) {
    heartbeatChangeOwners(toolName);
  }
  const taskFp = path.join(artDir, 'task.md');
  const taskFileExists = fs.existsSync(taskFp);
  function ensureArtifactWriterBase() {
    const missingBefore = [];
    const changesDir = path.join(artDir, 'changes');
    if (!fs.existsSync(changesDir)) missingBefore.push('changes/');
    for (const sub of ['changes/findings', 'changes/corrections']) {
      if (!fs.existsSync(path.join(artDir, sub))) missingBefore.push(`${sub}/`);
    }
    for (const file of ARTIFACT_FILES) {
      if (!fs.existsSync(path.join(artDir, file))) missingBefore.push(file);
    }
    let createdFiles = [];
    let error = '';
    if (missingBefore.length > 0) {
      try {
        createdFiles = createTemplates(cwd);
      } catch(e) {
        error = e.message || String(e);
      }
    }
    const missingAfter = [];
    if (!fs.existsSync(changesDir)) missingAfter.push('changes/');
    for (const sub of ['changes/findings', 'changes/corrections']) {
      if (!fs.existsSync(path.join(artDir, sub))) missingAfter.push(`${sub}/`);
    }
    for (const file of ARTIFACT_FILES) {
      if (!fs.existsSync(path.join(artDir, file))) missingAfter.push(file);
    }
    return { missingBefore, missingAfter, createdFiles, error };
  }

  // W-2: 使用 readActive 替换手动读取（内部自动解析 vault 路径）
  let taskActiveContent = readActive(cwd, 'task.md') || '';

  // v4.3.1: 仅 [ ]/[/]/[!] 算活跃任务，[x]/[-] 不算
  const hasActiveTasks = /- \[[ \/!]\]/.test(taskActiveContent);
  const isCodeFile = CODE_EXTS.some(ext => filePath.endsWith(ext));
  const fileName = filePath ? path.basename(filePath) : '';

  // P0-20260506-02: PACE 项目的 Write/Edit 保护链路必须 fail-closed。
  // 非 PACE 项目保持低干扰；PACE 项目中坏 stdin 或缺关键字段不能自然放行。
  if (paceEntrySignal) {
    if (!stdin.ok) {
      return hardDeny(
        'PACE hook 无法解析 Claude Code 提供的 Write/Edit JSON 输入。为避免绕过 artifact 保护，本次写入已阻止；请重试工具调用。',
        'DENY_BAD_STDIN',
        { stdin_ok: false }
      );
    }
    // Read-only Bash intentionally falls through: vault env/config errors only stop
    // operations that can mutate files or dispatch artifact-writer.
    if (rootConfigError && (isAgentTool(toolName) || isFileMutationTool(toolName) || (isCommandExecutionTool(toolName) && commandExecutionLooksMutating(toolName, commandInput)))) {
      return hardDeny(rootConfigError.message, 'DENY_ARTIFACT_ROOT_CONFIG', {
        code: rootConfigError.code,
        choice_path: rootConfigError.choicePath,
      });
    }
    const localChoiceDeny = commandLocalArtifactRootChoiceDeny(toolName, bashCommand, powershellCommand, cwd);
    if (localChoiceDeny) return hardDeny(localChoiceDeny.reason, localChoiceDeny.action, localChoiceDeny.fields);
    const projectMarkerDeny = commandProjectRootMarkerDeny(toolName, bashCommand, powershellCommand, cwd);
    if (projectMarkerDeny) return hardDeny(projectMarkerDeny.reason, projectMarkerDeny.action, projectMarkerDeny.fields);
    if (isAgentTool(toolName)) {
      // codex P2：artifact-writer Agent 派遣路径的 newer-schema 让位——8.0 数据不派旧 artifact-writer
      // 管理（会走 7.0 artifact-dir/lifecycle/base 裁判或创建 v7 模板写坏新数据）。与 V7F-5 直写写保护
      // 一致：artifact 写入对看不懂的 schema 不软化，deny 并提示升级 reload；位置在 lifecycle/base 校验之前。
      if (isArtifactWriterAgentTool(stdin)) {
        const newerSchema = paceUtils.detectNewerSchemaData(cwd);
        if (newerSchema.detected) {
          const reason = `检测到 artifact schema ${newerSchema.maxVersion} 高于当前插件支持的 7.0，不能派当前 artifact-writer 管理该数据（会用 7.0 逻辑裁判或创建模板写坏新数据）。请升级 PACEflow 插件并 reload 全部 session（含其他 worktree）后再派 artifact-writer。`;
          emitDeny(`DENY_AGENT_NEWER_SCHEMA${teammateTag}`, reason, { max_version: newerSchema.maxVersion });
          return;
        }
      }
      // CHG-20260814-02:宿主对命名 agent 的 SubagentStop 会把 agent_type 换成自定义 name(实测),
      // 命名派遣会让锁释放/owner 收口/报告观察整体静默失效——从源头拦截,resume 寻址用 spawn 返回的
      // agentId 即可,artifact-writer 不需要 name。
      if (isArtifactWriterAgentTool(stdin) && String((stdin.toolInput && stdin.toolInput.name) || '').trim()) {
        const reason = 'artifact-writer 派遣不得带 name 参数:命名派遣在部分场景(如 team 命名 teammate,2026-08-14 日志实拍)会让 SubagentStop 的 agent_type 变成自定义 name,破坏收口识别(锁释放 / owner 关闭 / 报告观察)。请移除 name 字段后重派同一 prompt;需要 resume 时用 spawn 返回的 agentId 寻址,不依赖 name。';
        emitDeny(`DENY_AGENT_NAMED_DISPATCH${teammateTag}`, reason, {
          agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
          name: String(stdin.toolInput.name || '').slice(0, 40),
        });
        return;
      }
      if (isArtifactWriterAgentTool(stdin) && needsArtifactRootChoice) {
        emitDeny(`DENY_AGENT_ARTIFACT_ROOT_CHOICE${teammateTag}`, artifactRootChoiceReason, {
          agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
        });
        return;
      }
      if (isArtifactWriterAgentTool(stdin) && !promptHasExactArtifactDir(stdin.toolInput.prompt, artDir)) {
        const declaredArtifactDir = extractPromptArtifactDir(stdin.toolInput.prompt);
        const reason = agentArtifactDirDenyReason(artDir, declaredArtifactDir, stdin.toolInput.prompt);
        emitDeny('DENY_AGENT_ARTIFACT_DIR', reason, {
          agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
          artifact_dir: displayDir(artDir),
          declared_artifact_dir: declaredArtifactDir ? displayDir(declaredArtifactDir) : '',
        });
        return;
      }
      if (isArtifactWriterAgentTool(stdin)) {
        const lifecycleReason = agentLifecyclePromptDenyReason(stdin.toolInput.prompt, artDir);
        if (lifecycleReason) {
          emitDeny('DENY_AGENT_LIFECYCLE_PROMPT', lifecycleReason, {
            agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
            reason: lifecycleReason.split('\n')[0],
          });
          return;
        }
        const legacyLock = paceUtils.readArtifactWriterLock(cwd);
        if (legacyLock.ok) {
          const legacyCheck = paceUtils.artifactWriterLockMatches(cwd, '__paceflow-new-agent__');
          if (!legacyCheck.ok && legacyCheck.reason !== 'stale-cleared') {
            const reason = legacyArtifactWriterLockDenyReason();
            emitDeny('DENY_AGENT_LEGACY_ARTIFACT_LOCK', reason, {
              agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
              artifact_dir: displayDir(artDir),
              lock: legacyLock.path,
              owner: legacyLock.sessionId || '',
            });
            return;
          }
        }
        const ensured = ensureArtifactWriterBase();
        if (ensured.missingAfter.length > 0) {
          paceUtils.clearArtifactReservation(cwd, { sessionId: stdin.sessionId, agentId: stdin.agentId });
          const errorLine = ensured.error ? `\n底层错误：${ensured.error}` : '';
          const reason = `PACE hook 无法在 artifact_dir 创建完整 Artifact 基础结构：${displayDir(artDir)}\n仍缺失：${ensured.missingAfter.join(', ')}${errorLine}\n请检查路径/权限后重试；禁止让 artifact-writer 自行创建 base changes/ 或根索引模板。`;
          emitDeny('DENY_AGENT_ARTIFACT_BASE', reason, {
            agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
            artifact_dir: displayDir(artDir),
            missing: ensured.missingAfter.join(', '),
            error: ensured.error,
          });
          return;
        }
        const operation = paceUtils.operationFromAgentPrompt(stdin.toolInput.prompt);
        let reservation = { reserved: false };
        if (operation === 'create-chg' || operation === 'record-correction') {
          const batchBlocks = operation === 'create-chg'
            ? parseBatchBlocks(stdin.toolInput.prompt)
            : { isBatch: false, blocks: [] };
          if (batchBlocks.isBatch) {
            // batch create：确定性校验每个块的 reserved-id 都匹配 hook 预留（单条流只验首块，这里补全 N 个）
            const batchOwner = { sessionId: stdin.sessionId, agentId: stdin.agentId };
            let badId = '';
            for (const b of batchBlocks.blocks) {
              const blockExplicit = { id: String(b.reservedId || '').toUpperCase(), fileRel: '', filePrefix: '' };
              const lookupRel = reservationRelForLookup(blockExplicit);
              const found = lookupRel ? paceUtils.findArtifactReservationForRel(cwd, batchOwner, lookupRel) : null;
              if (!reservationMatchesExplicit(found, blockExplicit)) { badId = blockExplicit.id || '(空)'; break; }
            }
            if (badId) {
              const reason = [
                `batch create CHG 中 reserved-id ${badId} 没有匹配的 hook 预留（无效或已过期）。`,
                FORMAT_SNIPPETS.skillRef,
                `请先在主 session 运行 Bash: node "${paceUtils.RESERVE_ARTIFACT_ID_SCRIPT}" --operation create-chg --count ${batchBlocks.blocks.length} --cwd "${cwd.replace(/\\/g, '/')}"，把输出的每个 reserved-id 原样放进对应 --- CHG i/N --- 块后重派；不要手写或复用旧 session 的 reserved-id。`,
              ].join('\n');
              emitDeny('DENY_AGENT_BATCH_RESERVED_MISMATCH', reason, {
                agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
                artifact_dir: displayDir(artDir),
                reserved: badId,
                blocks: batchBlocks.blocks.length,
              });
              return;
            }
          }
          const explicit = explicitReservationFromPrompt(stdin.toolInput.prompt);
          const hasExplicitReservation = !!(explicit.id || explicit.fileRel || explicit.filePrefix);
          if (!hasExplicitReservation) {
            const owner = { sessionId: stdin.sessionId, agentId: stdin.agentId };
            const existingReservation = paceUtils.readArtifactReservation(cwd, owner);
            reservation = existingReservation && existingReservation.operation === operation
              ? { reserved: true, ...existingReservation }
              : paceUtils.reserveArtifactId(cwd, {
                sessionId: stdin.sessionId,
                agentId: stdin.agentId,
                artifactDir: artDir,
                operation,
                prompt: stdin.toolInput.prompt,
              });
            if (!reservation.reserved) {
              const reason = [
                `PACE hook 无法为 ${operation} 预留唯一编号，已阻止本次 artifact-writer 以避免并发 ID 冲突。`,
                reservation.lock && reservation.lock.ok ? `当前 sequence 锁：${paceUtils.formatArtifactResourceLock(reservation.lock)}` : `原因：${reservation.reason || 'unknown'}`,
                '请稍后重试；不要让 agent 自行扫描索引分配编号。'
              ].join('\n');
              emitDeny('DENY_AGENT_ID_RESERVATION', reason, {
                agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
                artifact_dir: displayDir(artDir),
                operation,
                reason: reservation.reason || '',
              });
              return;
            }
            const reason = reservationRequiredReason(operation, artDir, reservation, cwd);
            emitDeny('DENY_AGENT_RESERVED_PROMPT_REQUIRED', reason, {
              agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
              artifact_dir: displayDir(artDir),
              operation,
              reserved: reservation.id || reservation.fileRel || reservation.filePrefix || '',
            });
            return;
          }

          const lookupRel = reservationRelForLookup(explicit);
          reservation = lookupRel
            ? paceUtils.findArtifactReservationForRel(cwd, { sessionId: stdin.sessionId, agentId: stdin.agentId }, lookupRel)
            : paceUtils.readArtifactReservation(cwd, { sessionId: stdin.sessionId, agentId: stdin.agentId });
          if (!reservationMatchesExplicit(reservation, explicit)) {
            const reason = reservationExplicitMissingReason(operation, explicit, cwd);
            emitDeny('DENY_AGENT_RESERVED_PROMPT_MISMATCH', reason, {
              agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
              artifact_dir: displayDir(artDir),
              operation,
              reserved: explicit.id || explicit.fileRel || explicit.filePrefix || '',
            });
            return;
          }
          reservation = { reserved: true, ...reservation };
        }
        const explicitTargetChangeId = paceUtils.explicitChangeTargetFromAgentPrompt(stdin.toolInput.prompt);
        if (['update-chg', 'close-chg', 'archive-chg'].includes(operation) && !explicitTargetChangeId) {
          const reason = [
            `派 artifact-writer 执行 ${operation} 时缺少明确 target。`,
            FORMAT_SNIPPETS.skillRef,
            '请重派同一个 agent，并在 prompt 顶部使用完整模板：',
            promptTemplateForOperation({ prompt: stdin.toolInput.prompt, artDir, operation }),
            '不要只在正文或摘要里提到 CHG-ID；hook 不会用正文中随便出现的 ID 判断 owner。'
          ].join('\n');
          emitDeny('DENY_AGENT_TARGET_REQUIRED', reason, {
            agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
            operation,
          });
          return;
        }
        const targetChangeId = operation === 'create-chg'
          ? (reservation && reservation.id || paceUtils.changeIdFromAgentPrompt(stdin.toolInput.prompt))
          : explicitTargetChangeId;
        if (targetChangeId && ['update-chg', 'close-chg', 'archive-chg'].includes(operation)) {
          const ownerStatus = paceUtils.changeOwnerStatus(cwd, targetChangeId, stdin.sessionId);
          // CHG-20260611-02：sibling-fresh（同目录另一活跃 session）不可静默接手，但接受 takeover
          // 三字段显式接手（覆盖 crash 后 TTL 窗口内用户要求立即接续的场景；owner 改写后原 session
          // 自动变 sibling 被隔离）。foreign-fresh 维持无条件 deny（跨 checkout 抢活跃 CHG 风险不同）。
          if (['foreign-fresh', 'sibling-fresh'].includes(ownerStatus.disposition)
            && !(ownerStatus.disposition === 'sibling-fresh' && paceUtils.ownerTakeoverConfirmed(stdin.toolInput.prompt))) {
            const siblingFresh = ownerStatus.disposition === 'sibling-fresh';
            const reason = [
              siblingFresh
                ? `${targetChangeId} 正由同目录另一个 Claude Code session 负责（owner fresh），当前 session 不应静默接手更新或收尾。`
                : `${targetChangeId} 正由另一个 Claude Code session 负责，当前 session 不应接手更新或收尾。`,
              `owner: worktree=${ownerStatus.owner.worktree || '-'} branch=${ownerStatus.owner.branch || '-'} state=${ownerStatus.owner.state || '-'}`,
              siblingFresh
                ? '该 session 可能仍活跃；优先在原 session 完成、暂停或取消。若用户明确要求本 session 接手（先用 AskUserQuestion 确认），重派同一 artifact-writer 并加入 owner-takeover-confirmed: true / owner-takeover-source: user-directive / owner-takeover-evidence: <用户原话>。'
                : '请回到该 worktree/session 完成、暂停或取消；当前 fresh owner 仍有效时，不要由本 session 接手。'
            ].join('\n');
            emitDeny('DENY_AGENT_CHANGE_OWNER', reason, {
              agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
              target: targetChangeId,
              owner_session: ownerStatus.owner.sessionId || '',
              owner_state: ownerStatus.owner.state || '',
              owner_worktree: ownerStatus.owner.worktree || '',
            });
            return;
          }
          // CHG-20260611-02：sibling-detached（原 session 正常关闭）/ sibling-stale（疑似 crash）
          // 与 foreign-stale 同走 takeover 协议——带齐三字段即可接手。
          if (['foreign-stale', 'sibling-stale', 'sibling-detached'].includes(ownerStatus.disposition) && !paceUtils.ownerTakeoverConfirmed(stdin.toolInput.prompt)) {
            const reason = [
              ownerStatus.disposition === 'sibling-detached'
                ? `${targetChangeId} 的原 session 已正常关闭（owner detached），接手需用户确认。`
                : `${targetChangeId} 的 owner 记录已过期，但属于另一个 session。`,
              '若用户明确要求由当前 session 接手（先用 AskUserQuestion 确认），请重派同一 artifact-writer，并加入：',
              'owner-takeover-confirmed: true',
              'owner-takeover-source: user-directive',
              'owner-takeover-evidence: <用户明确要求当前 session 接手的原话>'
            ].join('\n');
            emitDeny('DENY_AGENT_CHANGE_OWNER_STALE', reason, {
              agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
              target: targetChangeId,
              owner_session: ownerStatus.owner.sessionId || '',
            });
            return;
          }
        }
        if (targetChangeId && ['create-chg', 'update-chg', 'close-chg', 'archive-chg'].includes(operation)) {
          const action = operation === 'update-chg' ? promptDeclaredAction(stdin.toolInput.prompt) : '';
          const updateStatusValue = operation === 'update-chg' ? promptUpdateStatusValue(stdin.toolInput.prompt) : '';
          const ownerState = ['close-chg', 'archive-chg'].includes(operation)
            ? 'closing'
            : operation === 'create-chg'
              ? 'backlog'
            : action === 'approve'
              ? 'ready'
            : updateStatusValue === '!'
              ? 'blocked'
              : 'active';
          const ownerWrite = paceUtils.writeChangeOwner(cwd, targetChangeId, {
            sessionId: stdin.sessionId,
            agentId: stdin.agentId,
            operation,
            state: ownerState,
          });
          log(projectLogEntry('PreToolUse', ownerWrite.ok ? 'CHANGE_OWNER_SET' : 'CHANGE_OWNER_SET_FAILED', {
            proj,
            target: targetChangeId,
            operation,
            state: ownerState,
            reason: ownerWrite.reason || '',
            dur: Date.now() - t0,
          }));
        }
        const created = [...new Set([
          ...ensured.createdFiles,
          ...(ensured.missingBefore.includes('changes/') ? ['changes/'] : []),
          ...(ensured.missingBefore.includes('changes/findings/') ? ['changes/findings/'] : []),
          ...(ensured.missingBefore.includes('changes/corrections/') ? ['changes/corrections/'] : []),
        ])];
        const createdMsg = created.length > 0 ? `；已自动创建 Artifact 基础模板：${created.join(', ')}` : '';
        const reservationMsg = reservation.reserved
          ? `；reserved-id: ${reservation.id}${reservation.fileRel ? `；reserved-file: ${reservation.fileRel}` : ''}${reservation.filePrefix ? `；reserved-file-prefix: ${reservation.filePrefix}<slug>.md` : ''}。必须使用该预留编号，不得重新扫描索引分配编号`
          : '';
        const output = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: `artifact-writer ARTIFACT_DIR 已确认：${displayDir(artDir)}；仅用于 ${paceUtils.PACE_ARTIFACT_ROOT_CONTENT}；execution-context: ${paceUtils.executionContextForCwd(cwd).text}${reservationMsg}${createdMsg}`
          }
        };
        process.stdout.write(JSON.stringify(output));
        log(projectLogEntry('PreToolUse', 'PASS_AGENT_ARTIFACT_BASE', {
          proj,
          agent: stdin.toolInput.subagent_type || stdin.toolInput.subagentType,
          artifact_dir: displayDir(artDir),
          operation,
          reserved: reservation.reserved ? (reservation.id || reservation.fileRel || reservation.filePrefix || '') : '',
          created: created.join(', '),
          dur: Date.now() - t0,
        }));
        return;
      }
      log(projectLogEntry('PreToolUse', 'PASS_AGENT', { proj, tool: toolName, dur: Date.now() - t0 }));
      return;
    }
    if (isBashTool(toolName)) {
      if (bashCommandMutatesArtifactRuntimeControl(bashCommand, cwd)) {
        const reason = bashArtifactRuntimeControlDenyReason(bashCommand);
        return hardDeny(reason, `DENY_BASH_ARTIFACT_RUNTIME${teammateTag}`, {
          command: String(bashCommand).slice(0, 160).replace(/\n/g, ' '),
          runtime: paceUtils.getProjectRuntimeDir(cwd),
        });
      }
      const mutatesArtifact = bashCommandMutatesArtifact(bashCommand, cwd, artDir);
      if (mutatesArtifact) {
        const reason = bashArtifactDenyReason(bashCommand);
        emitDeny(`DENY_BASH_ARTIFACT${teammateTag}`, reason, {
          command: String(bashCommand).slice(0, 160).replace(/\n/g, ' '),
        });
        return;
      }
      log(projectLogEntry('PreToolUse', 'PASS_BASH', { proj, dur: Date.now() - t0 }));
      return;
    }
    if (isPowerShellTool(toolName)) {
      if (powershellCommandMutatesArtifactRuntimeControl(powershellCommand, cwd)) {
        const reason = powershellArtifactRuntimeControlDenyReason(powershellCommand);
        return hardDeny(reason, `DENY_POWERSHELL_ARTIFACT_RUNTIME${teammateTag}`, {
          command: String(powershellCommand).slice(0, 160).replace(/\n/g, ' '),
          runtime: paceUtils.getProjectRuntimeDir(cwd),
        });
      }
      const mutatesArtifact = powershellCommandMutatesArtifact(powershellCommand, cwd, artDir);
      if (mutatesArtifact) {
        const reason = powershellArtifactDenyReason(powershellCommand);
        emitDeny(`DENY_POWERSHELL_ARTIFACT${teammateTag}`, reason, {
          command: String(powershellCommand).slice(0, 160).replace(/\n/g, ' '),
        });
        return;
      }
      log(projectLogEntry('PreToolUse', 'PASS_POWERSHELL', { proj, dur: Date.now() - t0 }));
      return;
    }
    if (isMonitorTool(toolName)) {
      if (bashCommandMutatesArtifactRuntimeControl(bashCommand, cwd)) {
        const reason = monitorArtifactRuntimeControlDenyReason(bashCommand);
        return hardDeny(reason, `DENY_MONITOR_ARTIFACT_RUNTIME${teammateTag}`, {
          command: String(bashCommand).slice(0, 160).replace(/\n/g, ' '),
          runtime: paceUtils.getProjectRuntimeDir(cwd),
        });
      }
      const mutatesArtifact = bashCommandMutatesArtifact(bashCommand, cwd, artDir);
      if (mutatesArtifact) {
        const reason = monitorArtifactDenyReason(bashCommand);
        emitDeny(`DENY_MONITOR_ARTIFACT${teammateTag}`, reason, {
          command: String(bashCommand).slice(0, 160).replace(/\n/g, ' '),
        });
        return;
      }
      log(projectLogEntry('PreToolUse', 'PASS_MONITOR', { proj, dur: Date.now() - t0 }));
      return;
    }
    if (!isFileMutationTool(toolName)) {
      return hardDeny(
        `PACE hook 收到缺失或未知工具名：${toolName || '(empty)'}。本 hook 只允许处理 Write/Edit/MultiEdit/Agent/Bash/PowerShell/Monitor，已阻止以避免绕过保护。`,
        'DENY_BAD_TOOL'
      );
    }
    if (!rawFilePath) {
      return hardDeny(
        'PACE hook 缺少 tool_input.file_path，无法判断写入是否会修改 artifact。为避免绕过保护，本次写入已阻止；请重试工具调用。',
        'DENY_MISSING_FILE_PATH'
      );
    }
  }

  // v4.3.1: 项目外文件豁免（Project Root 与 artifact 目录均视为"项目内"）
  // H-1: 使用 normalizePath 跨平台适配（Windows toLowerCase，Linux 保持原样）
  const normalizedFile = paceUtils.normalizePath(filePath);
  const rootInfo = paceUtils.resolveEffectiveProjectRoot(cwd);
  const executionContext = paceUtils.executionContextForCwd(cwd);
  // Worktree 的代码边界是 checkout 根，不是当前子目录；真正写宿主
  // checkout 的普通文件仍只给 soft note。普通 inherited 子目录则由父
  // Project Root 承担 C/E gate，覆盖父目录与 sibling 文件。
  const projectBoundary = rootInfo.mode === 'worktree'
    ? (executionContext.checkoutDir || cwd)
    : rootInfo.projectRoot;
  const normalizedProjectBoundary = paceUtils.normalizePath(projectBoundary);
  if (isFileMutationTool(toolName) && paceUtils.isLocalArtifactRootChoicePath(cwd, filePath)) {
    return hardDeny(
      paceUtils.localArtifactRootChoiceDenyReason(cwd),
      'DENY_LOCAL_ARTIFACT_ROOT_CHOICE',
      {
        file: filePath,
        authoritative: paceUtils.getArtifactRootChoicePath(cwd),
      }
    );
  }
  const localChoiceDeny = commandLocalArtifactRootChoiceDeny(toolName, bashCommand, powershellCommand, cwd);
  if (localChoiceDeny) return hardDeny(localChoiceDeny.reason, localChoiceDeny.action, localChoiceDeny.fields);
  if (isFileMutationTool(toolName) && paceUtils.isProjectRootMarkerPath(cwd, filePath)) {
    return hardDeny(
      paceUtils.projectRootMarkerDenyReason(cwd),
      'DENY_PROJECT_ROOT_MARKER',
      {
        file: filePath,
        agent_id: stdin.agentId,
        agent_type: stdin.agentType,
      }
    );
  }
  const projectMarkerDeny = commandProjectRootMarkerDeny(toolName, bashCommand, powershellCommand, cwd);
  if (projectMarkerDeny) return hardDeny(projectMarkerDeny.reason, projectMarkerDeny.action, projectMarkerDeny.fields);
  if (isFileMutationTool(toolName) && paceUtils.isArtifactRuntimeControlPath(cwd, filePath)) {
    return hardDeny(
      `禁止使用 ${toolName} 修改 PaceFlow artifact 写入控制运行态：${filePath}。锁、编号计数与 reservation 只能由 hook 管理；不要手写或删除运行态文件。`,
      'DENY_ARTIFACT_RUNTIME_CONTROL',
      {
        file: filePath,
        agent_id: stdin.agentId,
        agent_type: stdin.agentType,
      }
    );
  }
  const projectBoundaryWithSlash = normalizedProjectBoundary.endsWith('/')
    ? normalizedProjectBoundary
    : normalizedProjectBoundary + '/';
  const artifactRelForMutation = getArtifactRelIfRelevant(toolName, paceSignal, artDir, filePath);
  // Artifact paths are part of the guarded project surface even when vault/local routing
  // puts them outside the current worktree cwd. Ordinary host-checkout files from a
  // worktree get a soft note only; PaceFlow hard-gates artifact semantics, not generic
  // edits to every path the user may explicitly request.
  const isInsideProject = normalizedFile.startsWith(projectBoundaryWithSlash) || !!artifactRelForMutation;
  const hostNonArtifactWriteNote = isFileMutationTool(toolName) && paceSignal
    ? worktreeHostNonArtifactWriteNote(cwd, artDir, filePath, artifactRelForMutation)
    : '';
  let artifactResourceLockHeld = null;
  if (artifactRelForMutation) {
    if (isArtifactWriterAgent(stdin)) {
      if (isChangeDetailArtifactRel(artifactRelForMutation)) {
        // CHG-20260614-02 T-002：写盘 owner 复核——闭合 dispatch→write 判定割裂。已 takeover 的 CHG 在 dispatch 时
        // owner 已改写为当前 session（→current 放行）；仍为 foreign/sibling-fresh 即此 CHG 非本次派发目标、未接手，
        // artifact-writer 越权改他人活跃 CHG 详情，deny（与派发门同构，不依赖资源锁只防并发不防越权）。
        const writeOwnerChangeId = paceUtils.changeIdFromArtifactRel(artifactRelForMutation);
        if (writeOwnerChangeId) {
          const writeOwner = paceUtils.changeOwnerStatus(cwd, writeOwnerChangeId, stdin.sessionId);
          if (writeOwner.disposition === 'foreign-fresh' || writeOwner.disposition === 'sibling-fresh') {
            const reason = [
              `禁止写入由其他活跃 session 持有的 CHG 详情：${artifactRelForMutation}（owner disposition: ${writeOwner.disposition}）。`,
              '该 CHG 不是本次 artifact-writer 派发的目标，也未经 owner-takeover 三字段握手接手。',
              '请只修改本次派发目标 CHG 的详情；如确需接手该 CHG，先在 Agent 派发时带 takeover 三字段。',
            ].join('\n');
            emitDeny('DENY_WRITE_FOREIGN_OWNER', reason, { target: writeOwnerChangeId, artifact: artifactRelForMutation, disposition: writeOwner.disposition });
            return;
          }
        }
        const mutationText = [content, newString].filter(Boolean).join('\n');
        if (/^status:\s*archived\s*$/mi.test(mutationText)) {
          // v7（CHG-20260611-08）：归档前置只检 task.md 双区结构（唯一索引）。
          const missingArchive = ['task.md'].filter(file => {
            try { return !paceUtils.ARCHIVE_PATTERN.test(fs.readFileSync(path.join(artDir, file), 'utf8')); }
            catch(e) { return true; }
          });
          if (missingArchive.length > 0) {
            const reason = [
              `禁止在根索引缺少 ARCHIVE 标记时先把详情归档：${artifactRelForMutation}。`,
              `缺少 ARCHIVE 标记：${missingArchive.join(', ')}`,
              '请先修复根索引双区结构，再执行 close-chg / archive-chg；不要留下详情 archived 但索引仍活跃的半归档状态。'
            ].join('\n');
            emitDeny('DENY_ARCHIVE_WITHOUT_INDEX_MARKER', reason, {
              tool: toolName,
              file: filePath,
              artifact: artifactRelForMutation,
              missing: missingArchive.join(','),
              agent_id: stdin.agentId,
              agent_type: stdin.agentType,
            });
            return;
          }
        }
      }
      if (toolName === 'Write' && isChangeDetailArtifactRel(artifactRelForMutation)) {
        const fm = paceUtils.parseFrontmatter(content || '');
        const status = String(fm.status || '').replace(/^["']|["']$/g, '').trim();
        if (status && !['planned', 'in-progress', 'completed', 'archived', 'cancelled'].includes(status)) {
          const reason = `CHG/HOTFIX 详情 frontmatter status 非法：${status}。允许值：planned / in-progress / completed / archived / cancelled。create-chg 初始状态必须是 planned。`;
          emitDeny('DENY_ARTIFACT_STATUS_INVALID', reason, {
            tool: toolName,
            file: filePath,
            artifact: artifactRelForMutation,
            status,
            agent_id: stdin.agentId,
            agent_type: stdin.agentType,
          });
          return;
        }
      }
      let reservation = paceUtils.findArtifactReservationForRel(cwd, {
        sessionId: stdin.sessionId,
        agentId: stdin.agentId,
      }, artifactRelForMutation);
      if (toolName === 'Write') {
        const writeNeedsReservation = !fs.existsSync(filePath) && (
          isChangeDetailArtifactRel(artifactRelForMutation) ||
          /^changes\/corrections\/correction-\d{4}-\d{2}-\d{2}-\d{2}-.+\.md$/i.test(artifactRelForMutation)
        );
        if (writeNeedsReservation && !reservation) {
          const reserveOp = /^changes\/corrections\//i.test(artifactRelForMutation) ? 'record-correction' : 'create-chg';
          const reason = [
            `artifact-writer 正在新建 ${artifactRelForMutation}，但当前 session/agent 没有 hook 预留编号。`,
            `请先在主 session 运行 Bash: node "${paceUtils.RESERVE_ARTIFACT_ID_SCRIPT}" --operation ${reserveOp} --cwd "${cwd.replace(/\\/g, '/')}"，把 helper 输出（reserved-id / reserved-file-prefix）放进 artifact-writer prompt 顶部后重派。`,
            '不要让 agent 自行扫描索引分配 CHG/HOTFIX/CORRECTION 编号。'
          ].join('\n');
          emitDeny('DENY_ARTIFACT_RESERVATION_MISSING', reason, {
            tool: toolName,
            file: filePath,
            artifact: artifactRelForMutation,
            agent_id: stdin.agentId,
            agent_type: stdin.agentType,
          });
          return;
        }
        if (!reservation) {
          reservation = paceUtils.readArtifactReservation(cwd, {
            sessionId: stdin.sessionId,
            agentId: stdin.agentId,
          });
        }
        const reservationMatch = writeNeedsReservation
          ? paceUtils.reservationMatchesArtifactRel(reservation, artifactRelForMutation)
          : { ok: true };
        if (!reservationMatch.ok) {
          const reason = artifactReservationDenyReason(reservationMatch, artifactRelForMutation);
          emitDeny('DENY_ARTIFACT_RESERVATION_MISMATCH', reason, {
            tool: toolName,
            file: filePath,
            artifact: artifactRelForMutation,
            agent_id: stdin.agentId,
            agent_type: stdin.agentType,
            expected: reservationMatch.expected,
          });
          return;
        }
      }
      const resource = paceUtils.artifactResourceForRel(artifactRelForMutation);
      const lockAttempt = paceUtils.acquireArtifactResourceLock(cwd, resource, {
        sessionId: stdin.sessionId,
        agentId: stdin.agentId,
        artifactDir: artDir,
        file: filePath,
        operation: reservation && reservation.operation || '',
        toolName,
      });
      if (!lockAttempt.acquired) {
        const reason = artifactResourceLockDenyReason(artifactRelForMutation);
        emitDeny('DENY_ARTIFACT_RESOURCE_LOCK', reason, {
          tool: toolName,
          file: filePath,
          artifact: artifactRelForMutation,
          resource,
          agent_id: stdin.agentId,
          agent_type: stdin.agentType,
          reason: lockAttempt.reason,
        });
        return;
      }
      artifactResourceLockHeld = resource;
      log(projectLogEntry('PreToolUse', lockAttempt.reentrant ? 'PASS_ARTIFACT_RESOURCE_LOCK_REENTRANT' : 'PASS_ARTIFACT_RESOURCE_LOCK', {
        proj,
        tool: toolName,
        file: filePath,
        artifact: artifactRelForMutation,
        resource,
        agent_id: stdin.agentId,
        agent_type: stdin.agentType,
        waited_ms: lockAttempt.waitedMs || 0,
        dur: Date.now() - t0,
      }));
    } else {
      const resource = paceUtils.artifactResourceForRel(artifactRelForMutation);
      const existingLock = resource ? paceUtils.readArtifactResourceLock(cwd, resource) : { ok: false };
      if (existingLock.ok) {
        const reason = [
          `当前 artifact 正由 artifact-writer 写入，禁止主 session/其他 agent 同时修改 ${artifactRelForMutation}。`,
          '请等待 artifact 写入结束后再重试。'
        ].join('\n');
        emitDeny('DENY_ARTIFACT_CONCURRENT_WRITE', reason, {
          tool: toolName,
          file: filePath,
          artifact: artifactRelForMutation,
          resource,
          owner: existingLock.sessionId,
        });
        return;
      }
    }
  }

  // v4.8: artifact 已迁移到 vault 时，拦截对 CWD 中 artifact 文件的 Write/Edit 并重定向
  if (isFileMutationTool(toolName) && artDir !== cwd && paceSignal) {
    const cwdArtifactRel = paceUtils.artifactRelativePathForFile(cwd, filePath);
    if (cwdArtifactRel) {
      if (artifactResourceLockHeld) {
        paceUtils.releaseArtifactResourceLock(cwd, artifactResourceLockHeld, { sessionId: stdin.sessionId, agentId: stdin.agentId });
        artifactResourceLockHeld = null;
      }
      const correctPath = path.join(artDir, cwdArtifactRel).replace(/\\/g, '/');
      const reason = `当前 artifact_dir 是 ${displayDir(artDir)}。请将 artifact file_path 修改为：${correctPath}`;
      emitDeny('DENY_REDIRECT', reason, { tool: toolName, file: filePath, artifact: cwdArtifactRel, redirect: correctPath });
      return;
    }
  }

  if (isArtifactWriterManagedRel(artifactRelForMutation) && toolName === 'Write' && !isArtifactWriterAgent(stdin)) {
    return hardDeny(
      directArtifactMutationDenyReason(toolName, artifactRelForMutation),
      'DENY_DIRECT_ARTIFACT_WRITE',
      {
        artifact: artifactRelForMutation,
        agent_id: stdin.agentId,
        agent_type: stdin.agentType,
      }
    );
  }

  // A04：非 artifact 信号项目（manual/.pace-enabled/code-count）的 Edit/MultiEdit managed artifact
  // 也拦截，与上方 Write 兜底对称。artifact 信号走下方 `paceSignal === 'artifact'` 块内的 marker 检测
  // + Edit 兜底（此处 paceSignal !== 'artifact' 守卫避免抢占 DENY_V6_MARKER 路径）。
  if (isArtifactWriterManagedRel(artifactRelForMutation) && isEditMutationTool(toolName) &&
      paceSignal !== 'artifact' && !isArtifactWriterAgent(stdin)) {
    return hardDeny(
      directArtifactMutationDenyReason(toolName, artifactRelForMutation), // dirHint 由 emitDeny dh:true 富化
      'DENY_DIRECT_ARTIFACT_EDIT',
      {
        artifact: artifactRelForMutation,
        agent_id: stdin.agentId,
        agent_type: stdin.agentType,
      }
    );
  }

  if (isEditMutationTool(toolName) && isInsideProject && paceSignal) {
    const artifactRel = paceUtils.artifactRelativePathForFile(artDir, filePath);
    if (artifactRel && fs.existsSync(filePath) && isArtifactWriterAgent(stdin)) {
      try {
        const current = fs.readFileSync(filePath, 'utf8');
        const normalized = paceUtils.normalizeLineEndings(current);
        if (normalized !== current) {
          fs.writeFileSync(filePath, normalized, 'utf8');
          log(projectLogEntry('PreToolUse', 'NORMALIZE_CRLF_ARTIFACT', {
            proj,
            tool: toolName,
            file: filePath,
            artifact: artifactRel,
            dur: Date.now() - t0,
          }));
        }
      } catch(e) {
        log(projectLogEntry('PreToolUse', 'NORMALIZE_CRLF_ARTIFACT_FAILED', {
          proj,
          tool: toolName,
          file: filePath,
          error: e.message,
          dur: Date.now() - t0,
        }));
      }
    }
  }

  // v4.3.2: Write 覆盖已有 artifact 保护（仅 PACE 项目内生效）
  if (toolName === 'Write' && isInsideProject && paceSignal) {
    if (artifactRelForMutation && fs.existsSync(filePath)) {
      if (artifactResourceLockHeld) {
        paceUtils.releaseArtifactResourceLock(cwd, artifactResourceLockHeld, { sessionId: stdin.sessionId, agentId: stdin.agentId });
      }
      const reason = `禁止使用 Write 覆盖已有 artifact：${artifactRelForMutation}。create-chg 若遇到同名文件必须重新分配 CHG-ID；更新已有 artifact 请使用 Edit。`;
      emitDeny('DENY_WRITE_EXISTING_ARTIFACT', reason, { tool: toolName, file: filePath, artifact: artifactRelForMutation });
      return;
    }
    if (PROTECTED_ARTIFACTS.includes(fileName) && fs.existsSync(filePath)) {
      const reason = `禁止使用 Write 覆盖已有的 ${fileName}，请使用 Edit 工具进行修改。Write 会丢失全部历史内容。${FORMAT_SNIPPETS.skillRef}`;
      emitDeny('DENY_WRITE_ARTIFACT', reason, { tool: toolName, file: filePath, reason });
      return;
    }
  }

  // T-206: Write 新建 artifact 文件时，注入对应模板内容引导格式
  if (toolName === 'Write' && isInsideProject && paceSignal) {
    if (ARTIFACT_FILES.includes(fileName) && !fs.existsSync(path.join(artDir, fileName))) {
      const TEMPLATES_DIR = path.join(__dirname, 'templates');
      const tmpl = path.join(TEMPLATES_DIR, fileName);
      if (fs.existsSync(tmpl)) {
        try {
          const tmplContent = paceUtils.normalizeLineEndings(fs.readFileSync(tmpl, 'utf8'));
          const ctx = `新建 ${fileName}：请严格按照以下官方模板格式，保留双区结构（${ARCHIVE_MARKER} 分隔符）和注释说明：\n\n${tmplContent}`;
          const output = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: ctx } };
          process.stdout.write(JSON.stringify(output));
          log(projectLogEntry('PreToolUse', 'INJECT_TEMPLATE', { proj, file: fileName, dur: Date.now() - t0 }));
          return;
        } catch(e) {}
      }
    }
  }

  // v4.4.1→v5.0.3: Obsidian 知识库笔记格式注入（Write 到 thoughts/knowledge 时注入格式要求）
  if (toolName === 'Write' && VAULT_PATH && filePath.endsWith('.md')) {
    const nf = normalizedFile;
    const vp = paceUtils.normalizePath(VAULT_PATH);
    const vpSlash = vp.endsWith('/') ? vp : vp + '/';
    let dirName = '';
    if (nf.startsWith(vpSlash + 'thoughts/')) dirName = 'thoughts';
    else if (nf.startsWith(vpSlash + 'knowledge/')) dirName = 'knowledge';
    if (dirName && path.basename(filePath) !== 'README.md') {
      const ctx = dirName === 'knowledge'
        ? '写入 knowledge/ 笔记时请先调用 Skill(paceflow:pace-knowledge)，按该 skill 的 frontmatter 与正文结构要求组织内容。'
        : '写入 thoughts/ 笔记时请先调用 Skill(paceflow:pace-knowledge)，按 thoughts 笔记格式组织 frontmatter 与正文。';
      const output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: ctx
        }
      };
      process.stdout.write(JSON.stringify(output));
      log(projectLogEntry('PreToolUse', 'INJECT_FORMAT', { proj, file: filePath, dir: dirName, dur: Date.now() - t0 }));
      return;
    }
  }

  // v6: 项目一旦有 changes/，所有执行前检查只看详情文件与索引 wikilink。
  if (paceSignal === 'artifact') {
    const activeEntriesAll = getActiveChangeEntries(cwd);
    const actionableEntries = activeEntriesAll.filter(e => {
      const m = e.taskCheckbox;
      return m === ' ' || m === '/' || m === '!';
    });

    // 阻止主 session 直接手写 C/V 阶段标志；应派 artifact writer。
    const markerMutation = detectChangeDetailMarkerMutation({
      artifactRel: artifactRelForMutation,
      newString,
      oldString,
      content,
    });
    if (isFileMutationTool(toolName) && isInsideProject && markerMutation.hasMarkerMutation) {
      if (!isArtifactWriterAgent(stdin)) {
        const reason = markerMutationDenyReason(markerMutation);
        return hardDeny(reason, `DENY_V6_MARKER${teammateTag}`, {
          agent_id: stdin.agentId,
          agent_type: stdin.agentType,
          addedApproved: markerMutation.addedApproved,
          addedVerified: markerMutation.addedVerified,
          setVerifiedDate: markerMutation.setVerifiedDate,
          addedReviewed: markerMutation.addedReviewed,
          setReviewedDate: markerMutation.setReviewedDate,
        });
      }
      log(projectLogEntry('PreToolUse', 'PASS_V6_MARKER_AGENT', {
        proj,
        file: filePath,
        agent_id: stdin.agentId,
        agent_type: stdin.agentType,
        addedApproved: markerMutation.addedApproved,
        addedVerified: markerMutation.addedVerified,
        setVerifiedDate: markerMutation.setVerifiedDate,
        addedReviewed: markerMutation.addedReviewed,
        setReviewedDate: markerMutation.setReviewedDate,
        dur: Date.now() - t0,
      }));
    }

    if (isArtifactWriterManagedRel(artifactRelForMutation) && !isArtifactWriterAgent(stdin)) {
      return hardDeny(
        directArtifactMutationDenyReason(toolName, artifactRelForMutation), // dirHint 由 emitDeny dh:true 富化
        'DENY_DIRECT_ARTIFACT_EDIT',
        {
          artifact: artifactRelForMutation,
          agent_id: stdin.agentId,
          agent_type: stdin.agentType,
        }
      );
    }

    // CHG-20260611-03：session 级 pause——免除下方流程门（写码门/索引结构/批准门），
    // 不免上方 artifact 完整性门（marker gate / DENY_DIRECT_ARTIFACT_EDIT / Bash artifact 防护）。
    if (paceUtils.isSessionPaused(cwd, stdin.sessionId)) {
      log(projectLogEntry('PreToolUse', 'SKIP_SESSION_PAUSED', { proj, tool: toolName, dur: Date.now() - t0 }));
      return;
    }

    // 前向兼容 guard（CHG-20260612-04）：数据 schema 比本 hook 新 → 下方全部流程门
    // （索引结构/批准/执行/无活跃 CHG）让位为软提示——hook 对看不懂的数据没有裁判权。
    // 位置在 artifact 完整性门（marker / 直写 / pause）之后：写保护语义与 schema 版本无关，不软化。
    {
      const newerSchema = paceUtils.detectNewerSchemaData(cwd, activeEntriesAll);
      if (newerSchema.detected) {
        const ctx = `检测到 artifact schema ${newerSchema.maxVersion} 高于当前插件支持的 7.0，流程门已让位（本次操作放行）。本插件无法正确管理该数据：请升级 PACEflow 插件，并 reload 全部 session（含其他 worktree）。`;
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx } }));
        log(projectLogEntry('PreToolUse', `PASS_NEWER_SCHEMA${teammateTag}`, { proj, tool: toolName, max_version: newerSchema.maxVersion, dur: Date.now() - t0 }));
        return;
      }
    }

    const ownerStatusById = new Map(actionableEntries.map(e => [e.id, paceUtils.changeOwnerStatus(cwd, e.id, stdin.sessionId)]));
    // CHG-20260611-02 收紧：写码门排除同目录其他 session 持有的 CHG（B 不搭 A 便车）；
    // foreign worktree 的既有搭便车行为不动（范围见 spec §3.1 消费点 3，后议 finding）。
    const nonSiblingActionableEntries = actionableEntries.filter(e => !String(ownerStatusById.get(e.id).disposition || '').startsWith('sibling-'));
    const currentToolIsArtifactWriter = isArtifactWriterAgent(stdin);
    const artifactWriterArtifactMutation = currentToolIsArtifactWriter && !!artifactRelForMutation;
    // CHG-20260616-01 T-001：写码门回归单一判据「文件是不是代码」——删执行期完整性门第二分支
    //（原「持有 owned actionable CHG 时非代码文件也门控」）。非代码文件（文档/配置）不再进流程门、
    // 一律放行；artifact 完整性门（structuralCheckNeeded / marker / 直写）独立保留，不受影响。
    const projectMutationNeedsGate = !artifactWriterArtifactMutation && isInsideProject && isCodeFile;
    const gatedEntries = nonSiblingActionableEntries;
    const structuralCheckNeeded = !artifactWriterArtifactMutation && isInsideProject && (isCodeFile || isFileMutationTool(toolName));

    if (structuralCheckNeeded) {
      const malformed = actionableEntries.filter(e => e.taskMalformed);
      if (malformed.length > 0) {
        const ids = malformed.map(e => e.id).join(', ');
        const reason = [
          `索引行格式损坏：${ids} 的 CHG/HOTFIX 行必须独占一行，并以 "- [ ] [[...]]"、"[/]"、"[x]"、"[!]" 或 "[-]" 开头。`,
          '请派 artifact-writer 修复索引行边界；修复后再继续写项目文件。'
        ].join('\n');
        emitDeny(`DENY_V6_INDEX_MALFORMED${teammateTag}`, reason, { ids });
        return;
      }

      const missingDetails = actionableEntries.filter(e => !e.detail || e.detail.missing);
      if (missingDetails.length > 0) {
        const ids = missingDetails.map(e => e.id).join(', ');
        const reason = `详情文件缺失：${ids} 对应 changes/<id>.md 不存在。请派 artifact-writer create-chg 或修复 wikilink。`;
        emitDeny(`DENY_V6_DETAIL_MISSING${teammateTag}`, reason, { ids });
        return;
      }
    }

    if (projectMutationNeedsGate) {
      if (gatedEntries.length === 0) {
        const doneEntries = activeEntriesAll.filter(e => ['x', '-'].includes(e.taskCheckbox));
        // CHG-20260611-02：被排除的 sibling CHG 存在时，写明三出口（自建/接手/原 session 处理）。
        const siblingHeld = actionableEntries.length - nonSiblingActionableEntries.length;
        const siblingHint = siblingHeld > 0
          ? `\n（另有 ${siblingHeld} 个活跃 CHG 由同目录其他 session 持有，不计入本 session：接手需用户确认并在 artifact 操作带 owner-takeover 三字段；本 session 独立工作请先 create-chg。）`
          : '';
        const reason = (doneEntries.length > 0
          ? `本项目当前只有已完成/跳过索引，请先派 artifact-writer close-chg 收尾归档，或 create-chg 创建新的变更后再写代码。archive-chg 仅用于已 verified 的单独归档修复。${FORMAT_SNIPPETS.closeOp}`
          : `本项目没有活跃 CHG/HOTFIX。请先创建 CHG 后再写代码。\n${artifactWriterCreateChgHint(artDir, cwd)}`) + siblingHint;
        emitDeny(`DENY_V6_NO_ACTIVE${teammateTag}`, reason, { tool: toolName });
        return;
      }

      const approvedEntries = gatedEntries.filter(e => isChangeApproved(e.detail));
      if (approvedEntries.length === 0) {
        const ids = gatedEntries.map(e => e.id).join(', ');
        const reason = `C 阶段未完成：${ids} 的详情文件缺少 <!-- APPROVED -->，且没有进行中任务。请确认用户是否已批准；若已批准并准备开始，派 artifact-writer approve-and-start，并带批准来源、证据和要开始的 task-id。字段格式见 Skill(paceflow:artifact-management)。`;
        emitDeny(`DENY_V6_C_PHASE${teammateTag}`, reason, { ids });
        return;
      }

      const runnableEntries = approvedEntries.filter(e => {
        const fmStatus = (e.detail.frontmatter.status || '').replace(/^["']|["']$/g, '');
        const tasks = paceUtils.countDetailTasks(e.detail.content);
        return e.taskCheckbox === '/' && fmStatus === 'in-progress' && tasks.blocked === 0;
      });
      if (runnableEntries.length === 0) {
        const ids = approvedEntries.map(e => e.id).join(', ');
        const reason = `E 阶段未就绪：${ids} 已批准但索引/详情状态未进入可执行状态，或仍有 [!] 暂停/阻塞任务。若本次刚获得用户批准并准备开始，请派 artifact-writer approve-and-start；若此前已暂停/阻塞并确认恢复，请派 update-chg action=update-status 将当前任务标为 [/] 并联动 frontmatter/index 状态。字段格式见 Skill(paceflow:artifact-management)。`;
        emitDeny(`DENY_V6_E_PHASE${teammateTag}`, reason, { ids });
        return;
      }

      const summaries = summarizeActiveChanges(cwd)
        .filter(s => runnableEntries.some(e => e.slug === s.slug))
        .map(s => `- ${s.id} status=${s.status} task=${s.taskCheckbox} pending=${s.pending} approved=${s.approved} verified=${s.verified} reviewed=${s.reviewed} path=${s.path}`)
        .join('\n');
      const additionalContext = hostNonArtifactWriteNote
        ? `当前活跃变更：\n${summaries}\n\n${hostNonArtifactWriteNote}`
        : `当前活跃变更：\n${summaries}`;
      const output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext
        }
      };
      process.stdout.write(JSON.stringify(output));
      log(projectLogEntry('PreToolUse', 'PASS_V6', { proj, tool: toolName, entries: runnableEntries.length, dur: Date.now() - t0 }));
      return;
    }

    if (hostNonArtifactWriteNote) {
      const output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: hostNonArtifactWriteNote
        }
      };
      process.stdout.write(JSON.stringify(output));
      log(projectLogEntry('PreToolUse', 'PASS_V6_WORKTREE_HOST_NOTE', { proj, tool: toolName, file: filePath, dur: Date.now() - t0 }));
      return;
    }

    log(projectLogEntry('PreToolUse', 'PASS_V6_NON_CODE', { proj, tool: toolName, dur: Date.now() - t0 }));
    return;
  }

  // v5.0.1: native plan 桥接引导 — 检测 .pace/current-native-plan + task.md 无任务
  if (isCodeFile && isInsideProject && !hasActiveTasks && paceSignal) {
    const nativePlan = getNativePlanPath(cwd);
    if (nativePlan) {
      if (needsArtifactRootChoice) {
        emitDeny(`DENY_ARTIFACT_ROOT_CHOICE${teammateTag}`, artifactRootChoiceReason, { signal: paceSignal, tool: toolName, file: filePath });
        return;
      }
      let createdFiles = [];
      if (!taskFileExists) {
        try { createdFiles = createTemplates(cwd); } catch(e) {}
      }
      const createdMsg = createdFiles.length > 0
        ? `已自动创建 Artifact 模板于 ${displayDir(artDir)}（${createdFiles.join(', ')}）。${artifactRootHint}。`
        : `${artifactRootHint}。`;
      const reason = `${createdMsg}检测到未桥接的原生计划文件：${nativePlan}。请先调用 Skill(paceflow:pace-bridge)，按该 skill 将当前计划桥接为 CHG 并记录同步标记；桥接完成后再重试本次代码写入。`;
      emitDeny(`DENY_NATIVE_PLAN${teammateTag}`, reason, { plan: nativePlan });
      return;
    }
  }

  // v4.3.5: 多信号三级触发（仅对项目内代码文件 + 无活跃任务时生效）
  // CHG-20260612-02：v5 布局的活跃行（无 wikilink 的旧详情）不构成可执行上下文——
  // 写码仍需先 create-chg 建出 v7 索引 + changes/（届时 detected 翻 false，本豁免自动失效）。
  if (isCodeFile && isInsideProject && (!hasActiveTasks || v5MigrationInfo.detected)) {
    // W-3: 使用顶层缓存的 paceSignal
    const codeCount = countCodeFiles(cwd);

    // 第一级：强信号 DENY（superpowers/manual/artifact/code-count）
    // I-06: isPaceProject() 返回 false 或字符串，truthy 检查等价于四重比较
    if (paceSignal) {
      if (needsArtifactRootChoice) {
        emitDeny(`DENY_ARTIFACT_ROOT_CHOICE${teammateTag}`, artifactRootChoiceReason, { signal: paceSignal, tool: toolName, file: filePath });
        return;
      }
      // T-076: DENY 前懒创建缺失的模板文件；幂等同内容创建，不需要 artifact-writer 写锁。
      let createdFiles = [];
      if (!taskFileExists) {
        try { createdFiles = createTemplates(cwd); } catch(e) {}
      }
      const createdMsg = createdFiles.length > 0
        ? `已自动创建 Artifact 模板于 ${displayDir(artDir)}（${createdFiles.join(', ')}）。${artifactRootHint}。`
        : `${artifactRootHint}。`;

      // T-076: 场景化 DENY 消息
      let reason;
      // CHG-A A1：原 paceSignal === 'superpowers' 两个分支已删——isPaceProject 不再返回 'superpowers'
      //   （dated-plan 降级 detectSoftSignal）。已激活项目的未同步 plan 桥接提示由下方 hasUnsyncedPlanFiles 分支承载。
      if (taskFileExists || createdFiles.includes('task.md')) {
        // W-flow-1: 区分"全部完成待归档"和"无任务"
        const hasDoneItems = /- \[[x\-]\]/.test(taskActiveContent);
        if (hasDoneItems) {
          reason = `${createdMsg}检测到 PACE 项目（${paceSignal}）但 task.md 中无进行中的活跃任务（全部已完成/跳过）。请先用 close-chg 收尾归档已完成任务，再定义新任务后写代码。\n收尾方法：${FORMAT_SNIPPETS.closeOp}`;
        } else {
          reason = `${createdMsg}检测到 PACE 项目（${paceSignal}）但 task.md 中无活跃任务。`;
          reason += hasUnsyncedPlanFiles(cwd)
            ? `检测到未同步的 Superpowers 计划文件，请调用 paceflow:pace-bridge：Read plan → 派 artifact-writer create-chg 创建 CHG 后再写代码。`
            : `请先执行 P-A-C 流程（Plan→Artifact→Check）定义任务后再写代码。\n${artifactWriterCreateChgHint(artDir, cwd)}\ntask.md 格式：${FORMAT_SNIPPETS.taskGroup}\n索引行格式：${FORMAT_SNIPPETS.taskEntry}\n任务状态：${FORMAT_SNIPPETS.statusHelp}\n变更状态：${FORMAT_SNIPPETS.changeStatusHelp}`;
        }
      } else {
        reason = `${createdMsg}检测到 PACE 激活信号（${paceSignal}）但 task.md 不存在。\n${artifactWriterCreateChgHint(artDir, cwd)}\n${FORMAT_SNIPPETS.skillRef}`;
      }
      emitDeny(`DENY${teammateTag}`, reason, { signal: paceSignal, tool: toolName, file: filePath, created: createdFiles.join(', '), reason });
      return;
    }

    // CHG-A A3b：原 T-079 code-count-lookahead（Write 第 3 文件达阈值即 deny + 建模板）已移除——
    //   它是 isPaceProject 之外的第二个 code-count 激活路径，与「弱信号不门控」冲突（spec §3/§10）。
    //   code-count 现仅由 detectSoftSignal 在 SessionStart 提示 AI 询问用户，不在 pre-tool-use 拦截。

    // 第三级：软提醒（非 PACE 项目写代码文件）
    if (codeCount >= 1) {
      // I-9: 变量名语义化
      const isNewFileForHint = toolName === 'Write' && !fs.existsSync(filePath);
      const displayCountForHint = codeCount + (isNewFileForHint ? 1 : 0);
      // CHG-A A3b：措辞改指向 /paceflow:enable（显式启用为主），不再建议直接建 CHG。
      const ctx = `提醒：这是项目中的第 ${displayCountForHint} 个代码文件。如需用 PACEflow 管理本项目的任务/变更/验证，运行 /paceflow:enable。`;
      const output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: ctx
        }
      };
      process.stdout.write(JSON.stringify(output));
      log(projectLogEntry('PreToolUse', 'SOFT_WARN', { proj, codeCount: displayCountForHint, tool: toolName, file: filePath, output: ctx, dur: Date.now() - t0 }));
      return;
    }

    // W-code-6: 当前无代码文件，不触发
    log(projectLogEntry('PreToolUse', 'SKIP', { proj, tool: toolName, reason: 'no-trigger', dur: Date.now() - t0 }));
    return;
  }

  // v5 布局的 task.md 活跃详情不作为可执行上下文注入，只给一句布局提示（CHG-20260612-02）。
  if (taskFileExists && taskActiveContent) {
    const ctx = paceUtils.appendArtifactDirHint(cwd, paceUtils.v5LayoutNoticeMessage(cwd) || '检测到 task.md 活跃内容但无 changes/ 详情目录；新变更请走 create-chg 建立 changes/<id>.md + 索引行。');
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: ctx
      }
    };
    process.stdout.write(JSON.stringify(output));
    log(projectLogEntry('PreToolUse', 'PASS', { proj, tool: toolName, injected: taskActiveContent.split('\n').length, dur: Date.now() - t0 }));
  } else {
    log(projectLogEntry('PreToolUse', 'SKIP', { proj, tool: toolName, reason: 'no-task-content', dur: Date.now() - t0 }));
  }
  } catch(e) {
    const errorMessage = e && e.message ? e.message : String(e);
    try { log(projectLogEntry('PreToolUse', 'ERROR', { proj, error: errorMessage })); } catch(e2) {}
    const reason = [
      'PACEflow PreToolUse guard 内部错误，已 fail-closed 阻止本次工具调用。',
      `错误：${errorMessage}`,
      '请重试；若连续出现，请查看 pace-hooks.log 并修复 hook 后再执行写入。'
    ].join('\n');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  }
});
