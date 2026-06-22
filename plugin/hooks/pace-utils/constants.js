const path = require('path');

const HOOKS_DIR = path.resolve(__dirname, '..');

const PACE_VERSION = 'v7.2.26';
// CHG-20260616-01 T-002：补无歧义主流语言扩展名——让写码门对这些语言用户也能启动（确定性门是兜底非
// 攻防完备：歧义项 .m/.r/.pl/.sql 故意不补，over-block 代价 > under-block，宁漏不误伤）。
// 注意双消费：除写码门(isCodeFile)外，本集合还供 countCodeFiles → detectSoftSignal/SOFT_WARN 软提示复用
// （isPaceProject 硬激活已不靠 code-count，补全只温和扩大软提示覆盖面，无硬门控副作用）。
const CODE_EXTS = [
  '.ts', '.js', '.py', '.go', '.rs', '.java', '.tsx', '.jsx', '.vue', '.svelte',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh',
  '.rb', '.php', '.cs', '.swift', '.kt', '.kts', '.scala', '.dart', '.lua',
  '.sh', '.bash', '.zsh', '.ex', '.exs', '.clj', '.cljs', '.cljc', '.hs', '.erl', '.jl', '.mm',
];
// v7（CHG-20260611-08）：implementation_plan.md 退役出 artifact 集合——task.md 是唯一 CHG 索引。
const ARTIFACT_FILES = ['spec.md', 'task.md', 'walkthrough.md', 'findings.md', 'corrections.md'];
// 写保护集合（pre-tool-use / bash-guard / powershell-guard 共用）：impl_plan 虽退役出
// ARTIFACT_FILES，但 tombstone 与未迁移存量仍受「主 session/Bash 不得直写」保护，故显式保留。
const PROTECTED_ARTIFACTS = [...ARTIFACT_FILES.filter(f => f !== 'spec.md'), 'implementation_plan.md'];
// 应保持 <!-- ARCHIVE --> 双区结构的文件（spec.md 无活跃/归档之分，排除）。
// checkArchiveFormat 缺失检测（层1）与 session-start 注入兜底（层2）共用此集合。
const ARCHIVE_REQUIRED_FILES = ARTIFACT_FILES.filter(file => file !== 'spec.md');
// 层2：应有 ARCHIVE 的文件缺标记且全文超此【字节】数时，session-start 按 UTF-8 字节截断注入兜底，防全文灌爆 context。
// ARCH-01：单位是字节（非字符）——全局 SESSION_OUTPUT_BUDGET_BYTES(46000) 字节守卫先于注入安装；层2 若按字符截断，
// CJK（~3 字节/字符）会让截断内容远超字节预算、缺失警告 footer 被守卫抢先截断而不可达。取 20000 < 46000 留足余量。
const ARCHIVE_MISSING_INJECT_LIMIT = Math.max(2000, Number(process.env.PACE_ARCHIVE_MISSING_INJECT_LIMIT) || 20000);
const VAULT_PATH = process.env.PACE_VAULT_PATH || '';
const ARTIFACT_ROOT_CHOICE_FILE = 'artifact-root';
const PROJECT_ROOT_FILE = 'project-root';
const ARTIFACT_WRITER_LOCK_FILE = 'artifact-writer.lock';
const ARTIFACT_WRITER_LOCK_TTL_MS = Number(process.env.PACE_ARTIFACT_LOCK_TTL_MS || 30 * 60 * 1000);
const ARTIFACT_RESOURCE_LOCK_TTL_MS = Math.max(1000, Number(process.env.PACE_ARTIFACT_RESOURCE_LOCK_TTL_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
const ARTIFACT_RESOURCE_LOCK_WAIT_MS = Math.max(0, Number(process.env.PACE_ARTIFACT_RESOURCE_LOCK_WAIT_MS || 2500) || 2500);
const ARTIFACT_SEQUENCE_LOCK_TTL_MS = Math.max(1000, Number(process.env.PACE_ARTIFACT_SEQUENCE_LOCK_TTL_MS || 30 * 1000) || 30 * 1000);
const ARTIFACT_SEQUENCE_LOCK_WAIT_MS = Math.max(0, Number(process.env.PACE_ARTIFACT_SEQUENCE_LOCK_WAIT_MS || 2500) || 2500);
const PLAN_SYNC_LOCK_TTL_MS = ARTIFACT_SEQUENCE_LOCK_TTL_MS;
const PLAN_SYNC_LOCK_WAIT_MS = ARTIFACT_SEQUENCE_LOCK_WAIT_MS;
const CHANGE_OWNER_TTL_MS = Math.max(60 * 1000, Number(process.env.PACE_CHANGE_OWNER_TTL_MS || 30 * 60 * 1000) || 30 * 60 * 1000);
// session 级 pause 标志 TTL（CHG-20260611-03）：防 crash 残留永久免门；正常失效靠
// /paceflow:resume 或 SessionEnd 删除，TTL 仅兜底。
const SESSION_PAUSE_TTL_MS = Math.max(60 * 1000, Number(process.env.PACE_SESSION_PAUSE_TTL_MS || 24 * 60 * 60 * 1000) || 24 * 60 * 60 * 1000);
const ARTIFACT_ROOT_CHOICE_MAX_CHARS = 4096;
const RESERVE_ARTIFACT_ID_SCRIPT = path.resolve(HOOKS_DIR, 'reserve-artifact-id.js').replace(/\\/g, '/');
const SYNC_PLAN_SCRIPT = path.resolve(HOOKS_DIR, 'sync-plan.js').replace(/\\/g, '/');
const SET_ARTIFACT_ROOT_SCRIPT = path.resolve(HOOKS_DIR, 'set-artifact-root.js').replace(/\\/g, '/');
const SET_PROJECT_ROOT_SCRIPT = path.resolve(HOOKS_DIR, 'set-project-root.js').replace(/\\/g, '/');
const MIGRATE_V7_SCRIPT = path.resolve(HOOKS_DIR, '..', 'migrate', 'migrate-v7.js').replace(/\\/g, '/');
const PACE_ARTIFACT_ROOT_CONTENT = 'spec.md / task.md / walkthrough.md / findings.md / corrections.md / changes/**';

const ARCHIVE_MARKER = '<!-- ARCHIVE -->';
// CA-1（v7.2.21 审计）：容忍标记行尾随空格，与 change-analysis.js findActiveIndexBelowArchive 的 [ \t]*$ 对齐——
// 否则尾随空格时 readActive 匹配不到 → 退回全文 → 归档区 [x]/[-] 行被当活跃 entry 冒泡回活跃集。
const ARCHIVE_PATTERN = /^<!-- ARCHIVE -->[ \t]*\r?$/m;

const SKILL_DIRS = [
  'pace-workflow',
  'artifact-management',
  'pace-knowledge',
  'pace-bridge',
];

const FORMAT_SNIPPETS = {
  taskEntry: '- [ ] [[chg-YYYYMMDD-NN-<slug>|chg-YYYYMMDD-NN]] 变更标题 #change [tasks:: T-001~T-003] [worktree:: main] [branch:: main]（wikilink 用详情文件名全名 + |纯ID 别名；旧无 slug 文件用 [[chg-YYYYMMDD-NN]]）',
  taskGroup: '任务详情不写入 task.md。请派 artifact-writer create-chg 创建 changes/chg-YYYYMMDD-NN-<slug>.md，并同步 task.md 索引。',
  approved: '<!-- APPROVED --> 位于 changes/<id>.md 的任务清单之后；approve/approve-and-start 都必须带 approval-confirmed、approval-source、approval-evidence',
  verified: '<!-- VERIFIED --> 紧邻 changes/<id>.md 内 <!-- APPROVED --> 下一行；主路径是验证结果已读取后 close-chg，暂不归档时才用 update-chg action=verify',
  reviewed: '<!-- REVIEWED --> 紧邻 changes/<id>.md 内 <!-- VERIFIED --> 下一行；R 阶段对抗审计跑过后由 close-chg 折叠写入（含 review-confirmed/review-source/review-findings），暂不归档时才用 update-chg action=review',
  statusHelp: '[ ] 未开始 | [/] 进行中 | [x] 完成 | [!] 暂停/阻塞 | [-] 跳过',
  changeStatusHelp: '[ ] 规划中 | [/] 进行中 | [x] 完成 | [-] 废弃 | [!] 暂停/阻塞',
  formatRule: 'hook 检测格式为行首 "- [/] "（Markdown checkbox），表格或 emoji 格式无法识别',
  approveAndStartOp: '批准并开始 = 派 artifact-writer approve-and-start；字段格式见 Skill(paceflow:artifact-management)',
  closeOp: '收尾 = 先运行并读取验证结果，再编排对抗审计并路由 findings；通过后派 artifact-writer close-chg（含 verification-confirmed + review-confirmed/review-source/review-findings）；字段格式见 Skill(paceflow:artifact-management)',
  reserveHelper: (cwd) => `预留编号 = 主 session 先运行 Bash: node "${RESERVE_ARTIFACT_ID_SCRIPT}" --operation create-chg${cwd ? ` --cwd "${String(cwd).replace(/\\/g, '/')}"` : ''}，并把输出原样放到 artifact-writer prompt 顶部`,
  syncPlanHelper: `同步 plan = 桥接成功后运行 Bash: node "${SYNC_PLAN_SCRIPT}" --plan "<已桥接 plan 绝对路径>"`,
  setArtifactRootHelper: `选择 artifact root = 用户选择后运行 Bash: node "${SET_ARTIFACT_ROOT_SCRIPT}" --choice local 或 --choice vault`,
  setProjectRootHelper: `声明独立 Project Root = 在子目录 cwd 运行 Bash: node "${SET_PROJECT_ROOT_SCRIPT}" --mode independent`,
  archiveOp: '归档 = 派 artifact-writer archive-chg：详情 status→archived，task.md 的索引行移动到 ARCHIVE 下方',
  walkthroughDetail: '| YYYY-MM-DD | [[chg-YYYYMMDD-NN-<slug>\\|chg-YYYYMMDD-NN]] 完成摘要 [worktree:: main] [branch:: main] | CHG-YYYYMMDD-NN |（表格内 wikilink 别名分隔符必须写 \\| 转义，否则裸 | 会切坏表格列）',
  skillRef: '流程参考：先调用 Skill(paceflow:pace-workflow)；artifact/CHG 字段格式参考 Skill(paceflow:artifact-management)',
};

const SESSION_SCOPED_FLAGS = [
  'degraded',
  'task-list-used',
  'todowrite-used',
  'archive-reminded',
  'findings-reminded',
  'cli-refresh-done',
  'walkthrough-archive-reminded',
  'findings-archive-reminded',
  'v7-migrate-reminded',
  'v5-layout-noticed',
];

const SESSION_SCOPED_FLAG_PREFIXES = [
  'archive-reminded-',
  'status-mismatch-',
  'verify-missing-',
  'review-missing-',
  'blocked-tasks-',
  'post-continue-',
];

// plan-sync 桥接检测目录（hasPlanFiles/listPlanFiles）。
const PLAN_DIRS = ['docs/plans', 'docs/superpowers/plans'];

module.exports = {
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
};
