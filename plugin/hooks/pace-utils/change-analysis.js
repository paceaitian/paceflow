const fs = require('fs');
const path = require('path');
const {
  normalizeChangeId,
  detailPathForId,
  slugForChangeId,
} = require('./change-id');

const COUNT_RE_PENDING = /- \[[ \/!]\]/g;
const COUNT_RE_PENDING_TOP = /^- \[[ \/!]\]/gm;
const COUNT_RE_DONE = /- \[[x-]\]/g;
const COUNT_RE_DONE_TOP = /^- \[[x-]\]/gm;

module.exports = function createChangeAnalysis(ctx) {
  function countByStatus(text, { topLevelOnly = false } = {}) {
    const pending = (text.match(topLevelOnly ? COUNT_RE_PENDING_TOP : COUNT_RE_PENDING) || []).length;
    const done = (text.match(topLevelOnly ? COUNT_RE_DONE_TOP : COUNT_RE_DONE) || []).length;
    return { pending, done, total: pending + done };
  }

  function extractOpenKeys(text) {
    const keys = [];
    (text.match(/^- \[ \] ([^—\n]+)/gm) || []).forEach(line => {
      keys.push(normalizeFindingKey(line.replace(/^- \[ \] /, '').trim()));
    });
    return keys;
  }

  function normalizeFindingKey(value) {
    let text = String(value || '').trim();
    const wikilink = text.match(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/);
    if (wikilink) text = (wikilink[2] || wikilink[1]).trim();
    return text.replace(/\s+/g, ' ').toLowerCase();
  }

  function detectLegacyImplFormat(text) {
    const hasEmoji = /^- \[.\].*[✅❌📋🔄⏳]/m.test(text);
    const hasTable = /^\|.+\|$/m.test(text) && !/^- \[.\]/m.test(text);
    return { hasEmoji, hasTable };
  }

  function parseFrontmatter(content) {
    const match = content && content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    const out = {};
    for (const line of match[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  }

  function contextMarkerSpecsFromLine(line) {
    const specs = [];
    const seen = new Set();
    const re = /\[(worktree|branch)\s*::\s*([^\]\r\n]+?)\s*\]/gi;
    let m;
    while ((m = re.exec(String(line || ''))) !== null) {
      const kind = String(m[1] || '').toLowerCase();
      const value = String(m[2] || '').trim().replace(/\s+/g, ' ');
      if (!kind || !value || seen.has(kind)) continue;
      seen.add(kind);
      specs.push({ kind, value, marker: `[${kind}:: ${value}]` });
    }
    return specs.sort((a, b) => ['worktree', 'branch'].indexOf(a.kind) - ['worktree', 'branch'].indexOf(b.kind));
  }

  function lineReferencesChangeId(line, id, slug) {
    const text = String(line || '');
    const expectedId = normalizeChangeId(id);
    const expectedSlug = String(slug || slugForChangeId(expectedId)).toLowerCase();
    if (!expectedId || !expectedSlug) return false;
    const slugRe = new RegExp(`\\[\\[${ctx.escapeRegex(expectedSlug)}(?:\\|[^\\]]+)?\\]\\]`, 'i');
    const idRe = new RegExp(`\\b${ctx.escapeRegex(expectedId)}\\b`, 'i');
    return slugRe.test(text) || idRe.test(text);
  }

  function walkthroughContextForChange(cwd, id) {
    const expectedId = normalizeChangeId(id);
    const expectedSlug = slugForChangeId(expectedId);
    if (!expectedId || !expectedSlug) return [];
    const byKind = new Map();
    // v7（CHG-20260611-08 T-002）：task.md 是唯一索引，执行上下文只从它提取。
    for (const file of ['task.md']) {
      const full = ctx.readFull(cwd, file) || '';
      for (const line of String(full || '').split(/\r?\n/)) {
        if (!lineReferencesChangeId(line, expectedId, expectedSlug)) continue;
        for (const spec of contextMarkerSpecsFromLine(line)) {
          if (!byKind.has(spec.kind)) byKind.set(spec.kind, spec);
        }
      }
    }
    return ['worktree', 'branch'].map(kind => byKind.get(kind)).filter(Boolean);
  }

  function textHasContextMarker(text, spec) {
    if (!spec || !spec.kind || !spec.value) return true;
    const valuePattern = ctx.escapeRegex(spec.value).replace(/\\ /g, '\\s+');
    const re = new RegExp(`\\[${ctx.escapeRegex(spec.kind)}\\s*::\\s*${valuePattern}\\s*\\]`, 'i');
    return re.test(String(text || ''));
  }

  function validateWalkthroughLinks(cwd) {
    const artDir = ctx.getArtifactDir(cwd);
    const active = ctx.readActive(cwd, 'walkthrough.md');
    if (active === null) return [];
    const issues = [];
    for (const line of String(active || '').split(/\r?\n/)) {
      if (!/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) continue;
      // HOTFIX-20260610-01：表格内 wikilink 别名必须写 \|（否则裸 | 把表格切出多余列）。
      //   切列前把 \| 占位保护，cell 内还原为裸 |，让下方 wikilink 正则按标准 [[target|alias]] 形态解析。
      const cells = line.replace(/\\\|/g, '\u0001').split('|').slice(1, -1)
        .map(cell => cell.trim().replace(/\u0001/g, '|'));
      if (cells.length < 3) continue;
      const summaryCell = cells[1] || '';
      const id = (cells[2] || '').match(/\b(CHG|HOTFIX)-\d{8}-\d{2}\b/i);
      if (!id) continue;
      const expectedId = id[0].toUpperCase();
      const expectedSlug = slugForChangeId(expectedId);
      // 合法 target：纯 ID（旧无 slug 文件）或当前详情文件 stem 全名（带 slug 文件）。
      const detailFp = detailPathForId(artDir, expectedId);
      const detailStem = detailFp ? path.basename(detailFp, '.md').toLowerCase() : '';
      const expectedDisplay = detailStem && detailStem !== expectedSlug ? `${detailStem}\\|${expectedSlug}` : expectedSlug;
      const link = summaryCell.match(/\[\[([^|\]#]+)(?:#[^|\]]+)?(?:\|[^\]]+)?\]\]/);
      let linkMatchesExpected = false;
      if (!link) {
        // R 审计 P3-2：cell 含 [[ 但 match 失败多半是表格内别名分隔符未转义（裸 | 把 wikilink 切到了下一列）。
        issues.push(summaryCell.includes('[[')
          ? `walkthrough.md 行 ${expectedId} 的 wikilink 别名分隔符未转义（表格内必须写 \\|），应为 [[${expectedDisplay}]]。`
          : `walkthrough.md 行 ${expectedId} 缺少 wikilink，应为 [[${expectedDisplay}]]。`);
      } else {
        const target = String(link[1] || '').trim().toLowerCase();
        // CHG-20260611-01 收紧：详情文件存在时唯一合法 target 是其 stem 全名——纯 ID 指向带 slug
        //   文件名在 Obsidian 是死链（旧无 slug 文件 stem=纯 ID 天然兼容）；详情文件缺失时退回
        //   纯 ID 校验，缺失本身由下方 detail-missing issue 单独报。
        const validTarget = detailStem || expectedSlug;
        if (target !== validTarget) {
          issues.push(`walkthrough.md 行 ${expectedId} 的 wikilink 应为 [[${expectedDisplay}]]，当前为 [[${target}]]。`);
        } else {
          linkMatchesExpected = true;
        }
      }
      const detailPath = detailPathForId(artDir, expectedId);
      if (detailPath && !fs.existsSync(detailPath)) {
        const linkHint = linkMatchesExpected ? `指向 [[${expectedSlug}]]，但` : `应指向 [[${expectedSlug}]]，且`;
        issues.push(`walkthrough.md 行 ${expectedId} ${linkHint}详情文件不存在：changes/${expectedSlug}.md（或带 slug 的 ${expectedSlug}-*.md）。`);
      }
      const expectedContext = walkthroughContextForChange(cwd, expectedId);
      const missingContext = expectedContext.filter(spec => !textHasContextMarker(summaryCell, spec));
      if (missingContext.length > 0) {
        issues.push(`walkthrough.md 行 ${expectedId} 缺少执行上下文 ${missingContext.map(spec => spec.marker).join(' ')}，应与 task.md 索引行一致；请派 artifact-writer close-chg 或 archive-chg 补齐。`);
      }
    }
    return issues;
  }

  function parseChangeIndex(activeText) {
    const entries = [];
    // HOTFIX-20260610-01：wikilink 支持带 slug 全名（chg-yyyymmdd-nn-<slug>）+ 可选 |别名。
    //   组 2 捕获纯 ID 部分（id 推导用），组 3 捕获可选 slug 段（slug 字段拼出文件 stem 全名，
    //   供 task.md 索引解析与 changes/<slug>.md 路径提示）。旧纯 ID 形态（无 slug 段）继续兼容。
    const lineRe = /^- \[([ x\/!\-])\]\s+\[\[((?:chg|hotfix)-\d{8}-\d{2})(-[a-z0-9][a-z0-9-]*)?(?:\|[^\]]+)?\]\]\s*(.*)$/i;
    const malformedRe = /^(.+)- \[([ x\/!\-])\]\s+\[\[((?:chg|hotfix)-\d{8}-\d{2})(-[a-z0-9][a-z0-9-]*)?(?:\|[^\]]+)?\]\]\s*(.*)$/i;
    for (const line of String(activeText || '').split(/\r?\n/)) {
      let checkbox, idPart, slugPart, rest, malformed;
      const m = line.match(lineRe);
      if (m) {
        [, checkbox, idPart, slugPart, rest] = m;
        malformed = false;
      } else {
        const embedded = line.match(malformedRe);
        if (!embedded) continue;
        [, , checkbox, idPart, slugPart, rest] = embedded;
        malformed = true;
      }
      const idLower = idPart.toLowerCase();
      const slug = `${idLower}${(slugPart || '').toLowerCase()}`;
      const id = idLower.startsWith('chg-')
        ? `CHG-${idLower.slice(4).toUpperCase()}`
        : `HOTFIX-${idLower.slice(7).toUpperCase()}`;
      entries.push({ checkbox: checkbox.toLowerCase(), slug, id, rest: (rest || '').trim(), line, malformed });
    }
    return entries;
  }

  function readChangeDetail(cwd, idOrSlug) {
    const artDir = ctx.getArtifactDir(cwd);
    const fp = detailPathForId(artDir, idOrSlug);
    if (!fp) return null;
    try {
      const content = fs.readFileSync(fp, 'utf8');
      return { path: fp, content, frontmatter: parseFrontmatter(content) };
    } catch(e) {
      return { path: fp, missing: true, content: '', frontmatter: {} };
    }
  }

  function extractTaskSection(content) {
    const text = content || '';
    const header = text.match(/^## 任务清单\r?\n/m);
    if (!header) return '';
    const start = header.index + header[0].length;
    const rest = text.slice(start);
    const next = rest.search(/^## /m);
    return next >= 0 ? rest.slice(0, next) : rest;
  }

  function countDetailTasks(content) {
    const section = extractTaskSection(content);
    const pending = (section.match(/^- \[[ \/!]\]\s+T-\d{3}\b/gm) || []).length;
    const done = (section.match(/^- \[(?:x|-)\]\s+T-\d{3}\b/gm) || []).length;
    const inProgress = (section.match(/^- \[\/\]\s+T-\d{3}\b/gm) || []).length;
    const blocked = (section.match(/^- \[!\]\s+T-\d{3}\b/gm) || []).length;
    return { pending, done, total: pending + done, inProgress, blocked };
  }

  function normalizeFrontmatterStatus(value) {
    return String(value || '').replace(/^["']|["']$/g, '').trim();
  }

  // 可空 frontmatter 字段（如 change-set / change-set-seq）：去引号后，字面 null/空串归一为 JS null，
  // 其余返回去引号字符串。与 verified-date/reviewed-date 的 'null' 判定一致，保证向后兼容。
  function frontmatterNullable(value) {
    const v = normalizeFrontmatterStatus(value);
    return v && v.toLowerCase() !== 'null' ? v : null;
  }

  // v7 schema 封闭合同（CHG-20260611-09，spec §3.5）：key 集合恒定（缺失/多余都非法）+
  // 阶段必填值非 null。字段恒在、未到阶段值为 null（与 hasNonNullVerifiedDate 等既有
  // 双表示判定兼容，agent 只改值不插行）。仅对 schema-version "7.0" 的帧生效。
  const SCHEMA_V7_KEYS = {
    chg: ['status', 'date', 'change-set', 'change-set-seq', 'verified-date', 'reviewed-date', 'archived-date', 'parent-tasks', 'schema-version'],
    finding: ['status', 'date', 'schema-version'],
    correction: ['date', 'schema-version'],
  };
  const SCHEMA_V7_VALUE_REQUIRED = {
    chg: { base: ['status', 'date', 'parent-tasks', 'schema-version'], archived: ['archived-date', 'verified-date', 'reviewed-date'], cancelled: ['archived-date'] },
    finding: { base: ['status', 'date', 'schema-version'] },
    correction: { base: ['date', 'schema-version'] },
  };
  // CHG-20260614-03 T-001：各 kind 合法 status 枚举。status typo/未知值不得静默退化为 base-only（Bug#5）。
  // correction 无 status 字段（见 SCHEMA_V7_KEYS.correction），不参与枚举校验。
  const SCHEMA_V7_STATUS_ENUM = {
    chg: ['planned', 'in-progress', 'completed', 'archived', 'cancelled'],
    finding: ['open', 'investigating', 'accepted', 'rejected', 'merged', 'blocked'],
  };

  /**
   * 校验 7.0 帧是否符合封闭合同。
   * @param {string} kind - chg | finding | correction（其他值不校验）。
   * @param {string} status - 帧 status（阶段必填集选择用；correction 无 status 传 ''）。
   * @param {object} frontmatter - parseFrontmatter 结果（扁平 string map）。
   * @returns {{ok: boolean, missing: string[], unknown: string[], skipped?: string}}
   *   missing 含两类：缺 key（标 `(missing-key)` 后缀）与必填值为 null/空。
   */
  function validateFrontmatterSchema(kind, status, frontmatter) {
    const keys = SCHEMA_V7_KEYS[kind];
    if (!keys) return { ok: true, missing: [], unknown: [] };
    const fm = frontmatter || {};
    if (normalizeFrontmatterStatus(fm['schema-version']) !== '7.0') {
      return { ok: true, missing: [], unknown: [], skipped: 'non-7.0' };
    }
    const st = normalizeFrontmatterStatus(status);
    const spec = SCHEMA_V7_VALUE_REQUIRED[kind];
    const valueRequired = [...spec.base, ...((spec[st]) || [])];
    const keySet = new Set(keys);
    const present = Object.keys(fm);
    const missing = [
      ...keys.filter(k => !present.includes(k)).map(k => `${k}(missing-key)`),
      ...valueRequired.filter(k => present.includes(k) && !frontmatterNullable(fm[k])),
    ];
    // T-001：status 枚举校验——值非空但不在该 kind 合法枚举内即非法（typo 不退化 base-only）。
    // 空/null status 由上方 valueRequired（status 在 base）已捕获，此处只判非空无效值。
    const statusEnum = SCHEMA_V7_STATUS_ENUM[kind];
    if (statusEnum && st && !statusEnum.includes(st)) {
      missing.push(`status(unknown-value:${st})`);
    }
    const unknown = present.filter(k => !keySet.has(k));
    // R-11：change-set / change-set-seq 成对不变量（仅 chg，两 key 都 present 时）——
    // 半空对（一有值一 null/占位）破坏 batch 聚合排序，报 violation。
    if (kind === 'chg' && present.includes('change-set') && present.includes('change-set-seq')) {
      const csHas = !!frontmatterNullable(fm['change-set']);
      const seqHas = !!frontmatterNullable(fm['change-set-seq']);
      if (csHas !== seqHas) missing.push(csHas ? 'change-set-seq(pair-empty)' : 'change-set(pair-empty)');
    }
    return { ok: missing.length === 0 && unknown.length === 0, missing, unknown };
  }

  // 前向兼容 guard（CHG-20260612-04）：数据 schema 比 hook 认识的新时，hook 对该数据的
  // 一切流程判断（索引解析/状态机/必填集）都不可信——流程门必须让位为软提示，否则就是
  // v6→v7 升级窗口 brick 的重演（旧 hook 对新数据 deny 级锁死，实测见 README §升级与迁移）。
  const SCHEMA_KNOWN_MAX = 7.0;

  /**
   * 检测项目数据中是否存在高于当前 hook 支持上限（7.0）的 schema 帧。
   * 性能形态：优先复用调用方已加载的活跃 entries（零额外 IO）；仅当活跃 entries 为空时
   * 补扫 changes/ 顶层最近 10 个详情帧头部——未来版本可能改索引行格式致活跃解析为空，
   * 此时唯有直接看帧才能发现 newer 数据。读失败一律视为非 newer（fail-open 到既有门控）。
   * @param {string} cwd - 项目目录
   * @param {Array} [entries] - 调用方已加载的活跃 entries（含 detail.frontmatter），省略则自行加载
   * @returns {{detected: boolean, maxVersion: number|null}}
   */
  function detectNewerSchemaData(cwd, entries) {
    try {
      const list = Array.isArray(entries) ? entries : getActiveChangeEntries(cwd);
      let maxV = 0;
      for (const e of list) {
        const raw = e && e.detail && e.detail.frontmatter && e.detail.frontmatter['schema-version'];
        const v = parseFloat(normalizeFrontmatterStatus(raw));
        if (v > maxV) maxV = v;
      }
      if (list.length === 0) {
        const dir = path.join(ctx.getArtifactDir(cwd), 'changes');
        const files = fs.readdirSync(dir)
          .filter(f => /^(chg|hotfix)-/i.test(f) && f.endsWith('.md'))
          .sort().reverse().slice(0, 10);
        for (const f of files) {
          const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 400);
          const m = head.match(/^schema-version:\s*(.+?)\s*$/m);
          const v = m ? parseFloat(String(m[1]).replace(/['"]/g, '')) : 0;
          if (v > maxV) maxV = v;
        }
      }
      return { detected: maxV > SCHEMA_KNOWN_MAX, maxVersion: maxV > SCHEMA_KNOWN_MAX ? maxV : null };
    } catch (e) {
      return { detected: false, maxVersion: null };
    }
  }

  function classifyChange(entry) {
    const detail = entry && entry.detail;
    const fm = (detail && detail.frontmatter) || {};
    const status = normalizeFrontmatterStatus(detail && detail.frontmatter && detail.frontmatter.status);
    const tasks = detail && !detail.missing ? countDetailTasks(detail.content) : { pending: 0, done: 0, total: 0, inProgress: 0, blocked: 0 };
    const approved = isChangeApproved(detail);
    const verified = isChangeVerified(detail);
    const reviewed = isChangeReviewed(detail);
    const taskCheckbox = entry && entry.taskCheckbox;
    const base = {
      id: entry && entry.id,
      slug: entry && entry.slug,
      status,
      tasks,
      approved,
      verified,
      reviewed,
      changeSet: frontmatterNullable(fm['change-set']),
      changeSetSeq: frontmatterNullable(fm['change-set-seq']),
      taskCheckbox,
      detail,
      category: 'backlog',
      reason: '',
    };

    // v7（CHG-20260611-08）：task.md 单索引——index-missing 仅防卫空 entry（正常路径不可达），
    //   index-mismatch（旧双索引 checkbox 不一致）随双文件合并退役。
    if (!entry || !entry.task) {
      return { ...base, category: 'inconsistent', reason: 'index-missing' };
    }
    if (entry.taskMalformed) {
      return { ...base, category: 'inconsistent', reason: 'index-malformed' };
    }
    if (!detail || detail.missing) {
      return { ...base, category: 'inconsistent', reason: 'detail-missing' };
    }
    if (taskCheckbox === 'x' && tasks.pending > 0) {
      return { ...base, category: 'inconsistent', reason: 'index-completed-with-pending-tasks' };
    }
    if (taskCheckbox === 'x' && !['completed', 'archived'].includes(status)) {
      return { ...base, category: 'inconsistent', reason: 'index-completed-status-mismatch' };
    }
    if ((['in-progress', 'completed'].includes(status) || taskCheckbox === '/') && tasks.total === 0) {
      return { ...base, category: 'inconsistent', reason: 'task-list-empty' };
    }

    if (status === 'archived') return { ...base, category: 'inconsistent', reason: 'active-archived' };
    if (status === 'cancelled' || taskCheckbox === '-') return { ...base, category: 'inconsistent', reason: 'active-cancelled' };
    if (taskCheckbox === '!' || tasks.blocked > 0) return { ...base, category: 'blocked' };
    if (status === 'completed' || taskCheckbox === 'x') return { ...base, category: 'closing-required' };
    if (status === 'in-progress' || taskCheckbox === '/') return { ...base, category: 'running' };
    if (status === 'planned' && approved) return { ...base, category: 'ready' };
    if (status === 'planned' || status === '') return { ...base, category: 'backlog' };
    return { ...base, category: 'inconsistent', reason: 'unknown-status' };
  }

  function getActiveChangeEntries(cwd) {
    // v7（CHG-20260611-08）：task.md 是唯一 CHG/HOTFIX 索引（双文件合并，implementation_plan 退役）。
    //   Map 按纯 ID 去重保留——同 CHG 重复行的脏数据不裂成两个 entry（沿旧双索引实现的 join 语义）。
    const taskEntries = parseChangeIndex(ctx.readActive(cwd, 'task.md') || '');
    const taskById = new Map(taskEntries.map(e => [e.id, e]));
    return [...taskById.values()].map(task => ({
      slug: task.slug,
      id: task.id,
      task,
      taskCheckbox: task.checkbox,
      taskMalformed: Boolean(task.malformed),
      detail: readChangeDetail(cwd, task.id),
    }));
  }

  function isChangeApproved(detail) {
    if (!detail || detail.missing) return false;
    return /<!-- APPROVED -->/.test(detail.content);
  }

  function isChangeVerified(detail) {
    if (!detail || detail.missing) return false;
    const verifiedDate = normalizeFrontmatterStatus(detail.frontmatter['verified-date']).toLowerCase();
    return Boolean(verifiedDate && verifiedDate !== 'null' && /<!-- VERIFIED -->/.test(detail.content));
  }

  function isChangeReviewed(detail) {
    if (!detail || detail.missing) return false;
    const reviewedDate = normalizeFrontmatterStatus(detail.frontmatter['reviewed-date']).toLowerCase();
    return Boolean(reviewedDate && reviewedDate !== 'null' && /<!-- REVIEWED -->/.test(detail.content));
  }

  function summarizeActiveChanges(cwd) {
    return getActiveChangeEntries(cwd).map(entry => {
      const fm = entry.detail && entry.detail.frontmatter || {};
      const classified = classifyChange(entry);
      const tasks = entry.detail && !entry.detail.missing ? classified.tasks : null;
      // 透出 ## 任务清单段原文（复用 entry.detail.content，零额外 IO）：供 SessionStart core
      //   把任务行加工成注入本体（collect-state.js 按相关度分级）。读失败/无该段时为 ''，下游降级不崩。
      const taskSectionRaw = entry.detail && !entry.detail.missing ? extractTaskSection(entry.detail.content) : '';
      return {
        id: entry.id,
        slug: entry.slug,
        taskSectionRaw,
        taskCheckbox: entry.taskCheckbox || null,
        status: fm.status || (entry.detail && entry.detail.missing ? 'missing-detail' : 'unknown'),
        category: classified.category,
        approved: isChangeApproved(entry.detail),
        verified: isChangeVerified(entry.detail),
        reviewed: isChangeReviewed(entry.detail),
        changeSet: frontmatterNullable(fm['change-set']),
        changeSetSeq: frontmatterNullable(fm['change-set-seq']),
        pending: tasks ? tasks.pending : null,
        done: tasks ? tasks.done : null,
        blocked: tasks ? tasks.blocked : null,
        path: entry.detail && entry.detail.path,
        // v7 schema 合同（CHG-20260611-09）：违规摘要透出（零额外 IO，fm 在手），
        //   供 SessionStart 格式警告区渲染兜底；合规或 6.0 帧为 null。
        schemaViolation: (() => {
          const r = validateFrontmatterSchema('chg', fm.status || '', fm);
          return r.ok ? null : { missing: r.missing, unknown: r.unknown };
        })(),
      };
    });
  }

  // 检测落在 <!-- ARCHIVE --> 下方（归档区）的活跃状态索引行（[ ]/[/]/[!]）。
  // 归档区应只含终态 [x]/[-]；活跃状态行出现在归档区 = create-chg 把新索引插错区
  // （见 finding-2026-06-07-create-chg-empty-active-archive-insert）。返回错位的 slug 列表。
  function findActiveIndexBelowArchive(content) {
    const text = String(content || '');
    const marker = text.match(/^<!-- ARCHIVE -->[ \t]*$/m);
    if (!marker) return [];
    const below = text.slice(marker.index + marker[0].length);
    const bad = [];
    for (const line of below.split(/\r?\n/)) {
      // HOTFIX-20260610-01：兼容带 slug 全名 + 可选 |别名形态；报告仍用纯 ID（人读定位）。
      const m = line.match(/^- \[([ /!])\] \[\[((?:chg|hotfix)-\d{8}-\d{2})(?:-[a-z0-9][a-z0-9-]*)?(?:\|[^\]]+)?\]\]/i);
      if (m) bad.push(m[2].toLowerCase());
    }
    return bad;
  }

  return {
    countByStatus,
    extractOpenKeys,
    normalizeFindingKey,
    normalizeFrontmatterStatus,
    detectLegacyImplFormat,
    parseFrontmatter,
    validateWalkthroughLinks,
    parseChangeIndex,
    readChangeDetail,
    extractTaskSection,
    countDetailTasks,
    validateFrontmatterSchema,
    SCHEMA_V7_KEYS,
    detectNewerSchemaData,
    classifyChange,
    getActiveChangeEntries,
    isChangeApproved,
    isChangeVerified,
    isChangeReviewed,
    summarizeActiveChanges,
    findActiveIndexBelowArchive,
  };
};
