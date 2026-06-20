#!/usr/bin/env node
// Pre-reserve artifact IDs for artifact-writer prompts.

const fs = require('fs');
const path = require('path');
const paceUtils = require('./pace-utils');
const { flagValue } = require('./pace-utils/cli-args');

const LOG_PATH = paceUtils.defaultLogPath();
const log = paceUtils.createLogger(LOG_PATH);

function parseArgs(argv) {
  const args = { operation: '', type: '', cwd: '', sessionId: '', newReservation: false, count: null, help: false, unknown: [], missingValue: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--new') {
      args.newReservation = true;
    } else if (arg === '--operation' || arg === '-o') {
      const v = flagValue(argv, i); if (v === null) args.missingValue.push(arg); else { args.operation = v; i++; }
    } else if (arg === '--type' || arg === '--kind') {
      const v = flagValue(argv, i); if (v === null) args.missingValue.push(arg); else { args.type = v; i++; }
    } else if (arg === '--cwd') {
      const v = flagValue(argv, i); if (v === null) args.missingValue.push(arg); else { args.cwd = v; i++; }
    } else if (arg === '--session-id') {
      const v = flagValue(argv, i); if (v === null) args.missingValue.push(arg); else { args.sessionId = v; i++; }
    } else if (arg === '--count') {
      // 与其他 flag 同口径用 flagValue peek（CHG-20260614-14 补 A4 缺口）：后跟另一个 flag 或缺失
      // 即 missingValue fail-closed，不吞后续 flag、不静默回落（args.count 留 null 由 missingValue 拦）。
      const v = flagValue(argv, i); if (v === null) args.missingValue.push(arg); else { args.count = v; i++; }
    } else if (arg.startsWith('-')) {
      args.unknown.push(arg);
    } else if (!args.operation && !arg.startsWith('-')) {
      args.operation = arg;
    } else {
      args.unknown.push(arg); // 多余 positional fail-closed 计入 unknown（CHG-20260620-01，审计 P3-3：与 unknown-flag 对称，不静默丢弃）
    }
  }
  args.operation = args.operation.trim().toLowerCase();
  args.type = args.type.trim().toLowerCase();
  args.cwd = args.cwd ? path.resolve(args.cwd) : paceUtils.resolveProjectCwd();
  args.sessionId = paceUtils.normalizeSessionId(args.sessionId || paceUtils.currentSessionId());
  return args;
}

function usage() {
  return [
    'Usage:',
    `  node "${paceUtils.RESERVE_ARTIFACT_ID_SCRIPT}" --operation create-chg [--type hotfix] [--count N] [--new] [--cwd <project-cwd>]`,
    `  node "${paceUtils.RESERVE_ARTIFACT_ID_SCRIPT}" --operation record-correction [--new] [--cwd <project-cwd>]`,
    '',
    'Run this from the main session before dispatching paceflow:artifact-writer.',
  ].join('\n');
}

function reservationConsumed(artDir, reservation) {
  if (reservation.fileRel) return fs.existsSync(path.join(artDir, reservation.fileRel));
  if (reservation.filePrefix) {
    const dir = path.join(artDir, path.dirname(reservation.filePrefix));
    const base = path.basename(reservation.filePrefix);
    try {
      return fs.readdirSync(dir).some(file => file.startsWith(base) && file.endsWith('.md'));
    } catch(e) {
      return false;
    }
  }
  return false;
}

function reusableReservation(cwd, artDir, sessionId, operation) {
  const existing = paceUtils.readArtifactReservation(cwd, { sessionId });
  if (!existing || existing.operation !== operation) return null;
  if (existing.timestampMs && Date.now() - existing.timestampMs > paceUtils.ARTIFACT_WRITER_LOCK_TTL_MS) return null;
  if (reservationConsumed(artDir, existing)) {
    const rel = existing.fileRel || (existing.filePrefix ? `${existing.filePrefix}used.md` : '');
    if (rel) paceUtils.clearArtifactReservationForRel(cwd, { sessionId }, rel);
    return null;
  }
  return existing;
}

function promptForReservation(operation, type) {
  const lines = [`operation: ${operation}`];
  if (operation === 'create-chg' && type) lines.push(`type: ${type}`);
  return lines.join('\n');
}

function formatReservationBlock(cwd, artDir, operation, reservation, reused) {
  const context = paceUtils.executionContextForCwd(cwd);
  const lines = [
    `artifact_dir: ${paceUtils.displayDir(artDir)}`,
    `operation: ${operation}`,
  ];
  lines.push(`project-root: ${context.projectRoot.replace(/\\/g, '/')}`);
  if (operation === 'create-chg') lines.push(`execution-context: ${context.text}`);
  if (reservation.id) lines.push(`reserved-id: ${reservation.id}`);
  if (reservation.fileRel) lines.push(`reserved-file: ${reservation.fileRel}`);
  if (reservation.filePrefix) {
    lines.push(`reserved-file-prefix: ${reservation.filePrefix}<slug>.md`);
    lines.push('（reserved-file-prefix 原样保留末尾 `<slug>.md` 占位——slug 由 artifact-writer 按 title 生成，caller 不要替换它）');
  }
  lines.push('把以上字段原样放到 paceflow:artifact-writer prompt 顶部；不要让 agent 扫描索引分配编号。');
  if (reused) lines.push('已复用当前 session 尚未消费的 reservation；如确实要再创建一个新编号，请重新运行本 helper 并加 --new。');
  return lines.join('\n');
}

function fail(cwd, action, message, fields = {}) {
  log(paceUtils.logEntry('ReserveID', action, { proj: paceUtils.getProjectName(cwd), ...fields }));
  process.stdout.write(`${message}\n`);
  process.exitCode = 2;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.unknown.length > 0) {
    fail(args.cwd, 'DENY_UNKNOWN_OPTION', `reserve-artifact-id 不支持参数：${args.unknown.join(', ')}。\n本 helper 从目标项目 cwd 和 .pace/artifact-root 配置解析 artifact_dir；不要传 --artifact-dir / --artifact-root / --project-dir。\n请在目标项目 cwd 中运行；自动化场景只可用 --cwd 明确项目 cwd。\n\n${usage()}`, { options: args.unknown.join(',') });
    return;
  }
  if (args.missingValue.length > 0) {
    fail(args.cwd, 'DENY_MISSING_VALUE', `reserve-artifact-id 参数缺值：${args.missingValue.join(', ')} 后未跟有效值（下一项是 flag 或缺失）。\n不吞后续 flag、不静默回落空值；请补全值后重试。\n\n${usage()}`, { missing: args.missingValue.join(',') });
    return;
  }
  if (!['create-chg', 'record-correction'].includes(args.operation)) {
    fail(args.cwd, 'DENY_INVALID_OPERATION', `reserve-artifact-id 只支持 create-chg 或 record-correction。\n\n${usage()}`, { operation: args.operation || '-' });
    return;
  }
  if (args.operation === 'create-chg' && args.type && !['change', 'hotfix'].includes(args.type)) {
    fail(args.cwd, 'DENY_INVALID_TYPE', 'create-chg --type 只支持 change / hotfix；finding/research 请使用 artifact-writer record-finding，不通过 create-chg 预留。', { type: args.type });
    return;
  }
  const MAX_RESERVE_COUNT = 20;
  let count = 1;
  if (args.count !== null) {
    if (!/^\d+$/.test(args.count)) {
      fail(args.cwd, 'DENY_INVALID_COUNT', `reserve --count 必须是 1..${MAX_RESERVE_COUNT} 的十进制整数（收到：${args.count || '(空)'}）。\n--count 用于一次性批量预留多个连号 CHG（batch create CHG）。\n\n${usage()}`, { count: args.count });
      return;
    }
    const parsed = Number(args.count);
    if (parsed < 1 || parsed > MAX_RESERVE_COUNT) {
      fail(args.cwd, 'DENY_INVALID_COUNT', `reserve --count 必须在 1..${MAX_RESERVE_COUNT} 之间（收到：${parsed}）。一次规划过多 CHG 不利于可闭环拆分；如确需更多请分批预留。\n\n${usage()}`, { count: args.count });
      return;
    }
    if (parsed > 1 && args.operation !== 'create-chg') {
      fail(args.cwd, 'DENY_INVALID_COUNT', `--count >1 仅用于 create-chg 批量预留（batch create CHG）；${args.operation} 不支持批量预留。\n\n${usage()}`, { operation: args.operation, count: parsed });
      return;
    }
    count = parsed;
  }
  if (!args.sessionId) {
    fail(args.cwd, 'DENY_MISSING_SESSION', '缺少 CLAUDE_CODE_SESSION_ID，无法创建可被后续 artifact-writer Agent 匹配的 session reservation。请在 Claude Code 主 session 的 Bash 工具中运行本 helper。');
    return;
  }

  const configError = paceUtils.artifactRootConfigError(args.cwd);
  if (configError) {
    fail(args.cwd, 'DENY_ARTIFACT_ROOT_CONFIG', configError.message, { reason: configError.code });
    return;
  }
  if (paceUtils.artifactRootChoiceNeeded(args.cwd)) {
    fail(args.cwd, 'DENY_ARTIFACT_ROOT_CHOICE', paceUtils.artifactRootChoiceMessage(args.cwd));
    return;
  }
  const artDir = paceUtils.getArtifactDir(args.cwd);
  try { paceUtils.ensureProjectInfra(args.cwd); } catch(e) {}
  try { paceUtils.createTemplates(args.cwd); } catch(e) {
    fail(args.cwd, 'DENY_TEMPLATE_CREATE', `PACE hook 无法在 artifact_dir 创建完整 Artifact 基础结构：${paceUtils.displayDir(artDir)}\n底层错误：${e.message || String(e)}`, { artifact_dir: paceUtils.displayDir(artDir) });
    return;
  }

  if (count > 1) {
    const batch = paceUtils.reserveArtifactIds(args.cwd, {
      sessionId: args.sessionId,
      artifactDir: artDir,
      operation: args.operation,
      prompt: promptForReservation(args.operation, args.type),
    }, count);
    if (!batch.reserved || !batch.reservations.length) {
      const detail = batch.lock && batch.lock.ok
        ? paceUtils.formatArtifactResourceLock(batch.lock)
        : (batch.reason || 'unknown');
      fail(args.cwd, 'DENY_ID_RESERVATION', `PACE hook 无法为 ${args.operation} 批量预留 ${count} 个唯一编号，已停止以避免并发 ID 冲突。\n原因：${detail}`, { operation: args.operation, count, reason: batch.reason || '' });
      return;
    }
    log(paceUtils.logEntry('ReserveID', 'RESERVE_BATCH', {
      proj: paceUtils.getProjectName(args.cwd),
      operation: args.operation,
      artifact_dir: paceUtils.displayDir(artDir),
      count,
      reserved: batch.reservations.map(r => r.id || r.fileRel || r.filePrefix || '').join(','),
    }));
    const blocks = batch.reservations.map((r, idx) =>
      `# --- reserved ${idx + 1}/${count} ---\n${formatReservationBlock(args.cwd, artDir, args.operation, r, false)}`);
    process.stdout.write(`${blocks.join('\n\n')}\n`);
    return;
  }

  let reservation = null;
  let reused = false;
  if (!args.newReservation) {
    reservation = reusableReservation(args.cwd, artDir, args.sessionId, args.operation);
    reused = !!reservation;
  }
  if (!reservation) {
    reservation = paceUtils.reserveArtifactId(args.cwd, {
      sessionId: args.sessionId,
      artifactDir: artDir,
      operation: args.operation,
      prompt: promptForReservation(args.operation, args.type),
    });
  }
  if (!reservation || !reservation.reserved && !reservation.id && !reservation.fileRel && !reservation.filePrefix) {
    const detail = reservation && reservation.lock && reservation.lock.ok
      ? paceUtils.formatArtifactResourceLock(reservation.lock)
      : (reservation && reservation.reason || 'unknown');
    fail(args.cwd, 'DENY_ID_RESERVATION', `PACE hook 无法为 ${args.operation} 预留唯一编号，已停止以避免并发 ID 冲突。\n原因：${detail}`, { operation: args.operation, reason: reservation && reservation.reason || '' });
    return;
  }

  log(paceUtils.logEntry('ReserveID', reused ? 'REUSE' : 'RESERVE', {
    proj: paceUtils.getProjectName(args.cwd),
    operation: args.operation,
    artifact_dir: paceUtils.displayDir(artDir),
    reserved: reservation.id || reservation.fileRel || reservation.filePrefix || '',
  }));
  process.stdout.write(`${formatReservationBlock(args.cwd, artDir, args.operation, reservation, reused)}\n`);
}

main();
