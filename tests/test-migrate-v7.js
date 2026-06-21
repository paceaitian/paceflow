// migrate-v7.js 端到端测试（V7E 组，CHG-20260611-12 T-001）
// CLI 黑盒：子进程跑脚本，断言文件系统结果 + stdout 报告。
// fixture：mini vault（2 CHG 详情 + finding + correction + 4 索引 + v5 尾巴 + 脏索引行）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const paceUtils = require('../plugin/hooks/pace-utils');
const { validateFrontmatterSchema, parseFrontmatter, ARCHIVE_MARKER } = paceUtils;

const { createTestRunner } = require('./test-utils');
const t = createTestRunner('migrate-v7-test');
const { test, makeTmpDir } = t;

const MIGRATE_SCRIPT = path.join(__dirname, '..', 'plugin', 'migrate', 'migrate-v7.js');

// ---------------- fixture ----------------

const CHG_OLD = `---
chg-id: CHG-20250101-01
status: archived
type: change
date: 2025-01-01
completed-date: 2025-01-02T10:00:00+08:00
verified-date: 2025-01-02T11:00:00+08:00
reviewed-date: 2025-01-02T12:00:00+08:00
parent-tasks: ["[[fixture-proj/task|task]]"]
parent-impl: ["[[fixture-proj/implementation_plan|implementation_plan]]"]
related-finding: null
aliases:
  - CHG-20250101-01
tags:
  - change
schema-version: "6.0"
---

# 旧式归档变更

## 任务清单

- [x] T-001 旧任务

<!-- APPROVED -->
<!-- VERIFIED -->
<!-- REVIEWED -->

## 实施详情

正文保持字节不动。
`;

const CHG_NEW = `---
chg-id: CHG-20260601-02
status: in-progress
type: change
date: 2026-06-01
change-set: demo-set
change-set-seq: 1/2
completed-date: null
verified-date: null
reviewed-date: null
archived-date: null
parent-tasks: ["[[fixture-proj/task|task]]"]
aliases: []
tags: []
schema-version: "6.0"
---

# 进行中变更

## 任务清单

- [/] T-001 进行中任务

<!-- APPROVED -->

## 实施详情
`;

const FINDING_OLD = `---
finding-id: FINDING-2026-01-01-foo
status: open
type: observation
date: 2026-01-01
impact: P2
summary: "fixture finding"
merges: []
merged-by: null
related-changes: []
schema-version: "6.0"
---

# fixture finding

正文。
`;

const CORRECTION_OLD = `---
correction-id: CORRECTION-2026-01-01-01
date: 2026-01-01
trigger-quote: "别这样"
wrong-behavior: "做错了一些事情，至少二十个字符长度的描述"
correct-behavior: "应该这样做，至少二十个字符长度的描述"
trigger-scenario: "测试场景"
root-cause: "测试根因"
knowledge-link: null
project-scope: "project-only"
aliases: []
tags: []
schema-version: "6.0"
---

# Correction: fixture

正文。
`;

const TASK_MD = `# 项目任务追踪

## 活跃任务

- [/] [[chg-20260601-02-demo-slug|chg-20260601-02]] 进行中变更 #change [tasks:: T-001~T-001]

${ARCHIVE_MARKER}

- [x] [[chg-20250101-01]] 旧式归档变更 #change [tasks:: T-001~T-001]

## v5 历史归档

> 以下内容由 PACEflow v5→v6 迁移脚本归档保留。

- 旧 v5 task 行，无 T-NNN schema
`;

const IMPL_MD = `# 实施计划

## 变更索引

- [/] [[chg-20260601-02-demo-slug|chg-20260601-02]] 进行中变更 #change [tasks:: T-001~T-001]

${ARCHIVE_MARKER}

- [x] [[chg-20250101-01]] 旧式归档变更 #change [tasks:: T-001~T-001]

## v5 历史归档

旧 v5 impl 尾巴。
`;

const WALKTHROUGH_MD = `# 工作记录

## 最近工作

| 日期 | 完成内容 | 关联变更 |
| --- | --- | --- |
| 2025-01-02 | [[chg-20250101-01]] 旧式归档变更完成 | CHG-20250101-01 |

${ARCHIVE_MARKER}
`;

const FINDINGS_MD = `# 调研记录

## 摘要索引

<!-- 格式：- [状态] [[finding-id|title]] — summary [date::] [impact::] -->

- [ ] [[finding-2026-01-01-foo|fixture finding]] — open 的留活跃区 #finding [date:: 2026-01-01] [impact:: P2]
- [x] [[finding-2025-12-01-done|已接受]] — accepted 的应下沉 #finding [date:: 2025-12-01] [impact:: P3]
- [-] [[finding-2025-11-01-rejected|已拒绝]] — rejected 的应下沉 #finding [date:: 2025-11-01] [impact:: P3]

${ARCHIVE_MARKER}
`;

const CORRECTIONS_MD = `# Corrections 索引

## 活跃记录

- [[correction-2026-01-01-01-fixture]] fixture 纠正 [date:: 2026-01-01] [knowledge:: project-only]
- [[correction-2025-12-01-01-quotes]] “弯引号”脏数据 [date:: 2025-12-01] [knowledge:: [[some-note]]]

${ARCHIVE_MARKER}
`;

function buildFixture(prefix) {
  const dir = makeTmpDir(prefix);
  fs.mkdirSync(path.join(dir, 'changes', 'findings'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'changes', 'corrections'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.pace', 'index-transactions'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'index-transactions', 'stale.json'), '{}');
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20250101-01.md'), CHG_OLD);
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260601-02-demo-slug.md'), CHG_NEW);
  fs.writeFileSync(path.join(dir, 'changes', 'findings', 'finding-2026-01-01-foo.md'), FINDING_OLD);
  fs.writeFileSync(path.join(dir, 'changes', 'corrections', 'correction-2026-01-01-01-fixture.md'), CORRECTION_OLD);
  fs.writeFileSync(path.join(dir, 'task.md'), TASK_MD);
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), IMPL_MD);
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), WALKTHROUGH_MD);
  fs.writeFileSync(path.join(dir, 'findings.md'), FINDINGS_MD);
  fs.writeFileSync(path.join(dir, 'corrections.md'), CORRECTIONS_MD);
  return dir;
}

function runMigrate(dir, args = []) {
  return execFileSync('node', [MIGRATE_SCRIPT, '--cwd', dir, ...args], { encoding: 'utf8' });
}

function snapshotAll(dir) {
  const files = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      // TH-1b（v7.2.21 审计）：key 用 path.sep→'/' 归一，Windows 反斜杠 key 才能匹配测试里的正斜杠字面量（如 V7E-6 'changes/chg-...md'）；POSIX 下 path.sep==='/' 归一是恒等。
      else files[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return files;
}

console.log('\n--- V7E: migrate-v7.js ---');

test('V7E-1: dry-run 零写入 + 报告含将删字段统计', () => {
  const dir = buildFixture('v7e-dryrun');
  const before = snapshotAll(dir);
  const out = runMigrate(dir, ['--dry-run']);
  const after = snapshotAll(dir);
  assert.deepStrictEqual(after, before, 'dry-run 不得改任何文件');
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'backups')), 'dry-run 不得产生备份');
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'v7-migration-state')), 'dry-run 不得写 migration-state');
  assert.match(out, /dry-run/i, '报告应标明 dry-run');
  assert.match(out, /completed-date/, '报告应含将删字段统计');
  assert.match(out, /chg-id/, '报告应含将删字段统计');
});

test('V7E-1b: 含引号 status（status: "archived"）触发 archived-date 回填（R-33 引号归一）', () => {
  const dir = buildFixture('v7e-quoted-status');
  const quoted = CHG_OLD.replace('status: archived', 'status: "archived"');
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20250101-01.md'), quoted);
  // 修复前：引号致 rewriteFrontmatter :162 判 false → archived-date 不回填 → 验收 missing → runMigrate throw(exit=1)
  runMigrate(dir);
  const migrated = fs.readFileSync(path.join(dir, 'changes', 'chg-20250101-01.md'), 'utf8');
  assert.match(migrated, /^archived-date: 20\d\d-\d\d-\d\dT/m, 'R-33: 含引号 archived status 应回填 archived-date');
});

test('V7E-1c: 零缩进块序列删 key 不留孤儿行（R-34）', () => {
  const dir = buildFixture('v7e-zero-indent-seq');
  // tags 改零缩进块序列形态（外部工具改写形态），删 tags 后不应留 `- change` 孤儿行
  const zeroIndent = CHG_OLD.replace('tags:\n  - change', 'tags:\n- change');
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20250101-01.md'), zeroIndent);
  runMigrate(dir);
  const migrated = fs.readFileSync(path.join(dir, 'changes', 'chg-20250101-01.md'), 'utf8');
  const fm = migrated.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.ok(!/^- change$/m.test(fm), 'R-34: 删 tags 后零缩进序列项 `- change` 不残留 frontmatter');
});

test('V7E-1d: 未知参数 fail-fast——--dryrun 误拼不得静默执行真迁移（codex P1）', () => {
  const dir = buildFixture('v7e-unknown-arg');
  const before = snapshotAll(dir);
  let failed = false;
  try { runMigrate(dir, ['--dryrun']); } catch (e) { failed = true; }
  assert.ok(failed, 'P1: 未知参数 --dryrun 应非零退出 fail-fast（修复前被静默忽略→执行真迁移）');
  assert.deepStrictEqual(snapshotAll(dir), before, '未知参数不得写盘（无迁移副作用）');
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'v7-migration-state')), '未知参数不得写 v7-migration-state');
});

test('V7E-1e: 取值型 flag 缺值 fail-fast——--restore 末尾缺值不静默降级为真迁移（codex P3）', () => {
  const dir = buildFixture('v7e-restore-missing');
  const before = snapshotAll(dir);
  // 修复前 --restore 末尾缺值 args.restore='' → if(args.restore) 假 → 执行真迁移
  let failed = false;
  try { runMigrate(dir, ['--restore']); } catch (e) { failed = true; }
  assert.ok(failed, 'P3: --restore 缺值应 fail-fast，不静默降级为真迁移');
  assert.deepStrictEqual(snapshotAll(dir), before, '--restore 缺值不得写盘');
});

test('V7E-2: 执行后全部详情 frontmatter 过 7.0 封闭合同', () => {
  const dir = buildFixture('v7e-contract');
  runMigrate(dir);
  const cases = [
    ['changes/chg-20250101-01.md', 'chg'],
    ['changes/chg-20260601-02-demo-slug.md', 'chg'],
    ['changes/findings/finding-2026-01-01-foo.md', 'finding'],
    ['changes/corrections/correction-2026-01-01-01-fixture.md', 'correction'],
  ];
  for (const [rel, kind] of cases) {
    const content = fs.readFileSync(path.join(dir, rel), 'utf8');
    const fm = parseFrontmatter(content);
    assert.strictEqual(String(fm['schema-version']).replace(/"/g, ''), '7.0', `${rel} schema-version 应为 7.0`);
    const r = validateFrontmatterSchema(kind, fm.status || '', fm);
    assert.strictEqual(r.skipped, undefined, `${rel} 必须真校验（被 skip 即假绿）`);
    assert.ok(r.ok, `${rel} 应过封闭合同：missing=${(r.missing || []).join(',')} unknown=${(r.unknown || []).join(',')}`);
  }
  // 正文字节不动
  const oldChg = fs.readFileSync(path.join(dir, 'changes/chg-20250101-01.md'), 'utf8');
  assert.ok(oldChg.includes('正文保持字节不动。'), '正文不得被改写');
  // change-set 既有值保留
  const newChg = parseFrontmatter(fs.readFileSync(path.join(dir, 'changes/chg-20260601-02-demo-slug.md'), 'utf8'));
  assert.strictEqual(newChg['change-set'], 'demo-set', '既有 change-set 值保留');
});

test('V7E-3: impl_plan 变 tombstone（含 ARCHIVE + 指向 task.md；v5 尾巴消失）', () => {
  const dir = buildFixture('v7e-tombstone');
  runMigrate(dir);
  const impl = fs.readFileSync(path.join(dir, 'implementation_plan.md'), 'utf8');
  assert.ok(impl.includes(ARCHIVE_MARKER), 'tombstone 保留 ARCHIVE 标记');
  assert.ok(impl.includes('[[task]]'), 'tombstone 指向 task.md');
  assert.ok(!impl.includes('v5 历史归档'), 'v5 尾巴随 tombstone 消失');
  assert.ok(!impl.includes('chg-20260601-02'), 'tombstone 不保留索引行');
});

test('V7E-4: task.md v5 死尾巴段被清（归档区 v6 行保留）', () => {
  const dir = buildFixture('v7e-task-tail');
  runMigrate(dir);
  const task = fs.readFileSync(path.join(dir, 'task.md'), 'utf8');
  assert.ok(!task.includes('v5 历史归档'), 'v5 尾巴段被清');
  assert.ok(task.includes('[[chg-20250101-01]]'), '归档区 v6 行保留');
  assert.ok(task.includes('[[chg-20260601-02-demo-slug|chg-20260601-02]]'), '活跃区行保留');
});

test('V7E-5: findings.md 三态重排 + 表头补 [change::]', () => {
  const dir = buildFixture('v7e-findings');
  runMigrate(dir);
  const findings = fs.readFileSync(path.join(dir, 'findings.md'), 'utf8');
  const archivePos = findings.indexOf(ARCHIVE_MARKER);
  const openPos = findings.indexOf('finding-2026-01-01-foo');
  const donePos = findings.indexOf('finding-2025-12-01-done');
  const rejectedPos = findings.indexOf('finding-2025-11-01-rejected');
  assert.ok(openPos < archivePos, 'open 行留活跃区');
  assert.ok(donePos > archivePos, '[x] 行移 ARCHIVE 下方');
  assert.ok(rejectedPos > archivePos, '[-] 行移 ARCHIVE 下方');
  assert.match(findings, /<!-- 格式：[^>]*\[change::\][^>]*-->/, '表头格式注释应补 [change::]');
});

test('V7E-6: 备份目录含全部被改文件原件', () => {
  const dir = buildFixture('v7e-backup');
  const before = snapshotAll(dir);
  runMigrate(dir);
  const backupRoot = path.join(dir, '.pace', 'backups', 'v7-migration');
  assert.ok(fs.existsSync(backupRoot), '备份根目录存在');
  const tsDirs = fs.readdirSync(backupRoot);
  assert.strictEqual(tsDirs.length, 1, '一次迁移一个时间戳目录');
  const backupDir = path.join(backupRoot, tsDirs[0]);
  for (const rel of ['task.md', 'implementation_plan.md', 'findings.md', 'corrections.md', 'changes/chg-20250101-01.md']) {
    const backed = path.join(backupDir, rel);
    assert.ok(fs.existsSync(backed), `备份应含 ${rel}`);
    assert.strictEqual(fs.readFileSync(backed, 'utf8'), before[rel], `备份 ${rel} 应为迁移前原件`);
  }
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'v7-migration-state')), '迁移完成写 migration-state');
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'index-transactions')), 'index-transactions 残留目录被清');
});

test('V7E-7: archived 缺 archived-date 从 walkthrough 回填；无记录用执行日并报告注明', () => {
  const dir = buildFixture('v7e-backfill');
  const out = runMigrate(dir);
  const fm = parseFrontmatter(fs.readFileSync(path.join(dir, 'changes/chg-20250101-01.md'), 'utf8'));
  assert.ok(String(fm['archived-date']).startsWith('2025-01-02'), `archived-date 应从 walkthrough 行回填 2025-01-02，实际 ${fm['archived-date']}`);
  assert.match(out, /回填/, '报告应含回填清单');

  // 分支二：walkthrough 无该 CHG 记录 → 用执行日
  const dir2 = buildFixture('v7e-backfill-fallback');
  fs.writeFileSync(path.join(dir2, 'walkthrough.md'), `# 工作记录\n\n## 最近工作\n\n| 日期 | 完成内容 | 关联变更 |\n| --- | --- | --- |\n\n${ARCHIVE_MARKER}\n`);
  const out2 = runMigrate(dir2);
  const fm2 = parseFrontmatter(fs.readFileSync(path.join(dir2, 'changes/chg-20250101-01.md'), 'utf8'));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.ok(String(fm2['archived-date']).startsWith(today), 'walkthrough 无记录时用执行日');
  assert.match(out2, /执行日/, '报告应注明执行日回填');
});

test('V7E-12: CRLF + BOM 详情文件正确迁移（归一后过 7.0 合同，不漏迁）', () => {
  const dir = buildFixture('v7e-crlf-bom');
  const crlfContent = '﻿' + CHG_NEW.replace(/\n/g, '\r\n').replace('chg-id: CHG-20260601-02', 'chg-id: CHG-20260601-03');
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260601-03-crlf.md'), crlfContent);
  runMigrate(dir);
  const after = fs.readFileSync(path.join(dir, 'changes', 'chg-20260601-03-crlf.md'), 'utf8');
  assert.ok(!after.includes('\r\n'), 'CRLF 应归一为 LF');
  assert.ok(!after.startsWith('﻿'), 'BOM 应剥离');
  const fm = parseFrontmatter(after);
  const r = validateFrontmatterSchema('chg', String(fm.status || '').replace(/"/g, ''), fm);
  assert.strictEqual(r.skipped, undefined, 'CRLF 文件不得漏迁');
  assert.ok(r.ok, `CRLF 文件迁移后应过合同：missing=${(r.missing || []).join(',')}`);
});

test('V7E-13: 漏迁文件（frontmatter 边界异常）→ 验收报错退出并还原全部文件', () => {
  const dir = buildFixture('v7e-acceptance-fail');
  // frontmatter 前有前导空行：rewriteFrontmatter 与 parseFrontmatter 都不认 → 留在 6.0 帧 → 验收应抓「漏迁」
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260601-09-broken.md'), '\n' + CHG_NEW);
  const before = snapshotAll(dir);
  let failed = false;
  let stderr = '';
  try { runMigrate(dir); } catch (e) { failed = true; stderr = String(e.stderr || ''); }
  assert.ok(failed, '验收失败应非零退出');
  assert.match(stderr, /漏迁|验收失败/, 'stderr 应说明漏迁/验收失败');
  const after = snapshotAll(dir);
  for (const rel of Object.keys(before)) {
    if (rel.startsWith('.pace')) continue;  // 备份目录允许残留
    assert.strictEqual(after[rel], before[rel], `验收失败应还原 ${rel}`);
  }
});

test('V7E-8: correction 索引 [knowledge:: project-only]→[scope::] + 弯引号修复', () => {
  const dir = buildFixture('v7e-corr-index');
  runMigrate(dir);
  const corrections = fs.readFileSync(path.join(dir, 'corrections.md'), 'utf8');
  assert.ok(corrections.includes('[scope:: project-only]'), 'project-only 改用 [scope::]');
  assert.ok(!corrections.includes('[knowledge:: project-only]'), '不再把 scope 值塞进 [knowledge::]');
  assert.ok(corrections.includes('[knowledge:: [[some-note]]]'), '真 knowledge wikilink 保留');
  assert.ok(!/[“”‘’]/.test(corrections), '弯引号修复为半角');
});

test('V7E-14: finding 行内含字面 <!-- ARCHIVE --> 文本不被误切（独占行锚定）', () => {
  const dir = buildFixture('v7e-inline-marker');
  // 复刻真实 vault 形态：[x] finding 行的 summary 含字面 marker 文本，位于结构 marker 之前
  const inlineLine = '- [x] [[finding-2025-10-01-inline|行内标记]] — 索引误插到 <!-- ARCHIVE --> 下方的问题 #finding [date:: 2025-10-01] [impact:: P2]';
  const findings = fs.readFileSync(path.join(dir, 'findings.md'), 'utf8')
    .replace('- [x] [[finding-2025-12-01-done', `${inlineLine}\n- [x] [[finding-2025-12-01-done`);
  fs.writeFileSync(path.join(dir, 'findings.md'), findings);
  runMigrate(dir);
  const after = fs.readFileSync(path.join(dir, 'findings.md'), 'utf8');
  const lines = after.split('\n');
  assert.ok(lines.includes(inlineLine), '行内 marker 的 finding 行必须整行完好下沉（不被切碎）');
  const structMarkerLine = lines.indexOf(ARCHIVE_MARKER);
  assert.ok(structMarkerLine !== -1, '结构 marker 仍独占一行');
  assert.ok(lines.indexOf(inlineLine) > structMarkerLine, '行内 marker 行已下沉到结构 marker 之后');
  const openLine = lines.findIndex((l) => l.startsWith('- [ ] [[finding-2026-01-01-foo'));
  assert.ok(openLine !== -1 && openLine < structMarkerLine, 'open 行完好留在活跃区');
});

test('V7E-15: --restore 从备份整体还原被改文件', () => {
  const dir = buildFixture('v7e-restore');
  const before = snapshotAll(dir);
  runMigrate(dir);
  const backupRoot = path.join(dir, '.pace', 'backups', 'v7-migration');
  const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
  runMigrate(dir, ['--restore', backupDir]);
  const after = snapshotAll(dir);
  for (const rel of Object.keys(before)) {
    if (rel.startsWith('.pace')) continue;
    assert.strictEqual(after[rel], before[rel], `--restore 应还原 ${rel} 为迁移前原件`);
  }
});

// ============================================================
// 汇总 + 清理
// ============================================================
t.cleanup();

const total = t.passed + t.failed;
console.log(`\n${t.failed === 0 ? '✅' : '❌'} ${t.passed}/${total} tests passed`);
if (t.failed > 0) process.exit(1);
