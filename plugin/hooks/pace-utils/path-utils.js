const fs = require('fs');
const path = require('path');
const {
  ARTIFACT_FILES,
  ARTIFACT_ROOT_CHOICE_FILE,
  PROJECT_ROOT_FILE,
  VAULT_PATH,
  ARTIFACT_ROOT_CHOICE_MAX_CHARS,
} = require('./constants');
// v5/v6 检测原语下沉单一 detection 模块（CHG-20260614-11），与门面共享同一份消除双实现漂移
const { hasChangesDir, legacyV5FilesInDir } = require('./detection');

function resolveProjectCwd() {
  return process.env.CLAUDE_PROJECT_DIR
    ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
    : process.cwd();
}

// 时间戳/日期跟随宿主系统时区（CHG-20260619-07 T-002）：原硬编码 timeZone:'Asia/Shanghai' 去除——
//   aging 比较两侧都经 todayISO 同源，去硬编码后仍自洽；marketplace 非中国用户由此得到本地日历日，
//   宿主即 Asia/Shanghai 时行为不变。
function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function todayISO() {
  return new Date().toLocaleDateString('sv-SE');
}

function isoDateDayNumber(value) {
  const m = String(value || '').trim().replace(/^["']|["']$/g, '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

function daysSinceISODate(value, todayValue = todayISO()) {
  const start = isoDateDayNumber(value);
  const end = isoDateDayNumber(todayValue);
  if (start === null || end === null) return null;
  return end - start;
}

const isWin = process.platform === 'win32';

function normalizePath(p) {
  const n = p.replace(/\\/g, '/');
  return isWin ? n.toLowerCase() : n;
}

function displayDir(dir) {
  return String(dir || '').replace(/\\/g, '/').replace(/\/?$/, '/');
}

function isPortableAbsolutePath(p) {
  const normalized = String(p || '').replace(/\\/g, '/');
  return path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized);
}

function resolveToolFilePath(cwd, filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return '';
  // 绝对路径用 path.posix.normalize 折叠 `.`/`..`：纯字符串折叠不依赖 cwd，
  // 正确保留 `C:/` 盘符（path.resolve 在非 win32 上会把 `C:/...` 当相对路径破坏）。
  // 不折叠会让 `<proj>/./changes/x.md` 绕过 artifact 写保护并伪造批准标志（PU-001）。
  if (isPortableAbsolutePath(normalized)) return path.posix.normalize(normalized);
  return path.resolve(cwd || process.cwd(), normalized).replace(/\\/g, '/');
}

function isArtifactRelativePath(relPath) {
  // 先折叠 `.`/`..` 再剥前导斜杠：纵深防御 PU-001，防止 `./changes/x.md`、
  // `changes/./x.md` 等形态绕过下方锚定正则。
  const rel = path.posix.normalize(String(relPath || '').replace(/\\/g, '/')).replace(/^\/+/, '');
  if (ARTIFACT_FILES.includes(rel)) return true;
  // v7（CHG-20260611-08）：impl_plan 退役出 ARTIFACT_FILES 但仍是 PACEflow 管辖路径——
  // tombstone 与未迁移存量必须继续被识别（否则 Edit/MultiEdit/Bash 直写保护被旁路）。
  if (rel === 'implementation_plan.md') return true;
  return /^changes\/.+\.md$/i.test(rel);
}

function artifactRelativePathForFile(baseDir, filePath) {
  if (!baseDir || !filePath) return null;
  const absFile = resolveToolFilePath(baseDir, filePath);
  const normalizedBase = normalizePath(path.resolve(baseDir));
  const normalizedFile = normalizePath(absFile);
  const baseWithSlash = normalizedBase.endsWith('/') ? normalizedBase : normalizedBase + '/';
  if (!normalizedFile.startsWith(baseWithSlash)) return null;
  const rel = normalizedFile.slice(baseWithSlash.length);
  return isArtifactRelativePath(rel) ? rel : null;
}

function sanitizeProjectName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeRuntimeChoice(value) {
  let raw = String(value || '').slice(0, ARTIFACT_ROOT_CHOICE_MAX_CHARS).trim();
  if (!raw) return '';
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function readRuntimeFile(dir, file) {
  try {
    return normalizeRuntimeChoice(fs.readFileSync(path.join(dir, '.pace', file), 'utf8'));
  } catch(e) {
    return '';
  }
}

function hasDisabledMarker(dir) {
  try { return fs.existsSync(path.join(dir, '.pace', 'disabled')); } catch(e) { return false; }
}

function hasArtifactRootChoiceFile(dir) {
  try { return fs.existsSync(path.join(dir, '.pace', ARTIFACT_ROOT_CHOICE_FILE)); } catch(e) { return false; }
}

function hasManualMarker(dir) {
  try { return fs.existsSync(path.join(dir, '.pace-enabled')); } catch(e) { return false; }
}

function worktreeBaseDir(cwd) {
  const resolved = path.resolve(cwd || '');
  const parts = resolved.split(path.sep);
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i] !== '.claude' || parts[i + 1] !== 'worktrees') continue;
    const baseParts = parts.slice(0, i);
    if (baseParts.length === 0) return null;
    return baseParts.join(path.sep) || path.sep;
  }
  return null;
}

function claudeWorktreeCheckoutDir(cwd) {
  const resolved = path.resolve(cwd || '');
  const parts = resolved.split(path.sep);
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i] !== '.claude' || parts[i + 1] !== 'worktrees' || !parts[i + 2]) continue;
    return parts.slice(0, i + 3).join(path.sep) || path.sep;
  }
  return null;
}

function addProjectCandidate(candidates, name) {
  const normalized = sanitizeProjectName(name);
  if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function gitWorktreeMainCheckoutDir(gitDir) {
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const idx = String(gitDir || '').indexOf(marker);
  if (idx < 0) return null;
  const mainGitDir = String(gitDir).slice(0, idx + `${path.sep}.git`.length);
  return path.dirname(mainGitDir);
}

function rawProjectNameCandidates(cwd, { includeEnv = true } = {}) {
  const candidates = [];
  const safeCwd = cwd || '';
  if (includeEnv) {
    addProjectCandidate(candidates, process.env.PACE_PROJECT_NAME);
    addProjectCandidate(candidates, process.env.PACEFLOW_PROJECT_NAME);
  }

  const wtBase = worktreeBaseDir(safeCwd);
  if (wtBase) addProjectCandidate(candidates, path.basename(wtBase));

  try {
    const gitFile = path.join(safeCwd, '.git');
    if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
      const content = fs.readFileSync(gitFile, 'utf8');
      const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
      if (match) {
        const gitDir = path.resolve(safeCwd, match[1].trim());
        const hostDir = gitWorktreeMainCheckoutDir(gitDir);
        if (hostDir) addProjectCandidate(candidates, path.basename(hostDir));
      }
    }
  } catch(e) {}

  addProjectCandidate(candidates, path.basename(safeCwd));
  return candidates.length > 0 ? candidates : ['unknown-project'];
}

function getProjectNameCandidates(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  const root = resolveEffectiveProjectRoot(resolved).projectRoot;
  const candidates = rawProjectNameCandidates(root);
  const wtHost = worktreeBaseDir(resolved) || gitWorktreeHostDir(resolved);
  if (wtHost && normalizePath(root) !== normalizePath(resolved)) {
    addProjectCandidate(candidates, path.basename(worktreeCheckoutDir(resolved) || resolved));
  }
  return candidates;
}

function getProjectName(cwd) {
  if (!cwd || cwd === '.' || cwd === '/' || cwd === '\\') return 'unknown-project';
  if (/^[A-Z]:\\\\?$/i.test(cwd)) return 'unknown-project';
  return getProjectNameCandidates(cwd)[0] || 'unknown-project';
}

function gitWorktreeInfo(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  while (dir) {
    try {
      const gitFile = path.join(dir, '.git');
      if (fs.existsSync(gitFile)) {
        if (fs.statSync(gitFile).isFile()) {
          const content = fs.readFileSync(gitFile, 'utf8');
          const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
          if (match) {
            const gitDir = path.resolve(dir, match[1].trim());
            const hostDir = gitWorktreeMainCheckoutDir(gitDir);
            if (hostDir) return { hostDir, checkoutDir: dir };
          }
        }
      }
    } catch(e) {
      // A nested or unreadable .git marker is not enough to rule out an outer
      // real worktree checkout; keep scanning ancestors.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function gitWorktreeHostDir(cwd) {
  const info = gitWorktreeInfo(cwd);
  return info ? info.hostDir : null;
}

function worktreeCheckoutDir(cwd) {
  const gitInfo = gitWorktreeInfo(cwd);
  return claudeWorktreeCheckoutDir(cwd) || (gitInfo ? gitInfo.checkoutDir : null);
}

function hasGitRootMarker(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch(e) { return false; }
}

function artifactDirFromChoiceForRoot(root, choice) {
  const raw = normalizeRuntimeChoice(choice);
  if (!raw) return null;
  const keyword = raw.toLowerCase();
  if (keyword === 'local') return root;
  if (keyword === 'vault') {
    if (!VAULT_PATH) return null;
    return path.join(VAULT_PATH, 'projects', rawProjectNameCandidates(root)[0]);
  }
  if (isPortableAbsolutePath(raw)) return path.resolve(raw);
  return path.resolve(root, raw);
}

function configuredRootHasArtifacts(dir) {
  const choice = readRuntimeFile(dir, ARTIFACT_ROOT_CHOICE_FILE);
  const configured = artifactDirFromChoiceForRoot(dir, choice);
  return !!configured && hasChangesDir(configured);
}

function hasV6ArtifactRoot(dir, { includeEnv = true } = {}) {
  if (hasChangesDir(dir)) return true;
  if (configuredRootHasArtifacts(dir)) return true;
  if (VAULT_PATH) {
    for (const projectName of rawProjectNameCandidates(dir, { includeEnv })) {
      if (hasChangesDir(path.join(VAULT_PATH, 'projects', projectName))) return true;
    }
  }
  return false;
}

function hasLegacyV5Root(dir, { includeEnv = true } = {}) {
  if (legacyV5FilesInDir(dir).length > 0) return true;
  if (!VAULT_PATH) return false;
  for (const projectName of rawProjectNameCandidates(dir, { includeEnv })) {
    if (legacyV5FilesInDir(path.join(VAULT_PATH, 'projects', projectName)).length > 0) return true;
  }
  return false;
}

function projectRootMarkerMode(dir) {
  const marker = readRuntimeFile(dir, PROJECT_ROOT_FILE).toLowerCase();
  return marker === 'independent' ? 'independent' : '';
}

function explicitProjectRootReason(dir, options = {}) {
  if (!dir || hasDisabledMarker(dir)) return '';
  try {
    if (!fs.existsSync(dir)) return '';
  } catch(e) {
    return '';
  }
  if (projectRootMarkerMode(dir)) return 'project-root';
  if (hasManualMarker(dir)) return 'manual-marker';
  if (hasArtifactRootChoiceFile(dir)) return 'artifact-root-choice';
  const includeEnv = options.includeEnv !== false;
  if (hasV6ArtifactRoot(dir, { includeEnv })) return 'artifact';
  if (hasLegacyV5Root(dir, { includeEnv })) return 'legacy';
  return '';
}

function resolveEffectiveProjectRoot(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  if (hasDisabledMarker(resolved)) {
    return {
      projectRoot: resolved,
      runtimeRoot: path.join(resolved, '.pace'),
      mode: 'disabled',
      reason: 'cwd-disabled',
      cwd: resolved,
      inheritedFrom: '',
      inherited: false,
    };
  }

  const wtBase = worktreeBaseDir(resolved);
  const gitHost = gitWorktreeHostDir(resolved);
  const wtHost = wtBase || gitHost;
  if (wtHost) {
    return {
      projectRoot: wtHost,
      runtimeRoot: path.join(wtHost, '.pace'),
      mode: 'worktree',
      reason: wtBase ? 'claude-worktree' : 'git-worktree',
      cwd: resolved,
      inheritedFrom: '',
      inherited: true,
    };
  }

  // Env project-name overrides choose a vault project for the eventual root;
  // they are not enough to claim every scanned child/ancestor as that root.
  const currentReason = explicitProjectRootReason(resolved, { current: true, includeEnv: false });
  if (currentReason) {
    return {
      projectRoot: resolved,
      runtimeRoot: path.join(resolved, '.pace'),
      mode: currentReason === 'project-root' ? 'independent' : 'current',
      reason: currentReason,
      cwd: resolved,
      inheritedFrom: '',
      inherited: false,
    };
  }

  let envAliasGitRoot = hasGitRootMarker(resolved) ? resolved : '';
  let parent = path.dirname(resolved);
  while (parent && parent !== resolved) {
    if (hasDisabledMarker(parent)) {
      return {
        projectRoot: parent,
        runtimeRoot: path.join(parent, '.pace'),
        mode: 'disabled',
        reason: 'ancestor-disabled',
        cwd: resolved,
        inheritedFrom: '',
        inherited: true,
      };
    }
    if (hasGitRootMarker(parent)) envAliasGitRoot = parent;
    const reason = explicitProjectRootReason(parent, { includeEnv: false });
    if (reason) {
      return {
        projectRoot: parent,
        runtimeRoot: path.join(parent, '.pace'),
        mode: 'inherited',
        reason,
        cwd: resolved,
        inheritedFrom: parent,
        inherited: true,
      };
    }
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }

  // PACE_PROJECT_NAME may recover a vault alias for an unmarked git project,
  // but nested git repos still inherit the outer project unless explicitly
  // declared independent. After strong roots fail, anchor that alias at the
  // outermost git root seen on the current path, not every inner git ancestor.
  if (envAliasGitRoot) {
    const envGitReason = explicitProjectRootReason(envAliasGitRoot, { current: envAliasGitRoot === resolved });
    if (envGitReason) {
      return {
        projectRoot: envAliasGitRoot,
        runtimeRoot: path.join(envAliasGitRoot, '.pace'),
        mode: envAliasGitRoot === resolved && envGitReason === 'project-root' ? 'independent'
          : envAliasGitRoot === resolved ? 'current' : 'inherited',
        reason: envGitReason,
        cwd: resolved,
        inheritedFrom: envAliasGitRoot === resolved ? '' : envAliasGitRoot,
        inherited: envAliasGitRoot !== resolved,
      };
    }
  }

  const envCurrentReason = explicitProjectRootReason(resolved, { current: true });
  if (envCurrentReason) {
    return {
      projectRoot: resolved,
      runtimeRoot: path.join(resolved, '.pace'),
      mode: envCurrentReason === 'project-root' ? 'independent' : 'current',
      reason: envCurrentReason,
      cwd: resolved,
      inheritedFrom: '',
      inherited: false,
    };
  }

  return {
    projectRoot: resolved,
    runtimeRoot: path.join(resolved, '.pace'),
    mode: 'current',
    reason: 'cwd',
    cwd: resolved,
    inheritedFrom: '',
    inherited: false,
  };
}

function getProjectStateDir(cwd) {
  return resolveEffectiveProjectRoot(cwd).projectRoot;
}

function getProjectRuntimeDir(cwd) {
  return resolveEffectiveProjectRoot(cwd).runtimeRoot;
}

function gitBranchName(cwd) {
  try {
    const { execFileSync } = require('child_process');
    return String(execFileSync('git', ['-C', cwd || process.cwd(), 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    })).trim();
  } catch(e) {
    return '';
  }
}

// HOTFIX-20260815-01(codex P2-2):进程内 per-cwd memo——changeOwnerStatus 每 owner 各调一次
// 本函数(内含 git rev-parse fork,timeout 1s),UserPromptSubmit 等每轮 hook 在多 owner 场景
// 延迟按 N 线性放大(实测 4 owner ≈ N×Git latency)。hook 进程生命周期短(单次调用),进程内
// memo 无 mid-session checkout 失效风险;返回浅拷贝防 caller 突变污染缓存。
const _execCtxMemo = new Map();

function executionContextForCwd(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  const cached = _execCtxMemo.get(resolved);
  if (cached) return { ...cached };
  const rootInfo = resolveEffectiveProjectRoot(resolved);
  const stateDir = rootInfo.projectRoot;
  const wtHost = worktreeBaseDir(resolved) || gitWorktreeHostDir(resolved);
  const wtCheckout = worktreeCheckoutDir(resolved);
  const isWorktree = !!wtHost && normalizePath(stateDir) !== normalizePath(resolved);
  const worktree = isWorktree ? path.basename(wtCheckout || resolved) : 'main';
  const branch = gitBranchName(resolved) || worktree || 'unknown';
  const built = {
    worktree,
    branch,
    cwd: resolved,
    stateDir,
    checkoutDir: wtCheckout || resolved,
    isWorktree,
    projectRoot: stateDir,
    projectRootMode: rootInfo.mode,
    projectRootReason: rootInfo.reason,
    inheritedProjectRoot: !!rootInfo.inherited && !isWorktree,
    text: `[worktree:: ${worktree}] [branch:: ${branch}]`,
  };
  _execCtxMemo.set(resolved, built);
  return { ...built };
}

module.exports = {
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
};
