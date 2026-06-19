// Artifact-writer Agent prompt/lifecycle helpers for PreToolUse.
const fs = require('fs');
const paceUtils = require('../pace-utils');

const {
  displayDir,
  normalizeArtifactRootChoice,
  FORMAT_SNIPPETS,
  RESERVE_ARTIFACT_ID_SCRIPT,
} = paceUtils;

// V7G T-002：artifact-writer 受支持的 8 类 operation 白名单（白名单外即 out-of-scope，hard-deny）。
const KNOWN_OPERATIONS = new Set([
  'create-chg', 'update-chg', 'close-chg', 'archive-chg',
  'record-finding', 'record-correction', 'update-finding', 'update-index',
]);

// V7G T-001：从 artDir 直接读 CHG 详情用于 V/R 偏序门（artDir 已在 guard 上下文，免再传 cwd）。
// 读不到 / 路径异常返回 null → 调用方按 fail-open 不加新 deny，不误伤路径异常的合法操作。
function readDetailFromArtDir(artDir, id) {
  if (!artDir || !id) return null;
  const fp = paceUtils.detailPathForId(artDir, id);
  if (!fp) return null;
  try {
    const content = fs.readFileSync(fp, 'utf8');
    return { path: fp, content, frontmatter: paceUtils.parseFrontmatter(content) };
  } catch (e) {
    return null;
  }
}

function isArtifactWriterAgentTool(stdin) {
  return paceUtils.isArtifactWriterAgentType(stdin.toolInput.subagent_type || stdin.toolInput.subagentType);
}

function normalizeArtifactDirValue(value) {
  const raw = normalizeArtifactRootChoice(value);
  if (!raw) return '';
  return paceUtils.normalizePath(raw.replace(/\\/g, '/')).replace(/\/+$/, '');
}

function extractPromptArtifactDir(prompt) {
  const match = String(prompt || '').match(/^\s*artifact_dir\s*[:=]\s*(.+?)\s*$/mi);
  return match ? normalizeArtifactDirValue(match[1]) : '';
}

function promptHasExactArtifactDir(prompt, dir) {
  const declared = extractPromptArtifactDir(prompt);
  return declared && declared === normalizeArtifactDirValue(dir);
}

function artifactDirField(artDir) {
  return artDir ? `artifact_dir: ${displayDir(artDir)}` : 'artifact_dir: <hook 解析出的 artifact 目录>';
}

// Keep these recovery templates aligned with plugin/agents/artifact-writer.md and
// artifact-management skill examples when adding or changing an operation.
function promptTemplateForOperation({ prompt = '', artDir = '', operation = '', action = '', target = '' } = {}) {
  const op = String(operation || promptDeclaredOperation(prompt) || '').toLowerCase();
  const act = String(action || promptDeclaredAction(prompt) || '').toLowerCase();
  const id = target || paceUtils.explicitChangeTargetFromAgentPrompt(prompt) || 'CHG-YYYYMMDD-NN';
  const lines = [artifactDirField(artDir)];

  if (op === 'create-chg-batch') {
    return [
      ...lines,
      'operation: create-chg',
      'change-set: <变更集名>',
      'change-set-total: <N，必须等于下面 CHG 块数>',
      '--- CHG 1/N ---',
      'reserved-id: <reserve --count N 输出的第 1 个>',
      'title: <第 1 个 CHG 标题（可闭环单元）>',
      'tasks:',
      '  - T-001: <任务标题与验收>',
      '--- CHG 2/N ---',
      'reserved-id: <第 2 个 reserved-id>',
      'title: <第 2 个 CHG 标题>',
      'tasks:',
      '  - T-001: <任务标题与验收>',
      '（每块一个 reserved-id，重复到第 N 块；先运行 reserve --operation create-chg --count N 取 N 个连号）',
    ].join('\n');
  }

  if (op === 'create-chg') {
    return [
      ...lines,
      'operation: create-chg',
      'execution-context: <helper 输出>',
      'reserved-id: <helper 输出或 hook deny 输出>',
      'reserved-file-prefix: <helper 输出或 hook deny 输出（含 <slug>.md 占位，原样保留不替换）>',
      'title: <变更标题>',
      'tasks:',
      '  - T-001: <任务标题与验收>',
      'background: <Why>',
      'scope: <What>',
      'technical-decision: <How>',
    ].join('\n');
  }

  if (op === 'update-chg' && act === 'approve') {
    return [
      ...lines,
      'operation: update-chg',
      `target: ${id}`,
      'action: approve',
      'approval-confirmed: true',
      'approval-source: user-directive | ask-user-question | accepted-plan | prior-approved-plan',
      'approval-evidence: <用户原话或已确认方案摘要>',
    ].join('\n');
  }

  if (op === 'update-chg' && act === 'approve-and-start') {
    return [
      ...lines,
      'operation: update-chg',
      `target: ${id}`,
      'action: approve-and-start',
      'task-id: T-NNN',
      'approval-confirmed: true',
      'approval-source: user-directive | ask-user-question | accepted-plan | prior-approved-plan',
      'approval-evidence: <用户原话或已确认方案摘要>',
    ].join('\n');
  }

  if (op === 'update-chg' && act === 'update-status') {
    return [
      ...lines,
      'operation: update-chg',
      `target: ${id}`,
      'section: tasks',
      'action: update-status',
      'task-id: T-NNN',
      'new-status: [/] | [!] | [x] | [-]',
      'status-reason: <new-status=[!] 时必填；其他状态按需说明>',
    ].join('\n');
  }

  if (op === 'update-chg' && act === 'verify') {
    return [
      ...lines,
      'operation: update-chg',
      `target: ${id}`,
      'action: verify',
      'verify-summary: <已运行并读取的验证结果>',
    ].join('\n');
  }

  if (op === 'update-chg' && act === 'review') {
    return [
      ...lines,
      'operation: update-chg',
      `target: ${id}`,
      'action: review',
      'review-confirmed: true',
      'review-source: manual | <所选 review agent 名>',
      "review-findings: <P0/P1/P2/P3 计数 + 各自处置（HOTFIX/won't-fix finding/record-finding 的 wikilink）>",
    ].join('\n');
  }

  if (op === 'close-chg') {
    return [
      ...lines,
      'operation: close-chg',
      `target: ${id}`,
      'verification-confirmed: true',
      'complete-open-tasks: true',
      'review-confirmed: true',
      'review-source: manual | <所选 review agent 名>',
      "review-findings: <P0/P1/P2/P3 计数 + 各自处置（HOTFIX/won't-fix finding/record-finding 的 wikilink）>",
      'verify-summary: <已运行并读取的验证结果>',
      'implementation-notes:',
      '  - T-NNN: <该任务实际改动——改了哪些文件、关键实现、对应 commit>',
      'walkthrough-summary: <完成摘要>',
    ].join('\n');
  }

  if (op === 'archive-chg') {
    return [
      ...lines,
      'operation: archive-chg',
      `target: ${id}`,
      'walkthrough-summary: <完成摘要>',
    ].join('\n');
  }

  if (op === 'record-finding') {
    return [
      ...lines,
      'operation: record-finding',
      'title: <finding 标题>',
      'summary: <≤200 字摘要>',
      'type: research | observation | comparison | bug-report',
      'impact: P0 | P1 | P2 | P3',
      'body: <完整 Markdown 正文>',
    ].join('\n');
  }

  if (op === 'record-correction') {
    return [
      ...lines,
      'operation: record-correction',
      'reserved-id: <helper 输出>',
      'reserved-file-prefix: <helper 输出>',
      'trigger-quote: <用户纠正原话>',
      'wrong-behavior: <错误行为，至少 20 字符>',
      'correct-behavior: <正确行为，至少 20 字符>',
      'trigger-scenario: <触发场景>',
      'root-cause: <根因>',
      'knowledge-link: [[note]] 或 project-scope: project-only',
    ].join('\n');
  }

  if (op === 'update-finding') {
    return [
      ...lines,
      'operation: update-finding',
      'target: FINDING-YYYY-MM-DD-slug',
      'status: open | investigating | accepted | rejected | merged | blocked（可选）',
      'change-link: [[chg-yyyymmdd-nn]]（可选，标记 finding 已被该变更处置）',
      'append: <追加到详情正文末尾的 Markdown>（可选）',
    ].join('\n');
  }

  if (op === 'update-index') {
    return [
      ...lines,
      'operation: update-index',
      'target: findings.md | corrections.md',
      'action: reorder',
    ].join('\n');
  }

  return [
    ...lines,
    'operation: create-chg | update-chg | close-chg | archive-chg | record-finding | record-correction | update-finding | update-index',
    'target: CHG-YYYYMMDD-NN 或 HOTFIX-YYYYMMDD-NN（create-chg / record-finding / record-correction 除外；update-finding 的 target 是 FINDING-id）',
    'action: <operation=update-chg 时必填>',
  ].join('\n');
}

function agentArtifactDirDenyReason(artDir, declared = '', prompt = '') {
  const dir = displayDir(artDir);
  const declaredLine = declared ? `\n当前 prompt 中的 artifact_dir 是：${displayDir(declared)}` : '';
  // 缺啥列啥（CHG-20260615-03 T-001）：artifact_dir gate 是派遣门第一道串行早返，缺 artifact_dir 时
  //   到不了后面的 operation/lifecycle 校验层。若 operation 也没声明，在本条 deny 一并点名，免「修了
  //   artifact_dir 重派又撞 operation 缺失」第二次往返。operation 是后续必填字段的前提（它决定该带哪些）。
  const operationMissingLine = promptDeclaredOperation(prompt)
    ? ''
    : '\n另：当前 prompt 也未声明 operation: 行——请一并补上（operation 决定本次该带哪些必填字段，缺它无法校验后续字段）。';
  return [
    `派 paceflow:artifact-writer 时缺少或写错当前 artifact_dir。当前项目已启用 PaceFlow，hook 解析出的 artifact 目录是：${dir}${declaredLine}${operationMissingLine}`,
    FORMAT_SNIPPETS.skillRef,
    '请重派同一个 agent，并使用完整 prompt 顶部模板：',
    promptTemplateForOperation({ prompt, artDir }),
    `artifact_dir 仅用于 PaceFlow artifacts：${paceUtils.PACE_ARTIFACT_ROOT_CONTENT}。`,
    '不要让 artifact-writer 自行推断或改写 artifact_dir。'
  ].join('\n');
}

function promptHasTrueField(prompt, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\n\\s,，;；])${escaped}\\s*[:=]\\s*true\\b`, 'i').test(String(prompt || ''));
}

function promptHasNonEmptyField(prompt, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\n,，;；])\\s*${escaped}\\s*[:=]\\s*\\S+`, 'mi').test(String(prompt || ''));
}

function promptFieldValue(prompt, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(prompt || '').match(new RegExp(`(?:^|[\\n,，;；])\\s*${escaped}\\s*[:=]\\s*([^\\n,，;；]+)`, 'mi'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

// P3-1（CHG-20260615-06）：operation/action 等单行 lifecycle 字段取值——冒号后只吞同行空白
// （[^\S\n]，空白但非换行），不跨换行吞下一字段。刻意区别于 promptFieldValue 的 \s*（后者故意
// 跨换行，让 implementation-notes / verify-summary 等「field:\n  - 缩进列表」多行值仍判非空）。
// `operation:\ntitle: x` 应解析为 operation 空值，而非把下一行 title: 当成 operation 的值。
function promptFieldValueSameLine(prompt, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(prompt || '').match(new RegExp(`(?:^|[\\n,，;；])\\s*${escaped}\\s*[:=][^\\S\\n]*([^\\n,，;；]+)`, 'mi'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

function explicitReservationFromPrompt(prompt) {
  const id = promptFieldValue(prompt, 'reserved-id').toUpperCase();
  const fileRel = promptFieldValue(prompt, 'reserved-file').replace(/\\/g, '/');
  let filePrefix = promptFieldValue(prompt, 'reserved-file-prefix').replace(/\\/g, '/');
  filePrefix = filePrefix.replace(/<slug>\.md$/i, '').replace(/\*\.md$/i, '');
  return { id, fileRel, filePrefix };
}

// 块内字段取值：只取冒号同一行的非空内容，避免 promptFieldValue 的 \s* 跨行吞下一字段
//（否则空 `title:` 会把下一行 `tasks:` 误当 title，绕过 batch 块字段校验）。
function blockFieldValue(body, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(body || '').match(new RegExp(`^[ \\t]*${escaped}[ \\t]*[:=][ \\t]*(\\S.*)$`, 'mi'));
  return m ? m[1].trim() : '';
}

// 解析 batch create CHG 的 `--- CHG i/N ---` 分块；逐块取 reserved-id / title / 是否含 tasks。
// 无任何块标记时 isBatch=false（单 CHG / 普通 create-chg 走原路径）。
function parseBatchBlocks(prompt) {
  const text = String(prompt || '');
  const re = /^---[ \t]*CHG[ \t]+(\d+)\/(\d+)[ \t]*---[ \t]*$/gim;
  const markers = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    markers.push({ start: m.index, end: re.lastIndex, seq: Number(m[1]), markerTotal: Number(m[2]) });
  }
  const blocks = markers.map((mk, idx) => {
    const bodyEnd = idx + 1 < markers.length ? markers[idx + 1].start : text.length;
    const body = text.slice(mk.end, bodyEnd);
    return {
      seq: mk.seq,
      markerTotal: mk.markerTotal,
      reservedId: blockFieldValue(body, 'reserved-id').toUpperCase(),
      title: blockFieldValue(body, 'title'),
      hasTasks: /(?:^|\n)[ \t]*tasks[ \t]*[:=]/i.test(body) || /(?:^|\n)[ \t]*-[ \t]+T-\d/i.test(body),
    };
  });
  return { isBatch: markers.length > 0, blocks };
}

function relFromReservedId(id) {
  const m = String(id || '').match(/^(CHG|HOTFIX)-(\d{8})-(\d{2})$/i);
  if (!m) return '';
  return `changes/${m[1].toLowerCase()}-${m[2]}-${m[3]}.md`;
}

function reservationRelForLookup(explicit) {
  if (explicit.fileRel) return explicit.fileRel;
  const fromId = relFromReservedId(explicit.id);
  if (fromId) return fromId;
  if (explicit.filePrefix) return `${explicit.filePrefix}slug.md`;
  return '';
}

// @see pace-utils/locks.js reservationMatchesArtifactRel —— 两函数防守同一不变量（CHG/HOTFIX/
//   CORRECTION 编号必来自 hook 预留）的两半：本函数判 agent prompt 声明的 explicit 字段（id/fileRel），
//   reservationMatchesArtifactRel 判实际写入的目标文件 rel。两者 filePrefix 容错须同为 startsWith；
//   改一侧的容错策略须同步另一侧，避免「prompt 路径放行但写盘路径拦」类不对称回归。
function reservationMatchesExplicit(reservation, explicit) {
  if (!reservation) return false;
  if (explicit.id && reservation.id !== explicit.id) return false;
  if (explicit.fileRel && reservation.fileRel !== explicit.fileRel) return false;
  // filePrefix 前缀匹配（startsWith）作防御容错。设计正道：caller 原样保留 reserve 输出的
  //   `<slug>.md` 占位（line 242 去掉 → 前缀），slug 由 artifact-writer 按 title 生成（record-correction.md Step 4）。
  // 但 caller 若误把 <slug> 替换成具体值（如工作流指引未注入时凭直觉填），explicit 成完整文件名——
  //   startsWith 让它仍匹配预留前缀（agent 照样用自己生成的 slug 写文件，caller 的值被忽略，无害），
  //   避免把这种误填打成 deny（HOTFIX-20260609-01：=== 会因「完整名 ≠ 前缀」永不匹配）。
  // create-chg 用 fileRel（完整名）走上面 === 分支，不受影响。
  if (explicit.filePrefix && (!reservation.filePrefix || !String(explicit.filePrefix).startsWith(reservation.filePrefix))) return false;
  return true;
}

function artifactWriterCreateChgHint(artDir, cwd) {
  return [
    FORMAT_SNIPPETS.skillRef,
    FORMAT_SNIPPETS.reserveHelper(cwd),
    '派 artifact-writer create-chg 时，Agent prompt 顶部必须包含：',
    `artifact_dir: ${displayDir(artDir)}`,
    'operation: create-chg',
    'execution-context: <helper 输出>',
    'reserved-id: <helper 输出或 hook deny 输出>',
    'reserved-file-prefix: <helper 输出或 hook deny 输出>',
    'title: <变更标题>',
    'tasks:',
    '- T-001: <首个任务>',
    '若未先运行 helper，hook 会用 deny 文案返回 reserved-id / reserved-file-prefix 作为 fallback；收到后原样写入 prompt 重派。'
  ].join('\n');
}

function reservationRequiredReason(operation, artDir, reservation, cwd = process.cwd()) {
  const lines = [
    `PACEflow 已为 ${operation} 预留唯一编号。本次 Agent 已被阻止，请重派 artifact-writer 并带上以下字段：`,
    FORMAT_SNIPPETS.skillRef,
    operation === 'create-chg' ? FORMAT_SNIPPETS.reserveHelper(cwd) : `后续可先运行 Bash: node "${RESERVE_ARTIFACT_ID_SCRIPT}" --operation record-correction --cwd "${String(cwd).replace(/\\/g, '/')}" 预留 correction 编号。`,
    `artifact_dir: ${displayDir(artDir)}`,
    `operation: ${operation}`,
  ];
  if (reservation.id) lines.push(`reserved-id: ${reservation.id}`);
  if (reservation.fileRel) lines.push(`reserved-file: ${reservation.fileRel}`);
  if (reservation.filePrefix) lines.push(`reserved-file-prefix: ${reservation.filePrefix}<slug>.md`);
  if (operation === 'create-chg') lines.splice(5, 0, `execution-context: ${paceUtils.executionContextForCwd(cwd).text}`);
  lines.push('不要启动不带 reserved-id 的 create-chg / record-correction agent；不要让 agent 扫描索引自行分配编号。');
  return lines.join('\n');
}

function reservationExplicitMissingReason(operation, explicit, cwd) {
  return [
    `artifact-writer prompt 的预留字段未匹配到 hook reservation：${explicit.id || explicit.fileRel || explicit.filePrefix || 'reserved fields'}。可能原因：(1) reservation 已过期（超 TTL）或已被消费；(2) reserved-id / reserved-file(-prefix) 与预留值不符。`,
    FORMAT_SNIPPETS.skillRef,
    `排查：先核对 reserved-id 与最近一次 reserve 输出是否完全一致；reserved-file-prefix 应**原样保留** reserve 输出（含末尾 \`<slug>.md\` 占位——slug 由 artifact-writer 按 title 生成，caller 不要替换它）。只要前缀部分（到 \`<slug>\` 前）与预留一致即匹配。确认字段无误仍失败，再重新 reserve：Bash node "${RESERVE_ARTIFACT_ID_SCRIPT}" --operation ${operation} --cwd "${String(cwd).replace(/\\/g, '/')}"。`,
    '不要手写或复用旧 session 的 reserved-id。'
  ].join('\n');
}

function promptMentionsVerifyAction(prompt) {
  const text = String(prompt || '');
  // 只读结构化 verify action，不解析自由文本话术（CHG-20260619-03：删散文 blocklist 分支
  // 「执行 verify 操作 / verify 操作」——它扫 status-reason 等自由文本猜「update-status+verify 串联」
  // 意图，而单次派遣 action 已唯一确定、串联执行层不可达；对齐「门读结构化字段非话术」原则）。
  return /(?:^|[\s\n])action\s*[:=]\s*verify\b/i.test(text) ||
    /\bupdate-chg\s+action=verify\b/i.test(text);
}

// A05：promptFieldValue 捕获到行尾（不被空格终止），operation/action 行带尾随说明文字时
// 取首个空白分隔 token，使 `operation: close-chg 顺便归档` 仍解析为 close-chg，生命周期字段强制不失效。
function firstToken(value) {
  return String(value || '').trim().split(/\s+/)[0] || '';
}

function promptDeclaredOperation(prompt) {
  const value = firstToken(promptFieldValueSameLine(prompt, 'operation')) || firstToken(promptFieldValueSameLine(prompt, '指令')) || paceUtils.operationFromAgentPrompt(prompt);
  return value.toLowerCase();
}

function promptDeclaredAction(prompt) {
  const value = firstToken(promptFieldValueSameLine(prompt, 'action'));
  if (value) return value.toLowerCase();
  const text = String(prompt || '');
  const m = text.match(/(?:^|[\n,，;；])\s*(approve-and-start|update-status|approve)(?=$|[\s,，;；:：])/i);
  return m ? m[1].toLowerCase() : '';
}

function promptApproveContainsStartIntent(prompt) {
  const text = String(prompt || '');
  // 只读结构化 in-progress 状态意图，不解析自由文本话术（CHG-20260619-03：删散文 blocklist 分支
  // 「开始实施/开始执行/立即开始/...」——它扫整段（含 approval-evidence 用户原话），approve-only
  // 场景用户原话逐字含触发动词即误伤；对齐 CHG-20260616-04 删 COMPLETION_PHRASES 的「门读结构化字段非话术」原则）。
  return /(?:status|状态)[^\n]{0,24}(?:in-progress|进行中)/i.test(text) ||
    /(?:改为|设为|推到|进入)[^\n]{0,24}(?:in-progress|进行中)/i.test(text);
}

function normalizeTaskStatusValue(value) {
  const raw = String(value || '').trim().toLowerCase();
  const checkbox = raw.match(/^\[([ x\/!\-])\]$/);
  if (checkbox) return checkbox[1];
  if ([' ', '/', 'x', '!', '-'].includes(raw)) return raw;
  if (['pending', 'todo', 'open', '未开始'].includes(raw)) return ' ';
  if (['in-progress', 'running', 'active', '进行中'].includes(raw)) return '/';
  if (['done', 'completed', 'complete', '完成', '已完成'].includes(raw)) return 'x';
  if (['blocked', 'paused', 'pause', 'hold', '阻塞', '暂停'].includes(raw)) return '!';
  if (['skipped', 'skip', 'cancelled', 'canceled', '跳过', '取消'].includes(raw)) return '-';
  return '';
}

function promptUpdateStatusValue(prompt) {
  if (promptDeclaredAction(prompt) !== 'update-status') return '';
  return normalizeTaskStatusValue(promptFieldValue(prompt, 'new-status') || promptFieldValue(prompt, 'new_status'));
}

function promptHasPauseOrBlockReason(prompt) {
  return promptHasNonEmptyField(prompt, 'status-reason') ||
    promptHasNonEmptyField(prompt, 'block-reason') ||
    promptHasNonEmptyField(prompt, 'pause-reason');
}

function agentLifecyclePromptDenyReason(prompt, artDir = '') {
  const text = String(prompt || '');
  const operation = promptDeclaredOperation(text);
  const action = promptDeclaredAction(text);
  const mentionsApproveAndStart = operation === 'update-chg' && action === 'approve-and-start';
  const mentionsApproveOnly = operation === 'update-chg' && action === 'approve';
  const mentionsApprovalAction = mentionsApproveAndStart || mentionsApproveOnly;
  const mentionsCloseChg = operation === 'close-chg';
  const mentionsArchiveChg = operation === 'archive-chg';
  const mentionsUpdateStatus = operation === 'update-chg' && action === 'update-status';
  const mentionsVerifyOnly = operation === 'update-chg' && action === 'verify';
  const mentionsReviewOnly = operation === 'update-chg' && action === 'review';

  if (!operation) {
    return [
      '派 artifact-writer 时缺少明确 operation。',
      FORMAT_SNIPPETS.skillRef,
      '请重派同一个 agent，并使用完整 prompt 顶部模板：',
      promptTemplateForOperation({ prompt, artDir }),
      '执行 approve / approve-and-start / update-status / verify 时，operation 必须为 update-chg，并同时提供 action。'
    ].join('\n');
  }

  if (!KNOWN_OPERATIONS.has(operation)) {
    return [
      `派 artifact-writer 时 operation「${operation}」不在受支持的 8 类指令内。`,
      FORMAT_SNIPPETS.skillRef,
      '受支持的 operation：create-chg / update-chg / close-chg / archive-chg / record-finding / record-correction / update-finding / update-index。',
      '请用其中之一重派；artifact-writer 不执行白名单外的指令。',
    ].join('\n');
  }

  if (operation === 'create-chg') {
    const batch = parseBatchBlocks(text);
    const totalRaw = promptFieldValue(text, 'change-set-total');
    const declaredTotal = /^\d+$/.test(totalRaw) ? Number(totalRaw) : null;
    const looksBatch = batch.isBatch || (declaredTotal !== null && declaredTotal > 1);
    if (looksBatch) {
      const tpl = promptTemplateForOperation({ prompt, artDir, operation: 'create-chg-batch' });
      const deny = (msg) => [msg, FORMAT_SNIPPETS.skillRef, '请重派同一个 agent，使用 batch create 多块模板：', tpl].join('\n');
      if (!batch.isBatch) {
        return deny('batch create CHG（change-set-total>1）必须用 `--- CHG i/N ---` 分隔每个 CHG 块，但 prompt 未检测到任何块。');
      }
      if (!promptHasNonEmptyField(text, 'change-set')) {
        return deny('batch create CHG 缺少 change-set 字段（变更集名）。');
      }
      if (declaredTotal === null) {
        return deny('batch create CHG 缺少 change-set-total（应等于 batch 块数）。');
      }
      if (batch.blocks.length !== declaredTotal) {
        return deny(`batch create CHG 块数（${batch.blocks.length}）与 change-set-total（${declaredTotal}）不一致。`);
      }
      const errs = [];
      const seen = new Set();
      batch.blocks.forEach((b, idx) => {
        const where = `第 ${idx + 1} 块（--- CHG ${b.seq}/${b.markerTotal} ---）`;
        if (b.markerTotal !== declaredTotal) errs.push(`${where} 标记总数 ${b.markerTotal} 与 change-set-total ${declaredTotal} 不符`);
        if (b.seq !== idx + 1) errs.push(`${where} 序号应为 ${idx + 1}`);
        if (!b.reservedId) errs.push(`${where} 缺 reserved-id`);
        else if (seen.has(b.reservedId)) errs.push(`${where} reserved-id 与其他块重复：${b.reservedId}`);
        else seen.add(b.reservedId);
        if (!b.title) errs.push(`${where} 缺 title`);
        if (!b.hasTasks) errs.push(`${where} 缺 tasks`);
      });
      if (errs.length > 0) {
        return [`batch create CHG 块校验失败：`, ...errs.map(e => `- ${e}`), FORMAT_SNIPPETS.skillRef, '请重派同一个 agent，使用 batch create 多块模板：', tpl].join('\n');
      }
    }
    return '';
  }

  if (operation === 'update-chg' && !['append', 'replace', 'approve', 'approve-and-start', 'update-status', 'verify', 'review'].includes(action)) {
    return [
      `派 artifact-writer 执行 update-chg 时缺少或写错 action：${action || '(missing)'}。`,
      FORMAT_SNIPPETS.skillRef,
      'update-chg 的 action 只能是 append / replace / approve / approve-and-start / update-status / verify / review。',
      '请重派同一个 agent，并使用完整 prompt 顶部模板：',
      promptTemplateForOperation({ prompt, artDir, operation: 'update-chg', action: action || 'update-status' })
    ].join('\n');
  }

  if (mentionsApprovalAction) {
    const missing = [];
    if (!promptHasTrueField(text, 'approval-confirmed')) missing.push('approval-confirmed: true');
    if (!promptHasNonEmptyField(text, 'approval-source')) missing.push('approval-source');
    if (!promptHasNonEmptyField(text, 'approval-evidence')) missing.push('approval-evidence');
    if (mentionsApproveAndStart && !promptHasNonEmptyField(text, 'task-id')) missing.push('task-id');
    if (missing.length > 0) {
      return [
        `派 artifact-writer 执行 C 阶段批准时缺少必填字段：${missing.join(', ')}。`,
        FORMAT_SNIPPETS.skillRef,
        'C 阶段批准是确认边界：主 session 可以基于用户明确执行指令、已接受方案或 AskUserQuestion 设置 approval-confirmed: true，但必须写明确认来源与证据。',
        '请重派同一个 agent，并使用完整 prompt 顶部模板：',
        promptTemplateForOperation({ prompt, artDir, operation, action }),
        mentionsApproveAndStart ? '' : '若批准后立即开始，请改用 action=approve-and-start 并提供 task-id。'
      ].filter(Boolean).join('\n');
    }
  }

  if (mentionsApproveOnly && promptApproveContainsStartIntent(text)) {
    return [
      '不要用 action=approve 同时表达开始执行或 in-progress 状态。',
      FORMAT_SNIPPETS.skillRef,
      'action=approve 只插入 APPROVED，适用于“先批准但暂不执行”。',
      '若用户已明确批准并准备开始，请重派同一个 agent，并使用完整 prompt 顶部模板：',
      promptTemplateForOperation({ prompt, artDir, operation: 'update-chg', action: 'approve-and-start' })
    ].join('\n');
  }

  if (mentionsUpdateStatus && promptMentionsVerifyAction(text) && !mentionsCloseChg) {
    return [
      '不要把 update-status 与 update-chg action=verify 串在同一次 agent 派遣中。',
      FORMAT_SNIPPETS.skillRef,
      '验证是确认边界：主 session 必须先运行验证命令并读取结果，确认通过后才允许写 VERIFIED。',
      '如果同一 CHG 会继续连续执行：不要为中间任务单独派 update-status，继续完成剩余代码/测试。',
      '只有暂停、阻塞、跳过、跨 session 或长任务进度可见性需要时，才派 update-chg action=update-status。',
      '如果这是最后任务且验证已通过，请使用完整 close-chg 模板：',
      promptTemplateForOperation({ prompt, artDir, operation: 'close-chg' })
    ].join('\n');
  }

  if (mentionsUpdateStatus && promptUpdateStatusValue(text) === '!' && !promptHasPauseOrBlockReason(text)) {
    return [
      '派 artifact-writer 将任务标记为 [!] 暂停/阻塞时缺少原因字段。',
      FORMAT_SNIPPETS.skillRef,
      '[!] 表示当前 CHG 暂停或阻塞，不是完成，也不是让其他 worktree 自动接手的信号。',
      '请重派同一个 agent，并使用完整 prompt 顶部模板：',
      promptTemplateForOperation({ prompt, artDir, operation, action })
    ].join('\n');
  }

  if (mentionsVerifyOnly) {
    if (!promptHasNonEmptyField(text, 'verify-summary')) {
      return [
        '派 artifact-writer 执行 update-chg action=verify 时缺少必填字段：verify-summary。',
        FORMAT_SNIPPETS.skillRef,
        '验证是确认边界：主 session 必须先运行验证命令并读取结果，确认通过后才允许写 VERIFIED。',
        '请重派同一个 agent，并使用完整 prompt 顶部模板：',
        promptTemplateForOperation({ prompt, artDir, operation, action })
      ].join('\n');
    }
    // V7G T-001：偏序——verify 写 VERIFIED 要求 CHG 已 APPROVED
    const detail = readDetailFromArtDir(artDir, paceUtils.explicitChangeTargetFromAgentPrompt(text));
    if (detail && !paceUtils.isChangeApproved(detail)) {
      return [
        '派 artifact-writer 执行 update-chg action=verify，但目标 CHG 尚未 APPROVED（无 <!-- APPROVED --> 标记）。',
        FORMAT_SNIPPETS.skillRef,
        '偏序约束：VERIFIED 必须建立在 APPROVED 之上。请先 approve-and-start 让 CHG 进入 in-progress + APPROVED，再 verify。',
      ].join('\n');
    }
  }

  if (mentionsReviewOnly) {
    const missing = [];
    if (!promptHasTrueField(text, 'review-confirmed')) missing.push('review-confirmed: true');
    if (!promptHasNonEmptyField(text, 'review-source')) missing.push('review-source');
    if (!promptHasNonEmptyField(text, 'review-findings')) missing.push('review-findings');
    if (missing.length > 0) {
      return [
        `派 artifact-writer 执行 update-chg action=review 时缺少必填字段：${missing.join(', ')}。`,
        FORMAT_SNIPPETS.skillRef,
        '审计是确认边界：主 session 必须先编排对抗审计、路由 findings，确认审计跑过后才允许写 REVIEWED；agent 以 review-confirmed 为唯一依据，不自行判断。',
        '请重派同一个 agent，并使用完整 prompt 顶部模板：',
        promptTemplateForOperation({ prompt, artDir, operation, action })
      ].join('\n');
    }
    // V7G T-001：偏序——review 写 REVIEWED 要求 CHG 已 VERIFIED
    const detail = readDetailFromArtDir(artDir, paceUtils.explicitChangeTargetFromAgentPrompt(text));
    if (detail && !paceUtils.isChangeVerified(detail)) {
      return [
        '派 artifact-writer 执行 update-chg action=review，但目标 CHG 尚未 VERIFIED（verified-date 为 null 或无 <!-- VERIFIED --> 标记）。',
        FORMAT_SNIPPETS.skillRef,
        '偏序约束：REVIEWED 必须建立在 VERIFIED 之上。请先完成验证（verify 或 close 写入 VERIFIED）再 review。',
      ].join('\n');
    }
  }

  if (mentionsCloseChg) {
    const missing = [];
    if (!promptHasTrueField(text, 'verification-confirmed')) missing.push('verification-confirmed: true');
    if (!promptHasTrueField(text, 'complete-open-tasks')) missing.push('complete-open-tasks: true');
    if (!promptHasNonEmptyField(text, 'verify-summary')) missing.push('verify-summary');
    if (!promptHasTrueField(text, 'review-confirmed')) missing.push('review-confirmed: true');
    if (!promptHasNonEmptyField(text, 'review-source')) missing.push('review-source');
    if (!promptHasNonEmptyField(text, 'review-findings')) missing.push('review-findings');
    if (!promptHasNonEmptyField(text, 'implementation-notes')) missing.push('implementation-notes');
    if (!promptHasNonEmptyField(text, 'walkthrough-summary')) missing.push('walkthrough-summary');
    if (missing.length > 0) {
      return [
        `派 artifact-writer 执行 close-chg 时缺少必填字段：${missing.join(', ')}。`,
        FORMAT_SNIPPETS.skillRef,
        'close-chg 只能在主 session 已运行并读取验证结果、且已编排对抗审计并路由 findings 后调用；验证是否通过经 verification-confirmed、审计是否跑过经 review-confirmed 传入，agent 不得自行判断。',
        missing.includes('implementation-notes')
          ? '实施详情是 CHG 的执行态记录：close 前主 session 必须按任务整理实际改动说明（每个 T-NNN 改了哪些文件、关键实现、对应 commit）经 implementation-notes 传入，agent 据此写入 ## 实施详情 段；缺失则详情文件只剩创建时的规划态信息（Why/What/How），执行情况无从审计。'
          : '',
        '请重派同一个 agent，并使用完整 prompt 顶部模板：',
        promptTemplateForOperation({ prompt, artDir, operation: 'close-chg' })
      ].filter(Boolean).join('\n');
    }
    // V7G T-001：偏序——close 折叠 VERIFIED+REVIEWED+归档，要求 CHG 已 APPROVED
    const detail = readDetailFromArtDir(artDir, paceUtils.explicitChangeTargetFromAgentPrompt(text));
    if (detail && !paceUtils.isChangeApproved(detail)) {
      return [
        '派 artifact-writer 执行 close-chg，但目标 CHG 尚未 APPROVED（无 <!-- APPROVED --> 标记）。',
        FORMAT_SNIPPETS.skillRef,
        'close-chg 折叠 VERIFIED + REVIEWED + 归档，必须建立在 APPROVED 之上。请先 approve-and-start 再 close。',
      ].join('\n');
    }
  }

  if (mentionsArchiveChg && !promptHasNonEmptyField(text, 'walkthrough-summary')) {
    return [
      '派 artifact-writer 执行 archive-chg 时缺少必填字段：walkthrough-summary。',
      FORMAT_SNIPPETS.skillRef,
      'archive-chg 用于已完成且已验证的 CHG/HOTFIX 归档、已取消 CHG/HOTFIX 的索引归档，或终态索引修复；仍需由主 session 提供摘要写入 walkthrough.md。',
      '请重派同一个 agent，并使用完整 prompt 顶部模板：',
      promptTemplateForOperation({ prompt, artDir, operation: 'archive-chg' })
    ].join('\n');
  }

  if (operation === 'record-correction') {
    const missing = [];
    if (!promptHasNonEmptyField(text, 'trigger-quote')) missing.push('trigger-quote');
    if (!promptHasNonEmptyField(text, 'wrong-behavior')) missing.push('wrong-behavior');
    if (!promptHasNonEmptyField(text, 'correct-behavior')) missing.push('correct-behavior');
    if (!promptHasNonEmptyField(text, 'trigger-scenario')) missing.push('trigger-scenario');
    if (!promptHasNonEmptyField(text, 'root-cause')) missing.push('root-cause');
    // knowledge-link | project-scope 二选一：两者都缺才 deny（record-correction.md 边界：都缺→missing-fields）
    if (!promptHasNonEmptyField(text, 'knowledge-link') && !promptHasNonEmptyField(text, 'project-scope')) {
      missing.push('knowledge-link 或 project-scope（二选一）');
    }
    if (missing.length > 0) {
      return [
        `派 artifact-writer 执行 record-correction 时缺少必填字段：${missing.join(', ')}。`,
        FORMAT_SNIPPETS.skillRef,
        'record-correction 持久化用户纠正：trigger-quote / wrong-behavior / correct-behavior / trigger-scenario / root-cause 五项必填，并二选一提供 knowledge-link（跨项目通用，先在 knowledge/ 选定或新建笔记拿 wikilink）或 project-scope: project-only（仅本项目）。',
        '请重派同一个 agent，并使用完整 prompt 顶部模板：',
        promptTemplateForOperation({ prompt, artDir, operation: 'record-correction' })
      ].join('\n');
    }
  }

  // CHG-20260619-07 T-001：update-index / update-finding 早期字段门——补齐与 gated op 对称的「缺字段
  //   hook 早拦」体验（省一次 agent spawn 往返）。只读结构化 target/action 字段，不解析自由文本；
  //   agent 第三层 fail-closed 自校验仍是权威安全网，本门只是快速路径预检。
  if (operation === 'update-index') {
    // 与 operation/action 同源 firstToken 容错（A05 约定）：`target: findings.md 重排索引` 取首 token
    //   findings.md，不因尾随说明误 DENY（R 审计 P2-1：原精确相等破坏对称）。
    const tgt = firstToken(promptFieldValueSameLine(text, 'target')).toLowerCase();
    const validTarget = tgt === 'findings.md' || tgt === 'corrections.md';
    const missing = [];
    if (!validTarget) missing.push('target（findings.md 或 corrections.md）');
    if (action !== 'reorder') missing.push('action: reorder');
    if (missing.length > 0) {
      return [
        `派 artifact-writer 执行 update-index 时缺少或写错必填字段：${missing.join(', ')}。`,
        FORMAT_SNIPPETS.skillRef,
        'update-index 维护索引文件排序：target 必须是 findings.md 或 corrections.md，action 必须是 reorder。',
        '请重派同一个 agent，并使用完整 prompt 顶部模板：',
        promptTemplateForOperation({ prompt, artDir, operation: 'update-index' })
      ].join('\n');
    }
  }

  if (operation === 'update-finding' && !promptHasNonEmptyField(text, 'target')) {
    return [
      '派 artifact-writer 执行 update-finding 时缺少必填字段：target（FINDING-id）。',
      FORMAT_SNIPPETS.skillRef,
      'update-finding 更新 finding 状态/链接：target 必须是 finding-id（解析到 changes/findings/<slug>.md）。',
      '请重派同一个 agent，并使用完整 prompt 顶部模板：',
      promptTemplateForOperation({ prompt, artDir, operation: 'update-finding' })
    ].join('\n');
  }

  return '';
}

function legacyArtifactWriterLockDenyReason() {
  return [
    '检测到旧版本 artifact-writer 项目级写锁仍在当前项目中，已阻止本次派遣以避免跨版本并发写入。',
    '请等待当前 artifact-writer 结束后重试；不要用 Bash 删除或改写写锁。若长时间未恢复，请查看 pace-hooks.log。'
  ].join('\n');
}

function artifactResourceLockDenyReason(artifactRel) {
  return [
    `当前 artifact 正被其他 artifact-writer 写入，已阻止修改 ${artifactRel}。`,
    '不要循环重试或删除运行态文件；请等待对方写入完成后重新 Read 目标 artifact，再重试本次 artifact-writer 操作。'
  ].join('\n');
}

function artifactReservationDenyReason(match, artifactRel) {
  return [
    `artifact-writer 写入的详情文件不匹配 hook 预留编号：${artifactRel}。`,
    `期望：${match.expected}`,
    '请使用主 session 重派 prompt 中的 reserved-id / reserved-file-prefix，不要重新扫描索引自行分配编号。'
  ].join('\n');
}

module.exports = {
  isArtifactWriterAgentTool,
  extractPromptArtifactDir,
  promptHasExactArtifactDir,
  promptHasTrueField,
  promptDeclaredAction,
  explicitReservationFromPrompt,
  parseBatchBlocks,
  promptUpdateStatusValue,
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
};
