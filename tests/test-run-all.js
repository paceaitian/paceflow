// test-run-all.js — run-all 聚合 runner 自测（CHG-20260614-07 T-001）
// 黑盒：用 fake 子命令喂 runSuites，断言退出码透传与清单装配，
// 不实际跑 5 个核心套件（避免递归与耗时），只验证聚合器逻辑本身。

const assert = require('assert');
const { createTestRunner } = require('./test-utils');
const t = createTestRunner('run-all-test');
const { test } = t;

const FAKE_PASS = { name: 'fake-pass', cmd: process.execPath, args: ['-e', 'process.exit(0)'] };
const FAKE_FAIL = { name: 'fake-fail', cmd: process.execPath, args: ['-e', 'process.exit(1)'] };

test('RUN-1: 任一子套件失败 → 整体 exitCode 1 且失败项标记 ok=false', () => {
  const { runSuites } = require('./run-all');
  const { exitCode, results } = runSuites([FAKE_PASS, FAKE_FAIL], { quiet: true });
  assert.strictEqual(exitCode, 1, '有失败套件时 exitCode 必须为 1');
  assert.strictEqual(results.find(r => r.name === 'fake-fail').ok, false, '失败套件 ok=false');
  assert.strictEqual(results.find(r => r.name === 'fake-pass').ok, true, '通过套件 ok=true');
});

test('RUN-2: 全部子套件通过 → 整体 exitCode 0', () => {
  const { runSuites } = require('./run-all');
  const { exitCode } = runSuites([FAKE_PASS, { name: 'fake-pass-2', cmd: process.execPath, args: ['-e', '0'] }], { quiet: true });
  assert.strictEqual(exitCode, 0, '全通过时 exitCode 必须为 0');
});

test('RUN-3: SUITES 清单含 7 个核心套件（含 CHG-20260815-04 挂入的 codex-adapter / mcp-server）+ plugin-validate + git-diff-check', () => {
  const { SUITES } = require('./run-all');
  const names = SUITES.map((s) => s.name);
  for (const core of ['pace-utils', 'hooks-e2e', 'session-layers', 'migrate-v7', 'agent-helpers', 'codex-adapter', 'mcp-server']) {
    assert.ok(names.includes(core), `SUITES 应含核心套件 ${core}`);
  }
  assert.ok(names.includes('plugin-validate'), 'SUITES 应含 plugin-validate');
  assert.ok(names.includes('git-diff-check'), 'SUITES 应含 git-diff-check');
});

test('RUN-4: PACE_TEST_FILTER 按名子串筛选，空值返回全部', () => {
  const { filterSuites, SUITES } = require('./run-all');
  const filtered = filterSuites(SUITES, 'migrate');
  assert.strictEqual(filtered.length, 1, 'migrate 子串只匹配 migrate-v7');
  assert.strictEqual(filtered[0].name, 'migrate-v7');
  assert.strictEqual(filterSuites(SUITES, '').length, SUITES.length, '空 filter 返回全部套件');
});

test('RUN-5: runSuites 支持 run 函数条目（git-diff-check 区间检查改用 fn，CHG-20260614-16）', () => {
  const { runSuites } = require('./run-all');
  const { exitCode, results } = runSuites([
    { name: 'fn-pass', run: () => true },
    { name: 'fn-fail', run: () => false },
    { name: 'fn-throw', run: () => { throw new Error('whitespace error'); } },
  ], { quiet: true });
  assert.strictEqual(exitCode, 1, 'run 返回 false 或抛错应使整体非零');
  assert.strictEqual(results.find((r) => r.name === 'fn-pass').ok, true, 'run 返回 true → ok');
  assert.strictEqual(results.find((r) => r.name === 'fn-fail').ok, false, 'run 返回 false → ok=false');
  assert.strictEqual(results.find((r) => r.name === 'fn-throw').ok, false, 'run 抛错（whitespace 检查失败）→ ok=false');
});

test('RUN-6: whitespaceCheckRanges——PACE_RELEASE_BASE 置位增 base..HEAD 区间，未置位行为不变（codex v7.2.5 #3）', () => {
  const { whitespaceCheckRanges } = require('./run-all');
  // 无 upstream 无 base → 空区间列表（只跑工作树 diff，不在此列）
  assert.deepStrictEqual(whitespaceCheckRanges(null, ''), []);
  // 有 upstream 无 base → 仅 upstream 区间（原行为完全不变）
  assert.deepStrictEqual(whitespaceCheckRanges('origin/master', ''), ['origin/master..HEAD']);
  // 有 upstream + base → 两区间（base 区间附加，不替换 upstream）
  assert.deepStrictEqual(whitespaceCheckRanges('origin/master', '1deccc4'), ['origin/master..HEAD', '1deccc4..HEAD']);
  // post-push 兜底核心：upstream 区间为空/缺时 base 仍单独生效（@{upstream}..HEAD=0 漏检 release 区间的根治）
  assert.deepStrictEqual(whitespaceCheckRanges(null, '1deccc4'), ['1deccc4..HEAD']);
  // base 前后空格被 trim
  assert.deepStrictEqual(whitespaceCheckRanges(null, '  1deccc4  '), ['1deccc4..HEAD']);
});

t.cleanup();
const total = t.passed + t.failed;
console.log(`\n${t.failed === 0 ? '✅' : '❌'} ${t.passed}/${total} tests passed`);
if (t.failed > 0) process.exit(1);
