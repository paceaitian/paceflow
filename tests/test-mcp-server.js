// PACEflow MCP artifact server 测试(CHG-20260815-02/03):
//   1) 单元:上下文解析优先级、业务参数剥离、管线干跑(file-conflict / edit-mismatch);
//   2) 进程级:以 newline-delimited JSON-RPC 喂 paceflow-server.js,在临时 PACE 项目上跑
//      握手 → tools/list → get_context → reserve → create_chg → approve-and-start → update-status → append →
//      verify → review,产物用 pace-utils 既有解析器(parseFrontmatter / validateFrontmatterSchema / parseChangeIndex)校验;
//   3) 边界:幂等、状态机拒绝、缺 reservation 时真门 deny 且零写入、未实现工具显式报错。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { createTestRunner } = require('./test-utils');

const PLUGIN = path.join(__dirname, '..', 'plugin');
const SERVER = path.join(PLUGIN, 'mcp', 'paceflow-server.js');
const paceUtils = require(path.join(PLUGIN, 'hooks', 'pace-utils'));
const { resolveCallContext, businessArgs } = require(path.join(PLUGIN, 'mcp', 'lib', 'context.js'));
const pipeline = require(path.join(PLUGIN, 'mcp', 'lib', 'writer-pipeline.js'));
const ops = require(path.join(PLUGIN, 'mcp', 'lib', 'artifact-ops.js'));
const t = createTestRunner('pace-mcp');
const { test, makeTmpDir } = t;

const _origLogPath = process.env.PACE_LOG_PATH;
const LOG_PATH = path.join(os.tmpdir(), `pace-mcp-log-${Date.now()}-${process.pid}.log`);
process.env.PACE_LOG_PATH = LOG_PATH;
const _origVault = process.env.PACE_VAULT_PATH;
const VAULT_TMP = path.join(os.tmpdir(), `pace-mcp-vault-${Date.now()}`);
fs.mkdirSync(path.join(VAULT_TMP, 'projects'), { recursive: true });
process.env.PACE_VAULT_PATH = VAULT_TMP;

function makeProject(label) {
  const dir = makeTmpDir(label);
  fs.mkdirSync(path.join(dir, 'changes', 'findings'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'changes', 'corrections'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'walkthrough.md'), '# 工作记录\n\n## 最近工作\n\n| 日期 | 完成内容 | 关联变更 |\n| --- | --- | --- |\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'findings.md'), '# 调研记录\n\n## 摘要索引\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'corrections.md'), '# Corrections 记录\n\n## 索引\n\n<!-- ARCHIVE -->\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src.js'), 'a\n', 'utf8');
  return dir;
}

function meta(dir, sessionId = 'sess-mcp-1') {
  return { 'x-codex-turn-metadata': { session_id: sessionId, thread_id: sessionId, turn_id: 'turn-1', workspaces: { [dir]: { has_changes: false } } } };
}

/** 一次性喂多条 JSON-RPC,返回 id → result 映射 */
function rpc(dir, calls, { env = {} } = {}) {
  const lines = [JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } })];
  calls.forEach((c, i) => lines.push(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: c.method || 'tools/call', params: c.params })));
  const r = spawnSync(process.execPath, [SERVER], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env }, cwd: os.tmpdir() });
  const out = {};
  for (const l of (r.stdout || '').split('\n').filter(Boolean)) { const o = JSON.parse(l); out[o.id] = o; }
  return { out, stderr: r.stderr || '', status: r.status };
}
function call(name, args, dir, sessionId) { return { params: { name, arguments: args, _meta: meta(dir, sessionId) } }; }
function textOf(res) { return res && res.result && res.result.content ? res.result.content[0].text : JSON.stringify(res); }
function sc(res) { return res && res.result ? res.result.structuredContent || {} : {}; }

console.log('\n[mcp-server] 单元');

test('MS-U1 resolveCallContext:hook 注入 > _meta > env;缺 session/cwd 报错', () => {
  const dir = '/tmp/x';
  const a = resolveCallContext({ arguments: { _pace_session_id: 'hook-s', _pace_cwd: dir }, _meta: meta('/tmp/y', 'meta-s') });
  assert.strictEqual(a.sessionId, 'hook-s'); assert.strictEqual(a.cwd, path.resolve(dir)); assert.strictEqual(a.source, 'hook');
  assert.ok(a.warnings.length >= 1, '不一致时有 warning');
  const b = resolveCallContext({ arguments: {}, _meta: meta('/tmp/y', 'meta-s') });
  assert.strictEqual(b.sessionId, 'meta-s'); assert.strictEqual(b.cwd, path.resolve('/tmp/y')); assert.strictEqual(b.source, 'meta');
  const saved = process.env.CODEX_THREAD_ID; process.env.CODEX_THREAD_ID = 'env-s';
  try {
    const c = resolveCallContext({ arguments: { _pace_cwd: '/tmp/z' } });
    assert.strictEqual(c.sessionId, 'env-s'); assert.strictEqual(c.source, 'env');
    const d = resolveCallContext({ arguments: {} });
    assert.strictEqual(d.ok, false, 'env 有 session 但无 cwd → 失败'); assert.ok(/cwd/.test(d.reason));
  } finally { if (saved === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = saved; }
  const savedC = process.env.CODEX_THREAD_ID, savedA = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID; delete process.env.CLAUDE_CODE_SESSION_ID;
  try { const e = resolveCallContext({ arguments: {} }); assert.strictEqual(e.ok, false); assert.ok(/session/.test(e.reason)); }
  finally { if (savedC !== undefined) process.env.CODEX_THREAD_ID = savedC; if (savedA !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedA; }
});

test('MS-U2 businessArgs 剥离 _ 前缀元数据', () => {
  assert.deepStrictEqual(businessArgs({ a: 1, _pace_cwd: '/x', _meta: {} }), { a: 1 });
});

test('MS-U3 pipeline.dryCheck:Write 目标已存在 → file-conflict;Edit old_string 未命中/多处 → edit-mismatch;不碰盘不调 hook', () => {
  const dir = makeProject('ms-u3');
  const f = path.join(dir, 'task.md');
  assert.strictEqual(pipeline.dryCheck([{ kind: 'write', file: f, content: 'x' }]).code, 'file-conflict');
  assert.strictEqual(pipeline.dryCheck([{ kind: 'edit', file: f, oldString: 'NOPE', newString: 'y' }]).code, 'edit-mismatch');
  fs.appendFileSync(f, '\ndup\ndup\n');
  assert.strictEqual(pipeline.dryCheck([{ kind: 'edit', file: f, oldString: 'dup', newString: 'y' }]).code, 'edit-mismatch');
  assert.strictEqual(pipeline.dryCheck([{ kind: 'edit', file: f, oldString: '<!-- ARCHIVE -->', newString: 'y' }]).ok, true);
});

test('MS-U4 artifact-ops 纯函数:slugify / normalizeTasks / deriveStatusAfterTasks / normalizeId', () => {
  assert.strictEqual(ops.slugify('Codex Host Adapter Layer!!'), 'codex-host-adapter-layer');
  assert.strictEqual(ops.slugify('全中文标题', 'change'), 'change');
  assert.ok(ops.slugify('a'.repeat(80)).length <= 50);
  assert.deepStrictEqual(ops.normalizeTasks(['T-003: 甲', '乙', { id: 'T-009', text: '丙' }]), [{ id: 'T-003', text: '甲' }, { id: 'T-002', text: '乙' }, { id: 'T-009', text: '丙' }]);
  assert.throws(() => ops.normalizeTasks([]), /tasks/);
  assert.strictEqual(ops.deriveStatusAfterTasks(['-', '-'], 'in-progress'), 'cancelled');
  assert.strictEqual(ops.deriveStatusAfterTasks(['x', '-'], 'in-progress'), 'completed');
  assert.strictEqual(ops.deriveStatusAfterTasks(['/', ' '], 'planned'), 'in-progress');
  assert.strictEqual(ops.deriveStatusAfterTasks(['x', '/'], 'in-progress'), 'in-progress');
  assert.strictEqual(ops.normalizeId('chg-20260815-01'), 'CHG-20260815-01');
  assert.strictEqual(ops.normalizeId('CHG-2026-01'), '');
});

console.log('\n[mcp-server] 进程级(真 hooks 管线)');

test('MS-E1 握手 + tools/list 稳定 + get_context 报 artifact_dir/空活跃列表', () => {
  const dir = makeProject('ms-e1');
  const { out } = rpc(dir, [{ method: 'tools/list', params: {} }, call('get_context', {}, dir)]);
  assert.strictEqual(out[0].result.serverInfo.name, 'paceflow');
  assert.deepStrictEqual(out[1].result.tools.map((x) => x.name), ['get_context', 'reserve_artifact_id', 'create_chg', 'update_chg']);
  const ctx = sc(out[2]);
  assert.strictEqual(path.resolve(ctx.artifact_dir), path.resolve(dir));
  assert.deepStrictEqual(ctx.active_changes, []);
});

test('MS-E2 全链路:reserve → create_chg → approve-and-start → update-status → append → verify → review,产物过既有解析器', () => {
  const dir = makeProject('ms-e2');
  const r1 = rpc(dir, [call('reserve_artifact_id', { operation: 'create-chg' }, dir)]);
  const reserved = sc(r1.out[1]).reserved;
  assert.ok(reserved && reserved[0] && /^CHG-\d{8}-01$/.test(reserved[0].reserved_id), `reserve 失败:${textOf(r1.out[1])} ${r1.stderr}`);
  const id = reserved[0].reserved_id;
  const r2 = rpc(dir, [
    call('create_chg', { reserved_id: id, reserved_file_prefix: reserved[0].reserved_file_prefix, title: '全链路冒烟', slug: 'e2e-smoke', tasks: ['T-001: 甲', 'T-002: 乙'], background: 'why', scope: 'what', technical_decision: 'how' }, dir),
    call('update_chg', { target: id, action: 'approve-and-start', task_id: 'T-001', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: '用户说开始' }, dir),
    call('update_chg', { target: id, action: 'append', section: 'work-record', content: '写了一半' }, dir),
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-001', new_status: '[x]' }, dir),
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-002', new_status: '[x]' }, dir),
    call('update_chg', { target: id, action: 'verify', verify_summary: 'node tests 8/8' }, dir),
    call('update_chg', { target: id, action: 'review', review_confirmed: true, review_source: 'manual', review_findings: 'P0×0 / P1×0 / P2×0 / P3×0' }, dir),
  ]);
  for (let i = 1; i <= 7; i++) assert.strictEqual(r2.out[i].result.isError, false, `step ${i}: ${textOf(r2.out[i])}\n${r2.stderr.slice(0, 500)}`);
  const detailPath = path.join(dir, 'changes', `${id.toLowerCase()}-e2e-smoke.md`);
  assert.ok(fs.existsSync(detailPath), 'slug 文件已建');
  const content = fs.readFileSync(detailPath, 'utf8');
  const fm = paceUtils.parseFrontmatter(content);
  const v = paceUtils.validateFrontmatterSchema('chg', fm.status, fm);
  assert.ok(v.ok, `frontmatter 封闭合同:${JSON.stringify(v)}`);
  assert.strictEqual(String(fm.status), 'completed');
  assert.ok(/^verified-date: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/m.test(content));
  assert.ok(/^reviewed-date: \d{4}-/m.test(content));
  assert.ok(/- \[x\] T-001 甲\n- \[x\] T-002 乙\n\n<!-- APPROVED -->\n<!-- VERIFIED -->\n<!-- REVIEWED -->\n\n## 实施详情/.test(content), `三标记位置:\n${content.slice(0, 700)}`);
  assert.ok(/\| \d{4}-\d{2}-\d{2} \| 写了一半 \|/.test(content));
  assert.ok(/\| \d{4}-\d{2}-\d{2} \| 验证通过：node tests 8\/8 \|/.test(content));
  assert.ok(/## 审查记录\n\n\| 日期 \| 审计来源 \| findings \|\n\| --- \| --- \| --- \|\n\| \d{4}-\d{2}-\d{2} \| manual \| P0×0/.test(content), `审查记录段:\n${content.slice(-400)}`);
  const idx = paceUtils.parseChangeIndex(paceUtils.readActive(dir, 'task.md'));
  assert.strictEqual(idx.length, 1); assert.strictEqual(idx[0].id, id); assert.strictEqual(idx[0].checkbox, 'x'); assert.strictEqual(idx[0].slug, `${id.toLowerCase()}-e2e-smoke`);
  assert.ok(idx[0].rest.includes('#change [tasks:: T-001~T-002]'));
  // 用 pace-utils 的 classifyChange 判定:completed + verified + reviewed
  const entries = paceUtils.getActiveChangeEntries(dir);
  const c = paceUtils.classifyChange(entries[0]);
  assert.ok(c.approved && c.verified, `classifyChange: ${JSON.stringify(c)}`);
});

test('MS-E3 缺 reservation 直接 create_chg → 真门 deny(hook-deny),零写入', () => {
  const dir = makeProject('ms-e3');
  const r = rpc(dir, [call('create_chg', { reserved_id: 'CHG-20260815-07', title: '未预留', tasks: ['甲'] }, dir)]);
  assert.strictEqual(r.out[1].result.isError, true, textOf(r.out[1]));
  assert.strictEqual(sc(r.out[1]).code, 'hook-deny', textOf(r.out[1]));
  assert.ok(!fs.existsSync(path.join(dir, 'changes', 'chg-20260815-07-untitled.md')));
  assert.ok(!fs.readFileSync(path.join(dir, 'task.md'), 'utf8').includes('chg-20260815-07'), 'task.md 未被改');
});

test('MS-E4 边界:approve 幂等;approve-and-start 对 completed 拒绝;verify 非 completed 拒绝;review 未 verified 拒绝;缺字段报 missing-fields;未实现工具报 not-implemented', () => {
  const dir = makeProject('ms-e4');
  const r1 = rpc(dir, [call('reserve_artifact_id', {}, dir)]);
  const id = sc(r1.out[1]).reserved[0].reserved_id;
  const r2 = rpc(dir, [
    call('create_chg', { reserved_id: id, title: '边界', slug: 'edge', tasks: ['甲'] }, dir),
    call('update_chg', { target: id, action: 'approve', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
    call('update_chg', { target: id, action: 'approve', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
    call('update_chg', { target: id, action: 'verify', verify_summary: 'x' }, dir),
    call('update_chg', { target: id, action: 'review', review_confirmed: true, review_source: 'manual', review_findings: 'x' }, dir),
    call('update_chg', { target: id, action: 'approve-and-start', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
    call('close_chg', { target: id }, dir),
    call('update_chg', { target: 'CHG-19990101-99', action: 'approve', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
  ]);
  assert.strictEqual(r2.out[1].result.isError, false, textOf(r2.out[1]));
  assert.strictEqual(r2.out[2].result.isError, false);
  assert.strictEqual(sc(r2.out[3]).idempotent, true, `第二次 approve 应幂等:${textOf(r2.out[3])}`);
  assert.strictEqual(sc(r2.out[4]).code, 'format-violation', `verify 非 completed:${textOf(r2.out[4])}`);
  assert.strictEqual(sc(r2.out[5]).code, 'format-violation', `review 未 verified:${textOf(r2.out[5])}`);
  assert.strictEqual(sc(r2.out[6]).code, 'missing-fields', `approve-and-start 缺 task_id:${textOf(r2.out[6])}`);
  assert.strictEqual(sc(r2.out[7]).code, 'not-implemented');
  assert.strictEqual(sc(r2.out[8]).code, 'target-not-found');
  const content = fs.readFileSync(path.join(dir, 'changes', `${id.toLowerCase()}-edge.md`), 'utf8');
  assert.strictEqual((content.match(/<!-- APPROVED -->/g) || []).length, 1, 'APPROVED 只有一处');
  assert.ok(/^status: planned$/m.test(content), 'approve 不推 status');
});

test('MS-E5 update-status 全部 [x] → completed + task.md [x];[!] 带原因 → 工作记录行 + 索引 [!];[/] 恢复 → 索引回 [/]', () => {
  const dir = makeProject('ms-e5');
  const id = sc(rpc(dir, [call('reserve_artifact_id', {}, dir)]).out[1]).reserved[0].reserved_id;
  const r = rpc(dir, [
    call('create_chg', { reserved_id: id, title: '状态机', slug: 'sm', tasks: ['甲', '乙'] }, dir),
    call('update_chg', { target: id, action: 'approve-and-start', task_id: 'T-001', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-002', new_status: '[!]', status_reason: '等依赖' }, dir),
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-002', new_status: '[!]' }, dir),
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-002', new_status: '[/]' }, dir),
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-001', new_status: '[x]' }, dir),
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-002', new_status: '[x]' }, dir),
  ]);
  const taskAt = (i) => fs.readFileSync(path.join(dir, 'task.md'), 'utf8');
  assert.strictEqual(r.out[3].result.isError, false, textOf(r.out[3]));
  assert.strictEqual(sc(r.out[4]).code, 'missing-fields', '[!] 缺 status_reason 拒绝');
  assert.strictEqual(r.out[5].result.isError, false, textOf(r.out[5]));
  assert.strictEqual(r.out[7].result.isError, false, textOf(r.out[7]));
  const content = fs.readFileSync(path.join(dir, 'changes', `${id.toLowerCase()}-sm.md`), 'utf8');
  assert.ok(/^status: completed$/m.test(content), content.slice(0, 200));
  assert.ok(/T-002 暂停\/阻塞：等依赖/.test(content));
  assert.ok(new RegExp(`^- \\[x\\] \\[\\[${id.toLowerCase()}-sm\\|`, 'm').test(taskAt()), taskAt());
});

t.cleanupAll = function() {
  if (_origLogPath === undefined) delete process.env.PACE_LOG_PATH; else process.env.PACE_LOG_PATH = _origLogPath;
  if (_origVault === undefined) delete process.env.PACE_VAULT_PATH; else process.env.PACE_VAULT_PATH = _origVault;
  try { fs.rmSync(VAULT_TMP, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(LOG_PATH, { force: true }); fs.rmSync(`${LOG_PATH}.lock`, { force: true }); } catch (e) {}
  t.cleanup();
};
t.cleanupAll();
console.log(`\n[mcp-server] passed=${t.passed} failed=${t.failed}`);
process.exit(t.failed > 0 ? 1 : 0);
