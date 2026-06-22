/**
 * subagent-runner.js
 *
 * 协调器：负责加载 YAML 用例 → 准备 fixture → 生成 agent prompt → 接收主 session 派遣的 agent 报告 → 验证 → 写报告。
 *
 * 注：Claude Code Agent tool 仅在主 session 内可调用，本 runner 不直接派遣 agent。
 * 主 session 用法：
 *   const runner = require('./helpers/subagent-runner');
 *   const ctx = runner.prepare('cases/phase-a/tc-a1-create-chg.yaml');
 *   // 主 session 用 Agent tool 派遣 artifact-writer，prompt = ctx.agentPrompt
 *   // 收到 agent 报告后：
 *   const result = runner.verifyAndReport(ctx, agentReport);
 *   runner.teardown(ctx);
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const setupHelper = require('./fixture-setup');
const teardownHelper = require('./fixture-teardown');
const verifyHelper = require('./verify-output');

const ROOT = path.join(__dirname, '..');

// 临时 vault 根目录的单一来源。历史上硬编码 `/tmp/test-vault/<fixture>`，
// 但 Windows 不识别 `/tmp`（会落到当前盘根 C:\tmp，污染且跨盘易失败），
// 故统一走 os.tmpdir()，供 prepare/run-tests/teardown 与 shell 端 harness 复用，保证跨平台一致。
function defaultVaultRoot() {
  return path.join(os.tmpdir(), 'pace-test-vault');
}
function defaultVaultDir(fixture) {
  return path.join(defaultVaultRoot(), String(fixture));
}
const REPO_ROOT = path.join(ROOT, '..', '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugin');
const RESULTS_ROOT = path.join(ROOT, 'results');
const ALLOWED_OPERATIONS = new Set([
  'create-chg',
  'update-chg',
  'archive-chg',
  'close-chg',
  'record-finding',
  'record-correction',
]);

function loadYaml(yamlPath) {
  return parseSimpleYaml(fs.readFileSync(yamlPath, 'utf8'));
}

function lineIndent(line) {
  return (line.match(/^ */) || [''])[0].length;
}

function isIgnorableYamlLine(line) {
  return !String(line || '').trim() || /^\s*#/.test(line);
}

function stripInlineYamlComment(value) {
  const raw = String(value || '');
  let quote = null;
  for (let idx = 0; idx < raw.length; idx += 1) {
    const ch = raw[idx];
    const prev = idx > 0 ? raw[idx - 1] : '';
    if ((ch === '"' || ch === "'") && prev !== '\\') {
      if (quote === ch) quote = null;
      else if (!quote) quote = ch;
      continue;
    }
    if (ch === '#' && !quote && (idx === 0 || /\s/.test(prev))) {
      return raw.slice(0, idx);
    }
  }
  return raw;
}

function splitInlineYamlObject(body) {
  const parts = [];
  let quote = null;
  let start = 0;
  for (let idx = 0; idx < body.length; idx += 1) {
    const ch = body[idx];
    const prev = idx > 0 ? body[idx - 1] : '';
    if ((ch === '"' || ch === "'") && prev !== '\\') {
      if (quote === ch) quote = null;
      else if (!quote) quote = ch;
    } else if (ch === ',' && !quote) {
      parts.push(body.slice(start, idx));
      start = idx + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function parseScalar(value) {
  const raw = stripInlineYamlComment(value).trim();
  if (raw === '[]') return [];
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const obj = {};
    const body = raw.slice(1, -1).trim();
    if (!body) return obj;
    for (const part of splitInlineYamlObject(body)) {
      const item = part.trim();
      const m = item.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!m) throw new Error(`Unsupported inline YAML object part: ${part}`);
      obj[m[1]] = parseScalar(m[2]);
    }
    return obj;
  }
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseSimpleYaml(content) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  function skipBlank() {
    while (i < lines.length && isIgnorableYamlLine(lines[i])) i++;
  }

  function readBlockScalar(parentIndent) {
    const blockIndent = parentIndent + 2;
    const out = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        out.push('');
        i++;
        continue;
      }
      if (lineIndent(line) < blockIndent) break;
      out.push(line.slice(Math.min(blockIndent, line.length)));
      i++;
    }
    return out.join('\n').replace(/\n+$/, '\n');
  }

  function parseValue(rest, indent) {
    const trimmed = stripInlineYamlComment(rest).trim();
    if (trimmed === '|') {
      i++;
      return readBlockScalar(indent);
    }
    if (trimmed === '') {
      i++;
      return parseNode(indent + 2);
    }
    i++;
    return parseScalar(trimmed);
  }

  function parseMap(indent) {
    const obj = {};
    while (i < lines.length) {
      skipBlank();
      if (i >= lines.length) break;
      const line = lines[i];
      const currentIndent = lineIndent(line);
      if (currentIndent < indent) break;
      if (currentIndent > indent) break;
      const trimmed = line.trim();
      if (/^#/.test(trimmed)) {
        i++;
        continue;
      }
      if (trimmed.startsWith('- ')) break;
      const match = trimmed.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
      if (!match) throw new Error(`Unsupported YAML line: ${line}`);
      obj[match[1]] = parseValue(match[2] || '', currentIndent);
    }
    return obj;
  }

  function parseList(indent) {
    const arr = [];
    while (i < lines.length) {
      skipBlank();
      if (i >= lines.length) break;
      const line = lines[i];
      const currentIndent = lineIndent(line);
      if (currentIndent < indent) break;
      if (currentIndent > indent) break;
      const trimmed = line.trim();
      if (/^#/.test(trimmed)) {
        i++;
        continue;
      }
      if (!trimmed.startsWith('- ')) break;
      const rest = trimmed.slice(2);
      if (!rest) {
        i++;
        arr.push(parseNode(indent + 2));
        continue;
      }
      const pair = rest.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
      if (!pair) {
        i++;
        arr.push(parseScalar(rest));
        continue;
      }
      const item = {};
      item[pair[1]] = pair[2] === undefined || pair[2] === '' ? (i++, parseNode(indent + 2)) : parseValue(pair[2], currentIndent);
      while (i < lines.length) {
        skipBlank();
        if (i >= lines.length) break;
        const next = lines[i];
        const nextIndent = lineIndent(next);
        if (nextIndent <= indent) break;
        if (nextIndent !== indent + 2) break;
        const nextTrimmed = next.trim();
        if (/^#/.test(nextTrimmed)) {
          i++;
          continue;
        }
        const m = nextTrimmed.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
        if (!m) break;
        item[m[1]] = parseValue(m[2] || '', nextIndent);
      }
      arr.push(item);
    }
    return arr;
  }

  function parseNode(indent) {
    skipBlank();
    if (i >= lines.length) return {};
    return lines[i].trim().startsWith('- ') ? parseList(indent) : parseMap(indent);
  }

  return parseNode(0);
}

function renderInputFields(testCase, variables) {
  const fields = testCase.input.fields || {};
  const renderedFields = {};
  for (const [k, v] of Object.entries(fields)) {
    renderedFields[k] = renderInputValue(v, variables);
  }
  return renderedFields;
}

function renderInputValue(value, variables) {
  if (typeof value === 'string') return setupHelper.renderVariables(value, variables);
  if (Array.isArray(value)) return value.map((item) => renderInputValue(item, variables));
  if (value && typeof value === 'object') {
    const rendered = {};
    for (const [k, v] of Object.entries(value)) rendered[k] = renderInputValue(v, variables);
    return rendered;
  }
  return value;
}

function buildProductionAgentPrompt(testCase, ctx) {
  const op = testCase.input.operation;
  const fieldsJson = JSON.stringify(renderInputFields(testCase, ctx.variables), null, 2);

  return `ARTIFACT_DIR: ${ctx.targetDir}
operation: ${op}

fields:
\`\`\`json
${fieldsJson}
\`\`\``;
}

function buildAgentPrompt(testCase, ctx, options = {}) {
  if (options.promptMode === 'production') {
    return buildProductionAgentPrompt(testCase, ctx);
  }

  const op = testCase.input.operation;
  const isAllowedOperation = ALLOWED_OPERATIONS.has(op);

  // 渲染字段中的变量
  const renderedFields = renderInputFields(testCase, ctx.variables);

  const fieldsJson = JSON.stringify(renderedFields, null, 2);
  const specPath = path.join(PLUGIN_ROOT, 'agent-references', 'artifact-writer-spec.md');
  const instructionPath = isAllowedOperation
    ? path.join(PLUGIN_ROOT, 'agent-references', 'instructions', `${op}.md`)
    : null;
  const instructionLine = instructionPath
    ? `- 当前指令规范：${instructionPath}`
    : `- 当前指令规范：无；operation \`${op}\` 不在允许集合内，必须报告 \`out-of-scope\``;

  const operationHints = op === 'create-chg'
    ? `
create-chg 资源路径要求：
- 不要读取 walkthrough.md / findings.md / corrections.md；本操作只修改 task.md 和 implementation_plan.md。
- 不要搜索 ~/.claude 或读取 agent 自身定义；本 prompt 已给出规范绝对路径。
- 不要用 wc/du/ls -la 统计报告大小或行数；报告里路径即可，大小/行数可省略。
- 最短工具路径参考：检测 changes/ → Read spec/instruction → 分配 ID → Write 详情 → Read+Edit task.md → Read+Edit implementation_plan.md → 报告。`
    : '';
  const unknownOperationHints = isAllowedOperation
    ? ''
    : `
未知 operation 硬约束：
- 允许集合：create-chg / update-chg / archive-chg / close-chg / record-finding / record-correction
- 当前 operation \`${op}\` 不在允许集合内；不要搜索或读取不存在的 \`instructions/${op}.md\`
- 不要检查 target 文件是否存在；未知 operation 的错误码固定为 \`out-of-scope\`
- 立即报告 \`status: FAILED\` / \`error_code: out-of-scope\`
- 禁止 Write / Edit；files_created / files_modified 必须为空`;

  return `执行 artifact-writer 指令：${op}

最终输出硬约束（机械检查）：
- 最终回答第一行必须完全等于：## artifact-writer 报告
- 禁止输出 ## 报告 / ## 执行报告 / ## ${op} 报告 / 任何标题变体
- 标题前不能有任何自然语言、空行或说明；不匹配会导致 report_title_strict FAIL
- 即使发现错误，也必须先输出标题；错误解释放在标题之后

项目路径（ARTIFACT_DIR）：${ctx.targetDir}

项目有效性硬约束：
- 先用 \`test -d "${ctx.targetDir}/changes" && echo EXISTS || echo MISSING\` 检查 ${ctx.targetDir}/changes 是否存在且是目录
- 禁止用 \`ls ${ctx.targetDir}/changes\` 的空输出判断目录不存在；空目录也会没有 stdout
- 如果 base changes/ 不存在，立即报告 \`status: FAILED\` / \`error_code: not-pace-project\`
- 禁止创建 base changes/ 来初始化项目；此场景不得 Write / Edit 任何 artifact
- 只有在 base changes/ 已存在时，才允许懒创建 changes/findings/ 或 changes/corrections/

规范路径（绝对路径；不要搜索 ~/.claude）：
- 通用规范：${specPath}
${instructionLine}

输入字段（JSON）：
\`\`\`json
${fieldsJson}
\`\`\`

操作要求：
- 严格按 ${op} 规范执行
- 操作完成后按报告格式输出，第一行必须是 \`## artifact-writer 报告\`
- 不做超出 ${op} 范围的额外修改
- 资源预算是硬约束的一部分；避免为报告展示而额外 Read/Bash
${unknownOperationHints}
${operationHints}`;
}

function prepare(yamlRelOrAbsPath, options = {}) {
  const yamlPath = path.isAbsolute(yamlRelOrAbsPath)
    ? yamlRelOrAbsPath
    : path.join(ROOT, yamlRelOrAbsPath);

  const testCase = loadYaml(yamlPath);

  const targetDir = (testCase.setup.variables && testCase.setup.variables.project_path)
    || defaultVaultDir(testCase.setup.fixture);

  // 渲染 pre_files 中的变量需先 setup（变量来自 setup.buildVariables）
  const preFiles = testCase.setup.pre_files || [];
  const { variables } = setupHelper.setup(
    testCase.setup.fixture,
    targetDir,
    preFiles,
    {},
    testCase.setup.variables || {},
  );

  const ctx = { testCase, yamlPath, targetDir, variables };
  ctx.promptMode = options.promptMode || 'harness';
  ctx.agentPrompt = buildAgentPrompt(testCase, ctx, options);
  return ctx;
}

function verifyAndReport(ctx, agentReport) {
  const result = verifyHelper.verify(ctx.testCase, ctx.targetDir, ctx.variables, agentReport);

  // 写报告到 results/<date>/tc-xxx.report.md
  const dateStr = ctx.variables.ISO_DATE;
  const resultsDir = path.join(RESULTS_ROOT, dateStr);
  fs.mkdirSync(resultsDir, { recursive: true });

  const reportPath = path.join(resultsDir, `${ctx.testCase.id.toLowerCase()}.report.md`);
  const lines = [
    `# ${ctx.testCase.id} 报告`,
    '',
    `- **用例**：${ctx.testCase.indication}`,
    `- **结果**：${result.passed ? '✅ PASS' : '❌ FAIL'}`,
    `- **运行时间**：${dateStr}`,
    `- **vault**：${ctx.targetDir}`,
    '',
    '## Agent 报告',
    '',
    '```',
    agentReport && agentReport.raw ? agentReport.raw : '(未提供 raw)',
    '```',
    '',
    '## 验证项',
    '',
    ...result.validations.map((v) => {
      const mark = v.warning ? '⚠️' : (v.ok ? '✅' : '❌');
      return `- ${mark} ${v.name}${v.reason ? ` — ${v.reason}` : ''}${v.actual !== undefined ? ` (actual=${v.actual} limit=${v.limit ?? '-'})` : ''}`;
    }),
    '',
  ];

  if (result.diffs.length > 0) {
    lines.push('## 差异');
    lines.push('');
    for (const d of result.diffs) lines.push(`- ${JSON.stringify(d)}`);
    lines.push('');
  }

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return { ...result, reportPath };
}

function teardown(ctx) {
  if (ctx && ctx.testCase && ctx.testCase.teardown && ctx.testCase.teardown.cleanup) {
    teardownHelper.teardown(ctx.targetDir);
  }
}

function appendManifest(date, entry) {
  const dir = path.join(RESULTS_ROOT, date);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest = { date, entries: [] };
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  manifest.entries.push(entry);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

module.exports = {
  loadYaml,
  parseSimpleYaml,
  defaultVaultRoot,
  defaultVaultDir,
  prepare,
  verifyAndReport,
  teardown,
  appendManifest,
  buildAgentPrompt,
  buildProductionAgentPrompt,
};
