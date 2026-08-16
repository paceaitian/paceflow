// 确定性 artifact 生成器(CHG-20260815-02/03):把 artifact-writer 指令(agent-references/instructions/*.md +
// artifact-writer-spec.md)从「LLM 照文档写」变成代码模板。每个 build* 只计算 WriteOp 列表(不碰盘),由
// writer-pipeline 经真 hooks 落盘。产物形态与 artifact-writer 逐字节同构:frontmatter 9 key 固定顺序、
// 4 段结构、索引行模板、APPROVED/VERIFIED/REVIEWED 三标记位置、状态机联动。
'use strict';
const fs = require('fs');
const path = require('path');

const paceUtils = require('../../hooks/pace-utils');

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
  const stem = `${idToStem(id)}-${slugify(p.slug || title, kind)}`;
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
  return { ops: [{ kind: 'write', file: detailAbs, content }, taskEdit], id, detailRel, indexLine, stem };
}

/** 索引行插到 <!-- ARCHIVE --> 之前(活跃区末尾),与既有索引行连续、与 ARCHIVE 之间保留一个空行 */
function insertBeforeArchiveEdit(indexAbs, line) {
  if (!fs.existsSync(indexAbs)) throw new OpError('target-not-found', `索引文件不存在:${indexAbs}`);
  const raw = fs.readFileSync(indexAbs, 'utf8');
  const idx = raw.indexOf(ARCHIVE_MARKER);
  if (idx < 0) throw new OpError('format-violation', `${path.basename(indexAbs)} 缺 ${ARCHIVE_MARKER} 标记`);
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
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
  const id = normalizeId(target);
  if (!id) throw new OpError('format-violation', `target 非法:${target}(应为 CHG-YYYYMMDD-NN / HOTFIX-YYYYMMDD-NN)`);
  const fp = paceUtils.detailPathForId(ctx.artDir, id);
  if (!fp || !fs.existsSync(fp)) throw new OpError('target-not-found', `target-not-found: ${id}`);
  const content = fs.readFileSync(fp, 'utf8');
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

/** task.md 索引行 checkbox 联动 op(找 `- [<old>] [[<stem>|…]]` 或 `[[<id-lower>]]`) */
function indexCheckboxOp(ctx, detail, newCheckbox) {
  const taskAbs = path.join(ctx.artDir, 'task.md');
  if (!fs.existsSync(taskAbs)) throw new OpError('target-not-found', 'task.md 不存在');
  const raw = fs.readFileSync(taskAbs, 'utf8');
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
  const nl = detail.content.includes('\r\n') ? '\r\n' : '\n';
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
  const nl = detail.content.includes('\r\n') ? '\r\n' : '\n';
  return { kind: 'edit', file: detail.path, oldString: anchorMarker, newString: `${anchorMarker}${nl}${newMarker}` };
}

/** 在某 `## 段` 末尾(下一个 `## ` 之前 / EOF)追加若干行 */
function appendToSectionOp(detail, sectionTitle, newLines, { createIfMissing = false, afterSection = '' } = {}) {
  const nl = detail.content.includes('\r\n') ? '\r\n' : '\n';
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
  const newString = `${trimmed}${nl}${newLines.join(nl)}${nl}${next >= 0 ? nl : nl}`;
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
    let newCheckbox = null;
    if (ns === '[!]') newCheckbox = '[!]';
    else if (ns === '[/]') newCheckbox = '[/]';
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
    ops.push(appendToSectionOp(detail, SECTION_TITLES[section], lines, { createIfMissing: section === 'research', afterSection: '工作记录' }));
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
