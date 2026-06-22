// Monitor 工具的 PaceFlow artifact 写保护 deny 文案构造器。与 bash-guard 的 bashArtifact*DenyReason、
// powershell-guard 的 powershellArtifact*DenyReason 对称——Monitor 的命令变更检测复用 bash 探测器
// （bashCommandMutatesArtifact* / bashCommandMutatesArtifactRuntimeControl），故本模块只承载 Monitor
// 专属的两段拒绝文案。从 pre-tool-use.js 逐字抽出，消除主 dispatch 文件里散落的 Monitor 文案特例
// （行为零改变，文案逐字不动以保 golden deny-outlets 快照一致）。
'use strict';

// Monitor 试图改写 PaceFlow artifact 写入控制运行态（锁/编号计数/reservation）时的拒绝文案。
function monitorArtifactRuntimeControlDenyReason(command) {
  return [
    '禁止使用 Monitor 修改 PaceFlow artifact 写入控制运行态。锁、编号计数与 reservation 只能由 hook 创建/释放。',
    '如果需要观察日志或测试输出，请让 Monitor 执行只读命令；不要用 Monitor 删除或改写 PaceFlow 运行态文件。',
    `被拦截的命令：${String(command || '').slice(0, 500)}`
  ].join('\n');
}

// Monitor 试图改写 artifact 文件本身时的拒绝文案。
function monitorArtifactDenyReason(command) {
  return [
    '禁止使用 Monitor 修改 artifact 文件。Monitor 只适合观察日志、测试输出或轮询状态；artifact 修改必须走 artifact-writer 的 Write/Edit 路径。',
    '允许用 Monitor 执行只读观察命令，但禁止 sed -i、重定向、rm/mv/cp/touch/mkdir、脚本写文件等会改变 artifact 的命令。',
    `被拦截的命令：${String(command || '').slice(0, 500)}`
  ].join('\n');
}

module.exports = {
  monitorArtifactRuntimeControlDenyReason,
  monitorArtifactDenyReason,
};
