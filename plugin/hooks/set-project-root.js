#!/usr/bin/env node
// Declare the current cwd as an independent PaceFlow Project Root.

const fs = require('fs');
const path = require('path');
const paceUtils = require('./pace-utils');

const LOG_PATH = paceUtils.defaultLogPath();
const log = paceUtils.createLogger(LOG_PATH);

function parseArgs(argv) {
  const args = { mode: '', cwd: '', help: false, unknown: [], missingValue: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--mode' || arg === '-m') {
      // H-01：取值前 peek 下一 token，是另一个 flag 或缺失则视为缺值，不吞 flag、不静默写损坏配置
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) { args.missingValue.push(arg); }
      else { args.mode = String(argv[++i]); }
    } else if (arg === '--cwd') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) { args.missingValue.push(arg); }
      else { args.cwd = String(argv[++i]); }
    } else if (arg.startsWith('-')) {
      args.unknown.push(arg);
    } else if (!args.mode) {
      args.mode = String(arg || '');
    } else {
      args.unknown.push(arg); // 多余 positional fail-closed 计入 unknown（CHG-20260620-01，审计 P3-3）
    }
  }
  args.cwd = args.cwd ? path.resolve(args.cwd) : paceUtils.resolveProjectCwd();
  args.mode = String(args.mode || '').trim().toLowerCase();
  return args;
}

function usage() {
  return [
    'Usage:',
    `  node "${paceUtils.SET_PROJECT_ROOT_SCRIPT}" --mode independent [--cwd <project-cwd>]`,
    '',
    'Run this only when the current subdirectory is intentionally a separate PaceFlow project.',
    'It writes .pace/project-root in the current cwd; it does not create artifacts or choose artifact-root.',
  ].join('\n');
}

function fail(cwd, action, message, fields = {}) {
  log(paceUtils.logEntry('SetProjectRoot', action, { proj: paceUtils.getProjectName(cwd), ...fields }));
  process.stdout.write(`${message}\n`);
  process.exitCode = 2;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.missingValue.length > 0) {
    fail(args.cwd, 'DENY_MISSING_VALUE', `set-project-root 参数缺值：${args.missingValue.join(', ')} 后未跟有效值（下一项是 flag 或缺失）。\n不吞 flag、不在错误目录写 .pace；请补全值。\n\n${usage()}`, { missing: args.missingValue.join(',') });
    return;
  }
  if (args.unknown.length > 0) {
    fail(args.cwd, 'DENY_UNKNOWN_OPTION', `set-project-root 不支持参数：${args.unknown.join(', ')}。\n只支持 --mode 与 --cwd。\n\n${usage()}`, { options: args.unknown.join(',') });
    return;
  }
  if (args.mode !== 'independent') {
    fail(args.cwd, 'DENY_INVALID_MODE', `Project Root mode 目前只支持 independent。\n\n${usage()}`, { mode: args.mode });
    return;
  }

  const cwd = path.resolve(args.cwd);
  const context = paceUtils.executionContextForCwd(cwd);
  if (context.isWorktree) {
    fail(cwd, 'DENY_WORKTREE_PROJECT_ROOT', [
      '当前 cwd 是 git worktree，PACEflow 保持 worktree 与宿主 checkout 的有效 Project Root 共享 artifact 和 runtime。',
      `当前 cwd: ${cwd.replace(/\\/g, '/')}`,
      `共享 Project Root: ${context.projectRoot.replace(/\\/g, '/')}`,
      '如需独立 PaceFlow 项目，请在非 worktree 的独立项目目录中运行 set-project-root helper。'
    ].join('\n'), { project_root: context.projectRoot });
    return;
  }

  const runtimeDir = path.join(cwd, '.pace');
  const markerPath = path.join(runtimeDir, paceUtils.PROJECT_ROOT_FILE);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const gitignore = path.join(runtimeDir, '.gitignore');
    if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n', 'utf8');
    fs.writeFileSync(markerPath, 'independent\n', 'utf8');
  } catch(e) {
    fail(cwd, 'DENY_WRITE_FAILED', `无法写入 Project Root 标记：${markerPath.replace(/\\/g, '/')}\n底层错误：${e.message || String(e)}`, { marker_path: markerPath });
    return;
  }

  const rootInfo = paceUtils.resolveEffectiveProjectRoot(cwd);
  log(paceUtils.logEntry('SetProjectRoot', 'SET_INDEPENDENT', {
    proj: paceUtils.getProjectName(cwd),
    cwd,
    project_root: rootInfo.projectRoot,
    marker_path: markerPath,
  }));

  process.stdout.write([
    'Project Root 已声明为 independent。',
    `project-root: ${rootInfo.projectRoot.replace(/\\/g, '/')}`,
    `runtime-root: ${rootInfo.runtimeRoot.replace(/\\/g, '/')}`,
    `mode: ${rootInfo.mode}`,
    `marker-file: ${markerPath.replace(/\\/g, '/')}`,
    `current-cwd: ${cwd.replace(/\\/g, '/')}`,
    'next-step: 选择 artifact root；执行以下一个命令：',
    `next-step-local: node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice local --cwd "${cwd.replace(/\\/g, '/')}"`,
    `next-step-vault: node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice vault --cwd "${cwd.replace(/\\/g, '/')}"`,
    '选择完成后再运行 reserve helper 创建 CHG；不要手写 artifact_dir。',
  ].join('\n') + '\n');
}

main();
