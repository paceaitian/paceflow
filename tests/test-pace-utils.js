// pace-utils.js 纯函数单元测试
// 零依赖：仅使用 Node.js 内置 assert + fs + os.tmpdir()
// 覆盖：isPaceProject / countByStatus / readActive / checkArchiveFormat

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 测试自洽（hermetic）：必须在 require pace-utils 之前强制 PACE_VAULT_PATH 指向进程私有临时 vault 根。
// constants.js 在 require 时即把 VAULT_PATH 固化为 `process.env.PACE_VAULT_PATH || ''`，因此干净环境
// （CI 无 PACE_VAULT_PATH）下 VAULT_PATH 为空字符串，vault/PACE_PROJECT_NAME/scanRelatedNotes/WIKI 等测试
// 构造 `path.join('', 'projects', name)` = 相对路径 `projects/<name>` 而断言崩溃（本地靠维护者 shell 的
// ambient 值假绿）。在此固定为临时根，既让 CI 干净环境成立，也避免污染真实 Obsidian vault。
process.env.PACE_VAULT_PATH = path.join(os.tmpdir(), 'pace-test-vault-root');
fs.mkdirSync(process.env.PACE_VAULT_PATH, { recursive: true });

const paceUtils = require('../plugin/hooks/pace-utils');
const cmdRecognition = require('../plugin/hooks/pre-tool-use/command-recognition');
const bashGuard = require('../plugin/hooks/pre-tool-use/bash-guard');
const powershellGuard = require('../plugin/hooks/pre-tool-use/powershell-guard');
const lifecycleGuard = require('../plugin/hooks/pre-tool-use/agent-lifecycle-guard');
const monitorGuard = require('../plugin/hooks/pre-tool-use/monitor-guard');
const subagentStop = require('../plugin/hooks/subagent-stop');
const createPlanUtils = require('../plugin/hooks/pace-utils/plans');
const createLockUtils = require('../plugin/hooks/pace-utils/locks');
const { isPaceProject, detectSoftSignal, daysSinceISODate, countByStatus, readActive, checkArchiveFormat, RESERVE_ARTIFACT_ID_SCRIPT, SYNC_PLAN_SCRIPT, SET_ARTIFACT_ROOT_SCRIPT, SET_PROJECT_ROOT_SCRIPT, getArtifactDir, _clearArtifactDirCache, getProjectName, getProjectNameCandidates, resolveEffectiveProjectRoot, resolveToolFilePath, isArtifactRelativePath, artifactRelativePathForFile, executionContextForCwd, getProjectStateDir, getProjectRuntimeDir, getArtifactRootChoicePath, readArtifactRootChoice, getConfiguredArtifactDir, artifactRootChoiceNeeded, artifactRootChoiceMessage, getV5MigrationInfo, v5LayoutNoticeMessage, parseHookStdin, logEntry, normalizeChangeId, detailPathForId, slugForChangeId, readArtifactWriterLock, artifactWriterLockMatches, getArtifactWriterLockPath, artifactResourceForRel, getArtifactResourceLockPath, acquireArtifactResourceLock, readArtifactResourceLock, releaseArtifactResourceLock, markIndexChangesTouchedAndMaybeRelease, reserveArtifactId, readArtifactReservation, findArtifactReservationForRel, clearArtifactReservationForRel, isArtifactRuntimeControlPath, createTemplates, writeChangeOwner, readChangeOwner, touchChangeOwnersForSession, changeOwnerStatus, hasBridgeCandidatePlanFiles, listBridgeCandidatePlanFiles, parseFrontmatter } = paceUtils;

// I-23: 公共测试工具（消除重复的 test/makeTmpDir/cleanup 定义）
const { createTestRunner } = require('./test-utils');
const t = createTestRunner('pace-test');
const { test, makeTmpDir } = t;

// ============================================================
// 1. isPaceProject()
// ============================================================
console.log('\n--- isPaceProject ---');

test('空目录 → false', () => {
  const dir = makeTmpDir('empty');
  assert.strictEqual(isPaceProject(dir), false);
});

test('有 changes/ → artifact', () => {
  const dir = makeTmpDir('artifact');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  assert.strictEqual(isPaceProject(dir), 'artifact');
});

test('changes 为同名文件（非目录）→ 不误判 artifact（PU-002）', () => {
  // hasChangesDir / isPaceProject 原用 existsSync，对同名文件 changes（非目录）误判为 PACE 项目
  const dir = makeTmpDir('changes-is-file');
  fs.writeFileSync(path.join(dir, 'changes'), 'not a directory');
  assert.strictEqual(isPaceProject(dir), false);
});

test('旧 v5 artifact 根文件但无 changes/ → legacy', () => {
  const dir = makeTmpDir('legacy-v5-signal');
  fs.writeFileSync(path.join(dir, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n- [ ] Legacy task\n\n<!-- ARCHIVE -->\n');
  assert.strictEqual(isPaceProject(dir), 'legacy');
});

test('普通 task.md 无 PACE 签名 → 不误判 legacy', () => {
  const dir = makeTmpDir('plain-task-md');
  fs.writeFileSync(path.join(dir, 'task.md'), '# Task list\n\n- buy milk\n');
  assert.strictEqual(isPaceProject(dir), false);
});

test('英文最小 v5 task+implementation checkbox → legacy', () => {
  const dir = makeTmpDir('legacy-v5-minimal');
  fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n\n- [ ] Legacy v5 active item\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), '# Implementation Plan\n\n- [ ] Legacy v5 implementation item\n', 'utf8');
  assert.strictEqual(isPaceProject(dir), 'legacy');
  const info = getV5MigrationInfo(dir);
  assert.strictEqual(info.detected, true);
  assert.deepStrictEqual(info.files, ['task.md', 'implementation_plan.md']);
});

test('CHG-20260612-02: v5 目录 createTemplates 正常创建（迁移门控退役，不再 fail-closed）', () => {
  const dir = makeTmpDir('legacy-v5-template-pass');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n\n- [ ] Legacy v5 active item\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), '# Implementation Plan\n\n- [ ] Legacy v5 implementation item\n', 'utf8');
  createTemplates(dir);
  assert.strictEqual(fs.existsSync(path.join(dir, 'changes')), true, 'v5 目录应可直接建出 changes/（新内容按当前合同写入）');
  // 既有 v5 task.md 不被模板覆盖
  assert.ok(fs.readFileSync(path.join(dir, 'task.md'), 'utf8').includes('Legacy v5 active item'));
  // changes/ 出现后 v5 布局判定自然消失（提示自动收敛）
  assert.strictEqual(getV5MigrationInfo(dir).detected, false);
});

test('有 .pace/disabled + task.md → false（豁免优先）', () => {
  const dir = makeTmpDir('disabled');
  fs.writeFileSync(path.join(dir, 'task.md'), '# Tasks\n');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'disabled'), '');
  assert.strictEqual(isPaceProject(dir), false);
});

test('有 .pace-enabled → manual', () => {
  const dir = makeTmpDir('manual');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  assert.strictEqual(isPaceProject(dir), 'manual');
});

test('只有 artifact-root 选择且尚无 changes → manual', () => {
  const dir = makeTmpDir('artifact-root-choice-signal');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  assert.strictEqual(isPaceProject(dir), 'manual');
});

test('只有运行态 .pace/ 目录 → false（不等于启用信号）', () => {
  const dir = makeTmpDir('runtime-pace-dir');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', '.gitignore'), '*\n');
  assert.strictEqual(isPaceProject(dir), false);
});

// CHG-A A1：isPaceProject 收紧——code-count / dated-plan 不再返回激活信号（降级到 detectSoftSignal）
test('docs/plans/<date>-*.md 但无强信号 → false（A1 收紧，原 superpowers/dated-plan 不再激活）', () => {
  const dir = makeTmpDir('dated-plan-no-activate');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-01-01-test.md'), '# Plan\n');
  assert.strictEqual(isPaceProject(dir), false);
});

test('3+ 代码文件但无强信号 → false（A1 收紧，原 code-count 不再激活）', () => {
  const dir = makeTmpDir('code-count-no-activate');
  fs.writeFileSync(path.join(dir, 'a.js'), '');
  fs.writeFileSync(path.join(dir, 'b.js'), '');
  fs.writeFileSync(path.join(dir, 'c.js'), '');
  assert.strictEqual(isPaceProject(dir), false);
});

test('优先级：artifact 存在时忽略 code-count', () => {
  const dir = makeTmpDir('priority');
  // 同时有 changes/（v6 artifact 信号）和 3 个 .js 文件（code-count 信号）
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.js'), '');
  fs.writeFileSync(path.join(dir, 'b.js'), '');
  fs.writeFileSync(path.join(dir, 'c.js'), '');
  assert.strictEqual(isPaceProject(dir), 'artifact');
});

// ============================================================
// detectSoftSignal()（CHG-A A2：软信号层，与激活层正交）
// ============================================================
console.log('\n--- detectSoftSignal ---');

test('detectSoftSignal: 空目录 → false', () => {
  const dir = makeTmpDir('soft-empty');
  assert.strictEqual(detectSoftSignal(dir), false);
});

test('detectSoftSignal: 3+ 代码文件 → "code-count"', () => {
  const dir = makeTmpDir('soft-code-count');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a');
  fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
  fs.writeFileSync(path.join(dir, 'c.go'), '// c');
  assert.strictEqual(detectSoftSignal(dir), 'code-count');
});

test('detectSoftSignal: 1-2 代码文件且无 plan → false（未达阈值）', () => {
  const dir = makeTmpDir('soft-below-threshold');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a');
  fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
  assert.strictEqual(detectSoftSignal(dir), false);
});

test('detectSoftSignal: docs/plans/<date>-*.md（mtime 新鲜）→ "dated-plan"', () => {
  const dir = makeTmpDir('soft-dated-plan');
  const planDir = path.join(dir, 'docs', 'plans');
  fs.mkdirSync(planDir, { recursive: true });
  // isFresh 按 mtime（14 天窗口）判定，新建文件 mtime=now 必然新鲜；文件名日期不参与判定。
  fs.writeFileSync(path.join(planDir, '2026-06-09-feature.md'), '# 计划\n');
  assert.strictEqual(detectSoftSignal(dir), 'dated-plan');
});

test('MANIFEST-1. detectSoftSignal: src/ 布局（根目录零代码）+ package.json → "manifest"（CHG-20260611-05）', () => {
  // cc-wechat 野外盲区复刻：代码全在 src/，根目录只有清单文件——code-count 恒 miss，
  // 清单文件检测补位（finding-2026-06-11-code-count-src-layout-miss-soft-signal）。
  const dir = makeTmpDir('soft-manifest');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), '// code in src');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  assert.strictEqual(detectSoftSignal(dir), 'manifest');
});

test('MANIFEST-2. 各类清单文件均触发；优先级 code-count > manifest > dated-plan', () => {
  for (const manifest of ['tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
    const dir = makeTmpDir(`soft-manifest-${manifest.replace(/\W/g, '-')}`);
    fs.writeFileSync(path.join(dir, manifest), '');
    assert.strictEqual(detectSoftSignal(dir), 'manifest', manifest + ' 应触发 manifest 软信号');
  }
  // code-count 优先（双命中返回更具体的 code-count）
  const both = makeTmpDir('soft-manifest-code-priority');
  fs.writeFileSync(path.join(both, 'package.json'), '{}');
  for (const f of ['a.js', 'b.ts', 'c.py']) fs.writeFileSync(path.join(both, f), '//');
  assert.strictEqual(detectSoftSignal(both), 'code-count');
  // manifest 优先于 dated-plan（工程证据强于计划文件）
  const mp = makeTmpDir('soft-manifest-plan-priority');
  fs.writeFileSync(path.join(mp, 'package.json'), '{}');
  fs.mkdirSync(path.join(mp, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(mp, 'docs', 'plans', '2026-06-10-x.md'), '# p');
  assert.strictEqual(detectSoftSignal(mp), 'manifest');
});

test('MANIFEST-3. manifest 项目 disabled / 已激活仍 false（守卫优先级不变）', () => {
  const disabled = makeTmpDir('soft-manifest-disabled');
  fs.writeFileSync(path.join(disabled, 'package.json'), '{}');
  fs.mkdirSync(path.join(disabled, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(disabled, '.pace', 'disabled'), '');
  assert.strictEqual(detectSoftSignal(disabled), false);
  const active = makeTmpDir('soft-manifest-active');
  fs.writeFileSync(path.join(active, 'package.json'), '{}');
  fs.mkdirSync(path.join(active, 'changes'), { recursive: true });
  assert.strictEqual(detectSoftSignal(active), false);
});

test('detectSoftSignal: 有 .pace/disabled → false（用户已禁用，不提示）', () => {
  const dir = makeTmpDir('soft-disabled');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a');
  fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
  fs.writeFileSync(path.join(dir, 'c.py'), '# c');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'disabled'), '');
  assert.strictEqual(detectSoftSignal(dir), false);
});

test('detectSoftSignal: 已激活（有 changes/）→ false（已 enabled 不再软提示）', () => {
  const dir = makeTmpDir('soft-already-active');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a');
  fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
  fs.writeFileSync(path.join(dir, 'c.py'), '# c');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  assert.strictEqual(detectSoftSignal(dir), false);
});

test('detectSoftSignal: code-count 优先于 dated-plan（双命中返回 code-count）', () => {
  const dir = makeTmpDir('soft-both');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a');
  fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
  fs.writeFileSync(path.join(dir, 'c.py'), '# c');
  const planDir = path.join(dir, 'docs', 'plans');
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, '2026-06-09-x.md'), '# x\n');
  assert.strictEqual(detectSoftSignal(dir), 'code-count');
});

console.log('\n--- date helpers ---');

test('daysSinceISODate 使用日历日差，避免 UTC 解析偏差', () => {
  assert.strictEqual(daysSinceISODate('2026-04-25', '2026-05-09'), 14);
  assert.strictEqual(daysSinceISODate('"2026-04-25"', '2026-05-09'), 14);
  assert.strictEqual(daysSinceISODate('2026-04-25T23:30:00+08:00', '2026-05-09'), 14);
  assert.strictEqual(daysSinceISODate('not-a-date', '2026-05-09'), null);
});

// ============================================================
// 2. countByStatus() — 3 个测试
// ============================================================
console.log('\n--- countByStatus ---');

test('空文本 → {pending:0, done:0, total:0}', () => {
  assert.deepStrictEqual(countByStatus(''), { pending: 0, done: 0, total: 0 });
});

test('混合状态 → {pending:2, done:2, total:4}', () => {
  const text = '- [ ] a\n- [x] b\n- [-] c\n- [/] d';
  assert.deepStrictEqual(countByStatus(text), { pending: 2, done: 2, total: 4 });
});

test('topLevelOnly=true 时子任务不计入', () => {
  const text = '- [ ] a\n  - [ ] sub';
  const result = countByStatus(text, { topLevelOnly: true });
  assert.strictEqual(result.pending, 1);
  assert.strictEqual(result.total, 1);
});

// ============================================================
// 3. readActive() — 3 个测试
// ============================================================
console.log('\n--- readActive ---');

test('无 ARCHIVE 标记 → 返回全文', () => {
  const dir = makeTmpDir('ra-noarchive');
  fs.writeFileSync(path.join(dir, 'test.md'), 'line1\nline2\n');
  assert.strictEqual(readActive(dir, 'test.md'), 'line1\nline2\n');
});

test('有 <!-- ARCHIVE --> → 返回标记前内容', () => {
  const dir = makeTmpDir('ra-archive');
  const content = 'active part\n<!-- ARCHIVE -->\nold stuff\n';
  fs.writeFileSync(path.join(dir, 'test.md'), content);
  assert.strictEqual(readActive(dir, 'test.md'), 'active part\n');
});

test('ARCHIVE 标记行带尾随空格 → 仍返回标记前内容（CA-1：与 findActiveIndexBelowArchive 容忍版对齐，防归档区 entry 冒泡回活跃）', () => {
  const dir = makeTmpDir('ra-archive-trailing');
  // 外部编辑器易在标记行尾留空格；不容忍会导致 readActive 退回全文、归档 [x]/[-] 行被当活跃
  const content = 'active part\n<!-- ARCHIVE --> \nold stuff\n';
  fs.writeFileSync(path.join(dir, 'test.md'), content);
  assert.strictEqual(readActive(dir, 'test.md'), 'active part\n');
});

test('文件不存在 → null', () => {
  const dir = makeTmpDir('ra-missing');
  assert.strictEqual(readActive(dir, 'nonexistent.md'), null);
});

// ============================================================
// 4. checkArchiveFormat() — 3 个测试
// ============================================================
console.log('\n--- checkArchiveFormat ---');

test('正确格式 <!-- ARCHIVE --> → null', () => {
  const dir = makeTmpDir('caf-correct');
  fs.writeFileSync(path.join(dir, 'test.md'), 'content\n<!-- ARCHIVE -->\nold\n');
  assert.strictEqual(checkArchiveFormat(dir, 'test.md'), null);
});

test('错误格式 ## ARCHIVE → 返回错误消息', () => {
  const dir = makeTmpDir('caf-wrong');
  fs.writeFileSync(path.join(dir, 'test.md'), 'content\n## ARCHIVE\nold\n');
  const result = checkArchiveFormat(dir, 'test.md');
  assert.ok(result !== null, '应返回错误消息');
  assert.ok(result.includes('错误的 ARCHIVE 标记格式'), `消息内容不符: ${result}`);
});

test('文件不存在 → null', () => {
  const dir = makeTmpDir('caf-missing');
  assert.strictEqual(checkArchiveFormat(dir, 'nonexistent.md'), null);
});

test('checkArchiveFormat: 应有 ARCHIVE 的双区文件完全缺失标记 → 返回缺失警告（findings.md，层1）', () => {
  const dir = makeTmpDir('caf-missing-archive');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true }); // 建 changes/ → dir 成为本地 artifact root，getArtifactDir(dir)=dir
  // findings.md 属 ARCHIVE_REQUIRED_FILES，但既无 <!-- ARCHIVE --> 也无 ## ARCHIVE
  fs.writeFileSync(path.join(dir, 'findings.md'), '# 调研记录\n\n## 未解决问题\n\n- [ ] something\n');
  const result = checkArchiveFormat(dir, 'findings.md');
  assert.ok(result !== null, '应返回缺失警告（防 session-start 全文注入）');
  assert.ok(/缺少|ARCHIVE/.test(result), `消息应提示 ARCHIVE 缺失: ${result}`);
});

test('checkArchiveFormat: spec.md 无 ARCHIVE → null（spec 无双区，不误报，层1关键）', () => {
  const dir = makeTmpDir('caf-spec-noarchive');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.md'), '# 规格\n\n技术栈说明\n');
  assert.strictEqual(checkArchiveFormat(dir, 'spec.md'), null, 'spec.md 不在 ARCHIVE_REQUIRED_FILES，缺失不应报错');
});

// ============================================================
// 5. getProjectName()
// ============================================================
console.log('\n--- getProjectName ---');

test('正常目录名 → 小写连字符', () => {
  assert.strictEqual(getProjectName('/foo/My Project'), 'my-project');
});

test('已小写无空格 → 原样返回', () => {
  assert.strictEqual(getProjectName('/foo/paceflow-hooks'), 'paceflow-hooks');
});

test('普通 worktrees/<name> 路径无 git 信号 → 不误判宿主项目', () => {
  assert.strictEqual(getProjectName('/foo/paceflow-hooks/worktrees/smoke-test'), 'smoke-test');
});

test('.claude/worktrees/<name> 路径 → .claude 父级项目名', () => {
  assert.strictEqual(getProjectName('/foo/paceflow/.claude/worktrees/smoke-test'), 'paceflow');
});

test('真实 git worktree .git 文件 → 宿主项目名', () => {
  const root = makeTmpDir('gpn-git-worktree');
  const host = path.join(root, 'paceflow-hooks');
  const worktree = path.join(host, 'worktrees', 'smoke-test');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'smoke-test')}\n`, 'utf8');
  assert.strictEqual(getProjectName(worktree), 'paceflow-hooks');
});

// ============================================================
// 5b. artifact path helpers
// ============================================================
console.log('\n--- artifact path helpers ---');

test('resolveToolFilePath: 相对路径基于 cwd 解析', () => {
  const dir = makeTmpDir('rtfp-relative');
  assert.strictEqual(resolveToolFilePath(dir, 'changes/chg-20260506-01.md'), path.join(dir, 'changes', 'chg-20260506-01.md').replace(/\\/g, '/'));
});

test('resolveToolFilePath: 绝对路径保持原样', () => {
  assert.strictEqual(resolveToolFilePath('/tmp/project', '/tmp/project/task.md'), '/tmp/project/task.md');
});

test('isArtifactRelativePath: 根索引和 changes 详情为 artifact', () => {
  assert.strictEqual(isArtifactRelativePath('task.md'), true);
  assert.strictEqual(isArtifactRelativePath('changes/chg-20260506-01.md'), true);
  assert.strictEqual(isArtifactRelativePath('changes/findings/finding-2026-05-06-test.md'), true);
  assert.strictEqual(isArtifactRelativePath('src/task.md'), false);
});

test('artifactRelativePathForFile: 返回 cwd 内 artifact 相对路径', () => {
  const dir = makeTmpDir('arff-artifact');
  assert.strictEqual(artifactRelativePathForFile(dir, path.join(dir, 'changes', 'corrections', 'correction-2026-05-06-01-test.md')), 'changes/corrections/correction-2026-05-06-01-test.md');
});

test('artifactRelativePathForFile: 普通代码文件返回 null', () => {
  const dir = makeTmpDir('arff-code');
  assert.strictEqual(artifactRelativePathForFile(dir, path.join(dir, 'src', 'task.md')), null);
  assert.strictEqual(artifactRelativePathForFile(dir, path.join(dir, 'src.js')), null);
});

// PU-001：绝对路径含 `.`/`..` 段必须折叠后再判定，否则 `<proj>/./changes/x.md`
// 绕过 marker-guard 等全部 artifact 写保护，并可注入 `<!-- APPROVED -->` 伪造批准门。
test('resolveToolFilePath: 绝对路径折叠 `.` 段（PU-001）', () => {
  assert.strictEqual(resolveToolFilePath('/tmp/project', '/tmp/project/./changes/chg-x.md'), '/tmp/project/changes/chg-x.md');
});

test('resolveToolFilePath: 绝对路径折叠 `..` 段（PU-001）', () => {
  assert.strictEqual(resolveToolFilePath('/tmp/project', '/tmp/project/sub/../changes/chg-x.md'), '/tmp/project/changes/chg-x.md');
});

test('resolveToolFilePath: 折叠不破坏 Windows 盘符路径（PU-001）', () => {
  // path.posix.normalize 纯字符串折叠，保留 `C:/`；若误用 path.resolve 会在非 win32 上把盘符当相对路径破坏
  assert.strictEqual(resolveToolFilePath('C:/proj', 'C:/proj/./changes/chg-x.md'), 'C:/proj/changes/chg-x.md');
});

test('isArtifactRelativePath: `.` 段形态仍判定为 artifact（PU-001 纵深防御）', () => {
  assert.strictEqual(isArtifactRelativePath('./changes/chg-x.md'), true);
  assert.strictEqual(isArtifactRelativePath('changes/./chg-x.md'), true);
  assert.strictEqual(isArtifactRelativePath('./task.md'), true);
  assert.strictEqual(isArtifactRelativePath('../outside/changes/x.md'), false);
});

test('artifactRelativePathForFile: `.`/`..` 段绝对路径不绕过 artifact 判定（PU-001）', () => {
  const dir = makeTmpDir('arff-dot-segment');
  // 字符串拼接构造含 `.` 的绝对路径（path.join 会自动折叠，无法复现绕过）
  assert.strictEqual(artifactRelativePathForFile(dir, dir + '/./changes/chg-x.md'), 'changes/chg-x.md');
  assert.strictEqual(artifactRelativePathForFile(dir, dir + '/sub/../changes/chg-x.md'), 'changes/chg-x.md');
  // control：无 `.` 段仍正常解析
  assert.strictEqual(artifactRelativePathForFile(dir, dir + '/changes/chg-x.md'), 'changes/chg-x.md');
});

// ============================================================
// command-recognition 共享识别原语（CHG-20260604-01）
// ============================================================
console.log('\n--- command-recognition ---');

const { segmentAnchorPrefix, scanRedirectTargets, commandRunsScriptEngine, BASH_WRAPPERS } = cmdRecognition;

test('segmentAnchorPrefix: 换行/分号/&&/管道/分组后的动词都被段首锚定', () => {
  const re = new RegExp(segmentAnchorPrefix({ extraChars: '\\n;&|(){}', wrappers: BASH_WRAPPERS }) + 'rm\\b', 'i');
  assert.ok(re.test('echo hi\nrm task.md'), '换行');
  assert.ok(re.test('echo hi; rm task.md'), '分号');
  assert.ok(re.test('echo hi && rm task.md'), '&&');
  assert.ok(re.test('echo hi | rm task.md'), '管道');
  assert.ok(re.test('{ rm task.md; }'), '花括号分组');
  assert.ok(re.test('(rm task.md)'), '圆括号分组');
  assert.ok(re.test('rm task.md'), '裸命令');
});

test('segmentAnchorPrefix: wrapper 与 for…do 前缀剥离后锚定动词', () => {
  const re = new RegExp(segmentAnchorPrefix({ extraChars: '\\n;&|(){}', wrappers: BASH_WRAPPERS, allowLoops: true }) + 'rm\\b', 'i');
  assert.ok(re.test('env rm task.md'), 'env');
  assert.ok(re.test('env FOO=1 rm task.md'), 'env 赋值');
  assert.ok(re.test('sudo rm task.md'), 'sudo');
  assert.ok(re.test('sudo -n rm task.md'), 'sudo flag');
  assert.ok(re.test('nohup rm task.md'), 'nohup');
  assert.ok(re.test('for f in .pace/locks/*; do rm "$f"; done'), 'for…do');
  assert.ok(re.test('ls | xargs rm task.md'), 'xargs 管道剥离（RES-GUARD）');
});

test('segmentAnchorPrefix: 不把动词作为单词一部分误锚定', () => {
  const re = new RegExp(segmentAnchorPrefix({ extraChars: '\\n;&|(){}', wrappers: BASH_WRAPPERS }) + 'rm\\b', 'i');
  assert.ok(!re.test('confirm task.md'), 'confirm 不含段首 rm');
});

test('scanRedirectTargets: 提取重定向目标，单引号内反斜杠字面不吞引号（BG-03）', () => {
  assert.deepStrictEqual(scanRedirectTargets('echo x > task.md', '\\'), ['task.md']);
  assert.deepStrictEqual(scanRedirectTargets('echo x >> changes/y.md', '\\'), ['changes/y.md']);
  assert.ok(scanRedirectTargets("echo 'C:\\' > task.md", '\\').includes('task.md'), '单引号字面后的 redirect 不漏检');
});

test('scanRedirectTargets: 引号内的 > 不算重定向', () => {
  assert.deepStrictEqual(scanRedirectTargets('echo "a > b"', '\\'), []);
  assert.deepStrictEqual(scanRedirectTargets("echo 'a > b'", '\\'), []);
});

test('commandRunsScriptEngine: 裸/路径前缀/env 包装的 node/python 都识别（BG-04）', () => {
  assert.strictEqual(commandRunsScriptEngine('node x.js'), true, '裸 node');
  assert.strictEqual(commandRunsScriptEngine('/usr/bin/node x.js'), true, '路径前缀');
  assert.strictEqual(commandRunsScriptEngine('env node x.js'), true, 'env 包装');
  assert.strictEqual(commandRunsScriptEngine('env FOO=1 python3 x.py'), true, 'env 赋值 + python3');
  assert.strictEqual(commandRunsScriptEngine('echo hi\nnode x.js'), true, '换行后');
  assert.strictEqual(commandRunsScriptEngine('cat x.js'), false, 'cat 不是引擎');
  assert.strictEqual(commandRunsScriptEngine('grep node x'), false, 'node 作搜索词不算');
});

// ============================================================
// bash-guard 识别层修复（CHG-20260604-01 T-002：BG-01~04）
// ============================================================
console.log('\n--- bash-guard BG-01~04 ---');

test('bash-guard BG-01: 换行/分组/wrapper/for…do/&& 分隔的 mutating 动词都识别', () => {
  const m = bashGuard.bashCommandLooksMutating;
  assert.ok(m('echo hi\nrm x.md'), '换行 rm');
  assert.ok(m('for f in a b; do rm "$f"; done'), 'for…do rm');
  assert.ok(m('{ rm x.md; }'), '花括号分组');
  assert.ok(m('(rm x.md)'), '圆括号分组');
  assert.ok(m('env rm x.md'), 'env wrapper');
  assert.ok(m('sudo -n rm x.md'), 'sudo wrapper');
  assert.ok(m('echo ok && rm x.md'), '&& 链式');
  assert.ok(m('rm x.md'), '裸 rm（回归）');
  assert.ok(m('echo hi; rm x.md'), '分号（回归）');
});

test('bash-guard BG-02: in-place 编辑器扩展识别', () => {
  const m = bashGuard.bashCommandLooksMutating;
  assert.ok(m('sed --in-place s/a/b/ x.md'), 'sed --in-place');
  assert.ok(m('sed -i s/a/b/ x.md'), 'sed -i（回归）');
  assert.ok(m('perl -i -pe s/a/b/ x.md'), 'perl -i -pe 拆分选项');
  assert.ok(m('perl -pi -e s/a/b/ x.md'), 'perl -pi 连写（回归）');
  assert.ok(m('sponge x.md'), 'sponge');
  assert.ok(m('gawk -i inplace {print} x.md'), 'gawk -i inplace');
});

test('bash-guard: 只读命令不误判 mutating（防 over-block）', () => {
  const m = bashGuard.bashCommandLooksMutating;
  assert.ok(!m('cat x.md'), 'cat');
  assert.ok(!m('grep foo x.md'), 'grep');
  assert.ok(!m('wc -l x.md'), 'wc');
});

test('bash-guard BG-05: python/node open() 仅写模式判 mutating，read-only open 不 over-block', () => {
  const m = bashGuard.bashCommandLooksMutating;
  assert.ok(!m("python -c \"open('x.md').read()\""), 'read-only open(f) 单参');
  assert.ok(!m("python -c \"open('x.md', 'r').read()\""), "open(f,'r') 读模式");
  assert.ok(!m("python3 -c \"data = open('x.md', 'rb').read()\""), "open(f,'rb') 读二进制");
  assert.ok(m("python -c \"open('x.md', 'w').write('z')\""), "open(f,'w') 写");
  assert.ok(m("python -c \"open('x.md', 'a').write('z')\""), "open(f,'a') 追加");
  assert.ok(m("python -c \"open('x.md', 'r+').write('z')\""), "open(f,'r+') 读写");
});

test('bash-guard BG-06: 替代引擎 deno/bun/ts-node/ruby/php 内联写 artifact 被检测', () => {
  const m = bashGuard.bashCommandLooksMutating;
  assert.ok(m("deno eval \"Deno.writeFileSync('x.md', d)\""), 'deno writeFileSync');
  assert.ok(m("bun -e \"require('fs').writeFileSync('x.md', d)\""), 'bun writeFileSync');
  assert.ok(m("ts-node -e \"require('fs').writeFileSync('x.md', d)\""), 'ts-node writeFileSync');
  assert.ok(m("ruby -e \"File.write('x.md', 'z')\""), 'ruby File.write');
  assert.ok(m("php -r \"file_put_contents('x.md', 'z');\""), 'php file_put_contents');
  assert.ok(m("php -r \"fopen('x.md', 'w');\""), 'php fopen 写模式');
  // 只读不误判（防 over-block）
  assert.ok(!m("ruby -e \"File.read('x.md')\""), 'ruby File.read 只读');
  assert.ok(!m("php -r \"file_get_contents('x.md');\""), 'php file_get_contents 只读');
});

test('bash-guard RES-GUARD: xargs 包装的 mutating 动词识别 + 只读不误判（审计 xargs 两轮点名残留）', () => {
  const m = bashGuard.bashCommandLooksMutating;
  assert.ok(m('ls | xargs rm task.md'), 'xargs rm');
  assert.ok(m('find . -name "*.md" | xargs rm'), 'find | xargs rm');
  assert.ok(m('cat list | xargs -n1 rm'), 'xargs -n1 选项剥离');
  assert.ok(!m('ls | xargs cat'), 'xargs cat 只读不误判（防 over-block）');
  assert.ok(!m('ls | xargs grep foo'), 'xargs grep 只读不误判');
});

test('bash-guard BG-01: runtime-control 锁经 for…do/分组/wrapper/换行删除均拦截', () => {
  const dir = makeTmpDir('bg-runtime');
  const mut = (cmd) => bashGuard.bashCommandMutatesArtifactRuntimeControl(cmd, dir);
  assert.ok(mut('rm .pace/locks/x'), '裸 rm 锁（回归）');
  assert.ok(mut('for f in .pace/locks/*; do rm "$f"; done'), 'for…do 删锁');
  assert.ok(mut('{ rm .pace/artifact-writer.lock; }'), '分组删锁');
  assert.ok(mut('env rm .pace/artifact-writer.lock'), 'env 删锁');
  assert.ok(mut('echo hi\nrm .pace/locks/x'), '换行删锁');
});

test('bash-guard BG-03: 单引号字面后的重定向到 artifact 不漏检', () => {
  const dir = makeTmpDir('bg-redirect');
  assert.ok(bashGuard.bashCommandRedirectsToArtifact("echo 'C:\\' > task.md", dir, dir), '单引号字面后 redirect 不漏');
  assert.ok(bashGuard.bashCommandRedirectsToArtifact('echo x > task.md', dir, dir), '普通 redirect（回归）');
});

test('bash-guard 1.4-dedup: bashCommandMutatesArtifact 组合谓词链（Bash/Monitor 共用，消内联重复，CHG-20260615-01）', () => {
  const dir = makeTmpDir('bg-mutates');
  const mut = (cmd) => bashGuard.bashCommandMutatesArtifact(cmd, dir, dir);
  assert.ok(mut('echo x > task.md'), 'redirect 写 artifact');
  assert.ok(mut("bash -c 'echo x > task.md'"), 'shell wrapper redirect');
  assert.ok(mut('rm task.md'), 'mutating 动词引用 artifact');
  assert.ok(!mut('cat task.md'), '只读 cat 不误判');
  assert.ok(!mut('grep x task.md'), '只读 grep 不误判');
});

test('#P3.2 ln 是 mutating 动词——ln 涉 artifact 被拦 + 非 artifact 不误伤（CHG-20260616-03 T-002）', () => {
  const dir = makeTmpDir('bg-ln');
  const mut = (cmd) => bashGuard.bashCommandMutatesArtifact(cmd, dir, dir);
  assert.ok(bashGuard.bashCommandLooksMutating('ln -sf x task.md'), 'ln 识别为 mutating 动词');
  assert.ok(mut('ln -sf x task.md'), 'ln -sf 覆盖 artifact 为符号链接被拦');
  assert.ok(mut('ln task.md backup'), 'ln 为 artifact 建 hard link（绕过入口）被拦');
  // over-block 反向：ln 不涉及 artifact 不误拦
  assert.ok(!mut('ln -s /usr/bin/foo /usr/local/bin/foo'), 'ln 不涉 artifact 不误拦');
});

// ============================================================
// powershell-guard 识别层修复（CHG-20260604-01 T-003：PSG-01~04 + A08）
// ============================================================
console.log('\n--- powershell-guard PSG/A08 ---');

test('powershell-guard PSG-01/02: 语句前缀 &/&&/分组/管道 ForEach 的 mutating 都识别', () => {
  const m = powershellGuard.powershellCommandLooksMutating;
  assert.ok(m('& Remove-Item x.md'), '& 调用操作符');
  assert.ok(m('Get-Date && Remove-Item x.md'), '&& 链式');
  assert.ok(m('$null=(Remove-Item x.md)'), '分组 (...)');
  assert.ok(m('gci | % { Remove-Item $_.FullName }'), '管道 ForEach { }');
  assert.ok(m('Remove-Item x.md'), '裸（回归）');
  assert.ok(m('Get-Date; Remove-Item x.md'), '分号（回归）');
});

test('powershell-guard A08: 默认别名 ri/rni/cpi/mi/clc 与 git 还原识别', () => {
  const m = powershellGuard.powershellCommandLooksMutating;
  assert.ok(m('ri x.md'), 'ri (Remove-Item)');
  assert.ok(m('rni a b'), 'rni (Rename-Item)');
  assert.ok(m('cpi a b'), 'cpi (Copy-Item)');
  assert.ok(m('mi a b'), 'mi (Move-Item)');
  assert.ok(m('clc x.md'), 'clc (Clear-Content)');
  assert.ok(m('git checkout x.md'), 'git checkout（与 bash 对称）');
});

test('powershell-guard A08: ri 别名删 runtime-control 锁被拦截', () => {
  const dir = makeTmpDir('ps-runtime');
  const mut = (cmd) => powershellGuard.powershellCommandMutatesArtifactRuntimeControl(cmd, dir);
  assert.ok(mut('Remove-Item .pace/artifact-writer.lock'), 'Remove-Item 锁（回归）');
  assert.ok(mut('ri .pace/artifact-writer.lock'), 'ri 删锁（A08）');
  assert.ok(mut('& Remove-Item .pace/locks/x'), '& 前缀删锁（PSG-01）');
});

test('powershell-guard 1.4-dedup: powershellCommandMutatesArtifact 组合谓词链（CHG-20260615-01）', () => {
  const dir = makeTmpDir('psg-mutates');
  const mut = (cmd) => powershellGuard.powershellCommandMutatesArtifact(cmd, dir, dir);
  assert.ok(mut('Set-Content task.md "x"'), 'Set-Content 写 artifact');
  assert.ok(mut('echo x > task.md'), 'PS redirect 写 artifact');
  assert.ok(mut('Remove-Item task.md'), 'Remove-Item 引用 artifact');
  assert.ok(!mut('Get-Content task.md'), '只读 Get-Content 不误判');
});

test('powershell-guard PSG-03: 反引号转义路径仍匹配 artifact', () => {
  const dir = makeTmpDir('ps-backtick');
  assert.ok(powershellGuard.powershellCommandReferencesArtifact('Set-Content ta`sk.md x', dir, dir), '反引号转义路径 ta`sk.md');
});

test('powershell-guard PSG-04/A02: 只读命令含 writeFileSync token 不 over-block', () => {
  const dir = makeTmpDir('ps-overblock');
  assert.ok(!powershellGuard.powershellCommandEmbedsArtifactWriteScript('Get-Content task.md | Select-String writeFileSync', dir, dir), '只读 Select-String token 放行');
  assert.ok(powershellGuard.powershellCommandEmbedsArtifactWriteScript("node -e \"require('fs').writeFileSync('task.md','x')\"", dir, dir), 'node 引擎写 artifact 仍拦');
});

test('powershell-guard RES-GUARD: `n/`r 语句分隔后的 mutating 识别（PSG-03 反噬修正）', () => {
  const m = powershellGuard.powershellCommandLooksMutating;
  // PowerShell `n 是单行多语句最地道写法，应当语句分隔符识别——不被剥成字面 n 而失锚
  assert.ok(m('Write-Host hi`nRemove-Item task.md'), '`n 分隔的 Remove-Item');
  assert.ok(m('Write-Host hi`r`nRemove-Item task.md'), '`r`n 分隔（CRLF）');
  // 只读不误判：`n 分隔的纯读命令不算 mutating（防 over-block）
  assert.ok(!m('Write-Host hi`nGet-Content task.md'), '`n 分隔 Get-Content 只读不误判');
  // 回归护栏：`s 等非分隔转义仍剥成字面（ta`sk.md → task.md，PSG-03 原行为）
  const dir = makeTmpDir('ps-backtick-regress');
  assert.ok(powershellGuard.powershellCommandReferencesArtifact('Set-Content ta`sk.md x', dir, dir), 'ta`sk.md 仍匹配 task.md');
});

// ============================================================
// monitor-guard：Monitor 工具的两段 artifact deny 文案构造器（CHG-20260622-05 抽出）
// ============================================================
console.log('\n--- monitor-guard ---');

test('MON-1. monitorArtifactRuntimeControlDenyReason 含运行态拒绝核心句 + 命令回显', () => {
  const r = monitorGuard.monitorArtifactRuntimeControlDenyReason('rm .pace/locks/x');
  assert.ok(r.includes('禁止使用 Monitor 修改 PaceFlow artifact 写入控制运行态'));
  assert.ok(r.includes('锁、编号计数与 reservation 只能由 hook 创建/释放'));
  assert.ok(r.includes('被拦截的命令：rm .pace/locks/x'));
});

test('MON-2. monitorArtifactDenyReason 含 artifact 拒绝核心句 + 命令回显', () => {
  const r = monitorGuard.monitorArtifactDenyReason('echo x > task.md');
  assert.ok(r.includes('禁止使用 Monitor 修改 artifact 文件'));
  assert.ok(r.includes('artifact 修改必须走 artifact-writer 的 Write/Edit 路径'));
  assert.ok(r.includes('被拦截的命令：echo x > task.md'));
});

test('MON-3. 命令回显截断 500 字符（防超长命令撑爆文案）', () => {
  const long = 'a'.repeat(800);
  assert.ok(monitorGuard.monitorArtifactRuntimeControlDenyReason(long).includes('a'.repeat(500)));
  assert.ok(!monitorGuard.monitorArtifactDenyReason(long).includes('a'.repeat(501)));
});

// ============================================================
// #3 子shell/命令替换内紧贴闭合 ) 绕过写保护修复（CHG-20260616-02 T-001）
// 动词锚点 extraChars 含 (){}（当分隔符识别动词），但 token/redirect 停止集漏 ()，
// 致 (rm task.md) 切成 'task.md)' 精确匹配 artifact 失配。只加 () 不加 {}（bash } 前
// 语法必有 ;/换行、紧贴不存在，加 {} 反而切坏 brace expansion cp a.{js,ts}）。
// ============================================================
console.log('\n--- #3 紧贴闭合符绕过修复 ---');

test('#3 scanRedirectTargets: 紧贴闭合 ) 的 redirect 目标切对、不吞 )（CHG-20260616-02 T-001）', () => {
  assert.deepStrictEqual(scanRedirectTargets('(echo x > task.md)', '\\'), ['task.md'], '子shell 闭合 )');
  assert.deepStrictEqual(scanRedirectTargets('$(echo x > changes/y.md)', '\\'), ['changes/y.md'], '命令替换闭合 )');
  // 反向 over-block：引号目标内的 ) 走引号分支保留完整、不切
  assert.deepStrictEqual(scanRedirectTargets('echo x > "a(b).md"', '\\'), ['a(b).md'], '引号目标含 () 不切');
});

test('#3 bash/ps mutatesArtifact: 子shell/命令替换包裹删除不绕过写保护（紧贴闭合 )）（CHG-20260616-02 T-001）', () => {
  const dir = makeTmpDir('subshell-bypass-3');
  const bmut = (cmd) => bashGuard.bashCommandMutatesArtifact(cmd, dir, dir);
  const pmut = (cmd) => powershellGuard.powershellCommandMutatesArtifact(cmd, dir, dir);
  assert.ok(bmut('(rm task.md)'), 'bash 子shell (rm task.md)');
  assert.ok(bmut('$(rm task.md)'), 'bash 命令替换 $(rm task.md)');
  assert.ok(bmut('(echo x > task.md)'), 'bash 子shell redirect');
  assert.ok(pmut('(Remove-Item task.md)'), 'ps 分组 (Remove-Item task.md)');
  assert.ok(pmut('$(Remove-Item task.md)'), 'ps 子表达式 $(...)');
  // R 审计补：PS 脚本块 {} 紧贴 } 缺口——PS {cmd} 脚本块紧贴 } 合法（不同 bash 必有 ;）、
  // 且 PS 无 brace expansion，故 PS token 停止集需加 {}（bash 侧不加，见下对照）。
  assert.ok(pmut('{Remove-Item task.md}'), 'ps 脚本块 {} 紧贴');
  assert.ok(pmut('& {Remove-Item task.md}'), 'ps & 脚本块紧贴 }');
  // 反向 over-block：非 artifact 不误拦 + 裸命令回归 + bash 不加 {} 对照
  assert.ok(!bmut('(rm other.txt)'), 'bash 非 artifact 不拦');
  assert.ok(bmut('rm task.md'), 'bash 裸 rm（回归）');
  assert.ok(bmut('{ rm task.md; }'), 'bash command-group 已拦（} 前有 ;，bash 不需加 {}）');
  assert.ok(!pmut('(Remove-Item other.txt)'), 'ps 非 artifact 不拦');
  assert.ok(!pmut('{Get-Content task.md}'), 'ps 脚本块只读不误拦（over-block 反向）');
  assert.ok(pmut('Remove-Item task.md'), 'ps 裸（回归）');
});

// ============================================================
// 反引号命令替换写保护补全——MUTATING_ANCHOR 补反引号与 $() 对称（CHG-20260616-07 T-001）
// `rm task.md`（反引号命令替换）与 $(rm task.md) 是 bash 命令替换等价语法（POSIX 同概念）；
// CHG-20260616-02 修 $() 时漏反引号，根因 MUTATING_ANCHOR extraChars 不含反引号、反引号内
// 动词不被段首锚定→looksMutating=false。补反引号到 extraChars（仅 bash MUTATING_ANCHOR；
// PS 反引号是转义符不加）。brace expansion / eval 属不同概念，按 finding 不堆特例不碰。
// ============================================================
console.log('\n--- 反引号命令替换对称补全 ---');

test('反引号命令替换包裹删除不绕过写保护，与 $() 对称（CHG-20260616-07 T-001）', () => {
  const dir = makeTmpDir('backtick-bypass-7');
  const bmut = (cmd) => bashGuard.bashCommandMutatesArtifact(cmd, dir, dir);
  // 正向：反引号命令替换内 mutating 动词引用 artifact 被拦（与 $(rm task.md) 对称）
  assert.ok(bmut('`rm task.md`'), 'bash 反引号命令替换 `rm task.md`');
  assert.ok(bmut('`rm changes/x.md`'), 'bash 反引号命令替换 changes/ 详情');
  assert.ok(bmut('echo `rm task.md`'), 'bash 反引号嵌在命令中');
  // 反向 over-block：反引号在 bash 仅命令替换语义，新增段首锚点不误伤合法用法
  assert.ok(!bmut('`rm other.txt`'), '反引号内非 artifact 不拦');
  assert.ok(!bmut('echo `date`'), '反引号内非 mutating 动词不拦（over-block）');
  assert.ok(!bmut('ls `which rm`'), '反引号内 which（非 mutating）不拦（over-block）');
  // over-block 关键：含 artifact 名但只读（referencesArtifact=true，靠 looksMutating=false pass）
  assert.ok(!bmut('cat task.md | grep `echo hi`'), '只读 cat task.md + 反引号 echo 不拦');
  assert.ok(!bmut('diff task.md `ls -t`'), '只读 diff task.md + 反引号 ls 不拦');
  assert.ok(!bmut('grep task.md `find . -name x.js`'), '只读 grep task.md + 反引号 find（无 -delete）不拦');
  // 回归：$() 与裸命令仍拦（不破坏既有）
  assert.ok(bmut('$(rm task.md)'), '$() 命令替换回归');
  assert.ok(bmut('rm task.md'), '裸 rm 回归');
});

test('powershell-guard RES-GUARD: `n 分隔删 runtime-control 锁被拦截', () => {
  const dir = makeTmpDir('ps-backtick-n-lock');
  const mut = (cmd) => powershellGuard.powershellCommandMutatesArtifactRuntimeControl(cmd, dir);
  assert.ok(mut('Write-Host x`nRemove-Item .pace/artifact-writer.lock'), '`n 分隔删锁');
});

test('powershell-guard HOTFIX-01: 双引号字面内 `n 不当语句分隔（over-block 防护，CHG-08 T-003 回归）', () => {
  const m = powershellGuard.powershellCommandLooksMutating;
  // 双引号字符串字面内的 `n 是输出文本换行、非命令分隔——字面内以 mutating cmdlet 开头的行不应被误判 mutating
  assert.ok(!m('Write-Output "task.md`nRemove-Item temp`ndone"'), '字面内 `n + Remove-Item 行首不误判（over-block）');
  assert.ok(!m('Write-Output "Updated task.md`nNew-Item logs created"'), '字面内 `n + New-Item 行首不误判');
  assert.ok(!m('Write-Host "See task.md`nMove-Item backup saved"'), '字面内 `n + Move-Item 行首不误判');
  // 回归护栏：引号【外】的 `n 仍当语句分隔——T-003 多语句绕过检测保住
  assert.ok(m('Write-Host hi`nRemove-Item task.md'), '引号外 `n 多语句仍检测（T-003 不退）');
  assert.ok(m('Write-Host hi`r`nRemove-Item task.md'), '引号外 `r`n 仍检测');
});

test('bash-guard HCR-01: open() mode= 关键字参数写模式识别（BG-05 收窄反噬修正）', () => {
  const m = bashGuard.bashCommandLooksMutating;
  assert.ok(m("python -c \"open('task.md', mode='w')\""), 'mode= 关键字（第二参）');
  assert.ok(m("python -c \"open(file='task.md', mode='w')\""), 'file=/mode= 全关键字');
  assert.ok(m("python3 -c \"open('task.md', encoding='utf8', mode='w')\""), 'mode= 在第三参');
  // 位置参回归 + 只读不误判（防 over-block）
  assert.ok(m("python -c \"open('task.md', 'w')\""), '位置参 w（回归）');
  assert.ok(!m("python -c \"open('task.md', mode='r')\""), 'mode=r 只读不误判');
  assert.ok(!m("python -c \"open('task.md').read()\""), '无模式只读（回归）');
});

test('powershell-guard HCR-01: open() mode= 识别 + 只读不 over-block（与 bash BG-05 对称）', () => {
  const m = powershellGuard.powershellCommandLooksMutating;
  assert.ok(m("python -c \"open('task.md', mode='w')\""), 'ps open mode=w');
  assert.ok(m("python -c \"open('task.md', 'w')\""), 'ps open 位置参 w');
  // 修 bash↔ps 不对称：ps:118 裸 open\\s*\\( 此前 over-block 只读
  assert.ok(!m("python -c \"open('task.md').read()\""), 'ps 只读 open 不 over-block');
  assert.ok(!m("python -c \"open('task.md', 'r')\""), 'ps open 读模式不误判');
});

// ============================================================
// CHG-B 解析/生命周期正确性（A05/A06/A07）
// ============================================================
console.log('\n--- CHG-B parse/lifecycle ---');

test('A05: agent-lifecycle-guard operation/action 行带尾随文字仍强制必填字段', () => {
  const deny = lifecycleGuard.agentLifecyclePromptDenyReason;
  assert.ok(deny('operation: close-chg 顺便归档\ntarget: CHG-20260101-01').includes('缺少必填字段'), 'close-chg 尾随文字缺字段应 deny');
  assert.ok(deny('operation: update-chg 立刻\naction: approve-and-start\ntarget: CHG-20260101-01').includes('缺少必填字段'), 'update-chg 尾随 + approve-and-start 缺字段应 deny');
  assert.ok(deny('operation: close-chg\ntarget: CHG-20260101-01').includes('缺少必填字段'), '干净 close-chg 缺字段 deny（回归）');
  assert.strictEqual(deny('operation: close-chg\ntarget: CHG-20260101-01\nverification-confirmed: true\ncomplete-open-tasks: true\nverify-summary: ok\nreview-confirmed: true\nreview-source: manual\nreview-findings: 0\nimplementation-notes: T-001 改 hello.js\nwalkthrough-summary: done'), '', '完整 close-chg 放行（回归）');
});

test('V7G-1: V/R 偏序确定性门——verify 要求已 APPROVED、review 要求已 VERIFIED、close 要求已 APPROVED', () => {
  const deny = lifecycleGuard.agentLifecyclePromptDenyReason;
  const dir = makeTmpDir('v7g-vr-order');
  const chgDir = path.join(dir, 'changes');
  fs.mkdirSync(chgDir, { recursive: true });
  const writeChg = (markers, verifiedDate) => fs.writeFileSync(path.join(chgDir, 'chg-20260614-09.md'),
    `---\nchg-id: CHG-20260614-09\nstatus: in-progress\ntype: change\nschema-version: "7.0"\nverified-date: ${verifiedDate || 'null'}\nreviewed-date: null\n---\n\n## 任务清单\n\n- [/] T-001 task${markers}\n\n## 实施详情\n`, 'utf8');
  const verifyPrompt = 'operation: update-chg\naction: verify\ntarget: CHG-20260614-09\nverify-summary: ok';
  const reviewPrompt = 'operation: update-chg\naction: review\ntarget: CHG-20260614-09\nreview-confirmed: true\nreview-source: manual\nreview-findings: 0';
  const closePrompt = 'operation: close-chg\ntarget: CHG-20260614-09\nverification-confirmed: true\ncomplete-open-tasks: true\nverify-summary: ok\nreview-confirmed: true\nreview-source: manual\nreview-findings: 0\nimplementation-notes: T-001 改 x.js\nwalkthrough-summary: done';

  // 未 APPROVED：verify / close 应 deny（偏序门）
  writeChg('', null);
  assert.ok(deny(verifyPrompt, dir).includes('APPROVED'), '未 APPROVED 的 verify 应 deny');
  assert.ok(deny(closePrompt, dir).includes('APPROVED'), '未 APPROVED 的 close 应 deny');

  // 已 APPROVED 未 VERIFIED：verify 放行、review deny、close 放行（反向不误伤）
  writeChg('\n\n<!-- APPROVED -->', null);
  assert.strictEqual(deny(verifyPrompt, dir), '', '已 APPROVED 的 verify 放行');
  assert.ok(deny(reviewPrompt, dir).includes('VERIFIED'), '未 VERIFIED 的 review 应 deny');
  assert.strictEqual(deny(closePrompt, dir), '', '已 APPROVED 的完整 close 放行');

  // 已 APPROVED 且 VERIFIED：review 放行
  writeChg('\n\n<!-- APPROVED -->\n<!-- VERIFIED -->', '2026-06-14T01:00:00+08:00');
  assert.strictEqual(deny(reviewPrompt, dir), '', '已 VERIFIED 的 review 放行');
});

test('V7G-2: 偏序门 fail-open——detail 读不到时不加新 deny（不误伤路径异常的合法操作）', () => {
  const deny = lifecycleGuard.agentLifecyclePromptDenyReason;
  const closePrompt = 'operation: close-chg\ntarget: CHG-20260614-09\nverification-confirmed: true\ncomplete-open-tasks: true\nverify-summary: ok\nreview-confirmed: true\nreview-source: manual\nreview-findings: 0\nimplementation-notes: T-001 改 x.js\nwalkthrough-summary: done';
  assert.strictEqual(deny(closePrompt), '', 'artDir 缺失时完整 close 放行（fail-open）');
  const dir = makeTmpDir('v7g-failopen');
  assert.strictEqual(deny(closePrompt, dir), '', 'detail 不存在时完整 close 放行（fail-open）');
});

test('V7G-3: unknown-operation 白名单 hard-deny——未知 operation deny、8 类合法 operation 放行', () => {
  const deny = lifecycleGuard.agentLifecyclePromptDenyReason;
  assert.ok(/delete-chg/.test(deny('operation: delete-chg\ntarget: CHG-20260101-01')), 'delete-chg 未知 operation 应 deny 并点名');
  assert.ok(deny('operation: merge-chg\ntarget: CHG-20260101-01') !== '', 'merge-chg 未知 operation 应 deny');
  assert.strictEqual(deny('operation: record-finding\ntitle: x\nsummary: y\ntype: observation\nimpact: P3\nbody: z'), '', 'record-finding 放行（白名单不误伤）');
  assert.strictEqual(deny('operation: update-finding\ntarget: finding-2026-01-01-x\nstatus: accepted'), '', 'update-finding 放行');
  assert.strictEqual(deny('operation: update-index\ntarget: findings.md\naction: reorder'), '', 'update-index 放行');
});

test('CHG-20260612-02: v5LayoutNoticeMessage——detected 即一句提示，changes/ 出现后消失', () => {
  const dir = makeTmpDir('v5-layout-notice');
  fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n\n- [ ] Legacy v5 item\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), '# Implementation Plan\n\n- [ ] Legacy v5 impl\n', 'utf8');
  const msg = v5LayoutNoticeMessage(dir);
  assert.ok(msg.includes('v5 时代 artifact 布局'), 'detected 应返回布局提示');
  assert.ok(msg.includes('不自动迁移'), '提示应声明不自动迁移');
  assert.ok(!/batch-archive|dry-run|AskUserQuestion|v5-migration-state/.test(msg), '提示不应再引用已退役的迁移工具/状态机');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  assert.strictEqual(v5LayoutNoticeMessage(dir), '', 'changes/ 出现后提示消失');
});

test('A07: 大写 [X] 索引行不污染 classifyChange', () => {
  const dir = makeTmpDir('a07-uppercase-checkbox');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260101-01.md'),
    '---\nchg-id: CHG-20260101-01\nstatus: completed\ntype: change\nschema-version: "6.0"\nverified-date: null\n---\n\n## 任务清单\n\n- [x] T-001 done\n\n<!-- APPROVED -->\n\n## 实施详情\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'task.md'), '# t\n\n## 活跃任务\n\n- [X] [[chg-20260101-01]] 测试 #change [tasks:: T-001]\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), '# i\n\n## 变更索引\n\n- [x] [[chg-20260101-01]] 测试 #change [tasks:: T-001]\n\n<!-- ARCHIVE -->\n', 'utf8');
  const e = paceUtils.getActiveChangeEntries(dir).find(x => x.id === 'CHG-20260101-01');
  assert.ok(e, '应解析到 CHG-20260101-01');
  const cls = paceUtils.classifyChange(e);
  assert.notStrictEqual(cls.reason, 'index-mismatch', '大写 [X] 不应误报 index-mismatch');
  assert.strictEqual(cls.category, 'closing-required', '应判 closing-required');
});

test('PSP-02: inferCloseTarget operation/target 同源（不跨 candidate 借 target）', () => {
  const ict = subagentStop.inferCloseTarget;
  // 同源：同一 candidate 同时有 operation + 显式 target → 正常返回
  const same = ict({ toolInput: { prompt: 'operation: close-chg\ntarget: CHG-20260101-01' }, raw: {} });
  assert.strictEqual(same.operation, 'close-chg');
  assert.strictEqual(same.target, 'CHG-20260101-01');
  // 不同源：operation 在 prompt（无 target），CHG id 只在 lastMessage → missing-target（不借）
  const diff = ict({ toolInput: { prompt: 'operation: close-chg' }, lastMessage: '处理了 CHG-20260202-02 相关讨论', raw: {} });
  assert.strictEqual(diff.operation, 'close-chg');
  assert.strictEqual(diff.target, '', '不同源不借 target');
  assert.strictEqual(diff.reason, 'missing-target');
  // 无 close/archive operation → missing-operation
  assert.strictEqual(ict({ lastMessage: 'CHG-20260202-02 完成', raw: {} }).reason, 'missing-operation');
});

test('SST-LAZY: inferCloseTarget 廉价 candidate 命中时不读 transcript（lazy，避免无谓 200KB I/O）', () => {
  const ict = subagentStop.inferCloseTarget;
  const tdir = makeTmpDir('sst-lazy-hit');
  const tpath = path.join(tdir, 'transcript.jsonl');
  // transcript 里放一个不同的 close target——验证廉价 candidate 命中时既不读盘也不借它
  fs.writeFileSync(tpath, JSON.stringify({ text: 'operation: close-chg\ntarget: CHG-20269999-99' }) + '\n', 'utf8');
  const origStat = fs.statSync;
  let transcriptRead = false;
  fs.statSync = function(p, ...rest) {
    if (p === tpath) transcriptRead = true;
    return origStat.call(fs, p, ...rest);
  };
  try {
    // 廉价 candidate（toolInput.prompt）已含 close-chg + 同源 target → 不应触碰 transcript
    const r = ict({
      toolInput: { prompt: 'operation: close-chg\ntarget: CHG-20260101-01' },
      agentTranscriptPath: tpath,
      raw: {},
    });
    assert.strictEqual(r.operation, 'close-chg');
    assert.strictEqual(r.target, 'CHG-20260101-01');
    assert.strictEqual(transcriptRead, false, '廉价 candidate 命中时不应读 transcript');
  } finally {
    fs.statSync = origStat;
  }
});

test('ECX-MEMO: executionContextForCwd 进程内 memo——同 cwd 第二次调用零新增 git fork + 突变隔离（HOTFIX-20260815-01 codex P2-2）', () => {
  const { execFileSync } = require('child_process');
  const tdir = makeTmpDir('ecx-memo');
  // 跨平台:不用 PATH shim(Windows 不认 shebang、PATHEXT 找 .exe/.cmd,shim 从不被调——CI 实测假绿),
  // 改在子进程用 Module._load 拦截 child_process.execFileSync 计数 git fork 并返回可控分支名。
  const code = [
    `const Module = require('module');`,
    `const realLoad = Module._load;`,
    `let gitCalls = 0;`,
    `Module._load = function (request, parent, isMain) {`,
    `  const mod = realLoad.apply(this, arguments);`,
    `  if (request === 'child_process') {`,
    `    return Object.assign({}, mod, { execFileSync: (file, args, opts) => {`,
    `      if (file === 'git') { gitCalls++; return 'fake-branch\\n'; }`,
    `      return mod.execFileSync(file, args, opts);`,
    `    } });`,
    `  }`,
    `  return mod;`,
    `};`,
    `const pu = require(${JSON.stringify(path.join(__dirname, '..', 'plugin', 'hooks', 'pace-utils', 'path-utils.js'))});`,
    `const a = pu.executionContextForCwd(${JSON.stringify(tdir)});`,
    `const n1 = gitCalls;`,
    `a.branch = 'MUTATED';`,
    `const b = pu.executionContextForCwd(${JSON.stringify(tdir)});`,
    `const n2 = gitCalls;`,
    `console.log(JSON.stringify({ n1, n2, firstBranch: a.branch, secondBranch: b.branch }));`,
  ].join('\n');
  const out = JSON.parse(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }).trim());
  assert.strictEqual(out.n1, 1, `首次调用应恰好 fork git 一次(实际 ${out.n1}),证明 spy 生效非假绿`);
  assert.strictEqual(out.n2, out.n1, `第二次调用不得新增 git fork(n1=${out.n1}, n2=${out.n2})`);
  assert.strictEqual(out.secondBranch, 'fake-branch', 'memo 返回浅拷贝——caller 突变不污染缓存');
});

test('SST-LAZY-FALLBACK: transcript 兜底仅提取 user/assistant 消息文本——裸对象/tool_result 不再入选（CHG-20260814-02 收窄）', () => {
  const ict = subagentStop.inferCloseTarget;
  const tdir = makeTmpDir('sst-lazy-fb');
  const tpath = path.join(tdir, 'transcript.jsonl');
  fs.writeFileSync(tpath, [
    // 裸对象（非 user/assistant 消息结构）排在前——旧的全字符串扫描会先命中它（archive-chg），
    // 收窄后不再提取；若此行被误配，下面的 close-chg 断言会失败
    JSON.stringify({ text: 'operation: archive-chg\ntarget: CHG-20260909-09' }),
    // dispatch prompt 真实形态：user message content——兜底仍生效
    JSON.stringify({ type: 'user', message: { content: 'operation: close-chg\ntarget: CHG-20260303-03' } }),
  ].join('\n') + '\n', 'utf8');
  const r = ict({
    toolInput: { prompt: '随便聊聊，无 operation 字段' },
    agentTranscriptPath: tpath,
    raw: {},
  });
  assert.strictEqual(r.operation, 'close-chg', '裸对象的 archive-chg 不得被提取（收窄负例）');
  assert.strictEqual(r.target, 'CHG-20260303-03', 'user message 的 dispatch prompt 兜底仍生效');
});

test('locks 2.6: reservationMatchesArtifactRel 契约锁——fail-open 仅 null 输入 + 真 mismatch 检出（CHG-20260615-02）', () => {
  const m = paceUtils.reservationMatchesArtifactRel;
  const resv = { filePrefix: 'changes/chg-20260101-01-' };
  // fail-open 契约（「检查不适用」路径，非跳过校验）：缺 reservation 或缺 rel → ok:true
  assert.strictEqual(m(null, 'changes/chg-20260101-01-x.md').ok, true, 'null reservation → fail-open ok');
  assert.strictEqual(m(resv, '').ok, true, 'null/空 artifactRel → fail-open ok');
  // 正向匹配两路：① 带 slug 全名 startsWith filePrefix；② 精确 stem.md（lookup 推的无 slug 名）
  assert.strictEqual(m(resv, 'changes/chg-20260101-01-some-slug.md').ok, true, '带 slug 全名匹配');
  assert.strictEqual(m(resv, 'changes/chg-20260101-01.md').ok, true, '精确 stem.md 匹配');
  // 真 mismatch（rel 是 CHG 模式但指向另一个 id）→ ok:false + expected/actual，护栏不被 fail-open 吞掉
  const bad = m(resv, 'changes/chg-20260202-02-other.md');
  assert.strictEqual(bad.ok, false, '不同 CHG id → mismatch 检出（非误放行）');
  assert.ok(bad.expected && bad.actual, 'mismatch 返回 expected/actual 供 deny 文案');
  // 非 reserved-id 模式的 rel（普通 artifact）→ ok:true（该函数只校验 reserved-id 文件，其余不适用）
  assert.strictEqual(m(resv, 'task.md').ok, true, '非 reserved-id 模式 rel 不适用→ok');
});

test('change-id helpers: CHG/HOTFIX 归一与非法值拒绝', () => {
  const dir = makeTmpDir('change-id-helpers');
  assert.strictEqual(normalizeChangeId(' chg-20260514-01 '), 'CHG-20260514-01');
  assert.strictEqual(normalizeChangeId('hotfix-20260514-02'), 'HOTFIX-20260514-02');
  assert.strictEqual(normalizeChangeId('chg-20260514-1'), '');
  assert.strictEqual(slugForChangeId('CHG-20260514-01'), 'chg-20260514-01');
  assert.strictEqual(slugForChangeId('HOTFIX-20260514-02'), 'hotfix-20260514-02');
  assert.strictEqual(slugForChangeId('chg-not-a-date'), '');
  assert.strictEqual(detailPathForId(dir, 'CHG-20260514-01'), path.join(dir, 'changes', 'chg-20260514-01.md'));
  assert.strictEqual(detailPathForId(dir, 'HOTFIX-20260514-02'), path.join(dir, 'changes', 'hotfix-20260514-02.md'));
  assert.strictEqual(detailPathForId(dir, 'CHG-20260514-1'), null);
});

// ============================================================
// 5c. session id + runtime locks
// ============================================================
console.log('\n--- session id + runtime locks ---');

test('parseHookStdin 解析 session_id 且 logEntry 自动带 sid', () => {
  // currentSessionId() 优先读 env.CLAUDE_CODE_SESSION_ID，会覆盖 parseHookStdin 记录的值；
  // 真实 Claude Code 会话内该 env 非空，故测试前临时清除以验证 stdin→logEntry 链路，finally 恢复避免污染后续用例。
  const savedSid = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const parsed = parseHookStdin(JSON.stringify({ session_id: 'session-test-1', tool_name: 'Bash' }));
    assert.strictEqual(parsed.sessionId, 'session-test-1');
    assert.ok(logEntry('UnitHook', 'TEST', { proj: 'demo' }).includes('sid=session-test-1'));
  } finally {
    if (savedSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedSid;
  }
});

test('legacy artifact-writer lock 只作为兼容阻断信号读取', () => {
  const dir = makeTmpDir('legacy-awl-read');
  const lockPath = getArtifactWriterLockPath(dir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    sessionId: 'sid-legacy',
    agentId: 'agent-legacy',
    artifactDir: dir,
    timestampMs: Date.now(),
  }), 'utf8');
  assert.strictEqual(readArtifactWriterLock(dir).sessionId, 'sid-legacy');
  assert.strictEqual(artifactWriterLockMatches(dir, 'sid-legacy').ok, true);
  assert.strictEqual(artifactWriterLockMatches(dir, 'sid-other').ok, false);
});

test('legacy artifact-writer stale lock 读取时清理，不再重建项目级锁', () => {
  const dir = makeTmpDir('legacy-awl-stale');
  const lockPath = getArtifactWriterLockPath(dir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    sessionId: 'sid-stale',
    artifactDir: dir,
    timestampMs: 1,
  }), 'utf8');
  const match = artifactWriterLockMatches(dir, 'sid-stale');
  assert.strictEqual(match.ok, false);
  assert.strictEqual(match.reason, 'stale-cleared');
  assert.strictEqual(fs.existsSync(lockPath), false);
});

test('json lock 默认允许同 owner 重入，序列锁可显式关闭重入', () => {
  const dir = makeTmpDir('json-lock-reentrant-option');
  const lockUtils = createLockUtils({
    getProjectRuntimeDir: d => path.join(d, '.pace'),
    displayDir: d => `${String(d || '').replace(/\\/g, '/')}/`,
    normalizeSessionId: s => String(s || '').trim(),
    currentSessionId: () => 'sid-json-lock',
    executionContextForCwd: () => ({ text: '[worktree:: main] [branch:: main]' }),
    normalizePath: p => String(p || '').replace(/\\/g, '/'),
    getArtifactDir: d => d,
    todayISO: () => '2026-05-30',
    CHANGE_OWNER_TTL_MS: paceUtils.CHANGE_OWNER_TTL_MS,
    PROJECT_ROOT_FILE: paceUtils.PROJECT_ROOT_FILE,
  });
  const lockPath = path.join(dir, '.pace', 'locks', 'sequences', 'chg.lock');
  const payload = { sessionId: 'sid-json-lock', ownerKey: 'session:sid-json-lock', resource: 'sequence:chg' };
  const first = lockUtils.acquireJsonLock(lockPath, payload, { ttlMs: 30000, waitMs: 1 });
  const exclusive = lockUtils.acquireJsonLock(lockPath, payload, { ttlMs: 30000, waitMs: 1, reentrant: false });
  const reentrant = lockUtils.acquireJsonLock(lockPath, payload, { ttlMs: 30000, waitMs: 1 });
  assert.strictEqual(first.acquired, true);
  assert.strictEqual(exclusive.acquired, false);
  assert.strictEqual(exclusive.reason, 'locked');
  assert.strictEqual(reentrant.acquired, true);
  assert.strictEqual(reentrant.reentrant, true);
});

test('acquireJsonLock: in-flight 空锁文件（mtime 新）不被判 stale 抢占（ROB-02）', () => {
  const dir = makeTmpDir('json-lock-inflight-empty');
  const lockUtils = createLockUtils({
    getProjectRuntimeDir: d => path.join(d, '.pace'),
    displayDir: d => `${String(d || '').replace(/\\/g, '/')}/`,
    normalizeSessionId: s => String(s || '').trim(),
    currentSessionId: () => 'sid-inflight',
    executionContextForCwd: () => ({ text: '[worktree:: main] [branch:: main]' }),
    normalizePath: p => String(p || '').replace(/\\/g, '/'),
    getArtifactDir: d => d,
    todayISO: () => '2026-06-04',
    CHANGE_OWNER_TTL_MS: paceUtils.CHANGE_OWNER_TTL_MS,
    PROJECT_ROOT_FILE: paceUtils.PROJECT_ROOT_FILE,
  });
  const lockPath = path.join(dir, '.pace', 'locks', 'sequences', 'chg.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // 模拟另一进程 openSync(wx) 已建锁但尚未写 body 的 in-flight 空文件窗口
  fs.writeFileSync(lockPath, '');
  const r = lockUtils.acquireJsonLock(lockPath, { sessionId: 'sid-other', ownerKey: 'session:sid-other', resource: 'sequence:chg' }, { ttlMs: 30000, waitMs: 5, reentrant: false });
  assert.strictEqual(r.acquired, false, 'in-flight 空锁（mtime 新）不应被判 stale 抢占');
  assert.ok(fs.existsSync(lockPath), 'in-flight 空锁文件不应被 unlink');
});

test('reserveArtifactId 遇同 session sequence lock 不重入分配重复编号', () => {
  const dir = makeTmpDir('reservation-sequence-no-reentrant');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  const origSid = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-sequence-lock';
  try {
    const compact = paceUtils.todayISO().replace(/-/g, '');
    const lockPath = path.join(dir, '.pace', 'locks', 'sequences', `chg-${compact}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      version: 'sequence-v1',
      resource: `sequence:chg-${compact}`,
      sessionId: 'sid-sequence-lock',
      ownerKey: 'session:sid-sequence-lock',
      timestampMs: Date.now(),
    }), 'utf8');
    const result = reserveArtifactId(dir, {
      sessionId: 'sid-sequence-lock',
      artifactDir: dir,
      operation: 'create-chg',
      prompt: 'operation: create-chg',
    });
    assert.strictEqual(result.reserved, false);
    assert.strictEqual(result.reason, 'sequence-locked');
  } finally {
    if (origSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = origSid;
  }
});

test('artifact resource lock 按文件资源互斥，不同资源可并发', () => {
  const dir = makeTmpDir('arl-basic');
  const detailA = 'detail:changes/chg-20260510-01.md';
  const detailB = 'detail:changes/chg-20260510-02.md';
  const first = acquireArtifactResourceLock(dir, detailA, { sessionId: 'sid-a', agentId: 'agent-a', file: 'changes/chg-20260510-01.md' });
  assert.strictEqual(first.acquired, true);
  assert.strictEqual(readArtifactResourceLock(dir, detailA).sessionId, 'sid-a');

  const sameResource = acquireArtifactResourceLock(dir, detailA, { sessionId: 'sid-b', agentId: 'agent-b', file: 'changes/chg-20260510-01.md' });
  assert.strictEqual(sameResource.acquired, false);
  assert.strictEqual(sameResource.lock.sessionId, 'sid-a');

  const otherResource = acquireArtifactResourceLock(dir, detailB, { sessionId: 'sid-b', agentId: 'agent-b', file: 'changes/chg-20260510-02.md' });
  assert.strictEqual(otherResource.acquired, true);
  assert.strictEqual(releaseArtifactResourceLock(dir, detailA, { sessionId: 'sid-a', agentId: 'agent-a' }).released, true);
  assert.strictEqual(releaseArtifactResourceLock(dir, detailB, { sessionId: 'sid-b', agentId: 'agent-b' }).released, true);
});

test('artifact resource stale lock 被其他进程删除时继续重试获取', () => {
  const dir = makeTmpDir('arl-stale-enoent');
  const resource = 'detail:changes/chg-20260510-01.md';
  const lockPath = getArtifactResourceLockPath(dir, resource);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    version: 'resource-v1',
    resource,
    sessionId: 'sid-stale',
    ownerKey: 'session:sid-stale',
    timestampMs: 1,
  }), 'utf8');

  const originalUnlinkSync = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && target === lockPath) {
      injected = true;
      originalUnlinkSync(target);
      const err = new Error('ENOENT: simulated concurrent stale resource cleanup');
      err.code = 'ENOENT';
      throw err;
    }
    return originalUnlinkSync(target);
  };
  try {
    const acquired = acquireArtifactResourceLock(dir, resource, {
      sessionId: 'sid-resource-retry',
      file: 'changes/chg-20260510-01.md',
    });
    assert.strictEqual(acquired.acquired, true);
    assert.strictEqual(readArtifactResourceLock(dir, resource).sessionId, 'sid-resource-retry');
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
});

test('artifact resource read path 自动清理 stale lock', () => {
  const dir = makeTmpDir('arl-read-stale-self-heal');
  const resource = 'detail:changes/chg-20260510-01.md';
  const lockPath = getArtifactResourceLockPath(dir, resource);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    version: 'resource-v1',
    resource,
    sessionId: 'sid-stale-read',
    ownerKey: 'session:sid-stale-read',
    timestampMs: 1,
  }), 'utf8');

  const lock = readArtifactResourceLock(dir, resource);
  assert.strictEqual(lock.ok, false);
  assert.strictEqual(lock.stale, true);
  assert.strictEqual(fs.existsSync(lockPath), false);
});

test('artifact resource read path 对缺失锁保持普通 ok:false', () => {
  const dir = makeTmpDir('arl-read-missing');
  const resource = 'detail:changes/chg-20260510-01.md';
  const lock = readArtifactResourceLock(dir, resource);
  assert.strictEqual(lock.ok, false);
  assert.strictEqual(lock.code, 'ENOENT');
  assert.strictEqual(lock.stale, undefined);
});

test('index:changes 在 task.md 单文件触碰后直接释放（v7 index-transaction 退役）', () => {
  const dir = makeTmpDir('arl-index');
  const resource = artifactResourceForRel('task.md');
  assert.strictEqual(resource, 'index:changes', '资源名保留（旧版本并发 session 锁互斥依赖同名）');
  assert.strictEqual(artifactResourceForRel('implementation_plan.md'), '', 'v7: impl_plan 不再映射资源');
  const lock = acquireArtifactResourceLock(dir, resource, { sessionId: 'sid-index', agentId: 'agent-index', file: 'task.md' });
  assert.strictEqual(lock.acquired, true);
  const first = markIndexChangesTouchedAndMaybeRelease(dir, 'task.md', { sessionId: 'sid-index', agentId: 'agent-index' });
  assert.strictEqual(first.released, true, 'v7: 单文件触碰即释放，不再等 impl_plan');
  assert.strictEqual(readArtifactResourceLock(dir, resource).ok, false);
});

test('reserveArtifactId 为 create-chg 原子分配 CHG 编号并写 reservation', () => {
  const dir = makeTmpDir('reservation-chg');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  const first = reserveArtifactId(dir, {
    sessionId: 'sid-reserve',
    artifactDir: dir,
    operation: 'create-chg',
    prompt: 'operation: create-chg',
  });
  assert.strictEqual(first.reserved, true);
  assert.ok(/^CHG-\d{8}-01$/.test(first.id));
  assert.strictEqual(readArtifactReservation(dir, { sessionId: 'sid-reserve' }).fileRel, first.fileRel);
  const second = reserveArtifactId(dir, {
    sessionId: 'sid-reserve-2',
    artifactDir: dir,
    operation: 'create-chg',
    prompt: 'operation: create-chg',
  });
  assert.strictEqual(second.reserved, true);
  assert.ok(second.id.endsWith('-02'));
});

test('#P3.4 sequence counter 被外部写成浮点不产非整数编号（CHG-20260616-03 T-002）', () => {
  const dir = makeTmpDir('counter-float');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  reserveArtifactId(dir, { sessionId: 'sid-cf', artifactDir: dir, operation: 'create-chg', prompt: 'operation: create-chg' });
  // 模拟运行态 counter 文件被外部损坏成浮点
  const seqDir = path.join(getProjectRuntimeDir(dir), 'sequences');
  const counters = fs.readdirSync(seqDir).filter(f => f.endsWith('.counter'));
  assert.ok(counters.length > 0, 'counter 文件已生成');
  fs.writeFileSync(path.join(seqDir, counters[0]), '3.7\n', 'utf8');
  const second = reserveArtifactId(dir, { sessionId: 'sid-cf-2', artifactDir: dir, operation: 'create-chg', prompt: 'operation: create-chg' });
  assert.ok(second.reserved, 'second reserve ok');
  assert.ok(/^CHG-\d{8}-\d+$/.test(second.id), 'counter 浮点损坏后编号仍整数格式（无小数）：' + second.id);
});

test('R-47: counter 缺失时 existingMax 识别带 slug 的 CHG/HOTFIX 文件名，不重发同 ID', () => {
  const dir = makeTmpDir('reservation-slug-existingmax');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  // 与 todayISO 同口径（宿主本地时区，CHG-20260619-07 去硬编码后对齐），避免凌晨跨日断言漂移
  const dateCompact = new Date().toLocaleDateString('sv-SE').replace(/-/g, '');
  // 混合形态：带 slug（HOTFIX-20260610-01 后的常态）+ 无 slug 旧格式并存
  fs.writeFileSync(path.join(dir, 'changes', `chg-${dateCompact}-01-some-feature-slug.md`), '---\nstatus: planned\n---\n');
  fs.writeFileSync(path.join(dir, 'changes', `chg-${dateCompact}-02.md`), '---\nstatus: planned\n---\n');
  const chg = reserveArtifactId(dir, {
    sessionId: 'sid-slug-max',
    artifactDir: dir,
    operation: 'create-chg',
    prompt: 'operation: create-chg',
  });
  assert.strictEqual(chg.reserved, true);
  assert.strictEqual(chg.id, `CHG-${dateCompact}-03`, 'existingMax 必须扫到带 slug 文件取 max+1，而非重发 -01');
  // HOTFIX 分支同款缺陷同款修复：带 slug 的 hotfix 文件也计入 existingMax
  fs.writeFileSync(path.join(dir, 'changes', `hotfix-${dateCompact}-01-urgent-fix.md`), '---\nstatus: planned\n---\n');
  const hf = reserveArtifactId(dir, {
    sessionId: 'sid-slug-max-hf',
    artifactDir: dir,
    operation: 'create-chg',
    prompt: 'operation: create-chg\ntype: hotfix',
  });
  assert.strictEqual(hf.reserved, true);
  assert.strictEqual(hf.id, `HOTFIX-${dateCompact}-02`, 'HOTFIX 分支同样识别带 slug 文件名');
});

test('T-002（CHG-20260619-07）: todayISO 跟随宿主 TZ，不再硬编码 Asia/Shanghai——相隔 26h 的两时区日期必不同', () => {
  const { execFileSync } = require('child_process');
  const facade = path.join(__dirname, '..', 'plugin', 'hooks', 'pace-utils.js');
  const code = `process.stdout.write(require(${JSON.stringify(facade)}).todayISO())`;
  const eastDate = execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: 'Etc/GMT-14' }, encoding: 'utf8' }).trim();
  const westDate = execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: 'Etc/GMT+12' }, encoding: 'utf8' }).trim();
  // Etc/GMT-14=UTC+14 与 Etc/GMT+12=UTC-12 相隔 26h>24h，日历日恒不同；若仍硬编码 Asia/Shanghai 则两子进程同得 Shanghai 日期=相等
  assert.notStrictEqual(eastDate, westDate, `todayISO 应跟随宿主 TZ（east=${eastDate} west=${westDate}），若相等说明仍硬编码 Asia/Shanghai`);
});

test('同一 session 多个 reservation 可按目标文件精确匹配', () => {
  const dir = makeTmpDir('reservation-same-session');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  const first = reserveArtifactId(dir, {
    sessionId: 'sid-same',
    artifactDir: dir,
    operation: 'create-chg',
    prompt: 'operation: create-chg',
  });
  const second = reserveArtifactId(dir, {
    sessionId: 'sid-same',
    artifactDir: dir,
    operation: 'create-chg',
    prompt: 'operation: create-chg',
  });
  assert.strictEqual(first.reserved, true);
  assert.strictEqual(second.reserved, true);
  // CHG-slug：CHG/HOTFIX reservation 改用 filePrefix（末尾 `-` 留 slug 占位），不再有精确 fileRel。
  assert.notStrictEqual(first.filePrefix, second.filePrefix);
  const owner = { sessionId: 'sid-same', agentId: 'agent-late' };
  const firstFile = `${first.filePrefix}detail.md`;
  const secondFile = `${second.filePrefix}detail.md`;
  // 带 slug 全名精确命中各自 reservation。
  assert.strictEqual(findArtifactReservationForRel(dir, owner, firstFile).filePrefix, first.filePrefix);
  assert.strictEqual(findArtifactReservationForRel(dir, owner, secondFile).filePrefix, second.filePrefix);
  // 精确 id 推的 rel（无 slug，batch 块 lookup 走此路）也须命中对的 reservation，不被多 reservation 顺序误取。
  const firstExactRel = `${first.filePrefix.replace(/-$/, '')}.md`;
  assert.strictEqual(findArtifactReservationForRel(dir, owner, firstExactRel).filePrefix, first.filePrefix);
  assert.strictEqual(clearArtifactReservationForRel(dir, owner, firstFile), true);
  assert.strictEqual(findArtifactReservationForRel(dir, owner, firstFile), null);
  assert.strictEqual(findArtifactReservationForRel(dir, owner, secondFile).filePrefix, second.filePrefix);
});

test('isArtifactRuntimeControlPath 识别锁/sequence/reservation 控制面', () => {
  const dir = makeTmpDir('runtime-control');
  assert.strictEqual(isArtifactRuntimeControlPath(dir, path.join(dir, '.pace', 'locks')), true);
  assert.strictEqual(isArtifactRuntimeControlPath(dir, path.join(dir, '.pace', 'locks', 'artifacts', 'x.lock')), true);
  assert.strictEqual(isArtifactRuntimeControlPath(dir, path.join(dir, '.pace', 'sequences', 'chg.counter')), true);
  assert.strictEqual(isArtifactRuntimeControlPath(dir, path.join(dir, '.pace', 'reservations', 'session.json')), true);
  assert.strictEqual(isArtifactRuntimeControlPath(dir, path.join(dir, '.pace', 'index-transactions', 'session.json')), true);
  assert.strictEqual(isArtifactRuntimeControlPath(dir, path.join(dir, '.pace', 'change-owners')), true);
  assert.strictEqual(isArtifactRuntimeControlPath(dir, path.join(dir, '.pace', 'change-owners', 'chg-20260504-01.json')), true);
  assert.strictEqual(isArtifactRuntimeControlPath(dir, path.join(dir, '.pace', 'artifact-root')), false);
});

// ============================================================
// 6. getArtifactDir()
// ============================================================
console.log('\n--- getArtifactDir ---');

test('CWD 有 artifact → 返回 CWD', () => {
  const dir = makeTmpDir('gad-cwd');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  // getArtifactDir 先检查 vault，vault 无 changes/ → 检查 CWD → 有 → 返回 CWD
  assert.strictEqual(getArtifactDir(dir), dir);
});

test('vault 有 artifact → 返回 vault', () => {
  const dir = makeTmpDir('gad-vault');
  const projectName = path.basename(dir).toLowerCase().replace(/\s+/g, '-');
  const vaultDir = path.join(paceUtils.VAULT_PATH, 'projects', projectName);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n');
  t.tmpDirs.push(vaultDir); // 清理
  assert.strictEqual(getArtifactDir(dir), vaultDir);
});

test('vault 和 CWD 都有 → vault 优先', () => {
  const dir = makeTmpDir('gad-both');
  fs.writeFileSync(path.join(dir, 'task.md'), '# cwd\n');
  const projectName = path.basename(dir).toLowerCase().replace(/\s+/g, '-');
  const vaultDir = path.join(paceUtils.VAULT_PATH, 'projects', projectName);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n');
  t.tmpDirs.push(vaultDir);
  assert.strictEqual(getArtifactDir(dir), vaultDir);
});

test('新项目（无 artifact、无配置）→ 默认本地项目根（F3 偏 local）', () => {
  const dir = makeTmpDir('gad-new');
  // F3：全新无配置项目默认偏 local（项目根），不再隐式指 vault；显式 artifact-root=vault 仍走 vault。
  assert.strictEqual(getArtifactDir(dir), dir);
});

test('新项目 + 显式 artifact-root=vault → 仍 vault（F3 不破坏显式选择，验反向）', () => {
  const dir = makeTmpDir('gad-new-vault-choice');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'vault\n', 'utf8');
  const projectName = path.basename(dir).toLowerCase().replace(/\s+/g, '-');
  const expected = path.join(paceUtils.VAULT_PATH, 'projects', projectName);
  assert.strictEqual(getArtifactDir(dir), expected, '显式 vault 选择优先级高于 F3 默认');
});

test('artifact-root=local → 返回项目本地目录', () => {
  const dir = makeTmpDir('gad-choice-local');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  assert.strictEqual(readArtifactRootChoice(dir), 'local');
  assert.strictEqual(getConfiguredArtifactDir(dir), dir);
  assert.strictEqual(getArtifactDir(dir), dir);
});

test('artifact-root=vault → 返回 vault 项目目录', () => {
  const dir = makeTmpDir('gad-choice-vault');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'vault\n', 'utf8');
  const projectName = path.basename(dir).toLowerCase().replace(/\s+/g, '-');
  const expected = path.join(paceUtils.VAULT_PATH, 'projects', projectName);
  assert.strictEqual(getArtifactDir(dir), expected);
});

test('_clearArtifactDirCache 刷新同进程 artifact-root 变更', () => {
  const dir = makeTmpDir('gad-cache-clear');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  assert.strictEqual(getArtifactDir(dir), dir);
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'vault\n', 'utf8');
  assert.strictEqual(getArtifactDir(dir), dir, '未清缓存前应保持同进程缓存值');
  _clearArtifactDirCache();
  const expected = path.join(paceUtils.VAULT_PATH, 'projects', path.basename(dir).toLowerCase().replace(/\s+/g, '-'));
  assert.strictEqual(getArtifactDir(dir), expected);
});

test('artifact-root 带引号/大小写 → 仍按关键词解析', () => {
  const dir = makeTmpDir('gad-choice-quoted-local');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), '"LOCAL"\n', 'utf8');
  assert.strictEqual(readArtifactRootChoice(dir), 'LOCAL');
  assert.strictEqual(getArtifactDir(dir), dir);
  assert.ok(!fs.existsSync(path.join(dir, '"LOCAL"')), '不应把带引号关键词当作相对目录名');
});

test('PACE_ARTIFACT_ROOT=local → 自动化环境跳过询问', () => {
  const dir = makeTmpDir('gad-choice-env-local');
  const prev = process.env.PACE_ARTIFACT_ROOT;
  process.env.PACE_ARTIFACT_ROOT = 'local';
  try {
    assert.strictEqual(readArtifactRootChoice(dir), 'local');
    assert.strictEqual(artifactRootChoiceNeeded(dir), false);
    assert.strictEqual(getArtifactDir(dir), dir);
  } finally {
    if (prev === undefined) delete process.env.PACE_ARTIFACT_ROOT;
    else process.env.PACE_ARTIFACT_ROOT = prev;
  }
});

test('PACE_ARTIFACT_ROOT 超长值会截断后再解析', () => {
  const dir = makeTmpDir('gad-choice-env-long');
  const prev = process.env.PACE_ARTIFACT_ROOT;
  process.env.PACE_ARTIFACT_ROOT = 'x'.repeat(5000);
  try {
    assert.strictEqual(readArtifactRootChoice(dir).length, 4096);
  } finally {
    if (prev === undefined) delete process.env.PACE_ARTIFACT_ROOT;
    else process.env.PACE_ARTIFACT_ROOT = prev;
  }
});

test('首次启用且 vault/local 都无 changes → 需要选择 artifact root', () => {
  const dir = makeTmpDir('gad-choice-needed');
  assert.strictEqual(artifactRootChoiceNeeded(dir), true);
  const msg = artifactRootChoiceMessage(dir);
  assert.ok(msg.includes('AskUserQuestion'));
  assert.ok(msg.includes(getArtifactRootChoicePath(dir).replace(/\\/g, '/')), 'HOTFIX-20260621-01：配置文件路径显示归一正斜杠（Windows 也匹配）');
  assert.ok(msg.includes('配置文件'), '应明确 artifact-root 是配置文件');
  assert.ok(msg.includes('不是 artifact 根目录'), '应明确配置文件不是 artifact 根目录');
	  assert.ok(msg.includes('只用于 PaceFlow artifacts'), '应明确 artifact_dir 的边界');
  assert.ok(msg.includes('set-artifact-root.js'), '应给出 artifact-root helper 路径');
	  assert.ok(msg.includes('reserve-artifact-id.js'), '应给出当前 helper 路径');
  assert.ok(msg.includes('不接受 --artifact-dir / --artifact-root / --project-dir'), '应明确 helper 不接受自造 artifact/root/project 参数');
});

// HOTFIX-20260621-01 守卫判别测试：注入 Windows 反斜杠路径，证明显示边界归一生效（POSIX 也判别，非平凡通过）。
test('HOTFIX-20260621-01: formatArtifactDirHint 对 Windows 反斜杠 choicePath/stateDir 显示归一正斜杠（同行三路径分隔符一致，防 GOLDEN 漂移）', () => {
  const hint = paceUtils.formatArtifactDirHint({
    artDir: 'C:\\proj',
    choice: 'local',
    choicePath: 'C:\\proj\\.pace\\artifact-root',
    stateDir: 'C:\\proj',
    mode: 'independent',
  });
  assert.ok(!hint.includes('\\'), 'HOTFIX：hint 不应含反斜杠（跨平台一致性契约）：' + hint);
  assert.ok(hint.includes('配置文件=C:/proj/.pace/artifact-root'), 'HOTFIX：choicePath 应归一为正斜杠：' + hint);
});

test('helper 脚本常量使用绝对当前 runtime 路径', () => {
  assert.ok(path.isAbsolute(SET_ARTIFACT_ROOT_SCRIPT));
  assert.ok(path.isAbsolute(SET_PROJECT_ROOT_SCRIPT));
  assert.ok(path.isAbsolute(RESERVE_ARTIFACT_ID_SCRIPT));
  assert.ok(path.isAbsolute(SYNC_PLAN_SCRIPT));
  assert.ok(SET_ARTIFACT_ROOT_SCRIPT.endsWith('/plugin/hooks/set-artifact-root.js'));
  assert.ok(SET_PROJECT_ROOT_SCRIPT.endsWith('/plugin/hooks/set-project-root.js'));
  assert.ok(RESERVE_ARTIFACT_ID_SCRIPT.endsWith('/plugin/hooks/reserve-artifact-id.js'));
  assert.ok(SYNC_PLAN_SCRIPT.endsWith('/plugin/hooks/sync-plan.js'));
});

test('检测到 v5 布局 → 不询问 artifact root，提示语为一句性布局提示', () => {
  const dir = makeTmpDir('gad-legacy-migration');
  fs.writeFileSync(path.join(dir, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n- [ ] Legacy task\n\n<!-- ARCHIVE -->\n');
  assert.strictEqual(artifactRootChoiceNeeded(dir), false);
  assert.strictEqual(getArtifactDir(dir), dir);
  const info = getV5MigrationInfo(dir);
  assert.strictEqual(info.detected, true);
  assert.deepStrictEqual(info.files, ['task.md']);
  const msg = v5LayoutNoticeMessage(dir);
  assert.ok(msg.includes('v5 时代 artifact 布局'));
  assert.ok(msg.includes('task.md'));
  assert.ok(!/batch-archive|dry-run|AskUserQuestion/.test(msg), '一句性提示不应引导迁移交互');
});

test('已有 changes 或已有选择 → 不需要 artifact root 选择', () => {
  const withChanges = makeTmpDir('gad-choice-existing');
  fs.mkdirSync(path.join(withChanges, 'changes'), { recursive: true });
  assert.strictEqual(artifactRootChoiceNeeded(withChanges), false);

  const withChoice = makeTmpDir('gad-choice-existing-choice');
  fs.mkdirSync(path.join(withChoice, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(withChoice, '.pace', 'artifact-root'), 'local\n', 'utf8');
  assert.strictEqual(artifactRootChoiceNeeded(withChoice), false);
});

test('子目录继承父级 PaceFlow Project Root 与 vault artifact', () => {
  const root = makeTmpDir('project-root-parent');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(child, '.git'), { recursive: true });
  const projectName = path.basename(root).toLowerCase().replace(/\s+/g, '-');
  const vaultDir = path.join(paceUtils.VAULT_PATH, 'projects', projectName);
  fs.mkdirSync(path.join(vaultDir, 'changes'), { recursive: true });
  t.tmpDirs.push(vaultDir);

  const rootInfo = resolveEffectiveProjectRoot(child);
  assert.strictEqual(rootInfo.projectRoot, root);
  assert.strictEqual(rootInfo.mode, 'inherited');
  assert.strictEqual(rootInfo.inheritedFrom, root);
  assert.strictEqual(getProjectStateDir(child), root);
  assert.strictEqual(getProjectRuntimeDir(child), path.join(root, '.pace'));
  assert.strictEqual(getProjectName(child), projectName);
  assert.strictEqual(getArtifactDir(child), vaultDir);
  assert.strictEqual(isPaceProject(child), 'artifact');
  const ctx = executionContextForCwd(child);
  assert.strictEqual(ctx.isWorktree, false);
  assert.strictEqual(ctx.inheritedProjectRoot, true);
});

test('PACE_ARTIFACT_ROOT 只选择 artifact，不切断子目录 Project Root 继承', () => {
  const root = makeTmpDir('project-root-env-parent');
  const child = path.join(root, 'packages', 'worker');
  fs.mkdirSync(path.join(root, '.pace'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(root, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const prev = process.env.PACE_ARTIFACT_ROOT;
  process.env.PACE_ARTIFACT_ROOT = 'local';
  _clearArtifactDirCache();
  try {
    const rootInfo = resolveEffectiveProjectRoot(child);
    assert.strictEqual(rootInfo.projectRoot, root);
    assert.strictEqual(rootInfo.mode, 'inherited');
    assert.strictEqual(getArtifactDir(child), root);
  } finally {
    if (prev === undefined) delete process.env.PACE_ARTIFACT_ROOT;
    else process.env.PACE_ARTIFACT_ROOT = prev;
    _clearArtifactDirCache();
  }
});

test('子目录继承父级 artifact-root-only 项目且触发 PACE 信号', () => {
  const root = makeTmpDir('project-root-choice-only-parent');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(path.join(root, '.pace'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(root, '.pace', 'artifact-root'), 'local\n', 'utf8');

  const rootInfo = resolveEffectiveProjectRoot(child);
  assert.strictEqual(rootInfo.projectRoot, root);
  assert.strictEqual(rootInfo.mode, 'inherited');
  assert.strictEqual(rootInfo.reason, 'artifact-root-choice');
  assert.strictEqual(getProjectStateDir(child), root);
  assert.strictEqual(getArtifactDir(child), root);
  assert.strictEqual(isPaceProject(child), 'manual');
  assert.strictEqual(artifactRootChoiceNeeded(child), false);
});

test('PACE_PROJECT_NAME 不把 vault ancestor scan 收窄到最近子目录', () => {
  const root = makeTmpDir('project-root-name-env-parent');
  const child = path.join(root, 'packages', 'api');
  const projectName = path.basename(root).toLowerCase().replace(/\s+/g, '-');
  const vaultDir = path.join(paceUtils.VAULT_PATH, 'projects', projectName);
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'changes'), { recursive: true });
  t.tmpDirs.push(vaultDir);
  const prev = process.env.PACE_PROJECT_NAME;
  process.env.PACE_PROJECT_NAME = projectName;
  _clearArtifactDirCache();
  try {
    const rootInfo = resolveEffectiveProjectRoot(child);
    assert.strictEqual(rootInfo.projectRoot, root);
    assert.strictEqual(rootInfo.mode, 'inherited');
    assert.strictEqual(getProjectRuntimeDir(child), path.join(root, '.pace'));
    assert.strictEqual(getArtifactDir(child), vaultDir);
  } finally {
    if (prev === undefined) delete process.env.PACE_PROJECT_NAME;
    else process.env.PACE_PROJECT_NAME = prev;
    _clearArtifactDirCache();
  }
});

test('PACE_PROJECT_NAME vault alias 从 git 父 root 继承而不分裂 child runtime', () => {
  const root = makeTmpDir('project-root-name-alias-parent');
  const child = path.join(root, 'packages', 'api');
  const alias = `project-root-alias-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const vaultDir = path.join(paceUtils.VAULT_PATH, 'projects', alias);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'changes'), { recursive: true });
  t.tmpDirs.push(vaultDir);
  const prev = process.env.PACE_PROJECT_NAME;
  process.env.PACE_PROJECT_NAME = alias;
  _clearArtifactDirCache();
  try {
    const rootInfo = resolveEffectiveProjectRoot(child);
    assert.strictEqual(rootInfo.projectRoot, root);
    assert.strictEqual(rootInfo.mode, 'inherited');
    assert.strictEqual(getProjectRuntimeDir(child), path.join(root, '.pace'));
    assert.strictEqual(getArtifactDir(child), vaultDir);
  } finally {
    if (prev === undefined) delete process.env.PACE_PROJECT_NAME;
    else process.env.PACE_PROJECT_NAME = prev;
    _clearArtifactDirCache();
  }
});

test('PACE_PROJECT_NAME vault alias 不让 nested git repo 抢父 Project Root', () => {
  const root = makeTmpDir('project-root-name-alias-nested-parent');
  const nested = path.join(root, 'nested-repo');
  const child = path.join(nested, 'packages', 'api');
  const alias = `project-root-nested-alias-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const vaultDir = path.join(paceUtils.VAULT_PATH, 'projects', alias);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'changes'), { recursive: true });
  t.tmpDirs.push(vaultDir);
  const prev = process.env.PACE_PROJECT_NAME;
  process.env.PACE_PROJECT_NAME = alias;
  _clearArtifactDirCache();
  try {
    assert.strictEqual(resolveEffectiveProjectRoot(nested).projectRoot, root);
    const rootInfo = resolveEffectiveProjectRoot(child);
    assert.strictEqual(rootInfo.projectRoot, root);
    assert.strictEqual(rootInfo.mode, 'inherited');
    assert.strictEqual(getProjectRuntimeDir(child), path.join(root, '.pace'));
    assert.strictEqual(getArtifactDir(child), vaultDir);
  } finally {
    if (prev === undefined) delete process.env.PACE_PROJECT_NAME;
    else process.env.PACE_PROJECT_NAME = prev;
    _clearArtifactDirCache();
  }
});

test('最近父级 PaceFlow root 胜出，避免继承更外层项目', () => {
  const outer = makeTmpDir('project-root-outer');
  const inner = path.join(outer, 'sub-project');
  const child = path.join(inner, 'src');
  fs.mkdirSync(child, { recursive: true });
  const outerVault = path.join(paceUtils.VAULT_PATH, 'projects', path.basename(outer).toLowerCase().replace(/\s+/g, '-'));
  const innerVault = path.join(paceUtils.VAULT_PATH, 'projects', 'sub-project');
  fs.mkdirSync(path.join(outerVault, 'changes'), { recursive: true });
  fs.mkdirSync(path.join(innerVault, 'changes'), { recursive: true });
  t.tmpDirs.push(outerVault, innerVault);

  assert.strictEqual(getProjectStateDir(child), inner);
  assert.strictEqual(getArtifactDir(child), innerVault);
  assert.strictEqual(getProjectName(child), 'sub-project');
});

test('子目录 project-root=independent 阻断父级继承', () => {
  const root = makeTmpDir('project-root-independent-parent');
  const child = path.join(root, 'experiments', 'new-direction');
  fs.mkdirSync(path.join(child, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(child, '.pace', 'project-root'), 'independent\n', 'utf8');
  const parentVault = path.join(paceUtils.VAULT_PATH, 'projects', path.basename(root).toLowerCase().replace(/\s+/g, '-'));
  fs.mkdirSync(path.join(parentVault, 'changes'), { recursive: true });
  t.tmpDirs.push(parentVault);

  const rootInfo = resolveEffectiveProjectRoot(child);
  assert.strictEqual(rootInfo.projectRoot, child);
  assert.strictEqual(rootInfo.mode, 'independent');
  assert.strictEqual(getProjectStateDir(child), child);
  assert.strictEqual(isPaceProject(child), false);
  // F3：全新 independent 子项目（无显式 artifact-root choice）默认 local（child 自身），不隐式指 vault；
  //   independent 只阻断父级继承，artifact root 仍走 getArtifactDir 的 F3 默认。
  assert.strictEqual(getArtifactDir(child), child);
});

test('中间父级 .pace/disabled 阻断继续继承更外层 Project Root', () => {
  const outer = makeTmpDir('project-root-disabled-outer');
  const disabled = path.join(outer, 'disabled-subtree');
  const child = path.join(disabled, 'pkg');
  fs.mkdirSync(path.join(disabled, '.pace'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(disabled, '.pace', 'disabled'), '', 'utf8');
  fs.writeFileSync(path.join(child, 'a.js'), '');
  fs.writeFileSync(path.join(child, 'b.js'), '');
  fs.writeFileSync(path.join(child, 'c.js'), '');
  const outerVault = path.join(paceUtils.VAULT_PATH, 'projects', path.basename(outer).toLowerCase().replace(/\s+/g, '-'));
  fs.mkdirSync(path.join(outerVault, 'changes'), { recursive: true });
  t.tmpDirs.push(outerVault);

  const rootInfo = resolveEffectiveProjectRoot(child);
  assert.strictEqual(rootInfo.projectRoot, disabled);
  assert.strictEqual(rootInfo.mode, 'disabled');
  assert.strictEqual(rootInfo.reason, 'ancestor-disabled');
  assert.strictEqual(isPaceProject(child), false);
});

test('父级 legacy v5 artifact 让子目录继承 Project Root 并触发迁移提示', () => {
  const root = makeTmpDir('project-root-legacy-parent');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(root, 'task.md'), '# Task\n\n- [ ] Legacy parent task\n', 'utf8');
  fs.writeFileSync(path.join(root, 'implementation_plan.md'), '# Implementation Plan\n\n- [ ] Legacy parent plan\n', 'utf8');

  const rootInfo = resolveEffectiveProjectRoot(child);
  assert.strictEqual(rootInfo.projectRoot, root);
  assert.strictEqual(rootInfo.mode, 'inherited');
  assert.strictEqual(rootInfo.reason, 'legacy');
  assert.strictEqual(isPaceProject(child), 'legacy');
  const migration = getV5MigrationInfo(child);
  assert.strictEqual(migration.detected, true);
  assert.strictEqual(migration.dir, root);
});

test('父级残留 .pace/.gitignore 不会被当成 Project Root', () => {
  const root = makeTmpDir('project-root-runtime-only');
  const child = path.join(root, 'pkg');
  fs.mkdirSync(path.join(root, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pace', '.gitignore'), '*\n', 'utf8');
  fs.mkdirSync(child, { recursive: true });
  // A1 后 code-count 不再激活——改用 changes/ 强信号验证「信号按 child 视角解析」的原意图。
  fs.mkdirSync(path.join(child, 'changes'), { recursive: true });

  assert.strictEqual(getProjectStateDir(child), child);
  assert.strictEqual(isPaceProject(child), 'artifact');
});

test('子目录本地 artifact-root 显式声明当前目录为 Project Root', () => {
  const root = makeTmpDir('project-root-child-choice-parent');
  const child = path.join(root, 'tool');
  fs.mkdirSync(path.join(child, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(child, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const parentVault = path.join(paceUtils.VAULT_PATH, 'projects', path.basename(root).toLowerCase().replace(/\s+/g, '-'));
  fs.mkdirSync(path.join(parentVault, 'changes'), { recursive: true });
  t.tmpDirs.push(parentVault);

  assert.strictEqual(getProjectStateDir(child), child);
  assert.strictEqual(getArtifactRootChoicePath(child), path.join(child, '.pace', 'artifact-root'));
  assert.strictEqual(getArtifactDir(child), child);
  assert.strictEqual(artifactRootChoiceNeeded(child), false);
});

test('worktree 有本地 changes 时仍优先沿用宿主 vault artifact', () => {
  const projectName = `pace-worktree-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const root = makeTmpDir('gad-worktree-root');
  const host = path.join(root, projectName);
  const worktree = path.join(host, 'worktrees', 'smoke');
  const vaultDir = path.join(paceUtils.VAULT_PATH, 'projects', projectName);
  fs.mkdirSync(path.join(worktree, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'smoke')}\n`, 'utf8');
  fs.mkdirSync(path.join(vaultDir, 'changes'), { recursive: true });
  t.tmpDirs.push(vaultDir);

  assert.deepStrictEqual(getProjectNameCandidates(worktree).slice(0, 2), [projectName, 'smoke']);
  assert.strictEqual(getArtifactDir(worktree), vaultDir);
});

test('worktree 读取宿主 artifact-root=local → 返回宿主项目目录', () => {
  const projectName = `pace-worktree-choice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const root = makeTmpDir('gad-worktree-choice-root');
  const host = path.join(root, projectName);
  const worktree = path.join(host, 'worktrees', 'smoke');
  fs.mkdirSync(path.join(host, '.pace'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(host, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'smoke')}\n`, 'utf8');

  assert.strictEqual(getProjectStateDir(worktree), host);
  assert.strictEqual(getProjectRuntimeDir(worktree), path.join(host, '.pace'));
  assert.strictEqual(getArtifactRootChoicePath(worktree), path.join(host, '.pace', 'artifact-root'));
  assert.strictEqual(getArtifactDir(worktree), host);
});

test('worktree 宿主 .pace/disabled 对 worktree 生效', () => {
  const projectName = `pace-worktree-disabled-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const root = makeTmpDir('disabled-worktree-root');
  const host = path.join(root, projectName);
  const worktree = path.join(host, 'worktrees', 'smoke');
  fs.mkdirSync(path.join(host, '.pace'), { recursive: true });
  fs.mkdirSync(path.join(host, 'changes'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(host, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(host, '.pace', 'disabled'), '', 'utf8');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'smoke')}\n`, 'utf8');

  assert.strictEqual(isPaceProject(worktree), false);
});

test('executionContextForCwd: git worktree 标记 worktree 名称并写宿主 stateDir', () => {
  const root = makeTmpDir('exec-context-root');
  const host = path.join(root, 'host');
  const worktree = path.join(root, 'worktrees', 'feature-a');
  const child = path.join(worktree, 'packages', 'api');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'feature-a'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'feature-a')}\n`, 'utf8');
  const ctx = executionContextForCwd(worktree);
  assert.strictEqual(ctx.isWorktree, true);
  assert.strictEqual(ctx.worktree, 'feature-a');
  assert.strictEqual(ctx.stateDir, host);
  assert.strictEqual(ctx.checkoutDir, worktree);
  assert.ok(ctx.text.includes('[worktree:: feature-a]'));
  const childCtx = executionContextForCwd(child);
  assert.strictEqual(childCtx.isWorktree, true);
  assert.strictEqual(childCtx.worktree, 'feature-a');
  assert.strictEqual(childCtx.stateDir, host);
  assert.strictEqual(childCtx.checkoutDir, worktree);

  const written = writeChangeOwner(worktree, 'CHG-20260522-01', {
    sessionId: 'sid-worktree-root',
    agentId: 'agent-worktree-root',
    operation: 'update-chg',
    state: 'active',
  });
  assert.strictEqual(written.ok, true);
  // CHG-20260611-02：同 checkout（worktree 及其 child 子目录归一）不同 session → sibling-fresh
  //（旧语义 current-worktree；归一性验证不变，断言精确到细分后形态）。
  assert.strictEqual(changeOwnerStatus(child, 'CHG-20260522-01', 'sid-worktree-child').disposition, 'sibling-fresh');
});

test('git worktree 内 nested .git 目录仍向上继承宿主 Project Root', () => {
  const root = makeTmpDir('worktree-nested-git-dir-root');
  const host = path.join(root, 'host');
  const worktree = path.join(root, 'worktrees', 'feature-nested-dir');
  const nested = path.join(worktree, 'vendor', 'lib');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'feature-nested-dir'), { recursive: true });
  fs.mkdirSync(path.join(host, '.pace'), { recursive: true });
  fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
  fs.writeFileSync(path.join(host, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'feature-nested-dir')}\n`, 'utf8');

  const rootInfo = resolveEffectiveProjectRoot(nested);
  assert.strictEqual(rootInfo.mode, 'worktree');
  assert.strictEqual(rootInfo.projectRoot, host);
  assert.strictEqual(getProjectStateDir(nested), host);
  assert.strictEqual(getProjectRuntimeDir(nested), path.join(host, '.pace'));
  assert.strictEqual(getArtifactDir(nested), host);
  const ctx = executionContextForCwd(nested);
  assert.strictEqual(ctx.isWorktree, true);
  assert.strictEqual(ctx.worktree, 'feature-nested-dir');
  assert.strictEqual(ctx.checkoutDir, worktree);
});

test('git worktree 内 nested 普通 .git 文件仍向上继承宿主 Project Root', () => {
  const root = makeTmpDir('worktree-nested-git-file-root');
  const host = path.join(root, 'host');
  const worktree = path.join(root, 'worktrees', 'feature-nested-file');
  const nested = path.join(worktree, 'vendor', 'submodule');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'feature-nested-file'), { recursive: true });
  fs.mkdirSync(path.join(host, '.pace'), { recursive: true });
  fs.mkdirSync(path.join(nested, '.gitdir'), { recursive: true });
  fs.writeFileSync(path.join(host, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'feature-nested-file')}\n`, 'utf8');
  fs.writeFileSync(path.join(nested, '.git'), `gitdir: ${path.join(nested, '.gitdir')}\n`, 'utf8');

  const rootInfo = resolveEffectiveProjectRoot(nested);
  assert.strictEqual(rootInfo.mode, 'worktree');
  assert.strictEqual(rootInfo.projectRoot, host);
  assert.strictEqual(getProjectStateDir(nested), host);
  assert.strictEqual(getProjectRuntimeDir(nested), path.join(host, '.pace'));
  assert.strictEqual(getArtifactDir(nested), host);
  const ctx = executionContextForCwd(nested);
  assert.strictEqual(ctx.isWorktree, true);
  assert.strictEqual(ctx.worktree, 'feature-nested-file');
  assert.strictEqual(ctx.checkoutDir, worktree);
});

test('change owner runtime: 当前 session / foreign fresh 可区分', () => {
  const dir = makeTmpDir('change-owner');
  const written = writeChangeOwner(dir, 'CHG-20260512-01', {
    sessionId: 'sid-owner',
    agentId: 'agent-owner',
    operation: 'create-chg',
    state: 'active',
  });
  assert.strictEqual(written.ok, true);
  const owner = readChangeOwner(dir, 'CHG-20260512-01');
  assert.strictEqual(owner.ok, true);
  assert.strictEqual(owner.sessionId, 'sid-owner');
  assert.strictEqual(changeOwnerStatus(dir, 'CHG-20260512-01', 'sid-owner').disposition, 'current');
  // CHG-20260611-02：同 checkout 不同 session 由 current-worktree 细分为 sibling-fresh。
  assert.strictEqual(changeOwnerStatus(dir, 'CHG-20260512-01', 'sid-other').disposition, 'sibling-fresh');
  const foreign = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  foreign.cwd = path.join(dir, 'other-checkout');
  foreign.stateDir = path.join(dir, 'other-checkout');
  foreign.worktree = 'other-checkout';
  foreign.branch = 'other-branch';
  fs.writeFileSync(written.path, `${JSON.stringify(foreign, null, 2)}\n`, 'utf8');
  assert.strictEqual(changeOwnerStatus(dir, 'CHG-20260512-01', 'sid-other').disposition, 'foreign-fresh');
});

test('changeOwnerStatus: sid 无法确定（缺 session_id + env 空）时 foreign owner 判 unknown 不 foreign（STOP-03）', () => {
  const dir = makeTmpDir('owner-stop03');
  const lockUtils = createLockUtils({
    getProjectRuntimeDir: d => path.join(d, '.pace'),
    displayDir: d => `${String(d || '').replace(/\\/g, '/')}/`,
    normalizeSessionId: s => String(s || '').trim(),
    currentSessionId: () => '',
    executionContextForCwd: d => ({ cwd: d, stateDir: d, worktree: 'wt-current', branch: 'br-current', text: '[worktree:: wt-current] [branch:: br-current]' }),
    normalizePath: p => String(p || '').replace(/\\/g, '/'),
    getArtifactDir: d => d,
    todayISO: () => '2026-06-05',
    CHANGE_OWNER_TTL_MS: paceUtils.CHANGE_OWNER_TTL_MS,
    PROJECT_ROOT_FILE: paceUtils.PROJECT_ROOT_FILE,
  });
  const written = lockUtils.writeChangeOwner(dir, 'CHG-20260605-91', { sessionId: 'sid-other', operation: 'create-chg', state: 'active' });
  // 改为别的 worktree（foreign），且 timestamp 保持 fresh
  const owner = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  owner.cwd = path.join(dir, 'other'); owner.stateDir = path.join(dir, 'other'); owner.worktree = 'wt-other'; owner.branch = 'br-other';
  fs.writeFileSync(written.path, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  // stdin 缺 session_id（''）+ currentSessionId 也空 → sid 无法确定，不应判 foreign（否则 Stop 漏检 running CHG）
  const status = lockUtils.changeOwnerStatus(dir, 'CHG-20260605-91', '');
  assert.strictEqual(status.disposition, 'unknown', 'sid 空时不应判 foreign-fresh');
});

test('sweepStaleRuntimeOwners: 清理超 TTL 的 change-owner/reservation 保留 fresh（RSL-01/02）', () => {
  const dir = makeTmpDir('rsl-sweep');
  const lockUtils = createLockUtils({
    getProjectRuntimeDir: d => path.join(d, '.pace'),
    displayDir: d => `${String(d || '').replace(/\\/g, '/')}/`,
    normalizeSessionId: s => String(s || '').trim(),
    currentSessionId: () => 'sid-sweep',
    executionContextForCwd: d => ({ cwd: d, stateDir: d, worktree: 'main', branch: 'main', text: '[worktree:: main] [branch:: main]' }),
    normalizePath: p => String(p || '').replace(/\\/g, '/'),
    getArtifactDir: d => d,
    todayISO: () => '2026-06-05',
    CHANGE_OWNER_TTL_MS: paceUtils.CHANGE_OWNER_TTL_MS,
    PROJECT_ROOT_FILE: paceUtils.PROJECT_ROOT_FILE,
  });
  const fresh = lockUtils.writeChangeOwner(dir, 'CHG-20260605-81', { sessionId: 'sid-sweep', operation: 'create-chg', state: 'active' });
  const stale = lockUtils.writeChangeOwner(dir, 'CHG-20260605-82', { sessionId: 'sid-old', operation: 'create-chg', state: 'active' });
  // 把 stale owner 的内部 timestampMs 改到 2 小时前（超 30min TTL）——sweep 现按内部 timestampMs 判 stale
  // （非文件 mtime，与 jsonLockIsStale/changeOwnerStatus 一致，CHG-20260614-02 T-001）。
  const staleData = JSON.parse(fs.readFileSync(stale.path, 'utf8'));
  staleData.timestampMs = Date.now() - 2 * 60 * 60 * 1000;
  fs.writeFileSync(stale.path, `${JSON.stringify(staleData, null, 2)}\n`, 'utf8');
  const swept = lockUtils.sweepStaleRuntimeOwners(dir);
  assert.ok(!fs.existsSync(stale.path), 'stale change-owner（2h，超 TTL）被清理，遏制无界增长');
  assert.ok(fs.existsSync(fresh.path), 'fresh change-owner 保留');
  assert.ok(Array.isArray(swept) && swept.length >= 1, '返回被清理文件列表');
});

test('change owner heartbeat: 当前 session 工具活动刷新 owner timestamp', () => {
  const dir = makeTmpDir('change-owner-heartbeat');
  const written = writeChangeOwner(dir, 'CHG-20260512-02', {
    sessionId: 'sid-heartbeat',
    agentId: 'agent-heartbeat',
    operation: 'update-chg',
    state: 'active',
  });
  assert.strictEqual(written.ok, true);
  const fp = written.path;
  const old = JSON.parse(fs.readFileSync(fp, 'utf8'));
  old.cwd = path.join(dir, 'other-checkout');
  old.stateDir = path.join(dir, 'other-checkout');
  old.worktree = 'other-checkout';
  old.branch = 'other-branch';
  old.timestampMs = Date.now() - 60 * 60 * 1000;
  old.updatedAt = new Date(old.timestampMs).toISOString();
  fs.writeFileSync(fp, `${JSON.stringify(old, null, 2)}\n`, 'utf8');
  assert.strictEqual(changeOwnerStatus(dir, 'CHG-20260512-02', 'sid-other').disposition, 'foreign-stale');
  const touched = touchChangeOwnersForSession(dir, { sessionId: 'sid-heartbeat' });
  assert.deepStrictEqual(touched, ['CHG-20260512-02']);
  // CHG-20260611-02：touch 刷回当前 checkout 后，不同 session 查询 → sibling-fresh（旧 current-worktree）。
  assert.strictEqual(changeOwnerStatus(dir, 'CHG-20260512-02', 'sid-other').disposition, 'sibling-fresh');
});

test('SIB-1. 同 checkout 不同 session：fresh owner → sibling-fresh（current:false，CHG-20260611-02）', () => {
  const dir = makeTmpDir('sibling-fresh');
  const written = writeChangeOwner(dir, 'CHG-20260611-91', { sessionId: 'sid-a', operation: 'update-chg', state: 'active' });
  assert.strictEqual(written.ok, true);
  const status = changeOwnerStatus(dir, 'CHG-20260611-91', 'sid-b');
  assert.strictEqual(status.disposition, 'sibling-fresh');
  assert.strictEqual(status.current, false);
  assert.strictEqual(status.sameCheckout, true);
  assert.strictEqual(status.fresh, true);
});

test('SIB-2. 同 checkout 不同 session：state=detached → sibling-detached（优先于 stale 判定）', () => {
  const dir = makeTmpDir('sibling-detached');
  writeChangeOwner(dir, 'CHG-20260611-92', { sessionId: 'sid-a', operation: 'update-chg', state: 'detached' });
  const status = changeOwnerStatus(dir, 'CHG-20260611-92', 'sid-b');
  assert.strictEqual(status.disposition, 'sibling-detached');
  assert.strictEqual(status.current, false);
});

test('SIB-3. 同 checkout 不同 session：超 TTL → sibling-stale', () => {
  const dir = makeTmpDir('sibling-stale');
  const written = writeChangeOwner(dir, 'CHG-20260611-93', { sessionId: 'sid-a', operation: 'update-chg', state: 'active' });
  const owner = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  owner.timestampMs = Date.now() - 2 * 60 * 60 * 1000;
  owner.updatedAt = new Date(owner.timestampMs).toISOString();
  fs.writeFileSync(written.path, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  const status = changeOwnerStatus(dir, 'CHG-20260611-93', 'sid-b');
  assert.strictEqual(status.disposition, 'sibling-stale');
  assert.strictEqual(status.stale, true);
});

test('SIB-4. sid 空 + 同 checkout → 保留 current-worktree（STOP-03 对称保守，不细分）', () => {
  const dir = makeTmpDir('sibling-no-sid');
  const lockUtils = createLockUtils({
    getProjectRuntimeDir: d => path.join(d, '.pace'),
    displayDir: d => `${String(d || '').replace(/\\/g, '/')}/`,
    normalizeSessionId: s => String(s || '').trim(),
    currentSessionId: () => '',
    executionContextForCwd: d => ({ cwd: d, stateDir: d, worktree: 'wt-current', branch: 'br-current', text: '[worktree:: wt-current] [branch:: br-current]' }),
    normalizePath: p => String(p || '').replace(/\\/g, '/'),
    getArtifactDir: d => d,
    todayISO: () => '2026-06-11',
    CHANGE_OWNER_TTL_MS: paceUtils.CHANGE_OWNER_TTL_MS,
    PROJECT_ROOT_FILE: paceUtils.PROJECT_ROOT_FILE,
  });
  lockUtils.writeChangeOwner(dir, 'CHG-20260611-94', { sessionId: 'sid-a', operation: 'update-chg', state: 'active' });
  const status = lockUtils.changeOwnerStatus(dir, 'CHG-20260611-94', '');
  assert.strictEqual(status.disposition, 'current-worktree', 'sid 空时不细分 sibling，保留保守路径');
  assert.strictEqual(status.current, true);
});

test('SIB-5. 同 session 与 foreign 行为不回归（CHG-20260611-02）', () => {
  const dir = makeTmpDir('sibling-regression');
  const written = writeChangeOwner(dir, 'CHG-20260611-95', { sessionId: 'sid-a', operation: 'update-chg', state: 'active' });
  assert.strictEqual(changeOwnerStatus(dir, 'CHG-20260611-95', 'sid-a').disposition, 'current');
  const owner = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  owner.cwd = path.join(dir, 'other');
  owner.stateDir = path.join(dir, 'other');
  owner.worktree = 'wt-other';
  owner.branch = 'br-other';
  fs.writeFileSync(written.path, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  assert.strictEqual(changeOwnerStatus(dir, 'CHG-20260611-95', 'sid-b').disposition, 'foreign-fresh');
});

test('SIB-6. detachChangeOwnersForSession 只降级本 session 非 closed 记录（CHG-20260611-02）', () => {
  const dir = makeTmpDir('sibling-detach');
  const mine = writeChangeOwner(dir, 'CHG-20260611-96', { sessionId: 'sid-a', operation: 'update-chg', state: 'active' });
  const closed = writeChangeOwner(dir, 'CHG-20260611-97', { sessionId: 'sid-a', operation: 'close-chg', state: 'closed' });
  const others = writeChangeOwner(dir, 'CHG-20260611-98', { sessionId: 'sid-b', operation: 'update-chg', state: 'active' });
  const before = JSON.parse(fs.readFileSync(mine.path, 'utf8')).timestampMs;
  const detached = paceUtils.detachChangeOwnersForSession(dir, { sessionId: 'sid-a' });
  assert.deepStrictEqual(detached, ['CHG-20260611-96'], '只降级本 session 的活跃记录');
  const after = JSON.parse(fs.readFileSync(mine.path, 'utf8'));
  assert.strictEqual(after.state, 'detached');
  assert.ok(after.timestampMs >= before, 'detach 刷新 timestampMs（W6 sweep 30min 窗口起点）');
  assert.strictEqual(JSON.parse(fs.readFileSync(closed.path, 'utf8')).state, 'closed', 'closed 不被 detach');
  assert.strictEqual(JSON.parse(fs.readFileSync(others.path, 'utf8')).state, 'active', '他 session 不动');
});

test('SIB-7. reviveDetachedChangeOwnersForSession 把本 session detached 升回 active', () => {
  const dir = makeTmpDir('sibling-revive');
  const mine = writeChangeOwner(dir, 'CHG-20260611-96', { sessionId: 'sid-a', operation: 'update-chg', state: 'detached' });
  const others = writeChangeOwner(dir, 'CHG-20260611-97', { sessionId: 'sid-b', operation: 'update-chg', state: 'detached' });
  const revived = paceUtils.reviveDetachedChangeOwnersForSession(dir, { sessionId: 'sid-a' });
  assert.deepStrictEqual(revived, ['CHG-20260611-96'], '只升级本 session 的 detached 记录');
  assert.strictEqual(JSON.parse(fs.readFileSync(mine.path, 'utf8')).state, 'active');
  assert.strictEqual(JSON.parse(fs.readFileSync(others.path, 'utf8')).state, 'detached', '他 session 不动');
});

test('PAUSE-1. write/isSessionPaused/clearSessionPause 基本闭环 + sessionId 键控隔离（CHG-20260611-03）', () => {
  const dir = makeTmpDir('pause-basic');
  assert.strictEqual(paceUtils.isSessionPaused(dir, 'sid-a'), false, '初始未 pause');
  assert.strictEqual(paceUtils.writeSessionPause(dir, 'sid-a'), true);
  assert.strictEqual(paceUtils.isSessionPaused(dir, 'sid-a'), true, '写入后 paused');
  assert.strictEqual(paceUtils.isSessionPaused(dir, 'sid-b'), false, '他 session 不受影响（sessionId 键控）');
  assert.strictEqual(paceUtils.clearSessionPause(dir, 'sid-a'), true);
  assert.strictEqual(paceUtils.isSessionPaused(dir, 'sid-a'), false, 'clear 后失效');
});

test('PAUSE-2. mtime 超 SESSION_PAUSE_TTL_MS → isSessionPaused false 且懒清理 unlink', () => {
  const dir = makeTmpDir('pause-ttl');
  paceUtils.writeSessionPause(dir, 'sid-a');
  const fp = path.join(paceUtils.getProjectRuntimeDir(dir), 'paused-sid-a');
  assert.ok(fs.existsSync(fp), '标志文件存在');
  const old = new Date(Date.now() - paceUtils.SESSION_PAUSE_TTL_MS - 60 * 1000);
  fs.utimesSync(fp, old, old);
  assert.strictEqual(paceUtils.isSessionPaused(dir, 'sid-a'), false, '超 TTL 视为无效（crash 残留兜底）');
  assert.ok(!fs.existsSync(fp), '过期标志被懒清理');
});

test('PAUSE-3. sid 空 → 全部 no-op/false', () => {
  const dir = makeTmpDir('pause-no-sid');
  assert.strictEqual(paceUtils.writeSessionPause(dir, ''), false);
  assert.strictEqual(paceUtils.isSessionPaused(dir, ''), false);
  assert.strictEqual(paceUtils.clearSessionPause(dir, ''), false);
});

test('PAUSE-4. 恶意 sessionId 路径穿越被 safeLockName 中和（R 审计 P3-1 回归）', () => {
  const dir = makeTmpDir('pause-traversal');
  const evil = '../../outside-runtime';
  assert.strictEqual(paceUtils.writeSessionPause(dir, evil), true);
  const runtime = paceUtils.getProjectRuntimeDir(dir);
  assert.ok(!fs.existsSync(path.join(runtime, '..', '..', 'outside-runtime')), '不得逃出 runtime 目录');
  const files = fs.readdirSync(runtime).filter(f => f.startsWith('paused-'));
  assert.strictEqual(files.length, 1, '标志应落在 runtime 内：' + files.join(','));
  assert.ok(!files[0].includes('/'), '文件名不含路径分隔符');
  assert.strictEqual(paceUtils.isSessionPaused(dir, evil), true, '同一恶意 sid 读写自洽');
  assert.strictEqual(paceUtils.clearSessionPause(dir, evil), true);
});

test('artifact-root=vault 且 vault env 缺失时返回配置错误', () => {
  const dir = makeTmpDir('vault-choice-missing-env-utils');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'vault\n', 'utf8');
  const originalVaultPath = process.env.PACE_VAULT_PATH;
  process.env.PACE_VAULT_PATH = '';
  delete require.cache[require.resolve('../plugin/hooks/pace-utils')];
  const fresh = require('../plugin/hooks/pace-utils');
  try {
    const err = fresh.artifactRootConfigError(dir);
    assert.ok(err);
    assert.strictEqual(err.code, 'vault-env-missing');
    assert.ok(err.message.includes('PACE_VAULT_PATH'));
  } finally {
    if (originalVaultPath === undefined) delete process.env.PACE_VAULT_PATH;
    else process.env.PACE_VAULT_PATH = originalVaultPath;
    delete require.cache[require.resolve('../plugin/hooks/pace-utils')];
    require('../plugin/hooks/pace-utils');
  }
});

test('worktree 无本地 artifact 但宿主 vault 有 changes → artifact', () => {
  const projectName = `pace-worktree-signal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const root = makeTmpDir('signal-worktree-root');
  const host = path.join(root, projectName);
  const worktree = path.join(host, 'worktrees', 'smoke');
  const vaultDir = path.join(paceUtils.VAULT_PATH, 'projects', projectName);
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'smoke')}\n`, 'utf8');
  fs.mkdirSync(path.join(vaultDir, 'changes'), { recursive: true });
  t.tmpDirs.push(vaultDir);

  assert.strictEqual(isPaceProject(worktree), 'artifact');
});

// ============================================================
// scanRelatedNotes (H-10)
// 注意：VAULT_PATH 是 const，无法在测试中替换。
// 采用与 getArtifactDir 相同策略：在真实 VAULT_PATH 创建唯一命名的临时文件。
// ============================================================

test('scanRelatedNotes: 正常匹配（projects 含项目名）', () => {
  const uniqueProject = 'pace-scan-test-' + Date.now();
  const thoughtsDir = path.join(paceUtils.VAULT_PATH, 'thoughts');
  fs.mkdirSync(thoughtsDir, { recursive: true });
  const noteFile = path.join(thoughtsDir, `_test-${uniqueProject}.md`);
  fs.writeFileSync(noteFile, [
    '---',
    'status: discussing',
    `projects: [${uniqueProject}, other]`,
    'summary: "测试摘要"',
    '---',
    '# Test',
  ].join('\n'));

  try {
    const results = paceUtils.scanRelatedNotes(uniqueProject);
    assert.ok(results.length >= 1, '应至少匹配 1 条');
    const found = results.find(r => r.title === `_test-${uniqueProject}`);
    assert.ok(found, '应找到测试笔记');
    assert.strictEqual(found.summary, '测试摘要');
    assert.strictEqual(found.status, 'discussing');
  } finally {
    try { fs.unlinkSync(noteFile); } catch(e) {}
  }
});

test('scanRelatedNotes: 无匹配项目名 → 空数组', () => {
  const uniqueProject = 'pace-scan-nomatch-' + Date.now();
  // 不创建任何笔记，直接查询不存在的项目名
  const results = paceUtils.scanRelatedNotes(uniqueProject);
  assert.strictEqual(results.length, 0, '不应匹配不相关项目');
});

test('scanRelatedNotes: status=archived 被过滤', () => {
  const uniqueProject = 'pace-scan-archived-' + Date.now();
  const knowledgeDir = path.join(paceUtils.VAULT_PATH, 'knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const noteFile = path.join(knowledgeDir, `_test-${uniqueProject}.md`);
  fs.writeFileSync(noteFile, [
    '---',
    'status: archived',
    `projects: [${uniqueProject}]`,
    'summary: "已归档"',
    '---',
    '# Archived',
  ].join('\n'));

  try {
    const results = paceUtils.scanRelatedNotes(uniqueProject);
    const found = results.find(r => r.title === `_test-${uniqueProject}`);
    assert.ok(!found, 'archived 笔记不应返回');
  } finally {
    try { fs.unlinkSync(noteFile); } catch(e) {}
  }
});

test('scanRelatedNotes: knowledge/thoughts 递归覆盖嵌套子目录（CHG-09 §E T-004）', () => {
  const uniqueProject = 'pace-scan-nested-' + Date.now();
  const subDir = path.join(paceUtils.VAULT_PATH, 'knowledge', `sub-${uniqueProject}`);
  fs.mkdirSync(subDir, { recursive: true });
  const noteFile = path.join(subDir, `_nested-${uniqueProject}.md`);
  fs.writeFileSync(noteFile, [
    '---',
    'status: concluded',
    `projects: [${uniqueProject}]`,
    'summary: "嵌套子目录笔记"',
    '---',
    '# Nested',
  ].join('\n'));

  try {
    const results = paceUtils.scanRelatedNotes(uniqueProject);
    const found = results.find(r => r.title === `_nested-${uniqueProject}`);
    assert.ok(found, '子目录 knowledge 笔记应被递归扫描（原仅顶层 readdir 会漏）');
    assert.strictEqual(found.kind, 'knowledge', '子目录笔记 kind 仍按所在 knowledge 目录');
  } finally {
    try { fs.rmSync(subDir, { recursive: true, force: true }); } catch(e) {}
  }
});

test('scanRelatedNotes: VAULT_PATH 空值 → 空数组不报错', () => {
  // W-1 防御：直接调用不可能触发（VAULT_PATH 是 const），
  // 但验证函数对完全不存在的项目名也不报错
  const results = paceUtils.scanRelatedNotes('nonexistent-project-' + Date.now());
  assert.ok(Array.isArray(results), '应返回数组');
});

// ------------------------------------------------------------
// M5: wiki article 注入（CHG-20260608-12 T-001）
// 在真实 VAULT_PATH 建唯一命名临时文件，用完 unlink（同既有策略）。
// ------------------------------------------------------------

test('WIKI-1. 有 wiki/ 时 article 优先注入 + 同名 raw 被 basename 去重', () => {
  const uniq = 'pace-wiki-test-' + Date.now();
  const artDir = path.join(paceUtils.VAULT_PATH, 'wiki', 'ai-workflow');
  fs.mkdirSync(artDir, { recursive: true });
  const articleFile = path.join(artDir, `_test-${uniq}.md`);
  fs.writeFileSync(articleFile, ['---','type: wiki-article','status: confirmed',
    'tags:','  - test-tag','summary: "wiki 提炼摘要"',
    'sources:',`  - "${uniq} CHG-X 描述, 2026-06-08"`,'---','# Article'].join('\n'));
  const kDir = path.join(paceUtils.VAULT_PATH, 'knowledge');
  fs.mkdirSync(kDir, { recursive: true });
  const rawSame = path.join(kDir, `_test-${uniq}.md`); // 同名 → 应被去重
  fs.writeFileSync(rawSame, ['---','status: concluded',`projects: [${uniq}]`,'summary: "raw 原始"','---','# Raw'].join('\n'));
  try {
    const r = paceUtils.scanRelatedNotes(uniq);
    const art = r.find(x => x.title === `_test-${uniq}` && x.kind === 'wiki');
    assert.ok(art, 'article 应匹配（sources 前缀）');
    assert.strictEqual(art.summary, 'wiki 提炼摘要');
    assert.strictEqual(r.filter(x => x.title === `_test-${uniq}`).length, 1, '同名 raw 被去重，只剩 article');
    assert.strictEqual(r[0].kind, 'wiki', 'article 优先排前');
  } finally { fs.unlinkSync(articleFile); fs.unlinkSync(rawSame); }
});

test('WIKI-1b. 仅 tags 含项目名（无 sources 前缀）的 article 也匹配（并集）', () => {
  const uniq = 'pace-wiki-tag-' + Date.now();
  const artDir = path.join(paceUtils.VAULT_PATH, 'wiki', 'tools');
  fs.mkdirSync(artDir, { recursive: true });
  const f = path.join(artDir, `_test-${uniq}.md`);
  fs.writeFileSync(f, ['---','type: wiki-article','status: likely',
    'tags:',`  - ${uniq}`,'summary: "仅 tags 匹配"',
    'sources:','  - "other-project CHG-Y, 2026-06-08"','---','# A'].join('\n'));
  try {
    const r = paceUtils.scanRelatedNotes(uniq);
    assert.ok(r.find(x => x.title === `_test-${uniq}` && x.kind === 'wiki'), 'tags 含项目名应匹配（并集）');
  } finally { fs.unlinkSync(f); }
});

test('WIKI-2. 无匹配 wiki article 时返回 knowledge raw（kind=knowledge，CHG-04 拆 kind）', () => {
  const uniq = 'pace-wiki-none-' + Date.now();
  const kDir = path.join(paceUtils.VAULT_PATH, 'knowledge');
  fs.mkdirSync(kDir, { recursive: true });
  const raw = path.join(kDir, `_test-${uniq}.md`);
  fs.writeFileSync(raw, ['---','status: concluded',`projects: [${uniq}]`,'summary: "只有 knowledge"','---','# Raw'].join('\n'));
  try {
    const r = paceUtils.scanRelatedNotes(uniq);
    assert.ok(r.find(x => x.title === `_test-${uniq}` && x.kind === 'knowledge'), 'knowledge raw kind=knowledge 正常返回');
  } finally { fs.unlinkSync(raw); }
});

test('WIKI-3. wiki article 按 status 排序（confirmed 排 likely 前，不依赖 walk 序）', () => {
  const uniq = 'pace-wiki-sort-' + Date.now();
  const aDir = path.join(paceUtils.VAULT_PATH, 'wiki', 'ai-workflow');
  fs.mkdirSync(aDir, { recursive: true });
  // likely 文件名排前（_a- → walk 序在前）、confirmed 排后——验证排序后 confirmed 仍在前。
  const fL = path.join(aDir, `_a-likely-${uniq}.md`);
  const fC = path.join(aDir, `_b-confirmed-${uniq}.md`);
  fs.writeFileSync(fL, ['---','type: wiki-article','status: likely','tags:',`  - ${uniq}`,'summary: "likely 项"','---','# L'].join('\n'));
  fs.writeFileSync(fC, ['---','type: wiki-article','status: confirmed','tags:',`  - ${uniq}`,'summary: "confirmed 项"','---','# C'].join('\n'));
  try {
    const wiki = paceUtils.scanRelatedNotes(uniq).filter(x => x.kind === 'wiki');
    const ci = wiki.findIndex(x => x.title === `_b-confirmed-${uniq}`);
    const li = wiki.findIndex(x => x.title === `_a-likely-${uniq}`);
    assert.ok(ci >= 0 && li >= 0 && ci < li, `confirmed 排在 likely 之前（实际 c=${ci} l=${li}）`);
  } finally { fs.unlinkSync(fL); fs.unlinkSync(fC); }
});

test('WIKI-4. knowledge 与 thoughts 分到不同 kind（CHG-04）', () => {
  const uniq = 'pace-wiki-kt-' + Date.now();
  const kDir = path.join(paceUtils.VAULT_PATH, 'knowledge');
  const tDir = path.join(paceUtils.VAULT_PATH, 'thoughts');
  fs.mkdirSync(kDir, { recursive: true });
  fs.mkdirSync(tDir, { recursive: true });
  const kf = path.join(kDir, `_k-${uniq}.md`);
  const tf = path.join(tDir, `_t-${uniq}.md`);
  fs.writeFileSync(kf, ['---','status: concluded',`projects: [${uniq}]`,'summary: "已沉淀"','---','# K'].join('\n'));
  fs.writeFileSync(tf, ['---','status: discussing',`projects: [${uniq}]`,'summary: "想法"','---','# T'].join('\n'));
  try {
    const r = paceUtils.scanRelatedNotes(uniq);
    assert.ok(r.find(x => x.title === `_k-${uniq}` && x.kind === 'knowledge'), 'knowledge raw kind=knowledge');
    assert.ok(r.find(x => x.title === `_t-${uniq}` && x.kind === 'thoughts'), 'thoughts raw kind=thoughts');
  } finally { fs.unlinkSync(kf); fs.unlinkSync(tf); }
});

test('WIKI-5. thoughts 同名 wiki article 不被去重（thoughts 不进 wiki，独立段保留）', () => {
  const uniq = 'pace-wiki-tdup-' + Date.now();
  const aDir = path.join(paceUtils.VAULT_PATH, 'wiki', 'ai-workflow');
  const tDir = path.join(paceUtils.VAULT_PATH, 'thoughts');
  fs.mkdirSync(aDir, { recursive: true });
  fs.mkdirSync(tDir, { recursive: true });
  const wf = path.join(aDir, `_dup-${uniq}.md`);
  const tf = path.join(tDir, `_dup-${uniq}.md`); // 与 wiki article 同 basename
  fs.writeFileSync(wf, ['---','type: wiki-article','status: confirmed','tags:',`  - ${uniq}`,'summary: "wiki 提炼"','---','# W'].join('\n'));
  fs.writeFileSync(tf, ['---','status: discussing',`projects: [${uniq}]`,'summary: "未成熟想法"','---','# T'].join('\n'));
  try {
    const r = paceUtils.scanRelatedNotes(uniq);
    assert.ok(r.find(x => x.title === `_dup-${uniq}` && x.kind === 'wiki'), 'wiki article 注入');
    assert.ok(r.find(x => x.title === `_dup-${uniq}` && x.kind === 'thoughts'), '同名 thoughts 不被去重、独立保留（只 knowledge 去重）');
  } finally { fs.unlinkSync(wf); fs.unlinkSync(tf); }
});

// ============================================================
// 7. resolveProjectCwd() — 3 个测试（CLAUDE_PROJECT_DIR 环境变量）
// ============================================================
console.log('\n--- resolveProjectCwd ---');

test('resolveProjectCwd: CLAUDE_PROJECT_DIR 设置 → 返回规范化路径', () => {
  const origEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = 'C:/Users/test/project';
  try {
    const result = paceUtils.resolveProjectCwd();
    assert.strictEqual(result, path.resolve('C:/Users/test/project'));
  } finally {
    if (origEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origEnv;
  }
});

test('resolveProjectCwd: CLAUDE_PROJECT_DIR 未设置 → fallback process.cwd()', () => {
  const origEnv = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    const result = paceUtils.resolveProjectCwd();
    assert.strictEqual(result, process.cwd());
  } finally {
    if (origEnv !== undefined) process.env.CLAUDE_PROJECT_DIR = origEnv;
  }
});

test('resolveProjectCwd: CLAUDE_PROJECT_DIR 空字符串 → fallback process.cwd()', () => {
  const origEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = '';
  try {
    const result = paceUtils.resolveProjectCwd();
    assert.strictEqual(result, process.cwd());
  } finally {
    if (origEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origEnv;
  }
});

// ============================================================
// 8. listPlanFiles() — 5 个测试（含双路径）
// ============================================================
console.log('\n--- listPlanFiles ---');

test('listPlanFiles: 无 docs/plans/ 返回空数组', () => {
  const dir = makeTmpDir('lp-empty');
  assert.deepStrictEqual(paceUtils.listPlanFiles(dir), []);
});

test('listPlanFiles: docs/plans/ 有 plan 文件按日期降序', () => {
  const dir = makeTmpDir('lp-sort');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-01-feature-a.md'), '');
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-04-feature-b.md'), '');
  fs.writeFileSync(path.join(dir, 'docs', 'plans', 'README.md'), '');
  const result = paceUtils.listPlanFiles(dir);
  assert.deepStrictEqual(result, [
    { name: '2026-03-04-feature-b.md', dir: 'docs/plans' },
    { name: '2026-03-01-feature-a.md', dir: 'docs/plans' },
  ]);
});

test('listPlanFiles: 非日期格式文件被过滤', () => {
  const dir = makeTmpDir('lp-filter');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', 'random-notes.md'), '');
  assert.deepStrictEqual(paceUtils.listPlanFiles(dir), []);
});

test('listPlanFiles: docs/superpowers/plans/ 新路径扫描', () => {
  const dir = makeTmpDir('lp-superpowers');
  fs.mkdirSync(path.join(dir, 'docs', 'superpowers', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'superpowers', 'plans', '2026-03-19-new-feature.md'), '');
  const result = paceUtils.listPlanFiles(dir);
  assert.deepStrictEqual(result, [
    { name: '2026-03-19-new-feature.md', dir: 'docs/superpowers/plans' },
  ]);
});

test('listPlanFiles: 双路径合并去重按日期降序', () => {
  const dir = makeTmpDir('lp-dual');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'superpowers', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-01-old.md'), '');
  fs.writeFileSync(path.join(dir, 'docs', 'superpowers', 'plans', '2026-03-19-new.md'), '');
  // 同名文件在两个目录（旧路径优先，去重）
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-10-dup.md'), '');
  fs.writeFileSync(path.join(dir, 'docs', 'superpowers', 'plans', '2026-03-10-dup.md'), '');
  const result = paceUtils.listPlanFiles(dir);
  assert.strictEqual(result.length, 3, '去重后应有 3 个');
  assert.strictEqual(result[0].name, '2026-03-19-new.md');
  assert.strictEqual(result[0].dir, 'docs/superpowers/plans');
  assert.strictEqual(result[1].name, '2026-03-10-dup.md');
  assert.strictEqual(result[1].dir, 'docs/plans'); // 旧路径先扫描
  assert.strictEqual(result[2].name, '2026-03-01-old.md');
});

test('getNativePlanPath: 过滤不属于当前项目的 current-native-plan', () => {
  const dir = makeTmpDir('native-plan-filter-project');
  const runtime = getProjectRuntimeDir(dir);
  fs.mkdirSync(runtime, { recursive: true });
  const foreign = path.join(makeTmpDir('native-plan-foreign'), 'plan.md');
  fs.writeFileSync(foreign, '# unrelated project\n\nccauth task\n', 'utf8');
  fs.writeFileSync(path.join(runtime, 'current-native-plan'), foreign, 'utf8');
  assert.strictEqual(paceUtils.getNativePlanPath(dir), null);

  const local = path.join(dir, 'docs', 'plan.md');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, '# local plan\n', 'utf8');
  fs.writeFileSync(path.join(runtime, 'current-native-plan'), local, 'utf8');
  assert.strictEqual(paceUtils.getNativePlanPath(dir), local.replace(/\\/g, '/'));
});

test('getNativePlanPath: 返回显示路径不复用 Windows 小写 normalizer', () => {
  const base = makeTmpDir('native-plan-display-case');
  const dir = path.join(base, 'MixedCaseProject');
  const runtime = path.join(dir, '.pace');
  const local = path.join(dir, 'Docs', 'Plan.md');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(local, '# local plan\n', 'utf8');
  fs.writeFileSync(path.join(runtime, 'current-native-plan'), local, 'utf8');

  const utils = createPlanUtils({
    ...paceUtils,
    getProjectRuntimeDir: () => runtime,
    normalizePath: value => String(value || '').replace(/\\/g, '/').toLowerCase(),
  });
  assert.strictEqual(utils.getNativePlanPath(dir), local.replace(/\\/g, '/'));
});

// ============================================================
// 9. hasUnsyncedPlanFiles() / listUnsyncedPlanFiles() — 4 个测试
// ============================================================
console.log('\n--- hasUnsyncedPlanFiles / listUnsyncedPlanFiles ---');

test('hasUnsyncedPlanFiles: 无 docs/plans/ → false', () => {
  const dir = makeTmpDir('usp-empty');
  assert.strictEqual(paceUtils.hasUnsyncedPlanFiles(dir), false);
});

test('hasUnsyncedPlanFiles: 全部已同步 → false', () => {
  const dir = makeTmpDir('usp-allsynced');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-01-feature-a.md'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'synced-plans'), '2026-03-01-feature-a.md\n');
  assert.strictEqual(paceUtils.hasUnsyncedPlanFiles(dir), false);
});

test('hasUnsyncedPlanFiles: 部分未同步 → true + listUnsyncedPlanFiles 仅返回未同步', () => {
  const dir = makeTmpDir('usp-partial');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-01-feature-a.md'), '');
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-04-feature-b.md'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'synced-plans'), '2026-03-01-feature-a.md\n');
  assert.strictEqual(paceUtils.hasUnsyncedPlanFiles(dir), true);
  const unsynced = paceUtils.listUnsyncedPlanFiles(dir);
  assert.strictEqual(unsynced.length, 1);
  assert.strictEqual(unsynced[0].name, '2026-03-04-feature-b.md');
  assert.strictEqual(unsynced[0].dir, 'docs/plans');
});

test('hasUnsyncedPlanFiles: 无 synced-plans 文件 → 全部视为未同步', () => {
  const dir = makeTmpDir('usp-nosync');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-01-feature-a.md'), '');
  assert.strictEqual(paceUtils.hasUnsyncedPlanFiles(dir), true);
  const unsynced = paceUtils.listUnsyncedPlanFiles(dir);
  assert.strictEqual(unsynced.length, 1);
  assert.strictEqual(unsynced[0].name, '2026-03-01-feature-a.md');
});

test('listUnsyncedPlanFiles: 主文件已同步时 -design.md 伴随文件也视为已同步', () => {
  const dir = makeTmpDir('usp-design');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-08-feature.md'), '');
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-08-feature-design.md'), '');
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-08-other.md'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'synced-plans'), '2026-03-08-feature.md\n');
  const unsynced = paceUtils.listUnsyncedPlanFiles(dir);
  assert.strictEqual(unsynced.length, 1);
  assert.strictEqual(unsynced[0].name, '2026-03-08-other.md');
});

test('listUnsyncedPlanFiles: synced-plans 含 CRLF 时已同步 plan 仍正确识别（PL-01）', () => {
  // PL-01：读取侧未规整 CRLF，synced name 残留尾随 \r 与无 \r 的 p.name 不相等，
  // 已 bridge 的 plan 被误判未同步 → 重复 bridge over-block。
  const dir = makeTmpDir('usp-crlf');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-01-feature-a.md'), '');
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-08-feature-b.md'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  // synced-plans 以 CRLF 入库（Windows 编辑器 / git autocrlf）
  fs.writeFileSync(path.join(dir, '.pace', 'synced-plans'), '2026-03-01-feature-a.md\r\n2026-03-08-feature-b.md\r\n');
  const unsynced = paceUtils.listUnsyncedPlanFiles(dir);
  assert.strictEqual(unsynced.length, 0, 'CRLF synced-plans 下两个 plan 都应识别为已同步');
});

test('bridge candidate plans: 旧 plan 不作为当前 bridge 信号', () => {
  const dir = makeTmpDir('usp-stale-bridge');
  const planDir = path.join(dir, 'docs', 'plans');
  fs.mkdirSync(planDir, { recursive: true });
  const plan = path.join(planDir, '2026-03-08-old-plan.md');
  fs.writeFileSync(plan, '# Old plan\n', 'utf8');
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(plan, old, old);

  assert.strictEqual(paceUtils.hasUnsyncedPlanFiles(dir), true);
  assert.strictEqual(hasBridgeCandidatePlanFiles(dir), false);
  assert.deepStrictEqual(listBridgeCandidatePlanFiles(dir), []);
  assert.strictEqual(paceUtils.formatBridgeHint(dir, dir), null);
  assert.strictEqual(isPaceProject(dir), false);
});

test('bridge candidate plans: current-native-plan 即使较旧也保持桥接提示', () => {
  const dir = makeTmpDir('usp-current-native-bridge');
  const planDir = path.join(dir, 'docs', 'plans');
  fs.mkdirSync(planDir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  const plan = path.join(planDir, '2026-03-08-current-plan.md');
  fs.writeFileSync(plan, '# Current plan\n', 'utf8');
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(plan, old, old);
  fs.writeFileSync(path.join(dir, '.pace', 'current-native-plan'), plan, 'utf8');

  assert.strictEqual(hasBridgeCandidatePlanFiles(dir), true);
  const candidates = listBridgeCandidatePlanFiles(dir);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].name, '2026-03-08-current-plan.md');
  assert.ok(paceUtils.formatBridgeHint(dir, dir).fileList.includes('2026-03-08-current-plan.md'));
  // A1 收紧：bridge candidate（含 current-native-plan）仍被 hasBridgeCandidatePlanFiles 检出（上方断言），
  // 但不再驱动 isPaceProject 激活——降级到 detectSoftSignal 的 dated-plan 软信号。
  assert.strictEqual(isPaceProject(dir), false);
});

// ============================================================
// 10. v6 change parsing/classification
// ============================================================
console.log('\n--- v6 change parsing/classification ---');

function writeV6ChangeFixture(dir, { id = 'CHG-20260507-01', status = 'in-progress', checkbox = '/', tasks = ['- [/] T-001 测试任务'], approved = true, verified = false, reviewed = false, changeSet = null, changeSetSeq = null } = {}) {
  const slug = id.toLowerCase();
  const indexLine = `- [${checkbox}] [[${slug}]] 测试变更 #change [tasks:: T-001]\n`;
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${indexLine}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n${indexLine}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'changes', `${slug}.md`), [
    '---',
    `chg-id: ${id}`,
    `status: ${status}`,
    'date: 2026-05-07',
    'type: change',
    ...(changeSet !== null ? [`change-set: ${changeSet}`] : []),
    ...(changeSetSeq !== null ? [`change-set-seq: ${changeSetSeq}`] : []),
    'parent-tasks: ["[[task]]"]',
    'parent-impl: ["[[implementation_plan]]"]',
    'related-finding: null',
    'aliases: []',
    'tags: []',
    'schema-version: "6.0"',
    'completed-date: null',
    `verified-date: ${verified ? '2026-05-07T12:00:00+08:00' : 'null'}`,
    `reviewed-date: ${reviewed ? '2026-05-07T13:00:00+08:00' : 'null'}`,
    'archived-date: null',
    '---',
    '',
    '# 测试变更',
    '',
    '## 任务清单',
    '',
    ...tasks,
    '',
    approved ? '<!-- APPROVED -->' : '',
    verified ? '<!-- VERIFIED -->' : '',
    reviewed ? '<!-- REVIEWED -->' : '',
    '',
    '## 实施详情',
    '',
  ].filter((line, idx, arr) => line !== '' || arr[idx - 1] !== '').join('\n'));
}

test('getActiveChangeEntries + classifyChange — running', () => {
  const dir = makeTmpDir('v6-class-running');
  writeV6ChangeFixture(dir);
  const entries = paceUtils.getActiveChangeEntries(dir);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].id, 'CHG-20260507-01');
  const classified = paceUtils.classifyChange(entries[0]);
  assert.strictEqual(classified.category, 'running');
  assert.strictEqual(classified.tasks.pending, 1);
});

test('classifyChange — completed 未 verified 需要收尾', () => {
  const dir = makeTmpDir('v6-class-closing');
  writeV6ChangeFixture(dir, { status: 'completed', checkbox: 'x', tasks: ['- [x] T-001 测试任务'] });
  const classified = paceUtils.classifyChange(paceUtils.getActiveChangeEntries(dir)[0]);
  assert.strictEqual(classified.category, 'closing-required');
  assert.strictEqual(classified.verified, false);
});

test('isChangeVerified — verified-date 为带引号 null 时不算 verified', () => {
  const dir = makeTmpDir('v6-class-quoted-null-verified');
  writeV6ChangeFixture(dir, { status: 'completed', checkbox: 'x', tasks: ['- [x] T-001 测试任务'], verified: true });
  const detailPath = path.join(dir, 'changes', 'chg-20260507-01.md');
  const content = fs.readFileSync(detailPath, 'utf8').replace(/^verified-date: .+$/m, 'verified-date: "null"');
  fs.writeFileSync(detailPath, content, 'utf8');
  const entry = paceUtils.getActiveChangeEntries(dir)[0];
  assert.strictEqual(paceUtils.isChangeVerified(entry.detail), false);
  assert.strictEqual(paceUtils.classifyChange(entry).category, 'closing-required');
});

test('isChangeReviewed — reviewed-date + REVIEWED 标记同时存在才算 reviewed', () => {
  const dir = makeTmpDir('v6-reviewed-true');
  writeV6ChangeFixture(dir, { status: 'completed', checkbox: 'x', tasks: ['- [x] T-001 测试任务'], verified: true, reviewed: true });
  const entry = paceUtils.getActiveChangeEntries(dir)[0];
  assert.strictEqual(paceUtils.isChangeReviewed(entry.detail), true);
  assert.strictEqual(paceUtils.classifyChange(entry).reviewed, true);
  // SessionStart / pre-compact 摘要行的 reviewed 维度来源：summarizeActiveChanges 必须回传 reviewed 字段
  assert.strictEqual(paceUtils.summarizeActiveChanges(dir)[0].reviewed, true);
});
test('isChangeReviewed — 缺 <!-- REVIEWED --> 标记不算 reviewed', () => {
  const dir = makeTmpDir('v6-reviewed-nomarker');
  writeV6ChangeFixture(dir, { status: 'completed', checkbox: 'x', tasks: ['- [x] T-001 测试任务'], verified: true, reviewed: true });
  const p = path.join(dir, 'changes', 'chg-20260507-01.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\n<!-- REVIEWED -->/, ''), 'utf8');
  assert.strictEqual(paceUtils.isChangeReviewed(paceUtils.getActiveChangeEntries(dir)[0].detail), false);
});
test('isChangeReviewed — reviewed-date 带引号 null 不算 reviewed', () => {
  const dir = makeTmpDir('v6-reviewed-quoted-null');
  writeV6ChangeFixture(dir, { status: 'completed', checkbox: 'x', tasks: ['- [x] T-001 测试任务'], verified: true, reviewed: true });
  const p = path.join(dir, 'changes', 'chg-20260507-01.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^reviewed-date: .+$/m, 'reviewed-date: "null"'), 'utf8');
  assert.strictEqual(paceUtils.isChangeReviewed(paceUtils.getActiveChangeEntries(dir)[0].detail), false);
});
test('classifyChange — completed+verified 未 reviewed 时 reviewed=false', () => {
  const dir = makeTmpDir('v6-reviewed-false');
  writeV6ChangeFixture(dir, { status: 'completed', checkbox: 'x', tasks: ['- [x] T-001 测试任务'], verified: true });
  const cls = paceUtils.classifyChange(paceUtils.getActiveChangeEntries(dir)[0]);
  assert.strictEqual(cls.reviewed, false);
  assert.strictEqual(cls.category, 'closing-required');
});

test('CS-1. classifyChange / summarizeActiveChanges 解析 change-set / change-set-seq', () => {
  const dir = makeTmpDir('v6-change-set');
  writeV6ChangeFixture(dir, { changeSet: 'review-gate', changeSetSeq: '2/4' });
  const e = paceUtils.getActiveChangeEntries(dir).find(x => x.id === 'CHG-20260507-01');
  const cls = paceUtils.classifyChange(e);
  assert.strictEqual(cls.changeSet, 'review-gate');
  assert.strictEqual(cls.changeSetSeq, '2/4');
  const sum = paceUtils.summarizeActiveChanges(dir)[0];
  assert.strictEqual(sum.changeSet, 'review-gate');
  assert.strictEqual(sum.changeSetSeq, '2/4');
});

test('CS-2. 无 change-set 字段 → changeSet/changeSetSeq null（回归）', () => {
  const dir = makeTmpDir('v6-no-change-set');
  writeV6ChangeFixture(dir);
  const cls = paceUtils.classifyChange(paceUtils.getActiveChangeEntries(dir)[0]);
  assert.strictEqual(cls.changeSet, null);
  assert.strictEqual(cls.changeSetSeq, null);
  assert.strictEqual(paceUtils.summarizeActiveChanges(dir)[0].changeSet, null);
});

test('CS-3. change-set: null 字面量归一为 JS null（非字符串 "null"）', () => {
  const dir = makeTmpDir('v6-change-set-literal-null');
  writeV6ChangeFixture(dir, { changeSet: 'null', changeSetSeq: '"null"' });
  const cls = paceUtils.classifyChange(paceUtils.getActiveChangeEntries(dir)[0]);
  assert.strictEqual(cls.changeSet, null, '字面 null 应归一为 JS null');
  assert.strictEqual(cls.changeSetSeq, null, '带引号 null 也应归一为 JS null');
});

// ============================================================
// HOTFIX-20260610-01 T-001：索引行 wikilink 全名（带 slug）形态解析兼容
// ============================================================

test('SLUGWL-1. parseChangeIndex 解析全名|纯ID 别名形态索引行', () => {
  const entries = paceUtils.parseChangeIndex(
    '- [/] [[chg-20260610-06-activation-signal-tighten-dual-entry-lock-fix|chg-20260610-06]] 激活信号收紧 #change [tasks:: T-001~T-004]'
  );
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].id, 'CHG-20260610-06', 'id 应为纯 ID');
  assert.strictEqual(entries[0].slug, 'chg-20260610-06-activation-signal-tighten-dual-entry-lock-fix', 'slug 应为文件 stem 全名');
  assert.strictEqual(entries[0].checkbox, '/');
  assert.match(entries[0].rest, /^激活信号收紧/);
  assert.strictEqual(entries[0].malformed, false);
});

test('SLUGWL-2. parseChangeIndex 全名无别名 + HOTFIX 全名形态', () => {
  const entries = paceUtils.parseChangeIndex([
    '- [ ] [[chg-20260610-08-sessionstart-soft-signal-prompt-layer]] 提问层 #change',
    '- [x] [[hotfix-20260610-01-chg-slug-wikilink-fix|HOTFIX-20260610-01]] wikilink 修复 #change',
  ].join('\n'));
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].id, 'CHG-20260610-08');
  assert.strictEqual(entries[0].slug, 'chg-20260610-08-sessionstart-soft-signal-prompt-layer');
  assert.strictEqual(entries[1].id, 'HOTFIX-20260610-01');
  assert.strictEqual(entries[1].slug, 'hotfix-20260610-01-chg-slug-wikilink-fix');
});

test('SLUGWL-3. parseChangeIndex 旧纯 ID 形态回归（slug=纯ID 小写）', () => {
  const entries = paceUtils.parseChangeIndex('- [x] [[chg-20260609-09]] 旧形态 #change');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].id, 'CHG-20260609-09');
  assert.strictEqual(entries[0].slug, 'chg-20260609-09');
});

test('SLUGWL-5. migrate/fix-slug-wikilinks：parent 链接与 wikilink 迁移纯函数', () => {
  const mig = require('../migrate/fix-slug-wikilinks');
  // parent 链接：裸 [[task]] → 部分路径；已迁移内容幂等（返回 null）
  const fm = '---\nparent-tasks: ["[[task]]"]\nparent-impl: ["[[implementation_plan]]"]\n---\n';
  const out = mig.migrateParentLinks(fm, 'paceflow-hooks');
  assert.match(out, /parent-tasks: \["\[\[paceflow-hooks\/task\|task\]\]"\]/);
  assert.match(out, /parent-impl: \["\[\[paceflow-hooks\/implementation_plan\|implementation_plan\]\]"\]/);
  assert.strictEqual(mig.migrateParentLinks(out, 'paceflow-hooks'), null, '已迁移应幂等返回 null');
  // wikilink：映射内纯 ID → 全名|纯ID；映射外（旧无 slug）保持；onlyBelowArchive 不动活跃区
  const slugMap = new Map([['chg-20260610-06', 'chg-20260610-06-some-slug']]);
  const idx = '- [/] [[chg-20260610-06]] 活跃 #change\n<!-- ARCHIVE -->\n- [x] [[chg-20260610-06]] 归档 #change\n- [x] [[chg-20260609-09]] 旧 #change\n';
  const r = mig.migrateWikilinks(idx, slugMap, true);
  assert.strictEqual(r.count, 1, '仅 ARCHIVE 下方映射内 1 处');
  assert.match(r.text, /- \[\/\] \[\[chg-20260610-06\]\] 活跃/, '活跃区不动');
  assert.match(r.text, /- \[x\] \[\[chg-20260610-06-some-slug\|chg-20260610-06\]\] 归档/);
  assert.match(r.text, /- \[x\] \[\[chg-20260609-09\]\] 旧/, '旧无 slug 保持纯 ID');
  const r2 = mig.migrateWikilinks(idx, slugMap, false);
  assert.strictEqual(r2.count, 2, '含活跃区共 2 处');
  // walkthrough（escapePipe）：纯 ID → \| 转义形态；未转义旧迁移产物修正为 \|；已转义幂等
  const wt = '| 2026-06-10 | [[chg-20260610-06]] 摘要 | CHG-20260610-06 |\n| 2026-06-09 | [[chg-20260610-06-some-slug|chg-20260610-06]] 未转义 | CHG-20260610-06 |\n';
  const r3 = mig.migrateWikilinks(wt, slugMap, false, true);
  assert.match(r3.text, /\[\[chg-20260610-06-some-slug\\\|chg-20260610-06\]\] 摘要/, '纯 ID 应迁为 \\| 转义形态');
  assert.match(r3.text, /\[\[chg-20260610-06-some-slug\\\|chg-20260610-06\]\] 未转义/, '未转义形态应修正为 \\|');
  const r4 = mig.migrateWikilinks(r3.text, slugMap, false, true);
  assert.strictEqual(r4.count, 0, '已转义内容幂等');
});

test('SLUGWL-7. 全名活跃索引行 → getActiveChangeEntries 详情可解析（R 审计 P0-1 回归）', () => {
  // P0-1：entries.slug 改全名后，readChangeDetail 必须用纯 ID 调（detailPathForId 只认纯 ID 入参）。
  const dir = makeTmpDir('slugwl-fullname-active');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260610-06-some-slug.md'),
    '---\nchg-id: CHG-20260610-06\nstatus: in-progress\n---\n# t\n\n## 任务清单\n\n- [/] T-001 x\n\n<!-- APPROVED -->\n', 'utf8');
  const line = '- [/] [[chg-20260610-06-some-slug|chg-20260610-06]] 标题 #change [tasks:: T-001~T-001]\n';
  fs.writeFileSync(path.join(dir, 'task.md'), `# 任务\n\n## 活跃任务\n\n${line}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 计划\n\n## 变更索引\n\n${line}\n<!-- ARCHIVE -->\n`, 'utf8');
  paceUtils._clearArtifactDirCache();
  const entries = paceUtils.getActiveChangeEntries(dir);
  assert.strictEqual(entries.length, 1);
  assert.ok(entries[0].detail && !entries[0].detail.missing, '全名行的详情必须可解析（不得 detail-missing）');
  const cls = paceUtils.classifyChange(entries[0]);
  assert.strictEqual(cls.category, 'running', '应分类为 running 而非 inconsistent：' + JSON.stringify({ category: cls.category, reason: cls.reason }));
});

test('SLUGWL-8. task.md 纯 ID 行命中带 slug 详情文件（v7 单索引；原双索引 join 防裂回归改写）', () => {
  const dir = makeTmpDir('slugwl-mixed-join');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260610-06-some-slug.md'),
    '---\nchg-id: CHG-20260610-06\nstatus: in-progress\n---\n# t\n\n## 任务清单\n\n- [/] T-001 x\n\n<!-- APPROVED -->\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'task.md'),
    '# 任务\n\n## 活跃任务\n\n- [/] [[chg-20260610-06]] 标题 #change\n\n<!-- ARCHIVE -->\n', 'utf8');
  paceUtils._clearArtifactDirCache();
  const entries = paceUtils.getActiveChangeEntries(dir);
  assert.strictEqual(entries.length, 1, '纯 ID 索引行 + 带 slug 详情文件应为单条：' + JSON.stringify(entries.map(e => e.slug)));
  assert.strictEqual(entries[0].id, 'CHG-20260610-06');
  assert.ok(entries[0].task && !entries[0].detail.missing, '索引命中且详情经 glob 解析到带 slug 文件');
});

test('SLUGWL-6. validateWalkthroughLinks 接受 \\| 转义全名行 + 仍校验纯 ID 旧行', () => {
  const dir = makeTmpDir('slugwl-walkthrough-escape');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260610-06-some-slug.md'), '---\nchg-id: CHG-20260610-06\nstatus: archived\n---\n# t\n\n## 任务清单\n\n- [x] T-001 x\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260609-09.md'), '---\nchg-id: CHG-20260609-09\nstatus: archived\n---\n# t\n\n## 任务清单\n\n- [x] T-001 x\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), [
    '# 工作记录', '', '## 最近工作', '',
    '| 日期 | 完成内容 | 关联变更 |', '| --- | --- | --- |',
    '| 2026-06-10 | [[chg-20260610-06-some-slug\\|chg-20260610-06]] 全名转义行 | CHG-20260610-06 |',
    '| 2026-06-09 | [[chg-20260609-09]] 旧纯 ID 行 | CHG-20260609-09 |',
    '', '<!-- ARCHIVE -->', '',
  ].join('\n'), 'utf8');
  const issues = paceUtils.validateWalkthroughLinks(dir);
  assert.deepStrictEqual(issues, [], '转义全名行与旧纯 ID 行都不应报 issue：' + JSON.stringify(issues));
});

test('SLUGWL-9. validateWalkthroughLinks 收紧：纯 ID 指向带 slug 详情文件 → 报迁移建议（CHG-20260611-01）', () => {
  // 纯 ID wikilink 对带 slug 文件名在 Obsidian 是死链；迁移两遍跑完、部署窗口关闭后收紧，
  // issue 文案给 expectedDisplay（全名\|纯ID）迁移建议。
  const dir = makeTmpDir('slugwl-pure-id-dead-link');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260610-06-some-slug.md'), '---\nchg-id: CHG-20260610-06\nstatus: archived\n---\n# t\n\n## 任务清单\n\n- [x] T-001 x\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), [
    '# 工作记录', '', '## 最近工作', '',
    '| 日期 | 完成内容 | 关联变更 |', '| --- | --- | --- |',
    '| 2026-06-10 | [[chg-20260610-06]] 纯 ID 指向带 slug 文件 | CHG-20260610-06 |',
    '', '<!-- ARCHIVE -->', '',
  ].join('\n'), 'utf8');
  const issues = paceUtils.validateWalkthroughLinks(dir);
  assert.strictEqual(issues.length, 1, '纯 ID 指向带 slug 文件应报死链 issue：' + JSON.stringify(issues));
  assert.ok(issues[0].includes('chg-20260610-06-some-slug\\|chg-20260610-06'), '应建议 expectedDisplay 全名\\|纯ID 形态：' + issues[0]);
});

test('SLUGWL-4. findActiveIndexBelowArchive 检出全名形态的误插活跃行', () => {
  const content = [
    '## 活跃任务', '', '<!-- ARCHIVE -->', '',
    '- [/] [[chg-20260610-06-activation-signal-tighten-dual-entry-lock-fix|chg-20260610-06]] 误插 #change',
  ].join('\n');
  assert.deepStrictEqual(paceUtils.findActiveIndexBelowArchive(content), ['chg-20260610-06']);
});

test('AIBA-1. findActiveIndexBelowArchive 检出 ARCHIVE 下方的活跃状态索引行', () => {
  const content = [
    '# 项目任务追踪', '', '## 活跃任务', '', '<!-- ARCHIVE -->', '',
    '- [/] [[chg-20260607-02]] 误插的活跃 CHG #change [tasks:: T-001]',
    '- [x] [[chg-20260607-01]] 正常归档 #change [tasks:: T-001]',
  ].join('\n');
  assert.deepStrictEqual(paceUtils.findActiveIndexBelowArchive(content), ['chg-20260607-02']);
});

test('AIBA-2. 活跃行在 ARCHIVE 上方 + 归档行均终态 → 无误报（回归）', () => {
  const content = [
    '## 活跃任务', '', '- [/] [[chg-20260607-02]] 正常活跃 #change', '', '<!-- ARCHIVE -->', '',
    '- [x] [[chg-20260607-01]] 归档 #change', '- [-] [[chg-20260606-09]] 取消 #change',
  ].join('\n');
  assert.deepStrictEqual(paceUtils.findActiveIndexBelowArchive(content), []);
});

test('AIBA-3. 无 ARCHIVE 标记 → 空数组（不崩）', () => {
  assert.deepStrictEqual(paceUtils.findActiveIndexBelowArchive('# t\n\n- [/] [[chg-20260607-02]] x'), []);
});

test('AIBA-4. ARCHIVE 下方多个活跃状态行（[ ]/[/]/[!]）全部检出', () => {
  const content = [
    '## 活跃任务', '', '<!-- ARCHIVE -->', '',
    '- [ ] [[chg-20260607-03]] planned 误插 #change',
    '- [!] [[hotfix-20260607-01]] blocked 误插 #hotfix',
    '- [x] [[chg-20260607-01]] 正常归档 #change',
  ].join('\n');
  assert.deepStrictEqual(paceUtils.findActiveIndexBelowArchive(content), ['chg-20260607-03', 'hotfix-20260607-01']);
});

test('parseFrontmatter — 支持 UTF-8 BOM 前缀', () => {
  const content = '\uFEFF---\nchg-id: CHG-20260507-01\nstatus: in-progress\n---\n';
  assert.deepStrictEqual(parseFrontmatter(content), {
    'chg-id': 'CHG-20260507-01',
    status: 'in-progress',
  });
});

test('classifyChange — archived/cancelled 活跃区视为 inconsistent', () => {
  const dir = makeTmpDir('v6-class-terminal-active');
  writeV6ChangeFixture(dir, { status: 'archived', checkbox: 'x', tasks: ['- [x] T-001 测试任务'], verified: true });
  const classified = paceUtils.classifyChange(paceUtils.getActiveChangeEntries(dir)[0]);
  assert.strictEqual(classified.category, 'inconsistent');
  assert.strictEqual(classified.reason, 'active-archived');
});

test('countDetailTasks — 只识别 T-NNN 三位任务编号', () => {
  const content = [
    '## 任务清单',
    '',
    '- [/] T-001 正确编号',
    '- [x] T-002 正确编号',
    '- [ ] T-1 非规范编号',
    '',
    '## 实施详情',
  ].join('\n');
  assert.deepStrictEqual(paceUtils.countDetailTasks(content), {
    pending: 1,
    done: 1,
    total: 2,
    inProgress: 1,
    blocked: 0,
  });
});

// ============================================================
// 12. getProjectName() 特殊字符 — 3 个测试
// ============================================================
console.log('\n--- getProjectName 特殊字符 ---');

test('getProjectName — 中文目录名被过滤', () => {
  const name = getProjectName('/home/user/我的项目');
  assert.strictEqual(name, 'unknown-project');
});

test('getProjectName — @#符号被过滤', () => {
  const name = getProjectName('/home/user/@my-project#1');
  assert.strictEqual(name, 'my-project-1');
});

test('getProjectName — 混合字符保留合法部分', () => {
  const name = getProjectName('/home/user/My Project (v2)');
  assert.strictEqual(name, 'my-project-v2');
});

// ============================================================
// 13. formatBridgeHint() — 3 个测试
// ============================================================
console.log('\n--- formatBridgeHint ---');

test('formatBridgeHint — 无计划文件返回 null', () => {
  const dir = makeTmpDir('bridge-none');
  assert.strictEqual(paceUtils.formatBridgeHint(dir, dir), null);
});

test('formatBridgeHint — 有未同步计划文件返回提示', () => {
  const dir = makeTmpDir('bridge-has');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-09-feature.md'), '');
  const result = paceUtils.formatBridgeHint(dir, dir);
  assert.ok(result !== null, '应返回非 null');
  assert.ok(result.fileList.includes('docs/plans/2026-03-09-feature.md'), 'fileList 应含完整路径');
  assert.ok(result.bridgeSteps.includes('Skill(paceflow:pace-bridge)'), 'bridgeSteps 应指向 pace-bridge skill');
  assert.ok(result.bridgeSteps.includes('创建 CHG'), 'bridgeSteps 应要求桥接为 CHG');
  assert.ok(result.bridgeSteps.includes('sync-plan.js'), 'bridgeSteps 应给出 plan 同步 helper');
  assert.ok(!result.bridgeSteps.includes('Edit '), 'bridgeSteps 不应引导主 session 直接 Edit artifact');
});

test('formatBridgeHint — 已同步文件不返回', () => {
  const dir = makeTmpDir('bridge-synced');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-03-09-feature.md'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'synced-plans'), '2026-03-09-feature.md\n');
  assert.strictEqual(paceUtils.formatBridgeHint(dir, dir), null);
});

// ============================================================
// 14. createLogger() — 3 个测试
// ============================================================
console.log('\n--- createLogger ---');

test('createLogger — 基本写入', () => {
  const dir = makeTmpDir('logger-basic');
  const logFile = path.join(dir, 'test.log');
  const log = paceUtils.createLogger(logFile);
  log('hello\n');
  log('world\n');
  const content = fs.readFileSync(logFile, 'utf8');
  assert.ok(content.includes('hello'), '应包含 hello');
  assert.ok(content.includes('world'), '应包含 world');
});

test('createLogger — 超过 1MB 触发轮转', () => {
  const dir = makeTmpDir('logger-rotate');
  const logFile = path.join(dir, 'test.log');
  // 写入 1025KB 数据（超过 1MB 阈值）
  const chunk = 'A'.repeat(1024) + '\n';
  fs.writeFileSync(logFile, chunk.repeat(1025));
  const sizeBefore = fs.statSync(logFile).size;
  assert.ok(sizeBefore > 1024 * 1024, '应超过 1MB');
  // 触发轮转
  const log = paceUtils.createLogger(logFile);
  log('trigger\n');
  const sizeAfter = fs.statSync(logFile).size;
  assert.ok(sizeAfter < sizeBefore, `轮转后应变小: ${sizeAfter} < ${sizeBefore}`);
});

test('createLogger — 轮转后对齐到换行符', () => {
  const dir = makeTmpDir('logger-align');
  const logFile = path.join(dir, 'test.log');
  // 写入带换行的大数据
  const lines = [];
  for (let i = 0; i < 600; i++) lines.push(`line-${i.toString().padStart(4, '0')}: ${'X'.repeat(900)}`);
  fs.writeFileSync(logFile, lines.join('\n') + '\n');
  const log = paceUtils.createLogger(logFile);
  log('after-rotate\n');
  const content = fs.readFileSync(logFile, 'utf8');
  // 第一个字符应该是 'l'（line- 开头），不应是截断的中间内容
  assert.ok(content.startsWith('line-'), `轮转后应从完整行开始，实际: ${content.slice(0, 20)}`);
  assert.ok(content.includes('after-rotate'), '应包含轮转后写入的内容');
});

// LOGENV：PACE_LOG_PATH 可注入日志路径（CHG-20260614-08 T-001，根治 e2e 写源码树共享日志 flaky）
test('LOGENV-1: defaultLogPath 优先返回 PACE_LOG_PATH 注入值', () => {
  const orig = process.env.PACE_LOG_PATH;
  try {
    process.env.PACE_LOG_PATH = '/tmp/pace-inject-xyz.log';
    assert.strictEqual(paceUtils.defaultLogPath(), '/tmp/pace-inject-xyz.log');
  } finally {
    if (orig === undefined) delete process.env.PACE_LOG_PATH; else process.env.PACE_LOG_PATH = orig;
  }
});

test('LOGENV-2: defaultLogPath 缺省回退 plugin/hooks/pace-hooks.log', () => {
  const orig = process.env.PACE_LOG_PATH;
  try {
    delete process.env.PACE_LOG_PATH;
    const p = paceUtils.defaultLogPath();
    assert.ok(p.endsWith(path.join('hooks', 'pace-hooks.log')), `缺省应回退 hooks/pace-hooks.log，实际 ${p}`);
    assert.ok(!p.includes('undefined') && !p.includes('..'), `回退路径应规整无 .. 残留，实际 ${p}`);
  } finally {
    if (orig === undefined) delete process.env.PACE_LOG_PATH; else process.env.PACE_LOG_PATH = orig;
  }
});

test('LOGENV-3: createLogger() 空参写入 PACE_LOG_PATH 注入的日志', () => {
  const orig = process.env.PACE_LOG_PATH;
  const tmp = path.join(makeTmpDir('logenv'), 'inject.log');
  try {
    process.env.PACE_LOG_PATH = tmp;
    paceUtils.createLogger()('LOGENV3-line\n');
    assert.ok(fs.readFileSync(tmp, 'utf8').includes('LOGENV3-line'), 'createLogger() 空参应写入注入路径');
  } finally {
    if (orig === undefined) delete process.env.PACE_LOG_PATH; else process.env.PACE_LOG_PATH = orig;
  }
});

test('LOGENV-4: createLogger(显式路径) 仍写显式路径（向后兼容，优先于 env）', () => {
  const orig = process.env.PACE_LOG_PATH;
  const tmp = path.join(makeTmpDir('logenv-explicit'), 'explicit.log');
  try {
    process.env.PACE_LOG_PATH = '/tmp/should-not-be-used.log';
    paceUtils.createLogger(tmp)('LOGENV4-line\n');
    assert.ok(fs.readFileSync(tmp, 'utf8').includes('LOGENV4-line'), '显式路径优先于 env');
    assert.ok(!fs.existsSync('/tmp/should-not-be-used.log'), 'env 不应在显式路径时被使用');
  } finally {
    if (orig === undefined) delete process.env.PACE_LOG_PATH; else process.env.PACE_LOG_PATH = orig;
  }
});

test('LOGENV-5: 无 hook 硬编码源码树日志路径（全部经 PACE_LOG_PATH 可注入）', () => {
  // 等价/结构锁：遍历 hooks 目录而非逐个硬编码，断言无 hook 绕过 defaultLogPath
  // 直接写 path.join(__dirname,'pace-hooks.log') —— 否则该 hook 在 e2e 仍污染源码树。
  const hooksDir = path.join(__dirname, '..', 'plugin', 'hooks');
  const files = fs.readdirSync(hooksDir).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(hooksDir, f), 'utf8');
    if (/createLogger\(\s*path\.join\(/.test(src)) offenders.push(`${f}: createLogger(path.join...)`);
    if (/=\s*path\.join\(\s*__dirname\s*,\s*['"]pace-hooks\.log['"]\s*\)/.test(src)) offenders.push(`${f}: const LOG = path.join(__dirname,'pace-hooks.log')`);
  }
  assert.strictEqual(offenders.length, 0, `这些 hook 仍硬编码日志路径绕过 PACE_LOG_PATH:\n${offenders.join('\n')}`);
});

// DETECT：v5/v6 检测原语下沉单一 detection 模块（CHG-20260614-11，去门面/path-utils 双实现漂移）
function mkDetectFixtures() {
  const v6 = makeTmpDir('detect-v6'); fs.mkdirSync(path.join(v6, 'changes'));
  const v5cn = makeTmpDir('detect-v5cn'); fs.writeFileSync(path.join(v5cn, 'task.md'), '# 项目任务追踪\n## 活跃任务\n<!-- ARCHIVE -->\n');
  const v5en = makeTmpDir('detect-v5en');
  fs.writeFileSync(path.join(v5en, 'task.md'), '# Tasks\n- [ ] a\n');
  fs.writeFileSync(path.join(v5en, 'implementation_plan.md'), '# Implementation Plan\n- [ ] b\n');
  const todo = makeTmpDir('detect-todo'); fs.writeFileSync(path.join(todo, 'task.md'), '# My Tasks\n- [ ] buy milk\n');
  const empty = makeTmpDir('detect-empty');
  // v5sig：触发 implementation_plan.md / walkthrough.md / findings.md 三条签名分支（task.md 签名外的覆盖）
  const v5sig = makeTmpDir('detect-v5sig');
  fs.writeFileSync(path.join(v5sig, 'implementation_plan.md'), '# 实施计划\n## 变更索引\n');
  fs.writeFileSync(path.join(v5sig, 'walkthrough.md'), '# 工作记录\n## 最近工作\n');
  fs.writeFileSync(path.join(v5sig, 'findings.md'), '# 调研记录\n## 未解决问题\n');
  return { v6, v5cn, v5en, todo, empty, v5sig };
}

test('DETECT-1: detection 模块 hasChangesDir/legacyV5FilesInDir 行为正确', () => {
  const detection = require('../plugin/hooks/pace-utils/detection');
  const fx = mkDetectFixtures();
  assert.strictEqual(detection.hasChangesDir(fx.v6), true, 'v6 有 changes/ → hasChangesDir true');
  assert.deepStrictEqual(detection.legacyV5FilesInDir(fx.v6), [], 'v6 → 非 legacy');
  assert.strictEqual(detection.hasChangesDir(fx.v5cn), false, 'v5 无 changes/');
  assert.ok(detection.legacyV5FilesInDir(fx.v5cn).includes('task.md'), 'v5 中文根+ARCHIVE → 检出 task.md');
  assert.deepStrictEqual(detection.legacyV5FilesInDir(fx.v5en).sort(), ['implementation_plan.md', 'task.md'], 'v5 英文双根+checkbox → 检出双根');
  assert.deepStrictEqual(detection.legacyV5FilesInDir(fx.todo), [], 'generic todo（# My Tasks 非根标题）→ false positive 防护');
  assert.deepStrictEqual(detection.legacyV5FilesInDir(fx.empty), [], '空目录 → 非 legacy');
  const sig = detection.legacyV5FilesInDir(fx.v5sig).sort();
  assert.deepStrictEqual(sig, ['findings.md', 'implementation_plan.md', 'walkthrough.md'], 'impl/walkthrough/findings 三条签名分支均命中');
});

test('DETECT-2: 门面 getV5MigrationInfo.files / path-utils / detection 三方对同组 fixture 结论一致（等价锁，穿越下沉不变）', () => {
  const detection = require('../plugin/hooks/pace-utils/detection');
  const pathUtils = require('../plugin/hooks/pace-utils/path-utils');
  const fx = mkDetectFixtures();
  for (const dir of Object.values(fx)) {
    const viaDetection = detection.legacyV5FilesInDir(dir).slice().sort();
    const viaPathUtils = pathUtils.legacyV5FilesInDir(dir).slice().sort();
    const viaFacade = getV5MigrationInfo(dir).files.slice().sort();
    assert.deepStrictEqual(viaPathUtils, viaDetection, `path-utils 与 detection legacyV5FilesInDir 对 ${dir} 一致`);
    assert.deepStrictEqual(viaFacade, viaDetection, `门面 getV5MigrationInfo.files 与 detection 对 ${dir} 一致`);
    assert.strictEqual(pathUtils.hasChangesDir(dir), detection.hasChangesDir(dir), `hasChangesDir 对 ${dir} 一致`);
  }
});

test('BG-WHITELIST. paceflow tests/ 验证脚本不被当 artifact-write-script over-block（白名单覆盖全部测试文件，HOTFIX-20260614-01）', () => {
  const repoRoot = path.join(__dirname, '..');
  const artDir = '/tmp/some-artifact-dir';
  // test-session-layers.js 含 artifact fixture（corrections.md/walkthrough.md 引用），属 paceflow 验证脚本应放行；
  // 白名单只列 test-pace-utils+test-hooks-e2e 时 test-session-layers 会被当 artifact-write-script 误拦（红）。
  const scripts = ['tests/test-session-layers.js', 'tests/test-pace-utils.js', 'tests/test-hooks-e2e.js',
    'tests/test-migrate-v7.js', 'tests/test-agent-tests-helpers.js', 'tests/run-all.js', 'tests/test-run-all.js'];
  for (const f of scripts) {
    assert.strictEqual(
      bashGuard.bashCommandEmbedsArtifactWriteScript(`node ${f}`, repoRoot, artDir),
      false,
      `${f} 应被 isPaceflowValidationScriptTarget 白名单放行（不当 artifact-write-script over-block）`
    );
  }
  // 反向锁（widen-matcher-verify-reverse）：放宽只放行 paceflow tests/，未削弱实际防护——
  // ① 非 tests/ 的真实 artifact 写仍被拦（node -e 内联 writeFileSync('task.md')）。
  assert.strictEqual(
    bashGuard.bashCommandEmbedsArtifactWriteScript(`node -e "require('fs').writeFileSync('task.md','x')"`, repoRoot, repoRoot),
    true,
    '反向：node -e 内联写 task.md 仍应被拦（widening 不削弱实际 artifact 写防护）'
  );
  // ② PS 侧白名单对称放宽（消 bash/PS 移植不对称，opus P3a）。
  assert.strictEqual(
    powershellGuard.powershellCommandEmbedsArtifactWriteScript('node tests/test-session-layers.js', repoRoot, artDir),
    false,
    'PS 侧 tests/*.js 应同样放行（与 bash-guard 对称）'
  );
  // ③ 非 paceflow 仓库（无 plugin.json name=paceflow）的 tests/x.js 写 artifact 仍被扫描拦截——
  //    plugin.json gate 限定白名单只在 paceflow 仓库本身生效，用户项目不受放宽影响（opus #1）。
  const fakeRepo = makeTmpDir('bg-non-paceflow');
  fs.mkdirSync(path.join(fakeRepo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, 'tests', 'evil.js'), "require('fs').writeFileSync('changes/x.md','<!-- APPROVED -->')\n");
  assert.strictEqual(
    bashGuard.bashCommandEmbedsArtifactWriteScript('node tests/evil.js', fakeRepo, fakeRepo),
    true,
    '反向：非 paceflow 仓库的 tests/x.js 写 artifact 仍被拦（gate 限定，用户项目不受放宽削弱）'
  );
});

test('logEntry — 字段单行化并截断长值', () => {
  const entry = paceUtils.logEntry('PreToolUse', 'DENY', {
    reason: 'line1\nline2|pipe',
    long: 'x'.repeat(1020),
  });
  const lines = entry.trimEnd().split('\n');
  assert.strictEqual(lines.length, 1, '日志字段中的换行不应打断结构化日志');
  assert.ok(entry.includes('reason=line1\\nline2/pipe'));
  assert.ok(entry.includes('long='));
  assert.ok(entry.includes('...'), '长字段应截断');
});

test('projectLogEntry — 补齐 cwd/project_root/artifact_dir/mode 上下文', () => {
  const root = makeTmpDir('project-log-root');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(path.join(root, 'changes'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  const entry = paceUtils.projectLogEntry(child, 'Stop', 'ENTRY', { proj: 'demo' });
  assert.ok(entry.includes(`cwd=${child.replace(/\\/g, '/')}`));
  assert.ok(entry.includes(`project_root=${root.replace(/\\/g, '/')}`));
  assert.ok(entry.includes(`artifact_dir=${root.replace(/\\/g, '/')}/`));
  assert.ok(entry.includes('mode=inherited'));
});

// ============================================================
// 15. parseHookStdin() — 6 个测试
// ============================================================
console.log('\n--- parseHookStdin ---');

test('parseHookStdin — 完整字段正常解析', () => {
  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: {
      file_path: 'C:\\Users\\test\\file.js',
      old_string: 'old',
      new_string: 'new',
      content: 'full content'
    },
    type: 'startup',
    agent_id: 'agent-123',
    agent_type: 'artifact-writer',
    last_assistant_message: 'done'
  });
  const r = paceUtils.parseHookStdin(input);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.toolName, 'Edit');
  assert.strictEqual(r.filePath, 'C:/Users/test/file.js', 'filePath 应被 normalize');
  assert.strictEqual(r.oldString, 'old');
  assert.strictEqual(r.newString, 'new');
  assert.strictEqual(r.content, 'full content');
  assert.strictEqual(r.type, 'startup');
  assert.strictEqual(r.agentId, 'agent-123');
  assert.strictEqual(r.agentType, 'artifact-writer');
  assert.strictEqual(r.lastMessage, 'done');
});

test('parseHookStdin — 相对 file_path 保持相对且正斜杠规范化', () => {
  const r = paceUtils.parseHookStdin(JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: 'docs\\plans\\test.md' }
  }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.filePath, 'docs/plans/test.md');
});

test('parseHookStdin — POSIX 绝对 file_path 保持原样', () => {
  const r = paceUtils.parseHookStdin(JSON.stringify({
    tool_name: 'Read',
    tool_input: { file_path: '/mnt/k/AI/Paceflow-hooks/paceflow/task.md' }
  }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.filePath, '/mnt/k/AI/Paceflow-hooks/paceflow/task.md');
});

test('parseHookStdin — 空字符串 → ok:false + 全空字段', () => {
  const r = paceUtils.parseHookStdin('');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.toolName, '');
  assert.strictEqual(r.filePath, '');
  assert.strictEqual(r.oldString, '');
  assert.strictEqual(r.newString, '');
  assert.strictEqual(r.content, '');
  assert.strictEqual(r.type, '');
  assert.strictEqual(r.agentId, '');
  assert.strictEqual(r.agentType, '');
  assert.strictEqual(r.lastMessage, '');
});

test('parseHookStdin — 非 JSON → ok:false + 全空字段', () => {
  const r = paceUtils.parseHookStdin('not json {{{');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.toolName, '');
});

test('parseHookStdin — JSON 字面量 null/数组/数字归一为安全空对象不抛（PUC-02/ROB-01）', () => {
  // JSON.parse('null') 返回 null（不抛、ok=true），后续 parsed.session_id 访问 null 抛 TypeError，
  // withStdinParsed 无 try/catch → 进程崩溃 fail-open；数组/数字/false/字符串虽不抛但非对象，应一并归一。
  for (const raw of ['null', '[]', '123', 'false', '"str"']) {
    const r = paceUtils.parseHookStdin(raw);
    assert.strictEqual(r.ok, false, `${raw} 应归一为 ok:false`);
    assert.strictEqual(r.toolName, '');
    assert.strictEqual(r.filePath, '');
    assert.deepStrictEqual(r.toolInput, {});
  }
});

test('parseHookStdin — 部分字段缺失 → 默认值', () => {
  const r = paceUtils.parseHookStdin(JSON.stringify({ tool_name: 'Write' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.toolName, 'Write');
  assert.strictEqual(r.filePath, '');
  assert.strictEqual(r.oldString, '');
  assert.deepStrictEqual(r.toolInput, {});
});

test('parseHookStdin — content 独立于 newString', () => {
  const r = paceUtils.parseHookStdin(JSON.stringify({
    tool_input: { content: 'write-content', new_string: 'edit-new' }
  }));
  assert.strictEqual(r.content, 'write-content');
  assert.strictEqual(r.newString, 'edit-new');
});

test('parseHookStdin — ok:true 时 raw 保留原始对象', () => {
  const r = paceUtils.parseHookStdin(JSON.stringify({ tool_input: { custom: 123 } }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.raw.tool_input.custom, 123);
});

// HOTFIX-20260315-05: CC SessionStart stdin 用 source 字段
test('parseHookStdin — source 字段映射到 type（CC SessionStart compact 事件）', () => {
  const r = paceUtils.parseHookStdin(JSON.stringify({ source: 'compact', session_id: 'abc' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'compact', 'source 字段应映射到 type');
});

test('parseHookStdin — source 优先于 type（两者都存在时）', () => {
  const r = paceUtils.parseHookStdin(JSON.stringify({ source: 'compact', type: 'startup' }));
  assert.strictEqual(r.type, 'compact', 'source 应优先于 type');
});

test('parseHookStdin — subagent fields fallback', () => {
  const r = paceUtils.parseHookStdin(JSON.stringify({
    subagent_id: 'agent-1',
    subagent_type: 'paceflow:artifact-writer',
    last_assistant_message: '## artifact-writer 报告',
    agent_transcript_path: '/tmp/agent.jsonl',
    duration_ms: 123,
  }));
  assert.strictEqual(r.agentId, 'agent-1');
  assert.strictEqual(r.agentType, 'paceflow:artifact-writer');
  assert.strictEqual(r.lastMessage, '## artifact-writer 报告');
  assert.strictEqual(r.agentTranscriptPath, '/tmp/agent.jsonl');
  assert.strictEqual(r.durationMs, 123);
});

test('isArtifactWriterAgentType — 识别本地与命名空间 agent 类型', () => {
  assert.strictEqual(paceUtils.isArtifactWriterAgentType('artifact-writer'), true);
  assert.strictEqual(paceUtils.isArtifactWriterAgentType('paceflow:artifact-writer'), true);
  assert.strictEqual(paceUtils.isArtifactWriterAgentType('paceaitian-paceflow:artifact-writer'), true);
  assert.strictEqual(paceUtils.isArtifactWriterAgentType('code-reviewer'), false);
  assert.strictEqual(paceUtils.isArtifactWriterAgentType(''), false);
});

// ============================================================
// 16. extractOpenKeys() / normalizeFindingKey() — 5 个测试
// ============================================================
console.log('\n--- extractOpenKeys ---');

test('extractOpenKeys — 空文本返回空数组', () => {
  assert.deepStrictEqual(paceUtils.extractOpenKeys(''), []);
});

test('extractOpenKeys — 无 [ ] 项返回空数组', () => {
  const text = '- [x] 已完成项 — 结论\n- [-] 已跳过项 — 原因\n- [/] 进行中 — 说明';
  assert.deepStrictEqual(paceUtils.extractOpenKeys(text), []);
});

test('extractOpenKeys — 多项提取', () => {
  const text = '- [ ] knowledge 注入问题 — 结论\n- [x] 已完成 — ok\n- [ ] 指引体系补遗 — 结论2';
  const keys = paceUtils.extractOpenKeys(text);
  assert.strictEqual(keys.length, 2);
  assert.strictEqual(keys[0], 'knowledge 注入问题');
  assert.strictEqual(keys[1], '指引体系补遗');
});

test('extractOpenKeys — 全标题提取（无截断）', () => {
  const text = '- [ ] PACEflow 非常长的标题应该被截断 — 结论';
  const keys = paceUtils.extractOpenKeys(text);
  assert.strictEqual(keys.length, 1);
  assert.strictEqual(keys[0], 'paceflow 非常长的标题应该被截断');
});

test('extractOpenKeys — wikilink alias 归一化为精确标题 key', () => {
  const text = '- [ ] [[finding-2026-05-07-login|登录优化]] — 结论';
  const keys = paceUtils.extractOpenKeys(text);
  assert.deepStrictEqual(keys, ['登录优化']);
  assert.strictEqual(paceUtils.normalizeFindingKey('登录优化二期'), '登录优化二期');
});

// ============================================================
// 17. ARCHIVE_MARKER / ARCHIVE_PATTERN — 4 个测试
// ============================================================
console.log('\n--- ARCHIVE_MARKER / ARCHIVE_PATTERN ---');

test('ARCHIVE_MARKER 字符串值正确', () => {
  assert.strictEqual(paceUtils.ARCHIVE_MARKER, '<!-- ARCHIVE -->');
});

test('ARCHIVE_PATTERN 匹配独占行的 <!-- ARCHIVE -->', () => {
  const text = 'content\n<!-- ARCHIVE -->\nold stuff';
  const match = text.match(paceUtils.ARCHIVE_PATTERN);
  assert.ok(match, '应匹配');
  assert.strictEqual(match[0], '<!-- ARCHIVE -->');
});

test('ARCHIVE_PATTERN 匹配 CRLF 独占行的 <!-- ARCHIVE -->', () => {
  const text = 'content\r\n<!-- ARCHIVE -->\r\nold stuff';
  const match = text.match(paceUtils.ARCHIVE_PATTERN);
  assert.ok(match, 'CRLF 应匹配');
  assert.strictEqual(match[0], '<!-- ARCHIVE -->\r');
});

test('ARCHIVE_PATTERN 不匹配行内嵌入的标记', () => {
  const text = 'some text <!-- ARCHIVE --> more text';
  assert.ok(!paceUtils.ARCHIVE_PATTERN.test(text), '行内嵌入不应匹配');
});

// ============================================================
// 18. release sanity — 16 个测试
// ============================================================
console.log('\n--- release sanity ---');

test('plugin manifest 与 marketplace version 一致', () => {
  const repoRoot = path.join(__dirname, '..');
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(fs.readFileSync(path.join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.strictEqual(
    pluginManifest.version,
    marketplace.plugins[0].version,
    'plugin manifest 和 marketplace version 必须一致'
  );
});

test('plugin runtime root 不包含开发资料', () => {
  const repoRoot = path.join(__dirname, '..');
  const pluginRoot = path.join(repoRoot, 'plugin');
  // CHG-B B2：commands/ 为 plugin slash command 发布面（plugin.json "commands" 声明），加入白名单。
  // codex 审计补遗：LICENSE 是发布合规文件（plugin.json 声明 MIT），随 marketplace 打包 ./plugin，加入白名单。
  // CHG-20260815-01：.codex-plugin 是 Codex CLI 的插件 manifest（与 .claude-plugin 并存不双载，探针 M1/M2），加入白名单。
  const allowedTopLevel = new Set(['.claude-plugin', '.codex-plugin', 'agent-references', 'agents', 'commands', 'hooks', 'migrate', 'skills', 'LICENSE']);
  for (const name of fs.readdirSync(pluginRoot)) {
    assert.ok(allowedTopLevel.has(name), `plugin runtime 顶层不应包含 ${name}`);
  }

  const disallowed = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(pluginRoot, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        rel.startsWith('docs/') ||
        rel.startsWith('tests/') ||
        rel.startsWith('internal/') ||
        rel.startsWith('config/') ||
        /^ticket.*\.md$/.test(path.basename(rel)) ||
        /(^|\/)(HOOKS-TEST|MEMORY|migrate-artifacts\.js)$/.test(rel)
      ) {
        disallowed.push(rel);
      }
    }
  }
  walk(pluginRoot);
  assert.deepStrictEqual(disallowed.sort(), [], `plugin runtime 不应包含开发资料: ${disallowed.join(', ')}`);
});

test('plugin runtime 文档不保留 create-chg 扫描分配旧语义', () => {
  const repoRoot = path.join(__dirname, '..');
  const pluginRoot = path.join(repoRoot, 'plugin');
  const stale = [];
  const forbidden = [
    /ID\s+由\s+`?artifact-writer create-chg`?\s+扫描\s+`?changes\/`?\s+后生成/,
    /CHG\/HOTFIX[^。\n]*扫描\s+`?changes\/`?[^。\n]*生成/,
    /create-chg[^。\n]*扫描\s+`?changes\/`?[^。\n]*分配/,
  ];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        const text = fs.readFileSync(full, 'utf8');
        if (forbidden.some(re => re.test(text))) {
          stale.push(path.relative(pluginRoot, full).split(path.sep).join('/'));
        }
      }
    }
  }
  walk(pluginRoot);
  assert.deepStrictEqual(stale.sort(), [], `plugin runtime 文档仍含旧编号语义: ${stale.join(', ')}`);
});

test('skills 明确 HOTFIX reserve helper 用法与 --new 边界', () => {
  const repoRoot = path.join(__dirname, '..');
  const files = [
    'plugin/skills/pace-workflow/SKILL.md',
    'plugin/skills/artifact-management/SKILL.md',
    'plugin/skills/pace-bridge/SKILL.md',
    'plugin/skills/artifact-management/references/change-lifecycle.md',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.ok(text.includes('--operation create-chg') && text.includes('--type hotfix'), `${rel} 应明确 HOTFIX 预留命令（--cwd 可内联其间）`);
    assert.ok(text.includes('--type hotfix --new'), `${rel} 应明确 HOTFIX 新编号复用边界`);
  }
});

test('reserve --cwd 对称守护：全 hook 生成的 reserve create-chg/record-correction 命令都带 --cwd（CHG-20260619-01，防再漏对称半边）', () => {
  // 背景：CHG-20260618-03 T-002 改了 SessionStart 注入 + skill 模板，但漏了 hook 内共享 snippet
  //   FORMAT_SNIPPETS.reserveHelper + pace-utils:393 + agent-lifecycle record-correction（finding-2026-06-19-chg3-t002...）。
  //   本守护扫全 hook .js：凡拼接 RESERVE_ARTIFACT_ID_SCRIPT 生成 reserve create-chg/record-correction 命令的行，都须带 --cwd
  //   （hook 有 cwd scope→注入真实 cwd；reserveHelper 函数模板含条件 --cwd）。skill 静态模板（占位符 --cwd <项目 cwd>）不在本扫描范围（非 .js）。
  const hooksDir = path.join(__dirname, '..', 'plugin', 'hooks');
  const jsFiles = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      if (fs.statSync(fp).isDirectory()) walk(fp);
      else if (name.endsWith('.js')) jsFiles.push(fp);
    }
  };
  walk(hooksDir);
  const violations = [];
  for (const fp of jsFiles) {
    fs.readFileSync(fp, 'utf8').split('\n').forEach((line, i) => {
      // regex 放宽到 /--operation \S/（含 `--operation ${operation}` 变量行，覆盖 reservationExplicitMissingReason:386 等变量化生成点；
      //   仅匹配字面 create-chg|record-correction 会漏扫变量行 → 虚假绿灯，R 审计 CHG-20260619-01 抓出）。
      if (line.includes('RESERVE_ARTIFACT_ID_SCRIPT') && /--operation \S/.test(line) && !line.includes('--cwd')) {
        violations.push(`${path.relative(hooksDir, fp)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(violations, [], `以下 hook reserve 命令缺 --cwd（须内联真实 cwd）：\n${violations.join('\n')}`);
});

test('skills 在无 hook 注入时给出 skill-root helper fallback', () => {
  const repoRoot = path.join(__dirname, '..');
  const files = {
    'plugin/skills/pace-workflow/SKILL.md': ['set-artifact-root.js', 'reserve-artifact-id.js'],
    'plugin/skills/artifact-management/SKILL.md': ['set-artifact-root.js', 'reserve-artifact-id.js'],
    'plugin/skills/pace-bridge/SKILL.md': ['set-artifact-root.js', 'reserve-artifact-id.js', 'sync-plan.js'],
    'plugin/skills/artifact-management/references/change-lifecycle.md': ['reserve-artifact-id.js'],
  };
  for (const [rel, helpers] of Object.entries(files)) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.ok(!text.includes('<运行 hook 提供的'), `${rel} 不应保留不可执行 helper 占位命令`);
    assert.ok(!/find\s+.*~\/\.claude\/plugins\/cache/.test(text), `${rel} 不应引导搜索 plugin cache`);
    assert.ok(text.includes('<skill-root>/../../hooks/'), `${rel} 应给出 skill-root fallback`);
    if (rel.endsWith('SKILL.md')) {
      assert.ok(text.includes('这不是顺序执行清单'), `${rel} 应避免把 helper 模板误读为顺序脚本`);
    }
    for (const helper of helpers) {
      assert.ok(text.includes(`<skill-root>/../../hooks/${helper}`), `${rel} 应给出 ${helper} fallback`);
    }
  }
});

test('artifact-management skill 明确 record-correction reserve helper 用法', () => {
  const repoRoot = path.join(__dirname, '..');
  const text = fs.readFileSync(path.join(repoRoot, 'plugin/skills/artifact-management/SKILL.md'), 'utf8');
  assert.ok(text.includes('--operation record-correction'), 'artifact-management 应明确 correction 预留命令');
  assert.ok(text.includes('reserved-file-prefix'), 'artifact-management 应要求带 reserved-file-prefix');
});

test('skills lifecycle 示例不遗漏 target/task-id 且表格不断裂', () => {
  const repoRoot = path.join(__dirname, '..');
  const workflow = fs.readFileSync(path.join(repoRoot, 'plugin/skills/pace-workflow/SKILL.md'), 'utf8');
  assert.ok(!workflow.includes('update-chg section=work-record action=append'), 'work-record 示例必须带 target');
  assert.ok(!workflow.includes('skill base directory'), 'workflow skill 应统一使用中文“skill 根目录”');
  assert.ok(workflow.includes('继续、恢复或收口已有 CHG 前'), 'workflow skill 应提醒先读取 CHG 详情');
  assert.ok(workflow.includes('SessionStart 摘要只用于定位，不替代 CHG 详情'), 'workflow skill 应说明摘要不替代详情');

  const artifactManagement = fs.readFileSync(path.join(repoRoot, 'plugin/skills/artifact-management/SKILL.md'), 'utf8');
  assert.ok(artifactManagement.includes('继续、恢复或收口已有 CHG/HOTFIX 前'), 'artifact-management skill 应提醒先读取详情文件');
  assert.ok(artifactManagement.includes('SessionStart 摘要只用于定位，不替代详情文件'), 'artifact-management skill 应说明摘要不替代详情');

  const lifecycle = fs.readFileSync(path.join(repoRoot, 'plugin/skills/artifact-management/references/change-lifecycle.md'), 'utf8');
  assert.ok(lifecycle.includes('update-chg target=CHG-... section=tasks action=update-status task-id=T-NNN new-status=[!]'), '[!] 示例必须带 target/section/task-id/new-status');
  assert.ok(lifecycle.indexOf('| 取消 |') < lifecycle.indexOf('[ ] planned'), 'deferred 说明不应插入生命周期表格中间');

  const bridge = fs.readFileSync(path.join(repoRoot, 'plugin/skills/pace-bridge/SKILL.md'), 'utf8');
  assert.ok(!bridge.includes('skill base directory'), 'bridge skill 应统一使用中文“skill 根目录”');
});

test('artifact-writer prompt surface 覆盖 owner takeover 与 correction 字符口径', () => {
  const repoRoot = path.join(__dirname, '..');
  const writer = fs.readFileSync(path.join(repoRoot, 'plugin/agents/artifact-writer.md'), 'utf8');
  assert.ok(writer.includes('owner-takeover-confirmed: true'), 'artifact-writer 应提供 owner takeover 正向模板');
  assert.ok(writer.includes('owner-takeover-source: user-directive'));
  assert.ok(writer.includes('owner-takeover-evidence:'));
  assert.ok(!writer.includes('至少 20 字>'), 'record-correction 模板应统一为 20 字符');
});

test('artifact-writer create-chg 明确索引行边界与低成本验证口径', () => {
  const repoRoot = path.join(__dirname, '..');
  const createChg = fs.readFileSync(path.join(repoRoot, 'plugin/agent-references/instructions/create-chg.md'), 'utf8');
  const spec = fs.readFileSync(path.join(repoRoot, 'plugin/agent-references/artifact-writer-spec.md'), 'utf8');
  assert.ok(createChg.includes('索引插入契约'), 'create-chg 指令应给出正向索引插入契约');
  assert.ok(createChg.includes('新增索引行与上一行注释、标题或正文之间保留空行隔开'), 'create-chg 指令应正向覆盖行边界要求');
  assert.ok(createChg.includes('^- \\[[ x/!-]\\] \\[\\[(chg|hotfix)-YYYYMMDD-NN\\]\\]'), 'create-chg 验证应检查行首格式');
  assert.ok(spec.includes('索引行必须独占一行，并从行首 `- [` 开始'), '通用 spec 应明确机械索引格式');
});

test('pace-utils 子模块可直接 require 且导出关键符号', () => {
  const repoRoot = path.join(__dirname, '..');
  const modules = {
    constants: ['PACE_VERSION', 'ARTIFACT_FILES', 'FORMAT_SNIPPETS'],
    'line-endings': ['normalizeLineEndings', 'hasNonNullVerifiedDate'],
    session: ['parseHookStdin', 'currentSessionId', 'isArtifactWriterAgentType'],
    'path-utils': ['normalizePath', 'resolveToolFilePath', 'resolveEffectiveProjectRoot', 'getProjectRuntimeDir'],
    detection: ['hasChangesDir', 'legacyV5FilesInDir'],
    logger: ['createLogger', 'defaultLogPath', 'logEntry'],
    plans: [],
    'change-id': ['normalizeChangeId', 'detailPathForId', 'slugForChangeId'],
    'change-analysis': [],
    locks: [],
  };
  for (const [name, symbols] of Object.entries(modules)) {
    const mod = require(path.join(repoRoot, 'plugin', 'hooks', 'pace-utils', name));
    assert.ok(mod, `${name} should require`);
    for (const symbol of symbols) {
      assert.ok(Object.prototype.hasOwnProperty.call(mod, symbol), `${name} should export ${symbol}`);
    }
  }
});

test('record-finding type 枚举不混入 correction', () => {
  const repoRoot = path.join(__dirname, '..');
  const files = [
    'plugin/agent-references/artifact-writer-spec.md',
    'plugin/agent-references/instructions/record-finding.md',
    'plugin/skills/artifact-management/SKILL.md',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const recordFindingSection = text;
    assert.ok(recordFindingSection.includes('research | observation | comparison | bug-report'), `${rel} 应列出 finding type 枚举`);
    assert.ok(!/research \| observation \| comparison \| bug-report \| correction/.test(recordFindingSection), `${rel} 不应把 correction 混入 record-finding type`);
  }
});

test('用户 skills 显式链接现有 references 文档', () => {
  const repoRoot = path.join(__dirname, '..');
  const expectations = {
    'plugin/skills/pace-workflow/SKILL.md': ['references/superpowers-integration.md'],
    'plugin/skills/artifact-management/SKILL.md': ['references/format-reference.md', 'references/change-lifecycle.md'],
  };
  for (const [rel, refs] of Object.entries(expectations)) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const ref of refs) {
      assert.ok(text.includes(`](${ref})`), `${rel} 应显式链接 ${ref}`);
    }
  }
});

test('CLAUDE.md 不承载 PACEflow workflow 或个人回复风格', () => {
  const repoRoot = path.join(__dirname, '..');
  const inner = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
  const outerPath = path.join(repoRoot, '..', 'CLAUDE.md');
  const candidates = [['inner', inner]];
  if (fs.existsSync(outerPath)) {
    candidates.push(['outer', fs.readFileSync(outerPath, 'utf8')]);
  }
  for (const [label, text] of candidates) {
    assert.ok(!text.includes('🐱'), `${label} CLAUDE.md 不应包含个人固定结尾`);
    assert.ok(!text.includes('每条回复开头'), `${label} CLAUDE.md 不应包含个人时间戳规则`);
    assert.ok(!text.includes('v6.0.34'), `${label} CLAUDE.md 不应保留旧版本号`);
  }
  assert.ok(inner.includes('不承担 artifact 创建、批准、验证、归档'), 'inner CLAUDE.md 应说明 workflow 权威不在 CLAUDE.md');
  if (fs.existsSync(outerPath)) {
    assert.ok(fs.readFileSync(outerPath, 'utf8').includes('此父目录不定义 PACEflow 运行规则'), 'outer CLAUDE.md 应成为 redirect');
  }
});

test('plugin agents 显式列表有维护说明', () => {
  const repoRoot = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
  const contributing = fs.readFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
  assert.deepStrictEqual(manifest.agents, ['./agents/artifact-writer.md']);
  assert.ok(contributing.includes('plugin/.claude-plugin/plugin.json'), 'CONTRIBUTING 应提示新增 agent 同步 manifest');
});

test('artifact-management 不保留旧 implementation_plan 详情模板别名', () => {
  const repoRoot = path.join(__dirname, '..');
  assert.ok(!fs.existsSync(path.join(repoRoot, 'plugin/skills/artifact-management/templates/change-implementation_plan.md')));
});

test('spec.md project-summary 与 knowledge summary 语义分离', () => {
  const repoRoot = path.join(__dirname, '..');
  const specTemplate = fs.readFileSync(path.join(repoRoot, 'plugin/hooks/templates/spec.md'), 'utf8');
  const knowledge = fs.readFileSync(path.join(repoRoot, 'plugin/skills/pace-knowledge/SKILL.md'), 'utf8');
  assert.ok(specTemplate.includes('project-summary:'));
  assert.ok(!/^summary:/m.test(specTemplate));
  assert.ok(knowledge.includes('项目元描述'));
});

test('V7F-1: detectNewerSchemaData——8.0 活跃帧检出，7.0/6.0 不误报', () => {
  const dir = makeTmpDir('newer-schema-active');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'),
    '# 项目任务追踪\n\n## 活跃任务\n\n- [/] [[chg-20270101-01|chg-20270101-01]] 未来变更 #change\n\n<!-- ARCHIVE -->\n');
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20270101-01.md'),
    '---\nstatus: in-progress\nschema-version: "8.0"\n---\n\n## 任务清单\n\n- [/] T-001 x\n');
  const r = paceUtils.detectNewerSchemaData(dir);
  assert.strictEqual(r.detected, true, '8.0 帧（引号形态）应检出');
  assert.strictEqual(r.maxVersion, 8);
  // 7.0 帧不误报
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20270101-01.md'),
    '---\nstatus: in-progress\nschema-version: "7.0"\n---\n\n## 任务清单\n\n- [/] T-001 x\n');
  assert.strictEqual(paceUtils.detectNewerSchemaData(dir).detected, false, '7.0 帧不触发');
  // 6.0 存量不误报
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20270101-01.md'),
    '---\nstatus: in-progress\nschema-version: 6.0\n---\n\n## 任务清单\n\n- [/] T-001 x\n');
  assert.strictEqual(paceUtils.detectNewerSchemaData(dir).detected, false, '6.0 帧不触发');
});

test('V7F-2: detectNewerSchemaData——活跃区为空时补扫 changes/ 最近详情帧（未来索引格式不可解析场景）', () => {
  const dir = makeTmpDir('newer-schema-fallback');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  // 活跃区空（v8 可能改了索引行格式，v7 解析不出 entries）+ changes/ 内 8.0 帧
  fs.writeFileSync(path.join(dir, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n\n<!-- ARCHIVE -->\n');
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20270101-01-future.md'),
    '---\nstatus: in-progress\nschema-version: 8.0\n---\n\n正文\n');
  const r = paceUtils.detectNewerSchemaData(dir);
  assert.strictEqual(r.detected, true, '活跃区空时应补扫 changes/ 检出 8.0');
  // 全 7.0 时补扫不误报
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20270101-01-future.md'),
    '---\nstatus: archived\nschema-version: "7.0"\n---\n\n正文\n');
  assert.strictEqual(paceUtils.detectNewerSchemaData(dir).detected, false);
  // changes/ 不存在 → fail-open false
  const dir2 = makeTmpDir('newer-schema-nochanges');
  fs.writeFileSync(path.join(dir2, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n\n<!-- ARCHIVE -->\n');
  assert.strictEqual(paceUtils.detectNewerSchemaData(dir2).detected, false);
});

test('CHG-20260612-02: v5 迁移面退役锁——batch-archive-v5 与 MIGRATABLE 常量不得回潮', () => {
  const repoRoot = path.join(__dirname, '..');
  assert.ok(!fs.existsSync(path.join(repoRoot, 'plugin', 'migrate', 'batch-archive-v5.js')), 'batch-archive-v5.js 已退役，不应随发布面 ship');
  assert.strictEqual(paceUtils.MIGRATABLE_ARTIFACT_FILES, undefined, 'MIGRATABLE_ARTIFACT_FILES 已随 v5 迁移退役');
});

// ============================================================
// detailPathForId (slug glob) —— CHG-slug T-1
// ============================================================
console.log('\n--- detailPathForId (slug glob) ---');

test('detailPathForId：旧无 slug 文件 chg-id.md 命中', () => {
  const dir = makeTmpDir('dp-old');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260101-01.md'), '# old');
  assert.strictEqual(detailPathForId(dir, 'CHG-20260101-01'), path.join(dir, 'changes', 'chg-20260101-01.md'));
});

test('detailPathForId：新带 slug 文件 chg-id-slug.md 命中', () => {
  const dir = makeTmpDir('dp-slug');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260101-02-some-feature.md'), '# new');
  assert.strictEqual(detailPathForId(dir, 'CHG-20260101-02'), path.join(dir, 'changes', 'chg-20260101-02-some-feature.md'));
});

test('detailPathForId：精确优先于 glob（同时存在取精确无 slug）', () => {
  const dir = makeTmpDir('dp-both');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260101-03.md'), '# exact');
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260101-03-x.md'), '# slug');
  assert.strictEqual(detailPathForId(dir, 'CHG-20260101-03'), path.join(dir, 'changes', 'chg-20260101-03.md'));
});

test('detailPathForId：HOTFIX 带 slug 命中', () => {
  const dir = makeTmpDir('dp-hotfix');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes', 'hotfix-20260101-01-urgent-fix.md'), '# hf');
  assert.strictEqual(detailPathForId(dir, 'HOTFIX-20260101-01'), path.join(dir, 'changes', 'hotfix-20260101-01-urgent-fix.md'));
});

test('detailPathForId：文件不存在回退精确路径（fail-safe）', () => {
  const dir = makeTmpDir('dp-missing');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  assert.strictEqual(detailPathForId(dir, 'CHG-20260101-04'), path.join(dir, 'changes', 'chg-20260101-04.md'));
});

test('detailPathForId：非法 id 返回 null', () => {
  const dir = makeTmpDir('dp-bad');
  assert.strictEqual(detailPathForId(dir, 'not-an-id'), null);
});

// ============================================================
// V7A. v7 双文件合并——getActiveChangeEntries 单读 task.md（CHG-20260611-08 T-001）
// ============================================================
console.log('\n--- V7A: task.md 单索引 ---');

test('V7A-1: getActiveChangeEntries 只读 task.md，impl_plan 缺失不影响', () => {
  const dir = makeTmpDir('v7a-single-index');
  writeV6ChangeFixture(dir);
  fs.unlinkSync(path.join(dir, 'implementation_plan.md')); // 已迁移布局：impl_plan 不存在
  const entries = paceUtils.getActiveChangeEntries(dir);
  assert.strictEqual(entries.length, 1, 'V7A-1a: impl_plan 缺失时 entry 仍可见');
  assert.strictEqual(entries[0].taskCheckbox, '/', 'V7A-1b: taskCheckbox 正常');
  assert.ok(!('impl' in entries[0]) && !('implCheckbox' in entries[0]), 'V7A-1c: entry 不再含 impl 字段');
  const cls = paceUtils.classifyChange(entries[0]);
  assert.strictEqual(cls.category, 'running', 'V7A-1d: 单索引下 classify 正常 running');
  assert.ok(!('implCheckbox' in cls), 'V7A-1e: classified 对象不再含 implCheckbox');
});

test('V7A-2: task.md 同 ID 重复行按 Map 去重为单 entry（沿旧实现语义）', () => {
  const dir = makeTmpDir('v7a-dedupe');
  writeV6ChangeFixture(dir);
  const taskPath = path.join(dir, 'task.md');
  const dupLine = '- [/] [[chg-20260507-01]] 测试变更重复行 #change [tasks:: T-001]\n';
  fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace('<!-- ARCHIVE -->', `${dupLine}<!-- ARCHIVE -->`), 'utf8');
  const entries = paceUtils.getActiveChangeEntries(dir);
  assert.strictEqual(entries.length, 1, 'V7A-2: 重复行不裂成两个 entry');
});

test('V7A-6: task.md 写后 index:changes 锁直接释放（index-transaction 退役）', () => {
  const dir = makeTmpDir('v7a-lock-direct-release');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  const info = { sessionId: 'sid-v7a6', agentId: 'agent-v7a6' };
  const acq = paceUtils.acquireArtifactResourceLock(dir, 'index:changes', info);
  assert.ok(acq.acquired, 'V7A-6 前置：锁获取成功');
  const r = paceUtils.markIndexChangesTouchedAndMaybeRelease(dir, 'task.md', info);
  assert.strictEqual(r.released, true, 'V7A-6: task.md 单 touched 即释放，不再等 implementation_plan.md');
});

test('V7A-7: ARTIFACT_FILES 不含 impl_plan 但 PROTECTED_ARTIFACTS 显式保留（tombstone 保护）', () => {
  assert.ok(!paceUtils.ARTIFACT_FILES.includes('implementation_plan.md'), 'V7A-7a: ARTIFACT_FILES 已移除');
  assert.ok(paceUtils.PROTECTED_ARTIFACTS.includes('implementation_plan.md'), 'V7A-7b: PROTECTED 显式保留');
  assert.ok(!paceUtils.PROTECTED_ARTIFACTS.includes('spec.md'), 'V7A-7c: spec.md 仍不受保护');
  assert.ok(paceUtils.PROTECTED_ARTIFACTS.includes('task.md'), 'V7A-7d: task.md 受保护');
});

// ============================================================
// V7B. schema 封闭合同——validateFrontmatterSchema（CHG-20260611-09 T-001）
// ============================================================
console.log('\n--- V7B: schema 封闭合同 ---');

test('V7B-1: 7.0 CHG 帧完整合同通过（key 恒在 + 阶段必填非 null）', () => {
  const fm = { status: 'in-progress', date: '2026-06-11', 'change-set': 'null', 'change-set-seq': 'null',
    'verified-date': 'null', 'reviewed-date': 'null', 'archived-date': 'null',
    'parent-tasks': '["[[x/task|task]]"]', 'schema-version': '"7.0"' };
  const r = paceUtils.validateFrontmatterSchema('chg', 'in-progress', fm);
  assert.ok(r.ok, 'V7B-1: ' + JSON.stringify(r));
  assert.strictEqual(r.missing.length, 0);
  assert.strictEqual(r.unknown.length, 0);
});

test('V7B-2: 缺 key 报 missing-key；archived 缺 archived-date 值报 missing-value', () => {
  const base = { status: 'archived', date: '2026-06-11', 'change-set': 'null', 'change-set-seq': 'null',
    'verified-date': '2026-06-11T10:00:00+08:00', 'reviewed-date': '2026-06-11T10:00:00+08:00',
    'archived-date': 'null', 'parent-tasks': '["[[x/task|task]]"]', 'schema-version': '"7.0"' };
  const r1 = paceUtils.validateFrontmatterSchema('chg', 'archived', base);
  assert.ok(!r1.ok && r1.missing.includes('archived-date'), 'V7B-2a: archived 必填 archived-date 非 null');
  const { date, ...noDate } = base;
  const r2 = paceUtils.validateFrontmatterSchema('chg', 'archived', { ...noDate, 'archived-date': '2026-06-11T10:00:00+08:00' });
  assert.ok(!r2.ok && r2.missing.some(m => m.includes('date')), 'V7B-2b: 缺 date key 报 missing');
});

test('V7B-3: 多余 key 报 unknown（aliases 复发场景）', () => {
  const fm = { status: 'in-progress', date: '2026-06-11', 'change-set': 'null', 'change-set-seq': 'null',
    'verified-date': 'null', 'reviewed-date': 'null', 'archived-date': 'null',
    'parent-tasks': '["[[x/task|task]]"]', 'schema-version': '"7.0"', aliases: '[]' };
  const r = paceUtils.validateFrontmatterSchema('chg', 'in-progress', fm);
  assert.ok(!r.ok && r.unknown.includes('aliases'), 'V7B-3: 封闭合同拒绝多余字段');
});

test('V7B-4: 6.0 文件跳过校验（合同只对 7.0 生效）', () => {
  const fm = { 'chg-id': 'CHG-20260611-01', status: 'in-progress', aliases: '[]', 'schema-version': '"6.0"' };
  const r = paceUtils.validateFrontmatterSchema('chg', 'in-progress', fm);
  assert.ok(r.ok && r.skipped === 'non-7.0', 'V7B-4: 6.0 存量零误报');
});

test('V7B-5: finding/correction kind 各自合同', () => {
  const fOk = paceUtils.validateFrontmatterSchema('finding', 'open',
    { status: 'open', date: '2026-06-11', 'schema-version': '"7.0"' });
  assert.ok(fOk.ok, 'V7B-5a: finding 三字段合同通过');
  const fBad = paceUtils.validateFrontmatterSchema('finding', 'open',
    { status: 'open', date: '2026-06-11', 'schema-version': '"7.0"', impact: 'P1' });
  assert.ok(!fBad.ok && fBad.unknown.includes('impact'), 'V7B-5b: finding 帧 impact 已删（索引行权威）');
  const cOk = paceUtils.validateFrontmatterSchema('correction', '',
    { date: '2026-06-11', 'schema-version': '"7.0"' });
  assert.ok(cOk.ok, 'V7B-5c: correction 两字段合同通过');
  const cBad = paceUtils.validateFrontmatterSchema('correction', '',
    { date: '2026-06-11', 'schema-version': '"7.0"', 'trigger-quote': 'x' });
  assert.ok(!cBad.ok && cBad.unknown.includes('trigger-quote'), 'V7B-5d: correction 五文本字段降正文单源');
  const unknownKind = paceUtils.validateFrontmatterSchema('other', '', { 'schema-version': '"7.0"' });
  assert.ok(unknownKind.ok, 'V7B-5e: 未知 kind 不校验');
});

test('V7B-8: status 枚举校验——typo/未知 status 不退化 base-only（CHG-20260614-03 T-001）', () => {
  const chgFrame = (status) => ({ status, date: '2026-06-11', 'change-set': 'null', 'change-set-seq': 'null',
    'verified-date': 'null', 'reviewed-date': 'null', 'archived-date': 'null',
    'parent-tasks': '["[[x/task|task]]"]', 'schema-version': '"7.0"' });
  // typo 'archive'（漏 d）：旧行为 spec[st]=undefined 退化 base-only、archived-date 不必填、全 null 通过；新行为枚举 deny
  const typo = paceUtils.validateFrontmatterSchema('chg', 'archive', chgFrame('archive'));
  assert.ok(!typo.ok, 'V7B-8a: typo status archive 应 deny');
  assert.ok(typo.missing.some(m => /unknown-value/.test(m)), 'V7B-8b: 报 status unknown-value：' + JSON.stringify(typo.missing));
  // 合法 chg status 全部不误伤（反向）
  for (const s of ['planned', 'in-progress', 'completed']) {
    assert.ok(paceUtils.validateFrontmatterSchema('chg', s, chgFrame(s)).ok, `V7B-8c: 合法 chg status ${s} 放行`);
  }
  // finding typo + 合法
  const fTypo = paceUtils.validateFrontmatterSchema('finding', 'acepted', { status: 'acepted', date: '2026-06-11', 'schema-version': '"7.0"' });
  assert.ok(!fTypo.ok && fTypo.missing.some(m => /unknown-value/.test(m)), 'V7B-8d: finding typo status deny');
  for (const s of ['open', 'investigating', 'accepted', 'rejected', 'merged', 'blocked']) {
    assert.ok(paceUtils.validateFrontmatterSchema('finding', s, { status: s, date: '2026-06-11', 'schema-version': '"7.0"' }).ok, `V7B-8e: 合法 finding status ${s} 放行`);
  }
  // correction 无 status 字段——不受枚举影响（回归）
  assert.ok(paceUtils.validateFrontmatterSchema('correction', '', { date: '2026-06-11', 'schema-version': '"7.0"' }).ok, 'V7B-8f: correction 无 status 不受枚举校验');
});

test('V7G-4: hasNonNull*Date 对齐 parseFrontmatter——无 whole-doc fallback + 块内 last-wins（CHG-20260614-03 T-002）', () => {
  // 重复 key（首真次 null）：last-wins → null → false（与 parseFrontmatter 一致）
  const dup = '---\nverified-date: 2026-06-14T10:00:00+08:00\nverified-date: null\n---\n\n正文\n';
  assert.strictEqual(paceUtils.hasNonNullVerifiedDate(dup), false, '重复 verified-date last-wins 取 null → false');
  assert.strictEqual(parseFrontmatter(dup)['verified-date'], 'null', '与 parseFrontmatter last-wins 一致');
  // verified-date 只在正文（无 frontmatter）：无 whole-doc fallback → false
  assert.strictEqual(paceUtils.hasNonNullVerifiedDate('# 标题\n\nverified-date: 2026-06-14T10:00:00+08:00\n'), false, '正文 verified-date 不触发 whole-doc fallback');
  // frontmatter 前有空行（非文首）：parseFrontmatter 返回 {} → hasNonNull 也 false
  assert.strictEqual(paceUtils.hasNonNullVerifiedDate('\n---\nverified-date: 2026-06-14T10:00:00+08:00\n---\n'), false, '非文首 frontmatter 与 parseFrontmatter 一致返 false');
  // 反向回归：正常 frontmatter 有效 → true（不过度修正）
  const ok = '---\nverified-date: 2026-06-14T10:00:00+08:00\nreviewed-date: 2026-06-14T11:00:00+08:00\n---\n';
  assert.strictEqual(paceUtils.hasNonNullVerifiedDate(ok), true, '正常 verified-date → true');
  assert.strictEqual(paceUtils.hasNonNullReviewedDate(ok), true, '正常 reviewed-date → true');
  assert.strictEqual(paceUtils.hasNonNullVerifiedDate('---\nverified-date: null\n---\n'), false, 'null → false');
});

test('V7B-6: archived 帧必须三 date 齐全（R-06a 对齐 spec §4.1 状态机表）；cancelled 豁免', () => {
  const full = { status: 'archived', date: '2026-06-11', 'change-set': 'null', 'change-set-seq': 'null',
    'verified-date': '2026-06-11T10:00:00+08:00', 'reviewed-date': '2026-06-11T10:00:00+08:00',
    'archived-date': '2026-06-11T10:00:00+08:00', 'parent-tasks': '["[[x/task|task]]"]', 'schema-version': '"7.0"' };
  assert.ok(paceUtils.validateFrontmatterSchema('chg', 'archived', full).ok, 'V7B-6a: 三 date 齐全的 archived 通过');
  const rV = paceUtils.validateFrontmatterSchema('chg', 'archived', { ...full, 'verified-date': 'null' });
  assert.ok(!rV.ok && rV.missing.includes('verified-date'), 'V7B-6b: archived 缺 verified-date 值报 missing');
  const rR = paceUtils.validateFrontmatterSchema('chg', 'archived', { ...full, 'reviewed-date': 'null' });
  assert.ok(!rR.ok && rR.missing.includes('reviewed-date'), 'V7B-6c: archived 缺 reviewed-date 值报 missing');
  // cancelled 帧不验证不审计（spec §4.1）：verified/reviewed-date 为 null 仍通过
  const cancelled = { ...full, status: 'cancelled', 'verified-date': 'null', 'reviewed-date': 'null' };
  assert.ok(paceUtils.validateFrontmatterSchema('chg', 'cancelled', cancelled).ok, 'V7B-6d: cancelled 帧 verified/reviewed null 豁免');
  // 6.0 archived 帧整体跳过（零误报回归）
  const v6 = { status: 'archived', 'schema-version': '"6.0"', 'verified-date': 'null', 'reviewed-date': 'null' };
  assert.strictEqual(paceUtils.validateFrontmatterSchema('chg', 'archived', v6).skipped, 'non-7.0', 'V7B-6e: 6.0 archived 零误报');
});

test('V7B-7: change-set / change-set-seq 成对不变量（R-11：半空对报 violation）', () => {
  const base = { status: 'in-progress', date: '2026-06-11',
    'verified-date': 'null', 'reviewed-date': 'null', 'archived-date': 'null',
    'parent-tasks': '["[[x/task|task]]"]', 'schema-version': '"7.0"' };
  assert.ok(paceUtils.validateFrontmatterSchema('chg', 'in-progress',
    { ...base, 'change-set': 'null', 'change-set-seq': 'null' }).ok, 'V7B-7a: 双 null 单 CHG 通过');
  assert.ok(paceUtils.validateFrontmatterSchema('chg', 'in-progress',
    { ...base, 'change-set': 'wave3', 'change-set-seq': '"1/2"' }).ok, 'V7B-7b: 双非 null batch 成员通过');
  const rA = paceUtils.validateFrontmatterSchema('chg', 'in-progress',
    { ...base, 'change-set': 'wave3', 'change-set-seq': 'null' });
  assert.ok(!rA.ok && rA.missing.some(m => m.includes('change-set-seq')), 'V7B-7c: 半空对（有 change-set 缺 seq）报 violation');
  const rB = paceUtils.validateFrontmatterSchema('chg', 'in-progress',
    { ...base, 'change-set': 'null', 'change-set-seq': '"1/2"' });
  assert.ok(!rB.ok && rB.missing.some(m => m.includes('change-set') && !m.includes('seq')), 'V7B-7d: 半空对（缺 change-set 有 seq）报 violation');
  const v6 = { ...base, 'schema-version': '"6.0"', 'change-set': 'wave3', 'change-set-seq': 'null' };
  assert.strictEqual(paceUtils.validateFrontmatterSchema('chg', 'in-progress', v6).skipped, 'non-7.0', 'V7B-7e: 6.0 半空对零误报');
});

// ============================================================
// V7C. 发布面模板与 7.0 合同一致性（CHG-20260611-10 T-003）
// ============================================================
console.log('\n--- V7C: 模板合同一致性 ---');

test('V7C-1: templates 三模板帧全部通过 7.0 封闭合同', () => {
  const repoRoot = path.join(__dirname, '..');
  const cases = [
    { rel: 'plugin/skills/artifact-management/templates/change-detail.md', kind: 'chg', status: 'planned' },
    { rel: 'plugin/skills/artifact-management/templates/finding-detail.md', kind: 'finding', status: 'open' },
    { rel: 'plugin/skills/artifact-management/templates/correction-detail.md', kind: 'correction', status: '' },
  ];
  for (const c of cases) {
    const text = fs.readFileSync(path.join(repoRoot, c.rel), 'utf8');
    // 模板正文里嵌在 ```markdown 代码块中的帧——取第一个 --- ... --- 块
    const m = text.match(/^---\n([\s\S]*?)\n---/m);
    assert.ok(m, `${c.rel} 应含 frontmatter 模板块`);
    const fm = paceUtils.parseFrontmatter(`---\n${m[1]}\n---`);
    // 模板占位日期（YYYY-MM-DD）对合同无碍（只查非空），placeholder 仍是合法值
    const r = paceUtils.validateFrontmatterSchema(c.kind, c.status, fm);
    assert.ok(r.ok, `V7C-1 ${c.rel}: ${JSON.stringify(r)}`);
  }
});

test('V7C-2: spec §2.1 yaml 块与 SCHEMA_V7_KEYS 字段集一致（规格-代码互锁雏形）', () => {
  const repoRoot = path.join(__dirname, '..');
  const spec = fs.readFileSync(path.join(repoRoot, 'plugin/agent-references/artifact-writer-spec.md'), 'utf8');
  const yamlBlock = spec.match(/### 2\.1 CHG\/HOTFIX\n\n```yaml\n([\s\S]*?)```/);
  assert.ok(yamlBlock, 'spec §2.1 应含 yaml 模板块');
  const keys = yamlBlock[1].split('\n').map(l => (l.match(/^([a-z-]+):/) || [])[1]).filter(Boolean);
  const expected = paceUtils.SCHEMA_V7_KEYS.chg;  // R-42：引用代码常量而非第三份硬编码拷贝
  assert.deepStrictEqual(keys.sort(), [...expected].sort(), 'V7C-2: spec yaml 字段集 = 代码合同字段集');
});

// ============================================================
// V7D: 规范单源化一致性锁（CHG-20260611-11 T-002）
// A1 类漂移（多份拷贝人肉同步漏改）从靠运气变为漏改即红灯。
// ============================================================

// 提取一段平铺字段文本（prompt 模板 / ```text 块）的行首字段名集合
function promptFieldNames(text) {
  return text.split('\n').map((l) => (l.match(/^([a-z][a-z-]*):/) || [])[1]).filter(Boolean);
}

test('V7D-1: agent.md close-chg 必填字段清单 ⊇ guard 实际校验集', () => {
  const repoRoot = path.join(__dirname, '..');
  const guardSrc = fs.readFileSync(path.join(repoRoot, 'plugin/hooks/pre-tool-use/agent-lifecycle-guard.js'), 'utf8');
  const block = guardSrc.match(/if \(mentionsCloseChg\) \{([\s\S]*?)if \(missing\.length/);
  assert.ok(block, 'guard 应含 mentionsCloseChg 必填校验块');
  const guardFields = [...block[1].matchAll(/missing\.push\('([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(guardFields.length >= 8, `guard close-chg 校验集应 ≥ 8 字段，实际 ${guardFields.length}`);

  const agentMd = fs.readFileSync(path.join(repoRoot, 'plugin/agents/artifact-writer.md'), 'utf8');
  const section = agentMd.match(/### 4\. close-chg\n([\s\S]*?)\n### /);
  assert.ok(section, 'agent.md 应含 close-chg 指令段');
  const agentFields = new Set([...section[1].matchAll(/`([a-z-]+)(?:: true)?`/g)].map((m) => m[1]));
  for (const f of guardFields) {
    assert.ok(agentFields.has(f), `V7D-1: guard 校验字段 ${f} 必须出现在 agent.md close-chg 必填清单`);
  }
});

test('V7D-2: guard deny 文案模板字段集 = 对应 instruction 模板字段集', () => {
  const repoRoot = path.join(__dirname, '..');
  const guard = require(path.join(repoRoot, 'plugin/hooks/pre-tool-use/agent-lifecycle-guard.js'));
  const readInstr = (name) => fs.readFileSync(path.join(repoRoot, 'plugin/agent-references/instructions', name), 'utf8');
  const textBlocks = (md) => [...md.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]);

  // 单模板 instruction：第一个 ```text 块即派遣模板
  const single = [
    ['create-chg.md', { operation: 'create-chg' }],
    ['close-chg.md', { operation: 'close-chg' }],
    ['archive-chg.md', { operation: 'archive-chg' }],
    ['record-finding.md', { operation: 'record-finding' }],
    ['record-correction.md', { operation: 'record-correction' }],
    ['update-finding.md', { operation: 'update-finding' }],
  ];
  for (const [file, opts] of single) {
    const tplFields = promptFieldNames(guard.promptTemplateForOperation(opts)).sort();
    const blocks = textBlocks(readInstr(file));
    assert.ok(blocks.length > 0, `${file} 应含 \`\`\`text 模板块`);
    const instrFields = promptFieldNames(blocks[0]).sort();
    assert.deepStrictEqual(instrFields, tplFields, `V7D-2: ${file} 模板字段集应与 guard deny 文案一致`);
  }

  // update-chg 多 action：按块内 action 值与 guard 模板逐一对位
  const updateBlocks = textBlocks(readInstr('update-chg.md'));
  for (const action of ['approve', 'approve-and-start', 'update-status', 'verify', 'review']) {
    const block = updateBlocks.find((b) => new RegExp(`^action: ${action}$`, 'm').test(b));
    assert.ok(block, `update-chg.md 应含 action=${action} 的模板块`);
    const tplFields = promptFieldNames(guard.promptTemplateForOperation({ operation: 'update-chg', action })).sort();
    const instrFields = promptFieldNames(block).sort();
    assert.deepStrictEqual(instrFields, tplFields, `V7D-2: update-chg action=${action} 模板字段集应与 guard deny 文案一致`);
  }
});

test('V7D-4: agent.md 正向模板块字段集 = guard deny 文案字段集（R-25：agent.md 模板纳入锁，close-chg implementation-notes 漂移即红）', () => {
  const repoRoot = path.join(__dirname, '..');
  const guard = require(path.join(repoRoot, 'plugin/hooks/pre-tool-use/agent-lifecycle-guard.js'));
  const agentMd = fs.readFileSync(path.join(repoRoot, 'plugin/agents/artifact-writer.md'), 'utf8');
  // 提取 agent.md 「正向输入模板」段的 ### <title> 后 ```text 块（区别于 V7D-1 锁的「输入字段速查」编号小节）
  const agentBlock = (title) => {
    const m = agentMd.match(new RegExp('### ' + title + '\\n+```text\\n([\\s\\S]*?)```'));
    return m ? m[1] : null;
  };
  const ops = [
    ['close-chg', { operation: 'close-chg' }],
    ['create-chg', { operation: 'create-chg' }],
    ['archive-chg', { operation: 'archive-chg' }],
    ['record-finding', { operation: 'record-finding' }],
    ['record-correction', { operation: 'record-correction' }],
    ['update-finding', { operation: 'update-finding' }],
  ];
  for (const [title, opts] of ops) {
    const block = agentBlock(title);
    assert.ok(block, `agent.md 应含 ### ${title} 正向模板块`);
    const agentFields = promptFieldNames(block).sort();
    const tplFields = promptFieldNames(guard.promptTemplateForOperation(opts)).sort();
    assert.deepStrictEqual(agentFields, tplFields, `V7D-4: agent.md ${title} 正向模板字段集应与 guard deny 文案一致（漂移即红）`);
  }
});

test('V7D-3: spec schema-keys 机器注释行 = SCHEMA_V7_KEYS 代码字面量', () => {
  const repoRoot = path.join(__dirname, '..');
  const spec = fs.readFileSync(path.join(repoRoot, 'plugin/agent-references/artifact-writer-spec.md'), 'utf8');
  const comment = spec.match(/<!-- schema-keys: chg = ([a-z,-]+) \| finding = ([a-z,-]+) \| correction = ([a-z,-]+) -->/);
  assert.ok(comment, 'spec 应含 schema-keys 机器可读注释行');

  const src = fs.readFileSync(path.join(repoRoot, 'plugin/hooks/pace-utils/change-analysis.js'), 'utf8');
  const codeBlock = src.match(/const SCHEMA_V7_KEYS = \{([\s\S]*?)\};/);
  assert.ok(codeBlock, 'change-analysis.js 应含 SCHEMA_V7_KEYS 字面量');
  const codeKeys = (kind) => {
    const m = codeBlock[1].match(new RegExp(`${kind}: \\[([^\\]]+)\\]`));
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  };

  assert.deepStrictEqual(comment[1].split(','), codeKeys('chg'), 'V7D-3: chg 字段集与顺序一致');
  assert.deepStrictEqual(comment[2].split(','), codeKeys('finding'), 'V7D-3: finding 字段集与顺序一致');
  assert.deepStrictEqual(comment[3].split(','), codeKeys('correction'), 'V7D-3: correction 字段集与顺序一致');
});

// ============================================================
// 汇总 + 清理
// ============================================================
t.cleanup();

const total = t.passed + t.failed;
console.log(`\n${t.failed === 0 ? '\u2705' : '\u274c'} ${t.passed}/${total} tests passed`);
if (t.failed > 0) process.exit(1);
