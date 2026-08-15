// Stop hook：有未完成项时 exit 2 阻止 Claude 停止 + 多信号检测 + 防无限循环
const fs = require('fs');
const path = require('path');
let paceUtils;
try { paceUtils = require('./pace-utils'); } catch(e) {
  process.stderr.write(`PACE: pace-utils.js 加载失败: ${e.message}\n`);
  process.exit(0);
}
const { ts, todayISO, isPaceProject, countCodeFiles, ARTIFACT_FILES, readActive, checkArchiveFormat, countByStatus, isTeammate, getArtifactDir, getProjectName, FORMAT_SNIPPETS, getActiveChangeEntries, classifyChange } = paceUtils;

const LOG = paceUtils.defaultLogPath();
const MAX_BLOCKS = 3; // 连续阻止超过此数后降级为软提醒
// W-8: 使用共享日志轮转函数
const log = paceUtils.createLogger(LOG);
const cwd = paceUtils.resolveProjectCwd();
const proj = getProjectName(cwd);
const projectLogEntry = (hook, action, fields = {}) => paceUtils.projectLogEntry(cwd, hook, action, fields);
const PACE_RUNTIME = paceUtils.getProjectRuntimeDir(cwd);
const COUNTER_FILE = path.join(PACE_RUNTIME, 'stop-block-count');
const warnings = [];
const warningTypes = [];
const softReminders = [];
// backlog 类软提醒(如超期 finding):与 deferred CHG 语义分离,独立前缀、不参与 slice 截断
const backlogReminders = [];
const backgroundWorkReminders = [];

const paceSignal = isPaceProject(cwd);

// H-1: 非 PACE 项目直接放行（.pace/disabled 豁免）
if (!paceSignal) {
  log(projectLogEntry('Stop', 'SKIP', { proj, reason: 'non-pace' }));
  process.exit(0);
}

// PUC-01：artifact-root 配置为 vault 但运行时 PACE_VAULT_PATH 缺失 → fail-closed 阻断。
// 否则 getArtifactDir 会静默降级到本地路径，漏检 vault 里的活跃 CHG（fail-open）。
const rootConfigError = paceUtils.artifactRootConfigError(cwd);
if (rootConfigError) {
  process.stderr.write(`PACE 完成度检查未通过（artifact-root 配置异常，已 fail-closed）：\n${rootConfigError.message}\n`);
  log(projectLogEntry('Stop', 'BLOCK', { proj, reason: rootConfigError.code, note: 'vault 配置但 PACE_VAULT_PATH 缺失，fail-closed 阻断' }));
  process.exit(2);
}

// 防无限循环：读取连续阻止计数
// I-12: 消除 existsSync TOCTOU 竞态，直接 try-catch readFileSync
function getBlockCount() {
  try {
    return parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10) || 0;
  } catch(e) { return 0; }
}
function setBlockCount(n, { ensure = false } = {}) {
  try {
    if (ensure) fs.mkdirSync(PACE_RUNTIME, { recursive: true });
    fs.writeFileSync(COUNTER_FILE, String(n), 'utf8');
    return true;
  } catch(e) { return false; }
}

function isDeferredCategory(category) {
  return ['backlog', 'ready', 'blocked'].includes(category);
}

function isForeignOwnerStatus(ownerStatus) {
  return ownerStatus.disposition === 'foreign-fresh' || ownerStatus.disposition === 'foreign-stale';
}

// CHG-20260611-02：同 checkout 其他 session 的 CHG（sibling 三态）——跳过硬约束改软提醒。
function isSiblingOwnerStatus(ownerStatus) {
  return String(ownerStatus.disposition || '').startsWith('sibling-');
}

function addWarning(type, message) {
  warnings.push(message);
  warningTypes.push(type || 'repair');
}

function activeBackgroundTasks(input) {
  const raw = input && input.raw && typeof input.raw === 'object' ? input.raw : {};
  // Claude Code removes completed/failed background work from this array; a
  // present item with a non-empty status is active. session_crons is separate
  // scheduling state and is intentionally not treated as background work here.
  const tasks = Array.isArray(raw.background_tasks) ? raw.background_tasks : [];
  return tasks.filter(task => {
    if (!task || typeof task !== 'object') return false;
    return String(task.status || '').trim() !== '';
  });
}

function describeBackgroundTask(task) {
  const type = String(task.type || 'task').trim() || 'task';
  const id = String(task.id || '').trim();
  const name = String(task.name || task.agent_type || task.description || task.command || '').trim();
  const status = String(task.status || '').trim();
  const parts = [type];
  if (name) parts.push(name.slice(0, 80));
  if (id) parts.push(`id=${id}`);
  if (status) parts.push(`status=${status}`);
  return parts.join(' ');
}

function emitAllowedStopReminders({ deferredReminders, backgroundReminders, backlogReminders = [], backgroundTasks, t0 }) {
  if (deferredReminders.length === 0 && backgroundReminders.length === 0 && backlogReminders.length === 0) return false;
  resetHardBlockRuntime();
  const parts = [];
  if (backgroundReminders.length > 0) {
    const shown = backgroundReminders.slice(0, 5);
    const more = backgroundReminders.length > shown.length ? `；另有 ${backgroundReminders.length - shown.length} 个` : '';
    const taskShown = backgroundTasks.slice(0, 3).map(describeBackgroundTask).join('；');
    const taskMore = backgroundTasks.length > 3 ? `；另有 ${backgroundTasks.length - 3} 个后台任务` : '';
    parts.push(`后台任务仍在运行，已允许主 session 暂停等待：${shown.join('；')}${more}${taskShown ? `；后台=${taskShown}${taskMore}` : ''}`);
  }
  if (deferredReminders.length > 0) {
    const shown = deferredReminders.slice(0, 5);
    const more = deferredReminders.length > shown.length ? `；另有 ${deferredReminders.length - shown.length} 个` : '';
    parts.push(`仍有 deferred CHG 可后续处理：${shown.join('；')}${more}`);
  }
  // backlog 提醒独立段(CHG-20260814-03 审计 P3-1/P3-2):语义非 deferred CHG,且不参与 slice 截断
  if (backlogReminders.length > 0) {
    parts.push(backlogReminders.join('。'));
  }
  const systemMessage = `PACEflow: ${parts.join('。')}。`;
  process.stdout.write(JSON.stringify({ systemMessage }) + '\n');
  const action = backgroundReminders.length > 0 ? 'SOFT_BACKGROUND_WORK_PASS' : 'SOFT_DEFERRED_PASS';
  log(projectLogEntry('Stop', action, {
    proj,
    deferred_count: deferredReminders.length,
    background_count: backgroundReminders.length,
    backlog_count: backlogReminders.length,
    background_tasks: backgroundTasks.map(describeBackgroundTask).join('; '),
    changes: [...backgroundReminders, ...deferredReminders].map(r => (r.match(/^(CHG|HOTFIX)-\d{8}-\d{2}/) || [''])[0]).filter(Boolean).join(','),
    dur: Date.now() - t0,
  }));
  return true;
}

function deferredNextAction(change) {
  if (change.category === 'backlog') return '先确认用户批准；若准备执行，派 approve-and-start';
  if (change.category === 'ready') return '已批准但未开始；执行前派 approve-and-start 或 update-status 将当前任务恢复为 [/]';
  if (change.category === 'blocked') return '已暂停/阻塞；恢复前确认用户意图，并派 update-status 将当前任务恢复为 [/]';
  return '继续前确认下一步状态';
}

function resetHardBlockRuntime() {
  if (fs.existsSync(PACE_RUNTIME)) setBlockCount(0);
  const degradedFile = path.join(PACE_RUNTIME, 'degraded');
  try { if (fs.existsSync(degradedFile)) fs.unlinkSync(degradedFile); } catch(e) {}
}

try {
const t0 = Date.now();
// S-1: 统一 stdin 解析
const stdin = paceUtils.parseStdinSync();
const backgroundTasks = activeBackgroundTasks(stdin);
const hasBackgroundTasks = backgroundTasks.length > 0;
log(projectLogEntry('Stop', 'ENTRY', { proj }));

// CHG-20260611-03：session 级 pause——本 session 跳过全部 Stop gate，仅留一条人可见提醒。
// 仅用户经 /paceflow:pause 启用；artifact 完整性门在 PreToolUse 层保留，不受影响。
if (paceUtils.isSessionPaused(cwd, stdin.sessionId)) {
  log(projectLogEntry('Stop', 'SKIP_SESSION_PAUSED', { proj }));
  emitAllowedStopReminders({
    deferredReminders: ['本 session 已 pause PACEflow（流程门跳过中）；恢复运行 /paceflow:resume。'],
    backgroundReminders: [],
    backgroundTasks: [],
    t0: Date.now(),
  });
  process.exit(0);
}

// I-opt-4: 直接使用 ARTIFACT_FILES（消除无意义别名）
const artDir = getArtifactDir(cwd);
const existing = ARTIFACT_FILES.filter(f => fs.existsSync(path.join(artDir, f)));

const taskActive = readActive(cwd, 'task.md');

if (paceSignal === 'artifact') {
  for (const file of ARTIFACT_FILES) {
    const archFmt = checkArchiveFormat(cwd, file);
    if (archFmt) addWarning('repair', archFmt);
  }

  const classifiedEntries = getActiveChangeEntries(cwd).map(e => classifyChange(e));
  // batch create 把每个新 CHG 索引行 prepend 到活跃区顶部，getActiveChangeEntries 因而返回创建倒序（如 08→05）。
  // 待执行/提醒列表应按执行顺序展示，故按 CHG-ID 升序做一次稳定排序：reserve --count N 取连号，
  // 故 id 升序 ⟺ change-set-seq 分子升序，一处 sort 同时修好 deferred 单条与 change-set 成组两个提醒消费点。
  // sort 只重排展示顺序、不改集合；Stop 的 warnings/deny/pass 与 foreignOwnedIds 累加均与顺序无关，行为等价。
  classifiedEntries.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // 前向兼容 guard（CHG-20260612-04）：数据 schema 比本 hook 新 → Stop 的全部 PACE 检查
  // 让位（exit 0 + 升级提示），与 pre-tool-use 流程门让位对称——防 v7→v8 升级窗口 brick 重演。
  {
    const newerSchema = paceUtils.detectNewerSchemaData(cwd, classifiedEntries);
    if (newerSchema.detected) {
      process.stdout.write(JSON.stringify({ systemMessage: `PACEflow: 检测到 artifact schema ${newerSchema.maxVersion} 高于当前插件支持的 7.0，Stop 检查已让位。请升级 PACEflow 插件并 reload 全部 session（含其他 worktree）。` }) + '\n');
      log(projectLogEntry('Stop', 'PASS_NEWER_SCHEMA', { proj, max_version: newerSchema.maxVersion }));
      process.exit(0);
    }
  }

  let requiresWalkthrough = false;
  // CS-FOREIGN: 记录 foreign-owner 成员，供下方 change-set 成组提醒跳过（与本循环 foreign 跳过对称）。
  const foreignOwnedIds = new Set();
  for (const change of classifiedEntries) {
    const ownerStatus = paceUtils.changeOwnerStatus(cwd, change.id, stdin.sessionId);
    const isForeignOwner = isForeignOwnerStatus(ownerStatus);
    const isSiblingOwner = isSiblingOwnerStatus(ownerStatus);
    if (isForeignOwner || isSiblingOwner) foreignOwnedIds.add(change.id);
    const isProgressState = ['running', 'blocked', 'closing-required'].includes(change.category);
    if ((isForeignOwner || isSiblingOwner) && (isProgressState || isDeferredCategory(change.category))) {
      if (isSiblingOwner) {
        // CHG-20260611-02 软化：sibling 的 CHG 不进硬 warnings，改人可见软提醒
        //（emitAllowedStopReminders 通道，仅在本就放行时显示）。
        softReminders.push(ownerStatus.disposition === 'sibling-fresh'
          ? `${change.id} 正由同目录另一 session 执行中（owner fresh），本 session 不受其完成约束；请勿接手。`
          : `${change.id} 的原 session 已${ownerStatus.disposition === 'sibling-detached' ? '正常关闭' : '失联（owner 记录过期）'}。如需本 session 接手，先用 AskUserQuestion 向用户确认，artifact 操作带 owner-takeover-confirmed/owner-takeover-source/owner-takeover-evidence。`);
      }
      log(projectLogEntry('Stop', isSiblingOwner ? 'SKIP_SIBLING_CHANGE_OWNER' : (ownerStatus.disposition === 'foreign-stale' ? 'SKIP_FOREIGN_STALE_CHANGE_OWNER' : 'SKIP_FOREIGN_CHANGE_OWNER'), {
        proj,
        change: change.id,
        owner_state: ownerStatus.owner.state || '',
        owner_worktree: ownerStatus.owner.worktree || '',
        owner_branch: ownerStatus.owner.branch || '',
        category: change.category,
        disposition: ownerStatus.disposition,
      }));
      continue;
    }
    const ownerPrefix = ownerStatus.disposition === 'foreign-stale'
      ? `${change.id} 的 owner 记录已过期；优先回到原 worktree/session 处理。若用户明确要求当前 session 修复或接手，请在 artifact-writer prompt 中带 owner-takeover-source 与 owner-takeover-evidence。`
      : '';

    // v7 schema 封闭合同兜底（CHG-20260611-09）：与 status-mismatch 同级的存量漂移检测。
    {
      const fm = change.detail && change.detail.frontmatter;
      const schemaCheck = paceUtils.validateFrontmatterSchema('chg', change.status || '', fm || {});
      if (!schemaCheck.ok) {
        addWarning('repair', `${ownerPrefix}${change.id} 不符合 v7 schema 合同：缺失 ${schemaCheck.missing.join(', ') || '无'}；多余 ${schemaCheck.unknown.join(', ') || '无'}。请派 artifact-writer 修复 frontmatter（7.0 字段集见 artifact-writer-spec.md schema 表）。`);
      }
    }

    if (change.category === 'inconsistent') {
      if (change.reason === 'index-missing') {
        // v7：正常路径不可达（classifyChange 仅防卫空 entry），保守保留兜底文案。
        addWarning('repair', `${ownerPrefix}${change.id} 索引状态异常（entry 缺失），请派 artifact-writer 修复 task.md 索引。`);
      } else if (change.reason === 'detail-missing') {
        addWarning('repair', `${ownerPrefix}${change.id} 的详情文件缺失（应为 changes/${change.slug}.md），请派 artifact-writer 修复。`);
      } else if (change.reason === 'index-malformed') {
        addWarning('repair', `${ownerPrefix}${change.id} 索引行格式损坏：task.md 中的 CHG/HOTFIX 行必须独占一行，并以 "- [ ] [[...]]"、"[/]"、"[x]"、"[!]" 或 "[-]" 开头。请派 artifact-writer 修复索引行边界。`);
      } else if (change.reason === 'index-completed-with-pending-tasks') {
        addWarning('execution', `${ownerPrefix}${change.id} 索引已是 [x]，但详情仍有 ${change.tasks.pending} 个未完成任务。请派 update-chg action=update-status 修复状态联动，或继续完成任务。`);
      } else if (change.reason === 'index-completed-status-mismatch') {
        addWarning('repair', `${ownerPrefix}${change.id} 索引已是 [x]，但详情 frontmatter status=${change.status || 'missing'}。请派 update-chg action=update-status 修复状态联动。`);
      } else if (change.reason === 'active-archived') {
        addWarning('repair', `${ownerPrefix}${change.id} 详情已 archived，但索引仍在活跃区。请派 artifact-writer close-chg 或 archive-chg 做索引修复：从 task.md 活跃区删除该行，并移动到 ARCHIVE 下方。${FORMAT_SNIPPETS.closeOp}`);
      } else if (change.reason === 'active-cancelled') {
        addWarning('repair', `${ownerPrefix}${change.id} 已取消或索引为 [-]，但仍在活跃区。请派 artifact-writer archive-chg 做取消归档：保持详情 status=cancelled，不验证；从 task.md 活跃区删除该行，并移动到 ARCHIVE 下方。`);
      } else if (change.reason === 'task-list-empty') {
        addWarning('repair', `${ownerPrefix}${change.id} 详情 status=${change.status}，但 ## 任务清单 中没有可识别的 T-NNN 任务行。请派 artifact-writer 修复 changes/${change.slug}.md 任务清单。`);
      } else {
        addWarning('repair', `${ownerPrefix}${change.id} 状态无法识别（status=${change.status || 'missing'}）。请派 artifact-writer 修复 frontmatter/index 状态。`);
      }
      continue;
    }

    if (isDeferredCategory(change.category)) {
      const pending = Number(change.tasks && change.tasks.pending || 0);
      softReminders.push(`${change.id} ${change.category}: ${deferredNextAction(change)}`);
      log(projectLogEntry('Stop', 'SOFT_DEFERRED_CHANGE', {
        proj,
        change: change.id,
        category: change.category,
        pending,
        blocked: change.tasks.blocked,
        owner: ownerStatus.disposition,
      }));
      continue;
    }

    if (change.category === 'running') {
      if (!change.approved) {
        addWarning('user-action', `${ownerPrefix}${change.id} 正在执行但未批准。请确认用户是否已批准；若已批准并准备开始，派 artifact-writer approve-and-start，并带批准来源、证据和要开始的 task-id。字段格式见 Skill(paceflow:artifact-management)。`);
        continue;
      }
      if (change.tasks.pending > 0) {
        if (hasBackgroundTasks) {
          backgroundWorkReminders.push(`${change.id} running: 还有 ${change.tasks.pending} 个未完成任务；后台执行单元仍在运行，等待其返回后继续更新/验证/归档`);
          log(projectLogEntry('Stop', 'SOFT_BACKGROUND_WORK_CHANGE', {
            proj,
            change: change.id,
            pending: change.tasks.pending,
            done: change.tasks.done,
            total: change.tasks.total,
            background_tasks: backgroundTasks.map(describeBackgroundTask).join('; '),
          }));
          continue;
        }
        addWarning('execution', `${ownerPrefix}${change.id} 还有 ${change.tasks.pending} 个未完成任务（完成 ${change.tasks.done}/${change.tasks.total}）。若本轮仍可连续执行，请继续完成代码/测试，不必为中间任务逐个 update-status；只有暂停、阻塞、跳过或跨 session 时才派 update-chg action=update-status 维护 T-NNN 状态。`);
        continue;
      }
      if (change.tasks.total > 0) {
        addWarning('repair', `${ownerPrefix}${change.id} 任务已全部完成，但 frontmatter status=${change.status || 'missing'}。若验证已通过，请直接派 close-chg complete-open-tasks: true 收尾归档；若暂不验证，才派 update-chg action=update-status 修复 completed 状态。`);
      }
      continue;
    }

    if (change.category === 'closing-required') {
      if (!change.verified) {
        addWarning('verify', `${ownerPrefix}${change.id} 已 completed 但未验证。请先运行验证并阅读结果；确认通过后派 artifact-writer close-chg 写入 VERIFIED 并归档。若只记录验证暂不归档，才派 update-chg action=verify。字段格式见 Skill(paceflow:artifact-management)。`);
      } else if (!change.reviewed) {
        addWarning('verify', `${ownerPrefix}${change.id} 已验证但未审计。请按本 CHG diff 自选合适的 review agent 做对抗审计，路由 findings（P0/P1 开 HOTFIX 或记 won't-fix，P2/P3 派 record-finding），再派 close-chg（含 review-confirmed/review-source/review-findings）写入 REVIEWED 并归档。若只记录审计暂不归档，才派 update-chg action=review。字段格式见 Skill(paceflow:artifact-management)。`);
      } else {
        requiresWalkthrough = true;
        addWarning('repair', `${ownerPrefix}${change.id} 已 completed 且 verified、reviewed，仍在活跃索引中。请派 artifact-writer close-chg（已验证已审计则只做归档收尾）或 archive-chg 归档。字段格式见 Skill(paceflow:artifact-management)。`);
      }
    }
  }

  // change-set 成组软提醒（不阻断）：同 change-set 的未执行（planned/ready/blocked）成员聚合提醒。
  // 走 softReminders → 仅在 warnings.length===0（本就放行）时由 emitAllowedStopReminders 显示，
  // 绝不进 warnings[]，故有 in-progress 等阻断项时不显示、也不会把阻断降级为放行。
  const changeSetPlanned = new Map();
  for (const change of classifiedEntries) {
    if (!change.changeSet || !isDeferredCategory(change.category)) continue;
    // CS-FOREIGN: 跳过 foreign-owner 成员，与第一循环 + session-start 进度注入对称——
    // 不催当前 session 去 approve-and-start 别的 worktree/session 拥有的 change-set 成员。
    if (foreignOwnedIds.has(change.id)) continue;
    if (!changeSetPlanned.has(change.changeSet)) changeSetPlanned.set(change.changeSet, []);
    changeSetPlanned.get(change.changeSet).push(change.changeSetSeq || change.id);
  }
  for (const [name, seqs] of changeSetPlanned) {
    softReminders.push(`change-set ${name} 还有 ${seqs.length} 个未执行成员（${seqs.join(', ')}）；逐个 approve-and-start 继续，勿遗漏后续阶段`);
  }

  const walkActive = readActive(cwd, 'walkthrough.md');
  if (walkActive !== null && requiresWalkthrough) {
    const today = todayISO();
    const hasToday = new RegExp(`^\\|\\s*${today}\\s*\\|`, 'm').test(walkActive);
    if (!hasToday) {
      addWarning('repair', `walkthrough.md 缺少 ${today} 的工作记录索引行；请派 close-chg 完成归档收尾，不要由主 session 直接补。${FORMAT_SNIPPETS.walkthroughDetail}`);
    }
  }
  for (const issue of paceUtils.validateWalkthroughLinks(cwd)) {
    addWarning('repair', issue);
  }

  try {
    const findingsDir = path.join(artDir, 'changes', 'findings');
    const aged = fs.existsSync(findingsDir)
      ? fs.readdirSync(findingsDir).filter(f => f.endsWith('.md')).filter(f => {
          const fd = fs.openSync(path.join(findingsDir, f), 'r');
          let detail = '';
          try {
            const buffer = Buffer.alloc(65536);
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
            detail = buffer.toString('utf8', 0, bytes);
          } finally {
            fs.closeSync(fd);
          }
          const fm = paceUtils.parseFrontmatter(detail);
          if ((paceUtils.normalizeFrontmatterStatus(fm.status) || 'open') !== 'open' || !fm.date) return false;
          const days = paceUtils.daysSinceISODate(fm.date);
          return days !== null && days >= 14;
        }).length
      : 0;
    // CHG-20260814-03(用户方案):超期 finding 是 backlog 陈化提醒,blast radius 极低,
    // 不与「未验证/未审计」等真流程门共用硬阻断通道——改走 softReminders,仅在本就放行时
    // 以 systemMessage 显示,不再 exit 2。此前硬阻断 + 降级即重置计数器(T-424)在等待
    // background agent 场景形成拦截乒乓(2026-08-14 实测 10+ 次)。
    if (aged > 0) {
      backlogReminders.push(`changes/findings/ 有 ${aged} 个 open finding 超过 14 天未流转（提醒，不阻断）；可让 AI 逐条给出采纳/否定建议后批量处置`);
      // 有其他硬 warning 时提醒会被吞(设计意图),补日志留痕保可观测(审计 P3-3)
      log(projectLogEntry('Stop', 'SOFT_AGED_FINDINGS', { proj, aged }));
    }
  } catch(e) {}

} else if (taskActive) {
  // v5 布局或无 changes/ 的 task.md 活跃内容不再阻断 Stop（CHG-20260612-02）：
  // 布局提示由 SessionStart / PostToolUse 一句性承载，Stop 只记录。
  log(projectLogEntry('Stop', 'SOFT_WARN', { proj, signal: paceSignal, reason: 'task-active-without-changes-dir' }));

} else if (existing.length > 0) {
  // task.md 不存在，但有其他 artifact → 不完整
  addWarning('repair', `检测到 ${existing.join(', ')} 但缺少 task.md，Artifact 不完整。task.md 格式：${FORMAT_SNIPPETS.taskGroup}`);
} else {
  // 无任何 artifact：v4.3.5 多信号检测
  // CHG-A A1：'superpowers' 半边已删（isPaceProject 不再返回该值，dated-plan 降级 detectSoftSignal）。
  if (paceSignal === 'manual') {
    // T-078 D2 修复：无 artifact 时仅记录日志，不加入 warnings
    log(projectLogEntry('Stop', 'SOFT_WARN', { proj, signal: paceSignal, reason: 'no artifact' }));
  } else {
    const codeCount = countCodeFiles(cwd);
    if (codeCount >= 3) {
      log(projectLogEntry('Stop', 'SOFT_WARN', { proj, signal: paceSignal, codeCount, reason: 'code-count-no-artifact' }));
    }
  }
}

// Legacy 任务面板 observer 标志清理：仅兼容旧手动配置，不代表当前 PACE 执行状态。
// v6 artifact 模式的 legacy task-panel flags 由 SessionStart 按会话清理；Stop 不改写 artifact 内容。
// 不阻止退出，因为当前插件不注册任务面板 hook，也无法查询 Claude 内部任务面板状态。
const taskListFlags = [path.join(PACE_RUNTIME, 'task-list-used'), path.join(PACE_RUNTIME, 'todowrite-used')];
if (paceSignal !== 'artifact' && taskListFlags.some(f => fs.existsSync(f)) && taskActive) {
  const { pending, done } = countByStatus(taskActive, { topLevelOnly: true });
  if (pending === 0 && done === 0) {
    log(projectLogEntry('Stop', 'TASK_LIST_CLEANUP', { proj, reason: 'no active task' }));
    for (const flag of taskListFlags) {
      try { fs.unlinkSync(flag); } catch(e) {}
    }
  }
}

if (warnings.length > 0) {
  // v4.7: teammate 降级 — 不阻止，仅输出 additionalContext 提醒
  if (isTeammate()) {
    // I-6: Stop hook 不支持 additionalContext，teammate 直接 exit 0 放行
    log(projectLogEntry('Stop', 'TEAMMATE_PASS', { proj, team: process.env.CLAUDE_CODE_TEAM_NAME, checks: warnings.join('; ') }));
    process.exit(0);
  } else {
    // W-7: 修正缩进（与 if 分支对齐）
    const blockCount = getBlockCount();
    const checksDetail = warnings.map((w, i) => `  [${i+1}] ${w}`).join('\n');
    if (blockCount >= MAX_BLOCKS) {
      // v4.3.3: 降级时写入标记文件，让 PostToolUse 提醒 AI
      try { fs.mkdirSync(PACE_RUNTIME, { recursive: true }); } catch(e) {}
      try { fs.writeFileSync(path.join(PACE_RUNTIME, 'degraded'), `降级时间: ${ts()}\n未通过检查:\n${checksDetail}\n`, 'utf8'); } catch(e) {}
      // T-424: 降级后重置计数器，避免下次会话冻结在 MAX_BLOCKS
      setBlockCount(0, { ensure: true });
      log(projectLogEntry('Stop', 'DOWNGRADE', { proj, blockCount, maxBlocks: MAX_BLOCKS, checks: warnings.join('; '), note: '.pace/degraded written' }));
      process.exit(0);
    } else {
      // STOP-02：counter 不可写时防无限循环机制失效（getBlockCount 恒 0、永远到不了 MAX_BLOCKS），
      // 降级放行避免 Stop 永久 exit 2 死循环——counter 不可写时 fail-open 优于 fail-closed 死锁。
      if (!setBlockCount(blockCount + 1, { ensure: true })) {
        log(projectLogEntry('Stop', 'COUNTER_UNWRITABLE', { proj, blockCount, checks: warnings.join('; '), note: 'counter 不可写，降级放行避免 Stop 死循环' }));
        process.exit(0);
      }
      // v4：exit 2 阻止 Claude 停止，stderr 反馈给 Claude
      // T-330: stderr 编号列表 + 降级递进式消息
      const stderrLines = warnings.map((w, i) => `[${i+1}] ${w}`);
      stderrLines.push(`[提示] 处理上述 PACEflow 检查前，${FORMAT_SNIPPETS.skillRef}。`);
      if (blockCount >= 1) stderrLines.push(`[提示] 这是第 ${blockCount + 1} 次阻止，请逐项处理上述问题后再结束会话。`);
      if (blockCount >= 2) stderrLines.push(`[警告] 下次将降级为软提醒不再阻止，但问题仍需处理。`);
      // HOTFIX-20260314-02: 场景感知前缀——区分"用户决策"/"继续执行"/"收尾修复"
      const hasUserActionWarning = warningTypes.includes('user-action');
      const hasExecutionWarning = warningTypes.includes('execution');
      const hasVerifyWarning = warningTypes.includes('verify');
      let prefix;
      if (hasUserActionWarning && hasExecutionWarning) {
        prefix = 'PACE 检查未通过，请继续执行任务并处理以下问题；其中部分问题需要用户决策：';
      } else if (hasUserActionWarning) {
        prefix = 'PACE 检查未通过，以下问题需要用户决策：';
      } else if (hasExecutionWarning) {
        prefix = 'PACE 检查未通过，请继续执行任务并处理以下问题：';
      } else if (hasVerifyWarning) {
        // N07：verify 警告正文要求去运行验证 / 派 review agent 做审计（要执行动作），
        //   不能落默认前缀「不要执行新任务」——单列一档，与「去验证 / 审计收尾」语义一致。
        prefix = 'PACE 检查未通过，请先完成验证 / 审计收尾，再处理以下检查项：';
      } else {
        prefix = 'PACE 完成度检查未通过。请仅修复以下检查项，不要执行新任务：';
      }
      const stderrMsg = `${prefix}\n${paceUtils.artifactDirRuntimeHint(cwd)}\n${stderrLines.join('\n')}`;
      process.stderr.write(stderrMsg + '\n');
      log(projectLogEntry('Stop', 'BLOCK', { proj, blockCount: blockCount + 1, maxBlocks: MAX_BLOCKS, checks: warnings.join('; '), stderr: stderrMsg }));
      process.exit(2);
    }
  } // 关闭 isTeammate else
} else {
  // 检查全部通过，重置计数器 + 清除降级标记
  if (emitAllowedStopReminders({ deferredReminders: softReminders, backgroundReminders: backgroundWorkReminders, backlogReminders, backgroundTasks, t0 })) process.exit(0);
  resetHardBlockRuntime();
  log(projectLogEntry('Stop', 'PASS', { proj, dur: Date.now() - t0 }));
  process.exit(0);
}
} catch(e) {
  try { log(projectLogEntry('Stop', 'ERROR', { proj, error: e.message })); } catch(e2) {}
  process.exit(0);
}
