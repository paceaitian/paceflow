// Notification hook:logging-only 观察(CHG-20260814-05)。
// changelog 称 Notification(v2.1.198)有 agent_needs_input / agent_completed 等通知,但探针实测
// background agent 完成场景零触发(2026-08-14)——真实触发条件未定锚,不可依赖为收口信号。
// 本 hook 仅记录事件的真实字段形态收集触发分布数据(同 StopFailure v2.1.78 logging-only 先例),
// 不拦截不注入(无 stdout,fail-open);观察期数据足够后再评估是否升级用途。
const path = require('path');
let paceUtils;
try {
  paceUtils = require(path.join(__dirname, 'pace-utils.js'));
} catch (e) {
  // pace-utils 加载失败(如 cache 半写入)时静默放行——logging-only hook 绝不阻断宿主
  process.stderr.write(`notification: pace-utils 加载失败,跳过(${e.message})\n`);
  process.exit(0);
}
const { isPaceProject, resolveProjectCwd, getProjectName, createLogger, logEntry } = paceUtils;

const cwd = resolveProjectCwd();
const proj = getProjectName(cwd);
const log = createLogger(paceUtils.defaultLogPath());

if (require.main === module) {
  try {
    const t0 = Date.now();
    const stdin = paceUtils.parseStdinSync();
    if (!isPaceProject(cwd)) {
      process.exit(0);
    }
    const raw = stdin.raw && typeof stdin.raw === 'object' ? stdin.raw : {};
    log(logEntry('Notification', 'OBSERVE', {
      proj,
      // 事件类型与来源字段形态未定锚,按候选名宽收集(值缺失记 -)
      notif_type: String(raw.notification_type || raw.type || raw.reason || '-').slice(0, 60) || '-',
      agent_id: stdin.agentId || '-',
      agent_type: stdin.agentType || '-',
      keys: Object.keys(raw).join(',').slice(0, 200) || '-',
      dur: Date.now() - t0,
    }));
    process.exit(0);
  } catch (e) {
    // logging-only hook 一律 fail-open
    process.exit(0);
  }
}
