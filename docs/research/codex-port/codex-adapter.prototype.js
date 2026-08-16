// 研究原型:Codex → PACEflow hook 适配层(不进产品)。
// 把 Codex 的 apply_patch 事件翻译成 PACEflow 认识的 Write/Edit 事件后转发给真 pre-tool-use.js;
// 其余工具原样透传。多文件 patch:逐文件转发,任一 deny 即整体 deny(fail-closed)。
const { spawnSync } = require('child_process');
const path = require('path');
const HOOK = process.argv[2]; // 真 hook 脚本路径
let raw = ''; process.stdin.on('data', c => raw += c); process.stdin.on('end', () => {
  let ev; try { ev = JSON.parse(raw); } catch (e) { process.exit(0); }
  // Codex session_id 优先(避免 CLAUDE_CODE_SESSION_ID 环境兜底串味)
  const forward = (obj) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(obj), encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: ev.session_id || '' } });
  if (ev.tool_name !== 'apply_patch') { const r = forward(ev); process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status || 0); }
  // 解析 apply_patch:*** Add File / *** Update File / *** Delete File
  const cmd = String((ev.tool_input || {}).command || '');
  const files = [];
  for (const m of cmd.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) files.push({ op: m[1], file: path.resolve(ev.cwd || process.cwd(), m[2].trim()) });
  if (files.length === 0) { process.exit(0); }
  for (const f of files) {
    const toolName = f.op === 'Add' ? 'Write' : 'Edit';
    const tool_input = f.op === 'Add' ? { file_path: f.file, content: '' } : { file_path: f.file, old_string: '', new_string: '' };
    const r = forward({ ...ev, tool_name: toolName, tool_input });
    if (r.stdout && r.stdout.includes('"deny"')) { process.stdout.write(r.stdout); process.exit(0); }
    if (r.status === 2) { process.stderr.write(r.stderr || ''); process.exit(2); }
  }
  process.exit(0);
});
