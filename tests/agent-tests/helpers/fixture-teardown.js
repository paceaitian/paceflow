/**
 * fixture-teardown.js
 *
 * 删除临时 vault 目录。安全：仅删除系统临时目录（os.tmpdir()）下的路径。
 * 跨平台：POSIX 下 os.tmpdir() 通常是 /tmp，Windows 下是 %TEMP%——
 * 原先硬编码 startsWith('/tmp/') 在 Windows 会对合法临时路径误抛。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function teardown(targetDir) {
  if (!targetDir || typeof targetDir !== 'string') return;
  const resolved = path.resolve(targetDir);
  const tmpRoot = path.resolve(os.tmpdir());
  // 必须严格位于临时根目录之下（加分隔符防 /tmpfoo 这类兄弟前缀误判）。
  if (resolved !== tmpRoot && !resolved.startsWith(tmpRoot + path.sep)) {
    throw new Error(`Refuse to teardown path outside os.tmpdir(): ${targetDir}`);
  }
  if (!fs.existsSync(resolved)) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

module.exports = { teardown };
