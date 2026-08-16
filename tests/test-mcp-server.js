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
// env 必须在 require pace-utils 之前设好:in-process 用到的模块在加载时读 PACE_VAULT_PATH(否则 vault 场景会指到真实 vault)
const _origLogPath = process.env.PACE_LOG_PATH;
const LOG_PATH = path.join(os.tmpdir(), `pace-mcp-log-${Date.now()}-${process.pid}.log`);
process.env.PACE_LOG_PATH = LOG_PATH;
const _origVault = process.env.PACE_VAULT_PATH;
const VAULT_TMP = path.join(os.tmpdir(), `pace-mcp-vault-${Date.now()}`);
fs.mkdirSync(path.join(VAULT_TMP, 'projects'), { recursive: true });
process.env.PACE_VAULT_PATH = VAULT_TMP;
const paceUtils = require(path.join(PLUGIN, 'hooks', 'pace-utils'));
const { resolveCallContext, businessArgs } = require(path.join(PLUGIN, 'mcp', 'lib', 'context.js'));
const pipeline = require(path.join(PLUGIN, 'mcp', 'lib', 'writer-pipeline.js'));
const ops = require(path.join(PLUGIN, 'mcp', 'lib', 'artifact-ops.js'));
const t = createTestRunner('pace-mcp');
const { test, makeTmpDir } = t;

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
  const a = resolveCallContext({ arguments: { _pace_session_id: 'hook-s', _pace_cwd: dir }, _meta: meta(dir, 'hook-s') });
  assert.strictEqual(a.sessionId, 'hook-s'); assert.strictEqual(a.cwd, path.resolve(dir)); assert.strictEqual(a.source, 'hook');
  // 审计 P2-5:hook 注入与宿主 _meta 冲突 → fail-closed(不给「以哪个为准」留口子)
  const conflictS = resolveCallContext({ arguments: { _pace_session_id: 'hook-s', _pace_cwd: dir }, _meta: meta(dir, 'meta-s') });
  assert.strictEqual(conflictS.ok, false); assert.ok(/session 不一致/.test(conflictS.reason));
  const conflictC = resolveCallContext({ arguments: { _pace_session_id: 'hook-s', _pace_cwd: dir }, _meta: meta('/tmp/y', 'hook-s') });
  assert.strictEqual(conflictC.ok, false); assert.ok(/cwd 不一致/.test(conflictC.reason));
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

test('MS-U1b resolveCallContext:cwd 归一为 realpath(macOS /var→/private/var 符号链接场景,PR #6 CI 实证)', () => {
  const real = fs.realpathSync(os.tmpdir());
  const link = path.join(real, `pace-mcp-link-${process.pid}`);
  const target = path.join(real, `pace-mcp-target-${process.pid}`);
  fs.mkdirSync(target, { recursive: true });
  try { fs.symlinkSync(target, link, 'dir'); } catch (e) { return; } // 平台不支持符号链接则跳过
  try {
    const c = resolveCallContext({ arguments: {}, _meta: meta(link, 's') });
    assert.strictEqual(c.cwd, fs.realpathSync(target), '经符号链接传入的 cwd 应解析为真实路径');
  } finally { try { fs.rmSync(link, { force: true }); fs.rmSync(target, { recursive: true, force: true }); } catch (e) {} }
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
  assert.deepStrictEqual(out[1].result.tools.map((x) => x.name), ['get_context', 'reserve_artifact_id', 'create_chg', 'update_chg', 'close_chg', 'archive_chg', 'record_finding']);
  assert.strictEqual(out[0].result.protocolVersion, '2025-06-18');
  const weird = rpc(dir, [{ method: 'ping', params: {} }, { method: 'nope/x', params: {} }], { env: {} });
  assert.deepStrictEqual(weird.out[1].result, {}, 'ping → {}');
  assert.strictEqual(weird.out[2].error.code, -32601, '未知 method → -32601');
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
    call('update_finding', { target: id }, dir),
    call('update_chg', { target: 'CHG-19990101-99', action: 'approve', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
  ]);
  assert.strictEqual(r2.out[1].result.isError, false, textOf(r2.out[1]));
  assert.strictEqual(r2.out[2].result.isError, false);
  assert.strictEqual(sc(r2.out[3]).idempotent, true, `第二次 approve 应幂等:${textOf(r2.out[3])}`);
  assert.strictEqual(sc(r2.out[4]).code, 'format-violation', `verify 非 completed:${textOf(r2.out[4])}`);
  assert.strictEqual(sc(r2.out[5]).code, 'format-violation', `review 未 verified:${textOf(r2.out[5])}`);
  assert.strictEqual(sc(r2.out[6]).code, 'missing-fields', `approve-and-start 缺 task_id:${textOf(r2.out[6])}`);
  assert.strictEqual(sc(r2.out[7]).code, 'not-implemented', 'update_finding 仍未实现');
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
  const taskAt = () => fs.readFileSync(path.join(dir, 'task.md'), 'utf8');
  assert.strictEqual(r.out[3].result.isError, false, textOf(r.out[3]));
  assert.strictEqual(sc(r.out[4]).code, 'missing-fields', '[!] 缺 status_reason 拒绝');
  assert.strictEqual(r.out[5].result.isError, false, textOf(r.out[5]));
  assert.strictEqual(r.out[7].result.isError, false, textOf(r.out[7]));
  // 中间态:分步重跑同一序列到 [!] 与 [/] 恢复点,断言索引 checkbox(审计 P2-8:原用例名实不符)
  const dir2 = makeProject('ms-e5-mid');
  const id2 = sc(rpc(dir2, [call('reserve_artifact_id', {}, dir2)]).out[1]).reserved[0].reserved_id;
  rpc(dir2, [
    call('create_chg', { reserved_id: id2, title: '状态机中间态', slug: 'sm2', tasks: ['甲', '乙'] }, dir2),
    call('update_chg', { target: id2, action: 'approve-and-start', task_id: 'T-001', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir2),
    call('update_chg', { target: id2, action: 'update-status', section: 'tasks', task_id: 'T-002', new_status: '[!]', status_reason: '等依赖' }, dir2),
  ]);
  assert.ok(new RegExp(`^- \\[!\\] \\[\\[${id2.toLowerCase()}-sm2\\|`, 'm').test(fs.readFileSync(path.join(dir2, 'task.md'), 'utf8')), '[!] 后索引为 [!]');
  rpc(dir2, [call('update_chg', { target: id2, action: 'update-status', section: 'tasks', task_id: 'T-002', new_status: '[/]' }, dir2)]);
  assert.ok(new RegExp(`^- \\[/\\] \\[\\[${id2.toLowerCase()}-sm2\\|`, 'm').test(fs.readFileSync(path.join(dir2, 'task.md'), 'utf8')), '[/] 恢复后索引回 [/]');
  const content = fs.readFileSync(path.join(dir, 'changes', `${id.toLowerCase()}-sm.md`), 'utf8');
  assert.ok(/^status: completed$/m.test(content), content.slice(0, 200));
  assert.ok(/T-002 暂停\/阻塞：等依赖/.test(content));
  assert.ok(new RegExp(`^- \\[x\\] \\[\\[${id.toLowerCase()}-sm\\|`, 'm').test(taskAt()), taskAt());
});

test('MS-E6 close_chg 一把梭:任务收口 → 实施详情 ### T-NNN → completed → VERIFIED → REVIEWED → archived + task.md 移 ARCHIVE + walkthrough 行;二次调用幂等', () => {
  const dir = makeProject('ms-e6');
  const id = sc(rpc(dir, [call('reserve_artifact_id', {}, dir)]).out[1]).reserved[0].reserved_id;
  const closeArgs = { target: id, verification_confirmed: true, complete_open_tasks: true, review_confirmed: true, review_source: 'opus-audit', review_findings: 'P0×0 / P1×0 / P2×1(record-finding [[finding-x]]) / P3×0', verify_summary: 'node tests 9/9', implementation_notes: ['T-001: 改了 a.js', 'T-002: 加了测试'], walkthrough_summary: 'close 冒烟完成' };
  const r = rpc(dir, [
    call('create_chg', { reserved_id: id, title: 'close 冒烟', slug: 'close-e2e', tasks: ['甲', '乙'], background: 'why', scope: 'what', technical_decision: 'how' }, dir),
    call('update_chg', { target: id, action: 'approve-and-start', task_id: 'T-001', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
    call('close_chg', closeArgs, dir),
    call('close_chg', closeArgs, dir),
  ]);
  for (let i = 1; i <= 4; i++) assert.strictEqual(r.out[i].result.isError, false, `step ${i}: ${textOf(r.out[i])}`);
  assert.deepStrictEqual(sc(r.out[4]).files, { created: [], modified: [] }, `二次 close 应零写入:${textOf(r.out[4])}`);
  const detail = fs.readFileSync(path.join(dir, 'changes', `${id.toLowerCase()}-close-e2e.md`), 'utf8');
  const fm = paceUtils.parseFrontmatter(detail);
  assert.strictEqual(String(fm.status), 'archived');
  assert.ok(paceUtils.validateFrontmatterSchema('chg', 'archived', fm).ok, JSON.stringify(paceUtils.validateFrontmatterSchema('chg', 'archived', fm)));
  assert.ok(/^archived-date: \d{4}-/m.test(detail) && /^verified-date: \d{4}-/m.test(detail) && /^reviewed-date: \d{4}-/m.test(detail));
  assert.ok(/- \[x\] T-001 甲\n- \[x\] T-002 乙\n\n<!-- APPROVED -->\n<!-- VERIFIED -->\n<!-- REVIEWED -->\n\n## 实施详情/.test(detail), detail.slice(0, 600));
  assert.ok(!detail.includes(ops.PLACEHOLDER_LINE), '占位行已删');
  assert.ok(/\*\*技术决策（How）\*\*：how\n\n### T-001\n\n改了 a\.js\n\n### T-002\n\n加了测试\n\n## 工作记录/.test(detail), detail.slice(300, 900));
  assert.ok(/\| 验证通过：node tests 9\/9 \|/.test(detail));
  assert.ok(/## 审查记录\n\n\| 日期 \| 审计来源 \| findings \|\n\| --- \| --- \| --- \|\n\| \d{4}-\d{2}-\d{2} \| opus-audit \| P0×0/.test(detail));
  const task = fs.readFileSync(path.join(dir, 'task.md'), 'utf8');
  const [active, archived] = task.split('<!-- ARCHIVE -->');
  assert.ok(!active.includes(id.toLowerCase()), '活跃区无该行');
  assert.ok(new RegExp(`^- \\[x\\] \\[\\[${id.toLowerCase()}-close-e2e\\|${id.toLowerCase()}\\]\\] close 冒烟 #change`, 'm').test(archived), archived);
  assert.strictEqual((task.match(/close-e2e/g) || []).length, 1, '索引行只有一份');
  const walk = fs.readFileSync(path.join(dir, 'walkthrough.md'), 'utf8');
  assert.ok(new RegExp(`\\| \\d{4}-\\d{2}-\\d{2} \\| \\[\\[${id.toLowerCase()}-close-e2e\\\\\\|${id.toLowerCase()}\\]\\] close 冒烟完成 \\[worktree:: [^\\]]+\\] \\[branch:: [^\\]]+\\] \\| ${id} \\|`).test(walk), walk);
  assert.strictEqual((walk.match(/close 冒烟完成/g) || []).length, 1, 'walkthrough 行只有一份(幂等)');
  assert.deepStrictEqual(paceUtils.validateWalkthroughLinks(dir), [], 'walkthrough 行经 hooks 侧解析零 issue');
});

test('MS-E7 close_chg 边界:缺 review_confirmed → missing-fields;有 [!] 任务 → format-violation;缺 APPROVED → format-violation;record_finding 边界(summary>200 / type 非法 / rejected 缺理由)', () => {
  const dir = makeProject('ms-e7');
  const id = sc(rpc(dir, [call('reserve_artifact_id', {}, dir)]).out[1]).reserved[0].reserved_id;
  const base = { target: id, verification_confirmed: true, complete_open_tasks: true, review_source: 'manual', review_findings: 'x', verify_summary: 'y', implementation_notes: ['T-001: z'], walkthrough_summary: 'w' };
  const r = rpc(dir, [
    call('create_chg', { reserved_id: id, title: '边界', slug: 'edge2', tasks: ['甲', '乙'] }, dir),
    call('close_chg', { ...base, review_confirmed: true }, dir), // 未 APPROVED
    call('update_chg', { target: id, action: 'approve-and-start', task_id: 'T-001', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
    call('close_chg', base, dir), // 缺 review_confirmed
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-002', new_status: '[!]', status_reason: '等依赖' }, dir),
    call('close_chg', { ...base, review_confirmed: true }, dir), // [!] 任务
    call('record_finding', { title: 't', summary: 'x'.repeat(201), type: 'research', impact: 'P3', body: 'b' }, dir),
    call('record_finding', { title: 't', summary: 's', type: 'doc-drift', impact: 'P3', body: 'b' }, dir),
    call('record_finding', { title: 't', summary: 's', type: 'research', impact: 'P3', body: 'b', status: 'rejected', rejection_reason: '短' }, dir),
  ]);
  assert.strictEqual(sc(r.out[2]).code, 'format-violation', textOf(r.out[2]));
  assert.strictEqual(sc(r.out[4]).code, 'missing-fields', textOf(r.out[4]));
  assert.strictEqual(sc(r.out[6]).code, 'format-violation', textOf(r.out[6]));
  assert.ok(/blocked|\[!\]/.test(sc(r.out[6]).message));
  assert.strictEqual(sc(r.out[7]).code, 'format-violation'); assert.strictEqual(sc(r.out[8]).code, 'format-violation'); assert.strictEqual(sc(r.out[9]).code, 'missing-fields');
  assert.ok(!fs.existsSync(path.join(dir, 'changes', 'findings', `finding-${ops.todayLocal()}-t.md`)), '失败不落盘');
});

test('MS-E8 record_finding:详情 3-key frontmatter + body 原样 + findings.md 最新在顶;related_changes 解析为全名+别名;rejected → [-] + 拒绝理由段;slug 碰撞加序号', () => {
  const dir = makeProject('ms-e8');
  const id = sc(rpc(dir, [call('reserve_artifact_id', {}, dir)]).out[1]).reserved[0].reserved_id;
  const body = '第一段\n\n```js\nconst a = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  const r = rpc(dir, [
    call('create_chg', { reserved_id: id, title: '关联', slug: 'rel', tasks: ['甲'] }, dir),
    call('record_finding', { title: '第一条', summary: '摘要一', type: 'research', impact: 'P2', body, slug: 'first', related_changes: [id] }, dir),
    call('record_finding', { title: '第二条', summary: '摘要二', type: 'bug-report', impact: 'P1', body: 'b2', slug: 'first' }, dir),
    call('record_finding', { title: '第三条 rejected', summary: '摘要三', type: 'observation', impact: 'P3', body: 'b3', slug: 'third', status: 'rejected', rejection_reason: '判定不修,理由足够长' }, dir),
  ]);
  for (let i = 1; i <= 4; i++) assert.strictEqual(r.out[i].result.isError, false, `step ${i}: ${textOf(r.out[i])}`);
  const today = ops.todayLocal();
  const f1 = fs.readFileSync(path.join(dir, 'changes', 'findings', `finding-${today}-first.md`), 'utf8');
  assert.ok(f1.startsWith(`---\nstatus: open\ndate: ${today}\nschema-version: "7.0"\n---\n\n# 第一条\n\n第一段\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n| a | b |`), f1);
  assert.ok(paceUtils.validateFrontmatterSchema('finding', 'open', paceUtils.parseFrontmatter(f1)).ok);
  assert.ok(fs.existsSync(path.join(dir, 'changes', 'findings', `finding-${today}-first-2.md`)), 'slug 碰撞加 -2');
  const f3 = fs.readFileSync(path.join(dir, 'changes', 'findings', `finding-${today}-third.md`), 'utf8');
  assert.ok(/^status: rejected$/m.test(f3) && /## 拒绝理由\n\n判定不修,理由足够长/.test(f3), f3);
  const idx = fs.readFileSync(path.join(dir, 'findings.md'), 'utf8').split('\n').filter((l) => l.startsWith('- ['));
  assert.strictEqual(idx.length, 3);
  assert.ok(idx[0].startsWith(`- [-] [[finding-${today}-third|第三条 rejected]] — 摘要三 #finding [date:: ${today}] [impact:: P3] [type:: observation]`), idx[0]);
  assert.ok(idx[1].startsWith(`- [ ] [[finding-${today}-first-2|第二条]]`), idx[1]);
  assert.ok(idx[2].includes(`[change:: [[${id.toLowerCase()}-rel|${id.toLowerCase()}]]]`), idx[2]);
});

test('MS-E9 archive_chg:全 [-] → cancelled(update-status 同步写 archived-date)→ 取消式归档([-] 移 ARCHIVE);archived 后 update-status 拒绝;缺 ARCHIVE 标记时 close 自动补标记', () => {
  const dir = makeProject('ms-e9');
  const id = sc(rpc(dir, [call('reserve_artifact_id', {}, dir)]).out[1]).reserved[0].reserved_id;
  const r = rpc(dir, [
    call('create_chg', { reserved_id: id, title: '取消', slug: 'cancel', tasks: ['甲', '乙'] }, dir),
    call('update_chg', { target: id, action: 'approve-and-start', task_id: 'T-001', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-001', new_status: '[-]' }, dir),
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-002', new_status: '[-]' }, dir),
    call('close_chg', { target: id, verification_confirmed: true, complete_open_tasks: true, review_confirmed: true, review_source: 'manual', review_findings: 'x', verify_summary: 'y', implementation_notes: ['T-001: z'], walkthrough_summary: 'w' }, dir),
    call('archive_chg', { target: id, walkthrough_summary: '放弃执行' }, dir),
    call('update_chg', { target: id, action: 'update-status', section: 'tasks', task_id: 'T-001', new_status: '[x]' }, dir),
  ]);
  const detail = fs.readFileSync(path.join(dir, 'changes', `${id.toLowerCase()}-cancel.md`), 'utf8');
  assert.strictEqual(r.out[4].result.isError, false, textOf(r.out[4]));
  assert.ok(/^status: cancelled$/m.test(detail) && /^archived-date: \d{4}-/m.test(detail), `全 [-] → cancelled 且 archived-date 已填:\n${detail.slice(0, 300)}`);
  assert.ok(paceUtils.validateFrontmatterSchema('chg', 'cancelled', paceUtils.parseFrontmatter(detail)).ok, 'cancelled 满足封闭合同(archived-date 必填)');
  assert.strictEqual(sc(r.out[5]).code, 'format-violation', 'close 拒绝 cancelled');
  assert.strictEqual(r.out[6].result.isError, false, `archive_chg 取消式归档:${textOf(r.out[6])}`);
  const task = fs.readFileSync(path.join(dir, 'task.md'), 'utf8');
  const [active, archived] = task.split('<!-- ARCHIVE -->');
  assert.ok(!active.includes(id.toLowerCase()) && new RegExp(`^- \\[-\\] \\[\\[${id.toLowerCase()}-cancel\\|`, 'm').test(archived), task);
  assert.ok(/放弃执行/.test(fs.readFileSync(path.join(dir, 'walkthrough.md'), 'utf8')));
  assert.strictEqual(sc(r.out[7]).code, 'format-violation', 'cancelled 详情已归档态,update-status 不可再改? (cancelled 未 archived 状态字段仍 cancelled)');
  // 缺 ARCHIVE 标记:close 自动补标记
  const dir2 = makeProject('ms-e9b');
  fs.writeFileSync(path.join(dir2, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n', 'utf8');
  const id2 = sc(rpc(dir2, [call('reserve_artifact_id', {}, dir2)]).out[1]).reserved[0].reserved_id;
  fs.writeFileSync(path.join(dir2, 'task.md'), '# 项目任务追踪\n\n## 活跃任务\n\n\n<!-- ARCHIVE -->\n', 'utf8');
  const r2 = rpc(dir2, [
    call('create_chg', { reserved_id: id2, title: '补标记', slug: 'marker', tasks: ['甲'] }, dir2),
    call('update_chg', { target: id2, action: 'approve-and-start', task_id: 'T-001', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir2),
  ]);
  assert.strictEqual(r2.out[2].result.isError, false, textOf(r2.out[2]));
  const t2 = fs.readFileSync(path.join(dir2, 'task.md'), 'utf8').replace(/\n<!-- ARCHIVE -->\n?$/, '\n');
  fs.writeFileSync(path.join(dir2, 'task.md'), t2, 'utf8');
  assert.ok(!t2.includes('<!-- ARCHIVE -->'));
  const r3 = rpc(dir2, [call('close_chg', { target: id2, verification_confirmed: true, complete_open_tasks: true, review_confirmed: true, review_source: 'manual', review_findings: 'x', verify_summary: 'y', implementation_notes: ['T-001: z'], walkthrough_summary: 'w' }, dir2)]);
  assert.strictEqual(r3.out[1].result.isError, false, textOf(r3.out[1]));
  const t3 = fs.readFileSync(path.join(dir2, 'task.md'), 'utf8');
  assert.ok(t3.includes('<!-- ARCHIVE -->\n- [x] [[' + id2.toLowerCase() + '-marker|'), t3);
});

test('MS-E10 CRLF artifact:create/approve/close 全链路正常(hook 会把 CRLF 归一为 LF,生成器与管线按 LF 匹配——审计 P0-1)', () => {
  const dir = makeProject('ms-e10');
  for (const f of ['task.md', 'walkthrough.md', 'findings.md']) fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(dir, f), 'utf8').replace(/\n/g, '\r\n'), 'utf8');
  const id = sc(rpc(dir, [call('reserve_artifact_id', {}, dir)]).out[1]).reserved[0].reserved_id;
  const r = rpc(dir, [
    call('create_chg', { reserved_id: id, title: 'crlf', slug: 'crlf', tasks: ['甲'] }, dir),
    call('update_chg', { target: id, action: 'approve-and-start', task_id: 'T-001', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
    call('close_chg', { target: id, verification_confirmed: true, complete_open_tasks: true, review_confirmed: true, review_source: 'manual', review_findings: 'x', verify_summary: 'y', implementation_notes: ['T-001: z'], walkthrough_summary: 'crlf ok' }, dir),
    call('record_finding', { title: 'crlf finding', summary: 's', type: 'research', impact: 'P3', body: 'b', slug: 'crlf-f' }, dir),
  ]);
  for (let i = 1; i <= 4; i++) assert.strictEqual(r.out[i].result.isError, false, `step ${i}: ${textOf(r.out[i])}`);
  const detail = fs.readFileSync(path.join(dir, 'changes', `${id.toLowerCase()}-crlf.md`), 'utf8');
  assert.ok(/^status: archived$/m.test(detail) && !detail.includes('\r'), 'CRLF 项目上 close 后详情 LF 且 archived');
  assert.ok(fs.readFileSync(path.join(dir, 'walkthrough.md'), 'utf8').includes('crlf ok'));
  // 详情文件手工写成 CRLF 后再 append,仍能命中锚点
  const dir2 = makeProject('ms-e10b');
  const id2 = sc(rpc(dir2, [call('reserve_artifact_id', {}, dir2)]).out[1]).reserved[0].reserved_id;
  rpc(dir2, [call('create_chg', { reserved_id: id2, title: 'crlf2', slug: 'crlf2', tasks: ['甲'] }, dir2)]);
  const dp = path.join(dir2, 'changes', `${id2.toLowerCase()}-crlf2.md`);
  fs.writeFileSync(dp, fs.readFileSync(dp, 'utf8').replace(/\n/g, '\r\n'), 'utf8');
  const r2 = rpc(dir2, [call('update_chg', { target: id2, action: 'append', section: 'implementation', content: '补充说明' }, dir2)]);
  assert.strictEqual(r2.out[1].result.isError, false, textOf(r2.out[1]));
  assert.ok(/不在此预填占位符。）\n\n补充说明\n/.test(fs.readFileSync(dp, 'utf8')), 'implementation append 与前文隔一空行(审计 P3-2)');
});

test('MS-E11 边界簇:walkthrough 归档区也有表头/分隔行仍能 close;findings 活跃区无 finding 行且标题重复仍能记录;implementation_notes 未知 T-NNN 拒绝;tasks 重复编号拒绝;HOTFIX 索引 #hotfix + 大写别名', () => {
  const dir = makeProject('ms-e11');
  fs.appendFileSync(path.join(dir, 'walkthrough.md'), '\n| 日期 | 完成内容 | 关联变更 |\n| --- | --- | --- |\n| 2026-01-01 | [[chg-20260101-01]] 旧 | CHG-20260101-01 |\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'findings.md'), '# 调研记录\n\n## 摘要索引\n\n## 未解决问题\n\n<!-- ARCHIVE -->\n## 未解决问题\n\n- [x] [[finding-2026-01-01-old|旧]] — 旧 #finding [date:: 2026-01-01] [impact:: P3] [type:: research]\n', 'utf8');
  const id = sc(rpc(dir, [call('reserve_artifact_id', {}, dir)]).out[1]).reserved[0].reserved_id;
  const hot = sc(rpc(dir, [call('reserve_artifact_id', { type: 'hotfix', new: true }, dir)]).out[1]).reserved[0].reserved_id;
  assert.ok(/^HOTFIX-/.test(hot), hot);
  const r = rpc(dir, [
    call('create_chg', { reserved_id: id, title: '边界簇', slug: 'edge3', tasks: ['甲'] }, dir),
    call('create_chg', { reserved_id: hot, title: '热修', slug: 'hot', tasks: ['甲'] }, dir),
    call('update_chg', { target: id, action: 'approve-and-start', task_id: 'T-001', approval_confirmed: true, approval_source: 'user-directive', approval_evidence: 'ok' }, dir),
    call('close_chg', { target: id, verification_confirmed: true, complete_open_tasks: true, review_confirmed: true, review_source: 'manual', review_findings: 'x', verify_summary: 'y', implementation_notes: ['T-999: 不存在'], walkthrough_summary: 'w' }, dir),
    call('close_chg', { target: id, verification_confirmed: true, complete_open_tasks: true, review_confirmed: true, review_source: 'manual', review_findings: 'x', verify_summary: 'y', implementation_notes: ['T-001: z'], walkthrough_summary: '双分隔行也能归档' }, dir),
    call('record_finding', { title: '无索引行', summary: 's', type: 'research', impact: 'P3', body: 'b', slug: 'noidx' }, dir),
    call('create_chg', { reserved_id: 'CHG-20990101-01', title: 'dup', tasks: ['T-001: a', 'T-001: b'] }, dir),
  ]);
  assert.strictEqual(r.out[1].result.isError, false, textOf(r.out[1]));
  assert.strictEqual(r.out[2].result.isError, false, textOf(r.out[2]));
  const task = fs.readFileSync(path.join(dir, 'task.md'), 'utf8');
  assert.ok(new RegExp(`^- \\[ \\] \\[\\[${hot.toLowerCase()}-hot\\|${hot}\\]\\] 热修 #hotfix `, 'm').test(task), task);
  assert.strictEqual(sc(r.out[4]).code, 'format-violation', `未知 T-999 应拒绝:${textOf(r.out[4])}`);
  assert.strictEqual(r.out[5].result.isError, false, `双分隔行 walkthrough 仍能 close:${textOf(r.out[5])}`);
  const walk = fs.readFileSync(path.join(dir, 'walkthrough.md'), 'utf8');
  assert.ok(walk.indexOf('双分隔行也能归档') < walk.indexOf('| 2026-01-01 |'), '新行插在活跃区表头下,不进归档区');
  assert.strictEqual(r.out[6].result.isError, false, `重复标题 findings 仍能记录:${textOf(r.out[6])}`);
  const findings = fs.readFileSync(path.join(dir, 'findings.md'), 'utf8');
  assert.ok(findings.indexOf('finding-') < findings.indexOf('<!-- ARCHIVE -->'), '新 finding 在活跃区');
  assert.strictEqual(sc(r.out[7]).code, 'format-violation', `重复 T-001 应拒绝:${textOf(r.out[7])}`);
});

test('MS-E12 长驻进程缓存失效:同一 server 进程内先后两次 get_context,中间切 artifact-root 到 vault → 第二次报新目录(审计 P1-3)', () => {
  const dir = makeProject('ms-e12');
  const server = require(SERVER);
  const captured = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {}, _meta: meta(dir, 's-e12') } });
    const first = JSON.parse(captured.pop()).result.structuredContent.artifact_dir;
    assert.strictEqual(path.resolve(first), path.resolve(dir));
    const sw = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'set-artifact-root.js'), '--choice', 'vault'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    assert.strictEqual(sw.status, 0, sw.stdout + sw.stderr);
    server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_context', arguments: {}, _meta: meta(dir, 's-e12') } });
    const second = JSON.parse(captured.pop()).result.structuredContent.artifact_dir;
    assert.ok(second.startsWith(path.join(VAULT_TMP, 'projects')), `切 vault 后应报新目录,实得 ${second}`);
  } finally { process.stdout.write = orig; }
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
