// SubagentStart hook:logging-only 观察(CHG-20260814-02)。
// 宿主 v2.1.232 提供 SubagentStart 事件(agent_id / agent_type,探针实拍);本 hook 仅记录
// start 侧字段形态,与 SubagentStop 做生命周期对账——为未来识别加固收集真实数据,不做任何
// 拦截或注入(无 stdout,fail-open)。命名 agent 的 agent_type 漂移由派遣门 DENY_AGENT_NAMED_DISPATCH
// 从源头消灭(见 pre-tool-use.js),本 hook 不承担识别职责。
const path = require('path');
let paceUtils;
try {
  paceUtils = require(path.join(__dirname, 'pace-utils.js'));
} catch (e) {
  // pace-utils 加载失败(如 cache 半写入)时静默放行——logging-only hook 绝不阻断派遣
  process.stderr.write(`subagent-start: pace-utils 加载失败,跳过(${e.message})\n`);
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
    log(logEntry('SubagentStart', 'OBSERVE', {
      proj,
      agent_id: stdin.agentId || '-',
      agent_type: stdin.agentType || '-',
      dur: Date.now() - t0,
    }));
    process.exit(0);
  } catch (e) {
    // logging-only hook 一律 fail-open,绝不阻断宿主派遣
    process.exit(0);
  }
}
