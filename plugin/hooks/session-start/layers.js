// session-start/layers.js — SessionStart 注入的「内容生成纯函数层」。
//
// 用途：buildLayers(state, eventType) 把 collectState 产出的纯数据渲染成四层文本块
//   { l0, l1, l2, l3 }（每层是 string[]）。本模块是纯函数：无 I/O、无 process、无 Date.now、
//   无写盘。可喂 fixture state 单测。
//
// 设计（CHG-A 等价重构）：本 CHG 严格只做「搬运 + 归类」，不改注入内容/顺序/对称。
//   各 section 的文本逐字复刻重构前 session-start.js 对应 process.stdout.write 的内容；
//   拼接顺序由 budget.js 的 assembleWithBudget 复刻 golden 基准。四层归类是为后续
//   CHG-B/C/D 的优先级/截断/对称演进预留结构，本 CHG 不依赖归类改变输出。
//
// 字节等价要点：每个 section 函数返回的字符串与重构前对应 write 调用的拼接完全一致
//   （含换行、空行、全角标点）。budget.assembleWithBudget 按 golden 顺序拼接所有层 →
//   经全局字节守卫单次输出 → 与逐段 write 字节一致。
'use strict';

// 共享的 UTF-8 字节截断（与 session-start.js / pace-utils 同算法），供 per-file 兜底截断使用。
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

// 活跃 CHG 展示排序档位：inconsistent（索引/详情损坏或状态违例）最前——损坏最该优先暴露，
//   排在所有正常档之前，避免被正常 CHG 淹没；其后 running（正在执行）→ closing-required（待收尾）
//   → 其余（backlog/ready/blocked）。
function rankChangeCategory(category) {
  if (category === 'inconsistent') return 0;
  if (category === 'running') return 1;
  if (category === 'closing-required') return 2;
  return 3;
}

// 从 change-set-seq（"i/N"）提取分子 i 用于排序；无法解析回退 0。
function changeSetSeqNum(seq) {
  const m = String(seq || '').match(/^(\d+)\s*\//);
  return m ? Number(m[1]) : 0;
}

// M3 §3.6：artifact 文件块在 l3（可截层）的注入优先级——packL3 从尾部按条 omit，
// 故最高优先级排最前（最不易被截）、最低优先级排最后（最先 omit）。
//   task.md（定位信息，CHG/任务唯一索引，最该保住）
//   → corrections（纠正记录）→ findings（调研记录）→ walkthrough（工作记录）
//   → spec（最稳定、可随时 Read，最先 omit）。
// 未在表中的文件名回退到末尾（与 spec 同档之后），保证排序稳定不报错。
const ARTIFACT_BLOCK_PRIORITY = [
  'task.md',
  'corrections.md',
  'findings.md',
  'walkthrough.md',
  'spec.md',
];
function artifactBlockPriorityRank(file) {
  const i = ARTIFACT_BLOCK_PRIORITY.indexOf(file);
  return i === -1 ? ARTIFACT_BLOCK_PRIORITY.length : i;
}
// 稳定排序：按优先级 rank 升序；同 rank 保持输入相对顺序（用原始 index 作 tie-breaker）。
function sortArtifactBlocksByPriority(items) {
  return items
    .map((it, index) => ({ it, index }))
    .sort((a, b) =>
      artifactBlockPriorityRank(a.it.file) - artifactBlockPriorityRank(b.it.file)
      || a.index - b.index)
    .map(({ it }) => it);
}

/**
 * 把 state 渲染成四层注入文本块。纯函数，无副作用。
 *
 * @param {object} state - collectState 产出的纯数据对象。
 * @param {string} eventType - SessionStart 事件类型（'startup' / 'compact' / ...）。
 * @param {object} paceUtils - pace-utils 模块（提供常量/正则/纯工具，依赖注入便于单测）。
 * @param {string} [group] - 渲染分组：'core'（默认）或 'artifact'。
 *   - core：项目上下文 / 工作流入口 / compact 快照 / Native Plan / rootChoice / Artifact 目录 /
 *           活跃 CHG 摘要 / change-set 进度 / 格式合规警告 / 跨会话提醒 / 执行上下文 /
 *           Findings 过期提醒 / git 状态 / 相关讨论
 *   - artifact：spec / task.md / walkthrough.md / findings.md / corrections.md
 * @returns {{ l1head: string[], l0: string[], l1: string[], l2: string[], l3: string[] }}
 *   - l1head: 项目上下文 + 工作流入口 + Artifact 目录 + 格式警告（注入顺序最前，head 永不截）
 *   - l0: 活跃 CHG 摘要 / change-set 进度 / 跨会话提醒 / 桥接 / 执行上下文（「我刚才在做」）
 *   - l1: git 状态
 *   - l2: （CHG-A 占位，工作流入口本 CHG 仍在 l1head 复刻原位）
 *   - l3: artifact 文件块（M3 按 §3.6 优先级排序）/ findings 过期提醒 / 相关讨论（唯一可截层）
 *   注：M3（CHG-10）把 artifact 文件块从 l1head 移到 l3，让全局 chars 兜底（budget.js）对 artifact 主体生效。
 */
function buildLayers(state, eventType, paceUtils, group) {
  // 渲染分组守卫：仅 'artifact' 为 artifact group，其余（含未传/非法值）显式回落 'core'。
  // 用显式三元而非 `group || 'core'`——否则非法真值（如 'bogus'）会令 isCore/isArtifact 双 false、输出空注入（R 审计发现 D）。
  const g = group === 'artifact' ? 'artifact' : 'core';
  const isCore = g === 'core';
  const isArtifact = g === 'artifact';
  const ev = eventType || state.eventType;
  // B5 + 倒序对称（HOTFIX-20260608-01）：活跃 CHG 展示顺序规范化——running 优先 → 同档 CHG-ID 升序。
  // summarizeActiveChanges 继承 task.md 活跃区物理顺序（batch create prepend 致创建倒序 08→05），
  // 此处稳定排序修正，使「正在执行的」「下一个该 approve-and-start 的」排最前；惠及下游消费点
  // （活跃 CHG 摘要 / 执行上下文）。change-set 进度另按纯 seq 升序（见 renderChangeSetProgress）。
  // 浅拷贝 state 替换排序后副本，不 mutate 输入，保持纯函数。
  // B5 + 倒序对称：活跃 CHG 排序（running 优先 → 同档 CHG-ID 升序）。
  // 浅拷贝 state 替换排序后副本，不 mutate 输入，保持纯函数。
  if (state.activeChangeSummaries && state.activeChangeSummaries.length > 1) {
    state = {
      ...state,
      activeChangeSummaries: [...state.activeChangeSummaries].sort((a, b) =>
        rankChangeCategory(a.category) - rankChangeCategory(b.category)
        || String(a.id).localeCompare(String(b.id))),
    };
  }
  const l1head = [];
  const l0 = [];
  const l1 = [];
  const l2 = [];
  const l3 = [];

  // ── core 块：项目骨架（每次 session 固定需要）──────────────────────────────
  if (isCore) {
    // === 0. 软信号提问指示（CHG-20260610-08 C1）===
    //   软信号命中（code-count/dated-plan）且未激活 → 指示 AI 在响应用户前用 AskUserQuestion 问是否启用。
    //   additionalContext 用户不可见，只能指示 AI 提问，不能直接问用户（spec §2）。放 l1head 最前（head 永不截）。
    const softPrompt = renderSoftSignalPrompt(state);
    if (softPrompt) l1head.push(softPrompt);

    // === 1. 项目上下文（重构前 137-139 + writeProjectContextSection 104-119）===
    const projCtx = renderProjectContext(state, paceUtils);
    if (projCtx) l1head.push(projCtx);

    // === 2. 工作流入口（重构前 141-144 + writeWorkflowEntrySection 122-134）===
    //   A0 对称（M4/T-002）：PreCompact 快照退役后 compact 与 startup 走同一条实时读路径，
    //   工作流入口去掉 compact 守卫——compact 也注入。仅 paceSignal && !rootChoicePending。
    const workflowEntry = renderWorkflowEntry(state, ev, paceUtils);
    if (workflowEntry) l1head.push(workflowEntry);

    // === 3. Native Plan 桥接提醒（重构前 264-273），仅 eventType !== 'compact' ===
    const nativePlanReminder = renderNativePlanReminder(state, ev);
    if (nativePlanReminder) l1head.push(nativePlanReminder);

    // === 5. rootChoicePending 启用提示（重构前 282-300）===
    const rootChoicePrompt = state.rootChoicePromptText || '';
    if (rootChoicePrompt) l1head.push(rootChoicePrompt);

    // === 6. Artifact 目录（重构前 404-407 writeArtifactDirSection）===
    //   仅 paceSignal && task.md 存在时在此位置注入。
    if (state.artifactDirInjected) {
      l1head.push(renderArtifactDirSection(state));
    }
  }

  // ── artifact 块：增长性文件（spec / task / impl / walkthrough / findings / corrections）──
  // renderArtifactFiles 在两个 group 都需要调用，但 push 文件块只在 isArtifact 时执行。
  // isCore 时 found 为 []（state.artifactFiles 由 collectState 按 group 过滤，见 T-004），
  // 此处渲染层已保证 core 不注入 artifact 文件块。
  const filesRender = renderArtifactFiles(state, paceUtils);
  if (isArtifact) {
    // === 7. artifact 文件循环（重构前 416-593）===
    // M3（CHG-10/T-001）：文件块从 l1head（head 永不截）移到 l3（可截层），让全局 chars
    //   兜底（assembleWithBudget）对 artifact 主体生效——CHG-09 R 审计发现 1：原在 l1head 时
    //   12000 chars 的 spec 完全不被截，全局 budget 对 artifact group 失效。
    //   按 §3.6 优先级排序（task/impl 定位信息排最前最不易被截 → spec 排最后最先 omit）。
    const ordered = sortArtifactBlocksByPriority(filesRender.blocks);
    for (const { block } of ordered) l3.push(block);

    // === 10. 格式合规警告（重构前 638-672）===
    // R 审计发现 A 修正：renderFormatWarnings 依赖 found（artifact 文件）+ taskFullCached（artifact 读），
    // 必须与数据同 group。T-003 误放 core 块致 core found 恒空、双 hook 后 artifact 块又不渲染 → 格式警告全 group 丢失。
    // 格式警告是重要提醒（不该被截），CHG-09 已留 l1head（head 永不截），本 CHG 不动。
    const formatWarn = renderFormatWarnings(state, filesRender.found, paceUtils);
    if (formatWarn) l1head.push(formatWarn);

    // === 14. Findings 过期提醒（重构前 757-787）===
    // CHG-11/T-001：findings 过期提醒三元组（W12 flag 写 + collectAgedFindings 读 + renderAgedFindings 渲染）
    // 整体归 artifact group。三者同 group 后时序自洽——artifact hook 先快照 flag 存在性、collectAgedFindings 据此判注入、
    // applyArtifactGroupEffects 再写 W12 flag，本次注入、当日去重。杜绝原发现 B2 的跨 group 写读割裂（core 写 flag →
    // artifact 读到已存在 → 永不注入）。agedText 仍 push l3（可截层；过期提醒非关键阻断信息）。
    const agedText = renderAgedFindings(state);
    if (agedText) l3.push(agedText);
  }
  // found（含 post-截断长度）回挂 state，供编排层 INJECT 日志的 files 字段复刻重构前 found.join。
  state._found = filesRender.found;

  if (isCore) {
    // === 8. 活跃 CHG 摘要 + change-set 进度（重构前 595-629）===
    if (state.paceSignal === 'artifact') {
      const activeChgText = renderActiveChangeSummary(state, paceUtils);
      if (activeChgText) l0.push(activeChgText);
      const changeSetText = renderChangeSetProgress(state);
      if (changeSetText) l0.push(changeSetText);
    }

    // === 9. Artifact 目录兜底（重构前 634-636：found>0 && !artifactDirInjected）===
    // core group 时 filesRender.found 由 T-004 保证为空（artifact IO 跳过），不触发。
    // 此处保留逻辑完整性，兼容 collectState 全量读取时 core group 的安全守卫。
    if (filesRender.found.length > 0 && !state.artifactDirInjected) {
      l1head.push(renderArtifactDirSection(state));
    }

    // === 11. 跨会话提醒 + 桥接 + 执行上下文（重构前 674-755）===
    const crossSession = renderCrossSessionAndExecution(state, paceUtils);
    for (const block of crossSession) l0.push(block);

    // === 12. Git 状态（重构前 790-799）===
    const gitText = renderGit(state);
    if (gitText) l1.push(gitText);

    // === 13. 相关讨论（重构前 801-813）===
    const relatedText = renderRelatedNotes(state, ev);
    if (relatedText) l3.push(relatedText);
  }

  return { l1head, l0, l1, l2, l3 };
}

// ============================================================================
// 各 section 渲染函数：返回字符串（含尾部换行），与重构前对应 write 调用逐字一致。
// ============================================================================

/**
 * 软信号提问指示 section（CHG-20260610-08 C1 / spec §7）。
 * 泛化措辞讲价值不讲机制：不写「N 个代码文件」（dated-plan 触发时无代码文件，写了自相矛盾）。
 * AI 问用户的话术与选项语义与 spec §7 对齐（启用 / 暂不，暂不=不再主动问、随时可 enable）。
 */
function renderSoftSignalPrompt(state) {
  if (!state.softSignal) return '';
  return [
    '=== PACEflow 启用询问 ===',
    '检测到本项目可纳入 PACEflow 管理但未启用。在响应用户前，用 AskUserQuestion 询问是否启用：',
    '问题：「PACEflow 可以管理这个项目的开发流程（任务追踪 / 变更记录 / 验证审计）。是否启用？」',
    // CHG-20260611-05：明确 AI 行为指令——/paceflow:enable 同时注册为 skill，AI 经 Skill 工具
    // 直接执行（command 文件含完整 helper 路径与选 root 流程），不要让用户手打命令多一轮往返。
    '选项「启用」→ 调用 Skill(paceflow:enable) 完成启用流程（首次会让用户选 artifact 存放位置）。',
    '选项「暂不」→ 调用 Skill(paceflow:disable)（本项目不再主动询问，随时可 /paceflow:enable 开启）。',
    '在用户回答前不要创建 changes/、不要派 artifact-writer、不要按 PACE 流程拦截写代码。',
    '',
  ].join('\n') + '\n';
}

/** 项目上下文 section（重构前 writeProjectContextSection + 触发条件 137）。 */
function renderProjectContext(state, paceUtils) {
  const { paceSignal, rootChoicePending } = state;
  const { rootInfo, contextArtDir } = state.projectContext;
  const cwd = state.cwd;
  // 触发：paceSignal || rootChoicePending || mode==='inherited'
  if (!(paceSignal || rootChoicePending || rootInfo.mode === 'inherited')) return '';
  const lines = [
    '=== PACEflow 项目上下文 ===',
    `Current CWD: ${cwd.replace(/\\/g, '/')}`,
    `Project Root: ${rootInfo.projectRoot.replace(/\\/g, '/')}`,
    `Artifact Root: ${paceUtils.displayDir(contextArtDir)}`,
    `Runtime Root: ${rootInfo.runtimeRoot.replace(/\\/g, '/')}`,
    `模式: ${projectContextMode(rootInfo)}（mode=${rootInfo.mode}）`,
  ];
  if (rootInfo.mode === 'inherited' || rootInfo.mode === 'worktree') {
    // 文件归属防呆：双层场景（CWD≠Project Root）下，AI 易把代码/普通文档（docs/、审计报告）
    // 误放到醒目的 Project Root。措辞直接搬 pace-workflow SKILL.md「Worktree」段原话保证单源
    // 一致（改一处同步另一处）；防呆前移到注入层，因注入先于 skill 被 AI 看到、且不需 invoke。
    lines.push('主 session 修改普通项目文件仍以当前 cwd/worktree 为准；只有 PaceFlow artifacts 与 .pace 运行态走 Project Root 共享位置。');
  }
  if (rootInfo.mode === 'inherited') {
    lines.push(`若这是独立子项目，先运行：node "${paceUtils.SET_PROJECT_ROOT_SCRIPT}" --mode independent`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

/** 项目上下文 mode 文案（重构前 projectContextMode 96-102）。 */
function projectContextMode(rootInfo) {
  if (rootInfo.mode === 'inherited') return '继承父级 PACEflow 项目';
  if (rootInfo.mode === 'independent') return '当前 cwd 是 independent Project Root';
  if (rootInfo.mode === 'worktree') return 'git worktree 共享宿主 Project Root';
  if (rootInfo.mode === 'disabled') return '当前 Project Root 已禁用 PACEflow';
  return '当前 cwd 作为 Project Root';
}

/** 工作流入口 section（重构前 writeWorkflowEntrySection + 触发条件 141-144）。
 *  A0 对称（M4/T-002）：去掉 eventType !== 'compact' 守卫——快照退役后 compact 也实时注入工作流入口。
 *  eventType 入参保留（签名稳定 + 不破坏调用方），现已不参与触发判定。 */
function renderWorkflowEntry(state, eventType, paceUtils) {
  const { paceSignal, rootChoicePending, v5MigrationInfo } = state;
  if (!(paceSignal && !rootChoicePending)) return '';
  const reason = v5MigrationInfo.detected ? 'legacy-v5' : String(paceSignal);
  const lines = [
    '=== PACEflow 工作流入口 ===',
    `信号: ${reason}`,
    '收到实现、迁移、CHG、验证、归档、记录 finding/correction 任务时，先调用 Skill(paceflow:pace-workflow)。',
    '涉及 artifact/CHG 字段、任务状态、批准、验证、归档、记录调研/纠正时，再调用 Skill(paceflow:artifact-management)。',
    `artifact-root helper: node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice local 或 --choice vault`,
    `独立子项目 helper: node "${paceUtils.SET_PROJECT_ROOT_SCRIPT}" --mode independent`,
    `预留编号 helper: node "${paceUtils.RESERVE_ARTIFACT_ID_SCRIPT}" --operation create-chg --cwd "${state.cwd.replace(/\\/g, '/')}"`,
    'reserve helper 从 --cwd 指定的项目 cwd 和 .pace/artifact-root 解析 artifact_dir；上面命令已内联 --cwd。Claude 主 session 的 Bash cwd 会在命令间漂移，务必带 --cwd 锚定，否则 reservation 可能写错 runtime（后续 artifact-writer 误报「无效或已过期」）。',
  ];
  // v5 布局一句性提示（CHG-20260612-02）：不催办迁移、不门控；首个 create-chg 建出 changes/ 后自动消失。
  if (v5MigrationInfo.detected) {
    lines.push(`v5 布局提示: 检测到 v5 时代 artifact 布局（${v5MigrationInfo.files.join(', ')} 含活跃详情、无 changes/）。新变更按当前合同写入——task.md 仅追加索引行，详情在 changes/<id>.md；v5 存量保持原样，不自动迁移。`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

/** Native Plan 桥接提醒（重构前 264-273），仅 eventType !== 'compact' 且有未桥接 plan。 */
function renderNativePlanReminder(state, eventType) {
  if (eventType === 'compact') return '';
  const planPath = state.nativePlanPath;
  if (!planPath) return '';
  return `\n=== Native Plan 桥接提醒 ===\n`
    + `检测到未桥接的原生计划文件：${planPath}\n`
    + '请调用 Skill(paceflow:pace-bridge)，按该 skill 桥接为 CHG 并记录同步标记。\n\n';
}

/** Artifact 目录 section（重构前 writeArtifactDirSection 315-327 的输出部分）。
 *  E4 去重：删「路径:」行（== 项目上下文段 Artifact Root，真重复）；保留「模式:」行——
 *  那是 artifact 存储 mode（本地项目根目录/Obsidian vault project），与项目上下文段的 project root
 *  mode（继承/独立，mode=inherited/independent）语义不同，不重复。 */
function renderArtifactDirSection(state) {
  const ad = state.artifactDir;
  return `=== Artifact 目录 ===\n模式: ${ad.mode}\n仅用于 PaceFlow artifacts：${ad.content}（路径见上方「项目上下文」段 Artifact Root）。\nCHG 编号 / artifact-root / 独立子项目 helper 见上方「PACEflow 工作流入口」段。\nplan 同步 helper: node "${ad.scripts.syncPlan}" --plan "<已桥接 plan 绝对路径>"\n\n`;
}

/**
 * artifact 文件循环（重构前 416-593）：逐文件输出 `=== file ===` + 截断整形后内容。
 * @returns {{ blocks: Array<{ file: string, block: string }>, found: string[] }}
 *   blocks 是各文件的输出块（带文件名，供 buildLayers 按 §3.6 优先级排序后 push l3）；
 *   found 是 `file(len)` 列表，保持 state.artifactFiles 输入顺序（供 INJECT 日志复刻）。
 */
function renderArtifactFiles(state, paceUtils) {
  const {
    ARCHIVE_PATTERN, ARCHIVE_MARKER, ARCHIVE_REQUIRED_FILES, ARCHIVE_MISSING_INJECT_LIMIT,
  } = paceUtils;
  const blocks = [];
  const found = [];
  for (const { file, full } of state.artifactFiles) {
    let block = `=== ${file} ===\n`;
    // findings 子路径线索（corrections.md 文件头已有 blockquote，findings.md 缺——注入层补，所有项目生效）。
    if (file === 'findings.md') block += '（finding 详情在 changes/findings/<id>.md，按需 Read 完整正文）\n';
    const archiveMatch = full.match(ARCHIVE_PATTERN);
    // M3 T-002：findings 缺 ARCHIVE 时不走通用「字节截断 + 缺失警告」兜底（那是 mid-line 字节切，
    //   且 20000 字节远超 9500 chars 注入预算 → 整条被 packL3 omit、警告 footer 不可达）。改为：
    //   先走 findings 类内 impact 优先截断（P0/P1 全 + P2/P3 最近 5）把开放区缩小到极小，再补「缺失警告」footer，
    //   缩小后的块存活 packL3、警告 footer 可达。其余 ARCHIVE_REQUIRED 文件仍走通用字节兜底（保持原行为）。
    const findingsArchiveMissing = file === 'findings.md' && !archiveMatch
      && ARCHIVE_REQUIRED_FILES.includes(file)
      && Buffer.byteLength(full, 'utf8') > ARCHIVE_MISSING_INJECT_LIMIT;
    let output;
    if (archiveMatch) {
      output = full.slice(0, archiveMatch.index);
    } else if (findingsArchiveMissing) {
      // findings 缺 ARCHIVE：交由 findings 类内截断处理，原文整体进截断（不预先字节切）。
      output = full;
    } else if (ARCHIVE_REQUIRED_FILES.includes(file) && Buffer.byteLength(full, 'utf8') > ARCHIVE_MISSING_INJECT_LIMIT) {
      // 层2：应有 ARCHIVE 的双区文件缺标记且超限 → 截断兜底，防全文灌爆 context。
      const archiveFooter = `\n\n（⚠️ ${file} 缺少 <!-- ARCHIVE --> 标记，已截断注入以防全文灌爆 context；请派 artifact-writer 修复双区结构）\n`;
      output = sliceUtf8ToBytes(full, Math.max(0, ARCHIVE_MISSING_INJECT_LIMIT - Buffer.byteLength(archiveFooter, 'utf8')))
        + archiveFooter;
    } else {
      output = full;
    }

    // spec.md 截断（重构前 440-447 + M3 T-002 类内摘要：保留概述/技术栈，砍目录/依赖）。
    if (file === 'spec.md') {
      output = truncateSpec(output);
    }

    // walkthrough.md 智能截断（重构前 449-503；M3 T-002 表格最近 3 行）。
    if (file === 'walkthrough.md') {
      output = truncateWalkthrough(output);
    }

    // findings.md 智能截断（重构前 505-557 + M3 T-002 impact 优先类内截断）。
    if (file === 'findings.md') {
      output = truncateFindings(output, state, paceUtils);
      // findings 缺 ARCHIVE：类内截断缩小后补「缺失警告」footer（缩小后块存活 packL3、footer 可达）。
      if (findingsArchiveMissing) {
        output += `\n\n（⚠️ ${file} 缺少 <!-- ARCHIVE --> 标记，已按 impact 优先类内截断注入以防全文灌爆 context；请派 artifact-writer 修复双区结构）\n`;
      }
    }

    // corrections.md 类内截断（M3 T-002）：活跃区纠正记录最近 6 条 + 长尾指针。
    if (file === 'corrections.md') {
      output = truncateCorrections(output);
    }

    output = foldForeignOwnedArtifactOutput(file, output, state.activeChangeSummaries);
    if (archiveMatch) output += ARCHIVE_MARKER + '\n';
    block += output;
    block += '\n\n';
    // 带文件名回传，供 buildLayers 按 §3.6 优先级排序后 push l3。
    blocks.push({ file, block });
    found.push(`${file}(${output.length})`);
  }
  return { blocks, found };
}

/** walkthrough 索引表截断：保留最近 10 行 + 删除 v6 永不触发的详情段落处理（重构前 449-503；M2 回 10 对齐 design L0）。 */
function truncateWalkthrough(output) {
  // 索引表截断：保留表头 + 最近 5 行数据行（CHG-20260614-15：从 10 降到 5，了解背景 5 条够；walkthrough 是 L3 rank-3 低优先）。
  const WALK_KEEP = 5;
  const dataRe = /^\| \d{4}-\d{2}-\d{2} \|/gm;
  const dataRows = [];
  let m;
  while ((m = dataRe.exec(output)) !== null) {
    const lineStart = output.lastIndexOf('\n', m.index) + 1;
    const lineEnd = output.indexOf('\n', lineStart);
    const line = output.slice(lineStart, lineEnd >= 0 ? lineEnd : output.length);
    const date = (line.match(/^\| (\d{4}-\d{2}-\d{2}) \|/) || [])[1] || '';
    dataRows.push({ lineStart, lineEnd, line, date, index: dataRows.length });
  }
  if (dataRows.length > WALK_KEEP) {
    const omitted = dataRows.length - WALK_KEEP;
    const keep = new Set(dataRows
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date) || a.index - b.index)
      .slice(0, WALK_KEEP)
      .map(row => row.index));
    const firstRowStart = dataRows[0].lineStart;
    const last = dataRows[dataRows.length - 1];
    const lastRowEnd = last.lineEnd >= 0 ? last.lineEnd : output.length;
    const keptLines = dataRows
      .filter(row => keep.has(row.index))
      .sort((a, b) => b.date.localeCompare(a.date) || a.index - b.index)
      .map(row => row.line);
    output = output.slice(0, firstRowStart)
      + keptLines.join('\n') + '\n'
      + `| ... | （已省略 ${omitted} 条旧记录，需要时 Read walkthrough.md） | | | |\n`
      + output.slice(lastRowEnd >= 0 ? lastRowEnd + 1 : output.length);
  }
  // 详情截断：保留最近 3 条 `## YYYY-MM-DD` 段落（重构前 481-502；v6 数据全表格时不触发）。
  const pos = [];
  const re = /^## \d{4}-\d{2}-\d{2}/gm;
  let m2;
  while ((m2 = re.exec(output)) !== null) pos.push(m2.index);
  if (pos.length > 3) {
    const sections = pos.map((start, index) => {
      const end = index + 1 < pos.length ? pos[index + 1] : output.length;
      const headerEnd = output.indexOf('\n', start);
      const header = output.slice(start, headerEnd >= 0 ? headerEnd : end);
      const date = (header.match(/^## (\d{4}-\d{2}-\d{2})/) || [])[1] || '';
      return { text: output.slice(start, end).trimEnd(), date, index };
    });
    const latest = sections
      .sort((a, b) => b.date.localeCompare(a.date) || a.index - b.index)
      .slice(0, 3);
    output = output.slice(0, pos[0])
      + latest.map(section => section.text).join('\n')
      + `\n（已省略 ${pos.length - 3} 条旧详情，需要时 Read walkthrough.md）\n`;
  }
  return output;
}

/** findings 智能截断（重构前 505-557）：跳过 [x]/[-] 索引+详情，保留 open + Corrections。 */
function truncateFindings(output, state, paceUtils) {
  const { extractOpenKeys, normalizeFindingKey, logEntry } = paceUtils;
  // 跳过 [x]/[-] 索引行。
  const resolvedRe = /^- \[(?:x|-)\] .+$/gm;
  const resolvedCount = (output.match(resolvedRe) || []).length;
  if (resolvedCount > 0) {
    output = output.replace(resolvedRe, '');
    output = output.replace(/\n{3,}/g, '\n\n');
    const statusLine = output.match(/^\*\*状态说明\*\*/m);
    if (statusLine) {
      output = output.slice(0, statusLine.index)
        + `（已省略 ${resolvedCount} 条已解决索引，需要时 Read findings.md）\n\n`
        + output.slice(statusLine.index);
    }
  }
  // 跳过已解决详情段落（正向匹配保留 open 项详情）。
  const openKeys = extractOpenKeys(output);
  const totalDetails = (output.match(/^### \[\d{4}-\d{2}-\d{2}\]/gm) || []).length;
  if (totalDetails > 0 && totalDetails > openKeys.length) {
    const lines = output.split('\n');
    const result = [];
    let skip = false, cnt = 0, kept = 0;
    const skippedTitles = [];
    for (const l of lines) {
      const dm = l.match(/^### \[\d{4}-\d{2}-\d{2}\] (.+)/);
      if (dm) {
        const key = normalizeFindingKey(dm[1]);
        skip = !openKeys.includes(key);
        if (skip) { cnt++; skippedTitles.push(dm[1]); continue; }
        kept++;
      } else if (skip) {
        if (/^#{2,3} /.test(l)) skip = false;
        else continue;
      }
      result.push(l);
    }
    if (openKeys.length > 0 && kept === 0 && skippedTitles.length > 0) {
      state._logs = state._logs || [];
      state._logs.push(logEntry('SessionStart', 'FINDINGS_DETAIL_MATCH_MISS', {
        proj: state.proj,
        open: openKeys.length,
        skipped: skippedTitles.slice(0, 5).join('; '),
      }));
    }
    if (cnt > 0) {
      output = result.join('\n');
      const ci = output.match(/^## Corrections/m);
      const hint = `（已省略 ${cnt} 条已解决详情，需要时 Read findings.md）\n\n`;
      output = ci ? output.slice(0, ci.index) + hint + output.slice(ci.index) : output + '\n' + hint;
    }
  }
  // M3 T-002：impact 优先类内截断——开放 [ ] 索引行 P0/P1 全保留、P2/P3 仅最近 5 条 + 长尾指针。
  //   防超大开放区（如 2d2/2d3 的 400/900 条 P3 filler）整块 > 注入预算被 packL3 omit。
  output = truncateFindingsByImpact(output);
  return output;
}

/**
 * findings impact 优先类内截断（M3 T-002 / design §3.6）：
 *   开放 [ ] 索引行按 impact 分档——P0/P1 全保留，P2/P3 仅保留最近 5 条（按 date 降序），
 *   被省略的 P2/P3 以「（另有 M 条 P2/P3 finding，详见 findings.md）」长尾指针替代。
 *   只动开放 `- [ ]` 索引行（数据模型保证活跃区索引连续单段，详情在 changes/findings/<id>.md）；P0/P1 与详情段落不受影响。无超量时仍按 impact+date 重排。
 * @param {string} output - 已跳过 [x]/[-] 的 findings 文本
 * @returns {string} impact 截断后的文本
 */
/**
 * 列表区整形（CHG-20260609-01 T-002）：把活跃区列表行按保留集过滤 + 自定义排序重排，
 *   长尾指针追加到列表**末尾**（不夹在中间割裂 P0/P1 等关键项——审查发现 C/H），
 *   列表区外结构（## 标题 / blockquote / ARCHIVE / 列表前后正文）原样保留。
 *   做法：把「列表区」（首个到末个列表行之间整段，含中间空行）整体替换为 排序后的保留行 [+ 指针]。
 * @param {string[]} lines - output.split('\n')
 * @param {Array<{i:number,text:string}>} items - 所有列表行（带行号 i + 排序字段 + 原文 text）
 * @param {Set<number>} keepSet - 要保留的列表行行号
 * @param {(a,b)=>number} sortFn - 保留行排序比较器（决定输出顺序，如 date 降序=新→旧）
 * @param {string} pointerText - 长尾指针（空串=无省略不插）
 * @returns {string}
 */
function reorderListWithPointer(lines, items, keepSet, sortFn, pointerText) {
  if (items.length === 0) return lines.join('\n');
  const keptTexts = items.filter(o => keepSet.has(o.i)).slice().sort(sortFn).map(o => o.text);
  const first = items[0].i;
  const last = items[items.length - 1].i;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i < first || i > last) { out.push(lines[i]); continue; }
    if (i === first) {
      for (const t of keptTexts) out.push(t);
      if (pointerText) out.push(pointerText);
    }
    // first..last 之间的原列表行 + 空行全部跳过（已由排序后的 keptTexts 替代）。
  }
  return out.join('\n');
}

// finding impact 排序档（P0 最高，必看项排最前）。
function findingImpactRank(impact) {
  return impact === 'P0' ? 0 : impact === 'P1' ? 1 : impact === 'P2' ? 2 : 3;
}

function truncateFindingsByImpact(output) {
  const lines = output.split('\n');
  // 收集开放索引行（`- [ ] ...`）及其 impact 与 date（扫活跃区全部开放索引行——数据模型保证它们连续单段）。
  const openIdx = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^- \[ \] /.test(l)) continue;
    const impactM = l.match(/\[impact::\s*(P[0-3])\]/i);
    const impact = impactM ? impactM[1].toUpperCase() : 'P3'; // 无 impact 视作低优先 P3，优先被截
    const dateM = l.match(/\[date::\s*(\d{4}-\d{2}-\d{2})\]/);
    openIdx.push({ i, impact, date: dateM ? dateM[1] : '', text: l });
  }
  if (openIdx.length === 0) return output;
  const lowItems = openIdx.filter(o => o.impact === 'P2' || o.impact === 'P3');
  // 保留集：P0/P1 全部 + P2/P3 最近 5 条（date 降序选择，同 date 保持原序）。
  const keepLow = new Set(lowItems
    .map((o, k) => ({ o, k }))
    .sort((a, b) => b.o.date.localeCompare(a.o.date) || a.k - b.k)
    .slice(0, 5)
    .map(({ o }) => o.i));
  const keepSet = new Set(openIdx.filter(o => o.impact === 'P0' || o.impact === 'P1' || keepLow.has(o.i)).map(o => o.i));
  const omitted = lowItems.length > 5 ? lowItems.length - 5 : 0;
  const pointer = omitted > 0 ? `（另有 ${omitted} 条 P2/P3 finding，详见 findings.md）` : '';
  // 输出排序：impact 优先（P0>P1>P2>P3，必看项突出）+ 同 impact date 降序（新→旧，#3）；
  //   指针追加列表末尾（不割裂 P0/P1，C）。即使无省略也重排，统一修正旧→新。
  return reorderListWithPointer(lines, openIdx, keepSet,
    (a, b) => findingImpactRank(a.impact) - findingImpactRank(b.impact) || b.date.localeCompare(a.date) || a.i - b.i,
    pointer);
}

/**
 * corrections 类内截断（M3 T-002 / design §3.6）：
 *   活跃区纠正记录行（`- [[correction-...]]`）按 date 降序保留最近 6 条，
 *   被省略的以「（另有 M 条更早纠正记录，避免重犯请 Read corrections.md）」长尾指针替代。
 *   纠正记录是「避免重犯」高价值提醒，超量时保留最新而非整块被 packL3 omit。无超量原样返回。
 * @param {string} output - corrections.md 活跃区文本
 * @returns {string} 截断后的文本
 */
function truncateCorrections(output) {
  // 纠正记录是「避免重犯」最高价值提醒（rank-1 L3 高优先），cap 提到 30（CHG-20260614-15）≈ 实际全量，
  //   极端规模优雅降级为「30 条 + 指针」，避免彻底去 cap 时单块超 L3 预算被 packL3 整块 omit。
  const CORRECTION_KEEP = 30;
  const lines = output.split('\n');
  const recs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^- \[\[correction-/i.test(lines[i])) continue;
    const dateM = lines[i].match(/\[date::\s*(\d{4}-\d{2}-\d{2})\]/)
      || lines[i].match(/correction-(\d{4}-\d{2}-\d{2})/i);
    recs.push({ i, date: dateM ? dateM[1] : '', text: lines[i] });
  }
  if (recs.length === 0) return output;
  // 保留最近 CORRECTION_KEEP 条（date 降序选择，同 date 保持原序）。
  const keepSet = new Set(recs
    .map((r, k) => ({ r, k }))
    .sort((a, b) => b.r.date.localeCompare(a.r.date) || a.k - b.k)
    .slice(0, CORRECTION_KEEP)
    .map(({ r }) => r.i));
  const omitted = recs.length > CORRECTION_KEEP ? recs.length - CORRECTION_KEEP : 0;
  const pointer = omitted > 0 ? `（另有 ${omitted} 条更早纠正记录，避免重犯请 Read corrections.md）` : '';
  // 输出 date 降序（新→旧，#3）；指针追加列表末尾（不在顶部——审查 H：旧版指针插首个 drop 行=最老记录=文件头）。
  //   即使无省略也重排，统一修正旧→新展示。
  return reorderListWithPointer(lines, recs, keepSet,
    (a, b) => b.date.localeCompare(a.date) || a.i - b.i,
    pointer);
}

// spec 类内摘要要砍掉的低频可随时 Read 的段落（标题前缀匹配）：目录（含「目录结构」）、依赖列表。
//   保留「项目概述 / 技术栈 / 禁止事项」等高价值约束段——禁止事项是 AI 不可违反的约束，必须保住（e2e 2h）。
//   E3：改前缀匹配——真实/模板标题是「## 目录结构」，精确 includes('目录') 永不命中、致 spec 全文注入。
//   保留数组 + some(startsWith) 而非钉死全名 ['目录结构',...]：对未来标题漂移（目录与结构/目录说明）鲁棒（spec §5）。
const SPEC_OMIT_SECTIONS = ['目录', '依赖列表'];
/**
 * spec 类内摘要（M3 T-002 / design §3.6）：
 *   砍掉「## 目录」「## 依赖列表」这类可随时 Read 的低频段落（标题到下一个同级 ## 或 ARCHIVE/文末），
 *   保留「项目概述 / 技术栈 / 禁止事项」等高价值约束段，附「（已省略 spec 目录/依赖列表，需要时 Read spec.md）」指针。
 *   只删命中段，不动其余结构；无命中段时原样返回。
 * @param {string} output - spec.md 文本
 * @returns {string} 摘要后的文本
 */
function truncateSpec(output) {
  // 收集全文所有 ## 标题位置（含名称），用于界定每段范围。
  const heads = [];
  const hRe = /^## (.+?)\s*$/gm;
  let hm;
  while ((hm = hRe.exec(output)) !== null) heads.push({ start: hm.index, name: hm[1].trim() });
  if (heads.length === 0) return output;
  // 命中要省略的段（标题在 SPEC_OMIT_SECTIONS 中），范围为本标题到下一个 ## 起点（或文末）。
  const dropRanges = [];
  for (let i = 0; i < heads.length; i++) {
    if (!SPEC_OMIT_SECTIONS.some(omit => heads[i].name.startsWith(omit))) continue;
    const end = i + 1 < heads.length ? heads[i + 1].start : output.length;
    dropRanges.push([heads[i].start, end]);
  }
  if (dropRanges.length === 0) return output;
  // 从后往前删除命中段，避免前面删改影响后面 range 下标。
  let result = output;
  for (let k = dropRanges.length - 1; k >= 0; k--) {
    const [s, e] = dropRanges[k];
    result = result.slice(0, s) + result.slice(e);
  }
  return result.trimEnd() + '\n\n（已省略 spec 目录/依赖列表，需要时 Read spec.md）\n';
}

// --- foreign owner 折叠（重构前 349-401）---

function isForeignSummary(summary) {
  // CHG-20260611-02：sibling 三态（同目录其他 session 的 CHG）同样折叠任务本体——
  // B 不该被注入引导执行 A 的任务。
  const d = String(summary.ownerDisposition || '');
  return d === 'foreign-fresh' || d === 'foreign-stale' || d.startsWith('sibling-');
}

function foreignOwnedSummariesForInjection(summaries) {
  return summaries.filter(s => isForeignSummary(s) && s.category !== 'inconsistent');
}

function lineReferencesChangeId(line, ids) {
  if (!line || !ids || ids.size === 0) return false;
  const re = /(?:\[\[((?:chg|hotfix)-\d{8}-\d{2})(?:\|[^\]]*)?\]\]|((?:CHG|HOTFIX)-\d{8}-\d{2}))/gi;
  let m;
  while ((m = re.exec(line)) !== null) {
    const id = String(m[1] || m[2] || '').toUpperCase();
    if (ids.has(id)) return true;
  }
  return false;
}

function appendForeignFoldNote(output, count) {
  if (count <= 0) return output;
  return `${output.trimEnd()}\n\n（已折叠 ${count} 个其他 worktree/session owner 的 CHG；见下方 owner 摘要。其他 worktree 或同目录 session 正在执行的 CHG 请勿接手；接手必须有用户明确指令与证据（owner-takeover 三字段）。）\n`;
}

function foldForeignOwnedArtifactOutput(file, output, summaries) {
  const foreignSummaries = foreignOwnedSummariesForInjection(summaries);
  if (foreignSummaries.length === 0) return output;
  const ids = new Set(foreignSummaries.map(s => s.id).filter(Boolean));
  if (ids.size === 0) return output;
  if (file === 'task.md') {
    const filtered = output.split('\n').filter(line => !lineReferencesChangeId(line, ids)).join('\n');
    return appendForeignFoldNote(filtered, ids.size);
  }
  return output;
}

// --- 活跃 CHG 摘要 owner 展示（重构前 341-347）---
function ownerDisplay(summary) {
  const parts = [summary.ownerDisposition || 'unknown'];
  if (summary.ownerWorktree) parts.push(`worktree=${summary.ownerWorktree}`);
  if (summary.ownerBranch) parts.push(`branch=${summary.ownerBranch}`);
  if (summary.ownerState) parts.push(`state=${summary.ownerState}`);
  // CHG-20260611-02：detached 即原 session 正常关闭，提示可经用户确认接手。
  if (summary.ownerDisposition === 'sibling-detached') parts.push('（原 session 已关闭，可接手）');
  return parts.join(' ');
}

/** 活跃 CHG 摘要 section（重构前 595-603）。 */
// 跨 CHG 任务本体注入总量上限（chars）——CHG-20260609-03 R 审计 P2：任务本体 push 到 l0，
//   而 assembleWithBudget 只截 l3、head（含 l0）永不截，宣称的第④层「全局兜底」对任务本体无效。
//   自带跨 CHG 累计护栏，防多个 in-progress CHG（含忘 close 的累积）线性撑破 9500/10000。
const TASK_INJECTION_TOTAL_MAX = 3000;
// 活跃 CHG 摘要 header 条数上限（CHG-20260614-10）：30+ 活跃 CHG 下 header 行无界累积撑爆 head
//   → head 超 10K char/hook cap → 整段被 persist 成 2KB preview（上下文恢复残废根因，记忆 claude-hook-output-10k）。
//   summaries 已在 buildLayers 按 running 优先 + CHG-ID 升序排序，超出 N 的以长尾指针收口（保前 N 高优先）。
const ACTIVE_CHG_SUMMARY_MAX = 12;

function renderActiveChangeSummary(state, paceUtils) {
  const allSummaries = state.activeChangeSummaries;
  if (!(allSummaries.length > 0)) return '';
  let out = `=== 活跃 CHG 摘要 ===\n`;
  // header cap（CHG-20260614-10）：只展开前 N 条（buildLayers 已按优先级排序），超出长尾指针收口防 head 无界撑爆。
  const summaries = allSummaries.slice(0, ACTIVE_CHG_SUMMARY_MAX);
  const omittedChg = allSummaries.length - summaries.length;
  let taskBudgetUsed = 0;            // 跨 CHG 任务本体累计 chars（P2 总量护栏）
  let taskBudgetPointerShown = false;
  for (const s of summaries) {
    // C2：status 也过 normalizeFrontmatterStatus 去引号归一（与 category 同源；带引号 frontmatter 否则渲染 status="in-progress"）。
    const statusText = paceUtils.normalizeFrontmatterStatus(s.status);
    out += `- ${s.id} category=${s.category} status=${statusText} owner=${ownerDisplay(s)} task=[${s.taskCheckbox || '?'}] pending=${s.pending ?? '?'} approved=${s.approved} verified=${s.verified} reviewed=${s.reviewed}\n  ${s.path ? s.path.replace(/\\/g, '/') : 'missing detail'}\n`;
    // 任务清单本体展开（CHG-20260609-03 T-001）：collectState 已按相关度把任务行加工成
    //   s.tasks = { items, omitted, mode }（in-progress 完整行含 [状态]，planned 只 T-NNN 标题）。
    //   渲染层做缩进展开 + 跨 CHG 总量护栏；单 CHG 内展开上限/planned 降级已在 collectState 落定。
    if (s.tasks && Array.isArray(s.tasks.items) && s.tasks.items.length > 0) {
      let block = s.tasks.items.map(line => `    ${line}\n`).join('');
      // 超单 CHG 展开上限的剩余任务以指针收口，引导 AI 按需 Read 详情文件取全量。
      if (s.tasks.omitted > 0) block += `    （另有 ${s.tasks.omitted} 个任务，Read changes/${s.slug || (s.id || '').toLowerCase()}.md）\n`;
      // 跨 CHG 总量护栏（P2 修复）：l0 不受 assembleWithBudget 截，超总量后续 CHG 不展开本体、一次性指针收口。
      if (taskBudgetUsed + block.length <= TASK_INJECTION_TOTAL_MAX) {
        out += block;
        taskBudgetUsed += block.length;
      } else if (!taskBudgetPointerShown) {
        out += `    （任务本体注入已达预算上限，其余活跃 CHG 任务见各自 changes/<id>.md）\n`;
        taskBudgetPointerShown = true;
      }
    }
  }
  if (omittedChg > 0) {
    out += `（另有 ${omittedChg} 个活跃 CHG 未在摘要展开，Read task.md 查看全部）\n`;
  }
  out += `状态符号：task=[ ]未开始 [/]进行中 [x]完成 [!]暂停/阻塞 [-]跳过；approved/verified/reviewed 为 C/V/R 阶段标记（完整图例见 Skill(paceflow:artifact-management)）。\n`;
  out += `继续、恢复或收口已有 CHG 前，先 Read 对应 changes/<id>.md，确认任务清单、实施详情和工作记录；本摘要只用于定位，不替代 CHG 详情。\n`;
  out += '\n';
  return out;
}

/** change-set 整体进度 section（重构前 605-629）。 */
function renderChangeSetProgress(state) {
  const summaries = state.activeChangeSummaries;
  const changeSetGroups = new Map();
  for (const s of summaries) {
    if (!s.changeSet || isForeignSummary(s)) continue;
    if (!changeSetGroups.has(s.changeSet)) changeSetGroups.set(s.changeSet, []);
    changeSetGroups.get(s.changeSet).push(s);
  }
  if (!(changeSetGroups.size > 0)) return '';
  let out = `=== change-set 整体进度 ===\n`;
  // group cap（CHG-20260614-10）：change-set 进度同样 push 进 l0，N 个独立 change-set 时无界累积撑大 head；
  //   与活跃 CHG 摘要同标准 cap 前 N 组（Map 保插入序＝buildLayers 已排序的优先序），超出长尾指针收口。
  const groupEntries = [...changeSetGroups].slice(0, ACTIVE_CHG_SUMMARY_MAX);
  const omittedGroups = changeSetGroups.size - groupEntries.length;
  for (const [name, members] of groupEntries) {
    // change-set 进度按阶段序列展示（纯 change-set-seq 升序 → 同 stop.js 成组提醒对称），
    // 不沿用 buildLayers 的 running 优先排序——进度看的是「2/5, 3/5, 4/5, 5/5」阶段顺序。
    members.sort((a, b) =>
      changeSetSeqNum(a.changeSetSeq) - changeSetSeqNum(b.changeSetSeq)
      || String(a.id).localeCompare(String(b.id)));
    const totals = [...new Set(members
      .map(m => { const mm = String(m.changeSetSeq || '').match(/\/(\d+)/); return mm ? Number(mm[1]) : 0; })
      .filter(t => t > 0))];
    const seqs = members.map(m => m.changeSetSeq || m.id).join(', ');
    const totalSuffix = (totals.length === 1 && members.length > 1) ? `，变更集共 ${totals[0]} 个` : '';
    // 区分执行中（running）与待执行——running 不是「待执行」，避免提示 AI 对执行中的 CHG 重复 approve-and-start。
    const runningCount = members.filter(m => m.category === 'running').length;
    const pendingCount = members.length - runningCount;
    const statusDesc = runningCount > 0 ? `还有 ${runningCount} 个执行中 + ${pendingCount} 个待执行` : `还有 ${pendingCount} 个待执行`;
    out += `- change-set ${name}：${statusDesc}（${seqs}）${totalSuffix}\n`;
  }
  if (omittedGroups > 0) {
    out += `（另有 ${omittedGroups} 个 change-set 进度未展开，Read task.md 查看全部）\n`;
  }
  out += `一个 change-set 是一组规划好的可闭环 CHG；逐个 approve-and-start 执行，勿遗漏后续阶段。\n\n`;
  return out;
}

/** 格式合规警告 section（重构前 638-672）。 */
function renderFormatWarnings(state, found, paceUtils) {
  const { ARCHIVE_PATTERN, ARCHIVE_MARKER, FORMAT_SNIPPETS, detectLegacyImplFormat } = paceUtils;
  if (!(state.paceSignal && found.length > 0)) return '';
  const formatWarnings = [];
  // v7 schema 合同（CHG-20260611-09）：SessionStart 兜底渲染——summarize 已透出违规摘要（零额外 IO）。
  for (const s of (state.activeChangeSummaries || [])) {
    if (s.schemaViolation) {
      formatWarnings.push(`${s.id} 不符合 v7 schema 合同：缺失 ${s.schemaViolation.missing.join(', ') || '无'}；多余 ${s.schemaViolation.unknown.join(', ') || '无'}。请派 artifact-writer 修复 frontmatter。`);
    }
  }
  // v7（CHG-20260611-08 T-002）：emoji/表格格式检测从 implementation_plan.md 迁移到 task.md——
  //   task.md 是唯一索引，格式不可解析会让写码门误判「无活跃 CHG」，检测语义必须保留。
  if (state.taskFullCached) {
    const taskArchiveM = state.taskFullCached.match(ARCHIVE_PATTERN);
    const taskActive = taskArchiveM ? state.taskFullCached.slice(0, taskArchiveM.index) : state.taskFullCached;
    const { hasEmoji, hasTable } = detectLegacyImplFormat(taskActive);
    if (hasEmoji) {
      formatWarnings.push(`task.md 使用了 emoji 状态标记，当前索引解析无法识别。${FORMAT_SNIPPETS.formatRule}\n正确格式：${FORMAT_SNIPPETS.taskEntry}`);
    }
    if (hasTable) {
      formatWarnings.push(`task.md 使用了表格格式，当前索引解析无法识别。${FORMAT_SNIPPETS.formatRule}\n正确格式：${FORMAT_SNIPPETS.taskEntry}`);
    }
    const taskArchiveCount = (state.taskFullCached.match(new RegExp(ARCHIVE_PATTERN.source, 'gm')) || []).length;
    if (taskArchiveCount > 1) {
      formatWarnings.push(`task.md 有 ${taskArchiveCount} 个 ${ARCHIVE_MARKER} 标记（应只有 1 个），会导致活跃区识别错误。请删除多余的标记，只保留活跃区与归档区之间的那个`);
    }
  }
  if (!(formatWarnings.length > 0)) return '';
  let out = `\n=== 格式合规警告 ===\n`;
  formatWarnings.forEach((w, i) => { out += `[${i + 1}] ${w}\n`; });
  out += `\n${FORMAT_SNIPPETS.skillRef}\n\n`;
  return out;
}

/**
 * 跨会话提醒 + 桥接 + 执行上下文（重构前 674-755）。
 * @returns {string[]} 各子 section 的文本块（按原顺序）。
 */
function renderCrossSessionAndExecution(state, paceUtils) {
  const { ARCHIVE_PATTERN, logEntry } = paceUtils;
  const blocks = [];
  if (!state.taskFullCached) return blocks;
  try {
    const taskFullCached = state.taskFullCached;
    const archMatch = taskFullCached.match(ARCHIVE_PATTERN);
    const active = archMatch ? taskFullCached.slice(0, archMatch.index) : taskFullCached;

    // 跳过任务提醒（重构前 685-692）。
    const skipped = active.match(/- \[-\] .+/g) || [];
    if (skipped.length > 0) {
      let out = `\n=== 跨会话提醒 ===\ntask.md 有 ${skipped.length} 个跳过的任务（[-]），请用 AskUserQuestion 询问用户这些跳过的任务是否需要重新开启或更新为 [x]：\n`;
      skipped.slice(-3).forEach(t => { out += `  ${t}\n`; });
      out += '\n';
      blocks.push(out);
      pushLog(state, logEntry('SessionStart', 'SKIPPED_REMINDER', { cwd: state.cwd, count: skipped.length }));
    }

    // Superpowers/native plan 桥接检测（重构前 694-706）。
    if (state.paceSignal) {
      const bridgeHint = state.bridgeHint;
      if (bridgeHint) {
        const hasActive = active && /- \[[ \/!]\]/.test(active);
        if (!hasActive) {
          let out = `\n=== Superpowers 桥接提醒 ===\n`;
          out += `检测到计划文件（${bridgeHint.fileList}）但 task.md 无活跃任务。\n`;
          out += `请在派 subagent 前执行桥接：${bridgeHint.bridgeSteps}\n\n`;
          blocks.push(out);
          pushLog(state, logEntry('SessionStart', 'SUPERPOWERS_BRIDGE_HINT', { cwd: state.cwd, plans: bridgeHint.fileList }));
        }
      }
    }

    // v7 未迁移布局提示（CHG-20260611-12 T-002）：task.md 是唯一 CHG 索引；
    // implementation_plan.md 活跃区仍含索引行说明项目尚未迁移，引导用户跑 migrate-v7。
    if (state.unmigratedV6Layout) {
      const mig = state.unmigratedV6Layout;
      let out = `\n=== v7 迁移提示 ===\n`;
      out += `task.md 是唯一 CHG 索引；当前 implementation_plan.md 活跃区仍含索引行（未迁移的 v6 布局）。\n`;
      out += `先预览迁移：node "${mig.script}" --cwd "${mig.cwd}" --dry-run\n`;
      out += `报告确认后去掉 --dry-run 执行（执行前自动备份到 .pace/backups/v7-migration/）。\n\n`;
      blocks.push(out);
      pushLog(state, logEntry('SessionStart', 'V7_MIGRATE_HINT', { cwd: state.cwd }));
    }

    // 前向兼容提示（CHG-20260612-04）：数据 schema 比本插件新，流程门让位中。
    if (state.newerSchemaData) {
      blocks.push(`\n=== 插件升级提示 ===\n检测到 artifact schema ${state.newerSchemaData.maxVersion} 高于当前插件支持的 7.0：流程门已让位（不拦截），但本插件无法正确管理该数据。请升级 PACEflow 插件并 reload 全部 session（含其他 worktree）。\n\n`);
      pushLog(state, logEntry('SessionStart', 'NEWER_SCHEMA_HINT', { cwd: state.cwd }));
    }

    // 执行上下文（重构前 708-753）。
    const currentCategories = new Set(['running']);
    const currentSessionSummaries = state.activeChangeSummaries.filter(s => !isForeignSummary(s));
    const blockedSessionSummaries = currentSessionSummaries.filter(s => s.category === 'blocked');
    // inconsistent 是「索引/详情损坏或状态违例」（detail 缺失 / 索引错位 / active 但已归档或取消等），不是 deferred——
    //   必须独立暴露给 AI 人工核对，不能被 else 兜底成「当前无活跃 CHG」（G：状态机渲染漏判，摘要显示损坏但执行上下文说「无」自相矛盾）。
    const inconsistentSessionSummaries = currentSessionSummaries.filter(s => s.category === 'inconsistent');
    const foreignProgressSummaries = foreignOwnedSummariesForInjection(state.activeChangeSummaries);
    const detailPending = state.activeChangeSummaries
      .filter(s => !isForeignSummary(s))
      .filter(s => currentCategories.has(s.category))
      .reduce((sum, s) => sum + (Number.isFinite(s.pending) ? s.pending : 0), 0);
    const hasCompleted = currentSessionSummaries.some(s => s.category === 'closing-required');
    const hasIndexPending = currentSessionSummaries.some(s => ['backlog', 'ready', 'running', 'blocked', 'closing-required'].includes(s.category));
    if (foreignProgressSummaries.length > 0) {
      let out = `\n=== 其他 worktree/session 活跃 CHG ===\n`;
      for (const s of foreignProgressSummaries.slice(0, 5)) {
        out += `- ${s.id} category=${s.category} owner=${ownerDisplay(s)} pending=${s.pending ?? '?'}\n`;
      }
      if (foreignProgressSummaries.length > 5) out += `- ... 另有 ${foreignProgressSummaries.length - 5} 个\n`;
      out += '这些 CHG 由其他 worktree/session 负责；当前 session 仅显示 owner 摘要。优先回到原 worktree/session，接手必须有用户明确指令与证据。\n\n';
      blocks.push(out);
      pushLog(state, logEntry('SessionStart', 'FOREIGN_CHANGE_OWNER_SUMMARY', {
        cwd: state.cwd,
        count: foreignProgressSummaries.length,
        changes: foreignProgressSummaries.slice(0, 5).map(s => s.id).join(','),
      }));
    }
    if (blockedSessionSummaries.length > 0) {
      let out = `\n=== 暂停/阻塞 CHG ===\n`;
      for (const s of blockedSessionSummaries.slice(0, 5)) {
        out += `- ${s.id} owner=${ownerDisplay(s)} blocked=${s.blocked ?? '?'} pending=${s.pending ?? '?'}\n`;
      }
      if (blockedSessionSummaries.length > 5) out += `- ... 另有 ${blockedSessionSummaries.length - 5} 个\n`;
      out += '这些 CHG 属于 deferred，不计入当前执行中的 T-NNN；恢复前先确认用户意图，必要时派 update-status 将任务重新标为 [/]。\n\n';
      blocks.push(out);
      pushLog(state, logEntry('SessionStart', 'BLOCKED_CHANGE_SUMMARY', {
        cwd: state.cwd,
        count: blockedSessionSummaries.length,
        changes: blockedSessionSummaries.slice(0, 5).map(s => s.id).join(','),
      }));
    }
    // CHG 状态异常段（独立 if，与正常执行上下文并存）：损坏 CHG 必须人工核对，优先级高于「无活跃 CHG」兜底。
    if (inconsistentSessionSummaries.length > 0) {
      let out = `\n=== CHG 状态异常（需人工核对）===\n`;
      for (const s of inconsistentSessionSummaries.slice(0, 5)) {
        out += `- ${s.id} status=${s.status || '?'} ${s.path ? '→ ' + s.path.replace(/\\/g, '/') : 'detail 缺失'}\n`;
      }
      if (inconsistentSessionSummaries.length > 5) out += `- ... 另有 ${inconsistentSessionSummaries.length - 5} 个\n`;
      out += '这些 CHG 索引/详情损坏或状态违例（detail 缺失 / 索引错位 / active 但已归档或取消等），不是 deferred；先人工核对修复，勿当正常活跃 CHG 继续执行。\n\n';
      blocks.push(out);
      pushLog(state, logEntry('SessionStart', 'INCONSISTENT_CHANGE_SUMMARY', {
        cwd: state.cwd,
        count: inconsistentSessionSummaries.length,
        changes: inconsistentSessionSummaries.slice(0, 5).map(s => s.id).join(','),
      }));
    }
    if (detailPending > 0) {
      blocks.push(`\n=== CHG 执行上下文 ===\n任务权威是 changes/<id>.md 的 ## 任务清单；task.md 只是 CHG 索引。\n当前执行中的 CHG 有 ${detailPending} 个未完成 T-NNN；继续前先 Read 对应 changes/<id>.md。Claude 任务面板只是工作记忆，按需要使用。\n\n`);
    } else if (hasCompleted) {
      blocks.push(`\n=== CHG 执行上下文 ===\n活跃索引中有已完成/跳过变更待 close-chg；archive-chg 仅用于已 verified 的单独归档修复。\n\n`);
    } else if (hasIndexPending && state.paceSignal === 'artifact') {
      blocks.push(`\n=== CHG 执行上下文 ===\n当前没有执行中的未完成 T-NNN；backlog / ready / blocked 属于 deferred。Stop 会用可见提醒提示这些 deferred CHG。\n\n`);
    } else if (inconsistentSessionSummaries.length === 0) {
      // 只有 inconsistent CHG 时不注入「无活跃 CHG」——上方「CHG 状态异常」段已说明，避免与摘要自相矛盾误导。
      blocks.push(`\n=== CHG 执行上下文 ===\n当前无活跃 CHG。\n\n`);
    }
  } catch (e) {}
  return blocks;
}

/** Findings 过期提醒 section（重构前 779-783 的输出部分；写 flag 留 effects）。 */
function renderAgedFindings(state) {
  const aged = state.agedFindings;
  if (!aged || !aged.shouldInject || !(aged.aged.length > 0)) return '';
  let out = `\n=== Findings 过期提醒 ===\n以下 findings 超过 14 天未流转，请决定采纳 [x] 或否定 [-]：\n`;
  aged.aged.forEach(f => { out += `  (${f.days}天) ${f.title}\n`; });
  out += '\n';
  return out;
}

/** Git 状态 section（重构前 790-799；M1 A2 加脏文件数 + ahead/behind）。 */
function renderGit(state) {
  if (!state.git) return '';
  const g = state.git;
  let out = `=== Git 状态 ===\n分支: ${g.branch}\n最近提交: ${g.lastCommit}\n`;
  // 脏文件：design §5 A2——有未提交变更时提示数量，干净时显式标注（避免「无信息=不确定」）。
  if (typeof g.dirtyCount === 'number') {
    out += g.dirtyCount > 0 ? `工作区: ${g.dirtyCount} 个文件未提交\n` : `工作区: 干净\n`;
  }
  // ahead/behind：仅有上游且任一 > 0 时渲染，无上游/已同步不噪声。
  if (g.hasUpstream && (g.ahead > 0 || g.behind > 0)) {
    out += `与上游: ahead ${g.ahead} / behind ${g.behind}\n`;
  }
  out += '\n';
  return out;
}

/** 相关讨论 section（CHG-04 重构为两段）：段1「相关知识 (wiki + knowledge)」wiki 提炼 + knowledge raw
 *  各保证名额（wikiMax/knowledgeMax 分别 slice，wiki 不挤光 knowledge）；段2「未成熟想法 (thoughts)」独立段。
 *  scanRelatedNotes 返回三类 kind（wiki/knowledge/thoughts）扁平数组，本函数按 kind 分组 + 各自名额。startup 名额比 compact 大。 */
function renderRelatedNotes(state, eventType) {
  const notes = state.relatedNotes;
  if (!(notes && notes.length > 0)) return '';
  // 按 kind 分组（scanRelatedNotes 返回 wiki 排序后 → knowledge → thoughts 的扁平数组）。
  const wiki = notes.filter(n => n.kind === 'wiki');
  const knowledge = notes.filter(n => n.kind === 'knowledge');
  const thoughts = notes.filter(n => n.kind === 'thoughts');
  // 各类独立名额（分别 slice）——knowledge 不被 wiki 挤光（CHG-04 修复 M5 的 wiki≥5 挤出问题）；thoughts 独立段。
  // N1：去掉 compact?2:3 三元——单 hook 时代 compact 走快照恢复故精简名额省体积；M4 退役快照后 compact 与
  //   startup 同走实时读路径，精简约束已无主，名额统一到 startup（wiki 3 / knowledge 2 / thoughts 3）。
  //   eventType 仍保留为 render 上下文参数（调用方传入，event-aware 语义钩子），当前三类名额与事件无关。
  const wikiMax = 3;
  const knowledgeMax = 2;
  const thoughtsMax = 3;
  let out = '';
  // 段1：相关知识（wiki 提炼 + 未进 wiki 的 knowledge raw，各保证名额）。
  const knowledgeBlock = [...wiki.slice(0, wikiMax), ...knowledge.slice(0, knowledgeMax)];
  if (knowledgeBlock.length > 0) {
    out += `=== 相关知识 (wiki + knowledge) ===\n`;
    knowledgeBlock.forEach(n => {
      const label = n.kind === 'wiki' ? 'wiki' : `knowledge·${n.status}`;
      out += `[${label}] ${n.title}${n.summary ? ' — "' + n.summary + '"' : ''}\n`;
    });
    out += '\n';
  }
  // 段2：未成熟想法（thoughts，不成熟/未实现，独立段明确标注）。
  const thoughtsBlock = thoughts.slice(0, thoughtsMax);
  if (thoughtsBlock.length > 0) {
    out += `=== 未成熟想法 (thoughts) ===\n`;
    thoughtsBlock.forEach(n => {
      out += `[thought·${n.status}] ${n.title}${n.summary ? ' — "' + n.summary + '"' : ''}\n`;
    });
    out += '\n';
  }
  return out;
}

// --- 日志累积助手：layers 是纯函数，把要写的日志推进 state._logs，由编排层统一 flush ---
function pushLog(state, entry) {
  state._logs = state._logs || [];
  state._logs.push(entry);
}

module.exports = { buildLayers, sliceUtf8ToBytes, ownerDisplay, isForeignSummary };
