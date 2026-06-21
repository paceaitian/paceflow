// PACEflow Hook E2E 测试（v6-only）
// 覆盖 v6 项目信号 changes/、详情文件任务权威、APPROVED/VERIFIED 详情位置。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'plugin', 'hooks');
const RESERVE_HELPER = path.join(HOOKS_DIR, 'reserve-artifact-id.js');
const SYNC_PLAN_HELPER = path.join(HOOKS_DIR, 'sync-plan.js');
const SET_ARTIFACT_ROOT_HELPER = path.join(HOOKS_DIR, 'set-artifact-root.js');
const SET_PROJECT_ROOT_HELPER = path.join(HOOKS_DIR, 'set-project-root.js');
const SET_ACTIVATION_HELPER = path.join(HOOKS_DIR, 'set-activation.js');
const bashGuard = require('../plugin/hooks/pre-tool-use/bash-guard');
const powershellGuard = require('../plugin/hooks/pre-tool-use/powershell-guard');
const { createTestRunner } = require('./test-utils');
const t = createTestRunner('pace-e2e');
const { test, makeTmpDir } = t;

const _origVaultPath = process.env.PACE_VAULT_PATH;
const _vaultTmpDir = path.join(os.tmpdir(), `pace-e2e-vault-${Date.now()}`);
fs.mkdirSync(path.join(_vaultTmpDir, 'projects'), { recursive: true });
process.env.PACE_VAULT_PATH = _vaultTmpDir;

// CHG-20260614-08: 注入独立 tmp 日志，杜绝 e2e 写源码树 plugin/hooks/pace-hooks.log
// （跨进程共享 + 1MB 砍半的结构性 flaky 根因）。每轮 run 一个 fresh 文件；子 hook 经
// process.env 继承 PACE_LOG_PATH，覆盖 runHook/runHookDetailed/直接 reserve helper 全部 spawn。
const _origLogPath = process.env.PACE_LOG_PATH;
const E2E_LOG_PATH = path.join(os.tmpdir(), `pace-e2e-log-${Date.now()}-${process.pid}.log`);
process.env.PACE_LOG_PATH = E2E_LOG_PATH;

function cleanupAll() {
  if (_origVaultPath === undefined) delete process.env.PACE_VAULT_PATH;
  else process.env.PACE_VAULT_PATH = _origVaultPath;
  if (_origLogPath === undefined) delete process.env.PACE_LOG_PATH;
  else process.env.PACE_LOG_PATH = _origLogPath;
  try { fs.rmSync(_vaultTmpDir, { recursive: true, force: true }); } catch(e) {}
  try { fs.rmSync(E2E_LOG_PATH, { force: true }); fs.rmSync(`${E2E_LOG_PATH}.lock`, { force: true }); } catch(e) {}
  t.cleanup();
}

function runHook(hookName, { cwd, stdin = {}, env = {}, args = [] }) {
  const hookPath = path.resolve(HOOKS_DIR, hookName);
  try {
    // args 透传到 hook 脚本路径之后（如 ['--group', 'artifact']）
    const stdout = execFileSync('node', [hookPath, ...args], {
      cwd,
      input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch(e) {
    return { code: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function runHookDetailed(hookName, { cwd, stdin = {}, env = {}, args = [] }) {
  const hookPath = path.resolve(HOOKS_DIR, hookName);
  // args 透传到 hook 脚本路径之后（如 ['--group', 'artifact']）
  const r = spawnSync('node', [hookPath, ...args], {
    cwd,
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
  });
  return { code: r.status || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runReserveHelper({ cwd, args = [], env = {} }) {
  const r = spawnSync('node', [RESERVE_HELPER, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
  });
  return { code: r.status || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runSyncPlanHelper({ cwd, args = [], env = {} }) {
  const r = spawnSync('node', [SYNC_PLAN_HELPER, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
  });
  return { code: r.status || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runSetArtifactRootHelper({ cwd, args = [], env = {} }) {
  const r = spawnSync('node', [SET_ARTIFACT_ROOT_HELPER, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
  });
  return { code: r.status || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runSetProjectRootHelper({ cwd, args = [], env = {} }) {
  const r = spawnSync('node', [SET_PROJECT_ROOT_HELPER, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
  });
  return { code: r.status || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runSetActivationHelper({ cwd, args = [], env = {} }) {
  const r = spawnSync('node', [SET_ACTIVATION_HELPER, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
  });
  return { code: r.status || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function today() {
  // 与 todayISO 同口径（宿主本地时区，CHG-20260619-07 去硬编码后对齐）
  return new Date().toLocaleDateString('sv-SE');
}

function slugFromId(id) {
  const lower = id.toLowerCase();
  if (lower.startsWith('chg-') || lower.startsWith('hotfix-')) return lower;
  if (id.startsWith('CHG-')) return `chg-${id.slice(4).toLowerCase()}`;
  if (id.startsWith('HOTFIX-')) return `hotfix-${id.slice(7).toLowerCase()}`;
  return lower;
}

function displayDirForAssert(dir, { normalized = false } = {}) {
  let value = String(dir || '').replace(/\\/g, '/').replace(/\/?$/, '/');
  if (normalized && process.platform === 'win32') value = value.toLowerCase();
  return value;
}

function reservedFromStdout(stdout) {
  let text = String(stdout || '');
  try {
    const parsed = JSON.parse(text);
    text = [
      parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecisionReason,
      parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext,
    ].filter(Boolean).join('\n');
  } catch(e) {}
  const id = (text.match(/reserved-id:\s*([A-Z]+-\d{8}-\d{2}|CORRECTION-\d{4}-\d{2}-\d{2}-\d{2})/) || [])[1] || '';
  const file = (text.match(/reserved-file:\s*([^\s；]+)/) || [])[1] || '';
  const prefix = (text.match(/reserved-file-prefix:\s*([^\s；<]+)(?:<slug>\.md)?/) || [])[1] || '';
  // 统一访问：CHG/HOTFIX/correction 走 filePrefix（reserved-file-prefix，带 <slug> 占位），
  //   detailFile 用固定 slug `detail` 拼出 artifact-writer 实际写入的详情文件路径；
  //   promptReservedLine 是加进 artifact-writer prompt 的预留行（精确 reserved-file，或 prefix 原样占位）。
  const detailFile = file || (prefix ? `${prefix}detail.md` : '');
  const promptReservedLine = file
    ? `reserved-file: ${file}`
    : (prefix ? `reserved-file-prefix: ${prefix}<slug>.md` : '');
  return { id, file, prefix, detailFile, promptReservedLine };
}

function projectNameForDir(dir) {
  return path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function chgDetail({ id = 'CHG-20260504-01', status = 'in-progress', task = '[/]', tasks = null, approved = true, verified = false, reviewed = false, changeSet = null, changeSetSeq = null } = {}) {
  const completedDate = status === 'completed' || status === 'archived' ? `${today()}T12:00:00+08:00` : 'null';
  const verifiedDate = verified ? `${today()}T12:30:00+08:00` : 'null';
  const reviewedDate = reviewed ? `${today()}T12:45:00+08:00` : 'null';
  const taskLines = tasks || [`- ${task} T-001 测试任务`];
  return [
    '---',
    `chg-id: ${id}`,
    `status: ${status}`,
    'date: 2026-05-04',
    'type: change',
    ...(changeSet !== null ? [`change-set: ${changeSet}`] : []),
    ...(changeSetSeq !== null ? [`change-set-seq: ${changeSetSeq}`] : []),
    'parent-tasks: ["[[task]]"]',
    'parent-impl: ["[[implementation_plan]]"]',
    'related-finding: null',
    'aliases: []',
    'tags: []',
    'schema-version: "6.0"',
    `completed-date: ${completedDate}`,
    `verified-date: ${verifiedDate}`,
    `reviewed-date: ${reviewedDate}`,
    'archived-date: null',
    '---',
    '',
    '# 测试变更',
    '',
    '## 任务清单',
    '',
    ...taskLines,
    '',
    approved ? '<!-- APPROVED -->' : '',
    verified ? '<!-- VERIFIED -->' : '',
    reviewed ? '<!-- REVIEWED -->' : '',
    '',
    '## 实施详情',
    '',
    '**背景（Why）**：E2E 测试',
    '',
    '## 工作记录',
    '',
    '| 日期 | 完成内容 |',
    '| --- | --- |',
    '',
  ].filter((line, idx, arr) => line !== '' || arr[idx - 1] !== '').join('\n');
}

function makeV6Project(label, opts = {}) {
  const dir = makeTmpDir(label);
  fs.mkdirSync(path.join(dir, 'changes', 'findings'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'changes', 'corrections'), { recursive: true });
  const mark = opts.indexMark || '[/]';
  const index = opts.withIndex === false ? '' : `- ${mark} [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n`;
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${index}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n${opts.implIndex === undefined ? index : opts.implIndex}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), `# 工作记录\n\n## 最近工作\n\n| 日期 | 完成内容 | 关联变更 |\n| --- | --- | --- |\n${opts.walkToday === false ? '' : `| ${today()} | [[chg-20260504-01]] smoke | CHG-20260504-01 |\n`}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'findings.md'), '# 调研记录\n\n## 摘要索引\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'corrections.md'), '# Corrections 记录\n\n## 索引\n\n<!-- ARCHIVE -->\n', 'utf8');
  if (opts.detail !== false) {
    fs.writeFileSync(path.join(dir, 'changes', 'chg-20260504-01.md'), opts.detail || chgDetail(), 'utf8');
  }
  if (opts.paceRuntime) {
    fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
    for (const [name, content] of Object.entries(opts.paceRuntime)) {
      fs.writeFileSync(path.join(dir, '.pace', name), content, 'utf8');
    }
  }
  return dir;
}

function seedArtifactWriterLock(dir, sessionId = 'sid-artifact-writer-test') {
  const paceDir = path.join(dir, '.pace');
  fs.mkdirSync(paceDir, { recursive: true });
  fs.writeFileSync(path.join(paceDir, 'artifact-writer.lock'), JSON.stringify({
    sessionId,
    agentId: 'agent-test',
    artifactDir: dir,
    cwd: dir,
    operation: 'test',
    createdAt: new Date().toISOString(),
    timestampMs: Date.now(),
  }, null, 2) + '\n', 'utf8');
  return sessionId;
}

function safeLockName(value) {
  return encodeURIComponent(String(value || 'unknown')).replace(/%/g, '_');
}

function seedArtifactResourceLock(dir, resource, { sessionId = 'sid-resource-owner', agentId = 'agent-resource-owner', file = '', timestampMs = Date.now() } = {}) {
  const lockDir = path.join(dir, '.pace', 'locks', 'artifacts');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${safeLockName(resource)}.lock`);
  fs.writeFileSync(lockPath, JSON.stringify({
    version: 'resource-v1',
    resource,
    sessionId,
    agentId,
    ownerKey: agentId ? `agent:${agentId}` : `session:${sessionId}`,
    artifactDir: dir,
    cwd: dir,
    file,
    operation: 'test',
    createdAt: new Date().toISOString(),
    timestampMs,
  }, null, 2) + '\n', 'utf8');
  return lockPath;
}

function seedChangeOwner(dir, changeId, {
  sessionId = 'sid-other-owner',
  agentId = 'agent-other-owner',
  state = 'active',
  cwd = '',
  stateDir = '',
  worktree = 'worktree-a',
  branch = 'branch-a',
  timestampMs = Date.now(),
} = {}) {
  const ownerDir = path.join(dir, '.pace', 'change-owners');
  fs.mkdirSync(ownerDir, { recursive: true });
  const fp = path.join(ownerDir, `${slugFromId(changeId)}.json`);
  fs.writeFileSync(fp, JSON.stringify({
    version: 'change-owner-v1',
    changeId,
    sessionId,
    agentId,
    ownerKey: agentId ? `agent:${agentId}` : `session:${sessionId}`,
    state,
    cwd,
    stateDir,
    worktree,
    branch,
    timestampMs,
    updatedAt: new Date(timestampMs).toISOString(),
  }, null, 2) + '\n', 'utf8');
  return fp;
}

function makeVaultBackedWorktree(label) {
  const root = makeTmpDir(`${label}-root`);
  const projectName = `pace-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const host = path.join(root, projectName);
  const worktree = path.join(host, 'worktrees', 'smoke');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectName);
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'smoke')}\n`, 'utf8');
  fs.mkdirSync(path.join(vaultDir, 'changes', 'findings'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'changes', 'corrections'), { recursive: true });

  const index = '- [/] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n';
  fs.writeFileSync(path.join(vaultDir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${index}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n${index}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'walkthrough.md'), '# 工作记录\n\n## 最近工作\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'findings.md'), '# 调研记录\n\n## 摘要索引\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'corrections.md'), '# Corrections 记录\n\n## 索引\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'changes', 'chg-20260504-01.md'), chgDetail(), 'utf8');
  return { host, worktree, vaultDir, projectName };
}

function makeV6ProjectWithChanges(label, changes, opts = {}) {
  const dir = makeV6Project(label, { withIndex: false, detail: false, walkToday: opts.walkToday });
  const lines = changes.map(c => {
    const id = c.id || 'CHG-20260504-01';
    const mark = c.indexMark || '[ ]';
    return `- ${mark} [[${slugFromId(id)}]] ${c.title || `变更 ${id}`} #change [tasks:: T-001]`;
  }).join('\n');
  const indexBlock = lines ? `${lines}\n` : '';
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${indexBlock}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n${indexBlock}\n<!-- ARCHIVE -->\n`, 'utf8');
  if (opts.walkToday !== false) {
    fs.writeFileSync(path.join(dir, 'walkthrough.md'), `# 工作记录\n\n## 最近工作\n\n| 日期 | 完成内容 | 关联变更 |\n| --- | --- | --- |\n| ${today()} | [[chg-20260504-01]] smoke | CHG-20260504-01 |\n<!-- ARCHIVE -->\n`, 'utf8');
  }
  for (const c of changes) {
    const id = c.id || 'CHG-20260504-01';
    fs.writeFileSync(
      path.join(dir, 'changes', `${slugFromId(id)}.md`),
      chgDetail({
        id,
        status: c.status || 'planned',
        task: c.task || '[ ]',
        tasks: c.tasks || null,
        approved: c.approved || false,
        verified: c.verified || false,
        changeSet: c.changeSet ?? null,
        changeSetSeq: c.changeSetSeq ?? null,
      }),
      'utf8'
    );
  }
  return dir;
}

function codeEditStdin(dir) {
  return { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src.js'), old_string: 'a', new_string: 'b' } };
}

function makeLegacyProject(label) {
  const dir = makeTmpDir(label);
  fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n\n- [ ] Legacy task\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(1)\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.js'), 'console.log(2)\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'c.js'), 'console.log(3)\n', 'utf8');
  return dir;
}

console.log('\n--- session-start.js ---');

test('1. 非 PACE 项目静默放行', () => {
  const dir = makeTmpDir('ss-empty');
  const r = runHook('session-start.js', { cwd: dir });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('=== task.md ==='));
  assert.ok(!fs.existsSync(path.join(dir, '.pace')), '非 PACE 项目不应被 SessionStart 创建 .pace');
});

test('2. v6 artifact 注入 + 活跃 CHG 摘要（core group：骨架内容）', () => {
  // core group（默认）：注入工作流入口 + 活跃 CHG 摘要，不含 artifact 文件块。
  const dir = makeV6Project('ss-v6');
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('=== 活跃 CHG 摘要 ==='));
  assert.ok(r.stdout.includes('spec.md / task.md / walkthrough.md / findings.md / corrections.md / changes/**'));
  assert.ok(r.stdout.includes('CHG-20260504-01'));
  assert.ok(r.stdout.includes('先 Read 对应 changes/<id>.md'));
  assert.ok(r.stdout.includes('本摘要只用于定位，不替代 CHG 详情'));
});

test('2-art. v6 artifact 注入（artifact group：文件块内容）', () => {
  // artifact group：注入 task.md/corrections.md 等文件块，不含工作流入口。
  const dir = makeV6Project('ss-v6-art');
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('=== task.md ==='));
  assert.ok(r.stdout.includes('=== corrections.md ==='));
});

test('C1. SessionStart 注入 change-set 整体进度', () => {
  const dir = makeV6ProjectWithChanges('ss-changeset', [
    { id: 'CHG-20260607-02', status: 'planned', task: '[ ]', changeSet: 'review-gate', changeSetSeq: '2/4' },
    { id: 'CHG-20260607-03', status: 'planned', task: '[ ]', changeSet: 'review-gate', changeSetSeq: '3/4' },
    { id: 'CHG-20260607-04', status: 'planned', task: '[ ]', changeSet: 'review-gate', changeSetSeq: '4/4' },
  ]);
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('change-set') && r.stdout.includes('review-gate'), '应注入 change-set 名');
  assert.ok(r.stdout.includes('还有 3 个待执行'), 'CS-PROGRESS：应报确切待执行数（3 个活跃成员）');
  assert.ok(r.stdout.includes('变更集共 4 个'), '分母一致（都是 /4）应附「共 N」');
  assert.ok(!/进度 \d+\/\d+/.test(r.stdout), 'CS-PROGRESS：不再输出会虚高的「进度 done/n」');
});

test('C1t. SessionStart core 注入活跃 CHG 任务清单本体（in-progress 完整 + planned 标题）', () => {
  // CHG-20260609-03 T-001：core hook 在活跃 CHG 摘要下展开任务本体。
  // in-progress CHG 给完整任务行（含 [状态]），planned CHG 只给任务标题。
  const dir = makeV6ProjectWithChanges('ss-task-body', [
    {
      id: 'CHG-20260609-03', status: 'in-progress', task: '[/]', approved: true,
      tasks: ['- [/] T-001 正在做的任务甲', '- [ ] T-002 待办任务乙'],
    },
    {
      id: 'CHG-20260609-09', status: 'planned', task: '[ ]', approved: false,
      tasks: ['- [ ] T-001 规划任务标题丙', '- [ ] T-002 规划任务标题丁'],
    },
  ]);
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  // in-progress：完整任务行本体（含状态）注入，AI 开局即见
  assert.ok(r.stdout.includes('T-001') && r.stdout.includes('正在做的任务甲'), 'in-progress 注入完整任务本体');
  assert.ok(r.stdout.includes('待办任务乙'), 'in-progress 注入全部活跃任务行');
  // planned：任务标题注入，让 AI 知规划
  assert.ok(r.stdout.includes('规划任务标题丙'), 'planned 注入任务标题');
});

test('C1c. change-set 分母不一致 → 不臆断总数、不虚高（CS-PROGRESS 回归）', () => {
  const dir = makeV6ProjectWithChanges('ss-cs-mixed', [
    { id: 'CHG-20260607-02', status: 'planned', task: '[ ]', changeSet: 'mixset', changeSetSeq: '2/4' },
    { id: 'CHG-20260607-03', status: 'planned', task: '[ ]', changeSet: 'mixset', changeSetSeq: '1/6' },
  ]);
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('还有 2 个待执行'), '应报 2 个待执行');
  assert.ok(!r.stdout.includes('变更集共'), '分母不一致（/4 与 /6）不应臆断总数');
  assert.ok(!/进度 \d+\/\d+/.test(r.stdout) && !r.stdout.includes('4/6'), '不得出现按 max 分母虚高的进度/完成数');
});

test('C1d. change-set 分母 typo（1/99 单成员）→ 不虚报已完成（CS-PROGRESS 回归）', () => {
  const dir = makeV6ProjectWithChanges('ss-cs-typo', [
    { id: 'CHG-20260607-02', status: 'planned', task: '[ ]', changeSet: 'typoset', changeSetSeq: '1/99' },
  ]);
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('还有 1 个待执行'), '应报 1 个待执行');
  assert.ok(!/进度 \d+\/\d+/.test(r.stdout), 'CS-PROGRESS：不得出现「进度 done/n」虚报（锚定格式，不用全局 includes(97/98) 避免误匹配注入其他位置的数字 → flaky）');
  assert.ok(!r.stdout.includes('变更集共'), 'CS-PROGRESS：单成员无法交叉验证分母，不附「共 N」（避免 typo 分母 99 被当真）');
});

// print-session-context.js helper（CHG-20260608-01）：让用户看到 SessionStart 注入，无副作用。
function runPrintContext(cwd, extraArgs = []) {
  const helperPath = path.resolve(HOOKS_DIR, 'print-session-context.js');
  const r = spawnSync('node', [helperPath, ...extraArgs], {
    cwd, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return { code: r.status || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('PSC-1. print-session-context 打印 SessionStart 注入（startup）', () => {
  const dir = makeV6ProjectWithChanges('psc-startup', [
    { id: 'CHG-20260608-01', status: 'in-progress', task: '[/]', approved: true, changeSet: 'gap-fill', changeSetSeq: '1/2' },
  ]);
  const r = runPrintContext(dir);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('SessionStart 注入预览'), '应有预览头');
  assert.ok(r.stdout.includes('=== 活跃 CHG 摘要 ===') && r.stdout.includes('CHG-20260608-01'), '应转发 session-start 的活跃 CHG 注入');
});

test('PSC-2. print-session-context --compact 走 compact 路径（exit 0 + 有预览）', () => {
  const dir = makeV6ProjectWithChanges('psc-compact', [
    { id: 'CHG-20260608-01', status: 'in-progress', task: '[/]', approved: true },
  ]);
  const r = runPrintContext(dir, ['--compact']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('compact') && r.stdout.includes('SessionStart 注入预览'), '应走 compact 预览');
});

test('PSC-3. print-session-context 无副作用——不重置 stop-block-count（PACE_PRINT_ONLY 隔离）', () => {
  const dir = makeV6ProjectWithChanges('psc-noeffect', [
    { id: 'CHG-20260608-01', status: 'in-progress', task: '[/]', approved: true },
  ]);
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  const counterPath = path.join(dir, '.pace', 'stop-block-count');
  fs.writeFileSync(counterPath, '2', 'utf8');
  const r = runPrintContext(dir);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(counterPath, 'utf8'), '2', 'print-only 不得重置 stop-block-count（裸跑 session-start 会重置为 0）');
});

// PSC-4 已删（M4/T-002）：原测 print-only --compact 注入「Compact 恢复」快照块且不消耗快照。
//   PreCompact 快照机制退役后，compact 不再读 pre-compact-state.json、无快照恢复段——前提消失。
//   compact 实时注入由 MH-5 覆盖；print-only 不写盘隔离仍由 PSC-1/PSC-2/PSC-3 等覆盖。

test('C1b. 无 change-set 成员 → 不注入 change-set 进度（回归）', () => {
  const dir = makeV6ProjectWithChanges('ss-no-changeset', [
    { id: 'CHG-20260607-02', status: 'in-progress', task: '[/]', approved: true },
  ]);
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('change-set 整体进度'), '无 change-set 成员不应注入该段');
});

test('STOP-cs1. change-set 有 planned + 无 in-progress → 软提醒 exit 0（不阻断）', () => {
  const dir = makeV6ProjectWithChanges('stop-cs-planned', [
    { id: 'CHG-20260607-03', status: 'planned', task: '[ ]', approved: false, changeSet: 'review-gate', changeSetSeq: '3/4' },
    { id: 'CHG-20260607-04', status: 'planned', task: '[ ]', approved: false, changeSet: 'review-gate', changeSetSeq: '4/4' },
  ], { walkToday: false });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 0, '无 in-progress 阻断项应放行');
  assert.ok(r.stderr.includes('change-set') || r.stdout.includes('change-set'), '应有 change-set 软提醒（可见）');
});

test('STOP-cs2. 有 in-progress CHG → 仍 exit 2（回归，不被 change-set 软提醒降级）', () => {
  const dir = makeV6ProjectWithChanges('stop-cs-inprogress', [
    { id: 'CHG-20260607-03', status: 'in-progress', task: '[/]', approved: true, changeSet: 'review-gate', changeSetSeq: '3/4' },
    { id: 'CHG-20260607-04', status: 'planned', task: '[ ]', approved: false, changeSet: 'review-gate', changeSetSeq: '4/4' },
  ], { walkToday: false });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2, '有 in-progress 阻断项仍应 exit 2，change-set 软提醒不得降级阻断');
  // 钉住「软提醒不得泄漏进 warnings」——若 change-set 提醒被误 push 进 warnings，阻断 stderr 会含其文案
  assert.ok(!r.stderr.includes('未执行成员'), 'change-set 软提醒文案不得出现在阻断 stderr（必须走 softReminders，不进 warnings）');
});

test('STOP-cs3. change-set 成员全为 foreign owner → 不催当前 session（CS-FOREIGN 回归）', () => {
  const dir = makeV6ProjectWithChanges('stop-cs-foreign', [
    { id: 'CHG-20260607-03', status: 'planned', task: '[ ]', approved: false, changeSet: 'review-gate', changeSetSeq: '3/4' },
    { id: 'CHG-20260607-04', status: 'planned', task: '[ ]', approved: false, changeSet: 'review-gate', changeSetSeq: '4/4' },
  ], { walkToday: false });
  // 两个成员都由别的 session 拥有（foreign-fresh）；当前 session 提供 session_id 才会判 foreign（STOP-03）
  seedChangeOwner(dir, 'CHG-20260607-03', { sessionId: 'sid-other', state: 'active' });
  seedChangeOwner(dir, 'CHG-20260607-04', { sessionId: 'sid-other', state: 'active' });
  const r = runHook('stop.js', { cwd: dir, stdin: { session_id: 'sid-current' } });
  assert.strictEqual(r.code, 0, '全 foreign + 无本 session 阻断项 → 放行');
  assert.ok(!r.stdout.includes('未执行成员') && !r.stderr.includes('未执行成员'),
    'CS-FOREIGN：foreign-owner 的 change-set 成员不应催当前 session approve-and-start（与 session-start 进度注入对称）');
});

test('STOP-cs4. change-set 自有成员仍催（CS-FOREIGN 对照：本 session 拥有不跳过）', () => {
  const dir = makeV6ProjectWithChanges('stop-cs-self', [
    { id: 'CHG-20260607-03', status: 'planned', task: '[ ]', approved: false, changeSet: 'review-gate', changeSetSeq: '3/4' },
    { id: 'CHG-20260607-04', status: 'planned', task: '[ ]', approved: false, changeSet: 'review-gate', changeSetSeq: '4/4' },
  ], { walkToday: false });
  // 成员由当前 session 拥有 → 不是 foreign → 仍应催（钉住 foreign 跳过没有误伤自有成员）
  seedChangeOwner(dir, 'CHG-20260607-03', { sessionId: 'sid-current', state: 'active' });
  seedChangeOwner(dir, 'CHG-20260607-04', { sessionId: 'sid-current', state: 'active' });
  const r = runHook('stop.js', { cwd: dir, stdin: { session_id: 'sid-current' } });
  assert.strictEqual(r.code, 0, '无阻断项 → 放行');
  assert.ok(r.stdout.includes('未执行成员') || r.stderr.includes('未执行成员'),
    '本 session 自有的 change-set 成员仍应催 approve-and-start（foreign 跳过不得误伤自有）');
});

test('STOP-cs5. deferred + change-set 提醒按 CHG-ID/seq 升序展示（batch create prepend 倒序修复）', () => {
  // batch create 把每个新 CHG 索引行 prepend 到活跃区顶部，物理顺序成创建倒序（08→05）。
  // 这里用倒序数组模拟该物理顺序，钉住 Stop 软提醒输出为正序——下一个该 approve-and-start 的成员排最前。
  const dir = makeV6ProjectWithChanges('stop-cs-order', [
    { id: 'CHG-20260608-08', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false, changeSet: 'layered-inject', changeSetSeq: '5/5' },
    { id: 'CHG-20260608-07', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false, changeSet: 'layered-inject', changeSetSeq: '4/5' },
    { id: 'CHG-20260608-06', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false, changeSet: 'layered-inject', changeSetSeq: '3/5' },
    { id: 'CHG-20260608-05', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false, changeSet: 'layered-inject', changeSetSeq: '2/5' },
  ], { walkToday: false });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 0, '无 in-progress 阻断项应放行');
  const msg = JSON.parse(r.stdout).systemMessage;
  // 1) deferred 单条：CHG-05（下一个该做）必须排在 CHG-08（最后阶段）之前
  const i05 = msg.indexOf('CHG-20260608-05 backlog');
  const i08 = msg.indexOf('CHG-20260608-08 backlog');
  assert.ok(i05 > -1 && i08 > -1, 'deferred 单条应同时列出 CHG-05 与 CHG-08');
  assert.ok(i05 < i08, `deferred 提醒应按 CHG-ID 升序（CHG-05 在 CHG-08 前），实际 i05=${i05} i08=${i08}`);
  // 2) change-set 成组 seqs 升序（与 id 升序一致，因 batch create 连号）
  assert.ok(msg.includes('2/5, 3/5, 4/5, 5/5'), `change-set seqs 应升序「2/5, 3/5, 4/5, 5/5」，实际 systemMessage：${msg}`);
  assert.ok(!msg.includes('5/5, 4/5, 3/5, 2/5'), 'change-set seqs 不应为倒序');
});

test('N07. Stop verify 警告用专属前缀（completed 未验证 → 「请先完成验证 / 审计收尾」，不落「不要执行新任务」）', () => {
  const dir = makeV6Project('stop-verify-prefix', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: false }),
  });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2, 'completed 未验证应 Stop BLOCK（exit 2）');
  assert.ok(r.stderr.includes('请先完成验证 / 审计收尾'), 'verify 警告应用专属前缀');
  assert.ok(!r.stderr.includes('请仅修复以下检查项，不要执行新任务'), 'verify 警告不应落默认前缀「不要执行新任务」');
});

test('2a. SessionStart CHG 执行上下文按详情 pending T-NNN 提示', () => {
  const dir = makeV6Project('ss-v6-detail-pending', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('当前执行中的 CHG 有 1 个未完成 T-NNN'));
  assert.ok(r.stdout.includes('=== CHG 执行上下文 ==='));
  assert.ok(r.stdout.includes('Claude 任务面板只是工作记忆，按需要使用'));
  assert.ok(!r.stdout.includes('=== Claude 任务列表同步 ==='));
  assert.ok(!r.stdout.includes('请让 Claude 任务列表反映'));
});

test('2b. SessionStart 仅索引活跃但详情无 pending 时不夸大任务列表', () => {
  const dir = makeV6Project('ss-v6-index-only', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: true }),
  });
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('待 close-chg'));
  assert.ok(!r.stdout.includes('请为当前活跃 CHG 的未完成 T-NNN'));
});

test('2c. SessionStart 不把 planned backlog 计入当前执行上下文', () => {
  const dir = makeV6ProjectWithChanges('ss-v6-backlog-only', [
    { id: 'CHG-20260504-01', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false },
    { id: 'CHG-20260504-02', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false },
  ]);
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('category=backlog'));
  assert.ok(!r.stdout.includes('当前执行中的 CHG 有 2 个未完成 T-NNN'));
  assert.ok(r.stdout.includes('当前没有执行中的未完成 T-NNN'));
});

test('2d. SessionStart 超大注入被 budget 截防爆 + 给路径化提示', () => {
  const dir = makeV6Project('ss-output-guard');
  // 1200 行是不现实的极端 task.md（CHG 索引正常有界）。M3 T-001/T-002：task.md 不在类内截断列表，
  //   超大块在 l3 被 assembleWithBudget 整条 omit（防爆 10K 注入预算正是移 l3 的初衷）。
  //   原断言「含 === task.md ===」在移 l3 后不成立，但这是预期防爆行为：超大块被 budget 省略 + 留路径提示。
  const huge = Array.from({ length: 1200 }, (_, i) => `- [ ] [[chg-20260504-99]] 超长任务 ${i} ${'x'.repeat(90)}`).join('\n');
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${huge}\n<!-- ARCHIVE -->\n`, 'utf8');
  const r = runHookDetailed('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(r.code, 0);
  // 防爆：超大块被 budget 截到远小于 9500 chars 预算（原 50000 字节守卫只是极端兜底，正常不触发）。
  assert.ok(r.stdout.length < 9500, `超大注入应被 budget 截到 <9500 chars，实际 ${r.stdout.length}`);
  // 路径提示：budget 省略 footer 指引按需 Read 对应 artifact（防爆后不丢失定位线索）。
  assert.ok(r.stdout.includes('相关提醒已省略'), 'budget 省略 footer 应提示有内容被省略');
  assert.ok(r.stdout.includes('按需 Read 对应 artifact'), 'budget 省略 footer 应给路径化 Read 提示');
});

test('2d2. SessionStart 对缺失 ARCHIVE 的双区大文件截断注入兜底，防全文灌爆 context（层2）', () => {
  const dir = makeV6Project('ss-archive-missing');
  // findings.md 故意无 <!-- ARCHIVE --> 标记 + 大量开放 [ ] 项（400 条 P3）+ 超 30000 字符。
  // 纯英文 filler 保证字符数≈字节数，便于把总输出控制在 50KB 全局截断阈值内——确保测的是层2 而非全局截断。
  // M3 T-002：findings 缺 ARCHIVE 改走「impact 优先类内截断（P0/P1 全 + P2/P3 最近 5）+ 缺失警告 footer」，
  //   不再是 mid-line 字节切。防灌爆由「块从 36KB 缩到几百字符（395 条 P2/P3 折成长尾指针）」证明，
  //   ARCHIVE 缺失 footer 在缩小后可达（与 2d3 同机制）。
  const filler = '- [ ] [[finding-open-x]] open research placeholder abcxyz [date:: 2026-01-01] [impact:: P3]\n';
  const huge = '# 调研记录\n\n## 未解决问题\n\n' + filler.repeat(400) + 'UNIQUE_TAIL_MARKER_ZZZ\n';
  fs.writeFileSync(path.join(dir, 'findings.md'), huge, 'utf8');
  const r = runHookDetailed('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(r.code, 0);
  assert.ok(huge.length > 30000, `fixture 应超 ARCHIVE_MISSING_INJECT_LIMIT，实际 ${huge.length}`);
  assert.ok(Buffer.byteLength(r.stdout, 'utf8') < 50000, '总输出仍 < 50KB，确保是层2 截断而非全局 50KB 截断主导');
  // 防灌爆：400 条开放 [ ] 不应全量注入，绝大多数 P2/P3 被折成长尾指针（块体积远小于全文）。
  assert.ok(r.stdout.includes('另有') && r.stdout.includes('P2/P3 finding'), 'findings 大量 P2/P3 折成长尾指针——证明 impact 截断缩小了缺 ARCHIVE 全文');
  assert.ok((r.stdout.match(/finding-open-x/g) || []).length <= 5, '开放 P3 仅注入最近 5 条（其余折叠），不全量灌爆');
  assert.ok(r.stdout.includes('缺少 <!-- ARCHIVE -->'), '应含层2 ARCHIVE 缺失截断警告（缩小后可达）');
});

test('2d3. SessionStart 缺 ARCHIVE 的 CJK 大文件层2 截断后警告 footer 仍可达（ARCH-01 字节截断）', () => {
  const dir = makeV6Project('ss-archive-missing-cjk');
  // findings.md 全中文（CJK ~3 字节/字符）+ 无 ARCHIVE 标记 + 超阈值。
  // ARCH-01：char 截断 30000 字符≈90000 字节，被全局 46000 字节守卫抢先截断，footer 永不可达——字节截断修复。
  const cjkLine = '- [ ] [[调研项占位]] 这是一条未解决的中文调研记录占位内容用于撑大文件体积以触发层2截断兜底 [date:: 2026-01-01] [impact:: P3]\n';
  const huge = '# 调研记录\n\n## 未解决问题\n\n' + cjkLine.repeat(900) + '中文尾部唯一标记\n';
  fs.writeFileSync(path.join(dir, 'findings.md'), huge, 'utf8');
  const r = runHookDetailed('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(r.code, 0);
  assert.ok(Buffer.byteLength(huge, 'utf8') > 46000, `fixture 字节数应超全局守卫，实际 ${Buffer.byteLength(huge, 'utf8')}`);
  assert.ok(r.stdout.includes('缺少 <!-- ARCHIVE -->'), 'CJK 大文件的 ARCHIVE 缺失 footer 应可达（字节截断后）');
});

test('2e. SessionStart walkthrough 截断保留最近日期记录', () => {
  // M2：walkthrough 表格类内截断保留最近 10 行（design L0，从 M3 的 3 回归 10）。
  const dir = makeV6Project('ss-walkthrough-recent', { walkToday: false });
  const rows = Array.from({ length: 12 }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return `| 2026-05-${day} | smoke ${day} | CHG-20260504-01 |`;
  }).join('\n');
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), `# 工作记录\n\n## 最近工作\n\n| 日期 | 完成内容 | 关联变更 |\n| --- | --- | --- |\n${rows}\n<!-- ARCHIVE -->\n`, 'utf8');
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(r.code, 0);
  // 12 行 → 保留最近 5 行（05-12..05-08），省略最旧 7（05-07..05-01）（CHG-20260614-15 WALK_KEEP 10→5）。
  assert.ok(r.stdout.includes('| 2026-05-12 | smoke 12 | CHG-20260504-01 |'));
  assert.ok(r.stdout.includes('| 2026-05-08 | smoke 08 | CHG-20260504-01 |'), '最近 5 之一 05-08 应保留');
  assert.ok(!r.stdout.includes('| 2026-05-07 | smoke 07 | CHG-20260504-01 |'), '第 6 新及更旧应被省略');
  assert.ok(!r.stdout.includes('| 2026-05-01 | smoke 01 | CHG-20260504-01 |'));
  assert.ok(r.stdout.includes('已省略 7 条旧记录'), '应附「已省略 7 条旧记录」长尾指针');
  assert.ok(r.stdout.indexOf('2026-05-12') < r.stdout.indexOf('2026-05-11'));
});

test('2e2. SessionStart walkthrough 详情段落截断同日多条保留最新而非最旧', () => {
  // v6 实际格式：walkthrough active 区是 `## YYYY-MM-DD [[slug]]` 详情段落，
  // close-chg prepend（最新在最前）。当同一天多条记录时，date 主键比较相等，
  // 截断排序会落到 index tie-breaker；prepend 下 index 小=新，必须保留最新而非最旧。
  const dir = makeV6Project('ss-walkthrough-detail-same-day', { walkToday: false });
  const detail = [
    '# 工作记录',
    '',
    '## 最近工作',
    '',
    '## 2026-06-04 [[chg-20260604-03]] 第三个变更最新',
    '正文三',
    '',
    '## 2026-06-04 [[chg-20260604-02]] 第二个变更',
    '正文二',
    '',
    '## 2026-06-04 [[chg-20260604-01]] 第一个变更',
    '正文一',
    '',
    '## 2026-06-04 [[hotfix-20260604-01]] 最旧修复',
    '正文修复',
    '',
    '<!-- ARCHIVE -->',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), detail, 'utf8');
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(r.code, 0);
  // 4 条同日 → 保留最新 3 条（chg-03/02/01），省略最旧 1 条（hotfix-01）
  assert.ok(r.stdout.includes('chg-20260604-03'), '最新条目 chg-03 必须保留');
  assert.ok(r.stdout.includes('chg-20260604-02'));
  assert.ok(r.stdout.includes('chg-20260604-01'));
  assert.ok(!r.stdout.includes('hotfix-20260604-01'), '最旧条目 hotfix-01 应被省略');
  assert.ok(r.stdout.includes('已省略 1 条旧详情'));
});

test('2e3. SessionStart walkthrough 表格截断同日多条保留最新（prepend 最新在顶）', () => {
  // walkthrough active 区表格是 prepend（最新在顶、index 小=新），与详情段落一致。
  // 同一天 >10 条时 date 主键相等落到 index tie-breaker；prepend 下 index 小=新，保留最新而非最旧。
  const dir = makeV6Project('ss-walkthrough-table-same-day', { walkToday: false });
  const rows = Array.from({ length: 11 }, (_, i) => {
    const n = String(11 - i).padStart(2, '0'); // index0=11(最新) … index10=01(最旧)
    return `| 2026-06-04 | [[chg-20260604-${n}]] smoke ${n} | CHG-20260604-${n} |`;
  }).join('\n');
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), `# 工作记录\n\n## 最近工作\n\n| 日期 | 完成内容 | 关联变更 |\n| --- | --- | --- |\n${rows}\n<!-- ARCHIVE -->\n`, 'utf8');
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(r.code, 0);
  // 11 条同日 → 保留最新 5（smoke 11..07，prepend index0~4），省略最旧 6（smoke 06..01）（CHG-20260614-15 WALK_KEEP 10→5）。
  assert.ok(r.stdout.includes('smoke 11'), '最新条目 smoke 11（prepend index0）必须保留');
  assert.ok(r.stdout.includes('smoke 07'), '最新 5 条之一 smoke 07 应保留');
  assert.ok(!r.stdout.includes('smoke 06'), '第 6 新及更旧应被省略');
  assert.ok(!r.stdout.includes('smoke 01'), '最旧条目 smoke 01 应被省略');
});

test('2f. SessionStart owner-aware：foreign running CHG 不计入当前执行上下文（core group）', () => {
  // core group：注入活跃 CHG 摘要（owner=foreign-fresh + 执行上下文），不含 artifact 文件折叠。
  const dir = makeV6ProjectWithChanges('ss-owner-aware-foreign-running', [{
    id: 'CHG-20260504-02',
    title: '外部 worktree 任务标题',
    indexMark: '[/]',
    status: 'in-progress',
    task: '[/]',
    approved: true,
  }]);
  seedChangeOwner(dir, 'CHG-20260504-02', {
    sessionId: 'sid-other-session',
    state: 'active',
    worktree: 'wt-a',
    branch: 'feature-a',
  });
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), fs.readFileSync(path.join(dir, 'implementation_plan.md'), 'utf8').replace(
    '<!-- ARCHIVE -->',
    '## 活跃变更详情\n\n### [[chg-20260504-02|外部详情别名]]\n\nforeign detail body\n\n<!-- ARCHIVE -->'
  ), 'utf8');
  const r = runHook('session-start.js', {
    cwd: dir,
    stdin: { type: 'startup', session_id: 'sid-current-session' },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('owner=foreign-fresh'));
  assert.ok(r.stdout.includes('其他 worktree/session 活跃 CHG'));
  assert.ok(r.stdout.includes('CHG-20260504-02'));
  assert.ok(!r.stdout.includes('当前执行中的 CHG 有 1 个未完成 T-NNN'));
  assert.ok(!r.stdout.includes('这些 CHG 不计入当前 session 的 Claude 任务列表'));
});

test('2f-art. SessionStart owner-aware：artifact group 的 foreign CHG 折叠', () => {
  // artifact group：task.md/implementation_plan.md 中 foreign CHG 索引行被折叠。
  const dir = makeV6ProjectWithChanges('ss-owner-aware-foreign-art', [{
    id: 'CHG-20260504-02',
    title: '外部 worktree 任务标题',
    indexMark: '[/]',
    status: 'in-progress',
    task: '[/]',
    approved: true,
  }]);
  seedChangeOwner(dir, 'CHG-20260504-02', {
    sessionId: 'sid-other-session',
    state: 'active',
    worktree: 'wt-a',
    branch: 'feature-a',
  });
  const r = runHook('session-start.js', {
    cwd: dir,
    stdin: { type: 'startup', session_id: 'sid-current-session' },
    args: ['--group', 'artifact'],
  });
  assert.strictEqual(r.code, 0);
  // v7：impl_plan 不再注入（ARTIFACT_FILES 退役），折叠语义只对 task.md 生效。
  assert.ok(r.stdout.includes('已折叠 1 个其他 worktree/session owner 的 CHG'));
  assert.ok(!r.stdout.includes('外部 worktree 任务标题'));
  assert.ok(!r.stdout.includes('=== implementation_plan.md ==='), 'v7: impl_plan 文件块不再注入');
});

test('2g. SessionStart 将当前 blocked CHG 单独展示且不计入执行中 T-NNN', () => {
  const dir = makeV6Project('ss-blocked-not-current-todo', {
    indexMark: '[!]',
    detail: chgDetail({ status: 'in-progress', task: '[!]', approved: true }),
  });
  const r = runHook('session-start.js', {
    cwd: dir,
    stdin: { type: 'startup', session_id: 'sid-blocked-current' },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('=== 暂停/阻塞 CHG ==='));
  assert.ok(r.stdout.includes('CHG-20260504-01'));
  assert.ok(!r.stdout.includes('当前执行中的 CHG 有 1 个未完成 T-NNN'));
  assert.ok(!r.stdout.includes('这些 CHG 不计入当前 session 的 Claude 任务列表'));
});

test('2h. SessionStart spec.md 截断保留禁止事项但省略依赖列表', () => {
  const dir = makeV6Project('ss-spec-prohibitions', { withIndex: false, detail: false });
  fs.writeFileSync(path.join(dir, 'spec.md'), [
    '# Spec',
    '',
    '## 项目概述',
    'overview',
    '',
    '## 技术栈',
    'node',
    '',
    '## 禁止事项',
    '- 禁止使用 legacy-api',
    '',
    '## 依赖列表',
    '- very-long-dependency-list',
    '',
  ].join('\n'), 'utf8');
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(r.code, 0);
  // M3 T-002：spec 类内摘要砍「目录/依赖列表」但保留禁止事项（约束段不可丢，AI 不可违反）+ 概述/技术栈。
  assert.ok(r.stdout.includes('禁止使用 legacy-api'), '禁止事项约束段必须保留');
  assert.ok(r.stdout.includes('overview') && r.stdout.includes('node'), '项目概述/技术栈应保留');
  assert.ok(!r.stdout.includes('very-long-dependency-list'), '依赖列表应被省略');
  assert.ok(r.stdout.includes('已省略 spec 目录/依赖列表'), '应附 spec 摘要长尾指针');
});

test('2i. SessionStart findings 过期提醒正确解析 wikilink display 标题', () => {
  const dir = makeV6Project('ss-findings-aging-title', { withIndex: false, detail: false });
  fs.writeFileSync(path.join(dir, 'findings.md'), [
    '# 调研记录',
    '',
    '## 摘要索引',
    '',
    '- [ ] [[finding-2000-01-01-login|登录优化]] — 结论 [date:: 2000-01-01] [impact:: P1]',
    '',
    '<!-- ARCHIVE -->',
    '',
  ].join('\n'), 'utf8');
  // agedFindings 三元组（W12 flag 写 + collectAgedFindings 读 + renderAgedFindings 渲染）整体归 artifact group
  //   （CHG-11/T-001：与 W12 flag 同 group 才时序自洽）。过期提醒只在 --group artifact 注入。
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('Findings 过期提醒'));
  assert.ok(r.stdout.includes('登录优化'));
  assert.ok(!r.stdout.includes('(2000天) ['));
});

test('MH-1. SessionStart --group core 注入工作流入口、不含 artifact 文件块', () => {
  // 验证 core group 只注入项目骨架（工作流入口/活跃 CHG），不含 artifact 文件循环内容。
  const dir = makeV6Project('mh-core');
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'core'] });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('=== PACEflow 工作流入口 ==='), 'core group 应含工作流入口');
  assert.ok(!r.stdout.includes('=== findings.md ==='), 'core group 不含 findings.md 文件块');
});

test('MH-2. SessionStart --group artifact 注入 artifact 文件块、不含工作流入口', () => {
  // 验证 artifact group 只注入文件内容（task/findings 等），不含工作流入口。
  const dir = makeV6Project('mh-artifact');
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('=== PACEflow 工作流入口 ==='), 'artifact group 不含工作流入口');
  assert.ok(r.stdout.includes('=== task.md ===') || r.stdout.includes('=== findings.md ==='), 'artifact group 应含 artifact 文件块');
});

test('MH-fmt. 格式合规警告在 artifact group 注入、core group 不注入（R 审计发现 A 回归守卫）', () => {
  // 格式警告依赖 implFullForFormat/found（artifact 文件），数据只在 artifact group 读。
  // T-003 曾把渲染放 core 块致 found 恒空、双 hook 后 artifact 块又不渲染 → 全 group 丢失。本测试守卫该回归。
  const dir = makeV6Project('ss-fmt-warn-group');
  // v7：格式检测基于 task.md（唯一索引）——故意放 2 个 ARCHIVE 标记（格式违规：会致活跃区识别错误）。
  fs.writeFileSync(path.join(dir, 'task.md'),
    '# 项目任务追踪\n\n## 活跃任务\n\n- [/] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n\n<!-- ARCHIVE -->\n\n<!-- ARCHIVE -->\n', 'utf8');
  const core = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'core'] });
  const art = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.strictEqual(core.code, 0);
  assert.strictEqual(art.code, 0);
  assert.ok(!core.stdout.includes('=== 格式合规警告 ==='), 'core group 不注入格式警告（数据在 artifact group）');
  assert.ok(art.stdout.includes('=== 格式合规警告 ==='), 'artifact group 注入格式警告（发现 A 修复后）');
});

test('MH-aged. findings 过期提醒在 artifact group 注入、core group 不注入（三元组同 group 回归守卫）', () => {
  // agedFindings 三元组（W12 flag 写 + 读 + 渲染）整体归 artifact group（CHG-11/T-001）：artifact 注入、core 不注入。
  // 守卫「三元组拆 group 致时序割裂（core 写 flag → artifact 读到已存在 → 永不注入）」回归（原发现 B2）。
  const dir = makeV6Project('ss-aged-group', { withIndex: false, detail: false });
  fs.writeFileSync(path.join(dir, 'findings.md'),
    '# 调研记录\n\n## 摘要索引\n\n- [ ] [[finding-2000-01-01-x|过期项]] — 结论 [date:: 2000-01-01] [impact:: P1]\n\n<!-- ARCHIVE -->\n', 'utf8');
  const art = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  // core 与 artifact 用各自独立 fixture，避免 artifact 先跑写 flag 污染 core 判定（实际生产双 hook 各跑各项目态）。
  const dir2 = makeV6Project('ss-aged-group-core', { withIndex: false, detail: false });
  fs.writeFileSync(path.join(dir2, 'findings.md'),
    '# 调研记录\n\n## 摘要索引\n\n- [ ] [[finding-2000-01-01-x|过期项]] — 结论 [date:: 2000-01-01] [impact:: P1]\n\n<!-- ARCHIVE -->\n', 'utf8');
  const core = runHook('session-start.js', { cwd: dir2, stdin: { type: 'startup' }, args: ['--group', 'core'] });
  assert.strictEqual(core.code, 0);
  assert.strictEqual(art.code, 0);
  assert.ok(art.stdout.includes('Findings 过期提醒'), 'artifact group 注入过期提醒（agedFindings 三元组归 artifact）');
  assert.ok(!core.stdout.includes('Findings 过期提醒'), 'core group 不注入过期提醒（三元组已移 artifact）');
});

test('MH-3. --group core 不写 findings-age flag（W12 归 artifact）', () => {
  // W12 写 flag 随三元组移 artifact：core 即便 findings.md 有活跃内容也不写 flag。
  const dir = makeV6Project('mh-w12-core', { withIndex: false, detail: false });
  fs.writeFileSync(path.join(dir, 'findings.md'),
    '# 调研记录\n\n## 摘要索引\n\n- [ ] [[finding-2000-01-01-x|过期项]] — 结论 [date:: 2000-01-01] [impact:: P1]\n\n<!-- ARCHIVE -->\n', 'utf8');
  const flag = path.join(dir, '.pace', `findings-age-${today()}`);
  runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'core'] });
  assert.ok(!fs.existsSync(flag), 'core 不写 W12 flag');
});

test('MH-4. --group artifact 写 findings-age flag', () => {
  // W12 写 flag 归 artifact：artifact group 在 findings.md 有活跃内容时写当日去重 flag。
  const dir = makeV6Project('mh-w12-art', { withIndex: false, detail: false });
  fs.writeFileSync(path.join(dir, 'findings.md'),
    '# 调研记录\n\n## 摘要索引\n\n- [ ] [[finding-2000-01-01-x|过期项]] — 结论 [date:: 2000-01-01] [impact:: P1]\n\n<!-- ARCHIVE -->\n', 'utf8');
  const flag = path.join(dir, '.pace', `findings-age-${today()}`);
  runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, args: ['--group', 'artifact'] });
  assert.ok(fs.existsSync(flag), 'artifact 写 W12 flag');
});

test('MH-5. compact 无快照文件时正常实时注入（快照退役）', () => {
  // M4/T-002：PreCompact 快照机制退役后，compact 与 startup 走同一条实时读 artifact 路径（A0 对称）。
  //   compact 不再读 pre-compact-state.json、不再有「Compact 恢复（快照…）」段；
  //   core group 在 compact 下也实时注入工作流入口（renderWorkflowEntry 去掉 compact 守卫）。
  const dir = makeV6Project('mh-compact');
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'compact' }, args: ['--group', 'core'] });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('=== PACEflow 工作流入口 ==='), 'compact core 实时注入工作流入口（A0 对称）');
  assert.ok(!r.stdout.includes('快照'), '不再有快照恢复段');
});

test('3a. SessionStart 清理每会话 .pace 运行态 flags', () => {
  const currentFindingsAgeFlag = `findings-age-${today()}`;
  const dir = makeV6Project('ss-session-flags', {
    paceRuntime: {
      'archive-reminded-chg-20260504-01': '1',
      'status-mismatch-chg-20260504-01': '1',
      'verify-missing-chg-20260504-01': '1',
      'blocked-tasks-chg-20260504-01': '1',
      'cli-refresh-done': '1',
      'task-list-used': '1',
      'findings-age-2000-01-01': '1',
      [currentFindingsAgeFlag]: '1',
    },
  });
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'archive-reminded-chg-20260504-01')));
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'status-mismatch-chg-20260504-01')));
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'verify-missing-chg-20260504-01')));
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'blocked-tasks-chg-20260504-01')));
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'cli-refresh-done')));
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'task-list-used')));
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'findings-age-2000-01-01')), '历史 findings 去重 flag 应按日期清理');
  assert.ok(fs.existsSync(path.join(dir, '.pace', currentFindingsAgeFlag)), '当日 findings 去重 flag 不应按 session 清理');
});

console.log('\n--- pre-tool-use.js ---');

test('4. 非 PACE 项目放行', () => {
  const dir = makeTmpDir('ptu-empty');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('deny'));
});

test('5. v6 无活跃 CHG → DENY', () => {
  const dir = makeV6Project('ptu-no-active', { withIndex: false, detail: false });
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.ok(r.stdout.includes('deny'));
  assert.ok(r.stdout.includes('create-chg'));
  assert.ok(r.stdout.includes(`artifact_dir: ${dir.replace(/\\/g, '/')}/`));
  assert.ok(r.stdout.includes('operation: create-chg'));
});

test('6. v6 未批准 → DENY approve-and-start', () => {
  const dir = makeV6Project('ptu-unapproved', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
  });
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.ok(r.stdout.includes('deny'));
  assert.ok(r.stdout.includes('approve-and-start'));
});

test('6a. v6 malformed 索引行 → DENY 索引格式修复而非继续执行', () => {
  const dir = makeV6Project('ptu-malformed-index', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
  });
  const malformed = '<!-- 详情与任务清单位于 changes/<id>.md；本文件只保留索引。 -->- [ ] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n';
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('索引行格式损坏'));
  assert.ok(r.stdout.includes('独占一行'));
});

test('6b. v6 缩进索引行 → DENY 索引格式修复而非静默无活跃 CHG', () => {
  const dir = makeV6Project('ptu-indented-index', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
  });
  const malformed = '  - [ ] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n';
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('索引行格式损坏'));
});

test('6c. v6 无 tag 的粘连 malformed CHG 行 → DENY 索引格式修复', () => {
  const dir = makeV6Project('ptu-malformed-index-plain', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
  });
  const malformed = '说明文字- [ ] [[chg-20260504-01]] 测试变更\n';
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('索引行格式损坏'));
});

test('7. v6 已批准但未 in-progress → DENY update-status', () => {
  const dir = makeV6Project('ptu-approved-planned', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: true }),
  });
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.ok(r.stdout.includes('deny'));
  assert.ok(r.stdout.includes('update-status'));
  assert.ok(r.stdout.includes('approve-and-start'));
});

test('8. v6 in-progress → additionalContext 放行', () => {
  const dir = makeV6Project('ptu-pass');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('additionalContext'));
  assert.ok(!r.stdout.includes('"deny"'));
});

test('8z. 详情存在 [!] 暂停/阻塞任务时即使根索引仍 [/] 也不放行代码写入', () => {
  const dir = makeV6Project('ptu-blocked-detail-deny', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[!]', approved: true }),
  });
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('[!] 暂停/阻塞任务'));
});

test('8a2. artifact-writer 写普通项目文件(非代码)放行——非代码不进流程门（CHG-20260616-01；8a 场景已并入 CGS-1）', () => {
  const dir = makeV6Project('ptu-artifact-writer-non-artifact-unapproved', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-agent-non-artifact',
    agentId: 'agent-non-artifact',
    state: 'active',
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-non-artifact',
      agent_id: 'agent-non-artifact',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, 'README.md'),
        content: 'docs\n',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), '非代码文件一律放行，不进 C/E 门');
  assert.ok(!r.stdout.includes('C 阶段未完成'));
});

test('V7H-1. sweepStaleRuntimeOwners 用内部 timestampMs 判 stale（非文件 mtime）（CHG-20260614-02 T-001）', () => {
  const pu = require('../plugin/hooks/pace-utils');
  const dir = makeV6Project('v7h-sweep-internal-ts');
  const now = Date.now();
  // 内部 timestampMs 已 stale（40min）但文件刚写 mtime≈now（fresh）——旧实现按 mtime 不清，新实现按内部 ts 清
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-x', timestampMs: now - 40 * 60 * 1000 });
  seedChangeOwner(dir, 'CHG-20260504-02', { sessionId: 'sid-x', timestampMs: now });
  const swept = pu.sweepStaleRuntimeOwners(dir, { now });
  assert.ok(swept.some(p => /chg-20260504-01/.test(p)), '内部 timestampMs stale 的 owner 被清（非文件 mtime）');
  assert.ok(!swept.some(p => /chg-20260504-02/.test(p)), '内部 timestampMs fresh 的 owner 保留');
});

test('V7H-2. heartbeat states 扩到 blocked——活跃 session 的 blocked owner 被刷新不误清（CHG-20260614-02 T-001）', () => {
  const dir = makeV6Project('v7h-heartbeat-blocked');
  const old = Date.now() - 40 * 60 * 1000;
  const ownerFp = seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-live', state: 'blocked', timestampMs: old });
  runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-live', tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'src.js'), old_string: 'a', new_string: 'b' } },
  });
  const owner = JSON.parse(fs.readFileSync(ownerFp, 'utf8'));
  assert.ok(owner.timestampMs > old, 'blocked owner 的 timestampMs 被 heartbeat 刷新（不再被 sweep 误清）');
});

test('V7H-3. 写盘 owner 复核——artifact-writer Edit foreign-owned CHG 详情 → DENY（CHG-20260614-02 T-002）', () => {
  const dir = makeV6Project('v7h-write-foreign');
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-foreign', agentId: 'agent-foreign', state: 'active', timestampMs: Date.now() });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-mine', agent_id: 'agent-mine', agent_type: 'paceflow:artifact-writer', tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'changes', 'chg-20260504-01.md'), old_string: '# 测试变更', new_string: '# 测试变更 x' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'foreign owner 的 CHG 详情写入应 deny');
});

test('V7H-4. 写盘 owner 复核——artifact-writer Edit 自己 session 的 CHG 详情 → 放行（不误伤）（CHG-20260614-02 T-002）', () => {
  const dir = makeV6Project('v7h-write-own');
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-mine', agentId: 'agent-mine', state: 'active', timestampMs: Date.now() });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-mine', agent_id: 'agent-mine', agent_type: 'paceflow:artifact-writer', tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'changes', 'chg-20260504-01.md'), old_string: '# 测试变更', new_string: '# 测试变更 x' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), '自己 session 的 CHG 详情写入放行');
});

test('8b. 当前 session owner 的 in-progress 非代码写入放行、不再注入 CHG 摘要（CHG-20260616-01：摘要注入随第二分支移除）', () => {
  const dir = makeV6Project('ptu-current-owner-non-code-pass');
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-current-non-code-pass',
    agentId: 'agent-current-non-code-pass',
    state: 'active',
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-current-non-code-pass',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, 'README.md'),
        content: 'docs\n',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), '非代码 in-progress 写入仍放行');
  assert.ok(!r.stdout.includes('当前活跃变更'), '非代码写入不进流程门，不再注入活跃变更摘要（执行期上下文由 AI 自管）');
});

test('8c. foreign fresh owner 不阻断当前 session 普通非代码写入', () => {
  const dir = makeV6Project('ptu-foreign-owner-non-code-pass', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-foreign-owner',
    agentId: 'agent-foreign-owner',
    state: 'active',
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-current-other',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, 'README.md'),
        content: 'docs\n',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

test('8c1. 同 worktree 不同 session：sibling-fresh 的 CHG 不构成新 session 的非代码 gate（CHG-20260611-02 语义变更）', () => {
  // 旧语义：同 checkout 即 current-worktree（current:true），新 session 自动继承旧 session owner
  // 的 C/E gate（deny「E 阶段未就绪」）。CHG-20260611-02 细分后 sibling-fresh current:false——
  // B 写非代码文件回归「无自有活跃 CHG 不 gate」基线；接续工作走 detached/takeover 流。
  const dir = makeV6Project('ptu-same-worktree-owner-non-code-gate', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-previous-session',
    agentId: 'agent-previous-session',
    state: 'ready',
    cwd: dir,
    stateDir: dir,
    worktree: 'main',
    branch: 'main',
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-new-same-worktree',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, 'README.md'),
        content: 'docs\n',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), 'sibling-fresh 的 CHG 不应把非代码 gate 算到新 session 头上：' + r.stdout);
});

test('8d. foreign owner 的结构损坏仍全局阻断非代码写入', () => {
  const dir = makeV6Project('ptu-foreign-owner-non-code-structure-deny', {
    detail: false,
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-foreign-structure',
    agentId: 'agent-foreign-structure',
    state: 'active',
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-current-structure',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, 'README.md'),
        content: 'docs\n',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('详情文件缺失'));
});

test('CGS-1. 删执行期完整性门第二分支后：own actionable 未 runnable CHG 写非代码文件直接放行（写码门只认代码文件）', () => {
  // CHG-20260616-01 T-001：写码门回归单一判据「文件是不是代码」。非代码文件（README/配置/文档）
  // 不再因「本 session 持有 owned CHG」进 C/E 流程门——文档一律放行（完整性门另算，见 CGS-2）。
  const dir = makeV6Project('cgs-non-code-passes', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-cgs-cur', agentId: 'agent-cgs-cur', state: 'active' });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-cgs-cur', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'README.md'), content: 'docs\n' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), '非代码文件不进流程门，直接放行：' + r.stdout);
  assert.ok(!r.stdout.includes('C 阶段未完成'), '不应触发 C 门');
  assert.ok(!r.stdout.includes('E 阶段未就绪'), '不应触发 E 门');
});

test('CGS-2. 删第二分支后完整性门仍对非代码文件生效：own CHG 详情缺失写非代码仍 DENY（结构门独立保留）', () => {
  // structuralCheckNeeded（isCodeFile||isFileMutationTool）独立于第二分支，删除不触及——
  // 索引损坏/详情缺失是 artifact 完整性门，保护 hook 判断可靠性，与流程门分层。
  const dir = makeV6Project('cgs-non-code-structure-deny', { detail: false });
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-cgs-struct', agentId: 'agent-cgs-struct', state: 'active' });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-cgs-struct', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'README.md'), content: 'docs\n' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), '完整性门对非代码文件仍拦');
  assert.ok(r.stdout.includes('详情文件缺失'), '结构门 deny 文案');
});

test('CEX-1. 补主流语言白名单后：无活跃 CHG 写这些扩展名被写码门 DENY（写码门对主流语言启动）（CHG-20260616-01 T-002）', () => {
  for (const ext of ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.rb', '.php', '.cs', '.swift', '.kt', '.kts', '.scala', '.dart', '.lua', '.sh', '.bash', '.zsh', '.ex', '.exs', '.clj', '.cljs', '.cljc', '.hs', '.erl', '.jl', '.mm']) {
    const dir = makeV6Project('ptu-cex-code-' + ext.slice(1), { withIndex: false, detail: false });
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: { session_id: 'sid-cex', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src' + ext), content: 'x\n' } },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'), ext + ' 应被写码门拦（无活跃 CHG）：' + r.stdout);
    assert.ok(r.stdout.includes('create-chg'), ext + ' deny 应提示 create-chg');
  }
});

test('CEX-2. 反向 over-block + 歧义项不补：文档/数据/歧义扩展名无活跃 CHG 写入仍放行（CHG-20260616-01 T-002）', () => {
  // 文档/数据扩展名不该被当代码；歧义项 .m(ObjC/MATLAB)/.r(R/Rebol)/.pl(Perl/Prolog)/.sql 故意不补，宁漏不误伤
  for (const ext of ['.md', '.json', '.txt', '.yaml', '.yml', '.toml', '.csv', '.m', '.r', '.pl', '.sql']) {
    const dir = makeV6Project('ptu-cex-doc-' + ext.slice(1), { withIndex: false, detail: false });
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: { session_id: 'sid-cex', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'data' + ext), content: 'x\n' } },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(!r.stdout.includes('"deny"'), ext + ' 文档/数据/歧义文件不应被误拦：' + r.stdout);
  }
});

test('9. 主 session 直接写 VERIFIED → DENY artifact-writer 操作', () => {
  const dir = makeV6Project('ptu-marker');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->',
      },
    },
  });
  assert.ok(r.stdout.includes('deny'));
  assert.ok(r.stdout.includes('对应批准/验证/审计/收尾操作'));
});

test('9dm. 主 session Edit 把 verified-date/reviewed-date 改非 null（无 comment marker）→ DENY_V6_MARKER（date-only 旁路守护；CHG-20260616-03 T-003 / P3.10）', () => {
  const dir = makeV6Project('ptu-marker-date-only');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  // date-only：new_string 是含 verified-date 非 null 的完整文首 frontmatter（hasNonNullVerifiedDate 只认文首 frontmatter）、
  // 无 <!-- VERIFIED --> comment，仍应被 setVerifiedDate 分支拦。用 Edit（paceSignal=artifact 时让位 marker 门）——
  // 注意 Write 整文件会先撞 DENY_DIRECT_ARTIFACT_WRITE（无 marker 让位守卫），到不了 marker 门，故必须 Edit。
  const baseV = chgDetail({ approved: false });
  const rv = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: baseV, new_string: baseV.replace('verified-date: null', 'verified-date: 2026-06-16T12:00:00+08:00') } },
  });
  assert.ok(rv.stdout.includes('deny'), 'verified-date 改非 null（无 comment）应 DENY');
  assert.ok(rv.stdout.includes('对应批准/验证/审计/收尾操作'), 'marker DENY 文案（date-only，非 DIRECT_ARTIFACT）');
  const baseR = chgDetail({ approved: false });
  const rr = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: baseR, new_string: baseR.replace('reviewed-date: null', 'reviewed-date: 2026-06-16T12:00:00+08:00') } },
  });
  assert.ok(rr.stdout.includes('deny'), 'reviewed-date 改非 null（无 comment）应 DENY');
  assert.ok(rr.stdout.includes('对应批准/验证/审计/收尾操作'), 'reviewed date-only marker DENY 文案');
});

test('9m. MultiEdit 直接写 VERIFIED → DENY artifact-writer 操作', () => {
  const dir = makeV6Project('ptu-marker-multiedit');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: fp,
        edits: [
          {
            old_string: '<!-- APPROVED -->',
            new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->',
          },
        ],
      },
    },
  });
  assert.ok(r.stdout.includes('deny'));
  assert.ok(r.stdout.includes('对应批准/验证/审计/收尾操作'));
});

test('9r. 主 session 直接写 REVIEWED → DENY（精确 REVIEWED 原因码）', () => {
  const dir = makeV6Project('ptu-marker-reviewed');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '<!-- VERIFIED -->',
        new_string: '<!-- VERIFIED -->\n<!-- REVIEWED -->',
      },
    },
  });
  assert.ok(r.stdout.includes('deny'));
  assert.ok(r.stdout.includes('REVIEWED/reviewed-date'));
});

test('9m2. 非 artifact changes/ 路径写 C/V 字符串不触发 marker gate', () => {
  const dir = makeV6Project('ptu-marker-non-artifact-changes');
  const fp = path.join(dir, 'src', 'changes', 'chg-20260508-01.md');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, 'note\n', 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: 'note',
        new_string: 'note\n<!-- VERIFIED -->',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(!r.stdout.includes('action=verify'));
});

test('9pu1. PU-001：file_path 含 ./ 段注入 marker 仍被 artifact 写保护拦截', () => {
  const dir = makeV6Project('ptu-pu001-dotslash');
  // control：正常 changes/ 路径写 marker → deny（现有 marker gate）
  const control = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(dir, 'changes', 'chg-20260504-01.md'),
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->',
      },
    },
  });
  assert.ok(control.stdout.includes('deny'));
  // PU-001：字符串拼接构造含 ./ 段的绝对路径（path.join 会折叠 . 无法复现绕过）；
  // 修复前 ./changes/x.md 不匹配 artifact 正则 → marker-guard 整体跳过 → allow（伪造批准门）
  const injectedFp = dir + '/./changes/chg-20260504-01.md';
  const injected = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Edit',
      tool_input: {
        file_path: injectedFp,
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->',
      },
    },
  });
  assert.ok(injected.stdout.includes('deny'));
});

test('9a. artifact-writer subagent 可写 APPROVED / VERIFIED 标志', () => {
  const dir = makeV6Project('ptu-marker-agent');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const sessionId = seedArtifactWriterLock(dir, 'sid-marker-agent');
  const approve = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: sessionId,
      agent_id: 'agent-test',
      agent_type: 'artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '## 实施详情',
        new_string: '<!-- APPROVED -->\n\n## 实施详情',
      },
    },
  });
  assert.strictEqual(approve.code, 0);
  assert.ok(!approve.stdout.includes('"deny"'));

  const verify = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: sessionId,
      agent_id: 'agent-test',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->\nverified-date: 2026-05-06T12:00:00+08:00',
      },
    },
  });
  assert.strictEqual(verify.code, 0);
  assert.ok(!verify.stdout.includes('"deny"'));
});

test('9aa. 未知 subagent 仍不能写 APPROVED / VERIFIED 标志', () => {
  const dir = makeV6Project('ptu-marker-unknown-agent');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-other',
      agent_type: 'code-reviewer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('artifact-writer'));
});

test('LOG-ISOLATION: 注入 PACE_LOG_PATH 后 hook 日志进 E2E 不进源码树（等价锁，按内容判定免疫并发写）', () => {
  // CHG-20260619-04（修 v7.2.18 审计 P2-2）：原断言比源码树 pace-hooks.log 的 mtime/size before/after，
  // 锚定的是 dogfood（本仓库 PACEflow 激活时跑测试）期间会被 live session hook 并发写的可变资源——
  // 外部写落进 before..assert 窗口即误红（flaky，污染 release gate、训练「重跑即绿」掩盖真回归）。
  // 改按内容正向判定：本测试 hook 日志（含唯一 proj 标识）应进注入的 E2E_LOG_PATH、不进源码树；
  // 无关 session 并发写 proj 标识不同，不误红。保留「某 hook 漏用 createLogger 仍污染源码树」检测意图。
  const srcLog = path.join(HOOKS_DIR, 'pace-hooks.log');
  const readSrc = () => (fs.existsSync(srcLog) ? fs.readFileSync(srcLog, 'utf8') : '');
  const srcBefore = readSrc();
  const e2eBefore = fs.existsSync(E2E_LOG_PATH) ? fs.readFileSync(E2E_LOG_PATH, 'utf8') : '';
  const dir = makeV6Project('log-isolation');
  const proj = path.basename(dir); // 唯一 proj 标识；hook 日志的 proj 字段据此（getProjectName ≈ basename）
  // 覆盖多个会写日志的 hook（pre-tool-use、session-start、stop）
  runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  runHook('session-start.js', { cwd: dir, stdin: {} });
  runHook('stop.js', { cwd: dir, stdin: {} });
  // 正向：本测试 hook 日志进注入的 E2E 独立日志（含 proj 标识）
  const e2eAfter = fs.existsSync(E2E_LOG_PATH) ? fs.readFileSync(E2E_LOG_PATH, 'utf8') : '';
  assert.ok(e2eAfter.length > e2eBefore.length, 'hook 应写入注入的 E2E 独立日志而非源码树');
  assert.ok(e2eAfter.includes(proj), 'E2E 日志应含本测试 proj 标识，证 hook 日志确实进 E2E');
  // 等价锁（免疫并发写）：源码树日志在测试窗口内无本测试 proj 标识的新行——
  // 某 hook 漏 createLogger 才会把本测试日志污染进源码树；无关 session 并发写 proj 不同不误红。
  const srcNew = readSrc().slice(srcBefore.length);
  assert.ok(!srcNew.includes(proj), '源码树 pace-hooks.log 不应出现本测试 proj 标识（hook 漏用 createLogger 才会污染）：' + srcNew.slice(0, 500));
});

test('9ab. marker 日志包含 agent_id / agent_type', () => {
  const dir = makeV6Project('ptu-marker-agent-log');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const logFile = E2E_LOG_PATH;
  const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

  runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-marker-deny',
      agent_id: 'agent-log-deny',
      agent_type: 'code-reviewer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->',
      },
    },
  });
  runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-marker-log',
      agent_id: 'agent-log-pass',
      agent_type: 'artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->',
      },
    },
  });

  const after = fs.readFileSync(logFile, 'utf8');
  const projectLogLines = after.split('\n').filter(line => line.includes(projectNameForDir(dir))).join('\n');
  const delta = projectLogLines || after.slice(before.length);
  assert.ok(delta.includes('act=DENY_V6_MARKER'));
  assert.ok(delta.includes('agent_id=agent-log-deny'));
  assert.ok(delta.includes('agent_type=code-reviewer'));
  assert.ok(delta.includes('act=PASS_V6_MARKER_AGENT'));
  assert.ok(delta.includes('agent_id=agent-log-pass'));
  assert.ok(delta.includes('agent_type=artifact-writer'));
});

test('9ab1. teammate 模式仍 hard-deny 直接写 C/V marker', () => {
  const dir = makeV6Project('ptu-marker-teammate-deny');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    env: { CLAUDE_CODE_TEAM_NAME: 'audit-team' },
    stdin: {
      agent_id: 'agent-team-marker',
      agent_type: 'code-reviewer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"permissionDecision":"deny"'));
  assert.ok(!r.stdout.includes('additionalContext'));
});

test('9ab2. teammate 模式未批准 C 阶段写代码 → hard-deny（不软化，纯执行者边界）', () => {
  const dir = makeV6Project('ptu-c-phase-teammate', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    env: { CLAUDE_CODE_TEAM_NAME: 'exec-team' },
    stdin: codeEditStdin(dir),
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"permissionDecision":"deny"'), 'teammate 未批准写代码应硬阻断');
  assert.ok(!r.stdout.includes('additionalContext'), 'C 门对 teammate 不应软化为提示');
  assert.ok(r.stdout.includes('任务管理归主 session'), '应含 teammate 回报主 session 引导');
});

test('9ab3. teammate 模式无活跃 CHG 写代码 → hard-deny（不软化）', () => {
  const dir = makeV6Project('ptu-no-active-teammate', { withIndex: false, detail: false });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    env: { CLAUDE_CODE_TEAM_NAME: 'exec-team' },
    stdin: codeEditStdin(dir),
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"permissionDecision":"deny"'), 'teammate 无活跃 CHG 写代码应硬阻断');
  assert.ok(!r.stdout.includes('additionalContext'), 'no-active 门对 teammate 不应软化');
});

test('9ab4. teammate 模式索引格式损坏写代码 → hard-deny（不软化）', () => {
  const dir = makeV6Project('ptu-malformed-teammate', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
  });
  const malformed = '<!-- 注释 -->- [ ] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n';
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    env: { CLAUDE_CODE_TEAM_NAME: 'exec-team' },
    stdin: codeEditStdin(dir),
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"permissionDecision":"deny"'), 'teammate 索引损坏写代码应硬阻断');
  assert.ok(!r.stdout.includes('additionalContext'), '索引完整性门对 teammate 不应软化');
});

test('9ab5. teammate 模式已批准但 E 阶段未就绪写代码 → hard-deny（不软化）', () => {
  const dir = makeV6Project('ptu-e-phase-teammate', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: true }),
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    env: { CLAUDE_CODE_TEAM_NAME: 'exec-team' },
    stdin: codeEditStdin(dir),
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"permissionDecision":"deny"'), 'teammate E 未就绪写代码应硬阻断');
  assert.ok(!r.stdout.includes('additionalContext'), 'E 门对 teammate 不应软化');
  assert.ok(r.stdout.includes('E 阶段未就绪'), '确认触发的是 E 门');
});

test('9ab7. teammate 模式 native plan 桥接门写代码 → 仍软化为提示（保持软化基线）', () => {
  // 保持软化的流程引导类守卫（桥接需主 session 跑 pace-bridge，teammate 做不了）在 teammate 下应仍软化，
  // 固化此行为防未来误把它也升 hardInTeammate（那会死锁 teammate）。
  // A1 后纯 dated-plan 不再激活——改用 manual 强信号（.pace-enabled）+ artifact-root 已配置（跳过 root-choice
  // 分支）+ current-native-plan，落到 native plan 桥接门（仍存活的桥接引导类门），意图不变。
  // 不用 changes/ 强信号：v6 项目会先撞「无活跃 CHG」hard 门（teammate 不软化），到不了桥接门。
  const dir = makeTmpDir('ptu-bridge-teammate');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  const planFile = path.join(dir, 'docs', 'plans', `${today()}-feature.md`);
  fs.writeFileSync(planFile, '# Plan\n');
  fs.writeFileSync(path.join(dir, '.pace', 'current-native-plan'), planFile, 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    env: { CLAUDE_CODE_TEAM_NAME: 'exec-team' },
    stdin: codeEditStdin(dir),
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('additionalContext'), '桥接引导类门对 teammate 应保持软化（不死锁 teammate）');
  assert.ok(!r.stdout.includes('"permissionDecision":"deny"'), '保持软化的门不应硬阻断');
});

test('9ab8. teammate 模式 shell 删/覆 artifact → hard-deny（TM-①，与 Edit/Write 对齐）', () => {
  // TM-①：teammate 是纯执行者，shell 删/覆 artifact 是破坏性写（非流程引导、无死锁风险），
  // 应与「直接 Edit/Write artifact 走 hardDeny」对齐——不软化为提示。覆盖 :725 bash / :751 powershell / :778 monitor 三处对称。
  const dir = makeV6Project('ptu-teammate-artifact-mutate');
  const cases = [
    { tool: 'Bash', command: 'rm task.md', label: 'bash 删' },
    { tool: 'Bash', command: 'echo x > task.md', label: 'bash 覆写' },
    { tool: 'PowerShell', command: 'Remove-Item task.md', label: 'powershell 删' },
    { tool: 'Monitor', command: 'echo x > task.md', label: 'monitor 覆写' },
  ];
  for (const { tool, command, label } of cases) {
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      env: { CLAUDE_CODE_TEAM_NAME: 'exec-team' },
      stdin: { tool_name: tool, tool_input: { command } },
    });
    assert.strictEqual(r.code, 0, `${label} 应正常退出`);
    assert.ok(r.stdout.includes('"permissionDecision":"deny"'), `teammate ${label} artifact 应硬阻断`);
    assert.ok(!r.stdout.includes('additionalContext'), `TM-①：${label} 对 teammate 不应软化为提示`);
  }
});

test('9b. create-chg 首次预留编号后重派，写 verified-date null → 放行', () => {
  const dir = makeV6Project('ptu-create-null', { withIndex: false, detail: false });
  const prompt = `artifact_dir: ${dir.replace(/\\/g, '/')}/\noperation: create-chg\n使用 create-chg 流程创建一个新的变更记录。`;
  const first = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-create-null',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  assert.strictEqual(first.code, 0);
  assert.ok(first.stdout.includes('"deny"'));
  const reserved = reservedFromStdout(first.stdout);
  assert.ok(reserved.id && reserved.detailFile);

  const pre = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-create-null',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: `${prompt}\nreserved-id: ${reserved.id}\n${reserved.promptReservedLine}`,
      },
    },
  });
  assert.strictEqual(pre.code, 0);
  assert.ok(!pre.stdout.includes('"deny"'));
  const fp = path.join(dir, reserved.file);
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-create-null',
      agent_id: 'agent-create-null',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Write',
      tool_input: {
        file_path: fp,
        content: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

test('9b1. create-chg 写入非法 CHG status=open → DENY', () => {
  const dir = makeV6Project('ptu-create-invalid-status', { withIndex: false, detail: false });
  const prompt = `artifact_dir: ${dir.replace(/\\/g, '/')}/\noperation: create-chg\n使用 create-chg 流程创建一个新的变更记录。`;
  const first = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-create-invalid-status',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  const reserved = reservedFromStdout(first.stdout);
  assert.ok(reserved.id && reserved.detailFile);
  const pre = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-create-invalid-status',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: `${prompt}\nreserved-id: ${reserved.id}\n${reserved.promptReservedLine}`,
      },
    },
  });
  assert.strictEqual(pre.code, 0);
  assert.ok(!pre.stdout.includes('"deny"'));
  const invalid = chgDetail({ status: 'planned', task: '[ ]', approved: false }).replace('status: planned', 'status: open');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-create-invalid-status',
      agent_id: 'agent-create-invalid-status',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, reserved.detailFile),
        content: invalid,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('status 非法'));
});

test('9b2. artifact-writer 不得在根索引缺 ARCHIVE 时先归档详情', () => {
  const dir = makeV6Project('ptu-archive-marker-precheck');
  fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n\n- [x] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), '# Implementation Plan\n\n- [x] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n', 'utf8');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-archive-marker-precheck',
      agent_id: 'agent-archive-marker-precheck',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: 'status: completed',
        new_string: 'status: archived',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('缺少 ARCHIVE 标记'));
});

test('9c. native plan 桥接提示走 artifact writer', () => {
  const dir = makeTmpDir('ptu-native-plan');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.writeFileSync(path.join(dir, '.pace', 'current-native-plan'), path.join(dir, 'plan.md'), 'utf8');
  fs.writeFileSync(path.join(dir, 'plan.md'), '# Native plan\n', 'utf8');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir), env: { PACE_VAULT_PATH: '' } });
  assert.ok(r.stdout.includes('deny'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-bridge)'));
  assert.ok(r.stdout.includes('同步标记'));
  assert.ok(!r.stdout.includes('Edit task.md'));
  assert.ok(fs.existsSync(path.join(dir, 'changes')), 'native plan deny 前应创建 v6 changes/ 基础目录');
});

test('9c1. 首次启用且 vault/local 都无 artifact → DENY 要求选择 artifact root', () => {
  const dir = makeTmpDir('ptu-artifact-root-choice');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectNameForDir(dir));
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('AskUserQuestion'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
  assert.ok(r.stdout.includes('artifact-root'));
  assert.ok(r.stdout.includes('配置文件'), '应把 .pace/artifact-root 描述为配置文件');
  assert.ok(r.stdout.includes('不是 artifact 根目录'), '应明确配置文件不是 artifact 根目录');
  assert.ok(r.stdout.includes('set-artifact-root.js'), '应给出 artifact-root helper 绝对路径');
  assert.ok(r.stdout.includes('不要直接重试代码写入'), '代码写入被拦后应先 create-chg + approve-and-start');
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), '选择前不应在本地懒创建 changes/');
  assert.ok(!fs.existsSync(path.join(vaultDir, 'changes')), '选择前不应在 vault 懒创建 changes/');
});

test('9c2. artifact-root=local 后首次 DENY 会在本地懒创建模板', () => {
  const dir = makeTmpDir('ptu-artifact-root-local');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectNameForDir(dir));
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('已自动创建 Artifact 模板'));
  assert.ok(r.stdout.includes(`Artifact 根目录：${dir.replace(/\\/g, '/')}/`));
  assert.ok(r.stdout.includes('reserve-artifact-id.js'));
  assert.ok(fs.existsSync(path.join(dir, 'changes')), 'local 选择应在本地懒创建 changes/');
  assert.ok(fs.existsSync(path.join(dir, 'task.md')), 'local 选择应在本地创建 task.md');
  assert.ok(!fs.existsSync(path.join(vaultDir, 'changes')), 'local 选择不应在 vault 创建 changes/');
});

test('9c2b. 仅有 artifact-root=local 也会首次 DENY 并懒创建模板', () => {
  const dir = makeTmpDir('ptu-artifact-root-local-choice-only');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('已自动创建 Artifact 模板'));
  assert.ok(r.stdout.includes('reserve-artifact-id.js'));
  assert.ok(fs.existsSync(path.join(dir, 'changes')), 'artifact-root choice 应足以触发本地懒创建 changes/');
  assert.ok(fs.existsSync(path.join(dir, 'task.md')), 'artifact-root choice 应足以触发 task.md 创建');
});

test('9c2c. 子目录继承父级 artifact-root-only 时首次写代码也走父级 DENY/init', () => {
  const root = makeTmpDir('ptu-artifact-root-parent-choice-only');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(path.join(root, '.pace'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(root, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const r = runHook('pre-tool-use.js', { cwd: child, stdin: codeEditStdin(child) });
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('已自动创建 Artifact 模板'));
  assert.ok(r.stdout.includes(`Project Root=${root.replace(/\\/g, '/')}`));
  assert.ok(fs.existsSync(path.join(root, 'changes')), '父级 artifact-root choice 应在父级懒创建 changes/');
  assert.ok(fs.existsSync(path.join(root, 'task.md')), '父级 artifact-root choice 应在父级创建 task.md');
  assert.ok(!fs.existsSync(path.join(child, 'changes')), '继承子目录不应创建自己的 changes/');
  assert.ok(!fs.existsSync(path.join(child, 'task.md')), '继承子目录不应创建自己的 task.md');
});

test('9c2a. PreToolUse 关键路径日志包含 artifact_dir 与 choice', () => {
  const dir = makeTmpDir('ptu-artifact-root-log');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const logFile = E2E_LOG_PATH;
  const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.ok(r.stdout.includes('"deny"'));
  const after = fs.readFileSync(logFile, 'utf8');
  const delta = after.length >= before.length ? after.slice(before.length) : after;
  const routeLine = after.split('\n').find(line =>
    line.includes('PreToolUse') &&
    line.includes('act=ROUTE') &&
    line.includes(`artifact_dir=${dir.replace(/\\/g, '/')}/`) &&
    line.includes(`project_root=${dir.replace(/\\/g, '/')}`) &&
    line.includes('mode=current') &&
    line.includes('choice=local')
  );
  assert.ok(routeLine, `应写入本次 artifact_dir route 日志；delta=${delta}`);
  assert.ok(routeLine.startsWith('['), '结构化日志字段不应因多行 reason 断裂');
});

test('9c3. SessionStart 首次启用只提示 skill，不询问、不自动创建模板', () => {
  const dir = makeTmpDir('ss-artifact-root-choice');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectNameForDir(dir));
  const r = runHookDetailed('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('Artifact 目录选择'), 'SessionStart 不应主动要求选择 artifact root');
	  assert.ok(!r.stdout.includes('AskUserQuestion'), '选择应推迟到 PreToolUse 阶段');
	  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'), 'SessionStart 应提示主 session 先读取 Paceflow workflow skill');
	  assert.ok(r.stdout.includes('set-artifact-root.js'), '首次 root-choice 提示也应给出 artifact-root helper 绝对路径');
	  assert.ok(r.stdout.includes('reserve-artifact-id.js'), '首次 root-choice 提示也应给出当前版本 reserve helper 绝对路径');
	  assert.ok(r.stdout.includes('--cwd') && r.stdout.includes('锚定'), '首次 root-choice 用正向 framing 引导 reserve helper（默认带 --cwd 锚定，不搜旧 plugin cache）');
	  assert.strictEqual(r.stderr, '', '非 git 项目不应泄漏 git fatal stderr');
  assert.ok(!fs.existsSync(path.join(dir, '.pace')), '选择前 SessionStart 不应创建 .pace 运行态目录');
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), '选择前不应在本地懒创建 changes/');
  assert.ok(!fs.existsSync(vaultDir), '选择前不应在 Obsidian projects 下创建空项目目录');
  assert.ok(!fs.existsSync(path.join(vaultDir, 'changes')), '选择前不应在 vault 懒创建 changes/');
});

test('9c3b. code-count SessionStart 选择前不创建 .pace 或 Obsidian 空目录', () => {
  const dir = makeTmpDir('ss-code-count-root-choice');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'c.js'), 'c\n', 'utf8');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectNameForDir(dir));
  const r = runHookDetailed('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.pace')), 'code-count 首次 SessionStart 不应创建 .pace');
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), 'code-count 首次 SessionStart 不应本地建模板');
  assert.ok(!fs.existsSync(vaultDir), 'code-count 首次 SessionStart 不应创建 Obsidian 空项目目录');
});

test('9c3c. worktree 继承宿主 local artifact-root 时 SessionStart 显示本地模式', () => {
  const root = makeTmpDir('ss-worktree-local-mode-root');
  const host = path.join(root, 'project-a');
  const worktree = path.join(root, 'project-a-wt');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'project-a-wt'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'project-a-wt')}\n`, 'utf8');
  fs.mkdirSync(path.join(host, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(host, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.mkdirSync(path.join(host, 'changes', 'findings'), { recursive: true });
  fs.mkdirSync(path.join(host, 'changes', 'corrections'), { recursive: true });
  fs.writeFileSync(path.join(host, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(host, 'implementation_plan.md'), '# 实施计划\n\n## 变更索引\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(host, 'walkthrough.md'), '# 工作记录\n\n## 最近工作\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(host, 'findings.md'), '# 调研记录\n\n## 摘要索引\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(host, 'corrections.md'), '# Corrections 记录\n\n## 索引\n\n<!-- ARCHIVE -->\n', 'utf8');

  const r = runHookDetailed('session-start.js', { cwd: worktree, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes(`Artifact Root: ${host.replace(/\\/g, '/')}/`)); // E4：路径去重后由项目上下文段 Artifact Root 承载
  assert.ok(r.stdout.includes('模式: 本地项目根目录')); // artifact mode 仍在 Artifact 目录段（E4 保留）
  assert.ok(!r.stdout.includes('模式: Obsidian vault project'));
  assert.ok(fs.existsSync(path.join(host, '.pace', 'stop-block-count')), 'SessionStart 运行态应写入宿主 .pace');
  assert.ok(!fs.existsSync(path.join(worktree, '.pace')), 'worktree 不应创建独立 .pace 运行态目录');
});

test('9c3d. 子目录继承父级 Project Root 的 vault artifact 并注入活跃 CHG', () => {
  const root = makeTmpDir('ss-subdir-inherit-root');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(child, { recursive: true });
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectNameForDir(root));
  fs.mkdirSync(path.join(vaultDir, 'changes', 'findings'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'changes', 'corrections'), { recursive: true });
  const index = '- [/] [[chg-20260504-01]] 父级任务 #change [tasks:: T-001]\n';
  fs.writeFileSync(path.join(vaultDir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${index}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n${index}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'walkthrough.md'), '# 工作记录\n\n## 最近工作\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'findings.md'), '# 调研记录\n\n## 摘要索引\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'corrections.md'), '# Corrections 记录\n\n## 索引\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'changes', 'chg-20260504-01.md'), chgDetail({ status: 'in-progress', task: '[/]', approved: true }), 'utf8');

  const r = runHookDetailed('session-start.js', { cwd: child, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('=== PACEflow 项目上下文 ==='));
  assert.ok(r.stdout.includes(`Current CWD: ${child.replace(/\\/g, '/')}`));
  assert.ok(r.stdout.includes(`Project Root: ${root.replace(/\\/g, '/')}`));
  assert.ok(r.stdout.includes(`Runtime Root: ${path.join(root, '.pace').replace(/\\/g, '/')}`));
  assert.ok(r.stdout.includes(`Artifact Root: ${vaultDir.replace(/\\/g, '/')}/`)); // E4：路径去重后由项目上下文段 Artifact Root 承载
  assert.ok(r.stdout.includes('=== 活跃 CHG 摘要 ==='));
  assert.ok(r.stdout.includes('CHG-20260504-01'));
  assert.ok(fs.existsSync(path.join(root, '.pace', 'stop-block-count')), '运行态应写入父级 Project Root');
  assert.ok(!fs.existsSync(path.join(child, '.pace')), '继承子目录不应创建自己的 .pace');
});

test('9c3e. 子目录 Project Root helper 声明 independent 后不再继承父级 artifact', () => {
  const root = makeTmpDir('ss-subdir-independent-root');
  const child = path.join(root, 'experiments', 'new-project');
  fs.mkdirSync(child, { recursive: true });
  const parentVault = path.join(_vaultTmpDir, 'projects', projectNameForDir(root));
  fs.mkdirSync(path.join(parentVault, 'changes'), { recursive: true });

  const setRoot = runSetProjectRootHelper({ cwd: child, args: ['--mode', 'independent'] });
  assert.strictEqual(setRoot.code, 0);
  assert.ok(setRoot.stdout.includes('Project Root 已声明为 independent'));
  assert.ok(setRoot.stdout.includes('mode: independent'));
  assert.ok(setRoot.stdout.includes('next-step:'));
  assert.ok(fs.existsSync(path.join(child, '.pace', 'project-root')));

  const setArtifact = runSetArtifactRootHelper({ cwd: child, args: ['--choice', 'local'] });
  assert.strictEqual(setArtifact.code, 0);
  assert.ok(setArtifact.stdout.includes(`project-root: ${child.replace(/\\/g, '/')}`));
  assert.ok(fs.existsSync(path.join(child, '.pace', 'artifact-root')));
  assert.ok(!fs.existsSync(path.join(root, '.pace', 'artifact-root')), 'independent 子项目不应写父级 artifact-root');
});

test('9c3f. git worktree 不允许用 Project Root helper 声明 independent', () => {
  const root = makeTmpDir('ss-worktree-independent-deny-root');
  const host = path.join(root, 'project-a');
  const worktree = path.join(root, 'project-a-wt');
  const worktreeChild = path.join(worktree, 'packages', 'api');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'project-a-wt'), { recursive: true });
  fs.mkdirSync(worktreeChild, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'project-a-wt')}\n`, 'utf8');

  const r = runSetProjectRootHelper({ cwd: worktree, args: ['--mode', 'independent'] });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stdout.includes('DENY_WORKTREE_PROJECT_ROOT') || r.stdout.includes('git worktree'));
  assert.ok(!fs.existsSync(path.join(worktree, '.pace', 'project-root')), '不应在 worktree 写入无效 independent marker');

  const child = runSetProjectRootHelper({ cwd: worktreeChild, args: ['--mode', 'independent'] });
  assert.strictEqual(child.code, 2);
  assert.ok(child.stdout.includes('DENY_WORKTREE_PROJECT_ROOT') || child.stdout.includes('git worktree'));
  assert.ok(!fs.existsSync(path.join(worktreeChild, '.pace', 'project-root')), 'worktree 子目录也不能分裂 independent marker');
});

test('9c3g. 继承子目录普通代码写入受父级 active CHG gate 约束', () => {
  const root = makeV6Project('ptu-subdir-inherit-code-gate', { withIndex: false, detail: false });
  const child = path.join(root, 'packages', 'api');
  const sibling = path.join(root, 'packages', 'web');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(child, 'src.js'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src.js'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(sibling, 'src.js'), 'a\n', 'utf8');

  const r = runHook('pre-tool-use.js', { cwd: child, stdin: codeEditStdin(child) });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('没有活跃 CHG'));

  const parent = runHook('pre-tool-use.js', { cwd: child, stdin: codeEditStdin(root) });
  assert.strictEqual(parent.code, 0);
  assert.ok(parent.stdout.includes('"deny"'));
  assert.ok(parent.stdout.includes('没有活跃 CHG'));

  const siblingWrite = runHook('pre-tool-use.js', { cwd: child, stdin: codeEditStdin(sibling) });
  assert.strictEqual(siblingWrite.code, 0);
  assert.ok(siblingWrite.stdout.includes('"deny"'));
  assert.ok(siblingWrite.stdout.includes('没有活跃 CHG'));
  assert.ok(!fs.existsSync(path.join(child, '.pace')), '子目录 gate 不应分裂 runtime');
});

test('9c3a. artifact-root=local 的 SessionStart 不创建 Obsidian 空项目目录', () => {
  const dir = makeTmpDir('ss-artifact-root-local-no-vault-dir');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectNameForDir(dir));
  const r = runHookDetailed('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
	  assert.strictEqual(r.code, 0);
	  assert.ok(r.stdout.includes('=== PACEflow 工作流入口 ==='), 'artifact signal SessionStart 应靠前提示 workflow skill');
	  assert.ok(r.stdout.includes('=== Artifact 目录 ==='), 'local 模式也应注入 artifact 根目录');
  assert.ok(r.stdout.includes(`Artifact Root: ${dir.replace(/\\/g, '/')}/`)); // E4：路径去重后由项目上下文段 Artifact Root 承载
  assert.ok(r.stdout.includes('仅用于 PaceFlow artifacts'));
  assert.ok(r.stdout.includes('sync-plan.js'), 'SessionStart 应提供 plan 同步 helper 绝对路径');
  assert.ok(fs.existsSync(path.join(dir, 'changes')), 'local 选择后 SessionStart 可在本地补齐模板');
  assert.ok(fs.existsSync(path.join(dir, 'task.md')), 'local 选择后 SessionStart 可在本地补齐 task.md');
  assert.ok(!fs.existsSync(vaultDir), 'local 选择不应创建 Obsidian 空项目目录');
});

test('9c4. code-count lookahead 已移除——Write 达阈值不 deny 不建模板（CHG-A A3b）', () => {
  // 原测试断言 lookahead 触发 root-choice deny + AskUserQuestion——A3b 删除 lookahead 后该行为废除：
  // 软信号（即将达 3 文件）不再触发任何门控；有 vault 环境同样放行（root 选择是激活后的事）。
  const dir = makeTmpDir('ptu-artifact-root-code-count');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b\n', 'utf8');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectNameForDir(dir));
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'c.js'), content: 'c\n' } },
  });
  assert.ok(!r.stdout.includes('"permissionDecision":"deny"'), 'code-count lookahead 不应再 deny');
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), '不应在本地懒创建 changes/');
  assert.ok(!fs.existsSync(path.join(dir, 'task.md')), '不应建 task.md 模板');
  assert.ok(!fs.existsSync(path.join(vaultDir, 'changes')), '不应在 vault 懒创建 changes/');
});

test('9c5. PACE_ARTIFACT_ROOT=local 自动化环境跳过询问并本地懒创建', () => {
  const dir = makeTmpDir('ptu-artifact-root-env-local');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: codeEditStdin(dir),
    env: { PACE_ARTIFACT_ROOT: 'local' },
  });
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(!r.stdout.includes('AskUserQuestion'));
  assert.ok(fs.existsSync(path.join(dir, 'changes')), 'env local 应在本地懒创建 changes/');
});

test('9c6. env scrub 场景仍可用项目级 artifact-root=local 恢复本地路由', () => {
  const dir = makeTmpDir('ss-env-scrub-local-choice');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const r = runHookDetailed('session-start.js', {
    cwd: dir,
    stdin: { type: 'startup' },
    env: { PACE_VAULT_PATH: '', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('=== Artifact 目录 ==='));
  assert.ok(r.stdout.includes(`Artifact Root: ${dir.replace(/\\/g, '/')}/`)); // E4：路径去重后由项目上下文段 Artifact Root 承载
  assert.ok(fs.existsSync(path.join(dir, 'changes')), 'scrub 环境下项目级 local 选择仍应创建本地 changes/');
});

test('9c7. artifact-root=vault 但 vault env 缺失时 fail-closed，不落本地模板', () => {
  const dir = makeTmpDir('ptu-vault-choice-missing-env');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'vault\n', 'utf8');

  const start = runHookDetailed('session-start.js', {
    cwd: dir,
    stdin: { type: 'startup' },
    env: { PACE_VAULT_PATH: '' },
  });
  assert.strictEqual(start.code, 0);
  assert.ok(start.stdout.includes('PACEflow 配置错误'));
  assert.ok(!fs.existsSync(path.join(dir, 'task.md')), 'SessionStart 不应 fallback 到本地 artifact');
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), 'SessionStart 不应本地建 changes/');

  const edit = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: codeEditStdin(dir),
    env: { PACE_VAULT_PATH: '' },
  });
  assert.strictEqual(edit.code, 0);
  assert.ok(edit.stdout.includes('"deny"'));
  assert.ok(edit.stdout.includes('PACE_VAULT_PATH'));
  assert.ok(!fs.existsSync(path.join(dir, 'task.md')), 'PreToolUse 不应 fallback 到本地 artifact');
});

test('9d. v5 布局项目写码走常规建 CHG 门，不再注入迁移引导（CHG-20260612-02）', () => {
  const dir = makeLegacyProject('ptu-legacy');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir), env: { PACE_VAULT_PATH: '' } });
  assert.ok(r.stdout.includes('deny'), 'v5 项目（paceSignal=legacy）写码仍需先建 CHG');
  assert.ok(!/batch-archive|v5 PACE artifact|AskUserQuestion|--dry-run/.test(r.stdout), '不再出现迁移引导文案');
  assert.ok(r.stdout.includes('create-chg'), 'deny 指引走常规 create-chg 路径');
});

test('9d1. vault 中 legacy v5 artifact 优先进入迁移提示，不先询问 artifact root', () => {
  const dir = makeTmpDir('ptu-legacy-vault');
  const projectName = projectNameForDir(dir);
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectName);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'task.md'), '# Task\n\n- [ ] Legacy vault task\n\n<!-- ARCHIVE -->\n', 'utf8');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.ok(r.stdout.includes('"deny"'), 'v5 布局项目写码仍需先建 CHG');
  assert.ok(!r.stdout.includes('PACEflow 首次启用需要选择 artifact 存放位置'), 'v5 布局目录即 artifact root，不再询问选择');
  assert.ok(!/batch-archive|v5 PACE artifact|AskUserQuestion/.test(r.stdout), '不再出现迁移引导文案');
});

test('9d2. legacy v5 不允许用 Bash 手动创建 changes/ 绕过迁移', () => {
  const dir = makeTmpDir('ptu-legacy-vault-mkdir');
  const projectName = projectNameForDir(dir);
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectName);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'task.md'), '# Task\n\n- [ ] Legacy vault task\n\n<!-- ARCHIVE -->\n', 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: { command: `mkdir -p "${path.join(vaultDir, 'changes')}"` },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'Bash 直改 artifact 目录仍被写保护拦截（与 v5 无关的通用保护）');
  assert.ok(!/batch-archive|禁止在用户确认前创建|--dry-run/.test(r.stdout), '不再出现迁移引导文案');
  assert.ok(!fs.existsSync(path.join(vaultDir, 'changes')), '手动 mkdir changes/ 必须在 PreToolUse 被拦截');
});

test('9e. worktree 本地 CHG 详情写入 → DENY 并重定向到 vault', () => {
  const { worktree, vaultDir } = makeVaultBackedWorktree('redirect-chg');
  const localFp = path.join(worktree, 'changes', 'chg-20260504-02.md');
  const expected = path.join(vaultDir, 'changes', 'chg-20260504-02.md').replace(/\\/g, '/');
  const r = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: { tool_name: 'Write', tool_input: { file_path: localFp, content: '# local detail\n' } },
  });
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes(expected));
});

test('9f. worktree 本地 finding/correction 详情写入 → DENY 并重定向到 vault', () => {
  const { worktree, vaultDir } = makeVaultBackedWorktree('redirect-subdetails');
  for (const rel of [
    'changes/findings/finding-2026-05-06-test.md',
    'changes/corrections/correction-2026-05-06-01-test.md',
  ]) {
    const localFp = path.join(worktree, rel);
    const expected = path.join(vaultDir, rel).replace(/\\/g, '/');
    const r = runHook('pre-tool-use.js', {
      cwd: worktree,
      stdin: { tool_name: 'Write', tool_input: { file_path: localFp, content: '# local detail\n' } },
    });
    assert.ok(r.stdout.includes('"deny"'), `${rel} should be denied`);
    assert.ok(r.stdout.includes(expected), `${rel} should point at vault`);
  }
});

test('9g. 主 session 写 vault 中的详情路径 → DENY artifact-writer-only', () => {
  const { worktree, vaultDir } = makeVaultBackedWorktree('redirect-vault-pass');
  const fp = path.join(vaultDir, 'changes', 'chg-20260504-02.md');
  const r = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: { tool_name: 'Write', tool_input: { file_path: fp, content: '# vault detail\n' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('禁止主 session/非 artifact-writer'));
});

test('9h. worktree 普通代码文件不触发 artifact 重定向', () => {
  const { worktree } = makeVaultBackedWorktree('redirect-code-pass');
  const r = runHook('pre-tool-use.js', { cwd: worktree, stdin: codeEditStdin(worktree) });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('DENY_REDIRECT'));
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('additionalContext'));
});

test('9ha. worktree 普通代码文件 MultiEdit 不触发 artifact 重定向', () => {
  const { worktree } = makeVaultBackedWorktree('redirect-code-multiedit-pass');
  const r = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: path.join(worktree, 'src.js'),
        edits: [{ old_string: 'a', new_string: 'b' }],
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('DENY_REDIRECT'));
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('additionalContext'));
});

test('9ha1. local 模式 worktree 中写宿主普通文件 → 仅提示 artifact_dir 语义，不 hard deny', () => {
  const root = makeTmpDir('worktree-host-normal-write-root');
  const host = path.join(root, 'project-a');
  const worktree = path.join(root, 'project-a-wt');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'project-a-wt'), { recursive: true });
  fs.mkdirSync(path.join(host, '.pace'), { recursive: true });
  fs.mkdirSync(path.join(host, 'changes'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(host, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'project-a-wt')}\n`, 'utf8');
  for (const file of ['task.md', 'implementation_plan.md', 'walkthrough.md', 'findings.md', 'corrections.md']) {
    fs.writeFileSync(path.join(host, file), `# ${file}\n\n<!-- ARCHIVE -->\n`, 'utf8');
  }
  const hostFile = path.join(host, 'branch-note.md');
  const r = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: { tool_name: 'Write', tool_input: { file_path: hostFile, content: 'wrong checkout\n' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('当前 cwd 是 worktree'));
  assert.ok(r.stdout.includes('仅用于 PaceFlow artifacts'));
  assert.ok(r.stdout.includes('如果用户明确要求修改宿主 checkout'));
});

test('9ha2. vault 模式 worktree 中写宿主普通文件 → 仅提示 artifact_dir 语义，不 hard deny', () => {
  const { host, worktree } = makeVaultBackedWorktree('vault-host-normal-write');
  const hostFile = path.join(host, 'branch-note.md');
  const r = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: { tool_name: 'Write', tool_input: { file_path: hostFile, content: 'wrong checkout\n' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('当前 cwd 是 worktree'));
  assert.ok(r.stdout.includes('仅用于 PaceFlow artifacts'));
  assert.ok(r.stdout.includes('如果用户明确要求修改宿主 checkout'));
});

test('9ha3. local 模式 worktree 写宿主普通代码文件不触发 PACE C/E gate', () => {
  const root = makeTmpDir('worktree-host-code-write-root');
  const host = path.join(root, 'project-a');
  const worktree = path.join(root, 'project-a-wt');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'project-a-wt'), { recursive: true });
  fs.mkdirSync(path.join(host, '.pace'), { recursive: true });
  fs.mkdirSync(path.join(host, 'changes'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(host, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'project-a-wt')}\n`, 'utf8');
  for (const file of ['task.md', 'implementation_plan.md', 'walkthrough.md', 'findings.md', 'corrections.md']) {
    fs.writeFileSync(path.join(host, file), `# ${file}\n\n<!-- ARCHIVE -->\n`, 'utf8');
  }
  const hostFile = path.join(host, 'src.js');
  const r = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: { tool_name: 'Write', tool_input: { file_path: hostFile, content: 'export const x = 1;\n' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(!r.stdout.includes('本项目没有活跃 CHG/HOTFIX'));
  assert.ok(r.stdout.includes('当前 cwd 是 worktree'));
  assert.ok(r.stdout.includes('仅用于 PaceFlow artifacts'));
});

test('9ha4. worktree 子目录写 checkout 根或 sibling 代码文件仍受 C/E gate 约束', () => {
  const root = makeTmpDir('worktree-child-checkout-boundary-root');
  const host = path.join(root, 'project-a');
  const worktree = path.join(root, 'project-a-wt');
  const child = path.join(worktree, 'packages', 'api');
  const sibling = path.join(worktree, 'packages', 'web');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'project-a-wt'), { recursive: true });
  fs.mkdirSync(path.join(host, '.pace'), { recursive: true });
  fs.mkdirSync(path.join(host, 'changes'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(host, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'project-a-wt')}\n`, 'utf8');
  for (const file of ['task.md', 'implementation_plan.md', 'walkthrough.md', 'findings.md', 'corrections.md']) {
    fs.writeFileSync(path.join(host, file), `# ${file}\n\n<!-- ARCHIVE -->\n`, 'utf8');
  }

  const rootWrite = runHook('pre-tool-use.js', {
    cwd: child,
    stdin: { tool_name: 'Write', tool_input: { file_path: path.join(worktree, 'root.js'), content: 'export const root = true;\n' } },
  });
  assert.strictEqual(rootWrite.code, 0);
  assert.ok(rootWrite.stdout.includes('"deny"'));
  assert.ok(rootWrite.stdout.includes('没有活跃 CHG'));

  const siblingWrite = runHook('pre-tool-use.js', {
    cwd: child,
    stdin: { tool_name: 'Write', tool_input: { file_path: path.join(sibling, 'src.js'), content: 'export const web = true;\n' } },
  });
  assert.strictEqual(siblingWrite.code, 0);
  assert.ok(siblingWrite.stdout.includes('"deny"'));
  assert.ok(siblingWrite.stdout.includes('没有活跃 CHG'));
  assert.ok(!siblingWrite.stdout.includes('当前 cwd 是 worktree'), 'checkout 内 sibling 不应被误认为宿主 checkout 写入');
});

test('9ha5. worktree 内 nested git repo 写代码仍受宿主 C/E gate', () => {
  const root = makeTmpDir('worktree-nested-git-gate-root');
  const host = path.join(root, 'project-a');
  const worktree = path.join(root, 'project-a-wt');
  const nestedDirRepo = path.join(worktree, 'vendor', 'lib');
  const nestedFileRepo = path.join(worktree, 'vendor', 'submodule');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'project-a-wt'), { recursive: true });
  fs.mkdirSync(path.join(host, '.pace'), { recursive: true });
  fs.mkdirSync(path.join(host, 'changes'), { recursive: true });
  fs.mkdirSync(path.join(nestedDirRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(nestedFileRepo, '.gitdir'), { recursive: true });
  fs.writeFileSync(path.join(host, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'project-a-wt')}\n`, 'utf8');
  fs.writeFileSync(path.join(nestedFileRepo, '.git'), `gitdir: ${path.join(nestedFileRepo, '.gitdir')}\n`, 'utf8');
  for (const file of ['task.md', 'implementation_plan.md', 'walkthrough.md', 'findings.md', 'corrections.md']) {
    fs.writeFileSync(path.join(host, file), `# ${file}\n\n<!-- ARCHIVE -->\n`, 'utf8');
  }

  const nestedDirWrite = runHook('pre-tool-use.js', {
    cwd: nestedDirRepo,
    stdin: { tool_name: 'Write', tool_input: { file_path: path.join(nestedDirRepo, 'src.js'), content: 'export const nested = true;\n' } },
  });
  assert.strictEqual(nestedDirWrite.code, 0);
  assert.ok(nestedDirWrite.stdout.includes('"deny"'));
  assert.ok(nestedDirWrite.stdout.includes('没有活跃 CHG'));

  const nestedFileWrite = runHook('pre-tool-use.js', {
    cwd: nestedFileRepo,
    stdin: { tool_name: 'Write', tool_input: { file_path: path.join(nestedFileRepo, 'src.js'), content: 'export const sub = true;\n' } },
  });
  assert.strictEqual(nestedFileWrite.code, 0);
  assert.ok(nestedFileWrite.stdout.includes('"deny"'));
  assert.ok(nestedFileWrite.stdout.includes('没有活跃 CHG'));
});

test('9haa. 首次 artifact-writer Agent 派遣前要求选择 artifact root', () => {
  const dir = makeTmpDir('agent-artifact-root-choice');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-local-template',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: '使用 create-chg 流程创建一个新的变更记录。',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('AskUserQuestion'));
  assert.ok(r.stdout.includes('artifact-root'));
});

test('9haa0. 无 PACE 信号但显式派 artifact-writer 也先要求选择 artifact root', () => {
  const dir = makeTmpDir('agent-no-signal-artifact-root-choice');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-no-signal-root-choice',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: 'operation: create-chg',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('AskUserQuestion'));
  assert.ok(r.stdout.includes('set-artifact-root.js'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
  assert.ok(!fs.existsSync(path.join(dir, '.pace')), '选择前不应创建 .pace');
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), '选择前不应创建本地 artifact 模板');
});

test('9haa0b. 已写 artifact-root 但无 PACE 信号时 artifact-writer 仍进入 artifact_dir gate', () => {
  const dir = makeTmpDir('agent-no-signal-artifact-dir-gate');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-no-signal-artdir',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: 'operation: create-chg',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('缺少或写错当前 artifact_dir'));
  assert.ok(r.stdout.includes(`artifact_dir: ${dir.replace(/\\/g, '/')}/`));
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), '缺 artifact_dir 时不应先创建 artifact 模板');
});

test('9haa0c. artifact-writer 派遣同时缺 artifact_dir + operation → deny 一次列全两项（CHG-20260615-03 T-001 缺啥列啥）', () => {
  const dir = makeTmpDir('agent-missing-both');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-missing-both',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'x', prompt: 'title: 测试' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('缺少或写错当前 artifact_dir'), 'artifact_dir 缺失仍点名');
  assert.ok(r.stdout.includes('也未声明 operation'), 'operation 缺失也一并点名（一次列全、免二次往返）');
});

test('9haa0d. artifact-writer 缺 artifact_dir 但 operation 已声明 → 不冗余追加 operation 提示（零回归）', () => {
  const dir = makeTmpDir('agent-missing-artdir-only');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-missing-artdir-only',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'x', prompt: 'operation: create-chg\ntitle: 测试' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('缺少或写错当前 artifact_dir'), 'artifact_dir 缺失点名');
  assert.ok(!r.stdout.includes('也未声明 operation'), 'operation 已声明时不追加 operation 提示');
});

test('9haa0e. operation 空行（operation: 后直接换行）+ 缺 artifact_dir → 按缺 operation 一并点名，不被下一行字段吞成非空（CHG-20260615-06 T-001 P3-1）', () => {
  const dir = makeTmpDir('agent-empty-op-no-artdir');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-empty-op-no-artdir',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'x', prompt: 'operation:\ntitle: 测试' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('缺少或写错当前 artifact_dir'), 'artifact_dir 缺失点名');
  assert.ok(r.stdout.includes('也未声明 operation'), 'operation 空行应判缺失、一并点名（不被下一行 title: 吞成非空）');
});

test('9haa0f. operation 空行 + 有 artifact_dir → lifecycle 报缺 operation，不把下一行 title: 误当 operation 报 unknown（CHG-20260615-06 T-001 P3-1）', () => {
  const dir = makeV6Project('agent-empty-op-with-artdir', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: false }),
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-empty-op-with-artdir',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'x',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation:',
          'title: 测试',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('缺少明确 operation'), 'operation 空行应报缺 operation');
  assert.ok(!r.stdout.includes('operation「title:」'), '不应把下一行 title: 误当 operation 报 unknown');
});

test('9haa1. v5 布局上 artifact-writer create-chg 不再被 v5 拦截，走常规 reservation 门（CHG-20260612-02）', () => {
  const dir = makeLegacyProject('agent-legacy-v5');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-vault-template',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: `artifact_dir: ${dir.replace(/\\/g, '/')}\n使用 create-chg 流程创建一个新的变更记录。`,
      },
    },
    env: { PACE_VAULT_PATH: '' },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!/v5 PACE artifact|AskUserQuestion|batch-archive/.test(r.stdout), '不再出现 v5 迁移拦截文案');
  // create-chg 无 reservation 仍被常规 reservation 门拦（与 v5 无关的既有约束）
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(/reserve|reserved-id/.test(r.stdout), 'deny 指引应为 reservation 路径');
});

test('9hab. artifact-root=local 后首次 create-chg Agent 创建模板并要求带 reserved-id 重派', () => {
  const dir = makeTmpDir('agent-artifact-root-local');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectNameForDir(dir));
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-local-template',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: `artifact_dir: ${dir.replace(/\\/g, '/')}\n使用 create-chg 流程创建一个新的变更记录。`,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('reserved-id'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
  assert.ok(r.stdout.includes('重派 artifact-writer'));
  assert.ok(r.stdout.includes('reserve-artifact-id.js'));
  assert.ok(r.stdout.includes(`artifact_dir: ${dir.replace(/\\/g, '/')}/`));
  assert.ok(fs.existsSync(path.join(dir, 'changes')), 'local agent 放行前应创建 changes/');
  assert.ok(fs.existsSync(path.join(dir, 'task.md')), 'local agent 放行前应创建 task.md');
  assert.ok(!fs.existsSync(path.join(dir, 'implementation_plan.md')), 'v7: 新项目不再创建 implementation_plan.md');
  assert.ok(!fs.existsSync(path.join(vaultDir, 'changes')), 'local 选择不应在 vault 创建 changes/');
});

test('9hab2. artifact-root=local 但 Agent prompt 写到 docs 子目录 → DENY', () => {
  const dir = makeTmpDir('agent-artifact-root-local-wrong-subdir');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-vault-template',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: `artifact_dir: ${dir.replace(/\\/g, '/')}/docs\n使用 create-chg 流程创建一个新的变更记录。`,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('写错当前 artifact_dir'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
  assert.ok(r.stdout.includes(`artifact_dir: ${dir.replace(/\\/g, '/')}/`));
  assert.ok(r.stdout.includes(displayDirForAssert(path.join(dir, 'docs'), { normalized: true })));
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), '错误 artifact_dir 时不应先创建本地模板');
});

test('9hac. artifact-root=vault 后首次 create-chg Agent 创建 vault 模板并要求带 reserved-id 重派', () => {
  const dir = makeTmpDir('agent-artifact-root-vault');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'vault\n', 'utf8');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectNameForDir(dir));
  const prompt = `artifact_dir: ${vaultDir.replace(/\\/g, '/')}/\n使用 create-chg 流程创建一个新的变更记录。`;
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-vault-template',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('reserved-id'));
  assert.ok(r.stdout.includes('重派 artifact-writer'));
  assert.ok(r.stdout.includes(`artifact_dir: ${vaultDir.replace(/\\/g, '/')}/`));
  assert.ok(fs.existsSync(path.join(vaultDir, 'changes')), 'vault agent 放行前应创建 changes/');
  assert.ok(fs.existsSync(path.join(vaultDir, 'task.md')), 'vault agent 放行前应创建 task.md');
  assert.ok(!fs.existsSync(path.join(vaultDir, 'implementation_plan.md')), 'v7: vault 新项目不再创建 implementation_plan.md');
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), 'vault 选择不应在本地项目创建 changes/');
});

test('9hac2. artifact-root=vault 但 Agent prompt 写到 vault 子目录 → DENY', () => {
  const dir = makeTmpDir('agent-artifact-root-vault-wrong-subdir');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'vault\n', 'utf8');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectNameForDir(dir));
  const prompt = `artifact_dir: ${vaultDir.replace(/\\/g, '/')}/docs\n使用 create-chg 流程创建一个新的变更记录。`;
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('写错当前 artifact_dir'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
  assert.ok(r.stdout.includes(`artifact_dir: ${vaultDir.replace(/\\/g, '/')}/`));
  assert.ok(r.stdout.includes(displayDirForAssert(path.join(vaultDir, 'docs'), { normalized: true })));
  assert.ok(!fs.existsSync(path.join(vaultDir, 'changes')), '错误 artifact_dir 时不应先创建 vault 模板');
});

test('9hb. artifact-writer Agent 未带 vault artifact_dir → DENY 重派', () => {
  const { worktree, vaultDir } = makeVaultBackedWorktree('agent-artdir-deny');
  const r = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: {
      session_id: 'sid-agent-artdir-pass',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: '使用 create-chg 流程创建一个新的变更记录，请创建 changes/<id>.md。',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('artifact_dir'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
  assert.ok(r.stdout.includes('spec.md / task.md / walkthrough.md / findings.md / corrections.md / changes/**'));
  assert.ok(r.stdout.includes(vaultDir.replace(/\\/g, '/')));
});

test('9hb1. record-finding 缺 artifact_dir 时 DENY 返回对应完整模板', () => {
  const { worktree } = makeVaultBackedWorktree('agent-artdir-finding-template');
  const prompt = [
    'operation: record-finding',
    'title: 测试 finding',
    'summary: 摘要',
    'type: observation',
    'impact: P2',
    'body: 正文',
  ].join('\n');
  const r = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: {
      session_id: 'sid-agent-artdir-finding-template',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Record finding',
        prompt,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('operation: record-finding'));
  assert.ok(r.stdout.includes('title: <finding 标题>'));
  assert.ok(r.stdout.includes('body: <完整 Markdown 正文>'));
});

test('9hc. artifact-writer create-chg 带 vault artifact_dir + reserved-id → 放行', () => {
  const { worktree, vaultDir } = makeVaultBackedWorktree('agent-artdir-pass');
  const prompt = `artifact_dir: ${vaultDir.replace(/\\/g, '/')}/\n使用 create-chg 流程创建一个新的变更记录。`;
  const first = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: {
      session_id: 'sid-agent-artdir-pass',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  assert.strictEqual(first.code, 0);
  assert.ok(first.stdout.includes('"deny"'));
  const reserved = reservedFromStdout(first.stdout);
  assert.ok(reserved.id && reserved.detailFile);

  const r = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: {
      session_id: 'sid-agent-artdir-pass',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: `${prompt}\nreserved-id: ${reserved.id}\n${reserved.promptReservedLine}`,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
  assert.ok(r.stdout.includes('spec.md / task.md / walkthrough.md / findings.md / corrections.md / changes/**'));
});

test('9hc-helper. reserve-artifact-id helper 预留 create-chg 后 Agent 首派即放行', () => {
  const dir = makeTmpDir('agent-reserve-helper-local');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const helper = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-helper-create' },
  });
  assert.strictEqual(helper.code, 0);
  assert.ok(helper.stdout.includes(`artifact_dir: ${dir.replace(/\\/g, '/')}/`));
  assert.ok(helper.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-01`));
  assert.ok(helper.stdout.includes(`reserved-file-prefix: changes/chg-${today().replace(/-/g, '')}-01-<slug>.md`));
  assert.ok(fs.existsSync(path.join(dir, 'changes')), 'helper 应在 root 已选择后懒创建 changes/');
  assert.ok(fs.existsSync(path.join(dir, 'task.md')), 'helper 应在 root 已选择后懒创建 task.md');

  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-helper-create',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: `${helper.stdout}\ntitle: helper smoke\ntasks:\n- T-001: do it`,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
  assert.ok(r.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-01`));
  assert.ok(helper.stdout.includes('execution-context:'), 'helper 应输出 execution-context');
});

test('9hc-helper0a. reserve-artifact-id helper 在继承子目录写父 Project Root runtime', () => {
  const root = makeTmpDir('agent-reserve-helper-subdir-parent');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(root, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pace', 'artifact-root'), 'local\n', 'utf8');

  const helper = runReserveHelper({
    cwd: child,
    args: ['--operation', 'create-chg'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-helper-subdir-create' },
  });
  assert.strictEqual(helper.code, 0);
  assert.ok(helper.stdout.includes(`artifact_dir: ${root.replace(/\\/g, '/')}/`));
  assert.ok(helper.stdout.includes(`project-root: ${root.replace(/\\/g, '/')}`));
  assert.ok(fs.existsSync(path.join(root, '.pace', 'reservations')), 'reservation 应写父 Project Root runtime');
  assert.ok(!fs.existsSync(path.join(child, '.pace')), '继承子目录不应创建自己的 .pace runtime');
});

test('9hc-helper1a. reserve-artifact-id helper 遇到未知参数 fail-fast', () => {
  const dir = makeV6Project('agent-reserve-helper-unknown-arg', { withIndex: false, detail: false });
  const helper = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--project-dir', dir, '--artifact-root', 'local'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-helper-unknown-arg' },
  });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('不支持参数'), 'fail-fast 报不支持参数');
  // CHG-20260620-01：多余 positional 也 fail-closed 计入 unknown——`--project-dir /tmp/x` 里 reserve 不认
  // --project-dir，故 /tmp/x 成裸 positional 一并报出，unknown 列表不再 flag 名连续，分别校验两个误传 flag 在列。
  assert.ok(helper.stdout.includes('--project-dir') && helper.stdout.includes('--artifact-root'), '两个未知 flag 都进 unknown 列表');
  assert.ok(helper.stdout.includes('不要传 --artifact-dir / --artifact-root / --project-dir'));
  assert.ok(helper.stdout.includes('只可用 --cwd'));
});

test('9hc-helper1c. reserve --cwd 吞掉后续 flag → fail-closed 不预留（CHG-20260614-04 peek 下沉）', () => {
  const dir = makeV6Project('agent-reserve-cwd-eats-flag', { withIndex: false, detail: false });
  const helper = runReserveHelper({
    cwd: dir,
    args: ['--cwd', '--operation', 'create-chg'], // --cwd 缺值会吞 --operation
    env: { CLAUDE_CODE_SESSION_ID: 'sid-reserve-cwd-eats' },
  });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('缺值'), 'reserve --cwd 吞 flag 应报缺值（非吞下 --operation 静默 resolve）');
  assert.ok(!helper.stdout.includes('reserved-id:'), '缺值必须 fail-closed 不预留');
});

test('9hc-helper1d. reserve --operation 末尾缺值 → fail-closed（CHG-20260614-04 peek 下沉）', () => {
  const dir = makeV6Project('agent-reserve-op-missing', { withIndex: false, detail: false });
  const helper = runReserveHelper({
    cwd: dir,
    args: ['--operation'], // 末尾缺值
    env: { CLAUDE_CODE_SESSION_ID: 'sid-reserve-op-missing' },
  });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('缺值'), 'reserve --operation 末尾缺值应报缺值');
  assert.ok(!helper.stdout.includes('reserved-id:'));
});

test('9hc-syncplan-mv1. sync-plan --cwd 吞掉后续 flag → fail-closed（CHG-20260614-04 peek 下沉）', () => {
  const dir = makeV6Project('syncplan-cwd-eats-flag', { withIndex: false, detail: false });
  const helper = runSyncPlanHelper({ cwd: dir, args: ['--cwd', '--plan', 'x.md'] });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('缺值'), 'sync-plan --cwd 吞 flag 应报缺值（非吞下 --plan 静默 resolve）');
});

test('9hc-syncplan-mv2. sync-plan --plan 末尾缺值 → fail-closed（CHG-20260614-04 peek 下沉）', () => {
  const dir = makeV6Project('syncplan-plan-missing', { withIndex: false, detail: false });
  const helper = runSyncPlanHelper({ cwd: dir, args: ['--plan'] });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('缺值'), 'sync-plan --plan 末尾缺值应报缺值');
});

// CHG-20260620-01（审计 P3-3）：4 helper parseArgs 多余 positional fail-closed 对称（原静默丢弃，与 unknown-flag 不对称）
test('9hc-helper-pos1. reserve 多余 positional → fail-closed 计入 unknown（审计 P3-3）', () => {
  const dir = makeV6Project('reserve-extra-positional', { withIndex: false, detail: false });
  const helper = runReserveHelper({ cwd: dir, args: ['create-chg', 'extra-junk'], env: { CLAUDE_CODE_SESSION_ID: 'sid-reserve-extra-pos' } });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('不支持参数'), 'reserve 多余 positional 应 fail-closed（非静默丢弃）：' + helper.stdout);
  assert.ok(!helper.stdout.includes('reserved-id:'), '多余 positional 必须 fail-closed 不预留');
});

test('9hc-helper-pos2. set-project-root 多余 positional → fail-closed（审计 P3-3）', () => {
  const dir = makeV6Project('spr-extra-positional', { withIndex: false, detail: false });
  const helper = runSetProjectRootHelper({ cwd: dir, args: ['independent', 'extra-junk'] });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('不支持参数'), 'set-project-root 多余 positional 应 fail-closed：' + helper.stdout);
});

test('9hc-helper-pos3. set-artifact-root 多余 positional → fail-closed（审计 P3-3）', () => {
  const dir = makeV6Project('sar-extra-positional', { withIndex: false, detail: false });
  const helper = runSetArtifactRootHelper({ cwd: dir, args: ['local', 'extra-junk'] });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('不支持参数'), 'set-artifact-root 多余 positional 应 fail-closed：' + helper.stdout);
});

test('9hc-helper-pos4. sync-plan 多余 positional → fail-closed（审计 P3-3）', () => {
  const dir = makeV6Project('syncplan-extra-positional', { withIndex: false, detail: false });
  const helper = runSyncPlanHelper({ cwd: dir, args: ['plan.md', 'extra-junk'] });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('不支持参数'), 'sync-plan 多余 positional 应 fail-closed：' + helper.stdout);
});

test('9hc-helper-pos5. sync-plan 未知 flag → fail-closed（CHG-20260620-01 补 sync-plan 缺失的 unknown 处理）', () => {
  const dir = makeV6Project('syncplan-unknown-flag', { withIndex: false, detail: false });
  const helper = runSyncPlanHelper({ cwd: dir, args: ['--plan', 'plan.md', '--bogus-flag'] });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('不支持参数'), 'sync-plan 未知 flag 应 fail-closed（原静默吞）：' + helper.stdout);
});

test('9hc-helper-pos6. set-project-root 单 positional mode 正常解析放行（反向，不误伤）', () => {
  const dir = makeV6Project('spr-single-positional', { withIndex: false, detail: false });
  const helper = runSetProjectRootHelper({ cwd: dir, args: ['independent'] });
  assert.ok(!helper.stdout.includes('不支持参数'), '单 positional mode 不应误判 unknown：' + helper.stdout);
});

test('9hc-helper-pos7. set-activation 多余 positional → fail-closed（SA-1：CHG-20260620-01 漏的第 5 个写 .pace 状态 helper）', () => {
  const dir = makeV6Project('setactivation-extra-positional', { withIndex: false, detail: false });
  const helper = runSetActivationHelper({ cwd: dir, args: ['--status', 'extra-junk', '--cwd', dir] });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('不支持参数'), 'set-activation 多余 positional 应 fail-closed（非静默丢弃）：' + helper.stdout);
});

test('9hc-helper1b. reserve-artifact-id helper 在最小 v5 fixture 中不创建 changes', () => {
  const dir = makeTmpDir('agent-reserve-helper-v5-minimal');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n\n- [ ] legacy item\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), '# Implementation Plan\n\n- [ ] legacy impl\n', 'utf8');
  const helper = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-helper-v5-minimal' },
  });
  // CHG-20260612-02：v5 布局不再拦 reserve——正常发号并建出 changes/（v5 布局判定随之消失）
  assert.strictEqual(helper.code, 0);
  assert.ok(/reserved-id: (CHG|HOTFIX)-\d{8}-\d{2}/.test(helper.stdout), 'v5 布局上 reserve 正常发号');
  assert.strictEqual(fs.existsSync(path.join(dir, 'changes')), true, 'createTemplates 建出 changes/，新内容按当前合同写入');
});

test('9hc-helper2. reserve-artifact-id helper 默认复用未消费 reservation，--new 才分配新编号', () => {
  const dir = makeV6Project('agent-reserve-helper-reuse', { withIndex: false, detail: false });
  const env = { CLAUDE_CODE_SESSION_ID: 'sid-helper-reuse' };
  const first = runReserveHelper({ cwd: dir, args: ['--operation', 'create-chg'], env });
  const second = runReserveHelper({ cwd: dir, args: ['--operation', 'create-chg'], env });
  const third = runReserveHelper({ cwd: dir, args: ['--operation', 'create-chg', '--new'], env });
  assert.strictEqual(first.code, 0);
  assert.strictEqual(second.code, 0);
  assert.strictEqual(third.code, 0);
  assert.ok(first.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-01`));
  assert.ok(second.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-01`));
  assert.ok(second.stdout.includes('已复用当前 session 尚未消费的 reservation'));
  assert.ok(third.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-02`));
});

test('9hc-helper2a. reserve-artifact-id helper 支持 HOTFIX 类型且 --new 避免复用普通 CHG', () => {
  const dir = makeV6Project('agent-reserve-helper-hotfix', { withIndex: false, detail: false });
  const env = { CLAUDE_CODE_SESSION_ID: 'sid-helper-hotfix' };
  const chg = runReserveHelper({ cwd: dir, args: ['--operation', 'create-chg'], env });
  const hotfix = runReserveHelper({ cwd: dir, args: ['--operation', 'create-chg', '--type', 'hotfix', '--new'], env });
  assert.strictEqual(chg.code, 0);
  assert.strictEqual(hotfix.code, 0);
  const compact = today().replace(/-/g, '');
  assert.ok(chg.stdout.includes(`reserved-id: CHG-${compact}-01`));
  assert.ok(hotfix.stdout.includes(`reserved-id: HOTFIX-${compact}-01`));
  assert.ok(hotfix.stdout.includes(`reserved-file-prefix: changes/hotfix-${compact}-01-<slug>.md`));
});

test('T-2-slug. reserve create-chg 输出 reserved-file-prefix 含 <slug> 占位（CHG-slug）', () => {
  const dir = makeV6Project('reserve-chg-prefix', { withIndex: false, detail: false });
  const r = runReserveHelper({ cwd: dir, args: ['--operation', 'create-chg'], env: { CLAUDE_CODE_SESSION_ID: 'sid-chg-prefix' } });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /reserved-file-prefix: changes\/chg-\d{8}-\d{2}-<slug>\.md/, 'CHG 应输出 reserved-file-prefix 带 <slug> 占位');
  assert.doesNotMatch(r.stdout, /reserved-file: changes\/chg-\d{8}-\d{2}\.md/, '不应再输出精确 reserved-file');
});

test('T-4-slug. 旧无 slug CHG 文件仍被 readChangeDetail 找到（兼容不退化）', () => {
  const dir = makeTmpDir('t4-compat');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  // 旧无 slug 文件名 chg-id.md（slug 机制前创建）须被精确分支命中，不因 glob 改动退化。
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260101-01.md'), '---\nid: CHG-20260101-01\nstatus: completed\n---\n# 旧 CHG\n');
  const pu = require('../plugin/hooks/pace-utils');
  const detail = pu.readChangeDetail(dir, 'CHG-20260101-01');
  assert.ok(detail && !detail.missing, '旧无 slug CHG 应被 readChangeDetail 找到');
  assert.match(detail.content, /旧 CHG/);
  // 新带 slug 文件名 chg-id-slug.md 也应被 readChangeDetail 找到（glob 分支）。
  fs.writeFileSync(path.join(dir, 'changes', 'chg-20260101-02-some-feature.md'), '---\nid: CHG-20260101-02\nstatus: planned\n---\n# 新带 slug CHG\n');
  const slugDetail = pu.readChangeDetail(dir, 'CHG-20260101-02');
  assert.ok(slugDetail && !slugDetail.missing, '新带 slug CHG 应被 readChangeDetail 找到');
  assert.match(slugDetail.content, /新带 slug CHG/);
});

test('T-slug-R. create-chg deny 恢复文案全用 reserved-file-prefix（R 审计 P2-1 stale 防回归）', () => {
  const dir = makeV6Project('slug-r-stale-hint', { withIndex: false, detail: false });
  const prompt = `artifact_dir: ${dir.replace(/\\/g, '/')}/\noperation: create-chg\n创建一个新变更。`;
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-slug-r-stale', tool_name: 'Agent', tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'Create CHG', prompt } },
  });
  assert.ok(r.stdout.includes('"deny"'), '首次无 reserved 应 deny 并给恢复指引');
  // P2-1：CHG reserve 产出 reserved-file-prefix；恢复文案/模板不得残留裸 reserved-file，
  //   否则主 session 照填 → explicitReservationFromPrompt 解析出 fileRel → reservationMatchesExplicit
  //   因 CHG reservation 无 fileRel 判 mismatch 误拦。
  assert.ok(r.stdout.includes('reserved-file-prefix'), 'deny 文案应含 reserved-file-prefix 指引');
  assert.ok(!/reserved-file(?!-prefix)/.test(r.stdout), 'deny 文案不得残留裸 reserved-file（须全部 reserved-file-prefix）');
});

test('9hc-helper2b. reserve-artifact-id helper 拒绝 create-chg --type research', () => {
  const dir = makeV6Project('agent-reserve-helper-research-type', { withIndex: false, detail: false });
  const r = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--type', 'research'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-helper-research-type' },
  });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stdout.includes('只支持 change / hotfix'));
  assert.ok(r.stdout.includes('record-finding'));
});

test('RES-batch1. reserve --count 4 产 4 个连号 reserved-id', () => {
  const dir = makeV6Project('reserve-count', { withIndex: false, detail: false });
  const r = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--count', '4'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-reserve-count' },
  });
  assert.strictEqual(r.code, 0);
  const ids = (r.stdout.match(/reserved-id:\s*(CHG-\d{8}-\d{2})/g) || []).map(s => s.split(/\s+/).pop());
  assert.strictEqual(ids.length, 4, '应输出 4 个 reserved-id');
  const nums = ids.map(s => Number(s.match(/-(\d{2})$/)[1]));
  assert.deepStrictEqual(nums, [nums[0], nums[0] + 1, nums[0] + 2, nums[0] + 3], '应为 4 个连号');
  assert.ok(r.stdout.includes('# --- reserved 1/4 ---'), '每块应有 reserved i/N 标记');
  assert.ok(r.stdout.includes('# --- reserved 4/4 ---'));
});

test('RES-batch1b. reserve --count 3 持久化 3 条可匹配 reservation（供 batch create 匹配）', () => {
  const dir = makeV6Project('reserve-count-store', { withIndex: false, detail: false });
  const r = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--count', '3'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-reserve-count-store' },
  });
  assert.strictEqual(r.code, 0);
  const uniqueIds = [...new Set(r.stdout.match(/CHG-\d{8}-\d{2}/g) || [])];
  assert.strictEqual(uniqueIds.length, 3);
  const resDir = path.join(dir, '.pace', 'reservations');
  const storedIds = new Set(fs.readdirSync(resDir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(resDir, f), 'utf8')).id; } catch (e) { return null; } })
    .filter(Boolean));
  for (const id of uniqueIds) {
    assert.ok(storedIds.has(id), `reservation 应持久化 ${id}`);
  }
});

test('RES-batch2. reserve 默认 count=1 行为不变（回归）', () => {
  const dir = makeV6Project('reserve-default', { withIndex: false, detail: false });
  const r = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-reserve-default' },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual((r.stdout.match(/reserved-id:/g) || []).length, 1);
  assert.ok(!r.stdout.includes('# --- reserved'), '单条预留不应带 batch 标记');
  assert.ok(r.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-01`));
});

test('RES-batch3. reserve --count 0 → fail-closed 非零退出', () => {
  const dir = makeV6Project('reserve-bad-count-zero', { withIndex: false, detail: false });
  const r = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--count', '0'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-reserve-bad-zero' },
  });
  assert.notStrictEqual(r.code, 0);
  assert.ok(r.stdout.includes('--count'), '应说明 --count 约束');
  assert.ok(!r.stdout.includes('reserved-id:'), 'fail-closed 不应预留');
});

test('RES-batch4. reserve --count 非整数 → fail-closed', () => {
  const dir = makeV6Project('reserve-bad-count-nan', { withIndex: false, detail: false });
  const r = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--count', 'abc'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-reserve-bad-nan' },
  });
  assert.notStrictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('reserved-id:'));
});

test('RES-batch5. reserve --count 缺值吞掉后续 flag → fail-closed 不预留（H-01）', () => {
  const dir = makeV6Project('reserve-bad-count-swallow', { withIndex: false, detail: false });
  const r = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--count', '--new'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-reserve-bad-swallow' },
  });
  assert.notStrictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('reserved-id:'), '吞 flag 后必须 fail-closed，不能静默预留');
});

test('RES-batch6. reserve --count N 后下一次预留接在 first+N（counter advance-by-N 不变量护栏）', () => {
  const dir = makeV6Project('reserve-count-advance', { withIndex: false, detail: false });
  const batch = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--count', '4'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-advance-batch' },
  });
  assert.strictEqual(batch.code, 0);
  const batchNums = (batch.stdout.match(/CHG-\d{8}-(\d{2})/g) || []).map(s => Number(s.slice(-2)));
  const maxBatch = Math.max(...batchNums);
  // 不同 session + --new 强制新预留；此刻磁盘尚无 .md，counter 是唯一防线——
  // 若 counter 只 advance-by-1 而非 advance-by-N，下一号会落进 batchNums 造成真实重号碰撞。
  const next = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--new'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-advance-next' },
  });
  assert.strictEqual(next.code, 0);
  const nextNum = Number((next.stdout.match(/CHG-\d{8}-(\d{2})/) || [])[1]);
  assert.strictEqual(nextNum, maxBatch + 1, 'counter 必须 advance-by-N，下一号接在批量末号+1');
  assert.ok(!batchNums.includes(nextNum), '下一号不得落在批量已预留集合内（无碰撞）');
});

test('RES-batch7. reserve --count 末尾缺值 → fail-closed（不静默回落 count=1）', () => {
  const dir = makeV6Project('reserve-count-empty', { withIndex: false, detail: false });
  const r = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--count'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-count-empty' },
  });
  assert.notStrictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('reserved-id:'), '缺值必须 fail-closed');
});

test('RES-count-peek. reserve --count 后跟 flag → 走统一「参数缺值」fail-closed（不吞后续 flag，与 --operation/--cwd 一致，补 A4 缺口）', () => {
  const dir = makeV6Project('reserve-count-peek', { withIndex: false, detail: false });
  const r = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--count', '--cwd', dir],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-count-peek' },
  });
  assert.notStrictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('reserved-id:'), '缺值 fail-closed 不预留');
  assert.ok(r.stdout.includes('参数缺值') && r.stdout.includes('--count'),
    '--count 后跟 flag 应走统一 DENY_MISSING_VALUE「参数缺值」（与 --operation/--cwd 一致），而非「非法 count」误吞 --cwd');
});

test('RES-batch8. reserve --count 科学计数法/超上限 → fail-closed', () => {
  const dir = makeV6Project('reserve-count-overmax', { withIndex: false, detail: false });
  const sci = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--count', '1e3'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-count-sci' },
  });
  assert.notStrictEqual(sci.code, 0, '1e3 非纯十进制应拒绝');
  const over = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg', '--count', '999'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-count-over' },
  });
  assert.notStrictEqual(over.code, 0, '超上限应拒绝');
  assert.ok(!sci.stdout.includes('reserved-id:') && !over.stdout.includes('reserved-id:'));
});

test('RES-batch9. reserve --count >1 仅限 create-chg（record-correction 批量 fail-closed）', () => {
  const dir = makeV6Project('reserve-count-correction', { withIndex: false, detail: false });
  const r = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'record-correction', '--count', '3'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-count-corr' },
  });
  assert.notStrictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('reserved-id:'));
});

test('RES-correction-slug. record-correction caller 替换 <slug> 后 reserved-file-prefix 仍匹配预留前缀（HOTFIX-20260609-01）', () => {
  const { explicitReservationFromPrompt, reservationMatchesExplicit } = require(path.join(__dirname, '..', 'plugin', 'hooks', 'pre-tool-use', 'agent-lifecycle-guard'));
  const reservation = { filePrefix: 'changes/corrections/correction-2026-06-08-03-' };
  // caller 按 reserve 提示把 <slug> 替换成真实 slug（合理行为——prompt 要给 agent 真实文件名）
  const promptReplaced = 'operation: record-correction\nreserved-file-prefix: changes/corrections/correction-2026-06-08-03-subagent-judgment-opus.md\n';
  assert.ok(reservationMatchesExplicit(reservation, explicitReservationFromPrompt(promptReplaced)), 'caller 替换 slug 后完整名应匹配预留前缀');
  // caller 原样保留 <slug>.md（parseExplicit 去掉后 = 前缀）也应匹配
  const promptLiteral = 'operation: record-correction\nreserved-file-prefix: changes/corrections/correction-2026-06-08-03-<slug>.md\n';
  assert.ok(reservationMatchesExplicit(reservation, explicitReservationFromPrompt(promptLiteral)), '原样 <slug>.md 也应匹配');
  // 验反向（widen-matcher-verify-reverse）：不同 correction 前缀不互相匹配，no over-match
  const promptOther = 'operation: record-correction\nreserved-file-prefix: changes/corrections/correction-2026-06-08-04-other-fix.md\n';
  assert.ok(!reservationMatchesExplicit(reservation, explicitReservationFromPrompt(promptOther)), '不同 correction（-04-）不应匹配 -03- 前缀');
});

// batch create CHG（CHG-B）：agent-lifecycle-guard 确定性校验 + pre-tool-use reserved-id 集合匹配
function batchCreatePrompt(dir, changeSet, blocks, { total } = {}) {
  const header = [
    `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
    'operation: create-chg',
  ];
  if (changeSet !== null) header.push(`change-set: ${changeSet}`);
  header.push(`change-set-total: ${total === undefined ? blocks.length : total}`);
  const blockLines = blocks.map((b, i) => [
    `--- CHG ${b.seq || i + 1}/${b.n || blocks.length} ---`,
    ...(b.id === null ? [] : [`reserved-id: ${b.id}`]),
    ...(b.title === null ? [] : [`title: ${b.title}`]),
    ...(b.noTasks ? [] : ['tasks:', `  - T-001: ${b.tasks || '任务与验收'}`]),
  ].join('\n'));
  return [...header, ...blockLines].join('\n');
}

function runBatchAgent(dir, sessionId, prompt) {
  return runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: sessionId,
      tool_name: 'Agent',
      tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'batch create', prompt },
    },
  });
}

test('BCG-1. batch create 带齐 2 块 + 匹配 reserved-id → 放行', () => {
  const dir = makeV6Project('batch-ok', { withIndex: false, detail: false });
  const env = { CLAUDE_CODE_SESSION_ID: 'sid-batch-ok' };
  const res = runReserveHelper({ cwd: dir, args: ['--operation', 'create-chg', '--count', '2'], env });
  const ids = [...new Set(res.stdout.match(/CHG-\d{8}-\d{2}/g) || [])];
  assert.strictEqual(ids.length, 2);
  const prompt = batchCreatePrompt(dir, 'review-gate', [{ id: ids[0], title: '阶段一' }, { id: ids[1], title: '阶段二' }]);
  const r = runBatchAgent(dir, 'sid-batch-ok', prompt);
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), 'batch 带齐应放行');
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
});

test('BCG-2. batch 某块缺 title → DENY（含块号）', () => {
  const dir = makeV6Project('batch-no-title', { withIndex: false, detail: false });
  const prompt = batchCreatePrompt(dir, 'x', [{ id: 'CHG-20260607-90', title: '有标题' }, { id: 'CHG-20260607-91', title: null }]);
  const r = runBatchAgent(dir, 'sid-bcg2', prompt);
  assert.ok(r.stdout.includes('"deny"'), '缺 title 应 deny');
  assert.ok(r.stdout.includes('title'));
});

test('BCG-3. batch reserved-id 与 hook 预留不匹配 → DENY', () => {
  const dir = makeV6Project('batch-bad-id', { withIndex: false, detail: false });
  const env = { CLAUDE_CODE_SESSION_ID: 'sid-batch-bad' };
  runReserveHelper({ cwd: dir, args: ['--operation', 'create-chg', '--count', '2'], env });
  const prompt = batchCreatePrompt(dir, 'x', [{ id: 'CHG-20260607-91', title: 'a' }, { id: 'CHG-20260607-92', title: 'b' }]);
  const r = runBatchAgent(dir, 'sid-batch-bad', prompt);
  assert.ok(r.stdout.includes('"deny"'), '未匹配预留应 deny');
  assert.ok(r.stdout.includes('reserved-id') || r.stdout.includes('预留'));
});

test('BCG-3b. batch 仅后块 reserved-id 不匹配 → DENY（验证全 N 个 id 而非仅首块）', () => {
  const dir = makeV6Project('batch-bad-id-2nd', { withIndex: false, detail: false });
  const env = { CLAUDE_CODE_SESSION_ID: 'sid-batch-bad2' };
  const res = runReserveHelper({ cwd: dir, args: ['--operation', 'create-chg', '--count', '2'], env });
  const ids = [...new Set(res.stdout.match(/CHG-\d{8}-\d{2}/g) || [])];
  assert.strictEqual(ids.length, 2);
  // 首块用有效预留，次块用不存在的编号——若只校验首块会漏放行
  const prompt = batchCreatePrompt(dir, 'x', [{ id: ids[0], title: 'a' }, { id: 'CHG-20260607-93', title: 'b' }]);
  const r = runBatchAgent(dir, 'sid-batch-bad2', prompt);
  assert.ok(r.stdout.includes('"deny"'), '后块 id 不匹配必须 deny（全 N 校验）');
  assert.ok(r.stdout.includes('CHG-20260607-93') || r.stdout.includes('reserved-id') || r.stdout.includes('预留'));
});

test('BCG-4. batch change-set-total 与实际块数不符 → DENY', () => {
  const dir = makeV6Project('batch-count-mismatch', { withIndex: false, detail: false });
  const prompt = batchCreatePrompt(dir, 'x', [{ id: 'CHG-20260607-90', title: 'a', n: 3 }, { id: 'CHG-20260607-91', title: 'b', n: 3 }], { total: 3 });
  const r = runBatchAgent(dir, 'sid-bcg4', prompt);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('change-set-total') || r.stdout.includes('块数'));
});

test('BCG-5. batch 缺 change-set → DENY', () => {
  const dir = makeV6Project('batch-no-cs', { withIndex: false, detail: false });
  const prompt = batchCreatePrompt(dir, null, [{ id: 'CHG-20260607-90', title: 'a' }, { id: 'CHG-20260607-91', title: 'b' }]);
  const r = runBatchAgent(dir, 'sid-bcg5', prompt);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('change-set'));
});

test('BCG-6. 单 CHG（无 --- CHG 块）走现有路径放行（回归）', () => {
  const dir = makeV6Project('batch-single-regression', { withIndex: false, detail: false });
  const env = { CLAUDE_CODE_SESSION_ID: 'sid-single-reg' };
  const res = runReserveHelper({ cwd: dir, args: ['--operation', 'create-chg'], env });
  const id = (res.stdout.match(/CHG-\d{8}-\d{2}/) || [])[0];
  const prompt = `artifact_dir: ${dir.replace(/\\/g, '/')}/\noperation: create-chg\nreserved-id: ${id}\nreserved-file-prefix: changes/${id.toLowerCase()}-<slug>.md\ntitle: 单条\ntasks:\n- T-001: do`;
  const r = runBatchAgent(dir, 'sid-single-reg', prompt);
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), '单 CHG 应回归放行');
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
});

test('BCG-8. batch 块内 title 为空（值在下一行字段）→ DENY（不被跨行吞值绕过）', () => {
  const dir = makeV6Project('batch-empty-title', { withIndex: false, detail: false });
  const prompt = [
    `artifact_dir: ${dir.replace(/\\/g, '/')}/`, 'operation: create-chg', 'change-set: x', 'change-set-total: 2',
    '--- CHG 1/2 ---', 'reserved-id: CHG-20260607-90', 'title:', 'tasks:', '  - T-001: a',
    '--- CHG 2/2 ---', 'reserved-id: CHG-20260607-91', 'title: 有标题', 'tasks:', '  - T-001: b',
  ].join('\n');
  const r = runBatchAgent(dir, 'sid-bcg8', prompt);
  assert.ok(r.stdout.includes('"deny"'), '空 title 必须 deny（不能被吞下一行 tasks: 当 title）');
  assert.ok(r.stdout.includes('title'));
});

test('BCG-7. batch deny 文案含多块模板骨架（--- CHG i/N --- + change-set）', () => {
  const dir = makeV6Project('batch-template', { withIndex: false, detail: false });
  const prompt = batchCreatePrompt(dir, null, [{ id: 'CHG-20260607-90', title: 'a' }, { id: 'CHG-20260607-91', title: 'b' }]);
  const r = runBatchAgent(dir, 'sid-bcg7', prompt);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('--- CHG'), 'deny 文案应含 batch 多块模板骨架');
  assert.ok(r.stdout.includes('change-set-total'), 'deny 文案应含 change-set-total 模板字段');
});

test('9hc-helper3. reserve-artifact-id helper 支持 record-correction prefix', () => {
  const dir = makeV6Project('agent-reserve-helper-correction', { withIndex: false, detail: false });
  const helper = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'record-correction'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-helper-correction' },
  });
  assert.strictEqual(helper.code, 0);
  assert.ok(helper.stdout.includes(`reserved-id: CORRECTION-${today()}-01`));
  assert.ok(helper.stdout.includes(`reserved-file-prefix: changes/corrections/correction-${today()}-01-<slug>.md`));
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-helper-correction',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Record correction',
        prompt: `${helper.stdout}\ntrigger-quote: test\nwrong-behavior: wrong behavior details are long enough\ncorrect-behavior: correct behavior details are long enough\ntrigger-scenario: helper\nroot-cause: helper\nproject-scope: project-only`,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

test('9hc-helper4. reserve-artifact-id helper 在 root 未选择时只提示选择，不落项目运行态', () => {
  const dir = makeTmpDir('agent-reserve-helper-root-choice');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  const helper = runReserveHelper({
    cwd: dir,
    args: ['--operation', 'create-chg'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-helper-choice' },
  });
  assert.strictEqual(helper.code, 2);
  assert.ok(helper.stdout.includes('PACEflow 首次启用需要选择 artifact 存放位置'));
  assert.ok(helper.stdout.includes('AskUserQuestion'));
  assert.ok(!fs.existsSync(path.join(dir, '.pace')), 'root 选择前 helper 不应创建项目 .pace/');
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), 'root 选择前 helper 不应懒创建 changes/');
});

test('9hc-helper4a. set-artifact-root helper 在 git worktree 写宿主 artifact-root', () => {
  const root = makeTmpDir('set-root-helper-worktree-root');
  const host = path.join(root, 'project-a');
  const worktree = path.join(root, 'project-a-wt');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'project-a-wt'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'project-a-wt')}\n`, 'utf8');

  const setRoot = runSetArtifactRootHelper({ cwd: worktree, args: ['--choice', 'local'] });
  assert.strictEqual(setRoot.code, 0);
  assert.ok(setRoot.stdout.includes(`config-file: ${path.join(host, '.pace', 'artifact-root').replace(/\\/g, '/')}`));
  assert.ok(setRoot.stdout.includes('choice: local'));
  assert.ok(setRoot.stdout.includes('execution-context: [worktree:: project-a-wt]'));
  assert.ok(setRoot.stdout.includes('不要在当前子目录另写 .pace/artifact-root'));
  assert.ok(setRoot.stdout.includes('reserve-artifact-id.js'));
  assert.ok(setRoot.stdout.includes(`--cwd "${worktree.replace(/\\/g, '/')}"`));
  assert.strictEqual(fs.readFileSync(path.join(host, '.pace', 'artifact-root'), 'utf8'), 'local\n');
  assert.ok(!fs.existsSync(path.join(worktree, '.pace', 'artifact-root')), '不应写 worktree 本地 artifact-root');

  const reserve = runReserveHelper({
    cwd: worktree,
    args: ['--operation', 'create-chg'],
    env: { CLAUDE_CODE_SESSION_ID: 'sid-set-root-worktree' },
  });
  assert.strictEqual(reserve.code, 0);
  assert.ok(reserve.stdout.includes(`artifact_dir: ${host.replace(/\\/g, '/')}/`));
  assert.ok(reserve.stdout.includes('execution-context: [worktree:: project-a-wt]'));
  assert.ok(fs.existsSync(path.join(host, 'changes')), 'reserve helper 应在宿主 artifact root 懒创建 changes/');
  assert.ok(!fs.existsSync(path.join(worktree, 'changes')), 'worktree 分支目录不应创建 artifact changes/');
});

test('9hc-helper4a1. set-artifact-root helper 报告覆写旧 choice 且拒绝 env 冲突', () => {
  const dir = makeTmpDir('set-root-helper-choice-conflict');
  const first = runSetArtifactRootHelper({ cwd: dir, args: ['--choice', 'local'] });
  assert.strictEqual(first.code, 0);
  const second = runSetArtifactRootHelper({ cwd: dir, args: ['--choice', 'vault'] });
  assert.strictEqual(second.code, 0);
  assert.ok(second.stdout.includes('previous-choice: local'));

  const conflict = runSetArtifactRootHelper({
    cwd: dir,
    args: ['--choice', 'local'],
    env: { PACE_ARTIFACT_ROOT: 'vault' },
  });
  assert.strictEqual(conflict.code, 2);
  assert.ok(conflict.stdout.includes('DENY_ENV_CHOICE_CONFLICT') || conflict.stdout.includes('环境变量'));
});

test('9hc-helper4a3. set-artifact-root --choice 缺值吞掉后续 --cwd flag → fail-closed 不写配置（H-01）', () => {
  const dir = makeTmpDir('set-root-missing-choice');
  const other = makeTmpDir('set-root-other-cwd');
  // bug：--choice 用 argv[++i] 无条件吞掉下一 token，把 --cwd 当作 choice 值，写出伪造配置且 exit 0
  const r = runSetArtifactRootHelper({ cwd: dir, args: ['--choice', '--cwd', other] });
  assert.notStrictEqual(r.code, 0, '取值型 flag 缺值应 fail-closed（exit≠0）');
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'artifact-root')), '缺值时不应写出 artifact-root 配置');
});

test('9hc-helper4a4. set-artifact-root --cwd 末尾缺值 → fail-closed（H-01）', () => {
  const dir = makeTmpDir('set-root-missing-cwd');
  const r = runSetArtifactRootHelper({ cwd: dir, args: ['--choice', 'local', '--cwd'] });
  assert.notStrictEqual(r.code, 0, '--cwd 缺值应 fail-closed');
});

test('9hc-helper4e. set-project-root --cwd/--mode 缺值 → fail-closed 不写 .pace（codex H-01 对称）', () => {
  const dir = makeTmpDir('set-project-root-missing-value');
  // bug：--cwd 用 argv[++i] 无条件吞下一 token，把 --mode 当 cwd 值写到 ./--mode/.pace
  const r1 = spawnSync('node', [SET_PROJECT_ROOT_HELPER, '--cwd', '--mode', 'independent'], { cwd: dir, encoding: 'utf8' });
  assert.notStrictEqual(r1.status, 0, '--cwd 缺值（吞 --mode flag）应 fail-closed（exit≠0）');
  assert.ok(!fs.existsSync(path.join(dir, '--mode', '.pace')), '不应把 --mode 当路径写 ./--mode/.pace');
  const r2 = spawnSync('node', [SET_PROJECT_ROOT_HELPER, '--mode'], { cwd: dir, encoding: 'utf8' });
  assert.notStrictEqual(r2.status, 0, '--mode 末尾缺值应 fail-closed');
});

test('9hc-helper4a2. 继承子目录 set-artifact-root 写父 Project Root runtime', () => {
  const root = makeTmpDir('set-root-helper-subdir-parent');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(path.join(root, 'changes'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });

  const r = runSetArtifactRootHelper({ cwd: child, args: ['--choice', 'local'] });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes(`project-root: ${root.replace(/\\/g, '/')}`));
  assert.ok(r.stdout.includes(`artifact-root: ${root.replace(/\\/g, '/')}/`));
  assert.ok(r.stdout.includes('不写入当前 cwd'));
  assert.strictEqual(fs.readFileSync(path.join(root, '.pace', 'artifact-root'), 'utf8'), 'local\n');
  assert.ok(!fs.existsSync(path.join(child, '.pace', 'artifact-root')), '不应写子目录 artifact-root');
});

test('9hc-helper4b. worktree 本地 .pace/artifact-root 写入被提示改用 helper', () => {
  const root = makeTmpDir('set-root-helper-worktree-deny-root');
  const host = path.join(root, 'project-a');
  const worktree = path.join(root, 'project-a-wt');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'project-a-wt'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'project-a-wt')}\n`, 'utf8');

  const write = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: {
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(worktree, '.pace', 'artifact-root'),
        content: 'local\n',
      },
    },
  });
  assert.strictEqual(write.code, 0);
  assert.ok(write.stdout.includes('"deny"'));
  assert.ok(write.stdout.includes('DENY_LOCAL_ARTIFACT_ROOT_CHOICE') || write.stdout.includes('继承了外层 PaceFlow Project Root'));
  assert.ok(write.stdout.includes('set-artifact-root.js'));
  assert.ok(write.stdout.includes(path.join(host, '.pace', 'artifact-root').replace(/\\/g, '/')));

  const bash = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: {
      tool_name: 'Bash',
      tool_input: {
        command: 'mkdir -p .pace && echo local > .pace/artifact-root',
      },
    },
  });
  assert.strictEqual(bash.code, 0);
  assert.ok(bash.stdout.includes('"deny"'));
  assert.ok(bash.stdout.includes('set-artifact-root.js'));
  assert.ok(!fs.existsSync(path.join(worktree, '.pace', 'artifact-root')), '被拦截后不应产生 worktree 本地配置');

  const powershell = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: {
      tool_name: 'PowerShell',
      tool_input: {
        command: 'New-Item -ItemType Directory .pace -Force; Set-Content .pace\\artifact-root local',
      },
    },
  });
  assert.strictEqual(powershell.code, 0);
  assert.ok(powershell.stdout.includes('"deny"'));
  assert.ok(powershell.stdout.includes('set-artifact-root.js'));
});

test('9hc-helper4c. 普通继承子目录本地 .pace/artifact-root 写入被提示改用 helper', () => {
  const root = makeTmpDir('set-root-helper-subdir-deny-root');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(root, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pace', 'artifact-root'), 'local\n', 'utf8');

  const write = runHook('pre-tool-use.js', {
    cwd: child,
    stdin: {
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(child, '.pace', 'artifact-root'),
        content: 'local\n',
      },
    },
  });
  assert.strictEqual(write.code, 0);
  assert.ok(write.stdout.includes('"deny"'));
  assert.ok(write.stdout.includes('继承了外层 PaceFlow Project Root'));
  assert.ok(write.stdout.includes('Project Root'));
  assert.ok(write.stdout.includes(path.join(root, '.pace', 'artifact-root').replace(/\\/g, '/')));
  assert.ok(!fs.existsSync(path.join(child, '.pace', 'artifact-root')));
});

test('9hc-helper4d. .pace/project-root 不能手写，必须通过 set-project-root helper', () => {
  const root = makeTmpDir('set-project-root-direct-deny-root');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(root, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pace', 'artifact-root'), 'local\n', 'utf8');

  const write = runHook('pre-tool-use.js', {
    cwd: child,
    stdin: {
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(child, '.pace', 'project-root'),
        content: 'independent\n',
      },
    },
  });
  assert.strictEqual(write.code, 0);
  assert.ok(write.stdout.includes('"deny"'));
  assert.ok(write.stdout.includes('禁止手写 .pace/project-root'));
  assert.ok(write.stdout.includes('set-project-root.js'));
  assert.ok(!fs.existsSync(path.join(child, '.pace', 'project-root')));

  const bash = runHook('pre-tool-use.js', {
    cwd: child,
    stdin: {
      tool_name: 'Bash',
      tool_input: {
        command: 'mkdir -p .pace && echo independent > .pace/project-root',
      },
    },
  });
  assert.strictEqual(bash.code, 0);
  assert.ok(bash.stdout.includes('"deny"'));
  assert.ok(bash.stdout.includes('set-project-root.js'));

  const powershell = runHook('pre-tool-use.js', {
    cwd: child,
    stdin: {
      tool_name: 'PowerShell',
      tool_input: {
        command: 'New-Item -ItemType Directory .pace -Force; Set-Content .pace\\project-root independent',
      },
    },
  });
  assert.strictEqual(powershell.code, 0);
  assert.ok(powershell.stdout.includes('"deny"'));
  assert.ok(powershell.stdout.includes('set-project-root.js'));

  const monitor = runHook('pre-tool-use.js', {
    cwd: child,
    stdin: {
      tool_name: 'Monitor',
      tool_input: {
        command: 'mkdir -p .pace && echo independent > .pace/project-root',
      },
    },
  });
  assert.strictEqual(monitor.code, 0);
  assert.ok(monitor.stdout.includes('"deny"'));
  assert.ok(monitor.stdout.includes('set-project-root.js'));
});

test('9hc-helper5. sync-plan helper 幂等写入单个 plan basename', () => {
  const dir = makeTmpDir('plan-sync-helper');
  const plan = path.join(dir, 'docs', 'plans', '2026-05-11-helper-smoke.md');
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, '# helper smoke\n', 'utf8');

  const help = runSyncPlanHelper({ cwd: dir, args: ['--help'] });
  assert.strictEqual(help.code, 0);
  assert.ok(help.stdout.includes(SYNC_PLAN_HELPER.replace(/\\/g, '/')), 'help 应展示可直接运行的绝对 helper 路径');

  const first = runSyncPlanHelper({ cwd: dir, args: ['--plan', plan] });
  const second = runSyncPlanHelper({ cwd: dir, args: ['--plan', plan] });
  assert.strictEqual(first.code, 0);
  assert.strictEqual(second.code, 0);
  assert.ok(first.stdout.includes('synced-plan: 2026-05-11-helper-smoke.md'));
  assert.ok(second.stdout.includes('plan 已经标记为同步'));

  const syncedPath = path.join(dir, '.pace', 'synced-plans');
  const lines = fs.readFileSync(syncedPath, 'utf8').trim().split('\n');
  assert.deepStrictEqual(lines, ['2026-05-11-helper-smoke.md']);
});

test('9hc-helper6. sync-plan helper 在 git worktree 写宿主 .pace/synced-plans', () => {
  const root = makeTmpDir('plan-sync-helper-worktree-root');
  const host = path.join(root, 'project-a');
  const worktree = path.join(root, 'project-a-wt');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'project-a-wt'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'project-a-wt')}\n`, 'utf8');
  const plan = path.join(host, 'docs', 'plans', '2026-05-11-worktree-plan.md');
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, '# worktree plan\n', 'utf8');

  const r = runSyncPlanHelper({ cwd: worktree, args: ['--plan', plan] });
  assert.strictEqual(r.code, 0);
  assert.ok(fs.existsSync(path.join(host, '.pace', 'synced-plans')), '应写宿主项目 runtime');
  assert.strictEqual(fs.readFileSync(path.join(host, '.pace', 'synced-plans'), 'utf8'), '2026-05-11-worktree-plan.md\n');
  assert.ok(!fs.existsSync(path.join(worktree, '.pace', 'synced-plans')), '不应写 worktree 自己的 runtime');
});

test('9hc-helper6a. sync-plan helper 在继承子目录写父 Project Root synced-plans', () => {
  const root = makeTmpDir('plan-sync-helper-subdir-root');
  const child = path.join(root, 'packages', 'api');
  const plan = path.join(root, 'docs', 'plans', '2026-05-22-subdir-plan.md');
  fs.mkdirSync(path.join(root, 'changes'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, '# inherited subdir plan\n', 'utf8');

  const r = runSyncPlanHelper({ cwd: child, args: ['--plan', plan] });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(path.join(root, '.pace', 'synced-plans'), 'utf8'), '2026-05-22-subdir-plan.md\n');
  assert.ok(!fs.existsSync(path.join(child, '.pace', 'synced-plans')), '继承子目录不应写自己的 synced-plans');
});

test('9hc-mismatch. create-chg 显式 reserved-id 与 hook reservation 不匹配 → DENY', () => {
  const dir = makeV6Project('agent-reserved-mismatch');
  const prompt = `artifact_dir: ${dir.replace(/\\/g, '/')}/\noperation: create-chg\n使用 create-chg 流程创建一个新的变更记录。`;
  const first = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-reserved-mismatch',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  assert.strictEqual(first.code, 0);
  assert.ok(first.stdout.includes('"deny"'));
  assert.ok(first.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-01`));

  const staleId = `CHG-${today().replace(/-/g, '')}-99`;
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-reserved-mismatch',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: `${prompt}\nreserved-id: ${staleId}\nreserved-file: changes/${staleId.toLowerCase()}.md`,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('未匹配到 hook reservation'));
  assert.ok(r.stdout.includes('不要手写或复用旧 session 的 reserved-id'));
});

test('9hc-correction. record-correction 首次预留 prefix 后重派 → 放行并允许写详情', () => {
  const dir = makeV6Project('agent-correction-reserved');
  const prompt = [
    `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
    'operation: record-correction',
    'trigger-quote: 用户纠正了实现',
    'wrong-behavior: 错误行为说明',
    'correct-behavior: 正确行为说明',
    'trigger-scenario: smoke',
    'root-cause: test',
    'project-scope: project-only',
  ].join('\n');
  const first = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-correction-reserved',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Record correction',
        prompt,
      },
    },
  });
  assert.strictEqual(first.code, 0);
  assert.ok(first.stdout.includes('"deny"'));
  const reserved = reservedFromStdout(first.stdout);
  assert.ok(reserved.id && reserved.prefix);

  const pre = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-correction-reserved',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Record correction',
        prompt: `${prompt}\nreserved-id: ${reserved.id}\nreserved-file-prefix: ${reserved.prefix}<slug>.md`,
      },
    },
  });
  assert.strictEqual(pre.code, 0);
  assert.ok(!pre.stdout.includes('"deny"'));

  const write = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-correction-reserved',
      agent_id: 'agent-correction-reserved',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, `${reserved.prefix}smoke.md`),
        content: '# Correction: smoke\n',
      },
    },
  });
  assert.strictEqual(write.code, 0);
  assert.ok(!write.stdout.includes('"deny"'));
});

test('9hc0. artifact-writer Agent 首次派遣预留唯一 ID、要求重派且不持项目级锁', () => {
  const dir = makeV6Project('agent-artifact-lock');
  const prompt = `artifact_dir: ${dir.replace(/\\/g, '/')}/\noperation: create-chg\n使用 create-chg 流程创建一个新的变更记录。`;
  const first = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-lock-1',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  assert.strictEqual(first.code, 0);
  assert.ok(first.stdout.includes('"deny"'));
  assert.ok(first.stdout.includes('重派 artifact-writer'));
  assert.ok(first.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-01`));
  const lockPath = path.join(dir, '.pace', 'artifact-writer.lock');
  assert.ok(!fs.existsSync(lockPath), '新版本 Agent 派遣不再创建项目级 artifact-writer.lock');

  const second = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-lock-2',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  assert.strictEqual(second.code, 0);
  assert.ok(second.stdout.includes('"deny"'));
  assert.ok(second.stdout.includes('重派 artifact-writer'));
  assert.ok(second.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-02`));
});

test('9hc0w. 真实 git worktree 共享宿主 reservation/sequence 且并发派遣不互斥', () => {
  const { worktree, vaultDir } = makeVaultBackedWorktree('agent-artifact-lock-worktree');
  const host = path.dirname(path.dirname(worktree));
  const sibling = path.join(host, 'worktrees', 'smoke-2');
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'smoke-2')}\n`, 'utf8');
  const prompt = `artifact_dir: ${vaultDir.replace(/\\/g, '/')}/\noperation: create-chg\n使用 create-chg 流程创建一个新的变更记录。`;

  const first = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: {
      session_id: 'sid-wt-1',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  assert.strictEqual(first.code, 0);
  assert.ok(first.stdout.includes('"deny"'));
  assert.ok(first.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-01`));
  assert.ok(!fs.existsSync(path.join(host, '.pace', 'artifact-writer.lock')), 'worktree 不再创建项目级 artifact-writer.lock');
  assert.ok(fs.existsSync(path.join(host, '.pace', 'sequences', safeLockName(`chg-${today().replace(/-/g, '')}`) + '.counter')), 'sequence counter 应落在宿主 .pace');

  const second = runHook('pre-tool-use.js', {
    cwd: sibling,
    stdin: {
      session_id: 'sid-wt-2',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  assert.strictEqual(second.code, 0);
  assert.ok(second.stdout.includes('"deny"'));
  assert.ok(second.stdout.includes(`reserved-id: CHG-${today().replace(/-/g, '')}-02`));
});

test('9hc0a. SubagentStop 清理 artifact-writer 残留 resource lock/reservation', () => {
  const dir = makeV6Project('agent-artifact-lock-release');
  const lockPath = seedArtifactResourceLock(dir, 'detail:changes/chg-20260504-01.md', {
    sessionId: 'sid-release-1',
    agentId: 'agent-release-1',
    file: path.join(dir, 'changes', 'chg-20260504-01.md'),
  });
  fs.mkdirSync(path.join(dir, '.pace', 'reservations'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'reservations', `${safeLockName('agent:agent-release-1')}.json`), '{}\n', 'utf8');
  assert.ok(fs.existsSync(lockPath));

  const stop = runHook('subagent-stop.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-release-1',
      agent_id: 'agent-release-1',
      agent_type: 'paceflow:artifact-writer',
      last_assistant_message: '## artifact-writer 报告\n\n**状态**：SUCCESS\n',
    },
  });
  assert.strictEqual(stop.code, 0);
  assert.strictEqual(stop.stdout, '');
  assert.ok(!fs.existsSync(lockPath), 'SubagentStop 应释放同 owner 的 resource lock');
});

test('9hc0a2. PostToolUseFailure:Agent 清理 artifact-writer resource lock', () => {
  const dir = makeV6Project('agent-artifact-lock-agent-failure');
  const lockPath = seedArtifactResourceLock(dir, 'detail:changes/chg-20260504-01.md', {
    sessionId: 'sid-agent-failure',
    agentId: 'agent-failure-1',
    file: path.join(dir, 'changes', 'chg-20260504-01.md'),
  });
  assert.ok(fs.existsSync(lockPath), '测试前应存在 resource lock');

  const failure = runHook('post-tool-use-failure.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-agent-failure',
      agent_id: 'agent-failure-1',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: 'operation: create-chg',
      },
      error: 'Agent tool failed before subagent stop',
    },
  });
  assert.strictEqual(failure.code, 0);
  const out = JSON.parse(failure.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Agent 执行失败'));
  assert.ok(!fs.existsSync(lockPath), 'Agent 工具失败时应清理 resource lock');
});

test('9a04. 非 artifact 信号项目 Edit managed artifact 与 Write 对称拦截（A04）', () => {
  const dir = makeTmpDir('ptu-a04-manual-signal');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  // VT-01：去三重兜底门，使唯一拦截点是 A04（A04 移除时此 Edit 放行 → 测试 FAIL，恢复判别力）：
  // ① artifact-root=local 中和 vault routing 使 artDir===cwd（否则 artifact_dir 不匹配门先 deny，文案不含 artifact-writer）；
  // ② task.md 不含 v5 签名（无 <!-- ARCHIVE -->/项目任务追踪/活跃任务/### CHG-，见 legacyV5FilesInDir）避免 legacy-v5 门；
  // ③ Edit 普通字段修改（不注入 <!-- APPROVED --> marker）避免 marker 门。
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'task.md'), '# 任务\n\n- [ ] T-001 一个任务条目\n', 'utf8');
  const edit = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'task.md'), old_string: '- [ ] T-001 一个任务条目', new_string: '- [ ] T-001 修改后的任务标题' } },
  });
  assert.ok(edit.stdout.includes('"deny"'), 'manual 信号 Edit managed artifact 应 deny');
  assert.ok(edit.stdout.includes('artifact-writer'), 'deny 文案应指向 artifact-writer');
  // 对照 Write 同样 deny（本就对称，回归）
  const write = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'task.md'), content: 'x' } },
  });
  assert.ok(write.stdout.includes('"deny"'), 'manual 信号 Write managed artifact deny（回归）');
});

test('9hc0a3. PreToolUse 读取 artifact resource stale lock 时自愈', () => {
  const dir = makeV6Project('agent-artifact-stale-lock-read-self-heal');
  const lockPath = seedArtifactResourceLock(dir, 'detail:changes/chg-20260504-01.md', {
    sessionId: 'sid-stale-resource',
    agentId: 'agent-stale-resource',
    file: path.join(dir, 'changes', 'chg-20260504-01.md'),
    timestampMs: Date.now() - 10 * 60 * 1000,
  });
  assert.ok(fs.existsSync(lockPath), '测试前应存在 stale resource lock');

  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-new-resource-owner',
      agent_id: 'agent-new-resource-owner',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(dir, 'changes', 'chg-20260504-01.md'),
        old_string: '## 工作记录',
        new_string: '## 工作记录',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('当前 artifact 正由 artifact-writer 写入'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.strictEqual(lock.sessionId, 'sid-new-resource-owner');
});

test('9hc0b. artifact-writer 新建 CHG 详情必须使用 hook 预留编号', () => {
  const dir = makeV6Project('agent-artifact-lock-write-deny');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-no-lock',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, 'changes', `chg-${today().replace(/-/g, '')}-01.md`),
        content: '# new detail\n',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('没有 hook 预留编号'));
});

test('9hc0b1. 主 session 不得用 Edit/MultiEdit 直接修改 artifact', () => {
  const dir = makeV6Project('direct-artifact-edit-deny');
  const cases = [
    {
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(dir, 'task.md'),
        old_string: '<!-- ARCHIVE -->',
        new_string: 'test\n<!-- ARCHIVE -->',
      },
    },
    {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: path.join(dir, 'implementation_plan.md'),
        edits: [
          {
            old_string: '<!-- ARCHIVE -->',
            new_string: 'test\n<!-- ARCHIVE -->',
          },
        ],
      },
    },
  ];

  for (const stdin of cases) {
    const r = runHook('pre-tool-use.js', { cwd: dir, stdin });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'), `${stdin.tool_name} should be denied`);
    assert.ok(r.stdout.includes('禁止主 session/非 artifact-writer'), `${stdin.tool_name} should explain artifact-writer-only`);
    assert.ok(r.stdout.includes('Artifact 根目录'), `${stdin.tool_name} should include artifact root`);
  }
});

test('9hc0b1a. spec.md 不是 artifact-writer 管理对象，主 session 可 Edit', () => {
  const dir = makeV6Project('direct-spec-edit-pass');
  fs.writeFileSync(path.join(dir, 'spec.md'), '# [项目名称] 规格说明\n', 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(dir, 'spec.md'),
        old_string: '[项目名称]',
        new_string: 'Smoke Project',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));

  const write = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, 'spec.md'),
        content: '# overwritten\n',
      },
    },
  });
  assert.strictEqual(write.code, 0);
  assert.ok(write.stdout.includes('"deny"'));
  assert.ok(write.stdout.includes('禁止使用 Write 覆盖已有 artifact：spec.md'));
});

test('9hc0b2. Bash 不得删除或重定向写入 artifact-writer.lock', () => {
  const dir = makeV6Project('agent-artifact-lock-bash-protect');
  const lockPath = path.join(dir, '.pace', 'artifact-writer.lock');
  seedArtifactWriterLock(dir, 'sid-lock-owner');

  const commands = [
    `rm -f "${lockPath}"`,
    'rm .pace//artifact-writer.lock',
    `echo "$$" > "${lockPath}"`,
    `node -e "require('fs').writeFileSync('${lockPath.replace(/\\/g, '/')}', 'bad')"`,
  ];
  for (const command of commands) {
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: {
        session_id: 'sid-other',
        tool_name: 'Bash',
        tool_input: { command },
      },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'), `应阻止命令: ${command}`);
    assert.ok(r.stdout.includes('artifact 写入控制运行态'), `应说明 runtime 保护: ${command}`);
    assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).sessionId, 'sid-lock-owner');
  }
});

test('9hc0b2a. Bash 不得删除或移动 change-owners 运行态目录', () => {
  const dir = makeV6Project('agent-change-owners-bash-protect');
  const ownerPath = seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-owner' });
  const ownerDir = path.dirname(ownerPath);

  const commands = [
    'rm -rf .pace/change-owners',
    'rm -rf .pace/change-owners/',
    'mv .pace/change-owners /tmp/pace-change-owners-bad',
    `rm -f "${ownerPath}"`,
  ];
  for (const command of commands) {
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: {
        session_id: 'sid-other',
        tool_name: 'Bash',
        tool_input: { command },
      },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'), `应阻止命令: ${command}`);
    assert.ok(r.stdout.includes('artifact 写入控制运行态'), `应说明 runtime 保护: ${command}`);
    assert.ok(fs.existsSync(ownerDir), 'change-owners 目录应保留');
    assert.ok(fs.existsSync(ownerPath), 'change owner 文件应保留');
  }
});

test('9hc0b3. Write/Edit 不得修改 artifact 写入控制运行态', () => {
  const dir = makeV6Project('agent-artifact-runtime-control-write-deny');
  const targets = [
    {
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, '.pace', 'locks', 'artifacts', 'x.lock'),
        content: '{}\n',
      },
    },
    {
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(dir, '.pace', 'reservations', 'session.json'),
        old_string: '{}',
        new_string: '{"bad":true}',
      },
    },
  ];
  fs.mkdirSync(path.join(dir, '.pace', 'reservations'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'reservations', 'session.json'), '{}', 'utf8');
  for (const stdin of targets) {
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: {
        session_id: 'sid-runtime-control',
        ...stdin,
      },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'));
    assert.ok(r.stdout.includes('artifact 写入控制运行态'));
  }
});

test('9hc0c. artifact-writer 持有写锁时可新建 changes 详情，已有详情仍禁止 Write 覆盖', () => {
  const dir = makeV6Project('agent-artifact-lock-write-pass');
  const prompt = `artifact_dir: ${dir.replace(/\\/g, '/')}/\noperation: create-chg\n使用 create-chg 流程创建一个新的变更记录。`;
  const first = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-write-pass',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt,
      },
    },
  });
  assert.strictEqual(first.code, 0);
  assert.ok(first.stdout.includes('"deny"'));
  const reserved = reservedFromStdout(first.stdout);
  assert.ok(reserved.id && reserved.detailFile);

  const pre = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-write-pass',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Create CHG',
        prompt: `${prompt}\nreserved-id: ${reserved.id}\n${reserved.promptReservedLine}`,
      },
    },
  });
  assert.strictEqual(pre.code, 0);
  assert.ok(!pre.stdout.includes('"deny"'));

  const writeNew = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-write-pass',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, reserved.detailFile),
        content: '# new detail\n',
      },
    },
  });
  assert.strictEqual(writeNew.code, 0);
  assert.ok(!writeNew.stdout.includes('"deny"'));

  const overwriteExisting = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-write-pass',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, 'changes', 'chg-20260504-01.md'),
        content: '# overwrite\n',
      },
    },
  });
  assert.strictEqual(overwriteExisting.code, 0);
  assert.ok(overwriteExisting.stdout.includes('"deny"'));
  assert.ok(overwriteExisting.stdout.includes('禁止使用 Write 覆盖已有 artifact'));
});

test('9hc0d. artifact-writer 持有写锁时可 Edit 索引 artifact', () => {
  const dir = makeV6Project('agent-artifact-lock-edit-pass');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-edit-pass',
      agent_id: 'agent-edit-pass',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(dir, 'task.md'),
        old_string: '测试变更',
        new_string: '测试变更',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

test('9hc0e. artifact-writer 可修复半写索引不一致', () => {
  const dir = makeV6Project('agent-index-mismatch-repair-pass', { implIndex: '' });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-index-repair',
      agent_id: 'agent-index-repair',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(dir, 'implementation_plan.md'),
        old_string: '<!-- ARCHIVE -->',
        new_string: '- [/] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n<!-- ARCHIVE -->',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(!r.stdout.includes('索引不一致'));
});

test('9hc0f. v7: impl_plan 空索引不再影响写码门（旧双索引 mismatch deny 退役）', () => {
  const dir = makeV6Project('direct-index-mismatch-still-deny', { implIndex: '' });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: codeEditStdin(dir),
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), 'task.md 单索引权威：impl_plan 缺行不再 deny');
  assert.ok(!r.stdout.includes('索引不一致'));
});

test('9hc0g. artifact-writer 写 C/E 阶段 artifact 不被项目执行 gate 自锁', () => {
  const cDir = makeV6Project('agent-c-phase-artifact-pass', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }),
  });
  const c = runHook('pre-tool-use.js', {
    cwd: cDir,
    stdin: {
      session_id: 'sid-c-phase',
      agent_id: 'agent-c-phase',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(cDir, 'changes', 'chg-20260504-01.md'),
        old_string: '- [ ] T-001 测试任务',
        new_string: '- [/] T-001 测试任务\n\n<!-- APPROVED -->',
      },
    },
  });
  assert.strictEqual(c.code, 0);
  assert.ok(!c.stdout.includes('"deny"'));
  assert.ok(!c.stdout.includes('C 阶段未完成'));

  const eDir = makeV6Project('agent-e-phase-artifact-pass', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: true }),
  });
  const e = runHook('pre-tool-use.js', {
    cwd: eDir,
    stdin: {
      session_id: 'sid-e-phase',
      agent_id: 'agent-e-phase',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(eDir, 'changes', 'chg-20260504-01.md'),
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->',
      },
    },
  });
  assert.strictEqual(e.code, 0);
  assert.ok(!e.stdout.includes('"deny"'));
  assert.ok(!e.stdout.includes('E 阶段未就绪'));
});

test('9hc-corr-fields1. record-correction 缺 trigger-quote → DENY（字段门，对齐 approve/review/close）', () => {
  const dir = makeV6Project('agent-correction-missing-quote');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-corr-missing-quote',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Record correction',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: record-correction',
          // 缺 trigger-quote
          'wrong-behavior: 错误行为说明足够长',
          'correct-behavior: 正确行为说明足够长',
          'trigger-scenario: smoke',
          'root-cause: test',
          'project-scope: project-only',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('缺少必填字段'));
  assert.ok(r.stdout.includes('trigger-quote'));
  const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.ok(!reason.endsWith('\n'), 'record-correction 缺字段提示不应保留尾部空行');
});

test('9hc-corr-fields2. record-correction 缺 knowledge-link 和 project-scope 二选一 → DENY', () => {
  const dir = makeV6Project('agent-correction-missing-dual');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-corr-missing-dual',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Record correction',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: record-correction',
          'trigger-quote: 用户纠正了实现',
          'wrong-behavior: 错误行为说明足够长',
          'correct-behavior: 正确行为说明足够长',
          'trigger-scenario: smoke',
          'root-cause: test',
          // 缺 knowledge-link 和 project-scope 两者
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('knowledge-link 或 project-scope'));
});

test('9hc-corr-fields3. record-correction 五字段齐全 + project-scope → 不被字段门误拦（反向验证）', () => {
  const dir = makeV6Project('agent-correction-fields-ok');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-corr-fields-ok',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Record correction',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: record-correction',
          'trigger-quote: 用户纠正了实现',
          'wrong-behavior: 错误行为说明足够长',
          'correct-behavior: 正确行为说明足够长',
          'trigger-scenario: smoke',
          'root-cause: test',
          'project-scope: project-only',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  // 字段齐全：不被字段门拦（无 reserved-id 会被 reserve 门拦，但 reason 不含字段门文案）
  assert.ok(!r.stdout.includes('缺少必填字段'));
});

test('9hc-corr-fields4. record-correction 只给 correct-behavior，wrong-behavior 仍被列 missing（子串污染回归护栏）', () => {
  // 对抗回归：correct-behavior 含 "-behavior"、wrong-behavior 含 "behavior"，
  // promptHasNonEmptyField 必须按字段名边界锚定，不能因 correct-behavior 存在就误判 wrong-behavior 存在。
  const dir = makeV6Project('agent-correction-substr-pollution');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-corr-substr',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Record correction',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: record-correction',
          'trigger-quote: 用户纠正了实现',
          // 缺 wrong-behavior（只给 correct-behavior，验证子串不污染）
          'correct-behavior: 正确行为说明足够长',
          'trigger-scenario: smoke',
          'root-cause: test',
          'project-scope: project-only',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  const firstLine = reason.split('\n')[0];
  // wrong-behavior 必须在 missing 列表（无子串污染）；correct-behavior 已给，不应在 missing 行
  assert.ok(firstLine.includes('wrong-behavior'), 'wrong-behavior 应被列为缺失（correct-behavior 存在不得污染）');
  assert.ok(!firstLine.includes('correct-behavior'), 'correct-behavior 已给，不应出现在缺失行');
});

test('9hc-corr-fields5. record-correction 只给 knowledge-link 不给 project-scope → 不被字段门拦（二选一另一半）', () => {
  const dir = makeV6Project('agent-correction-knowledge-link');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-corr-knowledge-link',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Record correction',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: record-correction',
          'trigger-quote: 用户纠正了实现',
          'wrong-behavior: 错误行为说明足够长',
          'correct-behavior: 正确行为说明足够长',
          'trigger-scenario: smoke',
          'root-cause: test',
          'knowledge-link: [[some-note]]',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  // knowledge-link 满足二选一：不被字段门拦（reason 不含字段门文案）
  assert.ok(!r.stdout.includes('缺少必填字段'));
});

test('9hc1. approve-and-start 缺 approval-confirmed → DENY', () => {
  const dir = makeV6Project('agent-approve-confirm-missing');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Approve and start',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: approve-and-start',
          'task-id: T-001',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
  assert.ok(r.stdout.includes('approval-confirmed: true'));
  const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.ok(!reason.endsWith('\n'), 'approve-and-start 缺字段提示不应保留尾部空行');
});

test('9hc1a. approve-and-start 带确认字段 → 放行', () => {
  const dir = makeV6Project('agent-approve-confirm-ok');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Approve and start',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: approve-and-start',
          'task-id: T-001',
          'approval-confirmed: true',
          'approval-source: user-directive',
          'approval-evidence: 用户说“开始执行这个方案”',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
});

test('9hc1a1. approve-and-start 证据提到 close-chg 不误判为 close', () => {
  const dir = makeV6Project('agent-approve-evidence-close-word');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Approve and start',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: approve-and-start',
          'task-id: T-001',
          'approval-confirmed: true',
          'approval-source: user-directive',
          'approval-evidence: 用户要求 approve-and-start 后修改代码，验证通过后 close-chg 归档。',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(!r.stdout.includes('verification-confirmed'));
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
});

test('9hc1a2. lifecycle prompt 字段支持等号与中文逗号分隔', () => {
  const dir = makeV6Project('agent-approve-confirm-equals');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Approve and start',
        prompt: [
          `artifact_dir=${dir.replace(/\\/g, '/')}/`,
          'operation=update-chg',
          'target=CHG-20260504-01',
          'action=approve-and-start，task-id=T-001',
          'approval-confirmed=true，approval-source=user-directive，approval-evidence=用户说开始执行',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
});

test('9hc1b. approve 缺 approval-confirmed/source/evidence → DENY', () => {
  const dir = makeV6Project('agent-approve-confirm-missing');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Approve only',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: approve',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('approval-source'));
  assert.ok(r.stdout.includes('approval-evidence'));
});

test('9hc1b1. approve-only owner state 记录为 ready', () => {
  const dir = makeV6Project('agent-approve-owner-ready');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-approve-ready',
      agent_id: 'agent-approve-ready',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Approve only',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: approve',
          'approval-confirmed: true',
          'approval-source: user-directive',
          'approval-evidence: 用户只批准，暂不开始。',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  const ownerPath = path.join(dir, '.pace', 'change-owners', 'chg-20260504-01.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.strictEqual(owner.state, 'ready');
});

test('9hc1c. approve 带开始语义 → DENY 要求 approve-and-start', () => {
  const dir = makeV6Project('agent-approve-start-intent');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Approve but start',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: approve',
          'approval-confirmed: true',
          'approval-source: user-directive',
          'approval-evidence: 用户说“开始执行”',
          '写入 APPROVED，并将 status 改为 in-progress。',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('approve-and-start'));
});

test('9hc1d. approve 纯批准且带确认证据 → 放行', () => {
  const dir = makeV6Project('agent-approve-confirm-ok');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Approve only',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: approve',
          'approval-confirmed: true',
          'approval-source: accepted-plan',
          'approval-evidence: 用户已确认方案，但要求稍后再开始。',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
});

test('9hc1e. approve-only + approval-evidence 含触发动词「开始执行」→ 放行（删散文话术门后不误伤用户原话）', () => {
  const dir = makeV6Project('agent-approve-evidence-trigger-word');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Approve only, trigger word in evidence',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: approve',
          'approval-confirmed: true',
          'approval-source: user-directive',
          'approval-evidence: 用户原话「先批准，等我确认后再开始执行」',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), 'approve-only 用户原话含「开始执行」不应误伤 DENY：' + r.stdout);
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
});

test('9hc2. update-status 与 verify 串联 → DENY', () => {
  const dir = makeV6Project('agent-update-status-verify-chain');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Complete and verify',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: update-status',
          'task-id: T-001',
          'new-status: x',
          'update-chg action=verify',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('不要把 update-status'));
  assert.ok(r.stdout.includes('operation: close-chg'));
  assert.ok(r.stdout.includes('complete-open-tasks: true'));
});

test('9hc2d. update-status 暂停 + status-reason 提到「执行 verify 操作」（无结构化 action:verify）→ 放行（删散文话术门后不靠措辞猜串联）', () => {
  const dir = makeV6Project('agent-update-status-prose-verify-mention');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Pause task, prose verify mention',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: update-status',
          'section: tasks',
          'task-id: T-001',
          'new-status: [!]',
          'status-reason: 暂停，等用户确认后再执行 verify 操作',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), 'update-status 暂停 status-reason 含「执行 verify 操作」不应误伤 DENY：' + r.stdout);
});

// CHG-20260619-07 T-001：update-index / update-finding 早期字段门（对齐 gated op 体验，省一次 agent 往返）
test('9hc-ui1. update-index 缺 action → DENY 要求 action: reorder', () => {
  const dir = makeV6Project('agent-update-index-missing-action');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'reorder index',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-index',
          'target: findings.md',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'update-index 缺 action 应早期 DENY：' + r.stdout);
  assert.ok(r.stdout.includes('action: reorder'));
});

test('9hc-ui2. update-index target 非 findings.md/corrections.md → DENY', () => {
  const dir = makeV6Project('agent-update-index-bad-target');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'bad target',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-index',
          'target: task.md',
          'action: reorder',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'update-index 非法 target 应 DENY：' + r.stdout);
  assert.ok(r.stdout.includes('findings.md'));
});

test('9hc-ui3. update-index target=findings.md + action=reorder → 放行', () => {
  const dir = makeV6Project('agent-update-index-ok');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'reorder ok',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-index',
          'target: findings.md',
          'action: reorder',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), 'update-index 合法字段不应 DENY：' + r.stdout);
});

test('9hc-ui4. update-index target 行带尾随说明 → 放行（firstToken 容错，对齐 A05；R 审计 P2-1 回归）', () => {
  const dir = makeV6Project('agent-update-index-target-trailing');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'reorder with trailing note',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-index',
          'target: findings.md 按日期重排',
          'action: reorder 顺便清空行',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), 'update-index target/action 带尾随说明不应误伤 DENY：' + r.stdout);
});

test('9hc-uf1. update-finding 缺 target → DENY 要求 target FINDING-id', () => {
  const dir = makeV6Project('agent-update-finding-missing-target');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'update finding no target',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-finding',
          'status: accepted',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'update-finding 缺 target 应早期 DENY：' + r.stdout);
  assert.ok(r.stdout.includes('target'));
});

test('9hc-uf2. update-finding 带 target → 放行', () => {
  const dir = makeV6Project('agent-update-finding-ok');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'update finding ok',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-finding',
          'target: finding-2026-06-19-some-slug',
          'status: accepted',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), 'update-finding 带 target 不应 DENY：' + r.stdout);
});

test('9hc2a. update-status [!] 缺少暂停/阻塞原因 → DENY', () => {
  const dir = makeV6Project('agent-update-status-blocked-missing-reason');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Pause task',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: update-status',
          'section: tasks',
          'task-id: T-001',
          'new-status: [!]',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('缺少原因字段'));
});

test('9hc2a1. approve-and-start shorthand 缺 task-id 在 Agent 启动前 DENY', () => {
  const dir = makeV6Project('agent-approve-start-shorthand-missing-task', {
    indexMark: '[ ]',
    detail: chgDetail({ status: 'planned', task: '[ ]', approved: true }),
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-approve-shorthand-missing-task',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Approve and start CHG without task-id',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'target: CHG-20260504-01',
          'approve-and-start approval-confirmed: true approval-source: user-directive approval-evidence: 用户说开始吧',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('task-id'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
});

test('9hc2b. update-status [!] 带原因时 owner state 记录为 blocked', () => {
  const dir = makeV6Project('agent-update-status-blocked-owner-state');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-block-owner-state',
      agent_id: 'agent-block-owner-state',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Pause task',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: update-status',
          'section: tasks',
          'task-id: T-001',
          'new-status: [!]',
          'status-reason: 用户要求暂停，稍后回到原 worktree 继续。',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  const ownerPath = path.join(dir, '.pace', 'change-owners', 'chg-20260504-01.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.strictEqual(owner.state, 'blocked');
});

test('9hc2b1. 同 worktree 新 session 带 takeover 三字段可接续 update-chg 并刷新 owner（CHG-20260611-02 语义变更）', () => {
  // 旧语义：同 checkout 即 current-worktree，新 session 静默接续放行。细分后 sibling-fresh
  // 不可静默接手，但带 owner-takeover 三字段（用户确认）仍可接手——覆盖 crash 后 TTL 窗口
  // 内接续场景；owner 刷新为新 session 后原 session 自动变 sibling 被隔离。
  const dir = makeV6Project('agent-same-worktree-owner-refresh');
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-previous-same-worktree',
    agentId: 'agent-previous-same-worktree',
    state: 'ready',
    cwd: dir,
    stateDir: dir,
    worktree: 'main',
    branch: 'main',
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-new-same-worktree-agent',
      agent_id: 'agent-new-same-worktree',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Start task',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: approve-and-start',
          'approval-confirmed: true',
          'approval-source: user-directive',
          'approval-evidence: 用户要求同 worktree 新 session 继续执行。',
          'owner-takeover-confirmed: true',
          'owner-takeover-source: user-directive',
          'owner-takeover-evidence: 用户要求同 worktree 新 session 继续执行。',
          'task-id: T-001',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), '带 takeover 三字段应放行：' + r.stdout);
  const ownerPath = path.join(dir, '.pace', 'change-owners', 'chg-20260504-01.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.strictEqual(owner.sessionId, 'sid-new-same-worktree-agent');
  assert.strictEqual(owner.state, 'active');
});

test('9hc2c. 非 update-status 文本提到 new-status [!] 不误标 owner blocked', () => {
  const dir = makeV6Project('agent-append-mentions-blocked-status');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-append-owner-state',
      agent_id: 'agent-append-owner-state',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Append work record',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: append',
          'section: work-record',
          'content: 记录示例字段 new-status: [!]，但本次不是状态更新。',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  const ownerPath = path.join(dir, '.pace', 'change-owners', 'chg-20260504-01.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.strictEqual(owner.state, 'active');
});

test('9hc3. close-chg 缺验证摘要字段 → DENY', () => {
  const dir = makeV6Project('agent-close-missing-fields');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Close CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: close-chg',
          'target: CHG-20260504-01',
          'verification-confirmed: true',
          'verify-summary: node hello.js PASS',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
  assert.ok(r.stdout.includes('walkthrough-summary'));
});

test('9hc3a. close-chg 缺 complete-open-tasks → DENY', () => {
  const dir = makeV6Project('agent-close-missing-complete-open');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Close CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: close-chg',
          'target: CHG-20260504-01',
          'verification-confirmed: true',
          'verify-summary: node hello.js PASS',
          'walkthrough-summary: 创建 hello.js 并验证通过',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('complete-open-tasks: true'));
});

test('9hc3b. close-chg 缺 implementation-notes → DENY（执行态记录门，CHG-20260610-10）', () => {
  // 与 verify-summary 同款内容字段校验（存在且非空）：缺失则详情文件只剩创建时的
  // 规划态信息（Why/What/How），执行情况无从审计——deterministic gate，不靠 agent 自觉。
  const dir = makeV6Project('agent-close-missing-impl-notes');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Close CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: close-chg',
          'target: CHG-20260504-01',
          'verification-confirmed: true',
          'complete-open-tasks: true',
          'verify-summary: node hello.js PASS',
          'review-confirmed: true',
          'review-source: manual',
          'review-findings: P0/P1/P2/P3 = 0/0/0/0',
          'walkthrough-summary: 创建 hello.js 并验证通过',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('implementation-notes'));
  // 拒绝文案必须写清楚后果：执行态记录缺失 → 详情只剩规划态信息
  assert.ok(r.stdout.includes('执行态记录'));
  assert.ok(r.stdout.includes('规划态'));
});

test('9hc4. close-chg 完整收尾 prompt → 放行', () => {
  const dir = makeV6Project('agent-close-complete');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Close CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: close-chg',
          'target: CHG-20260504-01',
          'verification-confirmed: true',
          'complete-open-tasks: true',
          'verify-summary: node hello.js 输出 Hello World，PASS',
          'review-confirmed: true',
          'review-source: manual',
          'review-findings: P0/P1/P2/P3 = 0/0/0/0',
          'implementation-notes:',
          '  - T-001: 新建 hello.js 输出 Hello World（commit abc1234）',
          'walkthrough-summary: 创建 hello.js 并验证通过',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
});

test('9hc4a0. close-chg walkthrough 提到 approve-and-start 不误判为批准', () => {
  const dir = makeV6Project('agent-close-summary-approve-word');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Close CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: close-chg',
          'target: CHG-20260504-01',
          'verification-confirmed: true',
          'complete-open-tasks: true',
          'verify-summary: grep README.md PASS',
          'review-confirmed: true',
          'review-source: manual',
          'review-findings: P0/P1/P2/P3 = 0/0/0/0',
          'implementation-notes:',
          '  - T-001: 修改 README.md 增加使用说明',
          'walkthrough-summary: 创建 CHG 后直接写文件被阻止；执行 approve-and-start 后修改文件并验证通过。',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(!r.stdout.includes('approval-confirmed'));
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
});

test('9hc4a1. update-chg action=verify 缺 verify-summary 在 Agent 启动前 DENY', () => {
  const dir = makeV6Project('agent-verify-missing-summary');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Verify CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: verify',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('verify-summary'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
});

test('9hc4a1b. update-chg 缺 action 或未知 action 在 Agent 启动前 DENY', () => {
  const dir = makeV6Project('agent-update-chg-action-required');
  for (const actionLine of ['', 'action: unknown']) {
    const ownerPath = path.join(dir, '.pace', 'change-owners', 'chg-20260504-01.json');
    try { fs.rmSync(ownerPath, { force: true }); } catch(e) {}
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: {
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'paceflow:artifact-writer',
          description: 'Update CHG',
          prompt: [
            `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
            'operation: update-chg',
            'target: CHG-20260504-01',
            actionLine,
          ].filter(Boolean).join('\n'),
        },
      },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'));
    assert.ok(r.stdout.includes('update-chg 的 action 只能是 append / replace / approve / approve-and-start / update-status / verify'));
    assert.ok(!fs.existsSync(ownerPath), '被 deny 的 update-chg 不应写入 owner state');
  }
});

test('9hc4a1c. update-chg action 空值后紧跟字段不被吞成非空 action（对称 9haa0f operation 版；CHG-20260616-03 T-003 / P3.16）', () => {
  const dir = makeV6Project('agent-update-chg-action-empty');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Update CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action:',
          'task-id: T-001',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'action 空值应 deny');
  assert.ok(r.stdout.includes('update-chg 的 action 只能是'), 'action 空值报缺 action');
  assert.ok(!r.stdout.includes('action「task-id'), '不把下一行 task-id: 误当 action 报 unknown');
});

test('9hc4a2. archive-chg 缺 walkthrough-summary 在 Agent 启动前 DENY', () => {
  const dir = makeV6Project('agent-archive-missing-summary');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Archive CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: archive-chg',
          'target: CHG-20260504-01',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('walkthrough-summary'));
  assert.ok(r.stdout.includes('operation: archive-chg'));
});

test('9hc4a. artifact-writer 不得接手其他 fresh session owner 的 CHG', () => {
  const dir = makeV6Project('agent-close-foreign-owner');
  seedChangeOwner(dir, 'CHG-20260504-01');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-current-owner',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Close CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: close-chg',
          'target: CHG-20260504-01',
          'verification-confirmed: true',
          'complete-open-tasks: true',
          'verify-summary: node hello.js 输出 Hello World，PASS',
          'review-confirmed: true',
          'review-source: manual',
          'review-findings: P0/P1/P2/P3 = 0/0/0/0',
          'implementation-notes:',
          '  - T-001: 新建 hello.js 输出 Hello World（commit abc1234）',
          'walkthrough-summary: 创建 hello.js 并验证通过',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('另一个 Claude Code session'));
  assert.ok(!r.stdout.includes('owner-takeover-confirmed'));
});

test('9hc4r. close-chg 缺 review-confirmed → DENY（审计门）', () => {
  const dir = makeV6Project('agent-close-no-review');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Close CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: close-chg',
          'target: CHG-20260504-01',
          'verification-confirmed: true',
          'complete-open-tasks: true',
          'verify-summary: node hello.js PASS',
          'walkthrough-summary: 完成',
        ].join('\n'),
      },
    },
  });
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('review-confirmed'));
});

test('9hc-review1. update-chg action=review 带齐三字段 + CHG 已 VERIFIED → 放行', () => {
  const dir = makeV6Project('agent-review-ok', { detail: chgDetail({ verified: true }) });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Review CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: review',
          'review-confirmed: true',
          'review-source: manual',
          'review-findings: P0/P1/P2/P3 = 0/0/0/0',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('ARTIFACT_DIR 已确认'));
});

test('9hc-review2. update-chg action=review 缺 review-confirmed → DENY', () => {
  const dir = makeV6Project('agent-review-missing');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Review CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: review',
        ].join('\n'),
      },
    },
  });
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('review-confirmed'));
});

test('9hc-review3. update-chg action=review 但 CHG 未 VERIFIED → DENY（V/R 偏序门）', () => {
  const dir = makeV6Project('agent-review-unverified'); // chgDetail 默认 approved 但未 verified
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Review unverified CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: review',
          'review-confirmed: true',
          'review-source: manual',
          'review-findings: P0/P1/P2/P3 = 0/0/0/0',
        ].join('\n'),
      },
    },
  });
  assert.ok(r.stdout.includes('"deny"'), '未 VERIFIED 的 review 应 deny');
  assert.ok(r.stdout.includes('VERIFIED'), 'deny 文案应点明偏序约束');
});

test('9hc4b. update/close/archive 必须显式 target，不能从正文 CHG-ID 推断 owner', () => {
  const dir = makeV6Project('agent-target-required');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-target-required',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Update CHG without target',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'action: update-status',
          'task-id: T-001',
          'status: in-progress',
          'notes: 这里提到 CHG-20260504-01，但没有 target 字段。',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('缺少明确 target'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
});

test('9hc4b0. close-chg shorthand 缺 summary 在 Agent 启动前 DENY', () => {
  const dir = makeV6Project('agent-close-shorthand-missing-summary', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: false }),
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-close-shorthand-missing-summary',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Close CHG without summaries',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'target: CHG-20260504-01',
          'close-chg verification-confirmed: true complete-open-tasks: true verification-evidence: tests passed',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('verify-summary'));
  assert.ok(r.stdout.includes('walkthrough-summary'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
});

test('9hc4b0a. verify-summary 字段名不应被误判为 verify action', () => {
  const dir = makeV6Project('agent-close-missing-operation-with-verify-summary', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: false }),
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-close-missing-operation-with-verify-summary',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Close CHG without explicit operation',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'target: CHG-20260504-01',
          'verification-confirmed: true',
          'complete-open-tasks: true',
          'verify-summary: grep README.md passed',
          'walkthrough-summary: README updated',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('缺少明确 operation'));
  assert.ok(r.stdout.includes('Skill(paceflow:pace-workflow)'));
});

test('9hc4b0b. prose 中提到 verify 不应被误判为 verify action', () => {
  const dir = makeV6Project('agent-prose-verify-missing-operation', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: false }),
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-prose-verify-missing-operation',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Prose verify without explicit operation',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'target: CHG-20260504-01',
          '请 verify 这个 CHG，但这里故意没有 operation/action 字段。',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('缺少明确 operation'));
});

test('9hc4b1. stale foreign owner takeover 必须带用户证据', () => {
  const dir = makeV6Project('agent-owner-stale-takeover-evidence-required');
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-stale-owner',
    state: 'active',
    timestampMs: Date.now() - 60 * 60 * 1000,
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-takeover-new',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Take over stale owner',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: update-status',
          'section: tasks',
          'task-id: T-001',
          'new-status: [/]',
          'owner-takeover-confirmed: true',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('owner-takeover-source: user-directive'));
  assert.ok(r.stdout.includes('owner-takeover-evidence'));
});

test('9hc4b2. stale foreign owner 带完整用户证据才允许接手', () => {
  const dir = makeV6Project('agent-owner-stale-takeover-evidence-pass');
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-stale-owner',
    state: 'active',
    timestampMs: Date.now() - 60 * 60 * 1000,
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-takeover-new',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Take over stale owner',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'action: update-status',
          'section: tasks',
          'task-id: T-001',
          'new-status: [/]',
          'owner-takeover-confirmed: true',
          'owner-takeover-source: user-directive',
          'owner-takeover-evidence: 用户明确要求当前 session 接手继续。',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

test('9hc4c. 代码阶段工具调用刷新当前 session change owner heartbeat', () => {
  const dir = makeV6Project('owner-heartbeat-code-tool');
  const ownerPath = seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-heartbeat-code',
    agentId: 'agent-heartbeat-code',
    timestampMs: Date.now() - 60 * 60 * 1000,
  });
  const before = JSON.parse(fs.readFileSync(ownerPath, 'utf8')).timestampMs;
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-heartbeat-code',
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(dir, 'src.js'),
        old_string: 'a',
        new_string: 'b',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  const after = JSON.parse(fs.readFileSync(ownerPath, 'utf8')).timestampMs;
  assert.ok(after > before, 'owner timestamp should be refreshed by code-stage tool activity');
});

test('9hd. 非 artifact-writer Agent 不受 artifact_dir 约束', () => {
  const { worktree } = makeVaultBackedWorktree('agent-other-pass');
  const r = runHook('pre-tool-use.js', {
    cwd: worktree,
    stdin: {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'code-reviewer',
        description: 'Review',
        prompt: '检查代码。',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

test('9he. Edit artifact 前自动把 CRLF 归一化为 LF', () => {
  const dir = makeV6Project('ptu-crlf-normalize');
  const fp = path.join(dir, 'walkthrough.md');
  const sessionId = seedArtifactWriterLock(dir, 'sid-crlf-normalize');
  fs.writeFileSync(fp, [
    '# 工作记录',
    '',
    '## 最近工作',
    '',
    '| 日期 | 完成内容 | 关联变更 |',
    '| --- | --- | --- |',
    '',
    '<!-- ARCHIVE -->',
    '',
  ].join('\r\n'), 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '| --- | --- | --- |\n',
        new_string: `| --- | --- | --- |\n| ${today()} | [[chg-20260504-01]] smoke | CHG-20260504-01 |\n`,
      },
      agent_id: 'agent-1',
      agent_type: 'artifact-writer',
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
  const after = fs.readFileSync(fp, 'utf8');
  assert.ok(!after.includes('\r'), 'artifact 应被归一化为 LF');
  assert.ok(after.includes('| --- | --- | --- |\n'), 'LF old_string 应能匹配归一化后的文件');
});

test('9hf. Bash 只读 artifact 放行', () => {
  const dir = makeV6Project('ptu-bash-read-artifact');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: {
        command: `grep -c "^<!-- ARCHIVE -->$" ${path.join(dir, 'walkthrough.md')}`,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

test('9hfa. Bash 读取 artifact 并重定向到非 artifact 放行', () => {
  const dir = makeV6Project('ptu-bash-read-artifact-redirect');
  const commands = [
    `grep -c "ARCHIVE" ${path.join(dir, 'walkthrough.md')} > /tmp/paceflow-grep-count.txt`,
    `bash -c 'grep -c "ARCHIVE" task.md > /tmp/paceflow-grep-count.txt'`,
  ];
  for (const command of commands) {
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: {
        tool_name: 'Bash',
        tool_input: { command },
      },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(!r.stdout.includes('"deny"'), `只读 artifact 命令应放行: ${command}`);
  }
});

test('9hg. Bash 修改 artifact 被拒绝', () => {
  const dir = makeV6Project('ptu-bash-write-artifact');
  const fp = path.join(dir, 'walkthrough.md');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: {
        command: `sed -i 's/\\r$//' ${fp}`,
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('禁止使用 Bash 修改 artifact'));
  assert.ok(r.stdout.includes('Artifact 根目录'));
});

test('9hga. Bash 重定向写 artifact 被拒绝', () => {
  const dir = makeV6Project('ptu-bash-redirect-artifact');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: {
        command: 'echo "# overwritten" > task.md',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('禁止使用 Bash 修改 artifact'));
  assert.ok(r.stdout.includes('Artifact 根目录'));
});

test('9hgb. Bash 修改 artifact 的等价路径也被拒绝', () => {
  const dir = makeV6Project('ptu-bash-write-artifact-normalized-path');
  const commands = [
    'rm .//task.md',
    'sed -i s/x/y/ .//task.md',
    'rm ./changes/../task.md',
  ];
  for (const command of commands) {
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: {
        tool_name: 'Bash',
        tool_input: { command },
      },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'), `应阻止命令: ${command}`);
    assert.ok(r.stdout.includes('禁止使用 Bash 修改 artifact'));
  }
});

test('9hgc. Bash shell wrapper / package runner 修改 artifact 被拒绝', () => {
  const dir = makeV6Project('ptu-bash-wrapper-artifact');
  const commands = [
    `bash -c 'node -e "require(\\"fs\\").writeFileSync(\\"task.md\\",\\"x\\")"'`,
    `bash -c 'cat > task.md <<EOF\nx\nEOF'`,
    `echo $(bash -c 'echo x > task.md')`,
    "echo `bash -c 'echo x > task.md'`",
    `eval "bash -c 'echo x > task.md'"`,
    `printf ignored | xargs sh -c 'echo x > task.md'`,
    `cat > /tmp/pace-artifact-bypass.js <<'SCRIPT'\nconst fs = require('fs');\nfs.writeFileSync('${path.join(dir, 'task.md').replace(/\\/g, '/')}', 'x');\nSCRIPT\nnode /tmp/pace-artifact-bypass.js`,
    'npx prettier --write task.md',
    'npm run fix -- task.md',
  ];
  for (const command of commands) {
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: {
        tool_name: 'Bash',
        tool_input: { command },
      },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'), `应阻止命令: ${command}`);
    assert.ok(r.stdout.includes('禁止使用 Bash 修改 artifact'));
  }
});

test('9hgd. Bash 执行已存在外部脚本写 artifact 被拒绝', () => {
  const dir = makeV6Project('ptu-bash-existing-script-artifact');
  const script = path.join(os.tmpdir(), `pace-bypass-${Date.now()}.js`);
  fs.writeFileSync(script, `const fs = require('fs');\nfs.writeFileSync(${JSON.stringify(path.join(dir, 'task.md'))}, 'x');\n`, 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: { command: `node ${script}` },
    },
  });
  try { fs.rmSync(script, { force: true }); } catch(e) {}
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('禁止使用 Bash 修改 artifact'));
});

test('9hgd1. Bash guard 识别 Windows JS 转义路径', () => {
  const script = 'const fs = require("fs");\nfs.writeFileSync("C:\\\\tmp\\\\pace\\\\task.md", "x");\n';
  assert.strictEqual(bashGuard.bashCommandReferencesArtifact(script, 'C:\\tmp\\pace', 'C:\\tmp\\pace'), true);
});

test('9hgd2. Bash find -delete / find -exec rm 修改 artifact 被拒绝', () => {
  const dir = makeV6Project('ptu-bash-find-delete-artifact');
  for (const command of [
    'find changes -name "*.md" -delete',
    'find changes -name "*.md" -exec rm {} \\;',
  ]) {
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: {
        tool_name: 'Bash',
        tool_input: { command },
      },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'), `应阻止命令: ${command}`);
    assert.ok(r.stdout.includes('禁止使用 Bash 修改 artifact'));
  }
});

test('9hgd3. Bash .sh 包装器写 artifact 被拒绝', () => {
  const dir = makeV6Project('ptu-bash-shell-script-artifact');
  const script = path.join(os.tmpdir(), `pace-bypass-${Date.now()}.sh`);
  fs.writeFileSync(script, 'node -e "require(\\"fs\\").writeFileSync(\\"task.md\\", \\"x\\")"\n', 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: { command: `bash ${script}` },
    },
  });
  try { fs.rmSync(script, { force: true }); } catch(e) {}
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('禁止使用 Bash 修改 artifact'));
});

test('9hgd4. heredoc body 中的 > artifact 文本不误判为重定向', () => {
  const dir = makeV6Project('ptu-bash-heredoc-body-readonly');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: { command: "cat > readme.md <<'EOF'\n> task.md\n; rm task.md\n查看 .pace/locks/example.lock\nEOF" },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

test('9hgd5. Bash guard 放行验证脚本里的动态 artifact fixture 字符串', () => {
  const dir = makeV6Project('ptu-bash-test-script-fixture-readonly');
  const testsDir = path.join(dir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const script = path.join(testsDir, 'fixture-check.js');
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    "const path = require('path');",
    "function fixture(dir) { fs.writeFileSync(path.join(dir, 'task.md'), '# fixture\\n'); }",
    "console.log('fixture strings only');",
  ].join('\n'), 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: { command: 'node tests/fixture-check.js' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

test('9hgd5a. Bash guard 仅放行 paceflow 官方验证脚本源码样本', () => {
  const dir = makeV6Project('ptu-bash-paceflow-validation-script');
  fs.mkdirSync(path.join(dir, 'plugin', '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'paceflow' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'tests', 'test-hooks-e2e.js'), [
    "const samples = [\"node -e \\\"require('fs').writeFileSync('task.md', 'x')\\\"\"];",
    "console.log(samples.length);",
  ].join('\n'), 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: { command: 'node tests/test-hooks-e2e.js' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

test('9hgd6. Bash guard 仍拒绝 tests 下脚本直接写 artifact 字面路径', () => {
  const dir = makeV6Project('ptu-bash-test-script-direct-artifact-write');
  const testsDir = path.join(dir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const script = path.join(testsDir, 'direct-write.js');
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    "fs.writeFileSync('task.md', '# bad\\n');",
  ].join('\n'), 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: { command: 'node tests/direct-write.js' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('禁止使用 Bash 修改 artifact 文件'));
});

test('9hgd7. Bash npx mutating 判断不跨换行误拦只读 artifact', () => {
  assert.strictEqual(bashGuard.bashCommandLooksMutating('npx eslint src/\nwc -w task.md'), false);
});

test('9hge. PowerShell 修改 artifact / runtime-control 被拒绝，只读放行', () => {
  const dir = makeV6Project('ptu-powershell-artifact');
  const commands = [
    ['Set-Content task.md "bad"', '禁止使用 PowerShell 修改 artifact'],
    ['"bad" > .\\task.md', '禁止使用 PowerShell 修改 artifact'],
    ['Add-Content .\\changes\\chg-20260504-01.md "bad"', '禁止使用 PowerShell 修改 artifact'],
    ["[IO.File]::WriteAllText('task.md', 'bad')", '禁止使用 PowerShell 修改 artifact'],
    ['"bad" | Tee-Object -FilePath task.md', '禁止使用 PowerShell 修改 artifact'],
    ['Invoke-WebRequest https://example.com/file -OutFile task.md', '禁止使用 PowerShell 修改 artifact'],
    ['Remove-Item .pace\\locks\\artifacts\\x.lock -Force', '禁止使用 PowerShell 修改 PaceFlow artifact 写入控制运行态'],
  ];
  for (const [command, expected] of commands) {
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: {
        tool_name: 'PowerShell',
        tool_input: { command },
      },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'), `应阻止命令: ${command}`);
    assert.ok(r.stdout.includes(expected), `命令 ${command} 应返回 ${expected}`);
  }

  const readOnly = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'PowerShell',
      tool_input: { command: 'Get-Content task.md' },
    },
  });
  assert.strictEqual(readOnly.code, 0);
  assert.ok(!readOnly.stdout.includes('"deny"'));
});

test('9hge0. PowerShell 验证脚本不因测试源码字面量误判 artifact 写入', () => {
  const repoRoot = path.resolve(__dirname, '..');
  assert.strictEqual(
    powershellGuard.powershellCommandEmbedsArtifactWriteScript('node tests/test-pace-utils.js', repoRoot, repoRoot),
    false
  );
  assert.strictEqual(
    powershellGuard.powershellCommandEmbedsArtifactWriteScript('node tests/test-hooks-e2e.js', repoRoot, repoRoot),
    false
  );
});

test('9hge1. PowerShell guard 识别 Windows JS 转义路径', () => {
  const script = 'const fs = require("fs");\nfs.writeFileSync("C:\\\\tmp\\\\pace\\\\task.md", "x");\n';
  assert.strictEqual(powershellGuard.powershellCommandReferencesArtifact(script, 'C:\\tmp\\pace', 'C:\\tmp\\pace'), true);
});

test('9hge1b. PowerShell node/python mutating 判断不跨语句误拦只读 artifact', () => {
  const command = 'node build.js; Get-Content task.md | Select-String writeFile';
  assert.strictEqual(powershellGuard.powershellCommandLooksMutating(command), false);
});

test('9hge2. PowerShell .ps1 包装器写 artifact 被拒绝', () => {
  const dir = makeV6Project('ptu-powershell-script-artifact');
  const script = path.join(os.tmpdir(), `pace-bypass-${Date.now()}.ps1`);
  fs.writeFileSync(script, 'Set-Content task.md "x"\n', 'utf8');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'PowerShell',
      tool_input: { command: `& "${script}"` },
    },
  });
  try { fs.rmSync(script, { force: true }); } catch(e) {}
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('禁止使用 PowerShell 修改 artifact'));
});

test('9cha-bypass. CHG-A 守卫绕过端到端：换行/分组/wrapper/for/&& 与 PS 前缀/别名均 deny', () => {
  const dir = makeV6Project('cha-guard-bypass');
  seedArtifactWriterLock(dir, 'sid-bypass-owner');

  // Bash runtime-control 锁的绕过写法（BG-01 P0：此前 4 种自然写法全 ALLOW）
  const bashRuntimeBypass = [
    'for f in .pace/locks/*; do rm "$f"; done',
    '{ rm .pace/artifact-writer.lock; }',
    'env rm .pace/artifact-writer.lock',
    'echo hi\nrm .pace/artifact-writer.lock',
  ];
  for (const command of bashRuntimeBypass) {
    const r = runHook('pre-tool-use.js', { cwd: dir, stdin: { session_id: 'sid-other', tool_name: 'Bash', tool_input: { command } } });
    assert.ok(r.stdout.includes('"deny"'), `Bash 绕过应 deny: ${command}`);
    assert.ok(r.stdout.includes('artifact 写入控制运行态'), `Bash 绕过应说明 runtime 保护: ${command}`);
  }

  // Bash artifact 的绕过写法（换行/分组/for…do）
  const bashArtifactBypass = [
    'echo hi\nrm changes/chg-20260504-01.md',
    '{ rm task.md; }',
    'for f in task.md; do rm "$f"; done',
  ];
  for (const command of bashArtifactBypass) {
    const r = runHook('pre-tool-use.js', { cwd: dir, stdin: { tool_name: 'Bash', tool_input: { command } } });
    assert.ok(r.stdout.includes('"deny"'), `Bash artifact 绕过应 deny: ${command}`);
  }

  // PowerShell & 前缀 / ri 别名 / && 删 runtime-control（PSG-01/02 + A08）
  const psRuntimeBypass = [
    '& Remove-Item .pace/artifact-writer.lock',
    'ri .pace/artifact-writer.lock',
    'Get-Date && Remove-Item .pace/locks/x',
  ];
  for (const command of psRuntimeBypass) {
    const r = runHook('pre-tool-use.js', { cwd: dir, stdin: { tool_name: 'PowerShell', tool_input: { command } } });
    assert.ok(r.stdout.includes('"deny"'), `PowerShell 绕过应 deny: ${command}`);
    assert.ok(r.stdout.includes('artifact 写入控制运行态'), `PowerShell 绕过应说明 runtime 保护: ${command}`);
  }

  // PowerShell ri 别名改 artifact
  const psArtifact = runHook('pre-tool-use.js', { cwd: dir, stdin: { tool_name: 'PowerShell', tool_input: { command: 'ri changes/chg-20260504-01.md' } } });
  assert.ok(psArtifact.stdout.includes('"deny"'), 'PowerShell ri 改 artifact 应 deny');
});

test('9cha-symmetry. bash↔powershell 守卫对称 + over-block 防回归', () => {
  const dir = makeV6Project('cha-guard-symmetry');
  seedArtifactWriterLock(dir, 'sid-sym-owner');

  // 对称：同语义删锁两侧都 deny
  const bash = runHook('pre-tool-use.js', { cwd: dir, stdin: { session_id: 'sid-other', tool_name: 'Bash', tool_input: { command: 'rm .pace/locks/x' } } });
  const ps = runHook('pre-tool-use.js', { cwd: dir, stdin: { tool_name: 'PowerShell', tool_input: { command: 'Remove-Item .pace/locks/x' } } });
  assert.ok(bash.stdout.includes('"deny"'), 'bash 删锁 deny');
  assert.ok(ps.stdout.includes('"deny"'), 'powershell 删锁 deny');

  // over-block 防回归：只读 grep / Select-String 含 writeFileSync token 仍放行
  const bashRead = runHook('pre-tool-use.js', { cwd: dir, stdin: { tool_name: 'Bash', tool_input: { command: 'grep writeFileSync task.md' } } });
  const psRead = runHook('pre-tool-use.js', { cwd: dir, stdin: { tool_name: 'PowerShell', tool_input: { command: 'Get-Content task.md | Select-String writeFileSync' } } });
  assert.ok(!bashRead.stdout.includes('"deny"'), 'bash 只读 grep token 放行');
  assert.ok(!psRead.stdout.includes('"deny"'), 'powershell 只读 Select-String token 放行');
});

test('9hge2b. teammate 模式仍 hard-deny runtime-control 删除', () => {
  const dir = makeV6Project('ptu-teammate-runtime-control');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    env: { CLAUDE_CODE_TEAM_NAME: 'audit-team' },
    stdin: {
      tool_name: 'PowerShell',
      tool_input: { command: 'Remove-Item .pace\\locks\\artifacts\\x.lock -Force' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"permissionDecision":"deny"'));
  assert.ok(!r.stdout.includes('additionalContext'));
  assert.ok(r.stdout.includes('artifact 写入控制运行态'));
});

test('9hge3. Monitor 修改 artifact / runtime-control 被拒绝，只读放行', () => {
  const dir = makeV6Project('ptu-monitor-artifact');
  for (const command of [
    'echo bad > task.md',
    'rm .pace/locks/artifacts/x.lock',
  ]) {
    const r = runHook('pre-tool-use.js', {
      cwd: dir,
      stdin: {
        tool_name: 'Monitor',
        tool_input: { command },
      },
    });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('"deny"'), `应阻止命令: ${command}`);
    assert.ok(r.stdout.includes('Monitor'));
  }

  const readOnly = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Monitor',
      tool_input: { command: 'tail -f server.log' },
    },
  });
  assert.strictEqual(readOnly.code, 0);
  assert.ok(!readOnly.stdout.includes('"deny"'));
});

test('9hge4. HCR-01: python open(mode=) 关键字写 artifact 端到端拦截（bash↔ps 对称）', () => {
  const dir = makeV6Project('ptu-open-mode-kw');
  for (const { tool, command } of [
    { tool: 'Bash', command: "python -c \"open('task.md', mode='w')\"" },
    { tool: 'Bash', command: "python -c \"open(file='task.md', mode='w')\"" },  // 关键判别：embeds 提取不到 file= 第一参，纯依赖 looksMutating
    { tool: 'PowerShell', command: "python -c \"open('task.md', mode='w')\"" },
  ]) {
    const r = runHook('pre-tool-use.js', { cwd: dir, stdin: { tool_name: tool, tool_input: { command } } });
    assert.ok(r.stdout.includes('"deny"'), `应拦 ${tool}: ${command}`);
  }
});

test('9hge5. HOTFIX-01: PowerShell Write-Output 含 `n 字面 + cmdlet 行首引用 artifact 不 over-block', () => {
  const dir = makeV6Project('ptu-ps-backtick-overblock');
  // 双引号字面内 `n 是输出文本换行——合法只读 Write-Output 不应被误判 mutating 而 deny（对抗验证抓到的 CHG-08 T-003 回归 PoC）
  const readOnly = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'PowerShell', tool_input: { command: 'Write-Output "task.md`nRemove-Item temp`ndone"' } },
  });
  assert.strictEqual(readOnly.code, 0);
  assert.ok(!readOnly.stdout.includes('"deny"'), '只读 Write-Output 含 `n 字面不应 over-block');
  // 对照：引号【外】`n 多语句删 artifact 仍 deny（T-003 端到端保住）
  const evil = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'PowerShell', tool_input: { command: 'Write-Host x`nRemove-Item task.md' } },
  });
  assert.ok(evil.stdout.includes('"deny"'), '引号外 `n 多语句删 artifact 仍 deny（T-003）');
});

test('9hh. 懒创建模板写入 LF', () => {
  const dir = makeTmpDir('ptu-template-lf');
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir) });
  assert.ok(r.stdout.includes('"deny"'));
  for (const file of ['task.md', 'walkthrough.md', 'findings.md', 'corrections.md']) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!content.includes('\r'), `${file} 应为 LF`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'implementation_plan.md')), 'v7: 懒创建不再生成 implementation_plan.md');
});

test('9i. PACE 项目 malformed stdin → fail-closed deny', () => {
  const dir = makeV6Project('ptu-bad-stdin');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: 'not json {{{' });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('无法解析'));
});

test('9j. PACE 项目缺 file_path → fail-closed deny', () => {
  const dir = makeV6Project('ptu-missing-file-path');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: { tool_name: 'Write', tool_input: { content: 'x' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'));
  assert.ok(r.stdout.includes('file_path'));
});

test('9k. 非 PACE 项目 malformed stdin 保持低干扰', () => {
  const dir = makeTmpDir('ptu-bad-stdin-nonpace');
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: 'not json {{{' });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'));
});

console.log('\n--- stop.js ---');

test('10. v6 未完成详情任务 → exit 2', () => {
  const dir = makeV6Project('stop-pending');
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('未完成任务'));
});

test('10X. Stop counter 文件不可写时降级放行而非 exit 2 死循环（STOP-02）', () => {
  const dir = makeV6Project('stop-counter-unwritable');
  // 把 counter 路径建成目录，使 writeFileSync 必抛 EISDIR（跨平台稳定模拟不可写，避免依赖权限位）。
  // bug：写失败被静默吞，getBlockCount 恒 0，永远到不了 MAX_BLOCKS 降级分支 → 每次 exit 2 死循环。
  fs.mkdirSync(path.join(dir, '.pace', 'stop-block-count'), { recursive: true });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 0, 'counter 不可写时应降级放行避免 Stop 永久 exit 2 死循环');
});

test('10Y. Stop 在 artifact-root=vault 但 PACE_VAULT_PATH 缺失时 fail-closed 阻断（PUC-01）', () => {
  // artifact-root 配置为 vault（artifact 实际在 vault），但运行时 PACE_VAULT_PATH 缺失：
  // getArtifactDir 会静默降级到本地路径、漏检 vault 里的活跃 CHG（fail-open）。
  // 应改为 fail-closed 阻断并提示恢复 PACE_VAULT_PATH。
  const dir = makeV6Project('stop-vault-env-missing', {
    withIndex: false,
    detail: false,
    paceRuntime: { 'artifact-root': 'vault\n' },
  });
  const r = runHook('stop.js', { cwd: dir, env: { PACE_VAULT_PATH: '' } });
  assert.strictEqual(r.code, 2, 'vault 配置但 PACE_VAULT_PATH 缺失应 fail-closed 阻断而非静默放行');
  assert.ok(r.stderr.includes('PACE_VAULT_PATH'), '应提示 PACE_VAULT_PATH 缺失');
});

test('10a. 多任务 CHG 部分完成 → 继续执行，不提示 verify/close/archive', () => {
  const dir = makeV6Project('stop-partial-multitask', {
    walkToday: false,
    detail: chgDetail({
      status: 'in-progress',
      approved: true,
      tasks: [
        '- [x] T-001 已完成',
        '- [ ] T-002 待完成',
        '- [ ] T-003 待完成',
      ],
    }),
  });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('还有 2 个未完成任务'));
  assert.ok(!r.stderr.includes('update-chg action=verify'));
  assert.ok(!r.stderr.includes('close-chg'));
  assert.ok(!r.stderr.includes('archive-chg'));
  assert.ok(!r.stderr.includes('walkthrough.md 缺少'), '执行中且仍有 pending task 时不应提前要求 walkthrough');
});

test('10a1. running CHG 有后台任务时 Stop 软通过并显示等待提醒', () => {
  const dir = makeV6Project('stop-background-work-running', {
    walkToday: false,
    detail: chgDetail({
      status: 'in-progress',
      approved: true,
      tasks: [
        '- [/] T-001 审计执行中',
        '- [ ] T-002 汇总报告',
      ],
    }),
    paceRuntime: { 'stop-block-count': '2' },
  });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-bg-work',
      background_tasks: [{
        id: 'wf_test_001',
        type: 'workflow',
        status: 'running',
        name: 'PACEflow audit workflow',
      }],
      last_assistant_message: '后台审计已启动，等待 workflow 完成。',
    },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.ok(out.systemMessage.includes('后台任务仍在运行'));
  assert.ok(out.systemMessage.includes('CHG-20260504-01 running'));
  assert.ok(out.systemMessage.includes('workflow'));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.pace', 'stop-block-count'), 'utf8'), '0');
});

test('10a1b. running CHG 有后台 shell 任务时 Stop 软通过', () => {
  const dir = makeV6Project('stop-background-work-shell', {
    walkToday: false,
    detail: chgDetail({
      status: 'in-progress',
      approved: true,
      tasks: [
        '- [/] T-001 后台 shell 执行中',
        '- [ ] T-002 汇总结果',
      ],
    }),
  });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-bg-shell',
      background_tasks: [{
        id: 'bash_001',
        type: 'shell',
        status: 'running',
        description: 'long verification',
        command: 'node tests/test-hooks-e2e.js',
      }],
    },
  });
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.systemMessage.includes('后台任务仍在运行'));
  assert.ok(out.systemMessage.includes('shell'));
  assert.ok(out.systemMessage.includes('long verification'));
});

test('10a1c. 畸形 background_tasks 不触发 Stop 软通过', () => {
  const dir = makeV6Project('stop-background-work-malformed', {
    walkToday: false,
    detail: chgDetail({
      status: 'in-progress',
      approved: true,
      tasks: [
        '- [/] T-001 执行中',
        '- [ ] T-002 待完成',
      ],
    }),
  });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-bg-malformed',
      background_tasks: [{ id: 'missing-status' }, { status: '' }, null, 'running'],
      session_crons: [{ id: 'cron-001', status: 'running' }],
    },
  });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('未完成任务'));
  assert.ok(!r.stdout.includes('后台任务仍在运行'));
});

test('10a2. 后台任务运行时声称完成软放行（COMPLETION_PHRASES 话术门已删，不再越过 background 软放行）', () => {
  const dir = makeV6Project('stop-background-work-claim-complete', {
    walkToday: false,
    detail: chgDetail({
      status: 'in-progress',
      approved: true,
      tasks: [
        '- [/] T-001 审计执行中',
        '- [ ] T-002 汇总报告',
      ],
    }),
  });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-bg-work',
      background_tasks: [{ id: 'agent_001', type: 'subagent', status: 'running', agent_type: 'Explore' }],
      last_assistant_message: '任务完成',
    },
  });
  // Stop 是确定性事件信号；后台任务在跑时，AI 说「任务完成」指「这轮做完、等后台返回」，
  // 不应再被 lastMessage 话术门越过 background 软放行（消解 v7.2.11 实测 805 误伤）。
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.ok(out.systemMessage.includes('后台任务仍在运行'));
  assert.ok(!r.stderr.includes('AI 声称完成'));
});

test('10a2b. 话术门删除后：无 background + 声称完成 + running CHG 有 pending → 仍 BLOCK（确定性任务状态兜底，拦截不丢）', () => {
  const dir = makeV6Project('stop-claim-complete-no-bg', {
    walkToday: false,
    detail: chgDetail({
      status: 'in-progress',
      approved: true,
      tasks: [
        '- [/] T-001 执行中',
        '- [ ] T-002 待完成',
      ],
    }),
  });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: { session_id: 'sid-claim-no-bg', last_assistant_message: '任务完成' },
  });
  // 删 COMPLETION_PHRASES 门后，真实「未完成」拦截由确定性的 running-pending 检查独扛。
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('未完成任务'), '确定性 running-pending 检查兜底 BLOCK');
  assert.ok(!r.stderr.includes('AI 声称完成'), '话术门已删，不再出现「AI 声称完成」文案');
});

test('10a2c. legacy 话术门删除后：legacy task.md + 声称完成 + pending → 不再 BLOCK（与「task.md 活跃内容不阻断 Stop」一致）', () => {
  const dir = makeLegacyProject('stop-legacy-claim-complete');
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: { stop_hook_active: false, last_assistant_message: '任务完成' },
    env: { PACE_VAULT_PATH: '' },
  });
  assert.strictEqual(r.code, 0, 'legacy 路径不再因声称完成而 BLOCK');
  assert.ok(!r.stderr.includes('AI 声称完成'));
});

test('10a3. 后台任务不放过 artifact 结构不一致（v7 换源：索引 [x] vs 详情未完成）', () => {
  const dir = makeV6Project('stop-background-work-mismatch', { indexMark: '[x]' });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-bg-work',
      background_tasks: [{ id: 'team_001', type: 'teammate', status: 'running', description: 'audit team' }],
    },
  });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('索引已是 [x]'));
});

test('11. v6 completed 但未 verified → exit 2', () => {
  const dir = makeV6Project('stop-unverified', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: false }),
  });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('verify') || r.stderr.includes('VERIFIED') || r.stderr.includes('验证'));
  assert.ok(r.stderr.includes('close-chg'));
});

test('12. v6 completed + verified + reviewed 仍活跃 → close-chg 优先阻止', () => {
  const dir = makeV6Project('stop-archive', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: true, reviewed: true }),
  });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('close-chg'));
  assert.ok(r.stderr.includes('archive-chg'));
});

test('RG-2a. v6 completed + verified 但未 reviewed → exit 2 含「未审计」', () => {
  const dir = makeV6Project('stop-unreviewed', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: true, reviewed: false }),
  });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('未审计'), '应提示未审计');
  assert.ok(r.stderr.includes('close-chg'));
});

test('RG-2b. v6 completed + verified + reviewed 仍活跃 → 仍在活跃索引、不含「未审计」', () => {
  const dir = makeV6Project('stop-reviewed-active', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: true, reviewed: true }),
  });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('仍在活跃索引'), '应提示仍在活跃索引');
  assert.ok(!r.stderr.includes('未审计'), '已 reviewed 不应再提示未审计');
});

test('RG-2c. 未 reviewed closing-required 连续阻止 4 次后降级放行并写 degraded', () => {
  const dir = makeV6Project('stop-unreviewed-downgrade', {
    indexMark: '[x]',
    walkToday: false,
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: true, reviewed: false }),
  });
  let last;
  for (let i = 0; i < 4; i++) {
    last = runHook('stop.js', { cwd: dir });
  }
  assert.strictEqual(last.code, 0, '第 4 次应降级放行');
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'degraded')), '降级时应写 degraded 标记');
});

test('RG-2d. 未 reviewed + 非空 background_tasks → 仍 exit 2 含「未审计」且不进 deferred 软提醒', () => {
  const dir = makeV6Project('stop-unreviewed-background', {
    indexMark: '[x]',
    walkToday: false,
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: true, reviewed: false }),
  });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-rg2d',
      background_tasks: [{
        id: 'wf_rg2d_001',
        type: 'workflow',
        status: 'running',
        name: 'PACEflow review workflow',
      }],
    },
  });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('未审计'), '应提示未审计');
  assert.ok(!r.stdout.includes('后台任务仍在运行'), 'closing-required 未审计不应进 background/deferred 软提醒');
});

test('12a. Stop 跳过其他 fresh session owner 的待归档 CHG', () => {
  const dir = makeV6ProjectWithChanges('stop-foreign-owner-closing', [{
    id: 'CHG-20260504-02',
    indexMark: '[x]',
    status: 'completed',
    task: '[x]',
    approved: true,
    verified: true,
  }], { walkToday: false });
  seedChangeOwner(dir, 'CHG-20260504-02', { state: 'closing' });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: { session_id: 'sid-current-owner-check' },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stderr.includes('CHG-20260504-02'));
});

test('12b. Stop 对其他 stale session owner 的 running CHG 也不硬阻断当前 session', () => {
  const dir = makeV6ProjectWithChanges('stop-foreign-stale-running', [{
    id: 'CHG-20260504-03',
    indexMark: '[/]',
    status: 'in-progress',
    task: '[/]',
    approved: true,
  }], { walkToday: false });
  seedChangeOwner(dir, 'CHG-20260504-03', {
    state: 'active',
    timestampMs: Date.now() - 60 * 60 * 1000,
  });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: { session_id: 'sid-current-owner-check' },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stderr.includes('CHG-20260504-03'));
});

test('12c. Stop 不跳过其他 owner 的结构不一致 CHG', () => {
  const dir = makeV6ProjectWithChanges('stop-foreign-inconsistent', [{
    id: 'CHG-20260504-04',
    indexMark: '[/]',
    status: 'archived',
    task: '[x]',
    approved: true,
    verified: true,
  }], { walkToday: false });
  seedChangeOwner(dir, 'CHG-20260504-04', { state: 'active' });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: { session_id: 'sid-current-owner-check' },
  });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('CHG-20260504-04'));
  assert.ok(r.stderr.includes('索引仍在活跃区'));
});

test('12d. Stop 对当前 session 已明确 blocked 的 CHG 软通过', () => {
  const dir = makeV6Project('stop-current-blocked-pass', {
    indexMark: '[!]',
    detail: chgDetail({ status: 'in-progress', task: '[!]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-current-blocked', state: 'blocked' });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: { session_id: 'sid-current-blocked' },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
  assert.ok(JSON.parse(r.stdout).systemMessage.includes('deferred'));
});

test('12e. Stop 对 blocked deferred CHG 的完成声明仍软通过', () => {
  const dir = makeV6Project('stop-current-blocked-claim-complete', {
    indexMark: '[!]',
    detail: chgDetail({ status: 'in-progress', task: '[!]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-current-blocked-claim', state: 'blocked' });
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: { session_id: 'sid-current-blocked-claim', last_assistant_message: '任务完成' },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
  assert.ok(JSON.parse(r.stdout).systemMessage.includes('CHG-20260504-01 blocked'));
});

test('13. v6 索引与详情状态不一致 → exit 2（v7 换源：双索引 mismatch 退役，改用 [x] vs 未完成）', () => {
  const dir = makeV6Project('stop-mismatch', { indexMark: '[x]' });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('索引已是 [x]'));
});

test('14. .pace/disabled → exit 0', () => {
  const dir = makeV6Project('stop-disabled', { paceRuntime: { disabled: '1' } });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 0);
});

test('14b. v5 布局 Stop 不再阻断（CHG-20260612-02：布局提示不门控）', () => {
  const dir = makeLegacyProject('stop-legacy');
  const r = runHook('stop.js', { cwd: dir, stdin: { stop_hook_active: false }, env: { PACE_VAULT_PATH: '' } });
  assert.strictEqual(r.code, 0, 'v5 布局不再触发 Stop exit 2');
  assert.ok(!/v5 PACE artifact|batch-archive|AskUserQuestion/.test(r.stderr), '不再输出迁移引导');
});

test('14b2. code-count 项目 idle Stop 不阻止 artifact-root 选择', () => {
  const dir = makeTmpDir('stop-code-count-idle');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'c.js'), 'c\n', 'utf8');
  const r = runHook('stop.js', { cwd: dir, stdin: { stop_hook_active: false, last_assistant_message: '你好' } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
  assert.ok(!fs.existsSync(path.join(dir, '.pace')), 'idle Stop 不应创建 .pace 运行态目录');
});

test('14b2b. 显式 artifact-root 但普通 task.md 非 v5 签名时 Stop 不误报 legacy', () => {
  const dir = makeTmpDir('stop-manual-generic-task-md');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local', 'utf8');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'c.js'), 'c\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'task.md'), '# Generic Tasks\n\n- [ ] generic todo unrelated to PACE\n', 'utf8');
  const r = runHook('stop.js', { cwd: dir, stdin: { stop_hook_active: false } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
});

test('14b3. Stop 连续阻止时即使 .pace 缺失也能累计并降级', () => {
  const dir = makeV6Project('stop-downgrade-without-runtime');
  let last;
  for (let i = 0; i < 4; i++) {
    last = runHook('stop.js', { cwd: dir, stdin: { stop_hook_active: false, last_assistant_message: '任务完成' } });
  }
  assert.strictEqual(last.code, 0, '第 4 次应降级放行');
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'degraded')), '降级时应写 degraded 标记');
  assert.strictEqual(fs.readFileSync(path.join(dir, '.pace', 'stop-block-count'), 'utf8'), '0');
});

test('14c. 多 CHG backlog 不阻止 Stop', () => {
  const dir = makeV6ProjectWithChanges('stop-backlog-only', [
    { id: 'CHG-20260504-01', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false },
    { id: 'CHG-20260504-02', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false },
    { id: 'CHG-20260504-03', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false },
  ]);
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'stop-block-count'), '2', 'utf8');
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.systemMessage.includes('deferred'));
  assert.ok(out.systemMessage.includes('CHG-20260504-01 backlog'));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.pace', 'stop-block-count'), 'utf8'), '0');
});

test('14d. 多 CHG 中仅 running 阻止，planned backlog 不阻止', () => {
  const dir = makeV6ProjectWithChanges('stop-running-with-backlog', [
    { id: 'CHG-20260504-01', indexMark: '[/]', status: 'in-progress', task: '[/]', approved: true },
    { id: 'CHG-20260504-02', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false },
    { id: 'CHG-20260504-03', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false },
  ]);
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('CHG-20260504-01'));
  assert.ok(!r.stderr.includes('CHG-20260504-02'));
  assert.ok(!r.stderr.includes('CHG-20260504-03'));
});

test('14e. 多 CHG 中 completed 必须 close/archive，planned backlog 不阻止', () => {
  const dir = makeV6ProjectWithChanges('stop-completed-with-backlog', [
    { id: 'CHG-20260504-01', indexMark: '[x]', status: 'completed', task: '[x]', approved: true, verified: true },
    { id: 'CHG-20260504-02', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false },
    { id: 'CHG-20260504-03', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false },
  ]);
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('CHG-20260504-01'));
  assert.ok(r.stderr.includes('close-chg'));
  assert.ok(!r.stderr.includes('CHG-20260504-02'));
  assert.ok(!r.stderr.includes('CHG-20260504-03'));
});

test('14f. approved planned backlog 不阻止 Stop', () => {
  const dir = makeV6ProjectWithChanges('stop-ready-backlog', [
    { id: 'CHG-20260504-01', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: true },
  ]);
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.systemMessage.includes('CHG-20260504-01 ready'));
});

test('14f1. deferred CHG 存在时声称完成仍软通过', () => {
  const dir = makeV6ProjectWithChanges('stop-ready-claim-complete', [
    { id: 'CHG-20260504-01', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: true },
  ]);
  const r = runHook('stop.js', {
    cwd: dir,
    stdin: { last_assistant_message: '任务完成' },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
  assert.ok(JSON.parse(r.stdout).systemMessage.includes('CHG-20260504-01 ready'));
});

test('14f2. Stop 对 malformed CHG 索引行不能静默通过', () => {
  const dir = makeV6ProjectWithChanges('stop-malformed-index', [
    { id: 'CHG-20260504-01', indexMark: '[ ]', status: 'planned', task: '[ ]', approved: false },
  ]);
  const malformed = '<!-- 详情与任务清单位于 changes/<id>.md；本文件只保留索引。 -->- [ ] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n';
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('CHG-20260504-01'));
  assert.ok(r.stderr.includes('索引行格式损坏'));
  assert.ok(r.stderr.includes('独占一行'));
});

test('14f3. Stop findings aging 识别带引号的 open status', () => {
  const dir = makeV6Project('stop-finding-quoted-open-aging', {
    withIndex: false,
    detail: false,
    walkToday: false,
  });
  fs.writeFileSync(path.join(dir, 'changes', 'findings', 'finding-2000-01-01-quoted-open.md'), [
    '---',
    'finding-id: FINDING-2000-01-01-quoted-open',
    'status: "open"',
    'type: research',
    'date: 2000-01-01',
    'impact: P2',
    'summary: quoted open status aging test',
    'schema-version: "6.0"',
    '---',
    '',
    '# quoted open status aging test',
    '',
  ].join('\n'), 'utf8');
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('open finding 超过 14 天'));
});

test('14g. 索引 [x] 但 status in-progress → inconsistent 阻止修复', () => {
  const dir = makeV6ProjectWithChanges('stop-x-status-mismatch', [
    { id: 'CHG-20260504-01', indexMark: '[x]', status: 'in-progress', task: '[x]', approved: true },
  ]);
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('索引已是 [x]'));
  assert.ok(r.stderr.includes('status=in-progress'));
});

test('14h. status archived 但索引仍在活跃区 → inconsistent 阻止修复', () => {
  const dir = makeV6ProjectWithChanges('stop-active-archived', [
    { id: 'CHG-20260504-01', indexMark: '[x]', status: 'archived', task: '[x]', approved: true, verified: true },
  ]);
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('已 archived'));
  assert.ok(r.stderr.includes('仍在活跃区'));
  assert.ok(r.stderr.includes('close-chg'));
});

test('14i. [-] 或 cancelled 仍在活跃区 → inconsistent 阻止修复', () => {
  const dir = makeV6ProjectWithChanges('stop-active-cancelled', [
    { id: 'CHG-20260504-01', indexMark: '[-]', status: 'cancelled', task: '[-]', approved: true },
  ]);
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('已取消'));
  assert.ok(r.stderr.includes('仍在活跃区'));
  assert.ok(r.stderr.includes('archive-chg'));
});

test('14i1. cancelled CHG 已归档到 ARCHIVE 下方后 Stop 放行', () => {
  const dir = makeV6ProjectWithChanges('stop-cancelled-archived-pass', [
    { id: 'CHG-20260504-01', indexMark: '[-]', status: 'cancelled', task: '[-]', approved: true },
  ], { walkToday: false });
  for (const rel of ['task.md', 'implementation_plan.md']) {
    const fp = path.join(dir, rel);
    const line = '- [-] [[chg-20260504-01]] 变更 CHG-20260504-01 #change [tasks:: T-001]';
    const content = fs.readFileSync(fp, 'utf8');
    fs.writeFileSync(fp, content.replace(`${line}\n\n<!-- ARCHIVE -->`, `<!-- ARCHIVE -->\n\n${line}`), 'utf8');
  }
  const r = runHook('stop.js', { cwd: dir, stdin: { session_id: 'sid-cancelled-archived-pass' } });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stderr.includes('仍在活跃区'));
  assert.ok(!r.stderr.includes('archive-chg'));
});

test('14j. in-progress 详情没有 T-NNN 任务行 → inconsistent 阻止修复', () => {
  const dir = makeV6ProjectWithChanges('stop-empty-task-list', [
    { id: 'CHG-20260504-01', indexMark: '[/]', status: 'in-progress', tasks: ['- [ ] 不是 T 编号任务'], approved: true },
  ]);
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('没有可识别的 T-NNN'));
});

test('14k. Stop 机械检查 walkthrough wikilink 指向详情文件', () => {
  const dir = makeV6Project('stop-walkthrough-bad-link', { withIndex: false });
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), [
    '# 工作记录',
    '',
    '## 最近工作',
    '',
    '| 日期 | 完成内容 | 关联变更 |',
    '| --- | --- | --- |',
    `| ${today()} | [[title-slug]] smoke | CHG-20260504-01 |`,
    '<!-- ARCHIVE -->',
    '',
  ].join('\n'), 'utf8');
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('wikilink 应为 [[chg-20260504-01]]'));
});

test('14k1. Stop 机械检查 walkthrough 行必须含详情 wikilink', () => {
  const dir = makeV6Project('stop-walkthrough-missing-link', { withIndex: false });
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), [
    '# 工作记录',
    '',
    '## 最近工作',
    '',
    '| 日期 | 完成内容 | 关联变更 |',
    '| --- | --- | --- |',
    `| ${today()} | smoke without link | CHG-20260504-01 |`,
    '<!-- ARCHIVE -->',
    '',
  ].join('\n'), 'utf8');
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('缺少 wikilink，应为 [[chg-20260504-01]]'));
});

test('14k2. Stop 机械检查 walkthrough 同步 worktree/branch 上下文', () => {
  const dir = makeV6Project('stop-walkthrough-missing-context', { withIndex: false });
  const indexRow = '- [x] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001] [worktree:: smoke] [branch:: feature-x]';
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n${indexRow}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n<!-- ARCHIVE -->\n${indexRow}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), [
    '# 工作记录',
    '',
    '## 最近工作',
    '',
    '| 日期 | 完成内容 | 关联变更 |',
    '| --- | --- | --- |',
    `| ${today()} | [[chg-20260504-01]] smoke | CHG-20260504-01 |`,
    '<!-- ARCHIVE -->',
    '',
  ].join('\n'), 'utf8');
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('缺少执行上下文 [worktree:: smoke] [branch:: feature-x]'));
});

console.log('\n--- post-tool-use.js ---');

test('15. v6 schema 缺 verified-date → warning', () => {
  const detail = chgDetail().replace('verified-date: null\n', '');
  const dir = makeV6Project('post-schema', { detail });
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', { cwd: dir, stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('verified-date'));
});

test('15r. v6 schema 缺 reviewed-date → warning', () => {
  const detail = chgDetail().replace('reviewed-date: null\n', '');
  const dir = makeV6Project('post-schema-reviewed', { detail });
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', { cwd: dir, stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('reviewed-date'));
});

test('15rb. v6 REVIEWED 标记存在但 reviewed-date 占位 → warning', () => {
  const detail = chgDetail()
    .replace('reviewed-date: null', 'reviewed-date: ""')
    .replace('<!-- APPROVED -->', '<!-- APPROVED -->\n<!-- REVIEWED -->');
  const dir = makeV6Project('post-schema-empty-reviewed-with-marker', { detail });
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', { cwd: dir, stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('reviewed-date 为占位 null/空'));
});

test('15ai. v6 task.md 活跃状态索引落 ARCHIVE 下方 → warning（finding 根因检测）', () => {
  const dir = makeV6Project('post-archive-misplace', { withIndex: false, detail: false });
  fs.writeFileSync(path.join(dir, 'task.md'),
    '# 项目任务追踪\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n\n- [/] [[chg-20260607-02]] 误插活跃 #change [tasks:: T-001]\n- [x] [[chg-20260504-01]] 归档 #change [tasks:: T-001]\n', 'utf8');
  const fp = path.join(dir, 'task.md');
  const r = runHook('post-tool-use.js', { cwd: dir, stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('ARCHIVE') && r.stdout.includes('chg-20260607-02'), '应告警活跃索引落归档区');
});

test('15aj. v6 task.md 活跃索引正常在 ARCHIVE 上方 → 不误报（回归）', () => {
  const dir = makeV6Project('post-archive-ok', { withIndex: false, detail: false });
  fs.writeFileSync(path.join(dir, 'task.md'),
    '# 项目任务追踪\n\n## 活跃任务\n\n- [/] [[chg-20260607-02]] 正常活跃 #change [tasks:: T-001]\n\n<!-- ARCHIVE -->\n\n- [x] [[chg-20260504-01]] 归档 #change [tasks:: T-001]\n', 'utf8');
  const fp = path.join(dir, 'task.md');
  const r = runHook('post-tool-use.js', { cwd: dir, stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('落在 <!-- ARCHIVE --> 下方'), '正常布局不应告警');
});

test('15a0. v6 schema verified-date null 且未验证 → 不误报占位 warning', () => {
  const detail = chgDetail().replace('verified-date: null', 'verified-date: ""');
  const dir = makeV6Project('post-schema-empty-verified-date', { detail });
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', { cwd: dir, stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('占位 null/空'));
});

test('15a0b. v6 VERIFIED 标记存在但 verified-date 占位 → warning', () => {
  const detail = chgDetail()
    .replace('verified-date: null', 'verified-date: ""')
    .replace('<!-- APPROVED -->', '<!-- APPROVED -->\n<!-- VERIFIED -->');
  const dir = makeV6Project('post-schema-empty-verified-date-with-marker', { detail });
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', { cwd: dir, stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('占位 null/空'));
});

test('15a0c. R-06b：带 slug 文件名 VERIFIED 标记但 verified-date 占位 → warning（兜底正则适配 slug）', () => {
  const detail = chgDetail({ id: 'CHG-20260504-03' })
    .replace('verified-date: null', 'verified-date: ""')
    .replace('<!-- APPROVED -->', '<!-- APPROVED -->\n<!-- VERIFIED -->');
  const dir = makeV6Project('post-schema-slug-verified');
  const fp = path.join(dir, 'changes', 'chg-20260504-03-some-slug.md');
  fs.writeFileSync(fp, detail, 'utf8');
  const r = runHook('post-tool-use.js', { cwd: dir, stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('占位 null/空'), 'R-06b: 带 slug 文件名（HOTFIX-20260610-01 后全部带 slug）的占位检测应生效，正则不能只匹配无 slug 旧格式');
});

test('15a. PostToolUse 对 artifact-writer 合法 C/V 标志写入不报直接写入', () => {
  const dir = makeV6Project('post-marker-agent');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-post-marker',
      agent_type: 'paceaitian-paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->\nverified-date: 2026-05-06T12:00:00+08:00',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('C/V 阶段标志被直接写入'));
});

test('15b. PostToolUse 对非 artifact-writer C/V 标志写入仍提醒', () => {
  const dir = makeV6Project('post-marker-direct');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-post-other',
      agent_type: 'code-reviewer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '<!-- APPROVED -->',
        new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('C/V/R 阶段标志被直接写入'));
  assert.ok(r.stdout.includes('artifact-writer'));
});

test('15c. artifact-writer 顺序编辑索引时不提示瞬时不一致', () => {
  const dir = makeV6Project('post-index-transient', { implIndex: '' });
  const fp = path.join(dir, 'task.md');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-post-index',
      agent_type: 'paceaitian-paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '## 活跃任务',
        new_string: '## 活跃任务',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('索引不一致'));
});

test('V7B-6. artifact-writer 写盘 7.0 详情含多余字段 → PostToolUse schema 合同打回', () => {
  const dir = makeV6Project('post-v7-schema-unknown');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  fs.writeFileSync(fp, [
    '---', 'status: in-progress', 'date: 2026-06-11', 'change-set: null', 'change-set-seq: null',
    'verified-date: null', 'reviewed-date: null', 'archived-date: null',
    'parent-tasks: ["[[task|task]]"]', 'schema-version: "7.0"', 'aliases: []', '---',
    '', '# t', '', '## 任务清单', '', '- [/] T-001 x', '', '<!-- APPROVED -->', '',
  ].join('\n'), 'utf8');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-v7b6', agent_type: 'paceaitian-paceflow:artifact-writer', tool_name: 'Edit',
      tool_input: { file_path: fp, old_string: 'x', new_string: 'y' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('v7 schema 合同'), 'V7B-6: 多余字段 aliases 即时打回');
  assert.ok(r.stdout.includes('aliases'));
});

test('V7B-7. 6.0 存量详情写盘 → 无 schema 合同 warning（skipped）', () => {
  const dir = makeV6Project('post-v7-schema-legacy');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-v7b7', agent_type: 'paceaitian-paceflow:artifact-writer', tool_name: 'Edit',
      tool_input: { file_path: fp, old_string: 'x', new_string: 'y' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('v7 schema 合同'), 'V7B-7: 6.0 帧零误报');
});

test('V7B-8. Stop 对 7.0 活跃 CHG 帧缺必填 key → repair 拦截', () => {
  const dir = makeV6Project('stop-v7-schema-missing', {
    detail: [
      '---', 'status: in-progress', 'date: 2026-06-11', 'change-set: null', 'change-set-seq: null',
      'verified-date: null', 'reviewed-date: null', 'archived-date: null',
      'schema-version: "7.0"', '---',
      '', '# t', '', '## 任务清单', '', '- [/] T-001 x', '', '<!-- APPROVED -->', '',
    ].join('\n'),
  });
  const r = runHook('stop.js', { cwd: dir });
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('schema 合同') && r.stderr.includes('parent-tasks'), 'V7B-8: 缺 parent-tasks key 兜底检出');
});

test('15d. v7: impl_plan 缺行不再产生跨索引不一致提示（旧双索引 warning 退役）', () => {
  const dir = makeV6Project('post-index-mismatch-direct', { implIndex: '' });
  const fp = path.join(dir, 'task.md');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-post-index-other',
      agent_type: 'code-reviewer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '## 活跃任务',
        new_string: '## 活跃任务',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('索引不一致'), 'v7: impl_plan 缺行不再产生跨索引不一致 warning');
});

test('15e. 写入 .pace/artifact-root 不触发无任务流程提醒', () => {
  const dir = makeTmpDir('post-runtime-config-artifact-root');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'c.js'), 'c\n', 'utf8');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(dir, '.pace', 'artifact-root'),
        content: 'local\n',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
});

test('15e1. Superpowers plan 存在但普通 docs/audits Edit 不触发 PostToolUse 创建 artifact 提醒', () => {
  const dir = makeTmpDir('post-superpowers-doc-edit-silent');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'audits'), { recursive: true });
  const fp = path.join(dir, 'docs', 'audits', 'audit.md');
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-05-11-plan.md'), '# Plan\n', 'utf8');
  fs.writeFileSync(fp, '# Audit\n', 'utf8');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '# Audit',
        new_string: '# Audit\n\nUpdated',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
});

test('15f. PostToolUse 同一 CHG 状态提醒每会话只提示一次', () => {
  const dir = makeV6Project('post-entry-warning-once', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: false }),
  });
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const stdin = {
    tool_name: 'Edit',
    tool_input: {
      file_path: fp,
      old_string: '## 工作记录',
      new_string: '## 工作记录',
    },
  };
  const first = runHook('post-tool-use.js', { cwd: dir, stdin });
  assert.strictEqual(first.code, 0);
  assert.ok(first.stdout.includes('缺少 verified-date'));

  const second = runHook('post-tool-use.js', { cwd: dir, stdin });
  assert.strictEqual(second.code, 0);
  assert.ok(!second.stdout.includes('缺少 verified-date'));
});

test('15f0. PostToolUse 将 quoted null verified-date 视为未验证', () => {
  const detail = chgDetail({ status: 'completed', task: '[x]', approved: true, verified: false })
    .replace('verified-date: null', 'verified-date: "null"');
  const dir = makeV6Project('post-entry-warning-quoted-null', {
    indexMark: '[x]',
    detail,
  });
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '## 工作记录',
        new_string: '## 工作记录',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('缺少 verified-date'));
});

test('RG-3a. PostToolUse verified 未 reviewed → 软催含「未审计」且不催归档', () => {
  const dir = makeV6Project('post-review-missing', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: true, reviewed: false }),
  });
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '## 工作记录',
        new_string: '## 工作记录',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('未审计'), '应软催未审计');
  assert.ok(!r.stdout.includes('优先派 close-chg 归档'), '未 reviewed 不应催归档');
});

test('RG-3b. PostToolUse verified + reviewed → 软催归档', () => {
  const dir = makeV6Project('post-archive-reminded', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: true, reviewed: true }),
  });
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '## 工作记录',
        new_string: '## 工作记录',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('优先派 close-chg 归档'), '已审计应催归档');
  assert.ok(!r.stdout.includes('未审计'), '已 reviewed 不应再催未审计');
});

test('15f1. artifact-writer 多步收尾中间态不输出状态类 warning', () => {
  const dir = makeV6Project('post-entry-warning-agent-silent', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: false }),
  });
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-close-midstate',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: '## 工作记录',
        new_string: '## 工作记录',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('缺少 verified-date'));
});

test('15f2. PostToolUse 不处理 Agent close/archive owner 收口', () => {
  const dir = makeV6Project('post-agent-close-owner-still-active', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true, verified: true }),
  });
  const ownerPath = seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-close-owner',
    agentId: 'agent-close-owner',
    state: 'closing',
  });
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-close-owner',
      agent_id: 'agent-close-owner',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        prompt: [
          'operation: close-chg',
          'target: CHG-20260504-01',
          'verification-confirmed: true',
          'complete-open-tasks: true',
          'verify-summary: pass',
          'walkthrough-summary: done',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.strictEqual(owner.state, 'closing');
});

test('15g. walkthrough wikilink 必须指向 CHG/HOTFIX 详情 slug', () => {
  const dir = makeV6Project('post-walkthrough-bad-link', { withIndex: false });
  const fp = path.join(dir, 'walkthrough.md');
  fs.writeFileSync(fp, [
    '# 工作记录',
    '',
    '## 最近工作',
    '',
    '| 日期 | 完成内容 | 关联变更 |',
    '| --- | --- | --- |',
    `| ${today()} | [[title-slug]] smoke | CHG-20260504-01 |`,
    '<!-- ARCHIVE -->',
    '',
  ].join('\n'), 'utf8');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-walkthrough',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: 'smoke',
        new_string: 'smoke',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('wikilink 应为 [[chg-20260504-01]]'));
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(out.continue, true);
  assert.ok(out.reason.includes('PostToolUse 终态修复'));
  assert.ok(out.reason.includes('不要结束 artifact-writer 报告'));

  const second = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-walkthrough',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: 'smoke',
        new_string: 'smoke',
      },
    },
  });
  assert.strictEqual(second.code, 0);
  const secondOut = JSON.parse(second.stdout);
  assert.notStrictEqual(secondOut.decision, 'block', '同一 walkthrough 终态问题每 session 只 continue 一次，避免循环');
  assert.ok(second.stdout.includes('wikilink 应为 [[chg-20260504-01]]'));
});

test('15g1. walkthrough 行缺少 wikilink 时 PostToolUse 提醒', () => {
  const dir = makeV6Project('post-walkthrough-missing-link', { withIndex: false });
  const fp = path.join(dir, 'walkthrough.md');
  fs.writeFileSync(fp, [
    '# 工作记录',
    '',
    '## 最近工作',
    '',
    '| 日期 | 完成内容 | 关联变更 |',
    '| --- | --- | --- |',
    `| ${today()} | smoke without link | CHG-20260504-01 |`,
    '<!-- ARCHIVE -->',
    '',
  ].join('\n'), 'utf8');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-walkthrough',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: 'smoke',
        new_string: 'smoke',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('缺少 wikilink，应为 [[chg-20260504-01]]'));
});

test('15g2. walkthrough 缺少 worktree/branch 上下文时 PostToolUse 提醒', () => {
  const dir = makeV6Project('post-walkthrough-missing-context', { withIndex: false });
  const indexRow = '- [x] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001] [worktree:: smoke] [branch:: feature-x]';
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n${indexRow}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n<!-- ARCHIVE -->\n${indexRow}\n`, 'utf8');
  const fp = path.join(dir, 'walkthrough.md');
  fs.writeFileSync(fp, [
    '# 工作记录',
    '',
    '## 最近工作',
    '',
    '| 日期 | 完成内容 | 关联变更 |',
    '| --- | --- | --- |',
    `| ${today()} | [[chg-20260504-01]] smoke | CHG-20260504-01 |`,
    '<!-- ARCHIVE -->',
    '',
  ].join('\n'), 'utf8');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-walkthrough',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: 'smoke',
        new_string: 'smoke',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('缺少执行上下文 [worktree:: smoke] [branch:: feature-x]'));
});

test('15g3. walkthrough 同一行 wikilink 错误仍继续检查 worktree/branch 上下文', () => {
  const dir = makeV6Project('post-walkthrough-bad-link-and-context', { withIndex: false });
  const indexRow = '- [x] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001] [worktree:: smoke] [branch:: feature-x]';
  fs.writeFileSync(path.join(dir, 'task.md'), `# 项目任务追踪\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n${indexRow}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), `# 实施计划\n\n## 变更索引\n\n<!-- ARCHIVE -->\n${indexRow}\n`, 'utf8');
  const fp = path.join(dir, 'walkthrough.md');
  fs.writeFileSync(fp, [
    '# 工作记录',
    '',
    '## 最近工作',
    '',
    '| 日期 | 完成内容 | 关联变更 |',
    '| --- | --- | --- |',
    `| ${today()} | [[title-slug]] smoke | CHG-20260504-01 |`,
    '<!-- ARCHIVE -->',
    '',
  ].join('\n'), 'utf8');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: {
      agent_id: 'agent-walkthrough',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: {
        file_path: fp,
        old_string: 'smoke',
        new_string: 'smoke',
      },
    },
  });
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(out.continue, true);
  assert.ok(out.reason.includes('wikilink 应为 [[chg-20260504-01]]'));
  assert.ok(out.reason.includes('缺少执行上下文 [worktree:: smoke] [branch:: feature-x]'));
});

test('16. correction 详情变更 → knowledge 提醒', () => {
  const dir = makeV6Project('post-correction');
  const fp = path.join(dir, 'changes', 'corrections', 'correction-20260504-test.md');
  fs.writeFileSync(fp, '---\nschema-version: "6.0"\n---\n# Correction\n', 'utf8');
  const r = runHook('post-tool-use.js', { cwd: dir, stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('knowledge'));
});

test('16b. correction 新建（Write content 路径）→ knowledge 提醒', () => {
  // record-correction 的 canonical 动作是 Write 新建（content 字段、无 edits/new_string），
  // FC-01：HINT 触发判据原为 `&& newString`，Write 路径 newString 为空被短路，提醒漏发。
  const dir = makeV6Project('post-correction-write');
  const fp = path.join(dir, 'changes', 'corrections', 'correction-20260504-write.md');
  const r = runHook('post-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'Write', tool_input: { file_path: fp, content: '---\nschema-version: "6.0"\n---\n# Correction\n详情正文\n' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('knowledge'), 'Write 创建 correction 也应触发 knowledge 同步提醒');
});

test('17. vault 内 changes 详情编辑 → cli-refresh flag', () => {
  const cwd = makeTmpDir('post-vault-cwd');
  const projectName = path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const vaultDir = path.join(_vaultTmpDir, 'projects', projectName);
  fs.mkdirSync(path.join(vaultDir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n');
  fs.writeFileSync(path.join(vaultDir, 'implementation_plan.md'), '# 实施计划\n\n## 变更索引\n\n<!-- ARCHIVE -->\n');
  const fp = path.join(vaultDir, 'changes', 'chg-20260504-01.md');
  fs.writeFileSync(fp, chgDetail(), 'utf8');
  fs.mkdirSync(path.join(cwd, '.pace'), { recursive: true });
  const r = runHook('post-tool-use.js', { cwd, stdin: { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(fs.existsSync(path.join(cwd, '.pace', 'cli-refresh-done')));
});

test('17b. v5 布局 PostToolUse 一句性布局提示（session 级一次，CHG-20260612-02）', () => {
  const dir = makeLegacyProject('post-legacy');
  const stdinPayload = { ...codeEditStdin(dir), session_id: 'sid-v5-notice' };
  const r = runHook('post-tool-use.js', { cwd: dir, stdin: stdinPayload, env: { PACE_VAULT_PATH: '' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('v5 时代 artifact 布局'), '应注入一句布局提示');
  assert.ok(r.stdout.includes('不自动迁移'));
  assert.ok(!/batch-archive|不再校验或修复 v5|迁移本身报告/.test(r.stdout), '不再出现迁移引导文案');
  // warnOnce：同 session 第二次写入不重复提示
  const r2 = runHook('post-tool-use.js', { cwd: dir, stdin: stdinPayload, env: { PACE_VAULT_PATH: '' } });
  assert.ok(!r2.stdout.includes('v5 时代 artifact 布局'), 'session 内只提示一次');
});

console.log('\n--- task-list / pre-compact / lifecycle observers ---');

test('18. hooks.json 不再注册已退役的 TodoWrite/TaskCreate/TaskUpdate PreToolUse matcher', () => {
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf8'));
  const entries = hooksConfig.hooks.PreToolUse || [];
  const matchers = entries.map(e => e.matcher || '');
  assert.ok(!matchers.includes('TodoWrite|TaskCreate|TaskUpdate'));
  assert.ok(!entries.some(e => (e.hooks || []).some(h => JSON.stringify(h).includes('task-list-sync.js'))));

  const postEntries = hooksConfig.hooks.PostToolUse || [];
  const postMatchers = postEntries.flatMap(e => String(e.matcher || '').split('|'));
  assert.ok(!postMatchers.includes('Agent'), 'PostToolUse 不应注册 Agent；Agent 失败由 PostToolUseFailure 处理');
});

test('18a. task-list-sync legacy observer 不注入 additionalContext', () => {
  const dir = makeV6Project('taskcreate-legacy-observer');
  const r = runHook('task-list-sync.js', {
    cwd: dir,
    stdin: {
      tool_name: 'TaskCreate',
      tool_input: { subject: 'T-901 旧 matcher 兼容', description: '旧手动配置可能仍调用此脚本' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'task-list-used')));
});

test('18b. TaskCreated/TaskCompleted 事件 observer 只记录运行态不输出提示', () => {
  const dir = makeV6Project('task-event-observer');
  const created = runHook('task-list-sync.js', {
    cwd: dir,
    stdin: {
      hook_event_name: 'TaskCreated',
      task_id: 'task-001',
      task_subject: '修改 index.js 输出',
      task_description: 'Claude 任务面板工作记忆',
    },
  });
  const completed = runHook('task-list-sync.js', {
    cwd: dir,
    stdin: {
      hook_event_name: 'TaskCompleted',
      task_id: 'task-001',
      task_subject: '修改 index.js 输出',
    },
  });
  assert.strictEqual(created.code, 0);
  assert.strictEqual(created.stdout, '');
  assert.strictEqual(completed.code, 0);
  assert.strictEqual(completed.stdout, '');
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'task-list-used')));
});

test('18d. 纯 dated-plan 项目（A1 后非 PACE）TaskCreate 零注入零写盘', () => {
  // A1 收紧后 dated-plan 不再激活——task-list-sync 对非 PACE 项目 SKIP 早退，
  // 不注入提醒、也不写 .pace/task-list-used（软信号项目零静默写盘，design 延伸收益）。
  const dir = makeTmpDir('taskcreate-superpowers-no-task');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', '2026-05-11-plan.md'), '# Plan\n', 'utf8');
  const r = runHook('task-list-sync.js', {
    cwd: dir,
    stdin: {
      tool_name: 'TaskCreate',
      tool_input: { subject: '先建立任务清单', description: '仅作为 Claude 工作记忆' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'task-list-used')), '非 PACE 项目不应写 task-list-used');
});

test('18e. 纯 code-count 项目（A1 后非 PACE）TaskUpdate 零注入零写盘', () => {
  const dir = makeTmpDir('taskupdate-code-count-no-artifact');
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(dir, 'c.js'), 'module.exports = 3;\n');
  const r = runHook('task-list-sync.js', {
    cwd: dir,
    stdin: {
      tool_name: 'TaskUpdate',
      tool_input: { task_id: 'task-001', status: 'in_progress' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'task-list-used')), '非 PACE 项目不应写 task-list-used');
});

// test 19 已删（M4/T-002）：原测 PreCompact 写 .pace/pre-compact-state.json 快照
//   （activeChanges/runtime.blockCount/findings/walkthrough）。快照机制退役后这些字段不复存在；
//   compact 恢复所需信息改由 SessionStart 实时读 artifact 注入（不经 PreCompact），由 MH-5 覆盖。
//   PreCompact 现仅做 native plan 兜底检测，行为由 19b 验证。

test('19a. PreCompact 在 root 选择前保持零写入', () => {
  const dir = makeTmpDir('pc-root-choice-pending');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'c.js'), 'c\n', 'utf8');
  const r = runHook('pre-compact.js', { cwd: dir });
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.pace')), 'root 选择前 PreCompact 不应创建 .pace');
});

test('19b. PreCompact 只记录匹配当前项目的 native plan（快照退役后落 current-native-plan）', () => {
  // M4/T-002：快照退役后 native plan 检测保留，唯一持久化出口是 .pace/current-native-plan
  //   （不再写 pre-compact-state.json）。断言据此改读 current-native-plan 文件，而非已退役的 snap.nativePlans。
  const dir = makeV6Project('pc-native-plan-filter');
  const home = makeTmpDir('pc-native-plan-home');
  const plansDir = path.join(home, '.claude', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });

  const foreignPlan = path.join(plansDir, 'foreign.md');
  fs.writeFileSync(foreignPlan, '# ccauth unrelated plan\n\n不属于当前项目。\n', 'utf8');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'current-native-plan'), foreignPlan, 'utf8');
  let r = runHook('pre-compact.js', { cwd: dir, env: { HOME: home } });
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'pre-compact-state.json')), '快照退役后 PreCompact 不再写 pre-compact-state.json');
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'current-native-plan')), '已有无关 current-native-plan 应被清理（foreign 不落盘）');

  const matchingPlan = path.join(plansDir, 'matching.md');
  fs.writeFileSync(matchingPlan, `# ${projectNameForDir(dir)} native plan\n\n用于当前项目。\n`, 'utf8');
  r = runHook('pre-compact.js', { cwd: dir, env: { HOME: home } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.pace', 'current-native-plan'), 'utf8'), matchingPlan.replace(/\\/g, '/'), '匹配当前项目的 native plan 应落到 current-native-plan');
});

test('21. StopFailure PACE 项目记录日志', () => {
  const dir = makeV6Project('sf-v6');
  const logFile = E2E_LOG_PATH;
  const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const r = runHook('stop-failure.js', { cwd: dir, stdin: { error_type: 'rate_limit', stop_reason: 'api_error' } });
  assert.strictEqual(r.code, 0);
  const after = fs.readFileSync(logFile, 'utf8');
  const delta = after.slice(before.length);
  assert.ok(delta.includes('StopFailure'));
  assert.ok(delta.includes('rate_limit'));
});

test('22. PostToolUseFailure artifact/code 写入失败注入恢复提示', () => {
  const dir = makeV6Project('ptuf-v6');
  const r = runHook('post-tool-use-failure.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'task.md') },
      error: 'EACCES: permission denied',
      duration_ms: 1234,
    },
  });
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('工具失败恢复'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Artifact 根目录'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('不要把失败工具调用视为完成'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('artifact 写入失败'));
});

test('22d. PostToolUseFailure 普通只读 Bash 失败只记录日志不注入 PACE 恢复提示', () => {
  const dir = makeV6Project('ptuf-bash-readonly-noise');
  const r = runHook('post-tool-use-failure.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: { command: 'ls docs/audits/missing.md' },
      error: 'No such file or directory',
    },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
});

test('22e. PostToolUseFailure Bash 验证失败仍注入验证恢复提示', () => {
  const dir = makeV6Project('ptuf-bash-validation');
  const r = runHook('post-tool-use-failure.js', {
    cwd: dir,
    stdin: {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'tests failed',
    },
  });
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('确认验证通过前不要派 verify/close-chg'));
});

test('22e0. PostToolUseFailure PowerShell / Monitor 验证失败仍注入验证恢复提示', () => {
  const dir = makeV6Project('ptuf-command-validation');
  for (const toolName of ['PowerShell', 'Monitor']) {
    const r = runHook('post-tool-use-failure.js', {
      cwd: dir,
      stdin: {
        tool_name: toolName,
        tool_input: { command: 'npm test' },
        error: 'tests failed',
      },
    });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(out.hookSpecificOutput.additionalContext.includes('确认验证通过前不要派 verify/close-chg'), toolName);
  }
});

test('22e1. PostToolUseFailure 自定义 Bash 验证脚本失败仍注入验证恢复提示', () => {
  const dir = makeV6Project('ptuf-bash-custom-validation');
  for (const command of ['bash scripts/test.sh', './run-tests.sh', 'python -m pytest tests/unit']) {
    const r = runHook('post-tool-use-failure.js', {
      cwd: dir,
      stdin: {
        tool_name: 'Bash',
        tool_input: { command },
        error: 'tests failed',
      },
    });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(out.hookSpecificOutput.additionalContext.includes('确认验证通过前不要派 verify/close-chg'), command);
  }
});

test('22c. PostToolUseFailure 写失败直接释放 index:changes 锁（v7 半事务保锁退役）', () => {
  const dir = makeV6Project('ptuf-index-tx-open');
  const lockPath = seedArtifactResourceLock(dir, 'index:changes', {
    sessionId: 'sid-index-fail',
    agentId: 'agent-index-fail',
    file: path.join(dir, 'task.md'),
  });
  const beforeLog = fs.existsSync(E2E_LOG_PATH) ? fs.readFileSync(E2E_LOG_PATH, 'utf8') : '';
  const r = runHook('post-tool-use-failure.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-index-fail',
      agent_id: 'agent-index-fail',
      agent_type: 'paceflow:artifact-writer',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'task.md') },
      error: 'Edit failed',
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(lockPath), 'v7: 单文件写失败没有半开事务态，直接释放锁减少并发阻塞');
  const afterLog = fs.readFileSync(E2E_LOG_PATH, 'utf8');
  const delta = afterLog.slice(beforeLog.length);
  assert.ok(delta.includes('RELEASE_ARTIFACT_RESOURCE_LOCK'));
  assert.ok(!delta.includes('index-transaction-open-after-failure'));
});

test('22a. PostToolUseFailure 用户中断只记录日志不注入恢复提示', () => {
  const dir = makeV6Project('ptuf-interrupt');
  const r = runHook('post-tool-use-failure.js', {
    cwd: dir,
    stdin: { tool_name: 'Bash', is_interrupt: true, error: 'User aborted' },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
});

test('22b. hooks.json 为 PostToolUseFailure 注册 Agent / command-tool matcher', () => {
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf8'));
  const entries = hooksConfig.hooks.PostToolUseFailure || [];
  const matcherParts = entries.flatMap(e => String(e.matcher || '').split('|'));
  for (const tool of ['Agent', 'Bash', 'PowerShell', 'Monitor']) {
    assert.ok(matcherParts.includes(tool), `PostToolUseFailure matcher 必须包含 ${tool}`);
  }
});

test('22b1. hooks.json 为 PreToolUse 注册 PowerShell / Monitor matcher', () => {
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf8'));
  const entries = hooksConfig.hooks.PreToolUse || [];
  const matcherParts = entries.flatMap(e => String(e.matcher || '').split('|'));
  for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
    assert.ok(matcherParts.includes(tool), `PreToolUse matcher 必须包含 ${tool}`);
  }
});

test('22c. hooks.json 使用 exec-form args 避免 shell quoting', () => {
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf8'));
  for (const [eventName, entries] of Object.entries(hooksConfig.hooks || {})) {
    for (const entry of entries || []) {
      for (const hook of entry.hooks || []) {
        assert.strictEqual(hook.type, 'command', `${eventName} hook type`);
        assert.strictEqual(hook.command, 'node', `${eventName} 应使用 command=node`);
        assert.ok(Array.isArray(hook.args), `${eventName} 应使用 args 数组`);
        assert.ok(hook.args.length >= 1, `${eventName} args 至少包含脚本路径`);
        assert.ok(hook.args[0].startsWith('${CLAUDE_PLUGIN_ROOT}/hooks/'), `${eventName} args 应使用 CLAUDE_PLUGIN_ROOT 占位`);
        assert.ok(hook.args[0].endsWith('.js'), `${eventName} args 应指向 .js hook`);
      }
    }
  }
});

test('23. SubagentStop artifact-writer 合规报告记录 transcript 且不注入提示', () => {
  const dir = makeV6Project('sas-valid');
  const r = runHook('subagent-stop.js', {
    cwd: dir,
    stdin: {
      agent_type: 'paceflow:artifact-writer',
      agent_transcript_path: '/tmp/pace-agent.jsonl',
      last_assistant_message: '## artifact-writer 报告\n\n**状态**：SUCCESS\n',
    },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(fs.readFileSync(path.join(dir, '.pace', 'last-artifact-writer-transcript'), 'utf8'), '/tmp/pace-agent.jsonl');
});

test('23c. SubagentStop 在 close/archive 已离开活跃索引后兜底标记 owner closed', () => {
  const dir = makeV6Project('sas-close-owner-fallback', {
    withIndex: false,
    detail: chgDetail({ status: 'archived', task: '[x]', approved: true, verified: true }),
    walkToday: false,
  });
  const ownerPath = seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-sas-close',
    agentId: 'agent-sas-close',
    state: 'closing',
  });
  const transcriptPath = path.join(dir, 'agent-close.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'user',
    message: {
      content: [
        'operation: close-chg',
        'target: CHG-20260504-01',
        'verification-confirmed: true',
      ].join('\n'),
    },
  }) + '\n', 'utf8');
  const r = runHook('subagent-stop.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-sas-close',
      agent_id: 'agent-sas-close',
      agent_type: 'paceflow:artifact-writer',
      agent_transcript_path: transcriptPath,
      last_assistant_message: '## artifact-writer 报告\n\n**状态**：SUCCESS\n',
    },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.strictEqual(owner.state, 'closed');
  assert.strictEqual(owner.operation, 'close-chg');
});

test('23d. SubagentStop close subagent 停止但 target 仍在活跃索引 → 不误标 owner closed（target-still-active 兜底；CHG-20260616-03 T-003 / P3.11）', () => {
  const dir = makeV6Project('sas-close-target-still-active', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  const ownerPath = seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-sas-still',
    agentId: 'agent-sas-still',
    state: 'closing',
  });
  const transcriptPath = path.join(dir, 'agent-close-still.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'user',
    message: { content: ['operation: close-chg', 'target: CHG-20260504-01', 'verification-confirmed: true'].join('\n') },
  }) + '\n', 'utf8');
  const r = runHook('subagent-stop.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-sas-still',
      agent_id: 'agent-sas-still',
      agent_type: 'paceflow:artifact-writer',
      agent_transcript_path: transcriptPath,
      last_assistant_message: '## artifact-writer 报告\n\n**状态**：SUCCESS\n',
    },
  });
  assert.strictEqual(r.code, 0);
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.notStrictEqual(owner.state, 'closed', 'target 仍在活跃索引时不误标 closed（target-still-active 兜底）');
  assert.strictEqual(owner.state, 'closing', 'owner 保持 closing 待目标真正离开活跃区');
});

test('23a. SubagentStop artifact-writer 缺报告标题时注入格式提醒', () => {
  const dir = makeV6Project('sas-missing-title');
  const r = runHook('subagent-stop.js', {
    cwd: dir,
    stdin: {
      subagent_type: 'artifact-writer',
      last_assistant_message: '## 报告\n\n**状态**：SUCCESS\n',
    },
  });
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SubagentStop');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('报告未能解析'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Artifact 根目录'));
});

test('23b. SubagentStop 允许全局时间戳前缀但记录为日志 warning', () => {
  const dir = makeV6Project('sas-timestamp-prefix');
  const r = runHook('subagent-stop.js', {
    cwd: dir,
    stdin: {
      agent_type: 'artifact-writer',
      last_assistant_message: '[2026-05-07 08:51:56]\n## artifact-writer 报告\n\n**状态**：FAILED\n',
    },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
});

test('MH-6. hooks.json SessionStart 注册 core + artifact 两个 command', () => {
  const hj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json'), 'utf8'));
  const ss = hj.hooks.SessionStart;
  const cmds = ss.flatMap(block => block.hooks).map(h => (h.args || []).join(' '));
  assert.ok(cmds.some(c => c.includes('--group core')), '有 core command');
  assert.ok(cmds.some(c => c.includes('--group artifact')), '有 artifact command');
});

// === CHG-20260616-01 T-001：写码门回归单一判据——非代码文件一律放行，代码文件仍门控 ===
// 原 CHG-08 §B「豁免 P 阶段规划产物」随执行期完整性门第二分支一并移除：非代码文件（design doc / README /
// REFERENCE / 配置）不再因「持有 owned CHG」进 C/E 流程门，一律放行；代码文件走第一条件仍门控（PB-3）。
// 反向锁定（widen-matcher-verify-reverse）：放行扩到全部非代码文件，代码文件不受影响、完整性门不受影响。
test('PB-1. own 非 runnable CHG 写非代码(design doc)放行——非代码不进流程门', () => {
  const dir = makeV6Project('ptu-planning-exempt', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[!]', approved: true }),  // [!] → blocked>0 → 非 runnable
  });
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-current', state: 'active' });  // own actionable
  fs.mkdirSync(path.join(dir, 'docs', 'superpowers', 'specs'), { recursive: true });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-current', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'docs/superpowers/specs/2026-06-09-x-design.md'), content: '# design\n' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('E 阶段未就绪'), '非代码文件不应被 E 门控拦');
  assert.ok(!r.stdout.includes('"permissionDecision":"deny"'), '非代码文件应放行');
});

test('PB-2. own 非 runnable CHG 写 README.md 放行——非代码文件不进 E 门（CHG-20260616-01）', () => {
  const dir = makeV6Project('ptu-readme-still-gated', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[!]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-current', state: 'active' });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-current', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'README.md'), content: 'docs\n' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('E 阶段未就绪'), 'README.md 非代码文件，不再被 E 门控');
  assert.ok(!r.stdout.includes('"permissionDecision":"deny"'), 'README.md 放行');
});

test('PB-3. 反向：own 非 runnable CHG 写代码(.js)仍被 E 门控 deny', () => {
  const dir = makeV6Project('ptu-code-still-gated', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[!]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-current', state: 'active' });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { ...codeEditStdin(dir), session_id: 'sid-current' },  // Edit src.js（isCodeFile，第一条件 gate，豁免不影响代码）
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('E 阶段未就绪'), '代码文件 isCodeFile，仍应被 E 门控');
});

test('PB-4. own 非 runnable CHG 写 docs/REFERENCE.md 放行——非代码文件不进 E 门（CHG-20260616-01）', () => {
  const dir = makeV6Project('ptu-docs-ref-still-gated', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[!]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', { sessionId: 'sid-current', state: 'active' });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-current', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'docs/REFERENCE.md'), content: '# ref\n' } },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('E 阶段未就绪'), 'docs/REFERENCE.md 非代码文件，不再被 E 门控');
  assert.ok(!r.stdout.includes('"permissionDecision":"deny"'), 'docs/REFERENCE.md 放行');
});

// ============================================================
// CHG-A A3：W11 + lookahead 双入口静默锁定病理根除
// ============================================================

test('A3. SessionStart 对野外 code-count 项目不建 changes/（W11 病理根除）', () => {
  // 野外：3+ 代码文件 + 无 vault + 无 disabled + 无 changes/。A1 后 paceSignal=false → W11 整块短路。
  const dir = makeTmpDir('a3-w11-no-changes');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a');
  fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
  fs.writeFileSync(path.join(dir, 'c.py'), '# c');
  runHook('session-start.js', { cwd: dir, args: ['--group', 'core'], env: { PACE_VAULT_PATH: '' }, stdin: { type: 'startup' } });
  runHook('session-start.js', { cwd: dir, args: ['--group', 'artifact'], env: { PACE_VAULT_PATH: '' }, stdin: { type: 'startup' } });
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), '不应静默创建 changes/');
  assert.ok(!fs.existsSync(path.join(dir, 'task.md')), '不应静默创建 task.md');
});

test('A3b. 野外无 vault 项目 Write 达 code-count 阈值不 deny 不建模板（lookahead 病理根除）', () => {
  // 原 T-079 lookahead：无强信号 + Write 新文件将达第 3 个 → deny + createTemplates。A3b 移除后应完全放行。
  const dir = makeTmpDir('a3b-lookahead-no-deny');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a');
  fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
  const r = runHookDetailed('pre-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'c.py'), content: '# c' } },
    env: { PACE_VAULT_PATH: '' },
  });
  assert.ok(!r.stdout.includes('"permissionDecision":"deny"'), '野外 code-count Write 不应被 deny');
  assert.ok(!fs.existsSync(path.join(dir, 'task.md')), '不应建 task.md 模板');
  assert.ok(!fs.existsSync(path.join(dir, 'changes')), '不应建 changes/');
});

// ============================================================
// CHG-B B1：set-activation.js 三子命令（--enable / --disable / --status）
// ============================================================

test('B1. --disable 写 disabled 标记 + isPaceProject 随后为 false', () => {
  const dir = makeTmpDir('b1-disable');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true }); // 先有 artifact 强信号
  const r = runSetActivationHelper({ cwd: dir, args: ['--disable', '--cwd', dir] });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'disabled')), 'disabled 标记应写入 .pace/');
  // disabled 守卫每次 fs.existsSync 实时判定（T-080），清 require 缓存防其他模块级缓存干扰。
  delete require.cache[require.resolve('../plugin/hooks/pace-utils')];
  assert.strictEqual(require('../plugin/hooks/pace-utils').isPaceProject(dir), false, 'disable 后 isPaceProject 应 false');
});

test('B1. --enable 删 disabled 标记 + 既有 changes/ 自动恢复 artifact', () => {
  const dir = makeTmpDir('b1-enable-restore');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  runSetActivationHelper({ cwd: dir, args: ['--disable', '--cwd', dir] });
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'disabled')));
  const r = runSetActivationHelper({ cwd: dir, args: ['--enable', '--cwd', dir] });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'disabled')), 'enable 应删 disabled 标记');
  delete require.cache[require.resolve('../plugin/hooks/pace-utils')];
  assert.strictEqual(require('../plugin/hooks/pace-utils').isPaceProject(dir), 'artifact', '删标记后既有 changes/ 自动恢复');
  assert.match(r.stdout, /恢复/, 'enable 输出应说明恢复既有项目');
});

test('B1. --enable 无既有强信号 → 首次启用写 .pace-enabled + 引导选 artifact-root', () => {
  const dir = makeTmpDir('b1-enable-fresh');
  const r = runSetActivationHelper({ cwd: dir, args: ['--enable', '--cwd', dir] });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.pace-enabled')), '首次 enable 应写项目根 .pace-enabled 强信号');
  assert.match(r.stdout, /set-artifact-root|artifact-root/, '首次 enable 应引导选 artifact-root');
});

test('B1. --status 输出当前状态机态（disabled/enabled/inactive）', () => {
  const dir = makeTmpDir('b1-status');
  let r = runSetActivationHelper({ cwd: dir, args: ['--status', '--cwd', dir] });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /inactive/, '空项目 status 应为 inactive');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  r = runSetActivationHelper({ cwd: dir, args: ['--status', '--cwd', dir] });
  assert.match(r.stdout, /enabled/, '有 changes/ 的项目 status 应为 enabled');
  runSetActivationHelper({ cwd: dir, args: ['--disable', '--cwd', dir] });
  r = runSetActivationHelper({ cwd: dir, args: ['--status', '--cwd', dir] });
  assert.match(r.stdout, /disabled/, 'disable 后 status 应为 disabled');
});

test('B1. --disable 幂等（已 disabled 再 disable 退出码 0）', () => {
  const dir = makeTmpDir('b1-disable-idempotent');
  runSetActivationHelper({ cwd: dir, args: ['--disable', '--cwd', dir] });
  const r = runSetActivationHelper({ cwd: dir, args: ['--disable', '--cwd', dir] });
  assert.strictEqual(r.code, 0, '重复 disable 应幂等成功');
});

test('B1. 未知参数 → 非零退出 + usage', () => {
  const dir = makeTmpDir('b1-bad-arg');
  const r = runSetActivationHelper({ cwd: dir, args: ['--bogus'] });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stdout, /Usage|--enable|--disable|--status/);
});

// ============================================================
// CHG-B B2：/paceflow slash command（manifest + 命令文件结构）
// ============================================================

test('PAUSE-CLI-1. --pause 写 sessionId 键控标志；env 空 fail；--resume 删；--status 显示（CHG-20260611-03）', () => {
  const dir = makeTmpDir('pause-cli');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  const noSid = runSetActivationHelper({ cwd: dir, args: ['--pause', '--cwd', dir], env: { CLAUDE_CODE_SESSION_ID: '' } });
  assert.strictEqual(noSid.code, 2, 'env 空应 fail 不静默写无主标志：' + noSid.stdout);
  assert.match(noSid.stdout, /--session/, 'fail 文案应提示 --session 出口');
  const p = runSetActivationHelper({ cwd: dir, args: ['--pause', '--cwd', dir], env: { CLAUDE_CODE_SESSION_ID: 'sid-cli' } });
  assert.strictEqual(p.code, 0, p.stdout + p.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'paused-sid-cli')), 'pause 标志应写入 .pace/');
  assert.match(p.stdout, /artifact 仍只能经 artifact-writer/, 'pause 输出应说明完整性门保留');
  const s = runSetActivationHelper({ cwd: dir, args: ['--status', '--cwd', dir], env: { CLAUDE_CODE_SESSION_ID: 'sid-cli' } });
  assert.match(s.stdout, /session-paused: true/, 'status 应显示 paused：' + s.stdout);
  const r2 = runSetActivationHelper({ cwd: dir, args: ['--resume', '--cwd', dir], env: { CLAUDE_CODE_SESSION_ID: 'sid-cli' } });
  assert.strictEqual(r2.code, 0, r2.stdout + r2.stderr);
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'paused-sid-cli')), 'resume 应删标志');
});

test('PAUSE-CLI-2. --session <id> 显式传参可替代 env', () => {
  const dir = makeTmpDir('pause-cli-session-arg');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  const p = runSetActivationHelper({ cwd: dir, args: ['--pause', '--cwd', dir, '--session', 'sid-explicit'], env: { CLAUDE_CODE_SESSION_ID: '' } });
  assert.strictEqual(p.code, 0, p.stdout + p.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'paused-sid-explicit')));
});

function seedSessionPause(dir, sid) {
  const runtime = path.join(dir, '.pace');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, `paused-${sid}`), JSON.stringify({ sessionId: sid, timestampMs: Date.now() }) + '\n', 'utf8');
}

test('PAUSE-E2E-1. paused session 写码不被流程门拦（无活跃 CHG 也放行）', () => {
  const dir = makeV6Project('pause-code-skip', { indexMark: null, detail: false });
  seedSessionPause(dir, 'sid-paused');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-paused',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'hello.js'), content: 'console.log(1);\n' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), 'paused session 写码应放行：' + r.stdout);
});

test('PAUSE-E2E-2. paused session：Stop 不拦未完成 CHG，输出 paused 提醒', () => {
  const dir = makeV6Project('pause-stop-skip', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-paused', agentId: 'agent-x', state: 'active',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
  });
  seedSessionPause(dir, 'sid-paused');
  const r = runHook('stop.js', { cwd: dir, stdin: { session_id: 'sid-paused' } });
  assert.strictEqual(r.code, 0, 'paused 的 Stop 不应阻断：' + r.stderr);
  assert.ok(r.stdout.includes('/paceflow:resume'), '应有 paused 提醒：' + r.stdout);
});

test('PAUSE-E2E-3. paused 不免 artifact 完整性门：主 session 直接 Edit task.md 仍 deny', () => {
  const dir = makeV6Project('pause-artifact-gate-keep');
  seedSessionPause(dir, 'sid-paused');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-paused',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'task.md'), old_string: 'x', new_string: 'y' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'artifact 完整性门不受 pause 影响：' + r.stdout);
});

test('PAUSE-E2E-4. 隔离：A paused 不影响 B（B 写码照常被门拦）', () => {
  const dir = makeV6Project('pause-isolation', { indexMark: null, detail: false });
  seedSessionPause(dir, 'sid-a');
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-b',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'hello.js'), content: 'console.log(1);\n' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'B 不应被 A 的 pause 放行：' + r.stdout);
});

test('PAUSE-E2E-5. SessionEnd 清除本 session pause 标志', () => {
  const dir = makeV6Project('pause-session-end-clear');
  seedSessionPause(dir, 'sid-ending');
  seedSessionPause(dir, 'sid-other');
  const r = runHook('session-end.js', { cwd: dir, stdin: { session_id: 'sid-ending' } });
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.pace', 'paused-sid-ending')), '本 session 标志应清除');
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'paused-sid-other')), '他 session 标志保留');
});

test('PAUSE-E2E-6. 新 session startup 不清他人 pause 标志（不入 W4 前缀清理）', () => {
  const dir = makeV6Project('pause-startup-survive');
  seedSessionPause(dir, 'sid-other');
  const r = runHook('session-start.js', { cwd: dir, stdin: { session_id: 'sid-new', source: 'startup' }, args: ['--group', 'core'] });
  assert.strictEqual(r.code, 0);
  assert.ok(fs.existsSync(path.join(dir, '.pace', 'paused-sid-other')), '他 session 的 pause 标志不应被 startup 清除');
});

test('PAUSE-CMD-1. plugin.json 声明 pause/resume 命令 + 命令文件调对应子命令含防滥用约束（CHG-20260611-03）', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
  for (const f of ['./commands/pause.md', './commands/resume.md']) {
    assert.ok(manifest.commands.includes(f), `commands 应含 ${f}`);
  }
  const cmdDir = path.join(__dirname, '..', 'plugin', 'commands');
  const pause = fs.readFileSync(path.join(cmdDir, 'pause.md'), 'utf8');
  assert.match(pause, /set-activation\.js" --pause/, 'pause.md 应调 --pause');
  assert.match(pause, /不得为绕过|绕过单次 deny/, 'pause.md 应含防滥用约束（对称 disable §5.1 不变量 2）');
  assert.match(pause, /artifact-writer/, 'pause.md 应说明完整性门保留');
  const resume = fs.readFileSync(path.join(cmdDir, 'resume.md'), 'utf8');
  assert.match(resume, /set-activation\.js" --resume/, 'resume.md 应调 --resume');
  const status = fs.readFileSync(path.join(cmdDir, 'status.md'), 'utf8');
  assert.match(status, /paused|pause/, 'status.md 应提及 paused 状态');
});

test('B2. plugin.json 声明三个独立命令文件（HOTFIX-20260610-02 拆分）', () => {
  // 插件 command 一律 /<plugin>:<command> 命名空间形态（官方规则，无 alias 机制）；
  // 单文件 paceflow.md 会变成重复的 /paceflow:paceflow，拆三文件得到 /paceflow:enable|disable|status。
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.commands), 'plugin.json 应有 commands 数组');
  for (const f of ['./commands/enable.md', './commands/disable.md', './commands/status.md']) {
    assert.ok(manifest.commands.includes(f), `commands 应含 ${f}`);
  }
  assert.ok(!manifest.commands.includes('./commands/paceflow.md'), '旧单文件命令应已移除');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'plugin', 'commands', 'paceflow.md')), 'paceflow.md 文件应已删除');
});

test('B2. 三个命令文件各自引用 set-activation 对应子命令 + disable 含防滥用约束', () => {
  const cmdDir = path.join(__dirname, '..', 'plugin', 'commands');
  const enable = fs.readFileSync(path.join(cmdDir, 'enable.md'), 'utf8');
  assert.match(enable, /set-activation\.js" --enable/, 'enable.md 应调 --enable');
  assert.match(enable, /AskUserQuestion/, 'enable.md 应保留首次启用选 root 流程');
  const disable = fs.readFileSync(path.join(cmdDir, 'disable.md'), 'utf8');
  assert.match(disable, /set-activation\.js" --disable/, 'disable.md 应调 --disable');
  assert.match(disable, /不得为绕过|绕过单次 deny/, 'disable.md 应含防滥用约束（spec §5.1 不变量 2）');
  const status = fs.readFileSync(path.join(cmdDir, 'status.md'), 'utf8');
  assert.match(status, /set-activation\.js" --status/, 'status.md 应调 --status');
});

test('B2. 运行时文案不残留旧的 /paceflow <子命令> 空格形态（命令 404 防回归）', () => {
  // 旧形态 /paceflow enable 对用户是 404（实际命令是 /paceflow:enable）——发布面全部文案必须用冒号形态。
  const roots = ['hooks', 'skills', 'commands', 'agents', 'agent-references'];
  const bad = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|md)$/.test(entry.name)) continue;
      const content = fs.readFileSync(full, 'utf8');
      for (const m of content.matchAll(/\/paceflow (enable|disable|status|pause|resume)/g)) {
        bad.push(`${path.relative(path.join(__dirname, '..'), full)}: ${m[0]}`);
      }
    }
  }
  for (const r of roots) {
    const dir = path.join(__dirname, '..', 'plugin', r);
    if (fs.existsSync(dir)) walk(dir);
  }
  assert.deepStrictEqual(bad, [], '发布面残留旧命令形态: ' + bad.join('; '));
});

// ============================================================
// CHG-20260610-10：close-chg implementation-notes 必填字段（发布面定义）
// ============================================================

test('IN1. implementation-notes 字段定义在发布面（instruction + spec + guard 模板）', () => {
  // 字段与 verify-summary 对齐：instruction 输入字段必填、spec 轻量定义、deny 重派模板含该行。
  const root = path.join(__dirname, '..', 'plugin');
  const closeDoc = fs.readFileSync(path.join(root, 'agent-references', 'instructions', 'close-chg.md'), 'utf8');
  assert.match(closeDoc, /`implementation-notes`（必填/, 'close-chg.md 输入字段应定义 implementation-notes 为必填');
  assert.match(closeDoc, /implementation-notes:/, 'close-chg.md prompt 示例应含 implementation-notes 行');
  const spec = fs.readFileSync(path.join(root, 'agent-references', 'artifact-writer-spec.md'), 'utf8');
  assert.ok(spec.includes('implementation-notes'), 'artifact-writer-spec.md 应含 implementation-notes 字段定义');
  const guard = fs.readFileSync(path.join(root, 'hooks', 'pre-tool-use', 'agent-lifecycle-guard.js'), 'utf8');
  assert.ok(guard.includes("'implementation-notes:"), 'guard close-chg 重派模板应含 implementation-notes 行');
});

test('IN2. 发布面 4 bug 快修断言（CHG-20260611-07）', () => {
  const root = path.join(__dirname, '..', 'plugin');
  // A1：agent 契约 close-chg 必填清单含 implementation-notes（v6.6.2 同步遗漏）
  const agentDoc = fs.readFileSync(path.join(root, 'agents', 'artifact-writer.md'), 'utf8');
  assert.ok(agentDoc.includes('implementation-notes'), 'agent 契约应含 implementation-notes 必填字段');
  // A2：archive-chg walkthrough wikilink 规则同步全名+转义（防死链）
  const archiveDoc = fs.readFileSync(path.join(root, 'agent-references', 'instructions', 'archive-chg.md'), 'utf8');
  assert.ok(archiveDoc.includes('\\|'), 'archive-chg 应含表格内 \\| 转义规则');
  assert.ok(/纯ID|纯 ID/.test(archiveDoc), 'archive-chg 应含全名+纯ID别名规则');
  // A3：correction 模板含触发引用段（对齐 record-correction 六段结构）
  const correctionTpl = fs.readFileSync(path.join(root, 'skills', 'artifact-management', 'templates', 'correction-detail.md'), 'utf8');
  assert.ok(correctionTpl.includes('## 触发引用'), 'correction 模板应含 ## 触发引用 段');
  // B1：commands 不引用发布面不存在的 spec §5.1
  for (const f of ['disable.md', 'pause.md']) {
    const cmd = fs.readFileSync(path.join(root, 'commands', f), 'utf8');
    assert.ok(!cmd.includes('§5.1'), `${f} 不应引用发布面不存在的 spec §5.1`);
  }
});

test('SOFT-2. manifest 软信号项目注入提问层且文案为 Skill 调用指令（CHG-20260611-05）', () => {
  // cc-wechat 野外盲区端到端复刻：src/ 布局 + package.json → 提问层注入；
  // 文案是 AI 行为指令（Skill 调用）而非「引导用户手打命令」（多一轮往返）。
  const dir = makeTmpDir('soft-manifest-inject');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), '// code in src\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n', 'utf8');
  const r = runHook('session-start.js', { cwd: dir, stdin: { session_id: 'sid-soft', source: 'startup' }, args: ['--group', 'core'] });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /PACEflow 启用询问/, 'manifest 软信号应注入提问层');
  assert.match(r.stdout, /Skill\(paceflow:enable\)/, '「启用」选项应为 Skill 调用指令');
  assert.match(r.stdout, /Skill\(paceflow:disable\)/, '「暂不」选项应为 Skill 调用指令');
});

// ============================================================
// CHG-20260611-02：SessionEnd 降级 detached + 心跳 revive
// ============================================================

test('SE-1. SessionEnd 把本 session 活跃 owner 降级 detached（CHG-20260611-02）', () => {
  const dir = makeV6Project('session-end-detach');
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-ending', agentId: 'agent-x', state: 'active',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
  });
  const r = runHook('session-end.js', { cwd: dir, stdin: { session_id: 'sid-ending' } });
  assert.strictEqual(r.code, 0);
  const owner = JSON.parse(fs.readFileSync(path.join(dir, '.pace', 'change-owners', 'chg-20260504-01.json'), 'utf8'));
  assert.strictEqual(owner.state, 'detached');
});

test('SE-2. SessionEnd 不动 closed 与他 session 记录', () => {
  const dir = makeV6Project('session-end-detach-scope');
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-ending', agentId: 'agent-x', state: 'closed',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
  });
  fs.writeFileSync(path.join(dir, '.pace', 'change-owners', 'chg-20260504-02.json'), JSON.stringify({
    version: 'change-owner-v1', changeId: 'CHG-20260504-02', sessionId: 'sid-other',
    state: 'active', cwd: dir, stateDir: dir, worktree: 'main', branch: 'main', timestampMs: Date.now(),
  }, null, 2) + '\n', 'utf8');
  const r = runHook('session-end.js', { cwd: dir, stdin: { session_id: 'sid-ending' } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.pace', 'change-owners', 'chg-20260504-01.json'), 'utf8')).state, 'closed');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.pace', 'change-owners', 'chg-20260504-02.json'), 'utf8')).state, 'active');
});

test('SE-3. 心跳 revive：detached + 同 session 工具活动 → 升回 active', () => {
  const dir = makeV6Project('session-end-revive', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-resumed', agentId: 'agent-x', state: 'detached',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-resumed',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'hello.js'), content: 'console.log(1);\n' },
    },
  });
  assert.strictEqual(r.code, 0);
  const owner = JSON.parse(fs.readFileSync(path.join(dir, '.pace', 'change-owners', 'chg-20260504-01.json'), 'utf8'));
  assert.strictEqual(owner.state, 'active', '同 session 心跳应把 detached 升回 active：' + r.stdout);
});

test('SIB-STOP-1. sibling-fresh：B 的 Stop 跳过硬约束并软提醒（CHG-20260611-02）', () => {
  const dir = makeV6Project('stop-sibling-fresh', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-a', agentId: 'agent-a', state: 'active',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
  });
  const r = runHook('stop.js', { cwd: dir, stdin: { session_id: 'sid-b' } });
  assert.strictEqual(r.code, 0, 'sibling-fresh 不应阻断 B 的 Stop：' + r.stderr);
  assert.ok(r.stdout.includes('同目录另一 session 执行中'), '应有 sibling 软提醒：' + r.stdout);
  assert.ok(r.stdout.includes('不受其完成约束'), r.stdout);
});

test('SIB-STOP-2. sibling-detached：软提醒含 AskUserQuestion 接手指引与 takeover 字段', () => {
  const dir = makeV6Project('stop-sibling-detached', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-a', agentId: 'agent-a', state: 'detached',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
  });
  const r = runHook('stop.js', { cwd: dir, stdin: { session_id: 'sid-b' } });
  assert.strictEqual(r.code, 0, 'sibling-detached 不应阻断：' + r.stderr);
  assert.ok(r.stdout.includes('正常关闭'), r.stdout);
  assert.ok(r.stdout.includes('AskUserQuestion'), r.stdout);
  assert.ok(r.stdout.includes('owner-takeover-confirmed'), r.stdout);
});

test('SIB-STOP-3. sibling-stale 给失联接手指引；同 session 硬约束不回归', () => {
  const dir = makeV6Project('stop-sibling-stale', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-a', agentId: 'agent-a', state: 'active',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
    timestampMs: Date.now() - 2 * 60 * 60 * 1000,
  });
  const r = runHook('stop.js', { cwd: dir, stdin: { session_id: 'sid-b' } });
  assert.strictEqual(r.code, 0, 'sibling-stale 不应阻断：' + r.stderr);
  assert.ok(r.stdout.includes('失联'), r.stdout);
  // 同 session（owner 本人）仍被未完成 CHG 硬约束阻断（软化只对 sibling）
  const own = runHook('stop.js', { cwd: dir, stdin: { session_id: 'sid-a' } });
  assert.strictEqual(own.code, 2, '同 session 的未完成 CHG 仍应阻断：' + own.stdout);
});

test('SIB-PTU-1. sibling-fresh 的 CHG：artifact-writer 派遣 deny 不可静默接手（CHG-20260611-02）', () => {
  const dir = makeV6Project('ptu-sibling-fresh-takeover-deny', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-a', agentId: 'agent-a', state: 'active',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-b',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Update CHG',
        prompt: [
          `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
          'operation: update-chg',
          'target: CHG-20260504-01',
          'section: work-record',
          'action: append',
          'content: 接手记录',
        ].join('\n'),
      },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'sibling-fresh 不可静默接手：' + r.stdout);
  assert.ok(r.stdout.includes('同目录另一'), r.stdout);
  assert.ok(r.stdout.includes('owner-takeover-confirmed'), 'deny 文案应给显式接手出口：' + r.stdout);
});

test('SIB-PTU-2. sibling-detached：缺 takeover 三字段 deny，带齐放行', () => {
  const dir = makeV6Project('ptu-sibling-detached-takeover', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-a', agentId: 'agent-a', state: 'detached',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
  });
  const basePrompt = [
    `artifact_dir: ${dir.replace(/\\/g, '/')}/`,
    'operation: update-chg',
    'target: CHG-20260504-01',
    'section: work-record',
    'action: append',
    'content: 接手继续执行',
  ];
  const denied = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-b',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'Update CHG', prompt: basePrompt.join('\n') },
    },
  });
  assert.ok(denied.stdout.includes('"deny"'), '缺 takeover 字段应 deny：' + denied.stdout);
  assert.ok(denied.stdout.includes('owner-takeover-confirmed'), denied.stdout);
  const allowed = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-b',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'paceflow:artifact-writer',
        description: 'Update CHG',
        prompt: basePrompt.concat([
          'owner-takeover-confirmed: true',
          'owner-takeover-source: user-directive',
          'owner-takeover-evidence: 用户说「继续上次的 CHG」',
        ]).join('\n'),
      },
    },
  });
  assert.ok(!allowed.stdout.includes('"deny"'), '带齐 takeover 字段应放行：' + allowed.stdout);
});

test('SIB-PTU-3. B 写代码不搭 sibling CHG 便车：仅 sibling 活跃 CHG 时写码 deny 含接手指引', () => {
  const dir = makeV6Project('ptu-sibling-code-no-freeride', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-a', agentId: 'agent-a', state: 'active',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-b',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'hello.js'), content: 'console.log(1);\n' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'B 写码不应搭 sibling CHG 便车：' + r.stdout);
  assert.ok(r.stdout.includes('同目录其他 session 持有'), r.stdout);
  assert.ok(r.stdout.includes('owner-takeover'), r.stdout);
  assert.ok(r.stdout.includes('create-chg'), r.stdout);
  // CHG-20260611-04：sibling 持有提示给第三出口（session 级 pause）
  assert.ok(r.stdout.includes('/paceflow:pause'), 'sibling deny 应含 pause 第三出口：' + r.stdout);
});

test('SIB-PTU-4. foreign worktree 写码搭便车现状不回归（isCodeFile 仍放行 foreign CHG）', () => {
  const dir = makeV6Project('ptu-foreign-code-freeride-keep', {
    indexMark: '[/]',
    detail: chgDetail({ status: 'in-progress', task: '[/]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-a', agentId: 'agent-a', state: 'active',
    cwd: path.join(dir, 'other-checkout'), stateDir: path.join(dir, 'other-checkout'),
    worktree: 'worktree-a', branch: 'branch-a',
  });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: {
      session_id: 'sid-b',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'hello.js'), content: 'console.log(1);\n' },
    },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), 'foreign 写码搭便车是既有现状，本 CHG 不动：' + r.stdout);
});

test('SIB-POST-1. sibling-fresh 的 CHG 催办（verify-missing 等）跳过；sibling-stale 不跳过（CHG-20260611-02）', () => {
  const dir = makeV6Project('post-sibling-nag-skip', {
    indexMark: '[x]',
    detail: chgDetail({ status: 'completed', task: '[x]', approved: true }),
  });
  seedChangeOwner(dir, 'CHG-20260504-01', {
    sessionId: 'sid-a', agentId: 'agent-a', state: 'active',
    cwd: dir, stateDir: dir, worktree: 'main', branch: 'main',
  });
  fs.writeFileSync(path.join(dir, 'hello.js'), 'console.log(1);\n', 'utf8');
  const stdinBase = {
    session_id: 'sid-b',
    tool_name: 'Write',
    tool_input: { file_path: path.join(dir, 'hello.js'), content: 'console.log(1);\n' },
  };
  const fresh = runHook('post-tool-use.js', { cwd: dir, stdin: stdinBase });
  assert.ok(!fresh.stdout.includes('已 completed 但缺少'), 'sibling-fresh 的催办应跳过：' + fresh.stdout);
  // owner 老化为 stale → 催办恢复（B 是潜在接手者，提醒有意义）
  const ownerPath = path.join(dir, '.pace', 'change-owners', 'chg-20260504-01.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  owner.timestampMs = Date.now() - 2 * 60 * 60 * 1000;
  fs.writeFileSync(ownerPath, JSON.stringify(owner, null, 2) + '\n', 'utf8');
  const stale = runHook('post-tool-use.js', { cwd: dir, stdin: stdinBase });
  assert.ok(stale.stdout.includes('已 completed 但缺少'), 'sibling-stale 的催办不应跳过：' + stale.stdout);
});

// ============================================================
// CHG-B B3：disable 无条件可达（spec §5.1 不变量 1，回归锁定）
// ============================================================

test('B1. 继承子目录：disable/enable 归一宿主 .pace（写宿主读宿主，无 split-brain）', () => {
  // 用户场景：cwd 是父 PACEflow 项目的普通子目录（如本仓库 paceflow/ 之于 paceflow-hooks/）。
  // disable 粒度 = 停用整个 Project Root（spec §5.1），标记必须落宿主、双视角一致。
  const root = makeTmpDir('b1-inherit-host');
  const child = path.join(root, 'packages', 'api');
  fs.mkdirSync(path.join(root, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pace', '.gitignore'), '*\n', 'utf8');
  fs.mkdirSync(path.join(root, 'changes'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  const r = runSetActivationHelper({ cwd: child, args: ['--disable', '--cwd', child] });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(root, '.pace', 'disabled')), 'disabled 应落宿主 .pace/');
  assert.ok(!fs.existsSync(path.join(child, '.pace', 'disabled')), 'disabled 不应落子目录');
  delete require.cache[require.resolve('../plugin/hooks/pace-utils')];
  let pu = require('../plugin/hooks/pace-utils');
  assert.strictEqual(pu.isPaceProject(child), false, 'child 视角应已禁用');
  assert.strictEqual(pu.isPaceProject(root), false, '宿主视角应已禁用（同一 Project Root）');
  const r2 = runSetActivationHelper({ cwd: child, args: ['--enable', '--cwd', child] });
  assert.strictEqual(r2.code, 0, r2.stdout + r2.stderr);
  assert.ok(!fs.existsSync(path.join(root, '.pace', 'disabled')), 'enable 应清宿主标记');
  delete require.cache[require.resolve('../plugin/hooks/pace-utils')];
  pu = require('../plugin/hooks/pace-utils');
  assert.strictEqual(pu.isPaceProject(root), 'artifact', '宿主既有 changes/ 自动恢复');
  assert.match(r2.stdout, /恢复/, '有 changes/ 的恢复应报恢复文案');
});

test('B1. 独立子项目：disable 只停用子项目，父项目不受影响', () => {
  const root = makeTmpDir('b1-indep-host');
  const child = path.join(root, 'tool');
  fs.mkdirSync(path.join(root, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pace', '.gitignore'), '*\n', 'utf8');
  fs.mkdirSync(path.join(root, 'changes'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  const decl = runSetProjectRootHelper({ cwd: child, args: ['--mode', 'independent', '--cwd', child] });
  assert.strictEqual(decl.code, 0, decl.stdout + decl.stderr);
  const r = runSetActivationHelper({ cwd: child, args: ['--disable', '--cwd', child] });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(child, '.pace', 'disabled')), '独立子项目 disabled 应落子项目自身 .pace/');
  assert.ok(!fs.existsSync(path.join(root, '.pace', 'disabled')), '父项目不应被写 disabled');
  delete require.cache[require.resolve('../plugin/hooks/pace-utils')];
  const pu = require('../plugin/hooks/pace-utils');
  assert.strictEqual(pu.isPaceProject(child), false, '子项目已禁用');
  assert.strictEqual(pu.isPaceProject(root), 'artifact', '父项目不受影响');
});

test('B1. worktree：disable 归一宿主 .pace（worktree 与宿主共享激活态）', () => {
  const host = makeTmpDir('b1-wt-host');
  const worktree = makeTmpDir('b1-wt-tree');
  fs.mkdirSync(path.join(host, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.mkdirSync(path.join(host, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(host, '.pace', '.gitignore'), '*\n', 'utf8');
  fs.mkdirSync(path.join(host, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(host, '.git', 'worktrees', 'wt')}\n`, 'utf8');
  const r = runSetActivationHelper({ cwd: worktree, args: ['--disable', '--cwd', worktree] });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(host, '.pace', 'disabled')), 'disabled 应落宿主 .pace/');
  assert.ok(!fs.existsSync(path.join(worktree, '.pace', 'disabled')), 'disabled 不应落 worktree');
  delete require.cache[require.resolve('../plugin/hooks/pace-utils')];
  const pu = require('../plugin/hooks/pace-utils');
  assert.strictEqual(pu.isPaceProject(worktree), false, 'worktree 视角已禁用');
  assert.strictEqual(pu.isPaceProject(host), false, '宿主视角已禁用（共享激活态）');
  const r2 = runSetActivationHelper({ cwd: worktree, args: ['--enable', '--cwd', worktree] });
  assert.strictEqual(r2.code, 0, r2.stdout + r2.stderr);
  delete require.cache[require.resolve('../plugin/hooks/pace-utils')];
  assert.strictEqual(require('../plugin/hooks/pace-utils').isPaceProject(host), 'artifact', 'worktree 侧 enable 恢复宿主');
});

// ============================================================
// CHG-C C1：SessionStart 软信号提问层（指示 AI AskUserQuestion 询问启用）
// ============================================================

test('C1. code-count 项目 SessionStart core 注入提问指示', () => {
  const dir = makeTmpDir('c1-prompt-inject');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a');
  fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
  fs.writeFileSync(path.join(dir, 'c.py'), '# c');
  const r = runHook('session-start.js', { cwd: dir, args: ['--group', 'core'], env: { PACE_VAULT_PATH: '' }, stdin: { type: 'startup' } });
  assert.match(r.stdout, /AskUserQuestion/, '应指示 AI 用 AskUserQuestion');
  assert.match(r.stdout, /\/paceflow:enable/, '应指向 /paceflow:enable（插件命令的真实可用形态）');
  // spec §7：讲价值不讲机制——不暴露「N 个代码文件」触发细节（dated-plan 触发时无代码文件，写了自相矛盾）。
  assert.doesNotMatch(r.stdout, /\d+\s*个代码文件/, '不应暴露 code-count 机制细节');
});

test('C1. 有 .pace/disabled 的 code-count 项目 → 不注入提问指示', () => {
  const dir = makeTmpDir('c1-disabled-no-prompt');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a');
  fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
  fs.writeFileSync(path.join(dir, 'c.py'), '# c');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'disabled'), '');
  const r = runHook('session-start.js', { cwd: dir, args: ['--group', 'core'], env: { PACE_VAULT_PATH: '' }, stdin: { type: 'startup' } });
  assert.doesNotMatch(r.stdout, /PACEflow 启用询问/, 'disabled 项目不应注入提问指示');
});

test('C1. 已激活（changes/）项目 → 不注入软信号提问指示', () => {
  const dir = makeTmpDir('c1-active-no-prompt');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.js'), '// a');
  fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
  fs.writeFileSync(path.join(dir, 'c.py'), '# c');
  const r = runHook('session-start.js', { cwd: dir, args: ['--group', 'core'], stdin: { type: 'startup' } });
  assert.doesNotMatch(r.stdout, /PACEflow 启用询问/, '已激活项目不出软信号提问');
});

test('B3. 已激活+无活跃任务项目 Bash 跑 set-activation --disable 不被 pre-tool-use 拦', () => {
  // 回归锁定：bash-guard mutation gate 保护 artifact + .pace/{locks,sequences,...} 但不含 .pace/disabled，
  // isArtifactRuntimeControlPath 清单亦不含 disabled——未来改 bash-guard 不得误伤这条逃生路（P0 复发）。
  const dir = makeTmpDir('b3-disable-unconditional');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true }); // artifact 强信号
  fs.writeFileSync(path.join(dir, 'task.md'), '# 任务\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n'); // 无活跃任务
  const cmd = `node "${SET_ACTIVATION_HELPER}" --disable --cwd "${dir}"`;
  const r = runHookDetailed('pre-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'Bash', tool_input: { command: cmd } },
  });
  assert.ok(!r.stdout.includes('"permissionDecision":"deny"'),
    'disable 命令不应被 pre-tool-use 拦（逃生口完整性，spec §5.1 不变量 1）：' + r.stdout);
});

// ============================================================
// CHG-D D1：所有 PACE deny 文案末尾追加 /paceflow disable 逃生口
// ============================================================

test('D1. 无活跃任务 deny 文案含 /paceflow disable 逃生口（指向用户决策）', () => {
  const dir = makeTmpDir('d1-deny-escape');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true }); // artifact 强信号
  fs.writeFileSync(path.join(dir, 'task.md'), '# 任务\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n'); // 无活跃任务
  const r = runHookDetailed('pre-tool-use.js', {
    cwd: dir,
    stdin: { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'feature.js'), content: '// x' } },
    env: { PACE_VAULT_PATH: '' },
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (e) {}
  assert.ok(parsed && parsed.hookSpecificOutput, 'deny 应产出 hookSpecificOutput: ' + r.stdout);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny', '应为 deny');
  const reason = parsed.hookSpecificOutput.permissionDecisionReason || '';
  assert.match(reason, /\/paceflow:disable/, 'deny 文案应含逃生口 /paceflow:disable');
  assert.match(reason, /若你（用户）不需要/, '逃生口应指向用户决策（spec §5.1 不变量 2）');
  // CHG-20260611-04：双出口——session 级 pause 与项目级 disable 并列
  assert.match(reason, /\/paceflow:pause/, 'deny 文案应含 session 级出口 /paceflow:pause');
  assert.strictEqual((reason.match(/若你（用户）不需要/g) || []).length, 1, '逃生口不应重复追加（幂等）');
});

test('D1. hardDeny 路径（teammate 删 artifact）同样带逃生口', () => {
  const dir = makeTmpDir('d1-harddeny-escape');
  fs.mkdirSync(path.join(dir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), '# 任务\n\n## 活跃任务\n\n<!-- ARCHIVE -->\n');
  const r = runHookDetailed('pre-tool-use.js', {
    cwd: dir,
    env: { CLAUDE_CODE_TEAM_NAME: 'exec-team' },
    stdin: { tool_name: 'Bash', tool_input: { command: 'rm task.md' } },
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (e) {}
  assert.ok(parsed && parsed.hookSpecificOutput, 'hardDeny 应产出 hookSpecificOutput: ' + r.stdout);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason || '', /\/paceflow:disable/, 'hardDeny 文案也应含逃生口');
});

// ============================================================
// V7E: 未迁移布局检测与提示（CHG-20260611-12 T-002）
// ============================================================
console.log('\n--- V7F: schema 前向兼容 guard（newer-data 软化）---');

// 8.0 帧 fixture：planned 未批准——7.0 下写码本该被 C 门 deny，正是「让位」的判别场景
const futureDetail = [
  '---', 'status: planned', 'date: 2026-07-01', 'change-set: null', 'change-set-seq: null',
  'verified-date: null', 'reviewed-date: null', 'archived-date: null', 'parent-tasks: "[[t]]"',
  'schema-version: "8.0"', '---', '', '## 任务清单', '', '- [ ] T-001 future', '',
].join('\n');

test('V7F-3. 8.0 帧项目写码 → 流程门让位（放行 + 升级提示），7.0 同形态仍 deny', () => {
  const dir = makeV6Project('v7f-newer-soften', { indexMark: '[ ]', implIndex: '', detail: futureDetail });
  const r = runHook('pre-tool-use.js', { cwd: dir, stdin: codeEditStdin(dir), env: { PACE_VAULT_PATH: '' } });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('"deny"'), '8.0 数据下流程门必须让位');
  assert.ok(r.stdout.includes('高于当前插件支持的 7.0'), '应注入升级提示');
  assert.ok(r.stdout.includes('reload 全部 session'), '提示应含 reload 指引');
  // 对照：同形态 7.0 帧（planned 未批准）写码仍走 C 门 deny——guard 不污染既有行为
  const ctl = makeV6Project('v7f-control-70', { indexMark: '[ ]', implIndex: '', detail: futureDetail.replace('schema-version: "8.0"', 'schema-version: "7.0"') });
  const rc = runHook('pre-tool-use.js', { cwd: ctl, stdin: codeEditStdin(ctl), env: { PACE_VAULT_PATH: '' } });
  assert.ok(rc.stdout.includes('"deny"'), '7.0 帧同形态仍被既有流程门拦截');
});

test('V7F-4. 8.0 帧项目 Stop → 让位（exit 0 + systemMessage 升级提示）', () => {
  const dir = makeV6Project('v7f-newer-stop', { indexMark: '[/]', implIndex: '', detail: futureDetail.replace('status: planned', 'status: in-progress') });
  const r = runHook('stop.js', { cwd: dir, stdin: { stop_hook_active: false }, env: { PACE_VAULT_PATH: '' } });
  assert.strictEqual(r.code, 0, '8.0 数据下 Stop 不阻断');
  assert.ok(r.stdout.includes('高于当前插件支持的 7.0'), 'systemMessage 应含升级提示');
});

test('V7F-5. 8.0 帧项目主 session 直写 task.md → 写保护不软化（仍 deny）', () => {
  const dir = makeV6Project('v7f-newer-protect', { indexMark: '[ ]', implIndex: '', detail: futureDetail });
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-v7f', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'task.md'), old_string: 'a', new_string: 'b' } },
    env: { PACE_VAULT_PATH: '' },
  });
  assert.ok(r.stdout.includes('"deny"'), 'artifact 写保护语义与 schema 版本无关，不让位');
});

test('V7F-6. 8.0 帧项目 SessionStart core → 注入插件升级提示段', () => {
  const dir = makeV6Project('v7f-newer-sessionstart', { indexMark: '[ ]', implIndex: '', detail: futureDetail });
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' }, env: { PACE_VAULT_PATH: '' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('插件升级提示'), '应注入升级提示段');
  assert.ok(r.stdout.includes('高于当前插件支持的 7.0'));
});

test('V7F-7. 8.0 帧项目派 artifact-writer → deny 升级提示（不走 7.0 lifecycle 裁判，codex P2）', () => {
  const dir = makeV6Project('v7f-newer-agent', { indexMark: '[/]', implIndex: '', detail: futureDetail.replace('status: planned', 'status: in-progress') });
  // 不完整 close-chg prompt（缺 verification-confirmed 等）——7.0 下走 lifecycle deny「缺少必填字段」
  const prompt = `artifact_dir: ${dir.replace(/\\/g, '/')}/\noperation: close-chg\ntarget: CHG-20260504-01`;
  const r = runHook('pre-tool-use.js', {
    cwd: dir,
    stdin: { session_id: 'sid-v7f-agent', tool_name: 'Agent', tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'close', prompt } },
    env: { PACE_VAULT_PATH: '' },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('"deny"'), 'P2: 8.0 artifact-writer 派遣应 deny（7.x writer 会用 7.0 逻辑写坏新数据，与 V7F-5 写保护一致）');
  assert.ok(r.stdout.includes('高于当前插件支持的 7.0'), 'P2: deny 文案应是升级提示');
  assert.ok(!r.stdout.includes('缺少必填字段'), 'P2: 不走 7.0 lifecycle 校验裁判新数据');
});

console.log('\n--- V7E: 未迁移布局提示 ---');

test('V7E-9. impl_plan 含活跃 CHG 索引行 → SessionStart 注入 migrate-v7 完整命令', () => {
  const dir = makeV6Project('v7e-unmigrated');  // 默认 impl_plan 含活跃索引行（v6 双索引布局）
  const r = runHook('session-start.js', { cwd: dir, stdin: { type: 'startup' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('migrate-v7.js'), '应注入 migrate-v7 命令');
  assert.ok(r.stdout.includes('--dry-run'), '命令应含 --dry-run 预览引导');
});

test('V7E-10. impl_plan 是 tombstone 或不存在 → 无迁移提示', () => {
  const tombstone = makeV6Project('v7e-tombstone-layout', { implIndex: '' });
  const r1 = runHook('session-start.js', { cwd: tombstone, stdin: { type: 'startup' } });
  assert.ok(!r1.stdout.includes('migrate-v7.js'), 'impl_plan 活跃区无索引行 → 不提示');

  const noImpl = makeV6Project('v7e-no-impl');
  fs.rmSync(path.join(noImpl, 'implementation_plan.md'));
  const r2 = runHook('session-start.js', { cwd: noImpl, stdin: { type: 'startup' } });
  assert.ok(!r2.stdout.includes('migrate-v7.js'), 'impl_plan 不存在 → 不提示');
});

test('V7E-11. 未迁移布局下 artifact 写盘 → PostToolUse 催办一次（flag 防重复）', () => {
  const dir = makeV6Project('v7e-ptu-remind');
  const fp = path.join(dir, 'changes', 'chg-20260504-01.md');
  const stdin = { tool_name: 'Edit', tool_input: { file_path: fp, old_string: 'a', new_string: 'b' } };
  const r1 = runHook('post-tool-use.js', { cwd: dir, stdin });
  assert.strictEqual(r1.code, 0);
  assert.ok(r1.stdout.includes('migrate-v7.js'), '首次写盘应催办迁移');
  const r2 = runHook('post-tool-use.js', { cwd: dir, stdin });
  assert.ok(!r2.stdout.includes('migrate-v7.js'), '同 session 第二次不重复催办（flag 去重）');
});

// ============================================================================
// \u9ec4\u91d1\u57fa\u7ebf\u9501\uff08CHG-20260614-13 T-001\uff09\uff1adeny \u51fa\u53e3\u5168\u6587 characterization \u5feb\u7167
// ----------------------------------------------------------------------------
// \u76ee\u7684\uff1aemitDeny \u91cd\u6784\u524d\u56fa\u5316\u6bcf\u4e2a deny \u51fa\u53e3\u7684 permissionDecisionReason \u5168\u6587 + decision
//   \u7c7b\u578b\uff08deny / context \u8f6f\u5316 / other\uff09\uff0c\u91cd\u6784\u540e\u9010\u5b57 match\u3002
// \u9632\u81ea\u6307\uff08\u8bb0\u5fc6 equivalence-lock-verify-against-original\uff09\uff1a\u672c\u5feb\u7167\u5bf9\u3010\u5f53\u524d\u672a\u91cd\u6784 HEAD\u3011
//   \u751f\u6210\uff08UPDATE_GOLDEN=1\uff09\uff0c\u662f characterization\u2014\u2014\u5bf9\u539f\u7248\u5373\u7eff\uff1bemitDeny \u82e5\u6539\u4e86\u4efb\u4f55 deny
//   \u6587\u6848/\u5bcc\u5316/teammate \u5206\u652f\uff0c\u672c\u6d4b\u8bd5\u7acb\u5373\u7ea2\u3002
// \u8def\u5f84\u5f52\u4e00\uff1afixture tmp / vault / repo \u8def\u5f84\u66ff\u6362\u4e3a <DIR>/<VAULT>/<HOOKS>/<REPO>\uff0c\u4fdd\u5feb\u7167\u7a33\u5b9a\u3002
// \u66f4\u65b0\u57fa\u7ebf\uff1aUPDATE_GOLDEN=1 node tests/test-hooks-e2e.js\uff08\u4ec5\u5728\u3010\u6545\u610f\u3011\u6539 deny \u884c\u4e3a\u65f6\u8dd1\uff09\u3002
console.log('\n--- GOLDEN: deny \u51fa\u53e3\u5168\u6587\u57fa\u7ebf\u9501\uff08CHG-20260614-13\uff09---');

const GOLDEN_SNAPSHOT_PATH = path.join(__dirname, 'golden', 'deny-outlets.snapshot.json');
const GOLDEN_UPDATE = process.env.UPDATE_GOLDEN === '1';
const GOLDEN_REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_TEAM_ENV = { CLAUDE_CODE_TEAM_NAME: 'golden-exec-team' };

// \u5f52\u4e00\u6240\u6709\u6613\u53d8\u5185\u5bb9\uff0c\u4fdd\u5feb\u7167\u8de8\u673a/\u8de8\u6b21/\u8de8\u5929\u7a33\u5b9a\u3002\u957f\u4e32\u5148\u4e8e\u77ed\u4e32\u66ff\u6362\uff08HOOKS_DIR \u5728 REPO_ROOT \u4e0b\uff09\u3002
// today() \u5f52\u4e00\u9632 native-plan \u6587\u6848\u91cc\u7684\u8ba1\u5212\u6587\u4ef6\u65e5\u671f\uff08${today()}-feature.md\uff09\u6b21\u65e5\u6f02\u79fb\u3002
function goldenNormalize(text, dir) {
  let s = String(text);
  // TH-1a（v7.2.21 审计）：每个路径 token 同时替换 OS 原生形态与正斜杠形态——hook 输出经
  // normalizePath 多为正斜杠，Windows 本机这些 token 含反斜杠，单形态 split 漏替换致 21 个 GOLDEN 快照漂移。
  // POSIX 下 token 无反斜杠（fwd===token）跳过第二次替换，行为与原单形态完全幂等。
  const subPath = (token, placeholder) => {
    if (!token) return;
    s = s.split(token).join(placeholder);
    const fwd = token.replace(/\\/g, '/');
    if (fwd !== token) s = s.split(fwd).join(placeholder);
  };
  subPath(dir, '<DIR>');
  subPath(_vaultTmpDir, '<VAULT>');
  subPath(HOOKS_DIR, '<HOOKS>');
  subPath(GOLDEN_REPO_ROOT, '<REPO>');
  s = s.split(today()).join('<TODAY>');
  s = s.split(today().replace(/-/g, '')).join('<TODAYC>'); // reserved-id 紧凑日期 CHG-YYYYMMDD-NN
  return s;
}

// TH-1a 针对性单测：在 POSIX 也能判别双形态归一是否生效（喂 Windows 反斜杠 dir + 正斜杠文本）。
test('TH-1a: goldenNormalize 路径 token 反斜杠+正斜杠双形态归一（Windows GOLDEN 快照可移植）', () => {
  const winDir = 'C:\\Users\\me\\proj';                                  // 模拟 Windows OS 原生反斜杠路径
  const out = goldenNormalize('target is C:/Users/me/proj/changes/a.md done', winDir); // hook 文本是正斜杠形态
  assert.ok(out.includes('<DIR>'), 'TH-1a: 正斜杠形态路径应归一为 <DIR>：' + out);
  assert.ok(!out.includes('C:/Users/me/proj'), 'TH-1a: 不应残留正斜杠真实路径：' + out);
});

// \u9a71\u52a8\u771f hook\uff0c\u5f52\u4e00\u540e\u62bd\u51fa {decision, text}\u3002deny\u2192permissionDecisionReason\uff1b\u8f6f\u5316\u2192additionalContext\u3002
function goldenCapture({ cwd, stdin, env = {}, normDir }) {
  const r = runHook('pre-tool-use.js', { cwd, stdin, env });
  let out;
  try { out = JSON.parse(r.stdout); } catch(e) { return { decision: 'PARSE_ERROR', text: goldenNormalize(r.stdout, normDir || cwd) }; }
  const hso = (out && out.hookSpecificOutput) || {};
  if (hso.permissionDecision === 'deny') return { decision: 'deny', text: goldenNormalize(hso.permissionDecisionReason, normDir || cwd) };
  if (typeof hso.additionalContext === 'string') return { decision: 'context', text: goldenNormalize(hso.additionalContext, normDir || cwd) };
  return { decision: 'other', text: goldenNormalize(JSON.stringify(out), normDir || cwd) };
}

// native-plan \u6865\u63a5\u95e8 fixture\uff08\u4eff 9ab7\uff1amanual \u5f3a\u4fe1\u53f7 + artifact-root \u5df2\u914d + current-native-plan\uff09\u3002
function goldenNativePlanDir(label) {
  const dir = makeTmpDir(label);
  fs.writeFileSync(path.join(dir, '.pace-enabled'), '');
  fs.mkdirSync(path.join(dir, '.pace'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pace', 'artifact-root'), 'local\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  const planFile = path.join(dir, 'docs', 'plans', `${today()}-feature.md`);
  fs.writeFileSync(planFile, '# Plan\n');
  fs.writeFileSync(path.join(dir, '.pace', 'current-native-plan'), planFile, 'utf8');
  return dir;
}

// \u6bcf\u4e2a label \u552f\u4e00 \u2192 \u6784\u9020 fixture + \u8fd4\u56de capture \u7ed3\u679c\u3002label \u547d\u540d\uff1a<\u7ec4>_<\u51fa\u53e3>__<\u53d8\u4f53>\u3002
// Phase 1\uff1a\u6d41\u7a0b\u95e8\u7ec4\uff08denyOrHint 7 \u51fa\u53e3 \u00d7 main/teammate\uff09\u3002
const GOLDEN_CASES = {
  'FLOW_NO_ACTIVE__main': () => { const d = makeV6Project('golden-no-active', { withIndex: false, detail: false }); return goldenCapture({ cwd: d, stdin: codeEditStdin(d) }); },
  'FLOW_NO_ACTIVE__teammate': () => { const d = makeV6Project('golden-no-active-tm', { withIndex: false, detail: false }); return goldenCapture({ cwd: d, stdin: codeEditStdin(d), env: GOLDEN_TEAM_ENV }); },

  'FLOW_C_PHASE__main': () => { const d = makeV6Project('golden-c-phase', { indexMark: '[ ]', detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }) }); return goldenCapture({ cwd: d, stdin: codeEditStdin(d) }); },
  'FLOW_C_PHASE__teammate': () => { const d = makeV6Project('golden-c-phase-tm', { indexMark: '[ ]', detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }) }); return goldenCapture({ cwd: d, stdin: codeEditStdin(d), env: GOLDEN_TEAM_ENV }); },

  'FLOW_E_PHASE__main': () => { const d = makeV6Project('golden-e-phase', { indexMark: '[ ]', detail: chgDetail({ status: 'planned', task: '[ ]', approved: true }) }); return goldenCapture({ cwd: d, stdin: codeEditStdin(d) }); },
  'FLOW_E_PHASE__teammate': () => { const d = makeV6Project('golden-e-phase-tm', { indexMark: '[ ]', detail: chgDetail({ status: 'planned', task: '[ ]', approved: true }) }); return goldenCapture({ cwd: d, stdin: codeEditStdin(d), env: GOLDEN_TEAM_ENV }); },

  'FLOW_INDEX_MALFORMED__main': () => {
    const d = makeV6Project('golden-malformed', { indexMark: '[ ]', detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }) });
    const malformed = '<!-- \u6ce8\u91ca -->- [ ] [[chg-20260504-01]] \u6d4b\u8bd5\u53d8\u66f4 #change [tasks:: T-001]\n';
    fs.writeFileSync(path.join(d, 'task.md'), `# \u9879\u76ee\u4efb\u52a1\u8ffd\u8e2a\n\n## \u6d3b\u8dc3\u4efb\u52a1\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
    fs.writeFileSync(path.join(d, 'implementation_plan.md'), `# \u5b9e\u65bd\u8ba1\u5212\n\n## \u53d8\u66f4\u7d22\u5f15\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
    return goldenCapture({ cwd: d, stdin: codeEditStdin(d) });
  },
  'FLOW_INDEX_MALFORMED__teammate': () => {
    const d = makeV6Project('golden-malformed-tm', { indexMark: '[ ]', detail: chgDetail({ status: 'planned', task: '[ ]', approved: false }) });
    const malformed = '<!-- \u6ce8\u91ca -->- [ ] [[chg-20260504-01]] \u6d4b\u8bd5\u53d8\u66f4 #change [tasks:: T-001]\n';
    fs.writeFileSync(path.join(d, 'task.md'), `# \u9879\u76ee\u4efb\u52a1\u8ffd\u8e2a\n\n## \u6d3b\u8dc3\u4efb\u52a1\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
    fs.writeFileSync(path.join(d, 'implementation_plan.md'), `# \u5b9e\u65bd\u8ba1\u5212\n\n## \u53d8\u66f4\u7d22\u5f15\n\n${malformed}\n<!-- ARCHIVE -->\n`, 'utf8');
    return goldenCapture({ cwd: d, stdin: codeEditStdin(d), env: GOLDEN_TEAM_ENV });
  },

  'FLOW_DETAIL_MISSING__main': () => { const d = makeV6Project('golden-detail-missing', { indexMark: '[ ]', detail: false }); return goldenCapture({ cwd: d, stdin: codeEditStdin(d) }); },
  'FLOW_DETAIL_MISSING__teammate': () => { const d = makeV6Project('golden-detail-missing-tm', { indexMark: '[ ]', detail: false }); return goldenCapture({ cwd: d, stdin: codeEditStdin(d), env: GOLDEN_TEAM_ENV }); },

  'FLOW_NATIVE_PLAN__main': () => { const d = goldenNativePlanDir('golden-native-plan'); return goldenCapture({ cwd: d, stdin: codeEditStdin(d) }); },
  'FLOW_NATIVE_PLAN__teammate': () => { const d = goldenNativePlanDir('golden-native-plan-tm'); return goldenCapture({ cwd: d, stdin: codeEditStdin(d), env: GOLDEN_TEAM_ENV }); },

  // Phase 2：fail-closed（hardDeny）——坏 stdin / 未知工具 / 缺 file_path。
  'FAILCLOSED_BAD_STDIN': () => { const d = makeV6Project('golden-bad-stdin'); return goldenCapture({ cwd: d, stdin: 'not-json-at-all' }); },
  'FAILCLOSED_BAD_TOOL': () => { const d = makeV6Project('golden-bad-tool'); return goldenCapture({ cwd: d, stdin: { tool_name: 'Glob', tool_input: {} } }); },
  'FAILCLOSED_MISSING_FILE_PATH': () => { const d = makeV6Project('golden-missing-fp'); return goldenCapture({ cwd: d, stdin: { tool_name: 'Write', tool_input: {} } }); },

  // Phase 2：直写/marker 门（hardDeny）——主 session 直接改 artifact。
  'HARDDENY_DIRECT_WRITE': () => { const d = makeV6Project('golden-direct-write'); return goldenCapture({ cwd: d, stdin: { tool_name: 'Write', tool_input: { file_path: path.join(d, 'changes', 'chg-20260504-01.md'), content: 'x' } } }); },
  'HARDDENY_DIRECT_EDIT': () => { const d = makeV6Project('golden-direct-edit'); return goldenCapture({ cwd: d, stdin: { tool_name: 'Edit', tool_input: { file_path: path.join(d, 'changes', 'chg-20260504-01.md'), old_string: '# 测试变更', new_string: '# 测试变更X' } } }); },
  'HARDDENY_V6_MARKER__main': () => { const d = makeV6Project('golden-marker'); return goldenCapture({ cwd: d, stdin: { agent_id: 'a-m', tool_name: 'Edit', tool_input: { file_path: path.join(d, 'changes', 'chg-20260504-01.md'), old_string: '<!-- APPROVED -->', new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->' } } }); },
  'HARDDENY_V6_MARKER__teammate': () => { const d = makeV6Project('golden-marker-tm'); return goldenCapture({ cwd: d, env: GOLDEN_TEAM_ENV, stdin: { agent_id: 'a-m', agent_type: 'code-reviewer', tool_name: 'Edit', tool_input: { file_path: path.join(d, 'changes', 'chg-20260504-01.md'), old_string: '<!-- APPROVED -->', new_string: '<!-- APPROVED -->\n<!-- VERIFIED -->' } } }); },

  // Phase 2：agent 派发 raw——artifact-writer Agent 派发各校验出口。
  'AGENT_TARGET_REQUIRED': () => {
    const d = makeV6Project('golden-agent-target');
    return goldenCapture({ cwd: d, stdin: { session_id: 'sid-g-target', tool_name: 'Agent', tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'x', prompt: [`artifact_dir: ${d.replace(/\\/g, '/')}/`, 'operation: update-chg', 'action: update-status', 'task-id: T-001', 'status: in-progress', '正文提到 CHG-20260504-01 但无 target 字段。'].join('\n') } } });
  },
  'AGENT_ARTIFACT_DIR': () => {
    const d = makeV6Project('golden-agent-dir');
    return goldenCapture({ cwd: d, stdin: { session_id: 'sid-g-dir', tool_name: 'Agent', tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'x', prompt: ['artifact_dir: /wrong/path/not/the/artdir/', 'operation: create-chg', 'title: 测试'].join('\n') } } });
  },
  'AGENT_LIFECYCLE_PROMPT': () => {
    const d = makeV6Project('golden-agent-lifecycle');
    return goldenCapture({ cwd: d, stdin: { session_id: 'sid-g-life', tool_name: 'Agent', tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'x', prompt: [`artifact_dir: ${d.replace(/\\/g, '/')}/`, 'operation: update-chg', 'target: CHG-20260504-01', 'action: approve'].join('\n') } } });
  },
  'AGENT_NEWER_SCHEMA': () => {
    const d = makeV6Project('golden-agent-newer');
    const newer = chgDetail({ approved: false }).replace('schema-version: "6.0"', 'schema-version: "8.0"');
    fs.writeFileSync(path.join(d, 'changes', 'chg-20260504-01.md'), newer, 'utf8');
    return goldenCapture({ cwd: d, stdin: { session_id: 'sid-g-newer', tool_name: 'Agent', tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'x', prompt: [`artifact_dir: ${d.replace(/\\/g, '/')}/`, 'operation: update-chg', 'target: CHG-20260504-01', 'action: verify'].join('\n') } } });
  },
  'AGENT_CHANGE_OWNER': () => {
    const d = makeV6Project('golden-agent-owner');
    seedChangeOwner(d, 'CHG-20260504-01', { sessionId: 'sid-foreign-owner', agentId: 'agent-foreign', state: 'active', worktree: 'worktree-a', branch: 'branch-a' });
    return goldenCapture({ cwd: d, stdin: { session_id: 'sid-g-owner', tool_name: 'Agent', tool_input: { subagent_type: 'paceflow:artifact-writer', description: 'x', prompt: [`artifact_dir: ${d.replace(/\\/g, '/')}/`, 'operation: update-chg', 'target: CHG-20260504-01', 'action: update-status', 'task-id: T-001', 'new-status: [/]'].join('\n') } } });
  },

  // Phase 2：artifact 写入完整性 raw——artifact-writer 写盘各校验出口。
  'RAW_STATUS_INVALID': () => {
    const d = makeV6Project('golden-status-invalid');
    return goldenCapture({ cwd: d, stdin: { session_id: 'sid-g-si', agent_id: 'aw-si', agent_type: 'paceflow:artifact-writer', tool_name: 'Write', tool_input: { file_path: path.join(d, 'changes', 'chg-20260504-77.md'), content: '---\nstatus: bogus\nschema-version: "7.0"\n---\n# x\n' } } });
  },
  'RAW_WRITE_EXISTING': () => {
    const d = makeV6Project('golden-write-existing');
    return goldenCapture({ cwd: d, stdin: { session_id: 'sid-g-we', agent_id: 'aw-we', agent_type: 'paceflow:artifact-writer', tool_name: 'Write', tool_input: { file_path: path.join(d, 'changes', 'chg-20260504-01.md'), content: chgDetail() } } });
  },

  // Phase 3：Bash 改 artifact 文件（denyOrHint hard-note）——补齐 teammate hard-note 命令族。
  'CMD_BASH_ARTIFACT__main': () => { const d = makeV6Project('golden-bash-art'); return goldenCapture({ cwd: d, stdin: { tool_name: 'Bash', tool_input: { command: `sed -i 's/a/b/' ${d.replace(/\\/g, '/')}/task.md` } } }); },
  'CMD_BASH_ARTIFACT__teammate': () => { const d = makeV6Project('golden-bash-art-tm'); return goldenCapture({ cwd: d, env: GOLDEN_TEAM_ENV, stdin: { tool_name: 'Bash', tool_input: { command: `sed -i 's/a/b/' ${d.replace(/\\/g, '/')}/task.md` } } }); },

  // Phase 3：多信号弱门 DENY（denyOrHint soft）——补齐 teammate soft 模式（非流程引导也软化的弱信号门）。
  'SOFT_SIGNAL_DENY__main': () => {
    const d = makeTmpDir('golden-soft-signal');
    fs.writeFileSync(path.join(d, '.pace-enabled'), '');
    fs.mkdirSync(path.join(d, '.pace'), { recursive: true });
    fs.writeFileSync(path.join(d, '.pace', 'artifact-root'), 'local\n', 'utf8');
    return goldenCapture({ cwd: d, stdin: codeEditStdin(d) });
  },
  'SOFT_SIGNAL_DENY__teammate': () => {
    const d = makeTmpDir('golden-soft-signal-tm');
    fs.writeFileSync(path.join(d, '.pace-enabled'), '');
    fs.mkdirSync(path.join(d, '.pace'), { recursive: true });
    fs.writeFileSync(path.join(d, '.pace', 'artifact-root'), 'local\n', 'utf8');
    return goldenCapture({ cwd: d, env: GOLDEN_TEAM_ENV, stdin: codeEditStdin(d) });
  },

  // Phase 3：更多 artifact 写入完整性 raw。
  'RAW_ARCHIVE_WITHOUT_INDEX_MARKER': () => {
    const d = makeV6Project('golden-archive-no-marker');
    fs.writeFileSync(path.join(d, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n- [/] [[chg-20260504-01]] 测试变更 #change [tasks:: T-001]\n', 'utf8'); // 去掉 <!-- ARCHIVE -->
    return goldenCapture({ cwd: d, stdin: { session_id: 'sid-g-arch', agent_id: 'aw-arch', agent_type: 'paceflow:artifact-writer', tool_name: 'Edit', tool_input: { file_path: path.join(d, 'changes', 'chg-20260504-01.md'), old_string: 'status: in-progress', new_string: 'status: archived' } } });
  },
  'RAW_WRITE_FOREIGN_OWNER': () => {
    const d = makeV6Project('golden-foreign-owner');
    seedChangeOwner(d, 'CHG-20260504-01', { sessionId: 'sid-foreign-w', agentId: 'agent-foreign-w', state: 'active', worktree: 'worktree-a', branch: 'branch-a' });
    return goldenCapture({ cwd: d, stdin: { session_id: 'sid-mine-w', agent_id: 'aw-mine-w', agent_type: 'paceflow:artifact-writer', tool_name: 'Edit', tool_input: { file_path: path.join(d, 'changes', 'chg-20260504-01.md'), old_string: '# 测试变更', new_string: '# 测试变更Z' } } });
  },
  'RAW_RESERVATION_MISSING': () => {
    const d = makeV6Project('golden-reservation-missing');
    return goldenCapture({ cwd: d, stdin: { session_id: 'sid-g-rm', agent_id: 'aw-rm', agent_type: 'paceflow:artifact-writer', tool_name: 'Write', tool_input: { file_path: path.join(d, 'changes', 'chg-20260504-99.md'), content: '---\nstatus: planned\nschema-version: "7.0"\n---\n# x\n' } } });
  },
};

// 覆盖缺口登记（no-silent-caps）：以下 deny 出口【未】行为锁定，降级到 T-003 的
// DENY_REASONS 表结构测试 + 源码 grep 断言（每个 emitDeny call 传对 action、每个 action
// 在表里、富化标志匹配预期）。降级理由：① 命令探测器/路径谓词族富化均匀（hardDeny
// 只加逃生口 / denyOrHint hard-note），行为维度已由 CMD_BASH_ARTIFACT + hardDeny 族代表
// 锁住；② emitDeny 重构把 reason 文案【留在 call site】，这些出口文案不搬家 → 文案漂移
// 风险低；③ 部分出口需非确定性状态（内部 throw / 资源锁竞争 / root-choice-pending）难
// 稳定触发。T-002 逐条定这些 action 的 escapeHatch/dirHint 期望值时以本清单为准。
const GOLDEN_DEFERRED = {
  '命令探测器（bash/ps/monitor，uniform hardDeny+逃生口 / denyOrHint hard-note）': [
    'DENY_BASH_ARTIFACT_RUNTIME', 'DENY_POWERSHELL_ARTIFACT_RUNTIME', 'DENY_MONITOR_ARTIFACT_RUNTIME',
    'DENY_BASH_LOCAL_ARTIFACT_ROOT_CHOICE', 'DENY_POWERSHELL_LOCAL_ARTIFACT_ROOT_CHOICE', 'DENY_MONITOR_LOCAL_ARTIFACT_ROOT_CHOICE',
    'DENY_BASH_PROJECT_ROOT_MARKER', 'DENY_POWERSHELL_PROJECT_ROOT_MARKER', 'DENY_MONITOR_PROJECT_ROOT_MARKER',
    'DENY_POWERSHELL_ARTIFACT', 'DENY_MONITOR_ARTIFACT', // bash 变体已锁（CMD_BASH_ARTIFACT），PS/Monitor 同 hard-note
  ],
  'file-path 谓词（uniform hardDeny+逃生口）': [
    'DENY_LOCAL_ARTIFACT_ROOT_CHOICE', 'DENY_PROJECT_ROOT_MARKER', 'DENY_ARTIFACT_RUNTIME_CONTROL',
  ],
  'root-choice-pending 状态（denyOrHint，soft 同 NATIVE_PLAN 已锁）': [
    'DENY_ARTIFACT_ROOT_CHOICE', 'DENY_AGENT_ARTIFACT_ROOT_CHOICE',
  ],
  'agent 派发 edge（uniform raw 无富化）': [
    'DENY_AGENT_LEGACY_ARTIFACT_LOCK', 'DENY_AGENT_ARTIFACT_BASE', 'DENY_AGENT_BATCH_RESERVED_MISMATCH',
    'DENY_AGENT_ID_RESERVATION', 'DENY_AGENT_RESERVED_PROMPT_REQUIRED', 'DENY_AGENT_RESERVED_PROMPT_MISMATCH',
    'DENY_AGENT_CHANGE_OWNER_STALE',
  ],
  '并发/完整性 raw（uniform raw 无富化，部分需锁竞争/vault 路由）': [
    'DENY_ARTIFACT_RESERVATION_MISMATCH', 'DENY_ARTIFACT_RESOURCE_LOCK', 'DENY_ARTIFACT_CONCURRENT_WRITE',
    'DENY_REDIRECT', 'DENY_WRITE_ARTIFACT', 'DENY_ARTIFACT_ROOT_CONFIG',
  ],
  'fail-closed catch（内部 throw 难确定性触发）': [
    'CATCH_FAIL_CLOSED',
  ],
};

let goldenSnapshot = {};
if (fs.existsSync(GOLDEN_SNAPSHOT_PATH)) {
  try { goldenSnapshot = JSON.parse(fs.readFileSync(GOLDEN_SNAPSHOT_PATH, 'utf8')); } catch(e) { goldenSnapshot = {}; }
}
const goldenResults = {};
for (const [label, build] of Object.entries(GOLDEN_CASES)) {
  test(`GOLDEN ${label}`, () => {
    const got = build();
    goldenResults[label] = got;
    if (GOLDEN_UPDATE) return; // \u66f4\u65b0\u6a21\u5f0f\uff1a\u53ea\u91c7\u96c6\u4e0d\u65ad\u8a00
    const want = goldenSnapshot[label];
    assert.ok(want, `\u9ec4\u91d1\u57fa\u7ebf\u7f3a ${label}\uff08\u9996\u6b21\u9700 UPDATE_GOLDEN=1 \u751f\u6210\uff09`);
    assert.strictEqual(got.decision, want.decision, `${label} decision \u6f02\u79fb\uff1agot=${got.decision} want=${want.decision}`);
    assert.strictEqual(got.text, want.text, `${label} \u6587\u6848\u6f02\u79fb\uff1a\n--- got ---\n${got.text}\n--- want ---\n${want.text}`);
  });
}
if (GOLDEN_UPDATE) {
  fs.mkdirSync(path.dirname(GOLDEN_SNAPSHOT_PATH), { recursive: true });
  const merged = { ...goldenSnapshot, ...goldenResults }; // \u4fdd\u7559\u672a\u5728\u672c\u6b21\u8dd1\u7684\u65e7 label
  fs.writeFileSync(GOLDEN_SNAPSHOT_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log(`  [GOLDEN] \u5df2\u66f4\u65b0\u57fa\u7ebf\u5feb\u7167: \u672c\u6b21 ${Object.keys(goldenResults).length} \u6761\uff0c\u5408\u8ba1 ${Object.keys(merged).length} \u6761 \u2192 ${GOLDEN_SNAPSHOT_PATH}`);
}

// \u8986\u76d6\u62a5\u544a + \u4e00\u81f4\u6027\u5b88\u536b\uff1a\u884c\u4e3a\u9501\u5b9a\u6570 vs \u7ed3\u6784\u964d\u7ea7\u6570\u663e\u5f0f\u53ef\u89c1\uff08no-silent-caps\uff09\u3002
test('GOLDEN coverage: \u884c\u4e3a\u9501\u5b9a + \u7ed3\u6784\u964d\u7ea7\u6e05\u5355\u5b8c\u6574\u3001\u4e92\u4e0d\u91cd\u53e0', () => {
  const behavioralLabels = Object.keys(GOLDEN_CASES);
  const deferredCodes = Object.values(GOLDEN_DEFERRED).flat();
  // \u884c\u4e3a\u9501\u5b9a\u7684 label \u91cc\u7684 action \u5173\u952e\u8bcd\u4e0d\u5f97\u540c\u65f6\u51fa\u73b0\u5728 deferred\uff08\u9632\u4e00\u4e2a\u51fa\u53e3\u65e2\u58f0\u79f0\u9501\u4e86\u53c8\u58f0\u79f0\u964d\u7ea7\uff09\u3002
  // label \u7528 <\u7ec4>_<\u51fa\u53e3>__<\u53d8\u4f53> \u5f62\u6001\uff0c\u4e0e deferred \u7684 DENY_ \u5168\u79f0\u975e\u540c\u540d\u7a7a\u95f4\uff0c\u8fd9\u91cc\u505a\u8ba1\u6570\u53ef\u89c1\u6027 + \u53bb\u91cd\u5b88\u536b\u3002
  assert.ok(behavioralLabels.length >= 33, `\u884c\u4e3a\u9501\u5b9a label \u5e94 \u226533\uff0c\u5b9e\u9645 ${behavioralLabels.length}`);
  assert.strictEqual(new Set(deferredCodes).size, deferredCodes.length, 'GOLDEN_DEFERRED \u5185\u4e0d\u5f97\u6709\u91cd\u590d action code');
  console.log(`  [GOLDEN] \u8986\u76d6: \u884c\u4e3a\u9501\u5b9a ${behavioralLabels.length} label\uff08\u542b main/teammate \u53d8\u4f53\uff09\uff0c\u7ed3\u6784\u964d\u7ea7 ${deferredCodes.length} action code\uff08\u2192 T-003 DENY_REASONS \u8868\u6d4b\u8bd5\uff09`);
});

// \u9ec4\u91d1\u57fa\u7ebf\u884c\u4e3a\u9501\u5b9a\u7684\u53bb\u91cd action code\uff08\u4e0e GOLDEN_CASES \u4e00\u4e00\u5bf9\u5e94\uff09\u3002\u4e0e GOLDEN_DEFERRED \u5408\u5e76 = \u5168\u90e8 deny \u51fa\u53e3 census\u3002
const GOLDEN_COVERED_CODES = [
  'DENY_V6_NO_ACTIVE', 'DENY_V6_C_PHASE', 'DENY_V6_E_PHASE', 'DENY_V6_INDEX_MALFORMED', 'DENY_V6_DETAIL_MISSING',
  'DENY_NATIVE_PLAN', 'DENY', 'DENY_BASH_ARTIFACT',
  'DENY_BAD_STDIN', 'DENY_BAD_TOOL', 'DENY_MISSING_FILE_PATH', 'DENY_DIRECT_ARTIFACT_WRITE', 'DENY_DIRECT_ARTIFACT_EDIT', 'DENY_V6_MARKER',
  'DENY_AGENT_TARGET_REQUIRED', 'DENY_AGENT_ARTIFACT_DIR', 'DENY_AGENT_LIFECYCLE_PROMPT', 'DENY_AGENT_NEWER_SCHEMA', 'DENY_AGENT_CHANGE_OWNER',
  'DENY_ARTIFACT_STATUS_INVALID', 'DENY_WRITE_EXISTING_ARTIFACT', 'DENY_ARCHIVE_WITHOUT_INDEX_MARKER', 'DENY_WRITE_FOREIGN_OWNER', 'DENY_ARTIFACT_RESERVATION_MISSING',
];

// \u7ed3\u6784\u5b8c\u6574\u6027\uff08CHG-20260614-13 T-003\uff09\uff1a\u6e90\u7801 regex \u65ad\u8a00 emitDeny \u6536\u655b + DENY_REASONS \u8868\u8986\u76d6\u5168\u90e8
// deny \u51fa\u53e3\uff08\u542b\u96be\u8fbe\u7684\u964d\u7ea7\u51fa\u53e3\uff09\uff0c\u8865\u9ec4\u91d1\u57fa\u7ebf\u884c\u4e3a\u9501\u8986\u76d6\u4e0d\u5230\u7684 no-silent-caps \u5b8c\u6574\u6027\u3002
test('GOLDEN structural: emitDeny \u5355\u51fa\u53e3\u6536\u655b + DENY_REASONS \u8868\u8986\u76d6\u5168\u90e8 deny action code', () => {
  const src = fs.readFileSync(path.join(HOOKS_DIR, 'pre-tool-use.js'), 'utf8');
  // 1) DENY_REASONS \u8868\u952e\uff08\u6a21\u5757\u7ea7 2 \u7a7a\u683c\u7f29\u8fdb\uff09
  const tableStart = src.indexOf('const DENY_REASONS = {');
  const tableEnd = src.indexOf('\nfunction isArtifactWriterAgent');
  assert.ok(tableStart >= 0 && tableEnd > tableStart, 'DENY_REASONS \u8868\u5757\u5b9a\u4f4d\u5931\u8d25');
  const tableBlock = src.slice(tableStart, tableEnd);
  // \u5b57\u7b26\u7c7b\u542b 0-9\uff1aaction code \u542b\u6570\u5b57\uff08DENY_V6_C_PHASE \u7b49\uff09\uff0c\u6f0f 0-9 \u4f1a\u628a code \u8170\u65a9\u6210 DENY_V\u3002
  const tableKeys = new Set([...tableBlock.matchAll(/^ {2}(DENY[A-Z0-9_]*):/gm)].map(m => m[1]));
  // 2) emitDeny \u7b2c\u4e00\u53c2 action code\uff08\u53bb ${teammateTag} \u540e\u7f00\uff09\u5fc5\u987b\u5728\u8868\u91cc\u2014\u2014\u5426\u5219\u8fd0\u884c\u65f6 emitDeny throw
  const emitted = new Set([...src.matchAll(/emitDeny\(\s*[`'"]([A-Z0-9_]+)/g)].map(m => m[1]));
  assert.ok(emitted.size >= 30, `emitDeny \u51fa\u53e3\u5e94 \u226530\uff0c\u5b9e\u9645 ${emitted.size}\uff08\u8fc1\u79fb\u53ef\u80fd\u4e0d\u5b8c\u6574\uff09`);
  for (const code of emitted) assert.ok(tableKeys.has(code), `emitDeny \u51fa\u53e3 ${code} \u7f3a DENY_REASONS \u8868\u9879\uff08\u8fd0\u884c\u65f6\u4f1a throw fail-closed\uff09`);
  // 3) emitDeny fail-fast \u5b88\u536b\u5b58\u5728\uff08\u672a\u767b\u8bb0 code \u629b\u9519\uff0c\u9632\u65b0\u51fa\u53e3\u6f0f\u767b\u8bb0\uff09
  assert.ok(/\u672a\u5728 DENY_REASONS \u767b\u8bb0\u7684 deny action code/.test(src), 'emitDeny \u5e94\u5bf9\u672a\u767b\u8bb0 code fail-fast \u629b\u9519');
  // 4) \u6536\u655b\u5b8c\u6574\u6027\uff1a\u9664 emitDeny \u5185\u90e8\u51fa\u53e3 + \u5168\u5c40 catch fail-closed\uff0c\u6e90\u7801\u4e0d\u5e94\u518d\u6709\u624b\u5199 permissionDecision deny \u51fa\u53e3
  const denyOutlets = [...src.matchAll(/permissionDecision:\s*['"]deny['"]/g)].length;
  assert.strictEqual(denyOutlets, 2, `\u624b\u5199 deny \u51fa\u53e3\u5e94\u53ea\u5269 emitDeny \u5185\u90e8 + catch fail-closed\uff08\u5171 2\uff09\uff0c\u5b9e\u9645 ${denyOutlets}`);
  // 5) \u5b8c\u6574\u6027\uff08no-silent-caps\uff09\uff1a\u884c\u4e3a\u9501\u5b9a + \u7ed3\u6784\u964d\u7ea7\u51fa\u53e3\uff08\u9664 CATCH_FAIL_CLOSED \u72ec\u7acb raw\uff09\u5168\u90e8\u5728\u8868\u91cc
  const census = [...GOLDEN_COVERED_CODES, ...Object.values(GOLDEN_DEFERRED).flat().filter(c => c !== 'CATCH_FAIL_CLOSED')];
  for (const code of census) assert.ok(tableKeys.has(code), `\u51fa\u53e3 census \u4e2d ${code} \u7f3a DENY_REASONS \u8868\u9879\uff08\u5b8c\u6574\u6027\u7834\u574f\uff09`);
  console.log(`  [GOLDEN] \u7ed3\u6784: DENY_REASONS ${tableKeys.size} \u9879\uff1bemitDeny \u6536\u655b ${emitted.size} \u51fa\u53e3\u5168\u5728\u8868\uff1bcensus ${census.length} \u5168\u8986\u76d6\uff1b\u624b\u5199 deny \u51fa\u53e3\u6536\u655b\u81f3 ${denyOutlets}`);
});

// 结构完整性 part 2（CHG-20260614-17 T-004，codex P3-3）：逐项锁 DENY_REASONS 53 个 action 的
// {escapeHatch, dirHint, teammateMode} 三元组。此前结构测试只验 code 在表内 + 出口=2，不验表值；
// 行为 golden 只锁 33 个可达出口，剩余 deferred action 若富化位（escapeHatch/dirHint/teammateMode）
// 被写反，两道现有守护都可能仍绿。EXPECTED_DENY_META 是表值 golden——flip 任一位即红，强制维护者
// 改富化时同步确认（DENY_DIRECT_ARTIFACT_EDIT 的 dirHint:true 例外亦在锁内）。
const EXPECTED_DENY_META = {
  // 流程门 soft（denyOrHint 无 hardInTeammate）——4
  DENY_AGENT_ARTIFACT_ROOT_CHOICE: 'true|true|soft',
  DENY_ARTIFACT_ROOT_CHOICE: 'true|true|soft',
  DENY_NATIVE_PLAN: 'true|true|soft',
  DENY: 'true|true|soft',
  // 流程门/完整性 hard-note（denyOrHint hardInTeammate:true）——8
  DENY_BASH_ARTIFACT: 'true|true|hard-note',
  DENY_POWERSHELL_ARTIFACT: 'true|true|hard-note',
  DENY_MONITOR_ARTIFACT: 'true|true|hard-note',
  DENY_V6_INDEX_MALFORMED: 'true|true|hard-note',
  DENY_V6_DETAIL_MISSING: 'true|true|hard-note',
  DENY_V6_NO_ACTIVE: 'true|true|hard-note',
  DENY_V6_C_PHASE: 'true|true|hard-note',
  DENY_V6_E_PHASE: 'true|true|hard-note',
  // hardDeny（escapeHatch only, teammate hard）——19（DENY_DIRECT_ARTIFACT_EDIT dirHint:true 例外）
  DENY_BAD_STDIN: 'true|false|hard',
  DENY_ARTIFACT_ROOT_CONFIG: 'true|false|hard',
  DENY_BASH_LOCAL_ARTIFACT_ROOT_CHOICE: 'true|false|hard',
  DENY_POWERSHELL_LOCAL_ARTIFACT_ROOT_CHOICE: 'true|false|hard',
  DENY_MONITOR_LOCAL_ARTIFACT_ROOT_CHOICE: 'true|false|hard',
  DENY_BASH_PROJECT_ROOT_MARKER: 'true|false|hard',
  DENY_POWERSHELL_PROJECT_ROOT_MARKER: 'true|false|hard',
  DENY_MONITOR_PROJECT_ROOT_MARKER: 'true|false|hard',
  DENY_BASH_ARTIFACT_RUNTIME: 'true|false|hard',
  DENY_POWERSHELL_ARTIFACT_RUNTIME: 'true|false|hard',
  DENY_MONITOR_ARTIFACT_RUNTIME: 'true|false|hard',
  DENY_BAD_TOOL: 'true|false|hard',
  DENY_MISSING_FILE_PATH: 'true|false|hard',
  DENY_LOCAL_ARTIFACT_ROOT_CHOICE: 'true|false|hard',
  DENY_PROJECT_ROOT_MARKER: 'true|false|hard',
  DENY_ARTIFACT_RUNTIME_CONTROL: 'true|false|hard',
  DENY_DIRECT_ARTIFACT_WRITE: 'true|false|hard',
  DENY_DIRECT_ARTIFACT_EDIT: 'true|true|hard',
  DENY_V6_MARKER: 'true|false|hard',
  // raw（无富化, teammate hard）——22
  DENY_AGENT_NEWER_SCHEMA: 'false|false|hard',
  DENY_AGENT_ARTIFACT_DIR: 'false|false|hard',
  DENY_AGENT_LIFECYCLE_PROMPT: 'false|false|hard',
  DENY_AGENT_LEGACY_ARTIFACT_LOCK: 'false|false|hard',
  DENY_AGENT_ARTIFACT_BASE: 'false|false|hard',
  DENY_AGENT_BATCH_RESERVED_MISMATCH: 'false|false|hard',
  DENY_AGENT_ID_RESERVATION: 'false|false|hard',
  DENY_AGENT_RESERVED_PROMPT_REQUIRED: 'false|false|hard',
  DENY_AGENT_RESERVED_PROMPT_MISMATCH: 'false|false|hard',
  DENY_AGENT_TARGET_REQUIRED: 'false|false|hard',
  DENY_AGENT_CHANGE_OWNER: 'false|false|hard',
  DENY_AGENT_CHANGE_OWNER_STALE: 'false|false|hard',
  DENY_WRITE_FOREIGN_OWNER: 'false|false|hard',
  DENY_ARCHIVE_WITHOUT_INDEX_MARKER: 'false|false|hard',
  DENY_ARTIFACT_STATUS_INVALID: 'false|false|hard',
  DENY_ARTIFACT_RESERVATION_MISSING: 'false|false|hard',
  DENY_ARTIFACT_RESERVATION_MISMATCH: 'false|false|hard',
  DENY_ARTIFACT_RESOURCE_LOCK: 'false|false|hard',
  DENY_ARTIFACT_CONCURRENT_WRITE: 'false|false|hard',
  DENY_REDIRECT: 'false|false|hard',
  DENY_WRITE_EXISTING_ARTIFACT: 'false|false|hard',
  DENY_WRITE_ARTIFACT: 'false|false|hard',
};

test('GOLDEN structural: DENY_REASONS 53 项 {escapeHatch,dirHint,teammateMode} 三元组逐项锁', () => {
  const src = fs.readFileSync(path.join(HOOKS_DIR, 'pre-tool-use.js'), 'utf8');
  const tableStart = src.indexOf('const DENY_REASONS = {');
  const tableEnd = src.indexOf('\nfunction isArtifactWriterAgent');
  assert.ok(tableStart >= 0 && tableEnd > tableStart, 'DENY_REASONS 表块定位失败');
  const tableBlock = src.slice(tableStart, tableEnd);
  // 解析实际表三元组（字符类含 0-9：action code 含数字如 DENY_V6_C_PHASE）
  const actual = {};
  for (const m of tableBlock.matchAll(/^ {2}(DENY[A-Z0-9_]*):\s*\{\s*category:\s*'[^']+',\s*escapeHatch:\s*(true|false),\s*dirHint:\s*(true|false),\s*teammateMode:\s*'([^']+)'/gm)) {
    actual[m[1]] = `${m[2]}|${m[3]}|${m[4]}`;
  }
  // 数量一致（防解析漏行 / 表增删未同步期望）
  assert.strictEqual(Object.keys(actual).length, 53, `DENY_REASONS 应解析 53 项，实际 ${Object.keys(actual).length}`);
  assert.strictEqual(Object.keys(EXPECTED_DENY_META).length, 53, 'EXPECTED_DENY_META 应 53 项');
  // 键集双向一致（新增/删除 action 须同步期望表）
  for (const code of Object.keys(EXPECTED_DENY_META)) assert.ok(code in actual, `EXPECTED 有 ${code} 但实际表缺`);
  for (const code of Object.keys(actual)) assert.ok(code in EXPECTED_DENY_META, `实际表有 ${code} 但 EXPECTED 缺（新增 action 须同步期望表）`);
  // 逐项三元组锁
  for (const [code, expected] of Object.entries(EXPECTED_DENY_META)) {
    assert.strictEqual(actual[code], expected, `${code} 三元组漂移：期望 escapeHatch|dirHint|teammateMode=${expected}，实际 ${actual[code]}`);
  }
  console.log(`  [GOLDEN] 表值: DENY_REASONS 53 项 {escapeHatch,dirHint,teammateMode} 逐项锁（DIRECT_ARTIFACT_EDIT dirHint:true 例外已锁）`);
});

cleanupAll();

const total = t.passed + t.failed;
console.log(`\n${t.failed === 0 ? '\u2705' : '\u274c'} ${t.passed}/${total} tests passed`);
if (t.failed > 0) process.exit(1);
