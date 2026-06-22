#!/usr/bin/env node
/**
 * run-tests.js — Phase A-D 测试运行器
 *
 * 由于 Claude Code Agent tool 仅在主 session 内可用，本 runner 采用半自动模式：
 *   - prepare 子命令：setup fixture + 打印 agent prompt（主 session 拷贝去派遣）
 *   - verify 子命令：主 session 派遣完拿到 agent 报告后，喂给 runner 验证 + 生成报告
 *   - dummy 子命令：用 mock agent 报告跑通 verify 链路，自测框架本身
 *
 * 用法：
 *   node run-tests.js list [phase]                 # 列出用例（默认 phase-a）
 *   node run-tests.js prepare <yaml-path> [--mode harness|production] [--prompt-file <path>]
 *                                                    # setup + 打印 prompt
 *   node run-tests.js verify <yaml-path> [json]    # 验证（json 文件路径 或 stdin）
 *   node run-tests.js teardown <yaml-path>         # 清理 fixture
 *   node run-tests.js dummy                        # 自测框架
 */

const fs = require('fs');
const path = require('path');
const runner = require('./helpers/subagent-runner');

const ROOT = __dirname;
const CASES_DIR = path.join(ROOT, 'cases');

function listCases(phase) {
  const dir = phase ? path.join(CASES_DIR, phase) : path.join(CASES_DIR, 'phase-a');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(dir, f));
}

function cmdList(phase) {
  const cases = listCases(phase);
  if (cases.length === 0) {
    console.log(`(no cases under ${phase || 'phase-a'})`);
    return;
  }
  for (const c of cases) {
    const tc = runner.loadYaml(c);
    console.log(`${tc.id}\t${tc.indication}\t${path.relative(ROOT, c)}`);
  }
}

function parsePrepareOptions(args) {
  let promptMode = 'harness';
  let promptFile = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--production' || arg === 'production') {
      promptMode = 'production';
    } else if (arg === '--harness' || arg === 'harness') {
      promptMode = 'harness';
    } else if (arg === '--mode' && args[i + 1]) {
      promptMode = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--mode=')) {
      promptMode = arg.slice('--mode='.length);
    } else if (arg === '--prompt-file' && args[i + 1]) {
      promptFile = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--prompt-file=')) {
      promptFile = arg.slice('--prompt-file='.length);
    }
  }
  if (!['harness', 'production'].includes(promptMode)) {
    console.error(`Unknown prompt mode: ${promptMode}`);
    process.exit(2);
  }
  return { promptMode, promptFile };
}

function cmdPrepare(yamlPath, ...prepareArgs) {
  const options = parsePrepareOptions(prepareArgs);
  const ctx = runner.prepare(yamlPath, options);
  if (options.promptFile) {
    fs.mkdirSync(path.dirname(path.resolve(options.promptFile)), { recursive: true });
    fs.writeFileSync(options.promptFile, ctx.agentPrompt, 'utf8');
  }
  console.log('═'.repeat(70));
  console.log(`已准备：${ctx.testCase.id}  →  ${ctx.targetDir}`);
  console.log(`Prompt mode：${ctx.promptMode}`);
  if (options.promptFile) console.log(`Prompt file：${path.resolve(options.promptFile)}`);
  console.log('═'.repeat(70));
  console.log('\n--- AGENT PROMPT（拷给主 session 派遣 artifact-writer）---\n');
  console.log(ctx.agentPrompt);
  console.log('\n' + '═'.repeat(70));
  console.log('下一步：');
  console.log(`  1. 主 session 用 Agent tool 派 artifact-writer，prompt 见上`);
  console.log(`  2. 收到 agent 报告后，存为 JSON：{"status":"SUCCESS","tokens":N,"tool_uses":N,"duration_ms":N,"raw":"..."}`);
  console.log(`  3. node run-tests.js verify ${path.relative(ROOT, ctx.yamlPath)} <report.json>`);
  console.log(`  4. 完成后清理：node run-tests.js teardown ${path.relative(ROOT, ctx.yamlPath)}`);
}

function readReport(reportPath) {
  if (!reportPath) {
    // 从 stdin 读
    const stdin = fs.readFileSync(0, 'utf8');
    return JSON.parse(stdin);
  }
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function cmdVerify(yamlPath, reportPath) {
  const yamlAbs = path.isAbsolute(yamlPath) ? yamlPath : path.join(ROOT, yamlPath);
  const tc = runner.loadYaml(yamlAbs);
  const targetDir = (tc.setup.variables && tc.setup.variables.project_path)
    || runner.defaultVaultDir(tc.setup.fixture);
  const setupHelper = require('./helpers/fixture-setup');
  const variables = setupHelper.buildVariables();
  // 与 prepare 保持一致：渲染并合入 case.setup.variables
  for (const [k, v] of Object.entries(tc.setup.variables || {})) {
    variables[k] = typeof v === 'string' ? setupHelper.renderVariables(v, variables) : v;
  }
  const ctx = { testCase: tc, yamlPath: yamlAbs, targetDir, variables };

  const agentReport = readReport(reportPath);
  const result = runner.verifyAndReport(ctx, agentReport);

  runner.appendManifest(variables.ISO_DATE, {
    id: tc.id,
    passed: result.passed,
    reportPath: path.relative(ROOT, result.reportPath),
    timestamp: new Date().toISOString(),
  });

  console.log(`${tc.id}: ${result.passed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`报告：${result.reportPath}`);
  for (const v of result.validations) {
    const mark = v.warning ? '⚠' : (v.ok ? '✓' : '✗');
    console.log(`  ${mark} ${v.name}${v.reason ? ' — ' + v.reason : ''}`);
  }
  process.exit(result.passed ? 0 : 1);
}

function cmdTeardown(yamlPath) {
  const yamlAbs = path.isAbsolute(yamlPath) ? yamlPath : path.join(ROOT, yamlPath);
  const tc = runner.loadYaml(yamlAbs);
  const targetDir = (tc.setup.variables && tc.setup.variables.project_path)
    || runner.defaultVaultDir(tc.setup.fixture);
  const teardownHelper = require('./helpers/fixture-teardown');
  teardownHelper.teardown(targetDir);
  console.log(`Cleaned: ${targetDir}`);
}

const RESULTS_ROOT = path.join(ROOT, 'results');

function cmdVerifyMulti(yamlPath, ...reportPaths) {
  if (!yamlPath || reportPaths.length === 0) {
    console.error('Usage: node run-tests.js verify-multi <yaml> <report1> [report2 ...]');
    process.exit(2);
  }
  const yamlAbs = path.isAbsolute(yamlPath) ? yamlPath : path.join(ROOT, yamlPath);
  const tc = runner.loadYaml(yamlAbs);
  const targetDir = (tc.setup.variables && tc.setup.variables.project_path)
    || runner.defaultVaultDir(tc.setup.fixture);
  const setupHelper = require('./helpers/fixture-setup');
  const variables = setupHelper.buildVariables();
  for (const [k, v] of Object.entries(tc.setup.variables || {})) {
    variables[k] = typeof v === 'string' ? setupHelper.renderVariables(v, variables) : v;
  }

  const verifyHelper = require('./helpers/verify-output');
  const reports = reportPaths.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
  const results = reports.map((r) => verifyHelper.verify(tc, targetDir, variables, r));

  // 聚合 per validation
  const aggregated = {};
  for (const result of results) {
    for (const v of result.validations) {
      if (!aggregated[v.name]) aggregated[v.name] = { passed: 0, failed: 0, samples: [] };
      if (v.ok) aggregated[v.name].passed += 1;
      else {
        aggregated[v.name].failed += 1;
        const sample = v.actual !== undefined ? `actual=${JSON.stringify(v.actual)}` : (v.reason || '');
        if (aggregated[v.name].samples.length < 3 && sample) aggregated[v.name].samples.push(sample);
      }
    }
  }

  const overallPassed = results.filter((r) => r.passed).length;
  const N = results.length;

  console.log(`\n=== Variance for ${tc.id} (${N} runs) ===`);
  console.log(`Overall PASS: ${overallPassed}/${N} (${Math.round(overallPassed / N * 100)}%)`);
  console.log(`\nPer-validation PASS rate:`);
  for (const [name, stats] of Object.entries(aggregated)) {
    const total = stats.passed + stats.failed;
    const rate = total === 0 ? '-' : `${stats.passed}/${total}`;
    const samples = stats.samples.length > 0 ? `  ❌ 样本: [${stats.samples.join(' | ')}]` : '';
    const flag = total === stats.passed ? '✓' : (stats.passed === 0 ? '✗' : '⚠');
    console.log(`  ${flag} ${rate} ${name}${samples}`);
  }

  // tokens / tool_uses / duration variance
  const tokens = reports.map((r) => r.tokens || 0);
  const toolUses = reports.map((r) => r.tool_uses || 0);
  const durations = reports.map((r) => r.duration_ms || 0);
  console.log(`\nResource variance (min / mean / max):`);
  console.log(`  tokens:    ${Math.min(...tokens)} / ${Math.round(tokens.reduce((a, b) => a + b, 0) / N)} / ${Math.max(...tokens)}`);
  console.log(`  tool_uses: ${Math.min(...toolUses)} / ${Math.round(toolUses.reduce((a, b) => a + b, 0) / N)} / ${Math.max(...toolUses)}`);
  console.log(`  duration:  ${Math.min(...durations)}ms / ${Math.round(durations.reduce((a, b) => a + b, 0) / N)}ms / ${Math.max(...durations)}ms`);

  // 写聚合报告
  const dateStr = variables.ISO_DATE;
  const resultsDir = path.join(RESULTS_ROOT, dateStr);
  fs.mkdirSync(resultsDir, { recursive: true });
  const reportPath = path.join(resultsDir, `${tc.id.toLowerCase()}.variance.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    id: tc.id,
    runs: N,
    overall_pass_rate: overallPassed / N,
    per_validation: aggregated,
    resource_variance: {
      tokens: { min: Math.min(...tokens), mean: Math.round(tokens.reduce((a, b) => a + b, 0) / N), max: Math.max(...tokens) },
      tool_uses: { min: Math.min(...toolUses), mean: Math.round(toolUses.reduce((a, b) => a + b, 0) / N), max: Math.max(...toolUses) },
      duration_ms: { min: Math.min(...durations), mean: Math.round(durations.reduce((a, b) => a + b, 0) / N), max: Math.max(...durations) },
    },
    generated_at: new Date().toISOString(),
  }, null, 2), 'utf8');
  console.log(`\n聚合报告: ${path.relative(ROOT, reportPath)}`);
  process.exit(overallPassed === N ? 0 : 1);
}

function cmdDummy() {
  // 自测：用 TC-A1 + mock agent 报告跑通 setup → verify → report → teardown
  const yamlPath = path.join(CASES_DIR, 'phase-a', 'tc-a1-create-chg.yaml');
  if (!fs.existsSync(yamlPath)) {
    console.error('Missing TC-A1 yaml:', yamlPath);
    process.exit(2);
  }

  console.log('=== Dummy 自测 ===');
  console.log('1. prepare（setup fixture）');
  const ctx = runner.prepare(yamlPath);
  console.log(`   targetDir: ${ctx.targetDir}`);

  // 模拟 agent 真的跑了 create-chg：手动写出 expected files
  console.log('2. mock agent 产出（手动 Write 模拟）');
  const date = ctx.variables.TODAY;
  const dateUpper = ctx.variables.DATE_UPPER;
  const isoDate = ctx.variables.ISO_DATE;
  const chgFile = path.join(ctx.targetDir, 'changes', `chg-${date}-01.md`);
  fs.mkdirSync(path.dirname(chgFile), { recursive: true });
  fs.writeFileSync(chgFile, [
    '---',
    `chg-id: CHG-${dateUpper}-01`,
    'status: planned',
    `date: ${isoDate}`,
    'type: change',
    'parent-tasks: ["[[task]]"]',
    'parent-impl: ["[[implementation_plan]]"]',
    'related-finding: null',
    'aliases: []',
    'tags: []',
    'schema-version: "6.0"',
    'completed-date: null',
    'verified-date: null',
    'archived-date: null',
    '---',
    '',
    '# Dummy CHG',
    '',
    '## 任务清单',
    '',
    '- [ ] T-901 dummy task',
    '',
  ].join('\n'), 'utf8');

  // 修改 task.md / impl_plan.md 加索引行
  const taskPath = path.join(ctx.targetDir, 'task.md');
  fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace(
    '## 活跃任务\n\n',
    `## 活跃任务\n\n- [ ] [[chg-${date}-01]] Dummy CHG #change [tasks:: T-901]\n\n`,
  ));
  const implPath = path.join(ctx.targetDir, 'implementation_plan.md');
  fs.writeFileSync(implPath, fs.readFileSync(implPath, 'utf8').replace(
    '## 变更索引\n\n',
    `## 变更索引\n\n- [ ] [[chg-${date}-01]] Dummy CHG #change [tasks:: T-901]\n\n`,
  ));

  console.log('3. verify');
  const mockReport = {
    status: 'SUCCESS',
    tokens: 5000,
    tool_uses: 7,
    duration_ms: 12000,
    raw: '## artifact-writer 报告\n**操作**：create-chg\n（mock 报告，dummy 自测用）',
  };
  const dummyCtx = {
    ...ctx,
    testCase: {
      ...ctx.testCase,
      id: 'TC-DUMMY',
      indication: 'dummy-self-test',
    },
  };
  const result = runner.verifyAndReport(dummyCtx, mockReport);
  console.log(`   结果：${result.passed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   报告：${path.relative(ROOT, result.reportPath)}`);
  for (const v of result.validations) {
    const mark = v.warning ? '⚠' : (v.ok ? '✓' : '✗');
    console.log(`   ${mark} ${v.name}${v.reason ? ' — ' + v.reason : ''}`);
  }

  console.log('4. teardown');
  runner.teardown(ctx);
  console.log(`   清理：${ctx.targetDir}`);

  process.exit(result.passed ? 0 : 1);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'list': return cmdList(args[0]);
    case 'prepare': return cmdPrepare(args[0], ...args.slice(1));
    case 'verify': return cmdVerify(args[0], args[1]);
    case 'verify-multi': return cmdVerifyMulti(args[0], ...args.slice(1));
    case 'teardown': return cmdTeardown(args[0]);
    case 'dummy': return cmdDummy();
    default:
      console.error('Usage:');
      console.error('  node run-tests.js list [phase]');
      console.error('  node run-tests.js prepare <yaml-path> [--mode harness|production] [--prompt-file <path>]');
      console.error('  node run-tests.js verify <yaml-path> [report.json]');
      console.error('  node run-tests.js verify-multi <yaml-path> <report1.json> <report2.json> [...]');
      console.error('  node run-tests.js teardown <yaml-path>');
      console.error('  node run-tests.js dummy');
      process.exit(2);
  }
}

main();
