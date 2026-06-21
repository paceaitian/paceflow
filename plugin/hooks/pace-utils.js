// pace-utils.js — PACE hooks 公共工具函数
// v6 项目识别 + 懒创建模板 + changes/ 详情解析 + .pace/disabled 豁免
const fs = require('fs');
const path = require('path');

// pace-utils.js 是兼容门面；子模块保持可审计边界，外部仍只 require('./pace-utils')。
// Hook 测试与 env-scrub 场景会在同一 Node 进程内切换环境变量，因此门面重载时
// 也要刷新会读取 process.env 的子模块缓存。
for (const rel of [
  './pace-utils/constants',
  './pace-utils/line-endings',
  './pace-utils/session',
  './pace-utils/path-utils',
  './pace-utils/logger',
  './pace-utils/plans',
  './pace-utils/change-id',
  './pace-utils/change-analysis',
  './pace-utils/locks',
]) {
  delete require.cache[require.resolve(rel)];
}

const {
  PACE_VERSION,
  CODE_EXTS,
  ARTIFACT_FILES,
  PROTECTED_ARTIFACTS,
  ARCHIVE_REQUIRED_FILES,
  ARCHIVE_MISSING_INJECT_LIMIT,
  VAULT_PATH,
  ARTIFACT_ROOT_CHOICE_FILE,
  PROJECT_ROOT_FILE,
  ARTIFACT_WRITER_LOCK_FILE,
  ARTIFACT_WRITER_LOCK_TTL_MS,
  ARTIFACT_RESOURCE_LOCK_TTL_MS,
  ARTIFACT_RESOURCE_LOCK_WAIT_MS,
  ARTIFACT_SEQUENCE_LOCK_TTL_MS,
  ARTIFACT_SEQUENCE_LOCK_WAIT_MS,
  PLAN_SYNC_LOCK_TTL_MS,
  PLAN_SYNC_LOCK_WAIT_MS,
  CHANGE_OWNER_TTL_MS,
  SESSION_PAUSE_TTL_MS,
  ARTIFACT_ROOT_CHOICE_MAX_CHARS,
  RESERVE_ARTIFACT_ID_SCRIPT,
  SYNC_PLAN_SCRIPT,
  SET_ARTIFACT_ROOT_SCRIPT,
  SET_PROJECT_ROOT_SCRIPT,
  MIGRATE_V7_SCRIPT,
  PACE_ARTIFACT_ROOT_CONTENT,
  ARCHIVE_MARKER,
  ARCHIVE_PATTERN,
  SKILL_DIRS,
  FORMAT_SNIPPETS,
  SESSION_SCOPED_FLAGS,
  SESSION_SCOPED_FLAG_PREFIXES,
  PLAN_DIRS,
} = require('./pace-utils/constants');

const {
  normalizeLineEndings,
  hasNonNullVerifiedDate,
  hasNonNullReviewedDate,
} = require('./pace-utils/line-endings');

const {
  isTeammate,
  isArtifactWriterAgentType,
  normalizeSessionId,
  currentSessionId,
  parseHookStdin,
  withStdinParsed,
  parseStdinSync,
} = require('./pace-utils/session');

const {
  resolveProjectCwd,
  ts,
  todayISO,
  daysSinceISODate,
  normalizePath,
  displayDir,
  isPortableAbsolutePath,
  resolveToolFilePath,
  isArtifactRelativePath,
  artifactRelativePathForFile,
  escapeRegex,
  resolveEffectiveProjectRoot,
  rawProjectNameCandidates,
  getProjectNameCandidates,
  getProjectName,
  getProjectStateDir,
  getProjectRuntimeDir,
  executionContextForCwd,
  hasChangesDir,
  legacyV5FilesInDir,
} = require('./pace-utils/path-utils');

const {
  createLogger,
  defaultLogPath,
  logEntry,
} = require('./pace-utils/logger');

const {
  normalizeChangeId,
  detailPathForId,
  slugForChangeId,
  changeIdFromArtifactRel,
} = require('./pace-utils/change-id');

const {
  countByStatus,
  extractOpenKeys,
  normalizeFindingKey,
  normalizeFrontmatterStatus,
  detectLegacyImplFormat,
  parseFrontmatter,
  validateFrontmatterSchema,
  SCHEMA_V7_KEYS,
  detectNewerSchemaData,
  validateWalkthroughLinks,
  parseChangeIndex,
  readChangeDetail,
  extractTaskSection,
  countDetailTasks,
  classifyChange,
  getActiveChangeEntries,
  isChangeApproved,
  isChangeVerified,
  isChangeReviewed,
  summarizeActiveChanges,
  findActiveIndexBelowArchive,
} = require('./pace-utils/change-analysis')({
  readActive,
  readFull,
  getArtifactDir,
  escapeRegex,
});

const {
  getArtifactWriterLockPath,
  readArtifactWriterLock,
  artifactWriterLockMatches,
  operationFromAgentPrompt,
  changeIdFromAgentPrompt,
  explicitChangeTargetFromAgentPrompt,
  artifactResourceForRel,
  getArtifactResourceLockPath,
  readArtifactResourceLock,
  acquireArtifactResourceLock,
  releaseArtifactResourceLock,
  releaseArtifactResourcesForOwner,
  sweepStaleRuntimeOwners,
  markIndexChangesTouchedAndMaybeRelease,
  formatArtifactResourceLock,
  reserveArtifactId,
  reserveArtifactIds,
  readArtifactReservation,
  findArtifactReservationForRel,
  clearArtifactReservation,
  clearArtifactReservationForRel,
  reservationMatchesArtifactRel,
  isArtifactRuntimeControlPath,
  getChangeOwnerPath,
  readChangeOwner,
  writeChangeOwner,
  markChangeOwnerClosed,
  touchChangeOwnersForSession,
  detachChangeOwnersForSession,
  reviveDetachedChangeOwnersForSession,
  sessionPausePath,
  writeSessionPause,
  clearSessionPause,
  isSessionPaused,
  changeOwnerStatus,
  ownerTakeoverConfirmed,
  acquireJsonLock,
} = require('./pace-utils/locks')({
  getProjectRuntimeDir,
  displayDir,
  normalizeSessionId,
  currentSessionId,
  executionContextForCwd,
  normalizePath,
  getArtifactDir,
  todayISO,
  CHANGE_OWNER_TTL_MS,
  SESSION_PAUSE_TTL_MS,
  PROJECT_ROOT_FILE,
});

const {
  listPlanFiles,
  hasPlanFiles,
  hasUnsyncedPlanFiles,
  listUnsyncedPlanFiles,
  hasBridgeCandidatePlanFiles,
  listBridgeCandidatePlanFiles,
  syncPlanFile,
  getNativePlanPath,
  nativePlanMatchesProject,
  formatBridgeHint,
} = require('./pace-utils/plans')({
  getProjectRuntimeDir,
  getProjectStateDir,
  acquireJsonLock,
  normalizePath,
  getProjectNameCandidates,
  escapeRegex,
});

function getArtifactRootChoicePath(cwd) {
  return path.join(getProjectRuntimeDir(cwd), ARTIFACT_ROOT_CHOICE_FILE);
}

function getProjectRootMarkerPath(cwd) {
  return path.join(path.resolve(cwd || process.cwd()), '.pace', PROJECT_ROOT_FILE);
}

function isLocalArtifactRootChoicePath(cwd, filePath) {
  if (!cwd || !filePath) return false;
  const target = normalizePath(path.resolve(filePath));
  const localChoicePath = normalizePath(path.join(path.resolve(cwd), '.pace', ARTIFACT_ROOT_CHOICE_FILE));
  const authoritativeChoicePath = normalizePath(getArtifactRootChoicePath(cwd));
  return target === localChoicePath && target !== authoritativeChoicePath;
}

function isProjectRootMarkerPath(cwd, filePath) {
  if (!filePath) return false;
  const target = normalizePath(path.resolve(filePath));
  return target.endsWith(`/.pace/${PROJECT_ROOT_FILE}`);
}

function localArtifactRootChoiceDenyReason(cwd, extra = '') {
  const context = executionContextForCwd(cwd);
  const choicePath = getArtifactRootChoicePath(cwd).replace(/\\/g, '/');
  const projectRoot = getProjectStateDir(cwd).replace(/\\/g, '/');
  const lines = [
    '当前 cwd 继承了外层 PaceFlow Project Root，artifact-root 配置必须写入该 Project Root 的共享 runtime，不写当前子目录的 .pace/artifact-root。',
    `当前 cwd: ${path.resolve(cwd || process.cwd()).replace(/\\/g, '/')}`,
    `Project Root: ${projectRoot}`,
    `配置文件: ${choicePath}`,
    `execution-context: ${context.text}`,
    `请运行 artifact-root helper：node "${SET_ARTIFACT_ROOT_SCRIPT}" --choice local 或 --choice vault`,
    'helper 会写入正确的共享 runtime 配置位置；若当前子目录确实是独立项目，先运行 Project Root helper 声明 independent。'
  ];
  if (extra) lines.push(extra);
  return lines.join('\n');
}

function projectRootMarkerDenyReason(cwd, extra = '') {
  const context = executionContextForCwd(cwd);
  const markerPath = getProjectRootMarkerPath(cwd).replace(/\\/g, '/');
  const projectRoot = getProjectStateDir(cwd).replace(/\\/g, '/');
  const lines = [
    '禁止手写 .pace/project-root。Project Root 独立声明必须通过 helper 完成，避免绕过 worktree 拒绝、父级继承和后续 artifact-root 引导。',
    `当前 cwd: ${path.resolve(cwd || process.cwd()).replace(/\\/g, '/')}`,
    `当前 Project Root: ${projectRoot}`,
    `当前 cwd marker: ${markerPath}`,
    `execution-context: ${context.text}`,
    `请运行 Project Root helper：node "${SET_PROJECT_ROOT_SCRIPT}" --mode independent`,
    'helper 会校验当前 cwd 是否为真实 git worktree；声明成功后再运行 artifact-root helper 选择 local 或 vault。'
  ];
  if (extra) lines.push(extra);
  return lines.join('\n');
}

function normalizeArtifactRootChoice(choice) {
  let raw = String(choice || '').slice(0, ARTIFACT_ROOT_CHOICE_MAX_CHARS).trim();
  if (!raw) return '';
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function readArtifactRootChoice(cwd) {
  const envChoice = process.env.PACE_ARTIFACT_ROOT || process.env.PACEFLOW_ARTIFACT_ROOT || '';
  if (String(envChoice).trim()) return normalizeArtifactRootChoice(envChoice);
  try { return normalizeArtifactRootChoice(fs.readFileSync(getArtifactRootChoicePath(cwd), 'utf8')); } catch(e) { return ''; }
}

function artifactDirFromChoice(cwd, choice) {
  const raw = normalizeArtifactRootChoice(choice);
  if (!raw) return null;
  const keyword = raw.toLowerCase();
  const stateDir = getProjectStateDir(cwd);
  if (keyword === 'local') return stateDir;
  if (keyword === 'vault') {
    if (!VAULT_PATH) return null;
    return path.join(VAULT_PATH, 'projects', getProjectNameCandidates(cwd)[0]);
  }
  if (isPortableAbsolutePath(raw)) return path.resolve(raw);
  return path.resolve(stateDir, raw);
}

function getConfiguredArtifactDir(cwd) {
  return artifactDirFromChoice(cwd, readArtifactRootChoice(cwd));
}

function artifactRootConfigError(cwd) {
  const choice = readArtifactRootChoice(cwd).toLowerCase();
  if (choice === 'vault' && !VAULT_PATH) {
    const choicePath = getArtifactRootChoicePath(cwd);
    return {
      code: 'vault-env-missing',
      choice,
      choicePath,
      message: [
        'PACEflow artifact-root 配置为 vault，但当前 hook 进程没有 PACE_VAULT_PATH，无法解析 Obsidian vault artifact 根目录。',
        `配置文件: ${choicePath.replace(/\\/g, '/')}`,
        '为避免把 artifact 静默写到本地项目目录，本次操作已停止。',
        '请恢复 PACE_VAULT_PATH 后重试；或如果确实要改用本地 artifact，请将配置文件内容改为纯文本 local。'
      ].join('\n')
    };
  }
  return null;
}

function hasLegacyV5ArtifactsDir(dir) {
  return legacyV5FilesInDir(dir).length > 0;
}

function getLegacyV5ArtifactDir(cwd) {
  const configuredDir = getConfiguredArtifactDir(cwd);
  if (configuredDir) return hasLegacyV5ArtifactsDir(configuredDir) ? configuredDir : null;

  if (VAULT_PATH) {
    for (const projectName of getProjectNameCandidates(cwd)) {
      const vaultDir = path.join(VAULT_PATH, 'projects', projectName);
      if (hasLegacyV5ArtifactsDir(vaultDir)) return vaultDir;
    }
  }

  const stateDir = getProjectStateDir(cwd);
  if (hasLegacyV5ArtifactsDir(stateDir)) return stateDir;
  if (stateDir !== cwd && hasLegacyV5ArtifactsDir(cwd)) return cwd;
  return null;
}

// v5 布局检测（CHG-20260612-02）：只产出布局事实供一句性提示与 W11 守卫消费，
// 不再承载迁移状态机（state/needsPrompt 随 v5 迁移路径退役）。
function getV5MigrationInfo(cwd) {
  const dir = getLegacyV5ArtifactDir(cwd);
  return {
    detected: !!dir,
    dir: dir || '',
    files: dir ? legacyV5FilesInDir(dir) : [],
  };
}

function v5LayoutNoticeMessage(cwd) {
  const info = getV5MigrationInfo(cwd);
  if (!info.detected) return '';
  return [
    `检测到 v5 时代 artifact 布局（${displayDir(info.dir)}：${info.files.join(', ')} 含活跃详情、无 changes/ 目录）。`,
    'PACEflow 当前架构：新变更按当前合同写入——task.md 仅追加索引行，详情在 changes/<id>.md（首个 create-chg 会建出 changes/，此提示随之消失）。',
    'v5 存量内容保持原样，不自动迁移；如需保留历史，可手动归档到 <!-- ARCHIVE --> 下方。'
  ].join('\n');
}

function artifactRootChoiceNeeded(cwd) {
  if (!VAULT_PATH) return false;
  if (getConfiguredArtifactDir(cwd)) return false;
  if (getLegacyV5ArtifactDir(cwd)) return false;
  if (hasChangesDir(getProjectStateDir(cwd))) return false;
  for (const projectName of getProjectNameCandidates(cwd)) {
    if (hasChangesDir(path.join(VAULT_PATH, 'projects', projectName))) return false;
  }
  return true;
}

function artifactRootChoiceMessage(cwd) {
  const projectName = getProjectName(cwd);
  const stateDir = getProjectStateDir(cwd);
  const rootInfo = resolveEffectiveProjectRoot(cwd);
  const vaultDir = VAULT_PATH ? path.join(VAULT_PATH, 'projects', projectName) : '';
  const choicePath = getArtifactRootChoicePath(cwd);
  return [
    'PACEflow 首次启用需要选择 artifact 存放位置。',
    FORMAT_SNIPPETS.skillRef,
    `Project Root: ${stateDir.replace(/\\/g, '/')}（当前 cwd: ${path.resolve(cwd || process.cwd()).replace(/\\/g, '/')}；mode=${rootInfo.mode}）`,
    `如果当前子目录应作为独立 PaceFlow 项目，先运行 Project Root helper：node "${SET_PROJECT_ROOT_SCRIPT}" --mode independent`,
    `Obsidian vault artifact 根目录: ${displayDir(vaultDir)}`,
    `本地项目 artifact 根目录: ${displayDir(stateDir)}`,
    '请用 AskUserQuestion 询问用户选择 "Obsidian vault project" 或 "本地项目目录"（至少两个选项）。',
    `用户选择后，运行 artifact-root helper 写入配置：node "${SET_ARTIFACT_ROOT_SCRIPT}" --choice local 或 --choice vault`,
    `配置文件: ${choicePath.replace(/\\/g, '/')}`,
    '该配置文件不是 artifact 根目录。',
    `artifact_dir 只用于 PaceFlow artifacts：${PACE_ARTIFACT_ROOT_CONTENT}。`,
    `配置写入后再从目标项目 cwd 运行 reserve helper：node "${RESERVE_ARTIFACT_ID_SCRIPT}" --operation create-chg --cwd "${path.resolve(cwd).replace(/\\/g, '/')}"`,
    'reserve helper 不接受 --artifact-dir / --artifact-root / --project-dir；自动化只可用 --cwd。',
    '写入配置后，不要直接重试代码写入；先创建/批准 CHG，再重试被阻止的代码写入。若被阻止的是 artifact-writer Agent，则按提示重派同一操作。'
  ].join('\n');
}

// 渲染纯函数（HOTFIX-20260621-01）：从 artifactDirRuntimeHint 抽出，便于注入 Windows 反斜杠路径做归一判别测试。
// choicePath/stateDir 在显示边界统一正斜杠归一，避免同一行三路径分隔符不一致（Windows 上 choicePath 裸插反斜杠是 GOLDEN 漂移根因）。
function formatArtifactDirHint({ artDir, choice, choicePath, stateDir, mode }) {
  return `Artifact 根目录：${displayDir(artDir)}（选择=${choice}；配置文件=${String(choicePath).replace(/\\/g, '/')}；Project Root=${String(stateDir).replace(/\\/g, '/')}；mode=${mode}；仅用于 ${PACE_ARTIFACT_ROOT_CONTENT}）`;
}

function artifactDirRuntimeHint(cwd) {
  return formatArtifactDirHint({
    artDir: getArtifactDir(cwd),
    choice: readArtifactRootChoice(cwd) || 'auto',
    choicePath: getArtifactRootChoicePath(cwd),
    stateDir: getProjectStateDir(cwd),
    mode: resolveEffectiveProjectRoot(cwd).mode,
  });
}

function appendArtifactDirHint(cwd, message) {
  const text = String(message || '');
  if (!text) return artifactDirRuntimeHint(cwd);
  if (text.includes('Artifact 根目录') || text.includes('artifact 根目录')) return text;
  return `${text}\n${artifactDirRuntimeHint(cwd)}`;
}

// T-281: 模块级缓存，避免同一 hook 进程内重复 existsSync（同 cwd 最多 11 次→1 次）
let _artifactDirCache = { cwd: null, dir: null };

function _clearArtifactDirCache() {
  _artifactDirCache = { cwd: null, dir: null };
}

/**
 * 获取 artifact 文件的实际存储目录
 * 优先级：显式 artifact-root → vault 有 v6 → CWD 有 v6 → legacy v5 → 新项目默认 vault/CWD
 * @param {string} cwd - 当前工作目录
 * @returns {string} artifact 目录路径
 */
function getArtifactDir(cwd) {
  if (_artifactDirCache.cwd === cwd) return _artifactDirCache.dir;
  const stateDir = getProjectStateDir(cwd);
  let result = stateDir;
  const configuredDir = getConfiguredArtifactDir(cwd);
  if (configuredDir) {
    _artifactDirCache = { cwd, dir: configuredDir };
    return configuredDir;
  }
  const projectCandidates = getProjectNameCandidates(cwd);
  // T-422: VAULT_PATH 空值守卫 — 无 vault 时跳过 vault 分支，直接走 CWD 路径
  if (VAULT_PATH) {
    for (const projectName of projectCandidates) {
      const vaultDir = path.join(VAULT_PATH, 'projects', projectName);
      try {
        // v6 项目信号：vault 项目目录存在 changes/
        if (fs.existsSync(path.join(vaultDir, 'changes'))) {
          result = vaultDir;
          _artifactDirCache = { cwd, dir: result };
          return result;
        }
      } catch(e) {}
    }
  }
  // Project Root 有 changes/ → Project Root
  if (fs.existsSync(path.join(stateDir, 'changes'))) {
    _artifactDirCache = { cwd, dir: stateDir };
    return stateDir;
  }
  const legacyDir = getLegacyV5ArtifactDir(cwd);
  if (legacyDir) {
    _artifactDirCache = { cwd, dir: legacyDir };
    return legacyDir;
  }
  // 新项目（无配置、无 vault v6 changes/、无 local v6 changes/、无 legacy）→ 默认本地项目根
  //   （F3：偏 local，不隐式指 vault）。显式 artifact-root / 已有 changes/ / 已迁 vault 在上方分支已早返回；
  //   此处仅「四不沾全新项目」的隐式默认——用户未表态前默认 local，避免注入 Artifact Root 误导指向 vault。
  result = stateDir;
  _artifactDirCache = { cwd, dir: result };
  return result;
}

function projectLogFields(cwd, artifactDir = '') {
  const rootInfo = resolveEffectiveProjectRoot(cwd);
  let artDir = artifactDir;
  try {
    if (!artDir) artDir = getArtifactDir(cwd);
  } catch(e) {}
  return {
    cwd: path.resolve(cwd || process.cwd()).replace(/\\/g, '/'),
    project_root: rootInfo.projectRoot.replace(/\\/g, '/'),
    artifact_dir: artDir ? displayDir(artDir) : '',
    mode: rootInfo.mode,
  };
}

function projectLogEntry(cwd, hook, action, fields = {}, artifactDir = '') {
  return logEntry(hook, action, {
    ...projectLogFields(cwd, artifactDir),
    ...fields,
  });
}

// W-6: 模块级缓存，避免 isPaceProject + 外部调用重复扫描目录
let _codeCountCache = { cwd: null, count: 0 };

/** 统计 cwd 根目录下的代码文件数量（同 cwd 自动缓存） */
function countCodeFiles(cwd) {
  if (_codeCountCache.cwd === cwd) return _codeCountCache.count;
  try {
    const count = fs.readdirSync(cwd).filter(f => CODE_EXTS.some(ext => f.endsWith(ext))).length;
    _codeCountCache = { cwd, count };
    return count;
  } catch(e) { return 0; }
}

/**
 * 多信号 PACE 激活判断
 * @param {string} cwd - 当前工作目录
 * @returns {'artifact'|'manual'|'legacy'|false} 仅强信号激活；弱信号（code-count/dated-plan）见 detectSoftSignal
 */
function isPaceProject(cwd) {
  try {
    // T-080: 豁免信号（最高优先级）— 用户主动禁用 PACE（.pace/disabled）
    const disabledPaths = [
      path.join(cwd, '.pace', 'disabled'),
      path.join(getProjectRuntimeDir(cwd), 'disabled'),
    ];
    if (disabledPaths.some(fp => fs.existsSync(fp))) return false;
    const storedArtifactRootChoice = (() => {
      try { return fs.existsSync(getArtifactRootChoicePath(cwd)) ? readArtifactRootChoice(cwd) : ''; } catch(e) { return ''; }
    })();
    const configuredDir = getConfiguredArtifactDir(cwd);
    if (configuredDir) {
      if (hasChangesDir(configuredDir)) return 'artifact';
    } else {
      const stateDir = getProjectStateDir(cwd);
      // 信号 1（最强）：v6 项目必须有 changes/ 目录（PU-002：isDirectory 区分同名文件）
      if (hasChangesDir(stateDir)) return 'artifact';
      // T-422: VAULT_PATH 空值守卫 — 无 vault 时跳过 vault 信号检查
      if (VAULT_PATH) {
        for (const projectName of getProjectNameCandidates(cwd)) {
          const vaultDir = path.join(VAULT_PATH, 'projects', projectName);
          try {
            if (fs.existsSync(path.join(vaultDir, 'changes'))) return 'artifact';
          } catch(e) {}
        }
      }
    }
    if (getLegacyV5ArtifactDir(cwd)) return 'legacy';
    // A stored artifact-root choice is an explicit PACE entry signal even
    // before templates/changes have been lazily initialized.
    if (configuredDir || storedArtifactRootChoice) return 'manual';
    // 强信号：手动激活标记（用户显式 enable 或既有 .pace-enabled）。
    if (fs.existsSync(path.join(getProjectStateDir(cwd), '.pace-enabled'))) return 'manual';
    // CHG-A A1：原 dated-plan（superpowers）与 code-count（3+ 文件）两个弱信号 return 已移除。
    //   它们信号强度与后果倒挂（最弱信号触发静默建 artifact + 永久锁定 + 写代码 deny），
    //   现降级到 detectSoftSignal——只提示 AI 主动询问用户，不再激活任何门控。
    //   countCodeFiles / hasBridgeCandidatePlanFiles 检测逻辑保留，供 detectSoftSignal 复用。
  } catch(e) {}
  return false;
}

/**
 * 软信号检测（CHG-A A2）：与 isPaceProject 激活层正交——只用于提示 AI 主动询问用户，
 *   不触发任何门控（deny / 建 artifact / 锁定）。
 *   规则：有 .pace/disabled（用户已禁用，与 isPaceProject T-080 守卫同源双路径）或已激活
 *   （isPaceProject 真值）→ false（不提示）；否则 code-count（3+ 代码文件）优先于
 *   dated-plan（docs/plans|docs/superpowers/plans 下 <date>-*.md，mtime 新鲜或当前 native plan，
 *   即被 A1 移除的原 superpowers 信号同判据 1:1 降级）。
 *   读文件失败一律返回 false（fail-safe：漏提示=不激活=野外安全，spec §8）。
 * @param {string} cwd - 当前工作目录
 * @returns {'code-count'|'dated-plan'|false}
 */
function detectSoftSignal(cwd) {
  try {
    // 已禁用 → 不提示（与 isPaceProject 的 T-080 disabled 守卫同源双路径）。
    const disabledPaths = [
      path.join(cwd, '.pace', 'disabled'),
      path.join(getProjectRuntimeDir(cwd), 'disabled'),
    ];
    if (disabledPaths.some(fp => fs.existsSync(fp))) return false;
    // 已激活（强信号）→ 不再软提示（已 enabled / 既有 changes/ / 配置 / legacy）。
    if (isPaceProject(cwd)) return false;
    // code-count 优先于 manifest / dated-plan（更直接的「这是代码项目」信号）。
    if (countCodeFiles(cwd) >= 3) return 'code-count';
    // CHG-20260611-05：项目清单文件检测——标准 src/ 布局项目根目录零代码文件，code-count
    // 恒 miss（finding-2026-06-11-code-count-src-layout-miss-soft-signal）；清单文件存在
    // 即「这是个工程项目」，零递归成本、误报面小。强于 dated-plan（工程证据 > 计划文件）。
    const MANIFEST_FILES = ['package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle'];
    if (MANIFEST_FILES.some(f => fs.existsSync(path.join(cwd, f)))) return 'manifest';
    if (hasBridgeCandidatePlanFiles(cwd)) return 'dated-plan';
  } catch (e) {}
  return false;
}

/** 读取文件活跃区（ARCHIVE_MARKER 上方内容），artifact 文件自动解析 vault 目录 */
function readActive(cwd, filename) {
  const dir = ARTIFACT_FILES.includes(filename) ? getArtifactDir(cwd) : cwd;
  const fp = path.join(dir, filename);
  // W-code-1: 直接 try readFileSync，消除 TOCTOU 竞态 + 减少 stat syscall
  try {
    const content = fs.readFileSync(fp, 'utf8');
    const m = content.match(ARCHIVE_PATTERN);
    return m ? content.slice(0, m.index) : content;
  } catch(e) { return null; }
}

/**
 * 检测未迁移的 v6 双索引布局（CHG-20260611-12 T-002）：
 * implementation_plan.md 活跃区仍含 CHG 索引行（task.md 是唯一 CHG 索引；tombstone /
 * 不存在 / 仅归档区有行都不算未迁移）。impl_plan 不在 ARTIFACT_FILES，需自行解析 artifact dir
 * 只读活跃区——读全文会把归档区旧行也算「未迁移」，全归档项目被永久催办。
 */
function detectUnmigratedV6Layout(cwd) {
  try {
    const fp = path.join(getArtifactDir(cwd), 'implementation_plan.md');
    const content = fs.readFileSync(fp, 'utf8');
    const m = content.match(ARCHIVE_PATTERN);
    const activePart = m ? content.slice(0, m.index) : content;
    return parseChangeIndex(activePart).length > 0;
  } catch (e) { return false; }
}

/** 读取文件全文，artifact 文件自动解析 vault 目录 */
function readFull(cwd, filename) {
  const dir = ARTIFACT_FILES.includes(filename) ? getArtifactDir(cwd) : cwd;
  const fp = path.join(dir, filename);
  try { return fs.readFileSync(fp, 'utf8'); } catch(e) { return null; }
}

/** 检查 ARCHIVE 标记格式，返回错误消息或 null */
function checkArchiveFormat(cwd, filename) {
  const content = readFull(cwd, filename);
  if (!content) return null;
  const hasCorrect = ARCHIVE_PATTERN.test(content);
  // I-6: 匹配所有级别的错误标题格式（# ARCHIVE ~ ###### ARCHIVE）
  const hasWrong = /^#{1,6}\s+ARCHIVE/m.test(content);
  if (hasWrong && !hasCorrect) return `${filename} 使用了错误的 ARCHIVE 标记格式（应为 <!-- ARCHIVE -->）`;
  // 层1：应保持双区结构的文件（ARCHIVE_REQUIRED_FILES，排除无双区的 spec.md）完全缺失 ARCHIVE 标记时报警——
  // session-start 注入依赖该标记切分活跃区，缺失会导致整个文件全文注入 context（findings/walkthrough 可达 10 万字符）。
  if (!hasCorrect && ARCHIVE_REQUIRED_FILES.includes(filename)) {
    return `${filename} 缺少 <!-- ARCHIVE --> 标记。session-start 注入依赖该标记切分活跃区，缺失会导致整个文件全文注入 context。请派 artifact-writer 修复双区结构。`;
  }
  return null;
}

/**
 * 确保 PACE 项目基础设施就绪（幂等）
 * - .pace/.gitignore（运行时文件不入库）
 * - 仅在 vault 已被选择或已有 vault artifact 时确保 vault 项目目录存在
 * @param {string} cwd - 当前工作目录
 */
function ensureProjectInfra(cwd) {
  // .pace/.gitignore
  try {
    const paceDir = getProjectRuntimeDir(cwd);
    const gitignorePath = path.join(paceDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.mkdirSync(paceDir, { recursive: true });
      fs.writeFileSync(gitignorePath, '*\n', 'utf8');
    }
  } catch(e) {}
  // vault 项目目录：首次启用未选择 root 时不能在 Obsidian 创建空项目目录。
  if (VAULT_PATH) {
    try {
      const vaultDirs = getProjectNameCandidates(cwd).map(projectName => path.join(VAULT_PATH, 'projects', projectName));
      const configuredDir = getConfiguredArtifactDir(cwd);
      const configuredVaultDir = configuredDir
        ? vaultDirs.find(dir => normalizePath(dir) === normalizePath(configuredDir))
        : null;
      const existingVaultDir = vaultDirs.find(dir => fs.existsSync(path.join(dir, 'changes')));
      const target = configuredVaultDir || existingVaultDir;
      if (target) fs.mkdirSync(target, { recursive: true });
    } catch(e) {}
  }
}

/**
 * T-075: 从模板目录复制缺失的 artifact 文件到 artifact 目录（vault 或 cwd）
 * @param {string} cwd - 当前工作目录
 * @returns {string[]} 创建的文件名列表
 */
function createTemplates(cwd) {
  const configError = artifactRootConfigError(cwd);
  if (configError) throw new Error(configError.message);
  const TEMPLATES_DIR = path.join(__dirname, 'templates');
  const artDir = getArtifactDir(cwd);
  // 确保目标目录存在（vault 模式下可能尚未创建）
  try { fs.mkdirSync(artDir, { recursive: true }); } catch(e) {}
  for (const sub of ['changes', 'changes/findings', 'changes/corrections']) {
    try { fs.mkdirSync(path.join(artDir, sub), { recursive: true }); } catch(e) {}
  }
  const created = [];
  for (const file of ARTIFACT_FILES) {
    const target = path.join(artDir, file);
    const tmpl = path.join(TEMPLATES_DIR, file);
    if (!fs.existsSync(target) && fs.existsSync(tmpl)) {
      try {
        const content = normalizeLineEndings(fs.readFileSync(tmpl, 'utf8'));
        fs.writeFileSync(target, content, 'utf8');
        created.push(file);
      } catch(e) {}
    }
  }
  return created;
}

/**
 * 解析 frontmatter 中某个 YAML list 字段，返回去引号后的字符串数组。
 * 为什么手写：wiki 的 sources/tags 是 block-style（`key:\n  - item`），
 * 现有 inline 正则 `key: [a,b]` 无法覆盖；这里同时兼容两种写法，
 * 避免引入 YAML 依赖（hook 需零依赖、稳健降级）。
 * @param {string} fm - frontmatter 文本（不含 `---` 包裹）
 * @param {string} key - 字段名（如 'sources' / 'tags'）
 * @returns {string[]} 解析出的条目（已 trim、已去除成对引号），无字段返回 []
 */
function parseYamlList(fm, key) {
  const lines = fm.split(/\r?\n/);
  // 去除成对的首尾引号（"..." 或 '...'），其余原样返回
  const unquote = (s) => {
    const t = s.trim();
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
      return t.slice(1, -1);
    }
    return t;
  };
  // 定位 `key:` 行（行首无缩进，允许 key 后直接跟 inline list 或换行进入 block）
  const keyRe = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.*)$');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    const rest = m[1].trim();
    // inline 形式：key: [a, b, c]
    if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\]\s*$/, '');
      if (!inner.trim()) return [];
      return inner.split(',').map(x => unquote(x)).filter(x => x.length > 0);
    }
    // block 形式：随后若干 `  - item` 行，直到遇到下一个非缩进 key 或非列表行
    const items = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      const itemMatch = line.match(/^\s+-\s+(.*)$/);
      if (itemMatch) { items.push(unquote(itemMatch[1])); continue; }
      // 空行容忍（block list 中间一般无空行，但稳健起见跳过纯空白）
      if (/^\s*$/.test(line)) continue;
      // 遇到下一个字段（非缩进、形如 `xxx:`）或正文 → 结束
      break;
    }
    return items;
  }
  return [];
}

/**
 * 扫描 wiki/ + knowledge/ + thoughts/ 中与指定项目相关的笔记，返回 L0 摘要。
 * 区分三类来源（kind），让渲染层能给各类各自名额，避免 wiki 多时挤光 knowledge/thoughts：
 *  1. wiki（kind:'wiki'，高信噪比提炼）：type: wiki-article，按 sources 前缀 OR tags 含项目名匹配（并集）。
 *     wiki 内部按 status 排序（confirmed > likely > 其他），不依赖 readdir walk 序，保证截断时优先保留高置信度。
 *  2. knowledge（kind:'knowledge'，已沉淀但未提炼进 wiki 的原始记录）：扫 knowledge/，按 projects 匹配；
 *     basename 已在 wiki 层出现则去重跳过（同一主题提炼优先）。
 *  3. thoughts（kind:'thoughts'，未成熟/未实现想法）：扫 thoughts/，按 projects 匹配。
 * 返回扁平数组：wiki（排序后）在前、knowledge 居中、thoughts 在后；渲染层按 kind 分组各给名额。
 * 完全 vault-gated 且 wiki 可选：无 vault → []；无 wiki/ → 只 knowledge/thoughts；无 thoughts/ → 不出该类；降级干净。
 * @param {string} projectName - 当前项目名（小写连字符格式，或由 getProjectName 生成）
 * @returns {Array<{title: string, summary: string, status: string, kind: 'wiki'|'knowledge'|'thoughts'}>}
 */
function scanRelatedNotes(projectName) {
  if (!VAULT_PATH) return [];
  const projLower = projectName.toLowerCase();
  const wikiArticles = [];
  const wikiBasenames = new Set(); // 记录 wiki article 的 basename（去 .md），供 knowledge 层去重（thoughts 不去重）
  const knowledgeNotes = []; // kind:'knowledge'——已沉淀但未提炼进 wiki 的原始记录
  const thoughtsNotes = []; // kind:'thoughts'——未成熟/未实现想法

  // --- 解析单文件 frontmatter：返回 frontmatter 文本或 null ---
  const fmOf = (content) => {
    const fmMatch = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
    return fmMatch ? fmMatch[1] : null;
  };
  const summaryOf = (fm) => {
    const summaryMatch = fm.match(/^summary:\s*(?:"([^"]*)"|'([^']*)'|(.+))/m);
    return summaryMatch ? (summaryMatch[1] || summaryMatch[2] || summaryMatch[3] || '').trim() : '';
  };
  const statusOf = (fm) => {
    const statusMatch = fm.match(/^status:\s*(.+)/m);
    return statusMatch ? statusMatch[1].trim() : 'unknown';
  };

  // --- wiki 层（先执行，建立 basename 集合，article 优先排前）---
  const wikiRoot = path.join(VAULT_PATH, 'wiki');
  try {
    if (fs.existsSync(wikiRoot)) {
      // 递归收集 wiki/**/*.md，排除根 index.md/log.md 与 sources/ 目录（非 article）
      const walk = (dir) => {
        let out = [];
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return out; }
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (ent.name === 'sources') continue; // wiki/sources/** 是 wiki-source，跳过
            out = out.concat(walk(full));
          } else if (ent.isFile() && ent.name.endsWith('.md')) {
            // 仅 wiki 根下的 index.md/log.md 是索引/日志（子目录同名文件仍是 article）
            if (dir === wikiRoot && (ent.name === 'index.md' || ent.name === 'log.md')) continue;
            out.push(full);
          }
        }
        return out;
      };
      for (const file of walk(wikiRoot)) {
        try {
          const content = fs.readFileSync(file, 'utf8');
          const fm = fmOf(content);
          if (!fm) continue;
          // 仅 type: wiki-article
          const typeMatch = fm.match(/^type:\s*(.+)/m);
          if (!typeMatch || typeMatch[1].trim() !== 'wiki-article') continue;
          // 匹配项目：sources 前缀（`<项目名> ` 开头或全等）OR tags 含项目名（并集）
          const sources = parseYamlList(fm, 'sources');
          const tags = parseYamlList(fm, 'tags');
          const sourceHit = sources.some(s => {
            const tl = s.trim().toLowerCase();
            return tl === projLower || tl.startsWith(projLower + ' ');
          });
          const tagHit = tags.some(t => t.trim().toLowerCase() === projLower);
          if (!sourceHit && !tagHit) continue;
          // archived 不注入
          const status = statusOf(fm);
          if (status === 'archived') continue;
          const basename = path.basename(file).replace(/\.md$/, '');
          wikiBasenames.add(basename);
          wikiArticles.push({ title: basename, summary: summaryOf(fm), status, kind: 'wiki' });
        } catch(e) { /* 单文件解析失败静默跳过 */ }
      }
    }
  } catch(e) { /* wiki 根不可读静默跳过，降级为只 raw */ }

  // --- knowledge / thoughts 层：按所在目录拆 kind（CHG-04），projects 匹配；basename 已进 wiki 则去重 ---
  //   knowledge=已沉淀原始记录、thoughts=未成熟/未实现想法，渲染层据 kind 分两段各给名额。
  // 递归收集 <dir>/**/*.md（与 wiki 层 walk 对称，覆盖嵌套子目录——CHG-09 §E T-004，原仅顶层 readdir）。
  const walkMd = (root) => {
    let out = [];
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch(e) { return out; }
    for (const ent of entries) {
      const full = path.join(root, ent.name);
      if (ent.isDirectory()) out = out.concat(walkMd(full));
      else if (ent.isFile() && ent.name.endsWith('.md')) out.push(full);
    }
    return out;
  };
  for (const dir of ['knowledge', 'thoughts']) {
    const dirPath = path.join(VAULT_PATH, dir);
    const sink = dir === 'knowledge' ? knowledgeNotes : thoughtsNotes;
    try {
      if (!fs.existsSync(dirPath)) continue;
      for (const filePath of walkMd(dirPath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          // I-7: 处理 BOM（UTF-8 BOM \uFEFF 可能出现在文件开头）
          const fmMatch = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
          if (!fmMatch) continue;
          const fm = fmMatch[1];
          // 解析 projects 字段
          const projMatch = fm.match(/^projects:\s*\[([^\]]*)\]/m);
          if (!projMatch) continue;
          const projects = projMatch[1].split(',').map(p => p.trim().toLowerCase());
          if (!projects.includes(projLower)) continue;
          // basename 去重：只对 knowledge——已提炼进 wiki 的 knowledge 不重复（wiki 从 knowledge ingest）。
          //   thoughts 是未成熟想法、不进 wiki，即使巧合同名也保留（独立段价值在思考过程而非结论）。
          const basename = path.basename(filePath).replace(/\.md$/, '');
          if (dir === 'knowledge' && wikiBasenames.has(basename)) continue;
          // 解析 status（archived 不注入）
          const status = statusOf(fm);
          if (status === 'archived') continue;
          sink.push({ title: basename, summary: summaryOf(fm), status, kind: dir });
        } catch(e) { /* 单文件解析失败静默跳过 */ }
      }
    } catch(e) { /* 目录不可读静默跳过 */ }
  }

  // wiki 内部排序：status confirmed > likely > 其他（不依赖 readdir walk 序——CHG-04 修复 wiki 子集任意问题）。
  const wikiStatusRank = (s) => (s === 'confirmed' ? 0 : s === 'likely' ? 1 : 2);
  wikiArticles.sort((a, b) => wikiStatusRank(a.status) - wikiStatusRank(b.status));
  // 三类带 kind 扁平返回（wiki 排序后 → knowledge → thoughts）；渲染层按 kind 分两段、各给名额。
  return [...wikiArticles, ...knowledgeNotes, ...thoughtsNotes];
}

// I-04: 多行格式按功能分组，便于 diff 审阅
module.exports = {
  // 常量
  PACE_VERSION, CODE_EXTS, ARTIFACT_FILES, PROTECTED_ARTIFACTS, VAULT_PATH, ARTIFACT_ROOT_CHOICE_FILE, PROJECT_ROOT_FILE,
  ARTIFACT_WRITER_LOCK_FILE, ARTIFACT_WRITER_LOCK_TTL_MS,
  ARTIFACT_RESOURCE_LOCK_TTL_MS, ARTIFACT_RESOURCE_LOCK_WAIT_MS, CHANGE_OWNER_TTL_MS, SESSION_PAUSE_TTL_MS,
  ARTIFACT_SEQUENCE_LOCK_TTL_MS, ARTIFACT_SEQUENCE_LOCK_WAIT_MS, PLAN_SYNC_LOCK_TTL_MS, PLAN_SYNC_LOCK_WAIT_MS,
  RESERVE_ARTIFACT_ID_SCRIPT, SYNC_PLAN_SCRIPT, SET_ARTIFACT_ROOT_SCRIPT, SET_PROJECT_ROOT_SCRIPT, PACE_ARTIFACT_ROOT_CONTENT,
  ARCHIVE_MARKER, ARCHIVE_PATTERN, ARCHIVE_REQUIRED_FILES, ARCHIVE_MISSING_INJECT_LIMIT,
  SKILL_DIRS, SESSION_SCOPED_FLAGS, SESSION_SCOPED_FLAG_PREFIXES, FORMAT_SNIPPETS, PLAN_DIRS,
  // 基础工具
  resolveProjectCwd, ts, todayISO, daysSinceISODate, countCodeFiles, getProjectName, getProjectNameCandidates, rawProjectNameCandidates, normalizePath, displayDir,
  resolveToolFilePath, isArtifactRelativePath, artifactRelativePathForFile, executionContextForCwd,
  projectLogFields, projectLogEntry,
  // 项目检测与路径
  isPaceProject, detectSoftSignal, isTeammate, isArtifactWriterAgentType, normalizeSessionId, currentSessionId,
  getArtifactDir, _clearArtifactDirCache, resolveEffectiveProjectRoot, getProjectStateDir, getProjectRuntimeDir,
  getArtifactRootChoicePath, getProjectRootMarkerPath, normalizeArtifactRootChoice, readArtifactRootChoice, getConfiguredArtifactDir,
  isLocalArtifactRootChoicePath, localArtifactRootChoiceDenyReason, isProjectRootMarkerPath, projectRootMarkerDenyReason,
  getLegacyV5ArtifactDir, getV5MigrationInfo, v5LayoutNoticeMessage,
  getArtifactWriterLockPath, readArtifactWriterLock,
  artifactWriterLockMatches,
  artifactResourceForRel, getArtifactResourceLockPath, readArtifactResourceLock,
  acquireArtifactResourceLock, releaseArtifactResourceLock, releaseArtifactResourcesForOwner,
  sweepStaleRuntimeOwners,
  markIndexChangesTouchedAndMaybeRelease, formatArtifactResourceLock,
  reserveArtifactId, reserveArtifactIds, readArtifactReservation, findArtifactReservationForRel, clearArtifactReservation, clearArtifactReservationForRel, reservationMatchesArtifactRel,
  isArtifactRuntimeControlPath, operationFromAgentPrompt, changeIdFromAgentPrompt, explicitChangeTargetFromAgentPrompt,
  getChangeOwnerPath, readChangeOwner, writeChangeOwner, markChangeOwnerClosed, touchChangeOwnersForSession, detachChangeOwnersForSession, reviveDetachedChangeOwnersForSession, changeOwnerStatus, ownerTakeoverConfirmed,
  sessionPausePath, writeSessionPause, clearSessionPause, isSessionPaused,
  artifactRootConfigError, artifactRootChoiceNeeded, artifactRootChoiceMessage, artifactDirRuntimeHint, formatArtifactDirHint, appendArtifactDirHint, ensureProjectInfra,
  // 文件读写
  readActive, readFull, checkArchiveFormat, createTemplates, normalizeLineEndings, hasNonNullVerifiedDate, hasNonNullReviewedDate, detectUnmigratedV6Layout, MIGRATE_V7_SCRIPT,
  // 计划文件
  hasPlanFiles, listPlanFiles, hasUnsyncedPlanFiles, listUnsyncedPlanFiles, hasBridgeCandidatePlanFiles, listBridgeCandidatePlanFiles, syncPlanFile,
  // 统计与检查
  countByStatus, extractOpenKeys, normalizeFindingKey, detectLegacyImplFormat,
  normalizeFrontmatterStatus,
  parseFrontmatter, validateFrontmatterSchema, SCHEMA_V7_KEYS, detectNewerSchemaData, normalizeChangeId, detailPathForId, slugForChangeId, changeIdFromArtifactRel, validateWalkthroughLinks, parseChangeIndex, readChangeDetail, extractTaskSection,
  countDetailTasks, classifyChange, getActiveChangeEntries, isChangeApproved, isChangeVerified, isChangeReviewed, summarizeActiveChanges, findActiveIndexBelowArchive,
  // 外部集成
  scanRelatedNotes, getNativePlanPath, nativePlanMatchesProject, createLogger, defaultLogPath, logEntry, formatBridgeHint,
  // stdin 解析
  parseHookStdin, withStdinParsed, parseStdinSync,
};
