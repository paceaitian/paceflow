// 确定性 artifact 生成器(CHG-20260815-02/03):把 artifact-writer 指令(agent-references/instructions/*.md +
// artifact-writer-spec.md)从「LLM 照文档写」变成代码模板。每个 build* 只计算 WriteOp 列表(不碰盘),由
// writer-pipeline 经真 hooks 落盘。产物形态与 artifact-writer 逐字节同构:frontmatter 9 key 固定顺序、
// 4 段结构、索引行模板、APPROVED/VERIFIED/REVIEWED 三标记位置、状态机联动。
'use strict';
const fs = require('fs');
const path = require('path');

const paceUtils = require('../../hooks/pace-utils');

// 所有 artifact 读取统一归一为 LF(pre-tool-use.js 会在 Edit 前把 CRLF artifact 落盘归一为 LF,spec §9.1;
// 生成器若按原始 CRLF 切锚点会全部落空——CHG-02/03 审计 P0-1)。写回也一律 LF。
const nl = '\n';
function readLF(file) { return paceUtils.normalizeLineEndings(fs.readFileSync(file, 'utf8')); }

const ARCHIVE_MARKER = '<!-- ARCHIVE -->';
const APPROVED = '<!-- APPROVED -->';
const VERIFIED = '<!-- VERIFIED -->';
const REVIEWED = '<!-- REVIEWED -->';
const CHG_ID_RE = /^(CHG|HOTFIX)-(\d{8})-(\d{2})$/;

class OpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** 本地时间 ISO(带时区偏移),与 artifact-writer 的 `date '+%Y-%m-%dT%H:%M:%S%z'` 同形态 */
function localIsoNow(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
function todayLocal(now = new Date()) { return localIsoNow(now).slice(0, 10); }

function normalizeId(id) {
  const m = String(id || '').trim().toUpperCase().match(CHG_ID_RE);
  return m ? m[0] : '';
}
function idToStem(id) { return id.toLowerCase(); }
function idKind(id) { return id.startsWith('HOTFIX-') ? 'hotfix' : 'change'; }
function idAlias(id) { return idKind(id) === 'hotfix' ? id : id.toLowerCase(); }

/** 英文 kebab-case slug(≤50);title 无 ASCII 词时用 fallback */
function slugify(input, fallback = 'change') {
  const s = String(input || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  const cut = s.length > 50 ? s.slice(0, 50).replace(/-[^-]*$/, '') : s;
  return cut || fallback;
}

/** 任务列表归一:接受 ["T-001: 描述", "描述"] 或 [{id,text}],输出 [{id:'T-001', text}] */
function normalizeTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new OpError('missing-fields', 'tasks 必填且至少 1 项');
  return tasks.map((t, i) => {
    let text = typeof t === 'object' && t ? String(t.text || t.title || '') : String(t || '');
    let id = typeof t === 'object' && t && t.id ? String(t.id) : '';
    const m = text.match(/^\s*(T-\d{3})\s*[:：]?\s*(.*)$/s);
    if (m) { id = id || m[1]; text = m[2]; }
    if (!id) id = `T-${String(i + 1).padStart(3, '0')}`;
    text = text.trim();
    if (!text) throw new OpError('missing-fields', `tasks 第 ${i + 1} 项为空`);
    return { id, text };
  }).map((t, i, arr) => {
    if (arr.findIndex((x) => x.id === t.id) !== i) throw new OpError('format-violation', `tasks 任务编号重复:${t.id}`);
    return t;
  });
}

function taskRange(tasks) {
  return tasks.length === 1 ? `${tasks[0].id}~${tasks[0].id}` : `${tasks[0].id}~${tasks[tasks.length - 1].id}`;
}

function artDirName(artDir) {
  return path.basename(String(artDir).replace(/[\\/]+$/, ''));
}

// ---------------------------------------------------------------------------------------------
// create-chg
// ---------------------------------------------------------------------------------------------

/**
 * @param {{artDir:string, cwd:string}} ctx
 * @param {object} p - reserved_id / reserved_file_prefix / title / tasks / type / slug / background / scope /
 *   technical_decision / related_finding / execution_context / change_set / change_set_seq
 * @returns {{ ops: WriteOp[], id: string, detailRel: string, indexLine: string }}
 */
function buildCreateChg(ctx, p) {
  const id = normalizeId(p.reserved_id);
  if (!id) throw new OpError('hook-deny', 'create_chg 必须带 reserve_artifact_id 预留的 reserved_id(CHG-YYYYMMDD-NN / HOTFIX-YYYYMMDD-NN)');
  const title = String(p.title || '').trim();
  if (!title) throw new OpError('missing-fields', 'missing-fields: title');
  const tasks = normalizeTasks(p.tasks);
  const kind = idKind(id);
  const warnings = [];
  const slugSrc = String(p.slug || '').trim();
  const slug = slugify(slugSrc || title, kind);
  if (!slugSrc && slug === kind) warnings.push(`title 无 ASCII 词且未传 slug,文件名回退为 ${idToStem(id)}-${kind}.md;建议传英文 kebab-case slug(spec create-chg.md「文件名 slug」)`);
  const stem = `${idToStem(id)}-${slug}`;
  const prefix = String(p.reserved_file_prefix || '').replace(/\\/g, '/').replace(/<slug>\.md$/i, '');
  const expectedPrefix = `changes/${idToStem(id)}-`;
  if (prefix && prefix !== expectedPrefix) throw new OpError('format-violation', `reserved_file_prefix(${prefix})与 reserved_id(${id})不匹配`);
  const detailRel = `changes/${stem}.md`;
  const detailAbs = path.join(ctx.artDir, detailRel);
  const taskAbs = path.join(ctx.artDir, 'task.md');
  if (!fs.existsSync(path.join(ctx.artDir, 'changes'))) throw new OpError('not-pace-project', `${path.join(ctx.artDir, 'changes')} 不存在`);
  if (fs.existsSync(detailAbs)) throw new OpError('file-conflict', `目标文件已存在:${detailRel}`);
  const existingForId = fs.readdirSync(path.join(ctx.artDir, 'changes')).filter((f) => f.toLowerCase().startsWith(`${idToStem(id)}-`) || f.toLowerCase() === `${idToStem(id)}.md`);
  if (existingForId.length) throw new OpError('file-conflict', `${id} 已有详情文件:${existingForId.join(', ')}`);

  const changeSet = p.change_set ? String(p.change_set) : null;
  const changeSetSeq = p.change_set_seq ? String(p.change_set_seq) : null;
  const fm = [
    '---',
    'status: planned',
    `date: ${todayLocal()}`,
    `change-set: ${changeSet === null ? 'null' : changeSet}`,
    `change-set-seq: ${changeSetSeq === null ? 'null' : `"${changeSetSeq}"`}`,
    'verified-date: null',
    'reviewed-date: null',
    'archived-date: null',
    `parent-tasks: ["[[${artDirName(ctx.artDir)}/task|task]]"]`,
    'schema-version: "7.0"',
    '---',
  ];
  const body = [
    '',
    `# ${title}`,
    '',
    '## 任务清单',
    '',
    ...tasks.map((t) => `- [ ] ${t.id} ${t.text}`),
    '',
    '## 实施详情',
    '',
    `**背景（Why）**：${String(p.background || '').trim() || '（未提供）'}`,
    '',
    `**范围（What）**：${String(p.scope || '').trim() || '（未提供）'}`,
    '',
    `**技术决策（How）**：${String(p.technical_decision || '').trim() || '（未提供）'}`,
    '',
    '（各任务的实施说明在收口时由 `close-chg implementation-notes` 字段写入，中途可用 `update-chg section=implementation` append；create 阶段任务未实施，不在此预填占位符。）',
    '',
    '## 工作记录',
    '',
    '| 日期 | 完成内容 |',
    '| --- | --- |',
    '',
    '## 关联调研',
    '',
  ];
  const related = String(p.related_finding || '').trim();
  if (related) body.push(`- ${related.startsWith('[[') ? related : `[[${related}]]`} 关联调研`, '');
  const content = `${fm.join('\n')}\n${body.join('\n')}`;

  const execCtx = String(p.execution_context || (paceUtils.executionContextForCwd(ctx.cwd) || {}).text || '').trim();
  const tag = kind === 'hotfix' ? '#hotfix' : '#change';
  const indexLine = `- [ ] [[${stem}|${idAlias(id)}]] ${title} ${tag} [tasks:: ${taskRange(tasks)}]${execCtx ? ` ${execCtx}` : ''}`;
  const taskEdit = insertBeforeArchiveEdit(taskAbs, indexLine);
  return { ops: [{ kind: 'write', file: detailAbs, content }, taskEdit], id, detailRel, indexLine, stem, warnings };
}

/** 索引行插到 <!-- ARCHIVE --> 之前(活跃区末尾),与既有索引行连续、与 ARCHIVE 之间保留一个空行 */
function insertBeforeArchiveEdit(indexAbs, line) {
  if (!fs.existsSync(indexAbs)) throw new OpError('target-not-found', `索引文件不存在:${indexAbs}`);
  const raw = readLF(indexAbs);
  const idx = raw.indexOf(ARCHIVE_MARKER);
  if (idx < 0) throw new OpError('format-violation', `${path.basename(indexAbs)} 缺 ${ARCHIVE_MARKER} 标记`);
  // 以 ARCHIVE 行为锚:old = ARCHIVE 前的空行区 + 标记;new = 索引行 + 空行 + 标记
  const before = raw.slice(0, idx);
  const trailingBlank = before.match(/(\r?\n)+$/);
  const anchorOld = `${trailingBlank ? trailingBlank[0] : ''}${ARCHIVE_MARKER}`;
  // 上一行是索引行 → 紧接(索引行连续);上一行是标题/注释/正文 → 隔一空行
  const prevLine = before.replace(/(\r?\n)+$/, '').split(/\r?\n/).pop() || '';
  const lead = /^- \[[ x/!\-]\] /.test(prevLine) ? nl : `${nl}${nl}`;
  const anchorNew = `${lead}${line}${nl}${nl}${ARCHIVE_MARKER}`;
  return { kind: 'edit', file: indexAbs, oldString: anchorOld, newString: anchorNew, _line: line };
}

// ---------------------------------------------------------------------------------------------
// 详情文件读取与状态机
// ---------------------------------------------------------------------------------------------

function loadDetail(ctx, target) {
  if (!fs.existsSync(path.join(ctx.artDir, 'changes'))) throw new OpError('not-pace-project', `${path.join(ctx.artDir, 'changes')} 不存在`);
  const id = normalizeId(target);
  if (!id) throw new OpError('format-violation', `target 非法:${target}(应为 CHG-YYYYMMDD-NN / HOTFIX-YYYYMMDD-NN)`);
  const fp = paceUtils.detailPathForId(ctx.artDir, id);
  if (!fp || !fs.existsSync(fp)) throw new OpError('target-not-found', `target-not-found: ${id}`);
  const content = readLF(fp);
  return { id, path: fp, stem: path.basename(fp, '.md'), content, fm: paceUtils.parseFrontmatter(content) };
}

function fmValue(fm, key) { return String(fm[key] === undefined ? '' : fm[key]).replace(/^["']|["']$/g, '').trim(); }
function fmIsNull(fm, key) { const v = fmValue(fm, key); return !v || v.toLowerCase() === 'null'; }

/** 替换 frontmatter 某 key 的值(key 恒在,只改值不插行) */
function fmSetOp(detail, key, value) {
  const re = new RegExp(`^${key}:[^\\r\\n]*$`, 'm');
  const m = detail.content.match(re);
  if (!m) throw new OpError('format-violation', `frontmatter 缺 ${key} 行(封闭合同 9 key 恒在)`);
  const line = m[0];
  return { kind: 'edit', file: detail.path, oldString: line, newString: `${key}: ${value}` };
}

function taskSection(content) { return paceUtils.extractTaskSection(content); }

/** 找 `- [<x>] T-NNN` 行 */
function findTaskLine(content, taskId) {
  const sec = taskSection(content);
  const re = new RegExp(`^- \\[([ x/!\\-])\\] ${taskId}\\b[^\\r\\n]*$`, 'm');
  const m = sec.match(re);
  return m ? { line: m[0], status: `[${m[1]}]` } : null;
}

function taskStatuses(content) {
  return (taskSection(content).match(/^- \[([ x/!\-])\] T-\d{3}\b/gm) || []).map((l) => l.slice(3, 4));
}

/** 按 update-chg 规范推算 frontmatter status 联动 */
function deriveStatusAfterTasks(statuses, current) {
  if (statuses.length && statuses.every((s) => s === '-')) return 'cancelled';
  if (statuses.length && statuses.every((s) => s === 'x' || s === '-') && statuses.some((s) => s === 'x')) return 'completed';
  if (statuses.some((s) => s === '/') && current === 'planned') return 'in-progress';
  return current;
}
const STATUS_TO_CHECKBOX = { planned: '[ ]', 'in-progress': '[/]', completed: '[x]', cancelled: '[-]', archived: '[x]' };

/** 读 task.md 目标索引行当前 checkbox(找不到返回 '') */
function currentIndexCheckbox(ctx, detail) {
  const taskAbs = path.join(ctx.artDir, 'task.md');
  if (!fs.existsSync(taskAbs)) return '';
  const raw = readLF(taskAbs);
  const re = new RegExp(`^- (\\[[ x/!\\-]\\]) \\[\\[(?:${escapeRe(detail.stem)}|${escapeRe(idToStem(detail.id))})(?:\\|[^\\]]+)?\\]\\]`, 'm');
  const m = raw.match(re);
  return m ? m[1] : '';
}

/** task.md 索引行 checkbox 联动 op(找 `- [<old>] [[<stem>|…]]` 或 `[[<id-lower>]]`) */
function indexCheckboxOp(ctx, detail, newCheckbox) {
  const taskAbs = path.join(ctx.artDir, 'task.md');
  if (!fs.existsSync(taskAbs)) throw new OpError('target-not-found', 'task.md 不存在');
  const raw = readLF(taskAbs);
  const stem = detail.stem;
  const re = new RegExp(`^- \\[[ x/!\\-]\\] \\[\\[${escapeRe(stem)}(?:\\|[^\\]]+)?\\]\\][^\\r\\n]*$`, 'm');
  let m = raw.match(re);
  if (!m) {
    const re2 = new RegExp(`^- \\[[ x/!\\-]\\] \\[\\[${escapeRe(idToStem(detail.id))}(?:\\|[^\\]]+)?\\]\\][^\\r\\n]*$`, 'm');
    m = raw.match(re2);
  }
  if (!m) throw new OpError('target-not-found', `task.md 找不到 ${detail.id} 的索引行`);
  const line = m[0];
  if (line.startsWith(`- ${newCheckbox} `)) return null;
  return { kind: 'edit', file: taskAbs, oldString: line, newString: `- ${newCheckbox} ${line.slice(6)}` };
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 在最后一个任务行之后插入 APPROVED(与任务行隔一空行,标记后一空行) */
function approvedInsertOp(detail) {
  const sec = taskSection(detail.content);
  if (!sec) throw new OpError('format-violation', '缺 ## 任务清单 段');
  const lines = sec.split(/\r?\n/);
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) if (/^- \[[ x/!\-]\] T-\d{3}\b/.test(lines[i])) lastIdx = i;
  if (lastIdx < 0) throw new OpError('format-violation', '## 任务清单 段无任务行');
  const lastLine = lines[lastIdx];
  // old = 最后任务行 + 紧随其后的空行(若有);new = 任务行 + 空行 + APPROVED + 空行
  const afterIdx = detail.content.indexOf(lastLine) + lastLine.length;
  const after = detail.content.slice(afterIdx);
  const blank = after.match(/^(\r?\n)+/);
  const oldString = `${lastLine}${blank ? blank[0] : ''}`;
  const newString = `${lastLine}${nl}${nl}${APPROVED}${nl}${nl}`;
  return { kind: 'edit', file: detail.path, oldString, newString };
}

/** 在指定标记行之后紧邻插入另一标记(VERIFIED 跟在 APPROVED 后,REVIEWED 跟在 VERIFIED 后) */
function markerAfterOp(detail, anchorMarker, newMarker) {
  const idx = detail.content.indexOf(anchorMarker);
  if (idx < 0) throw new OpError('format-violation', `缺 ${anchorMarker}`);
  return { kind: 'edit', file: detail.path, oldString: anchorMarker, newString: `${anchorMarker}${nl}${newMarker}` };
}

/** 在某 `## 段` 末尾(下一个 `## ` 之前 / EOF)追加若干行 */
function appendToSectionOp(detail, sectionTitle, newLines, { createIfMissing = false, afterSection = '', blankLineBefore = false } = {}) {
  const content = detail.content;
  const headerRe = new RegExp(`^## ${escapeRe(sectionTitle)}[ \\t]*\\r?\\n`, 'm');
  const h = content.match(headerRe);
  if (!h) {
    if (!createIfMissing) throw new OpError('format-violation', `缺 ## ${sectionTitle} 段`);
    // 在 afterSection 段末尾之后新建段
    const anchor = afterSection ? content.match(new RegExp(`^## ${escapeRe(afterSection)}[ \\t]*\\r?\\n`, 'm')) : null;
    if (!anchor) throw new OpError('format-violation', `缺 ## ${afterSection} 段,无法新建 ## ${sectionTitle}`);
    const start = anchor.index + anchor[0].length;
    const rest = content.slice(start);
    const next = rest.search(/^## /m);
    const sectionEnd = next >= 0 ? start + next : content.length;
    const oldString = content.slice(anchor.index, sectionEnd);
    const trimmed = oldString.replace(/(\r?\n)+$/, '');
    const newString = `${trimmed}${nl}${nl}## ${sectionTitle}${nl}${nl}${newLines.join(nl)}${nl}${nl}`;
    return { kind: 'edit', file: detail.path, oldString, newString };
  }
  const start = h.index + h[0].length;
  const rest = content.slice(start);
  const next = rest.search(/^## /m);
  const sectionEnd = next >= 0 ? start + next : content.length;
  const oldString = content.slice(h.index, sectionEnd);
  const trimmed = oldString.replace(/(\r?\n)+$/, '');
  // 表格行紧接上一行;标题/段落类追加(如 ### T-NNN)与前文隔一空行
  const newString = `${trimmed}${nl}${blankLineBefore ? nl : ''}${newLines.join(nl)}${nl}${nl}`;
  return { kind: 'edit', file: detail.path, oldString, newString };
}

// ---------------------------------------------------------------------------------------------
// update-chg
// ---------------------------------------------------------------------------------------------

const UPDATE_ACTIONS = new Set(['approve', 'approve-and-start', 'update-status', 'append', 'verify', 'review']);
const SECTION_TITLES = { tasks: '任务清单', implementation: '实施详情', 'work-record': '工作记录', research: '关联调研' };

/**
 * @returns {{ ops: WriteOp[], id: string, idempotent?: boolean, note?: string }}
 */
function buildUpdateChg(ctx, p) {
  const action = String(p.action || '').trim();
  if (!action) throw new OpError('missing-fields', 'missing-fields: action');
  if (!UPDATE_ACTIONS.has(action)) throw new OpError('format-violation', `action 非法:${action}(MVP 支持 ${[...UPDATE_ACTIONS].join(' / ')};replace 未实现)`);
  const detail = loadDetail(ctx, p.target);
  const status = fmValue(detail.fm, 'status');
  const ops = [];
  const notes = [];

  if (action === 'approve' || action === 'approve-and-start') {
    if (p.approval_confirmed === undefined || p.approval_confirmed === null) throw new OpError('missing-fields', 'missing-fields: approval_confirmed');
    if (p.approval_confirmed !== true && String(p.approval_confirmed).toLowerCase() !== 'true') throw new OpError('format-violation', 'approval_confirmed 必须为 true');
    if (!String(p.approval_source || '').trim()) throw new OpError('missing-fields', 'missing-fields: approval_source');
    if (!String(p.approval_evidence || '').trim()) throw new OpError('missing-fields', 'missing-fields: approval_evidence');
    if (['completed', 'archived', 'cancelled'].includes(status)) throw new OpError('format-violation', `status=${status} 不可批准/开始`);
    if (detail.content.includes(VERIFIED) || !fmIsNull(detail.fm, 'verified-date')) throw new OpError('format-violation', '已 verified 的 CHG 不可再 approve');
    const hasApproved = detail.content.includes(APPROVED);
    if (!hasApproved) ops.push(approvedInsertOp(detail)); else notes.push('already approved');
    if (action === 'approve') {
      return { ops, id: detail.id, idempotent: ops.length === 0, note: notes.join('; ') };
    }
    const taskId = String(p.task_id || '').trim().toUpperCase();
    if (!taskId) throw new OpError('missing-fields', 'missing-fields: task_id');
    const t = findTaskLine(detail.content, taskId);
    if (!t) throw new OpError('target-not-found', `task-id ${taskId} 不在 ## 任务清单`);
    if (!['[ ]', '[/]'].includes(t.status)) throw new OpError('format-violation', `task not startable: ${taskId} 当前 ${t.status}`);
    if (t.status === '[ ]') ops.push({ kind: 'edit', file: detail.path, oldString: t.line, newString: `- [/] ${t.line.slice(6)}` });
    if (status === 'planned') ops.push(fmSetOp(detail, 'status', 'in-progress'));
    const idxOp = indexCheckboxOp(ctx, detail, '[/]');
    if (idxOp) ops.push(idxOp);
    return { ops, id: detail.id, idempotent: ops.length === 0, note: notes.join('; ') };
  }

  if (action === 'update-status') {
    const section = String(p.section || 'tasks');
    if (section !== 'tasks') throw new OpError('format-violation', 'update-status 仅适用于 section=tasks');
    if (status === 'archived' || status === 'cancelled' || !fmIsNull(detail.fm, 'archived-date')) throw new OpError('format-violation', `status=${status} 已是终态(archived-date 已填),不可再改任务状态(审计 P2-3:否则 status 会被打回 completed 而索引仍在归档区)`);
    const taskId = String(p.task_id || '').trim().toUpperCase();
    const ns = normalizeStatusToken(p.new_status);
    if (!taskId || !ns) throw new OpError('missing-fields', 'missing-fields: task_id / new_status');
    if (ns === '[!]' && !String(p.status_reason || '').trim()) throw new OpError('missing-fields', 'new_status=[!] 必须带 status_reason');
    const t = findTaskLine(detail.content, taskId);
    if (!t) throw new OpError('target-not-found', `task-id ${taskId} 不在 ## 任务清单`);
    if (t.status !== ns) ops.push({ kind: 'edit', file: detail.path, oldString: t.line, newString: `- ${ns} ${t.line.slice(6)}` });
    const statuses = taskStatuses(detail.content);
    // 用更新后的状态集推算
    const sec = taskSection(detail.content);
    const ids = (sec.match(/^- \[[ x/!\-]\] (T-\d{3})\b/gm) || []).map((l) => l.replace(/^- \[[ x/!\-]\] /, ''));
    const updated = statuses.map((s, i) => (ids[i] === taskId ? ns.slice(1, 2) : s));
    const newStatus = deriveStatusAfterTasks(updated, status);
    if (newStatus !== status) ops.push(fmSetOp(detail, 'status', newStatus));
    // cancelled 的归档时刻只由 archived-date 承载(schema 合同 cancelled 必填 archived-date;审计 P1-2:否则 Stop 硬拦无出口)
    if (newStatus === 'cancelled' && fmIsNull(detail.fm, 'archived-date')) ops.push(fmSetOp(detail, 'archived-date', localIsoNow()));
    let newCheckbox = null;
    if (ns === '[!]') newCheckbox = '[!]';
    else if (ns === '[/]' && currentIndexCheckbox(ctx, detail) === '[!]') newCheckbox = '[/]'; // 只在从 [!] 恢复时改索引(update-chg.md 步骤 4)
    else if (newStatus !== status) newCheckbox = STATUS_TO_CHECKBOX[newStatus];
    if (newCheckbox) { const idxOp = indexCheckboxOp(ctx, detail, newCheckbox); if (idxOp) ops.push(idxOp); }
    if (ns === '[!]') ops.push(appendToSectionOp(detail, '工作记录', [`| ${todayLocal()} | ${taskId} 暂停/阻塞：${String(p.status_reason).trim().replace(/\|/g, '\\|')} |`]));
    return { ops, id: detail.id, idempotent: ops.length === 0 };
  }

  if (action === 'append') {
    const section = String(p.section || '').trim();
    if (!SECTION_TITLES[section]) throw new OpError('format-violation', `section 非法:${section}`);
    if (section === 'tasks') throw new OpError('format-violation', 'append 不适用于 tasks 段(任务由 update-status 管理)');
    const content = String(p.content || '').trim();
    if (!content) throw new OpError('missing-fields', 'missing-fields: content');
    let lines = content.split(/\r?\n/);
    if (section === 'work-record' && !/^\|/.test(lines[0])) lines = [`| ${todayLocal()} | ${content.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')} |`];
    const lastKnown = ['审查记录', '工作记录'].find((t) => new RegExp(`^## ${t}[ \\t]*\\r?\\n`, 'm').test(detail.content)) || '工作记录';
    ops.push(appendToSectionOp(detail, SECTION_TITLES[section], lines, { createIfMissing: section === 'research', afterSection: lastKnown, blankLineBefore: section !== 'work-record' }));
    return { ops, id: detail.id };
  }

  if (action === 'verify') {
    const summary = String(p.verify_summary || '').trim();
    if (!summary) throw new OpError('missing-fields', 'missing-fields: verify_summary');
    if (status !== 'completed') throw new OpError('format-violation', `verify 要求 status=completed(当前 ${status})`);
    if (!detail.content.includes(APPROVED)) throw new OpError('format-violation', '缺 <!-- APPROVED -->,不可 verify');
    const hasMarker = detail.content.includes(VERIFIED);
    const hasDate = !fmIsNull(detail.fm, 'verified-date');
    if (hasMarker && hasDate) return { ops: [], id: detail.id, idempotent: true, note: 'already verified, no change' };
    if (hasMarker !== hasDate) throw new OpError('format-violation', 'verified-date 与 <!-- VERIFIED --> 不一致');
    ops.push(fmSetOp(detail, 'verified-date', localIsoNow()));
    ops.push(markerAfterOp(detail, APPROVED, VERIFIED));
    ops.push(appendToSectionOp(detail, '工作记录', [`| ${todayLocal()} | 验证通过：${summary.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')} |`]));
    return { ops, id: detail.id };
  }

  if (action === 'review') {
    if (p.review_confirmed !== true && String(p.review_confirmed || '').toLowerCase() !== 'true') throw new OpError(p.review_confirmed === undefined ? 'missing-fields' : 'format-violation', 'review_confirmed 必须为 true');
    const source = String(p.review_source || '').trim();
    const findings = String(p.review_findings || '').trim();
    if (!source || !findings) throw new OpError('missing-fields', 'missing-fields: review_source / review_findings');
    if (status !== 'completed') throw new OpError('format-violation', `review 要求 status=completed(当前 ${status})`);
    if (!detail.content.includes(VERIFIED) || fmIsNull(detail.fm, 'verified-date')) throw new OpError('format-violation', '先验证再审计:缺 VERIFIED/verified-date');
    const hasMarker = detail.content.includes(REVIEWED);
    const hasDate = !fmIsNull(detail.fm, 'reviewed-date');
    if (hasMarker && hasDate) return { ops: [], id: detail.id, idempotent: true, note: 'already reviewed, no change' };
    if (hasMarker !== hasDate) throw new OpError('format-violation', 'reviewed-date 与 <!-- REVIEWED --> 不一致');
    ops.push(fmSetOp(detail, 'reviewed-date', localIsoNow()));
    ops.push(markerAfterOp(detail, VERIFIED, REVIEWED));
    ops.push(...reviewRecordOps(detail, source, findings));
    return { ops, id: detail.id };
  }
  throw new OpError('format-violation', `未处理的 action:${action}`);
}

function reviewRecordOps(detail, source, findings) {
  const row = `| ${todayLocal()} | ${source.replace(/\|/g, '\\|')} | ${findings.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')} |`;
  const has = /^## 审查记录[ \t]*\r?\n/m.test(detail.content);
  if (has) return [appendToSectionOp(detail, '审查记录', [row])];
  return [appendToSectionOp(detail, '审查记录', ['| 日期 | 审计来源 | findings |', '| --- | --- | --- |', row], { createIfMissing: true, afterSection: '工作记录' })];
}

function normalizeStatusToken(v) {
  const s = String(v || '').trim();
  const m = s.match(/^\[?\s*([ x/!\-])\s*\]?$/i);
  if (m) return `[${m[1].toLowerCase()}]`;
  const map = { planned: '[ ]', 'in-progress': '[/]', done: '[x]', completed: '[x]', skipped: '[-]', cancelled: '[-]', blocked: '[!]', paused: '[!]' };
  return map[s.toLowerCase()] || '';
}

module.exports = {
  OpError, buildCreateChg, buildUpdateChg, loadDetail, slugify, normalizeTasks, localIsoNow, todayLocal,
  insertBeforeArchiveEdit, appendToSectionOp, approvedInsertOp, markerAfterOp, indexCheckboxOp, deriveStatusAfterTasks,
  fmSetOp, fmValue, fmIsNull, taskStatuses, findTaskLine, normalizeId, idKind, idAlias, APPROVED, VERIFIED, REVIEWED, ARCHIVE_MARKER,
};

// ---------------------------------------------------------------------------------------------
// close-chg(CHG-20260815-03):一把梭 完成 → VERIFIED → REVIEWED → 归档 → walkthrough
// ---------------------------------------------------------------------------------------------

const PLACEHOLDER_LINE = '（各任务的实施说明在收口时由 `close-chg implementation-notes` 字段写入，中途可用 `update-chg section=implementation` append；create 阶段任务未实施，不在此预填占位符。）';

function requireTrue(p, key, code = 'format-violation') {
  if (p[key] === undefined || p[key] === null) throw new OpError('missing-fields', `missing-fields: ${key}`);
  if (p[key] !== true && String(p[key]).toLowerCase() !== 'true') throw new OpError(code, `${key} 必须为 true`);
}

/** implementation_notes 归一:数组 "T-001: 文本" / 对象 {T-001: 文本} / 多行字符串 */
function normalizeImplNotes(v) {
  const out = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === 'object') { for (const [k, t] of Object.entries(item)) out.push({ id: String(k).toUpperCase(), text: String(t).trim() }); continue; }
      const m = String(item || '').match(/^\s*-?\s*(T-\d{3})\s*[:：]\s*([\s\S]*)$/);
      if (m) out.push({ id: m[1].toUpperCase(), text: m[2].trim() });
    }
  } else if (v && typeof v === 'object') {
    for (const [k, t] of Object.entries(v)) out.push({ id: String(k).toUpperCase(), text: String(t).trim() });
  } else if (typeof v === 'string') {
    for (const line of v.split(/\r?\n/)) {
      const m = line.match(/^\s*-?\s*(T-\d{3})\s*[:：]\s*(.*)$/);
      if (m) out.push({ id: m[1].toUpperCase(), text: m[2].trim() });
    }
  }
  return out.filter((n) => n.text);
}

/**
 * @returns {{ ops: WriteOp[], id: string, extra: string }}
 */
function buildCloseChg(ctx, p) {
  requireTrue(p, 'verification_confirmed');
  requireTrue(p, 'complete_open_tasks');
  requireTrue(p, 'review_confirmed');
  const reviewSource = String(p.review_source || '').trim();
  const reviewFindings = String(p.review_findings || '').trim();
  const verifySummary = String(p.verify_summary || '').trim();
  const walkSummary = String(p.walkthrough_summary || '').trim();
  const notes = normalizeImplNotes(p.implementation_notes);
  const missing = [];
  const detailPeek = loadDetail(ctx, p.target);
  const knownIds = new Set((taskSection(detailPeek.content).match(/^- \[[ x/!\-]\] (T-\d{3})\b/gm) || []).map((l) => l.replace(/^- \[[ x/!\-]\] /, '')));
  const unknown = notes.map((n) => n.id).filter((id) => !knownIds.has(id));
  if (unknown.length) throw new OpError('format-violation', `implementation_notes 含任务清单里不存在的任务:${unknown.join(', ')}`);
  if (!reviewSource) missing.push('review_source');
  if (!reviewFindings) missing.push('review_findings');
  if (!verifySummary) missing.push('verify_summary');
  if (!walkSummary) missing.push('walkthrough_summary');
  if (!notes.length) missing.push('implementation_notes');
  if (missing.length) throw new OpError('missing-fields', `missing-fields: ${missing.join(', ')}`);

  const detail = loadDetail(ctx, p.target);
  const status = fmValue(detail.fm, 'status');
  if (status === 'cancelled') throw new OpError('format-violation', 'cancelled change:改走 archive-chg');
  if (!detail.content.includes(APPROVED)) throw new OpError('format-violation', '缺 <!-- APPROVED -->');
  const hasVer = detail.content.includes(VERIFIED); const hasVerDate = !fmIsNull(detail.fm, 'verified-date');
  if (hasVer !== hasVerDate) throw new OpError('format-violation', 'verification state inconsistent');
  const hasRev = detail.content.includes(REVIEWED); const hasRevDate = !fmIsNull(detail.fm, 'reviewed-date');
  if (hasRev !== hasRevDate) throw new OpError('format-violation', 'review state inconsistent');
  const statuses = taskStatuses(detail.content);
  if (statuses.includes('!')) throw new OpError('format-violation', 'blocked tasks:存在 [!] 任务,先解除阻塞');
  const closed = statuses.map((s) => (s === ' ' || s === '/' ? 'x' : s));
  if (!closed.includes('x')) throw new OpError('format-violation', 'all tasks skipped, use cancelled + archive-chg');

  const taskAbs = path.join(ctx.artDir, 'task.md');
  const walkAbs = path.join(ctx.artDir, 'walkthrough.md');
  if (!fs.existsSync(taskAbs)) throw new OpError('target-not-found', 'task.md 不存在');
  const marker = ensureArchiveMarker(taskAbs, detail);
  const taskRaw = marker.raw; const preOps = marker.ops;

  // 逐步在内存里演化文本(每步产生一个 Edit op,前后连贯),避免多 Edit 锚点互相踩
  let content = detail.content;
  const ops = [];
  const edit = (oldString, newString) => { if (oldString === newString) return; ops.push({ kind: 'edit', file: detail.path, oldString, newString }); content = content.replace(oldString, () => newString); };
  const cur = () => ({ ...detail, content, fm: paceUtils.parseFrontmatter(content) });

  // 1. 任务收口 [ ]/[/] → [x]
  for (const line of (taskSection(content).match(/^- \[[ /]\] T-\d{3}\b[^\r\n]*$/gm) || [])) edit(line, `- [x] ${line.slice(6)}`);
  // 1.5 实施详情执行态记录:删占位行,每任务 ### T-NNN
  if (content.includes(PLACEHOLDER_LINE)) {
    const idx = content.indexOf(PLACEHOLDER_LINE);
    const after = content.slice(idx + PLACEHOLDER_LINE.length).match(/^(\r?\n)+/);
    edit(`${PLACEHOLDER_LINE}${after ? after[0] : ''}`, '');
  }
  const implLines = [];
  for (const n of notes) {
    const hdrRe = new RegExp(`^### ${n.id}[ \\t]*\\r?\\n`, 'm');
    if (hdrRe.test(content)) {
      // 已有标题:在该小节末尾补充(内容一致则跳过)
      const h = content.match(hdrRe); const start = h.index + h[0].length; const rest = content.slice(start); const next = rest.search(/^##+ /m); const end = next >= 0 ? start + next : content.length;
      const block = content.slice(h.index, end);
      if (!block.includes(n.text)) edit(block, `${block.replace(/(\r?\n)+$/, '')}${nl}${nl}${n.text}${nl}${nl}`);
    } else {
      implLines.push(`### ${n.id}`, '', n.text, '');
    }
  }
  if (implLines.length) {
    const d = cur();
    ops.push(appendToSectionOp(d, '实施详情', implLines.slice(0, -1), { blankLineBefore: true }));
    content = content.replace(ops[ops.length - 1].oldString, () => ops[ops.length - 1].newString);
  }
  // 2. status → completed
  const status2 = fmValue(cur().fm, 'status');
  if (status2 !== 'archived' && status2 !== 'completed') { const o = fmSetOp(cur(), 'status', 'completed'); edit(o.oldString, o.newString); }
  // 3. VERIFIED
  if (!content.includes(VERIFIED)) {
    let o = fmSetOp(cur(), 'verified-date', localIsoNow()); edit(o.oldString, o.newString);
    o = markerAfterOp(cur(), APPROVED, VERIFIED); edit(o.oldString, o.newString);
    o = appendToSectionOp(cur(), '工作记录', [`| ${todayLocal()} | 验证通过：${verifySummary.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')} |`]); edit(o.oldString, o.newString);
  }
  // 4. REVIEWED
  if (!content.includes(REVIEWED)) {
    let o = fmSetOp(cur(), 'reviewed-date', localIsoNow()); edit(o.oldString, o.newString);
    o = markerAfterOp(cur(), VERIFIED, REVIEWED); edit(o.oldString, o.newString);
    for (const ro of reviewRecordOps(cur(), reviewSource, reviewFindings)) edit(ro.oldString, ro.newString);
  }
  // 5. archived
  if (fmValue(cur().fm, 'status') !== 'archived') { const o = fmSetOp(cur(), 'status', 'archived'); edit(o.oldString, o.newString); }
  if (fmIsNull(cur().fm, 'archived-date')) { const o = fmSetOp(cur(), 'archived-date', localIsoNow()); edit(o.oldString, o.newString); }

  // 6. task.md:活跃区行移到 ARCHIVE 下方(checkbox [x]);已在归档区则幂等
  const idxOps = archiveIndexOps(taskAbs, taskRaw, detail);
  ops.push(...idxOps.ops);
  // 7. walkthrough.md prepend
  ops.push(...walkthroughOps(walkAbs, detail, walkSummary, idxOps.execCtx));
  const extra = `归档:task.md 索引行移到 ARCHIVE 下方;walkthrough.md 新增一行。`;
  // 补 ARCHIVE 标记必须先于详情归档落盘(hook 拒绝「根索引缺 ARCHIVE 时先把详情归档」),作为独立前置管线
  return { ops, prelude: preOps, id: detail.id, extra };
}

/** spec close-chg/archive-chg §0:task.md 缺 <!-- ARCHIVE --> 但目标活跃索引行存在 → 文件末尾补独占行;两处都没有才拒绝 */
function ensureArchiveMarker(taskAbs, detail) {
  let raw = readLF(taskAbs);
  const ops = [];
  if (!raw.includes(ARCHIVE_MARKER)) {
    const hasRow = new RegExp(`\\[\\[(?:${escapeRe(detail.stem)}|${escapeRe(idToStem(detail.id))})(?:\\|[^\\]]+)?\\]\\]`).test(raw);
    if (!hasRow) throw new OpError('format-violation', 'archive marker missing');
    const tail = raw.match(/(\r?\n)*$/)[0];
    const trimmed = raw.slice(0, raw.length - tail.length);
    const lastLine = trimmed.split(/\r?\n/).pop();
    ops.push({ kind: 'edit', file: taskAbs, oldString: `${lastLine}${tail}`, newString: `${lastLine}${nl}${nl}${ARCHIVE_MARKER}${nl}` });
    raw = `${trimmed}${nl}${nl}${ARCHIVE_MARKER}${nl}`;
  }
  return { raw, ops };
}

function archiveIndexOps(taskAbs, raw, detail, finalCheckbox = '[x]') {
  const stem = detail.stem;
  const lineRe = new RegExp(`^- \\[[ x/!\\-]\\] \\[\\[(?:${escapeRe(stem)}|${escapeRe(idToStem(detail.id))})(?:\\|[^\\]]+)?\\]\\][^\\r\\n]*$`, 'm');
  const archiveIdx = raw.indexOf(ARCHIVE_MARKER);
  const activePart = raw.slice(0, archiveIdx);
  const archivedPart = raw.slice(archiveIdx);
  const execCtxOf = (line) => (line.match(/\[worktree::[^\]]*\](?:\s*\[branch::[^\]]*\])?/) || [''])[0];
  const mActive = activePart.match(lineRe);
  if (mActive) {
    const line = mActive[0];
    const archivedLine = `- ${finalCheckbox} ${line.slice(6)}`;
    const ops = [];
    // 删活跃行(连同其换行)
    const withNl = raw.includes(`${line}${nl}`) ? `${line}${nl}` : line;
    ops.push({ kind: 'edit', file: taskAbs, oldString: withNl, newString: '' });
    // 插到 ARCHIVE 标记下一行
    ops.push({ kind: 'edit', file: taskAbs, oldString: `${ARCHIVE_MARKER}`, newString: `${ARCHIVE_MARKER}${nl}${archivedLine}` });
    return { ops, execCtx: execCtxOf(line) };
  }
  const mArchived = archivedPart.match(lineRe);
  if (mArchived) return { ops: [], execCtx: execCtxOf(mArchived[0]) };
  throw new OpError('format-violation', 'index row not found');
}

function walkthroughOps(walkAbs, detail, summary, execCtx) {
  if (!fs.existsSync(walkAbs)) throw new OpError('target-not-found', 'walkthrough.md 不存在');
  const raw = readLF(walkAbs);
  const stem = detail.stem;
  const alias = detail.stem === idToStem(detail.id) ? '' : `\\|${idAlias(detail.id)}`;
  const link = alias ? `[[${stem}${alias}]]` : `[[${stem}]]`;
  const already = raw.split(/\r?\n/).find((l) => l.includes(`[[${stem}`) && l.trim().endsWith(`| ${detail.id} |`));
  if (already) {
    if (execCtx && !already.includes(execCtx)) {
      const cells = already.split(' | ');
      // 在完成内容列末尾补上下文
      const fixed = already.replace(new RegExp(`\\s*\\| ${escapeRe(detail.id)} \\|$`), ` ${execCtx} | ${detail.id} |`);
      return [{ kind: 'edit', file: walkAbs, oldString: already, newString: fixed }];
    }
    return [];
  }
  const row = `| ${todayLocal()} | ${link} ${summary.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')}${execCtx ? ` ${execCtx}` : ''} | ${detail.id} |`;
  // 锚点必须全文唯一(Edit 语义):归档区可能也保留了一份表头+分隔行(审计 P1-1),故用「## 最近工作 标题 … 分隔行」
  // 整段作为锚点(标题唯一);无表头时在标题下补表头
  const hdr = raw.match(/^## 最近工作[ \t]*\r?\n/m);
  if (!hdr) throw new OpError('format-violation', 'walkthrough.md 缺 ## 最近工作');
  const afterHdr = raw.slice(hdr.index + hdr[0].length);
  const sepIn = afterHdr.match(/^(?:[ \t]*\r?\n)*\| 日期 \| 完成内容 \| 关联变更 \|[ \t]*\r?\n\| --- \| --- \| --- \|[ \t]*\r?\n/);
  if (sepIn) {
    const anchor = `${hdr[0]}${sepIn[0]}`;
    return [{ kind: 'edit', file: walkAbs, oldString: anchor, newString: `${anchor}${row}${nl}` }];
  }
  return [{ kind: 'edit', file: walkAbs, oldString: hdr[0], newString: `${hdr[0]}${nl}| 日期 | 完成内容 | 关联变更 |${nl}| --- | --- | --- |${nl}${row}${nl}` }];
}

// ---------------------------------------------------------------------------------------------
// archive-chg(审计 P1-2:cancelled 在 Codex 上无归档出口 → 补最小实现;index-only 归档 / 取消式归档 / repair)
// ---------------------------------------------------------------------------------------------

function buildArchiveChg(ctx, p) {
  const walkSummary = String(p.walkthrough_summary || '').trim();
  if (!walkSummary) throw new OpError('missing-fields', 'missing-fields: walkthrough_summary');
  const detail = loadDetail(ctx, p.target);
  const status = fmValue(detail.fm, 'status');
  if (!['completed', 'archived', 'cancelled'].includes(status)) throw new OpError('format-violation', `status not terminal:${status}(planned/in-progress 请先 close_chg 或 update-status)`);
  const statuses = taskStatuses(detail.content);
  if (statuses.some((s) => s === ' ' || s === '/')) throw new OpError('format-violation', 'tasks not done:存在 [ ]/[/] 任务');
  if (statuses.some((s) => s === '!')) throw new OpError('format-violation', 'blocked tasks:存在 [!] 任务');
  if (status === 'cancelled' && statuses.some((s) => s !== '-')) throw new OpError('format-violation', 'cancelled tasks not all skipped');
  const hasVer = detail.content.includes(VERIFIED); const hasVerDate = !fmIsNull(detail.fm, 'verified-date');
  const hasRev = detail.content.includes(REVIEWED); const hasRevDate = !fmIsNull(detail.fm, 'reviewed-date');
  if (status !== 'cancelled') {
    if (hasVer !== hasVerDate) throw new OpError('format-violation', 'verification state inconsistent');
    if (!hasVer) throw new OpError('format-violation', 'not verified:请验证通过后用 close_chg,或先 update_chg action=verify');
    if (hasRev !== hasRevDate) throw new OpError('format-violation', 'review state inconsistent');
    if (!hasRev) throw new OpError('format-violation', 'not reviewed:请编排对抗审计后用 close_chg,或先 update_chg action=review');
  }
  const taskAbs = path.join(ctx.artDir, 'task.md');
  const walkAbs = path.join(ctx.artDir, 'walkthrough.md');
  if (!fs.existsSync(taskAbs)) throw new OpError('target-not-found', 'task.md 不存在');
  const ops = [];
  if (status === 'completed') ops.push(fmSetOp(detail, 'status', 'archived'));
  if (fmIsNull(detail.fm, 'archived-date')) ops.push(fmSetOp(detail, 'archived-date', localIsoNow()));
  const marker = ensureArchiveMarker(taskAbs, detail);
  const idxOps = archiveIndexOps(taskAbs, marker.raw, detail, status === 'cancelled' ? '[-]' : '[x]');
  ops.push(...idxOps.ops);
  ops.push(...walkthroughOps(walkAbs, detail, walkSummary, idxOps.execCtx));
  return { ops, prelude: marker.ops, id: detail.id, extra: status === 'cancelled' ? '取消式归档:索引行 [-] 移到 ARCHIVE 下方,verified/reviewed 保持 null。' : `归档:status→archived,索引行移到 ARCHIVE 下方,walkthrough 行已补。` };
}

// ---------------------------------------------------------------------------------------------
// record-finding(CHG-20260815-03)
// ---------------------------------------------------------------------------------------------

const FINDING_TYPES = new Set(['research', 'observation', 'comparison', 'bug-report']);
const FINDING_STATUS_CHECKBOX = { open: '[ ]', investigating: '[/]', accepted: '[x]', rejected: '[-]', merged: '[-]', blocked: '[!]' };

function buildRecordFinding(ctx, p) {
  const title = String(p.title || '').trim();
  const summary = String(p.summary || '').trim();
  const type = String(p.type || '').trim();
  const impact = String(p.impact || '').trim().toUpperCase();
  const body = typeof p.body === 'string' ? p.body : '';
  const status = String(p.status || 'open').trim();
  const missing = [];
  if (!title) missing.push('title'); if (!summary) missing.push('summary'); if (!type) missing.push('type'); if (!impact) missing.push('impact'); if (!body.trim()) missing.push('body');
  if (missing.length) throw new OpError('missing-fields', `missing-fields: ${missing.join(', ')}`);
  if ([...summary].length > 200) throw new OpError('format-violation', `summary 超过 200 字符(${[...summary].length})`);
  if (!FINDING_TYPES.has(type)) throw new OpError('format-violation', `type 非法:${type}(research | observation | comparison | bug-report)`);
  if (!/^P[0-3]$/.test(impact)) throw new OpError('format-violation', `impact 非法:${impact}(P0-P3)`);
  if (!FINDING_STATUS_CHECKBOX[status]) throw new OpError('format-violation', `status 非法:${status}`);
  const rejection = String(p.rejection_reason || '').trim();
  if (status === 'rejected' && [...rejection].length < 10) throw new OpError('missing-fields', 'status=rejected 必须带 rejection_reason(≥10 字符)');
  if (!fs.existsSync(path.join(ctx.artDir, 'changes'))) throw new OpError('not-pace-project', 'changes/ 不存在');

  const date = todayLocal();
  const slug = slugify(p.slug || title, 'finding');
  const findingsDir = path.join(ctx.artDir, 'changes', 'findings');
  let stem = `finding-${date}-${slug}`;
  let n = 2;
  while (fs.existsSync(path.join(findingsDir, `${stem}.md`))) { stem = `finding-${date}-${slug}-${n}`; n += 1; }
  const detailAbs = path.join(findingsDir, `${stem}.md`);
  const idxAbs = path.join(ctx.artDir, 'findings.md');
  if (!fs.existsSync(idxAbs)) throw new OpError('target-not-found', 'findings.md 不存在');

  const bodyNorm = body.replace(/\r\n/g, '\n');
  const parts = ['---', `status: ${status}`, `date: ${date}`, 'schema-version: "7.0"', '---', '', `# ${title}`, '', bodyNorm.replace(/\n+$/, ''), ''];
  if (status === 'rejected') parts.push('## 拒绝理由', '', rejection, '');
  const content = parts.join('\n');

  const meta = [`[date:: ${date}]`, `[impact:: ${impact}]`, `[type:: ${type}]`];
  const related = normalizeLinkList(p.related_changes).map((l) => resolveChangeLink(ctx, l));
  if (related.length) meta.push(`[change:: ${related.join(', ')}]`);
  const merges = normalizeLinkList(p.merges);
  if (merges.length) meta.push(`[merges:: ${merges.join(', ')}]`);
  // wikilink 别名内 `|` 与 `]]` 会切坏链接:| 换全角｜,]] 拆成 ] ](保留可读性,不静默改写为其他字符——审计 P3-3)
  const safeTitle = title.replace(/\|/g, '｜').replace(/\]\]/g, '] ]');
  const line = `- ${FINDING_STATUS_CHECKBOX[status]} [[${stem}|${safeTitle}]] — ${summary.replace(/\r?\n/g, ' ').replace(/\|/g, '｜')} #finding ${meta.join(' ')}`;
  return { ops: [{ kind: 'write', file: detailAbs, content }, findingIndexInsertOp(idxAbs, line)], id: stem.toUpperCase(), stem, extra: `索引行：\`${line}\`` };
}

/** `[[CHG-…]]` 形态的关联 CHG 解析为详情文件全名 + 纯 ID 别名(spec §5.4);找不到详情文件时原样保留 */
function resolveChangeLink(ctx, link) {
  const inner = String(link).replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();
  const id = normalizeId(inner);
  if (!id) return link;
  const fp = paceUtils.detailPathForId(ctx.artDir, id);
  if (!fp || !fs.existsSync(fp)) return `[[${idToStem(id)}]]`;
  const stem = path.basename(fp, '.md');
  return stem === idToStem(id) ? `[[${stem}]]` : `[[${stem}|${idAlias(id)}]]`;
}

function normalizeLinkList(v) {
  const arr = Array.isArray(v) ? v : (v ? String(v).split(/[,，]/) : []);
  return arr.map((s) => String(s).trim()).filter(Boolean).map((s) => (s.startsWith('[[') ? s : `[[${s}]]`));
}

/** findings.md:插到活跃区第一个 finding 索引行之前;无索引行时插到活跃区最后一个标题下方 */
function findingIndexInsertOp(idxAbs, line) {
  const raw = readLF(idxAbs);
  const archiveIdx = raw.indexOf(ARCHIVE_MARKER);
  const active = archiveIdx >= 0 ? raw.slice(0, archiveIdx) : raw;
  const first = active.match(/^- \[[ x/!\-]\] \[\[finding-[^\r\n]*$/m);
  if (first) {
    // 索引行文本理论上唯一;若归档区有一模一样的行,带上前一行做锚点
    if (raw.indexOf(first[0]) !== raw.lastIndexOf(first[0])) {
      const before = raw.slice(0, raw.indexOf(first[0]));
      const prevLine = before.replace(/(\r?\n)+$/, '').split(/\r?\n/).pop() || '';
      const anchor = `${prevLine}${nl}${nl}${first[0]}`;
      if (raw.includes(anchor)) return { kind: 'edit', file: idxAbs, oldString: anchor, newString: `${prevLine}${nl}${nl}${line}${nl}${first[0]}` };
    }
    return { kind: 'edit', file: idxAbs, oldString: first[0], newString: `${line}${nl}${first[0]}` };
  }
  // 活跃区无 finding 行:插到 <!-- ARCHIVE --> 之前(全文唯一锚点;审计 P2-1:标题在归档区可能重复)
  if (archiveIdx >= 0) return insertBeforeArchiveEdit(idxAbs, line);
  const headings = [...active.matchAll(/^##+ [^\r\n]*\r?\n/gm)];
  if (!headings.length) throw new OpError('format-violation', 'findings.md 活跃区无标题可锚定');
  const last = headings[headings.length - 1];
  if (raw.indexOf(last[0]) !== raw.lastIndexOf(last[0])) throw new OpError('format-violation', `findings.md 标题「${last[0].trim()}」不唯一且无 <!-- ARCHIVE --> 标记,无法定位插入点`);
  return { kind: 'edit', file: idxAbs, oldString: last[0], newString: `${last[0]}${nl}${line}${nl}` };
}

module.exports.buildCloseChg = buildCloseChg;
module.exports.buildArchiveChg = buildArchiveChg;
module.exports.buildRecordFinding = buildRecordFinding;
module.exports.normalizeImplNotes = normalizeImplNotes;
module.exports.PLACEHOLDER_LINE = PLACEHOLDER_LINE;
