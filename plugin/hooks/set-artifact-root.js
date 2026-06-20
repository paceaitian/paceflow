#!/usr/bin/env node
// Persist the PaceFlow artifact-root choice in the authoritative project runtime.

const fs = require('fs');
const path = require('path');
const paceUtils = require('./pace-utils');

const LOG_PATH = paceUtils.defaultLogPath();
const log = paceUtils.createLogger(LOG_PATH);

function parseArgs(argv) {
  const args = { choice: '', cwd: '', help: false, unknown: [], missingValue: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--choice' || arg === '-c') {
      // H-01：取值前 peek 下一 token，是另一个 flag 或缺失则视为缺值，不吞 flag、不静默写损坏配置
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) { args.missingValue.push(arg); }
      else { args.choice = String(argv[++i]); }
    } else if (arg === '--cwd') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) { args.missingValue.push(arg); }
      else { args.cwd = String(argv[++i]); }
    } else if (arg.startsWith('-')) {
      args.unknown.push(arg);
    } else if (!args.choice) {
      args.choice = String(arg || '');
    } else {
      args.unknown.push(arg); // 多余 positional fail-closed 计入 unknown（CHG-20260620-01，审计 P3-3）
    }
  }
  args.cwd = args.cwd ? path.resolve(args.cwd) : paceUtils.resolveProjectCwd();
  args.choice = paceUtils.normalizeArtifactRootChoice(args.choice);
  return args;
}

function usage() {
  return [
    'Usage:',
    `  node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice local [--cwd <project-cwd>]`,
    `  node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice vault [--cwd <project-cwd>]`,
    `  node "${paceUtils.SET_ARTIFACT_ROOT_SCRIPT}" --choice <custom-artifact-path> [--cwd <project-cwd>]`,
    '',
    'Run this after the user chooses where PaceFlow artifacts should live.',
  ].join('\n');
}

function choiceLooksAbsolute(choice) {
  const normalized = String(choice || '').replace(/\\/g, '/');
  return path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized);
}

function comparableArtifactRootChoice(choice, cwd) {
  const raw = paceUtils.normalizeArtifactRootChoice(choice);
  const keyword = raw.toLowerCase();
  if (keyword === 'local' || keyword === 'vault') return keyword;
  const base = paceUtils.getProjectStateDir(cwd);
  const resolved = (choiceLooksAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw)).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fail(cwd, action, message, fields = {}) {
  log(paceUtils.logEntry('SetArtifactRoot', action, { proj: paceUtils.getProjectName(cwd), ...fields }));
  process.stdout.write(`${message}\n`);
  process.exitCode = 2;
}

function formatSuccess(cwd, choice, configFile, artifactDir, previousChoice = '') {
  const context = paceUtils.executionContextForCwd(cwd);
  const rootInfo = paceUtils.resolveEffectiveProjectRoot(cwd);
  const runtimeNote = context.isWorktree || rootInfo.inherited
    ? '当前 cwd 位于共享 PaceFlow Project Root 内。本次配置写入 Project Root 的 runtime，不写入当前 cwd。'
    : '这是 PaceFlow runtime 配置位置，不是普通项目文件写入目标。';
  const duplicateNote = context.isWorktree || rootInfo.inherited
    ? '不要在当前子目录另写 .pace/artifact-root；若当前子目录是独立项目，先声明 independent Project Root。'
    : '不要额外手写其他 .pace/artifact-root。';
  const lines = [
    'artifact-root 已写入 PaceFlow runtime 配置。',
    `config-file: ${configFile.replace(/\\/g, '/')}`,
    `choice: ${choice}`,
    previousChoice && previousChoice !== choice ? `previous-choice: ${previousChoice}` : '',
    `project-root: ${rootInfo.projectRoot.replace(/\\/g, '/')}`,
    `runtime-root: ${rootInfo.runtimeRoot.replace(/\\/g, '/')}`,
    `project-root-mode: ${rootInfo.mode}`,
    `current-cwd: ${path.resolve(cwd).replace(/\\/g, '/')}`,
    `execution-context: ${context.text}`,
    `artifact-root: ${paceUtils.displayDir(artifactDir)}`,
    `artifact_dir: ${paceUtils.displayDir(artifactDir)}`,
    runtimeNote,
    duplicateNote,
    '下一步从当前 cwd 运行 reserve helper:',
    `node "${paceUtils.RESERVE_ARTIFACT_ID_SCRIPT}" --operation create-chg --cwd "${path.resolve(cwd).replace(/\\/g, '/')}"`
  ];
  return lines.filter(Boolean).join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.unknown.length > 0) {
    fail(args.cwd, 'DENY_UNKNOWN_OPTION', `set-artifact-root 不支持参数：${args.unknown.join(', ')}。\n只支持 --choice 与 --cwd。\n\n${usage()}`, { options: args.unknown.join(',') });
    return;
  }
  if (args.missingValue.length > 0) {
    fail(args.cwd, 'DENY_MISSING_VALUE', `参数缺少取值：${args.missingValue.join(', ')}。\n--choice 与 --cwd 必须各自紧跟一个值（不能是另一个 flag）。\n\n${usage()}`, { options: args.missingValue.join(',') });
    return;
  }
  if (!args.choice) {
    fail(args.cwd, 'DENY_MISSING_CHOICE', `缺少 artifact root 选择。\n\n${usage()}`);
    return;
  }
  if (/[\r\n\0]/.test(args.choice)) {
    fail(args.cwd, 'DENY_INVALID_CHOICE', 'artifact root 选择必须是单行文本。', { choice: args.choice.slice(0, 80) });
    return;
  }
  const keywordChoice = args.choice.toLowerCase();
  if (keywordChoice === 'local' || keywordChoice === 'vault') args.choice = keywordChoice;
  const rawEnvChoice = paceUtils.normalizeArtifactRootChoice(process.env.PACE_ARTIFACT_ROOT || process.env.PACEFLOW_ARTIFACT_ROOT || '');
  const envKeywordChoice = rawEnvChoice.toLowerCase();
  const envChoice = envKeywordChoice === 'local' || envKeywordChoice === 'vault' ? envKeywordChoice : rawEnvChoice;
  if (envChoice && comparableArtifactRootChoice(envChoice, args.cwd) !== comparableArtifactRootChoice(args.choice, args.cwd)) {
    fail(args.cwd, 'DENY_ENV_CHOICE_CONFLICT', [
      `当前环境变量 PACE_ARTIFACT_ROOT/PACEFLOW_ARTIFACT_ROOT=${envChoice}，会覆盖 .pace/artifact-root。`,
      `本次请求写入 choice=${args.choice}，两者不一致，已停止以避免显示的 artifact_dir 与实际生效位置不一致。`,
      '请先清除环境变量，或使用与环境变量相同的 --choice。'
    ].join('\n'), { env_choice: envChoice, choice: args.choice });
    return;
  }
  if (args.choice === 'vault' && !paceUtils.VAULT_PATH) {
    fail(args.cwd, 'DENY_VAULT_ENV_MISSING', '用户选择了 Obsidian vault project，但当前 hook 进程没有 PACE_VAULT_PATH，无法解析 vault artifact 根目录。请恢复 PACE_VAULT_PATH 后重试，或选择 local。');
    return;
  }

  const configFile = paceUtils.getArtifactRootChoicePath(args.cwd);
  let previousChoice = '';
  try { previousChoice = paceUtils.normalizeArtifactRootChoice(fs.readFileSync(configFile, 'utf8')); } catch(e) {}
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const gitignore = path.join(path.dirname(configFile), '.gitignore');
    if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n', 'utf8');
    fs.writeFileSync(configFile, `${args.choice}\n`, 'utf8');
  } catch(e) {
    fail(args.cwd, 'DENY_WRITE_FAILED', `无法写入 artifact-root 配置：${configFile.replace(/\\/g, '/')}\n底层错误：${e.message || String(e)}`, { config_file: configFile });
    return;
  }

  const configError = paceUtils.artifactRootConfigError(args.cwd);
  if (configError) {
    fail(args.cwd, 'DENY_ARTIFACT_ROOT_CONFIG', configError.message, { reason: configError.code, config_file: configFile });
    return;
  }
  const artifactDir = paceUtils.getConfiguredArtifactDir(args.cwd);
  if (!artifactDir) {
    fail(args.cwd, 'DENY_ARTIFACT_ROOT_UNRESOLVED', `artifact-root 已写入但无法解析 artifact_dir：${args.choice}`, { config_file: configFile });
    return;
  }

  log(paceUtils.logEntry('SetArtifactRoot', 'SET', {
    proj: paceUtils.getProjectName(args.cwd),
    choice: args.choice,
    config_file: configFile,
    artifact_dir: paceUtils.displayDir(artifactDir),
    execution_context: paceUtils.executionContextForCwd(args.cwd).text,
  }));
  process.stdout.write(`${formatSuccess(args.cwd, args.choice, configFile, artifactDir, previousChoice)}\n`);
}

main();
