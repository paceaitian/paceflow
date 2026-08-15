// UserPromptSubmit hook:活跃 CHG 一行摘要注入(CHG-20260814-06)。
// 第二防遗忘通道:SessionStart 注入受 10K cap 且 compact 通路萎缩(v2.1.232 评估),长会话中期
// 的上下文遗忘缺补给点;canary 探针实测 UserPromptSubmit 的 additionalContext 注入有效。
// 严格条件注入防每轮税:仅当本 session 存在 running / closing-required CHG 时注入一行
// (预算 ≤300 chars),无命中 / 非 artifact 信号项目 / session 已 pause 一律零输出零日志。
// foreign/sibling owner 的 CHG 跳过(与 stop.js/session-start 归属先例一致,防诱导误接手)。
// fail-open:任何异常静默放行,绝不阻断用户 prompt。
const path = require('path');
let paceUtils;
try {
  paceUtils = require(path.join(__dirname, 'pace-utils.js'));
} catch (e) {
  process.stderr.write(`user-prompt-submit: pace-utils 加载失败,跳过(${e.message})\n`);
  process.exit(0);
}
const { isPaceProject, resolveProjectCwd, getProjectName, createLogger, logEntry, getActiveChangeEntries, classifyChange, changeOwnerStatus, isSessionPaused } = paceUtils;

const cwd = resolveProjectCwd();
const proj = getProjectName(cwd);
const log = createLogger(paceUtils.defaultLogPath());
const LINE_BUDGET_CHARS = 300;
const TITLE_BUDGET_CHARS = 120;

// 索引行 rest 剥掉 dataview 尾巴(#change [tasks:: ...] 等),留人读标题
function humanTitleFromRest(rest) {
  return String(rest || '').split('#change')[0].replace(/\[[^\]]*::[^\]]*\]/g, '').trim();
}

function isForeignOrSibling(disposition) {
  const d = String(disposition || '');
  return d.startsWith('foreign-') || d.startsWith('sibling-');
}

if (require.main === module) {
  try {
    const t0 = Date.now();
    const stdin = paceUtils.parseStdinSync();
    if (isPaceProject(cwd) !== 'artifact') {
      process.exit(0);
    }
    if (isSessionPaused(cwd, stdin.sessionId)) {
      process.exit(0);
    }
    const candidates = getActiveChangeEntries(cwd)
      .map((e) => ({ entry: e, c: classifyChange(e) }))
      .filter(({ c }) => c.category === 'running' || c.category === 'closing-required')
      .filter(({ c }) => {
        const ownerStatus = changeOwnerStatus(cwd, c.id, stdin.sessionId);
        return !isForeignOrSibling(ownerStatus.disposition);
      })
      // batch create prepend 使索引物理序为创建倒序;按 CHG-ID 升序与 SessionStart 排序面一致
      .sort((a, b) => String(a.c.id).localeCompare(String(b.c.id)));
    if (candidates.length === 0) {
      process.exit(0);
    }
    // running 优先于 closing-required(与 SessionStart「running 优先」同构)
    const first = candidates.find(({ c }) => c.category === 'running') || candidates[0];
    let title = humanTitleFromRest(first.entry.task && first.entry.task.rest);
    if (title.length > TITLE_BUDGET_CHARS) title = title.slice(0, TITLE_BUDGET_CHARS - 1) + '…';
    const t = first.c.tasks || {};
    const progress = Number.isFinite(t.done) && Number.isFinite(t.total) ? `任务 ${t.done}/${t.total}` : '';
    const more = candidates.length > 1 ? `(另有 ${candidates.length - 1} 个活跃 CHG)` : '';
    const tail = first.c.category === 'closing-required'
      ? '已完成待验证/审计,派 close-chg 收口。'
      : '收尾前须验证+审计后派 close-chg。';
    let line = `PACE 活跃变更:${first.c.id} ${title}${progress ? `(${progress})` : ''}${more}——${tail}`;
    if (line.length > LINE_BUDGET_CHARS) line = line.slice(0, LINE_BUDGET_CHARS - 1) + '…';
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line },
    }) + '\n');
    log(logEntry('UserPromptSubmit', 'INJECT', { proj, candidates: candidates.length, category: first.c.category, chars: line.length, dur: Date.now() - t0 }));
    process.exit(0);
  } catch (e) {
    // 注入通道 fail-open,绝不阻断用户 prompt
    process.exit(0);
  }
}
