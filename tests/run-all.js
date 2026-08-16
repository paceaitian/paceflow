#!/usr/bin/env node
// run-all.js — 核心测试套件聚合 runner（CHG-20260614-07）
// 用途：一条命令串起全部核心套件 + plugin validate + git diff --check，
// 任一子套件非零退出即整体非零退出，杜绝「手敲漏跑某套件→回归静默漏网」。
// 设计：每个 suite 是独立子进程（execFileSync），退出码忠实透传；
// runSuites 接受任意 suite 列表便于自测（tests/test-run-all.js 喂 fake 子命令验证传播）。

const path = require('path');
const { execFileSync } = require('child_process');

// 纯函数：给定 upstream 与 releaseBase，决定要跑 `git diff --check <range>` 的区间列表（工作树未提交
// diff 总是先单独跑、不在此列）。抽出便于自测「PACE_RELEASE_BASE 置位增区间、未置位行为不变」而不 shell
// out git。upstream 区间 catch 已提交未推送的 whitespace；releaseBase 区间 catch post-push/远端干净检出
// 场景——push 后 @{upstream}..HEAD=0，upstream 区间查不到已推送的整段 release whitespace（codex v7.2.5 #3）。
function whitespaceCheckRanges(upstream, releaseBase) {
  const ranges = [];
  if (upstream) ranges.push(`${upstream}..HEAD`);
  const base = releaseBase ? String(releaseBase).trim() : '';
  if (base) ranges.push(`${base}..HEAD`);
  return ranges;
}

// git whitespace 检查：工作树未提交改动 + 已提交未推送区间（@{upstream}..HEAD）+ 可选 release 区间
// （PACE_RELEASE_BASE..HEAD）。区间集中由 whitespaceCheckRanges 决定；无 upstream 跟踪时跳过 upstream 区间。
// 发布流程用 `PACE_RELEASE_BASE=<上版 commit> node tests/run-all.js` 显式覆盖整段 release 区间。
// 任一 whitespace 错误 → execFileSync 抛错 → runSuites 判失败。
function gitWhitespaceCheck(cwd) {
  execFileSync('git', ['diff', '--check'], { cwd, stdio: 'pipe' });
  let upstream = null;
  try { upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd, stdio: 'pipe' }).toString().trim(); }
  catch (e) { upstream = null; }
  for (const range of whitespaceCheckRanges(upstream, process.env.PACE_RELEASE_BASE)) {
    execFileSync('git', ['diff', '--check', range], { cwd, stdio: 'pipe' });
  }
  return true;
}

// 核心套件清单。run-all-self 是聚合器自测，喂 fake 子命令、不递归跑 run-all 本身。
const SUITES = [
  { name: 'pace-utils', cmd: process.execPath, args: ['tests/test-pace-utils.js'] },
  { name: 'hooks-e2e', cmd: process.execPath, args: ['tests/test-hooks-e2e.js'] },
  { name: 'session-layers', cmd: process.execPath, args: ['tests/test-session-layers.js'] },
  { name: 'migrate-v7', cmd: process.execPath, args: ['tests/test-migrate-v7.js'] },
  { name: 'agent-helpers', cmd: process.execPath, args: ['tests/test-agent-tests-helpers.js'] },
  // CHG-20260815-04：Codex 宿主适配层与 MCP artifact server（纯 Node spawn process.execPath，无 shell shim / PATHEXT 雷区）
  { name: 'codex-adapter', cmd: process.execPath, args: ['tests/test-codex-adapter.js'] },
  { name: 'mcp-server', cmd: process.execPath, args: ['tests/test-mcp-server.js'] },
  { name: 'run-all-self', cmd: process.execPath, args: ['tests/test-run-all.js'] },
  // Windows：claude 经 npm 全局装为 claude.cmd shim，execFileSync 不走 PATHEXT 解析（且新版 Node 出于安全
  // 禁止无 shell 直跑 .cmd）→ ENOENT 瞬挂。shell:true 让 cmd.exe 经 PATHEXT 解析 claude.cmd。POSIX 保持 shell:false。
  { name: 'plugin-validate', cmd: 'claude', args: ['plugin', 'validate', './plugin'], shell: process.platform === 'win32' },
  { name: 'git-diff-check', run: gitWhitespaceCheck },
];

/**
 * 按子串筛选套件（供 PACE_TEST_FILTER 分片）。空值返回全部，不做静默清空。
 * @param {Array} suites - 套件清单
 * @param {string} filter - 名字子串
 * @returns {Array} 命中的套件
 */
function filterSuites(suites, filter) {
  if (!filter) return suites;
  return suites.filter((s) => s.name.includes(filter));
}

/**
 * 顺序运行每个套件，忠实透传退出码。任一非零即整体 exitCode=1。
 * @param {Array} suites - 套件清单
 * @param {{cwd?: string, quiet?: boolean}} opts - quiet 时吞子进程输出（自测用）
 * @returns {{results: Array<{name,ok,ms}>, exitCode: number}}
 */
function runSuites(suites, opts = {}) {
  const cwd = opts.cwd || path.join(__dirname, '..');
  const quiet = !!opts.quiet;
  const results = [];
  for (const s of suites) {
    const t0 = Date.now();
    let ok = true;
    try {
      if (typeof s.run === 'function') {
        ok = s.run(cwd, quiet) !== false; // run 函数：返回 false 或抛错即失败（如 git-diff-check 区间检查）
      } else {
        execFileSync(s.cmd, s.args, { cwd, stdio: quiet ? 'pipe' : 'inherit', shell: s.shell });
      }
    } catch (e) {
      ok = false; // 子进程非零退出 / run 抛错 / 命令不存在 → 标记失败，继续跑完其余套件
    }
    const ms = Date.now() - t0;
    results.push({ name: s.name, ok, ms });
    if (!quiet) console.log(`  ${ok ? '✅' : '❌'} ${s.name} (${ms}ms)`);
  }
  const failed = results.filter((r) => !r.ok);
  return { results, exitCode: failed.length > 0 ? 1 : 0 };
}

if (require.main === module) {
  const filter = process.env.PACE_TEST_FILTER || '';
  const suites = filterSuites(SUITES, filter);
  if (filter) console.log(`PACE_TEST_FILTER="${filter}" → ${suites.length}/${SUITES.length} 套件`);
  const { results, exitCode } = runSuites(suites);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${exitCode === 0 ? '✅' : '❌'} run-all: ${passed}/${results.length} 套件通过`);
  if (exitCode !== 0) {
    console.log('失败套件: ' + results.filter((r) => !r.ok).map((r) => r.name).join(', '));
  }
  process.exit(exitCode);
}

module.exports = { runSuites, filterSuites, SUITES, whitespaceCheckRanges };
