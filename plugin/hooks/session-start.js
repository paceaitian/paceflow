// SessionStart hook：瘦编排层。
//   解析输入 → （非 PRINT_ONLY）运行态副作用 → collectState 纯读取 → buildLayers 纯渲染
//   → assembleWithBudget 装配 → 单次输出 + flush 日志。
//
// 三段式解耦（CHG-20260608-04 / CHG-A）：
//   - 运行态副作用（12 写盘点 W1–W12）集中在 session-start/runtime-effects.js，PRINT_ONLY 一处短路；
//   - 注入内容生成（L0–L3 各 section 文本）是 session-start/layers.js 的纯函数，可喂 fixture 单测；
//   - 项目状态读取集中在 session-start/collect-state.js（纯读、无写盘、无 stdout）；
//   - 预算装配在 session-start/budget.js。
//   本 CHG 为 byte-等价重构：注入输出与重构前逐字一致（print-session-context.js diff 为空）。
//
// PACE_PRINT_ONLY：print-session-context.js helper 设此 env，让本 hook 只产出注入 stdout、
//   跳过一切 .pace 运行态写盘——靠「!PRINT_ONLY 时才调用 applyRuntimeEffects」单点短路实现
//   （替代重构前 7 处散落 !PRINT_ONLY 守卫）。
const fs = require('fs');
const path = require('path');
let paceUtils;
try { paceUtils = require('./pace-utils'); } catch(e) {
  process.stderr.write(`PACE: pace-utils.js 加载失败: ${e.message}\n`);
  process.exit(0);
}
const { PACE_VERSION, isPaceProject, getArtifactDir, getProjectName, artifactRootChoiceNeeded } = paceUtils;
const { collectState } = require('./session-start/collect-state');
const { buildLayers } = require('./session-start/layers');
const { assembleWithBudget } = require('./session-start/budget');
const { applyRuntimeEffects, applyArtifactGroupEffects } = require('./session-start/runtime-effects');

const LOG = paceUtils.defaultLogPath();
// W-8: 使用共享日志轮转函数
const log = paceUtils.createLogger(LOG);
const cwd = paceUtils.resolveProjectCwd();
const proj = getProjectName(cwd);
const PACE_RUNTIME = paceUtils.getProjectRuntimeDir(cwd);
const COUNTER_FILE = path.join(PACE_RUNTIME, 'stop-block-count');
const PRINT_ONLY = !!process.env.PACE_PRINT_ONLY;

// --group 路由：core（默认）运行副作用 + 渲染 core 层（项目骨架/L0/git/相关讨论）；
// artifact 渲染 artifact 层（文件块 + 格式警告 + findings 过期提醒）并跑 artifact group 副作用（W10/W11 幂等自保 + W12 写 flag）。
// findings 过期提醒三元组（W12 flag 写 + collectAgedFindings 读 + renderAgedFindings 渲染）整体归 artifact（CHG-11/T-001）。
// 分组渲染由 M2（buildLayers/collectState 按 group）实现。
// 向后兼容：无 --group 默认 core；但 hooks.json 注册双 hook（M4/T-008）前单独跑时仅注入 core 骨架，
// artifact 文件块/格式警告不注入——故整个多 hook 重构须作为一个发布单元，T-008 前不发布中间态。
const GROUP_CORE = 'core';
const GROUP_ARTIFACT = 'artifact';
function parseGroupArg() {
  const i = process.argv.indexOf('--group');
  const v = i >= 0 ? process.argv[i + 1] : '';
  return v === GROUP_ARTIFACT ? GROUP_ARTIFACT : GROUP_CORE; // 默认 core，向后兼容无 arg
}
const GROUP = parseGroupArg();

// 注入预算改用 chars（per-hook 10K chars cap 的核心修复）；PACE_SESSION_OUTPUT_BUDGET_CHARS 可覆盖。
// assembleWithBudget 已做 L3 优先截断（head 永不截）；此全局字节守卫退为极端兜底，正常不触发。
const SESSION_OUTPUT_BUDGET_CHARS = Math.max(9500, Number(process.env.PACE_SESSION_OUTPUT_BUDGET_CHARS) || 9500);
// 全局 stdout 字节守卫阈值：与 SESSION_OUTPUT_BUDGET_CHARS 解耦——assembleWithBudget 已按 chars 做主截断，
// 本守卫是独立字节兜底，只拦 assembleWithBudget 之外的意外 write。阈值须 > 单 hook 合法上限
// （9500 chars 全 CJK ≈ 28500 bytes，否则误截合法注入），< 50000（Claude 50KB 持久化边界，e2e 2d 系列据此）。
const SESSION_OUTPUT_GUARD_BYTES = Number(process.env.PACE_SESSION_OUTPUT_GUARD_BYTES) || 46000;
let sessionOutputBytes = 0;
let sessionOutputTruncated = false;
const realStdoutWrite = process.stdout.write.bind(process.stdout);

function sliceUtf8ToBytes(str, maxBytes) {
  if (maxBytes <= 0) return '';
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(str.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo);
}

// 全局字节守卫：极端兜底，防止任何额外 write 超出字节上限。
//   阈值用独立的 SESSION_OUTPUT_GUARD_BYTES（默认 46000 bytes），与 assembleWithBudget 的 chars 主预算解耦——
//   主预算控制已在 assembleWithBudget 完成，此守卫只拦 assembleWithBudget 之外的意外 write。
function installSessionOutputGuard() {
  process.stdout.write = (chunk, encoding, callback) => {
    const cb = typeof encoding === 'function' ? encoding : callback;
    const enc = typeof encoding === 'string' ? encoding : undefined;
    const text = Buffer.isBuffer(chunk) ? chunk.toString(enc || 'utf8') : String(chunk);
    if (sessionOutputTruncated) {
      if (typeof cb === 'function') process.nextTick(cb);
      return true;
    }

    const bytes = Buffer.byteLength(text, 'utf8');
    if (sessionOutputBytes + bytes <= SESSION_OUTPUT_GUARD_BYTES) {
      sessionOutputBytes += bytes;
      return realStdoutWrite(chunk, encoding, callback);
    }

    const remaining = Math.max(0, SESSION_OUTPUT_GUARD_BYTES - sessionOutputBytes);
    const prefix = sliceUtf8ToBytes(text, remaining);
    if (prefix) {
      sessionOutputBytes += Buffer.byteLength(prefix, 'utf8');
      realStdoutWrite(prefix);
    }
    const notice = `\n\n=== SessionStart 输出截断 ===\n注入字节超过 ${SESSION_OUTPUT_GUARD_BYTES} 字节兜底上限，已停止继续输出。主预算已由 assembleWithBudget 按 chars 控制，此为极端兜底，请按需 Read artifact 文件。\n`;
    sessionOutputBytes += Buffer.byteLength(notice, 'utf8');
    realStdoutWrite(notice);
    sessionOutputTruncated = true;
    if (typeof cb === 'function') process.nextTick(cb);
    return true;
  };
}
installSessionOutputGuard();

// S-1: 统一 stdin 解析
const hookInput = paceUtils.parseStdinSync();
const eventType = hookInput.type || 'startup';

// H-3: 顶层 try-catch 安全网（内部 try-catch 保留不变）
try {

// v4.3: 多信号 PACE 检测
const paceSignal = isPaceProject(cwd);
const artDir = paceSignal ? getArtifactDir(cwd) : cwd;
const v5MigrationInfo = paceSignal ? paceUtils.getV5MigrationInfo(cwd) : { detected: false };
const rootConfigError = paceSignal ? paceUtils.artifactRootConfigError(cwd) : null;
if (rootConfigError) {
  log(paceUtils.logEntry('SessionStart', 'ARTIFACT_ROOT_CONFIG_ERROR', {
    proj,
    code: rootConfigError.code,
    choice_path: rootConfigError.choicePath,
  }));
  process.stdout.write(`=== PACEflow 配置错误 ===\n${rootConfigError.message}\n\n`);
  process.exit(0);
}
const rootChoicePending = paceSignal && paceSignal !== 'artifact' && artifactRootChoiceNeeded(cwd);
const artifactRootChoice = paceUtils.readArtifactRootChoice(cwd) || 'auto';

// === compact 快照预读已退役（M4/T-002）===
//   PreCompact 快照机制整体移除：compact 不再读 pre-compact-state.json、不再单独生成「Compact 恢复」
//   注入文本。collectState/buildLayers 实时读 artifact 已完整覆盖 compact 场景，compact 与 startup
//   走同一条实时读路径（OQ-1 + A0 对称）。eventType 仍透传给 W1–W6 startup 重置守卫与 native plan 提醒守卫。

// === rootChoicePending 启用提示文本（重构前 282-300）===
//   该分支无写盘（只注入 + log）；注入文本在此生成、注入位置由 layers 复刻 golden。
let rootChoicePromptText = '';
if (rootChoicePending && !fs.existsSync(path.join(artDir, 'task.md'))) {
  log(paceUtils.logEntry('SessionStart', 'ARTIFACT_ROOT_CHOICE_PENDING', {
    cwd,
    signal: paceSignal,
    choice_path: paceUtils.getArtifactRootChoicePath(cwd),
    local_artifact_dir: paceUtils.displayDir(paceUtils.getProjectStateDir(cwd)),
    vault_artifact_dir: paceUtils.VAULT_PATH ? paceUtils.displayDir(path.join(paceUtils.VAULT_PATH, 'projects', getProjectName(cwd))) : '',
  }));
  rootChoicePromptText = [
    '=== PACEflow 启用提示 ===',
    '本项目已触发 PACEflow 信号；收到代码修改任务时先调用 Skill(paceflow:pace-workflow)。',
    '涉及 artifact/CHG 字段、任务状态、批准、验证、归档、记录调研/纠正时，再调用 Skill(paceflow:artifact-management)。',
    '首次写代码或派 artifact-writer 时，PreToolUse 会要求选择 artifact root；选择前不会创建 .pace/、changes/ 或 Obsidian 空项目目录。',
    `若当前子目录应作为独立 PaceFlow 项目，先运行：node "${paceUtils.SET_PROJECT_ROOT_SCRIPT}" --mode independent`,
    `若用户已明确选择 vault/local，先从当前项目 cwd 运行：node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice local 或 --choice vault`,
    `配置写入后再运行：node "${paceUtils.RESERVE_ARTIFACT_ID_SCRIPT}" --operation create-chg --cwd "${cwd.replace(/\\/g, '/')}"`,
    'reserve helper 从 --cwd 指定的项目 cwd 和 .pace/artifact-root 解析 artifact_dir；上面命令已内联 --cwd。Claude 主 session 的 Bash cwd 会在命令间漂移，务必带 --cwd 锚定，否则 reservation 可能写错 runtime（后续 artifact-writer 误报「无效或已过期」）。',
    '',
  ].join('\n') + '\n';
}

// findings-age flag 存在性快照（必须在 effects 的 W12 写 flag 之前取）：
//   重构前注入判定与 W12 写 flag 在同一 if (!fs.existsSync(ageFlag)) 块内、用写之前的状态；
//   解耦后 effects 先于 collectState，故在此先快照，传给 collectState 判定注入。
//   CHG-11/T-001：findings 过期三元组归 artifact group——仅 artifact 需要此快照（collectAgedFindings 读已移 artifact），
//   且必须在 applyArtifactGroupEffects 的 W12 写 flag 之前取，否则读到自己刚写的 flag → 判「今日已提醒」→ 不注入。
let ageFlagExistedBefore = false;
if (GROUP === GROUP_ARTIFACT && paceSignal) {
  try { ageFlagExistedBefore = fs.existsSync(path.join(PACE_RUNTIME, `findings-age-${paceUtils.todayISO()}`)); } catch(e) {}
}

// === 运行态副作用：core group 写盘点集中（W1–W11），PRINT_ONLY 一处短路（替代散落守卫）===
//   core group 跑 W1–W11（startup 重置 / compact 快照消费 / 基础设施 / 模板）；W12 已随 findings 过期
//   三元组迁出至 artifact 的 applyArtifactGroupEffects（CHG-11/T-001）。
//   注意：effects 内 W10/W11 会创建 .gitignore / task.md 模板，须在 collectState 读文件前执行
//   （与重构前 276/282 写盘先于 416 读取循环的顺序一致）。
if (GROUP === GROUP_CORE && !PRINT_ONLY) {
  applyRuntimeEffects(cwd, eventType, paceSignal, rootChoicePending, artDir, {
    paceUtils, log, PACE_RUNTIME, COUNTER_FILE,
    v5MigrationInfo, artifactRootChoice, proj,
    group: GROUP,
  });
}

// === artifact group 副作用：W10/W11 幂等自保 + W12 写 findings-age flag（CHG-11/T-001）===
//   W10/W11 与 core 重复执行（幂等）：保证 artifact hook 即便先于 core 跑，下方 collectState 读 artifact
//   文件前 task.md 模板/基础设施已就绪。W12 写 flag 必须晚于上方 ageFlagExistedBefore 快照、早于
//   collectState（collectAgedFindings 据 ageFlagExistedBefore 判注入），故此调用置于两者之间。
if (GROUP === GROUP_ARTIFACT && !PRINT_ONLY) {
  applyArtifactGroupEffects(cwd, paceSignal, artDir, {
    paceUtils, log, rootChoicePending, v5MigrationInfo, artifactRootChoice, proj,
  });
}

// === 纯读取层：项目状态 → state ===
const state = collectState(cwd, eventType, paceSignal, artDir, paceUtils, {
  proj, hookInput, rootChoicePending, artifactRootChoice, v5MigrationInfo, ageFlagExistedBefore,
  group: GROUP,
});
// 编排层预生成的注入文本块挂到 state，供 layers 在 golden 原位拼接。
state.rootChoicePromptText = rootChoicePromptText;

// === 纯渲染层：state → L0–L3 文本块 ===
const layers = buildLayers(state, eventType, paceUtils, GROUP);

// === flush layers 渲染期累积的日志（FINDINGS_DETAIL_MATCH_MISS / SKIPPED_REMINDER / 桥接 / owner / blocked）===
if (Array.isArray(state._logs)) {
  for (const entry of state._logs) { try { log(entry); } catch(e) {} }
}

// === 预算装配 + 单次输出 ===
const { text, headOverflow, headChars } = assembleWithBudget(layers, { limitChars: SESSION_OUTPUT_BUDGET_CHARS });
process.stdout.write(text);

// headOverflow（CHG-20260614-10）：head 自身超 char 预算时记 OVER_BUDGET——否则整段被 Claude
//   persist 成 2KB preview、上下文恢复残废而无任何日志痕迹。根治在 layers 活跃 CHG header cap，此为兜底可见性。
if (headOverflow) {
  log(paceUtils.projectLogEntry(cwd, 'SessionStart', 'OVER_BUDGET', {
    cwd,
    proj,
    head_chars: headChars,
    limit: SESSION_OUTPUT_BUDGET_CHARS,
    active_chg: (state.activeChangeSummaries && state.activeChangeSummaries.length) || 0,
  }));
}

log(paceUtils.projectLogEntry(cwd, 'SessionStart', 'INJECT', {
  cwd,
  proj,
  event: eventType,
  signal: paceSignal || 'none',
  artifact_dir: paceUtils.displayDir(artDir),
  choice: artifactRootChoice,
  group: GROUP,
  files: (state._found && state._found.length) ? state._found.join(', ') : '无 Artifact 文件',
  output_bytes: sessionOutputBytes,
  truncated: sessionOutputTruncated ? 'yes' : 'no',
  version: PACE_VERSION,
}));

} catch(e) {
  // H-3: 顶层异常捕获，静默放行
  try { log(paceUtils.logEntry('SessionStart', 'ERROR', { cwd, error: e.message })); } catch(e2) {}
}
