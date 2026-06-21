#!/usr/bin/env node
// PACEflow 激活状态 helper（CHG-B B1）：--enable / --disable / --status。
// disabled 标记写入 Project Root 的 runtime（.pace/disabled），控制 isPaceProject T-080 守卫
// 与 detectSoftSignal 的禁用判定；enable 删标记（既有强信号自动恢复），无强信号时首次启用
// 写项目根 .pace-enabled（manual 强信号）并引导选 artifact-root。
// disable 只写标记、不动任何 artifact——re-enable 零成本恢复（spec §5）。
// 照 set-project-root.js 模式：argv 解析 / fail() / 写 .pace + .gitignore / stdout 报告 / process.exitCode。

const fs = require('fs');
const path = require('path');
const paceUtils = require('./pace-utils');

const LOG_PATH = paceUtils.defaultLogPath();
const log = paceUtils.createLogger(LOG_PATH);
const SELF_PATH = path.resolve(__dirname, 'set-activation.js').replace(/\\/g, '/');

function parseArgs(argv) {
  const args = { action: '', cwd: '', session: '', help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--enable') {
      args.action = 'enable';
    } else if (arg === '--disable') {
      args.action = 'disable';
    } else if (arg === '--status') {
      args.action = 'status';
    } else if (arg === '--pause') {
      args.action = 'pause';
    } else if (arg === '--resume') {
      args.action = 'resume';
    } else if (arg === '--cwd') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) { args.unknown.push(arg); }
      else { args.cwd = String(argv[++i]); }
    } else if (arg === '--session') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) { args.unknown.push(arg); }
      else { args.session = String(argv[++i]); }
    } else if (arg.startsWith('-')) {
      args.unknown.push(arg);
    } else {
      // SA-1（v7.2.21 审计）：裸 positional 也 fail-closed 计入 unknown，与 CHG-20260620-01 加固的 4 helper 对称
      args.unknown.push(arg);
    }
  }
  args.cwd = args.cwd ? path.resolve(args.cwd) : paceUtils.resolveProjectCwd();
  return args;
}

function usage() {
  return [
    'Usage:',
    `  node "${SELF_PATH}" --enable  [--cwd <project-cwd>]`,
    `  node "${SELF_PATH}" --disable [--cwd <project-cwd>]`,
    `  node "${SELF_PATH}" --pause   [--cwd <project-cwd>] [--session <id>]`,
    `  node "${SELF_PATH}" --resume  [--cwd <project-cwd>] [--session <id>]`,
    `  node "${SELF_PATH}" --status  [--cwd <project-cwd>]`,
    '',
    '--enable  启用 PACEflow（删除 disabled 标记；既有 changes//配置自动恢复，否则首次启用并引导选 artifact-root）。',
    '--disable 禁用 PACEflow（写 .pace/disabled 标记；不删除任何 artifact，随时可 --enable 恢复）。',
    '--pause   仅本 session 暂停 PACEflow 流程门（sessionId 键控标志；session 结束自动失效，artifact 完整性门保留）。',
    '--resume  恢复本 session 的 PACEflow（删除 pause 标志）。',
    '--status  输出当前激活状态（enabled / disabled / inactive）与本 session paused 状态。',
  ].join('\n');
}

function disabledPath(cwd) {
  return path.join(paceUtils.getProjectRuntimeDir(cwd), 'disabled');
}

function paceEnabledPath(cwd) {
  // 与 isPaceProject 的 manual 信号检查路径一致：getProjectStateDir(cwd)/.pace-enabled（项目根）。
  return path.join(paceUtils.getProjectStateDir(cwd), '.pace-enabled');
}

function ensureRuntimeDir(cwd) {
  const dir = paceUtils.getProjectRuntimeDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n', 'utf8');
  return dir;
}

function fail(cwd, action, message, fields = {}) {
  log(paceUtils.logEntry('SetActivation', action, { proj: paceUtils.getProjectName(cwd), ...fields }));
  process.stdout.write(`${message}\n`);
  process.exitCode = 2;
}

// 当前激活态：disabled 标记存在（双路径，与 T-080 守卫同源）→ 'disabled'；
// 否则按 isPaceProject 真值 → 'enabled'，false → 'inactive'。
function currentState(cwd) {
  if (fs.existsSync(disabledPath(cwd)) || fs.existsSync(path.join(cwd, '.pace', 'disabled'))) return 'disabled';
  const signal = paceUtils.isPaceProject(cwd);
  return signal ? 'enabled' : 'inactive';
}

function doDisable(cwd) {
  try {
    ensureRuntimeDir(cwd);
    fs.writeFileSync(disabledPath(cwd), 'disabled\n', 'utf8');
  } catch (e) {
    fail(cwd, 'DENY_WRITE_FAILED', [
      `无法写入 disabled 标记：${disabledPath(cwd).replace(/\\/g, '/')}`,
      `底层错误：${e.message || String(e)}`,
      '可手动创建该文件（内容任意）以禁用 PACEflow。',
    ].join('\n'), { path: disabledPath(cwd) });
    return;
  }
  log(paceUtils.logEntry('SetActivation', 'DISABLE', { proj: paceUtils.getProjectName(cwd), path: disabledPath(cwd) }));
  process.stdout.write([
    'PACEflow 已禁用（disabled）。',
    `disabled-marker: ${disabledPath(cwd).replace(/\\/g, '/')}`,
    '本操作只写禁用标记，不删除任何 artifact（changes/ 等全部保留）。',
    '随时可运行 /paceflow:enable 或 set-activation --enable 恢复。',
  ].join('\n') + '\n');
}

function doEnable(cwd) {
  // 删 disabled 标记（runtime 与 cwd 两个可能位置都删，与 T-080 守卫双路径对称）。
  for (const fp of [disabledPath(cwd), path.join(cwd, '.pace', 'disabled')]) {
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {}
  }
  // 既有强信号（changes/ / 配置 / legacy / .pace-enabled）→ 删标记即自动恢复。
  const signalAfter = paceUtils.isPaceProject(cwd);
  if (signalAfter && signalAfter !== 'manual') {
    log(paceUtils.logEntry('SetActivation', 'ENABLE_RESTORE', { proj: paceUtils.getProjectName(cwd), signal: signalAfter }));
    process.stdout.write([
      'PACEflow 已启用（恢复既有项目）。',
      `signal: ${signalAfter}`,
      '既有 artifact / 配置已自动恢复，可继续按 PACE 流程工作。',
      '下一步：调用 Skill(paceflow:pace-workflow) 继续创建/恢复 CHG。',
    ].join('\n') + '\n');
    return;
  }
  if (signalAfter === 'manual') {
    // manual = .pace-enabled 标记或 artifact-root 配置存在，但不保证 changes/ 等真实 artifact 在——
    // 不称「恢复既有项目」（spec §5 恢复判据是既有 changes/），如实报告并给选 root 出口（已配置则忽略）。
    log(paceUtils.logEntry('SetActivation', 'ENABLE_MANUAL', { proj: paceUtils.getProjectName(cwd), signal: signalAfter }));
    process.stdout.write([
      'PACEflow 已启用（manual 标记）。',
      'signal: manual',
      '若尚未选择 artifact 存放位置，按下列命令选择（已配置过则忽略）：',
      `  node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice local --cwd "${cwd.replace(/\\/g, '/')}"`,
      `  node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice vault --cwd "${cwd.replace(/\\/g, '/')}"`,
      '之后调用 Skill(paceflow:pace-workflow) 创建/恢复 CHG。',
    ].join('\n') + '\n');
    return;
  }
  // 无强信号 → 首次启用：写项目根 .pace-enabled（manual 强信号）+ 引导选 artifact-root。
  try {
    fs.writeFileSync(paceEnabledPath(cwd), 'enabled\n', 'utf8');
  } catch (e) {
    fail(cwd, 'DENY_WRITE_FAILED', [
      `无法写入 .pace-enabled 标记：${paceEnabledPath(cwd).replace(/\\/g, '/')}`,
      `底层错误：${e.message || String(e)}`,
    ].join('\n'), { path: paceEnabledPath(cwd) });
    return;
  }
  log(paceUtils.logEntry('SetActivation', 'ENABLE_FIRST', { proj: paceUtils.getProjectName(cwd), path: paceEnabledPath(cwd) }));
  process.stdout.write([
    'PACEflow 已启用（首次）。',
    `enabled-marker: ${paceEnabledPath(cwd).replace(/\\/g, '/')}`,
    '下一步：选择 artifact 存放位置（用 AskUserQuestion 让用户选「Obsidian vault project」或「本地项目目录」，按选择运行其一）：',
    `  node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice local --cwd "${cwd.replace(/\\/g, '/')}"`,
    `  node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice vault --cwd "${cwd.replace(/\\/g, '/')}"`,
    '选择完成后调用 Skill(paceflow:pace-workflow) 创建首个 CHG。',
    '如需撤销启用，运行 /paceflow:disable。',
  ].join('\n') + '\n');
}

// CHG-20260611-03：--pause / --resume——session 级流程门暂停。仅用户经 /paceflow:pause 主动
// 运行（spec §5.1 不变量 2 对称且更严：AI 不得为绕过单次 deny 自行 pause）。
function resolveSessionId(explicit) {
  return paceUtils.normalizeSessionId(explicit || paceUtils.currentSessionId());
}

function doPause(cwd, explicitSession) {
  const sid = resolveSessionId(explicitSession);
  if (!sid) {
    fail(cwd, 'DENY_PAUSE_NO_SESSION', [
      '无法识别当前 session（CLAUDE_CODE_SESSION_ID 为空）。',
      '请在 Claude Code session 内运行，或显式传 --session <id>；不写无主标志。',
    ].join('\n'));
    return;
  }
  if (!paceUtils.writeSessionPause(cwd, sid)) {
    fail(cwd, 'DENY_PAUSE_WRITE_FAILED', '无法写入 pause 标志，请检查 .pace/ 目录可写。', { sid });
    return;
  }
  log(paceUtils.logEntry('SetActivation', 'PAUSE', { proj: paceUtils.getProjectName(cwd), sid }));
  process.stdout.write([
    'PACEflow 已在本 session 暂停（paused）。',
    `session: ${sid}`,
    '仅流程门（Stop / 写码门）跳过；artifact 仍只能经 artifact-writer 写入（完整性门保留）。',
    '本 session 结束自动失效；恢复运行 /paceflow:resume。',
  ].join('\n') + '\n');
}

function doResume(cwd, explicitSession) {
  const sid = resolveSessionId(explicitSession);
  if (!sid) {
    fail(cwd, 'DENY_RESUME_NO_SESSION', '无法识别当前 session（CLAUDE_CODE_SESSION_ID 为空）。请显式传 --session <id>。');
    return;
  }
  const cleared = paceUtils.clearSessionPause(cwd, sid);
  log(paceUtils.logEntry('SetActivation', 'RESUME', { proj: paceUtils.getProjectName(cwd), sid, cleared: cleared ? '1' : '0' }));
  process.stdout.write([
    cleared ? 'PACEflow 已在本 session 恢复（pause 标志已删除）。' : '本 session 没有 pause 标志（无需恢复）。',
    `session: ${sid}`,
  ].join('\n') + '\n');
}

function doStatus(cwd) {
  const state = currentState(cwd);
  const soft = (() => { try { return paceUtils.detectSoftSignal(cwd); } catch (e) { return false; } })();
  const sid = resolveSessionId('');
  const paused = sid ? paceUtils.isSessionPaused(cwd, sid) : false;
  log(paceUtils.logEntry('SetActivation', 'STATUS', { proj: paceUtils.getProjectName(cwd), state, soft: soft || 'none', paused: paused ? '1' : '0' }));
  const lines = [
    `PACEflow 激活状态: ${state}`,
    `current-cwd: ${cwd.replace(/\\/g, '/')}`,
    `session-paused: ${paused}${paused ? '（本 session 流程门跳过中；恢复运行 /paceflow:resume）' : ''}`,
  ];
  if (state === 'disabled') {
    lines.push(`disabled-marker: ${disabledPath(cwd).replace(/\\/g, '/')}`, '运行 /paceflow:enable 恢复。');
  } else if (state === 'enabled') {
    lines.push(`signal: ${paceUtils.isPaceProject(cwd)}`, 'PACEflow 正在管理本项目；运行 /paceflow:disable 可禁用。');
  } else {
    lines.push(soft
      ? `检测到软信号（${soft}）但未启用；运行 /paceflow:enable 启用。`
      : '未检测到激活信号；运行 /paceflow:enable 可手动启用。');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(`${usage()}\n`); return; }
  if (args.unknown.length > 0) {
    fail(args.cwd, 'DENY_UNKNOWN_OPTION', `set-activation 不支持参数：${args.unknown.join(', ')}。\n只支持 --enable / --disable / --pause / --resume / --status / --cwd / --session。\n\n${usage()}`, { options: args.unknown.join(',') });
    return;
  }
  if (!args.action) {
    fail(args.cwd, 'DENY_MISSING_ACTION', `缺少操作。\n\n${usage()}`);
    return;
  }
  if (args.action === 'enable') doEnable(args.cwd);
  else if (args.action === 'disable') doDisable(args.cwd);
  else if (args.action === 'pause') doPause(args.cwd, args.session);
  else if (args.action === 'resume') doResume(args.cwd, args.session);
  else doStatus(args.cwd);
}

main();
