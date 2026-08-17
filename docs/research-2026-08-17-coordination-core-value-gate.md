# 远端多 agent 协调中心：价值门评估（2026-08-17）

> **状态**：scope-corrected product value gate / decision record。
> **产品目标**：面向任意分布在独立机器、服务器或会话上的 agent，提供中心任务看板、进度看板、任务下发/认领通道和共享协调状态。
> **边界**：中心协调工作，**不管理 agent**。agent 的安装、启动、模型、工具、权限、sandbox、执行方式和本机安全策略均由本机/宿主预先设定。
> **任务范围**：代码实现、审查、日志诊断、服务器运维以及未来其他任务都可以进入中心；中心只理解最小通用协调字段，领域内容通过引用或扩展承载。
> **决策**：**研究 GO；最小远端协调原型 GO；更广产品能力按真实需求增量添加。**

## 范围纠正记录

本轮曾先后把目标误收窄/扩张为：

1. 本地 Claude/Codex 或 worktree 内多 agent 编程；
2. OT/PLC/物理设备调度；
3. 用户个人服务器 fleet manager，并把权限、handler、部署和 host 生命周期也放进中心。

这些都不是最终产品边界。最终不变量是：

- 产品不是只给用户个人使用；用户自己的多服务器场景只是 dogfood，不是市场或架构边界；
- 中心不执行任务，也不替本机 agent 决定能做什么；
- 中心不成为 agent 安装器、进程管理器、权限管理器或远程 shell；
- 中心保存并交换协调事实：任务、依赖、分配/认领、租约、进度、事件、消息和 artifact 引用；
- PACEflow 原有边界继续成立：确定性流程/协调，不做质量裁决；artifact 保持人可读、可 diff；中心不是中央 LLM 大脑。

---

## 0. 先回答价值问题

**有足够价值继续研究和实现最小原型。**

价值来自远端 agent 之间缺少共同协调面，而不是来自中心控制服务器或收紧权限：

1. agent 能从同一入口知道「有哪些工作、什么已经 ready、什么被谁认领」；
2. 用户能看到所有 agent 的任务、进度、阻塞、最后更新和产物；
3. 多 agent 不会因为各自只有局部上下文而重复领取同一任务；
4. agent/session/供应商中断后，任务和 checkpoint 不随聊天消失；
5. Claude、Codex 或其他 agent 可以通过各自 adapter 使用同一任务板；
6. 跨任务域可以用同一协调层串联，例如诊断 → 修复 → 审查 → 验证；
7. artifact 内容仍由 PACEflow/git/vault 管理，中心只提供全局索引、所有权、依赖和事件；
8. 将来确有需求时，再在核心之外增加权限、调度优化、组织、多租户或 host 管理扩展。

### 决策分层

| 决定 | 当前结论 | 说明 |
| --- | --- | --- |
| 问题类别是否有价值 | **是** | 跨机器、跨宿主、跨 session 的任务与进度协调是真缺口 |
| 是否值得研究 | **GO** | 边界已收敛成小而清晰的 coordination core |
| 是否做最小原型 | **GO** | 两机/三 agent 即可验证，不需要先建设 agent manager |
| 是否立即做权限/host 管理 | **NO-GO for now** | 属扩展，不是核心价值前置 |
| 是否立即做中央 LLM 调度 | **NO-GO** | 中心只做确定性状态和路由原语 |
| 是否立即做完整 DAG/组织/多租户 | **later** | 有真实使用证据后增量添加 |

---

## 1. 中心负责什么

### 最小职责

- **任务板索引**：task ID、标题/摘要、状态、优先级、依赖、来源和 artifact refs；
- **下发/认领通道**：targeted assignment、共享队列、`claim_next`、release；
- **所有权与租约**：谁当前在做、多久没更新、是否可以接管；
- **进度看板**：agent 报告的 stage、summary、checkpoint、blocked reason 和 result refs；
- **agent presence**：agent/instance 自报身份、标签、可选 capability、last seen；
- **事件流**：created、assigned、claimed、progressed、blocked、released、completed、failed；
- **消息/通知**：任务有变化时通知目标 agent；轮询/sync 是可靠兜底；
- **查询**：按 agent、状态、项目、标签、依赖和更新时间查询；
- **适配器边界**：Claude/Codex/MCP/HTTP 或其他 agent 只需映射到同一协调协议。

### 明确不负责

- 安装、启动、停止、升级或恢复 agent 进程；
- 选择模型、prompt、工具或执行策略；
- 设置 agent 的本机文件、shell、网络、sudo 或云权限；
- 决定任务质量是否合格；
- 自动把诊断升级成修复或部署；
- 执行任意服务器命令；
- 承担 agent sandbox 或 host lifecycle；
- 替代 PACEflow 的 P-A-C-E-V-R、artifact、审批和审查语义；
- 把中心变成一个拥有所有权限的中央 agent。

连接层仍需要基本身份来防止不同 agent 的状态互相覆盖，但这只是协调记录完整性；它不等同于管理 agent 在本机能做什么。认证实现应可插拔，由部署环境决定。

---

## 2. 为什么值得做成通用产品

用户的多服务器环境可以验证机制，但目标用户可以是任何同时使用多个 agent 的个人或团队：

- 多台开发机/服务器上的 agent；
- Claude、Codex、其他 agent 混合；
- 多个长期 session；
- 本地与远端 agent 混合；
- 不同项目、仓库或任务域；
- 需要统一任务/进度可见性但不希望换掉现有 agent runtime 的用户。

这种“只协调、不接管”的边界反而扩大可适配性：中心不要求用户把权限、运行环境或 agent 生命周期迁进 PACEflow。

### 可量化价值

> **价值 ≈ 少做的人工派发/查状态 + 减少的重复/冲突工作 + 中断恢复节省 + agent 空闲减少 + 可追踪性提升 − 中心使用和维护成本。**

原型应记录：

- 每个任务人工派发耗时；
- 查看全部 agent 状态需要多久；
- agent 等待下一任务的时间；
- 重复认领/冲突次数；
- session/agent 中断后的恢复时间；
- 任务从 ready 到 claimed、从 claimed 到 completed 的时间；
- 看板状态与 artifact/agent 报告的一致性；
- 用户为使用中心额外输入了多少字段。

最重要的反指标是 ceremony：若维护中心状态比直接给 agent 发消息更费力，原型就未证明价值。

---

## 3. 一手先例支持的是机制，不是产品边界

### Kubernetes

Kubernetes control plane 保存期望对象，kubelet/node 负责本地执行并回报状态；Lease 用于 node heartbeat。可借鉴的是 shared API、reported status、presence/lease，不是容器或权限管理本身。

来源：

- https://kubernetes.io/docs/reference/node/kubelet-sync-loop/
- https://kubernetes.io/docs/concepts/architecture/leases/
- https://kubernetes.io/docs/concepts/overview/working-with-objects/

### GitHub Actions self-hosted runners

远端 runner 从中心获取匹配 job 并回报执行状态。可借鉴的是 queue、labels、remote execution report 和外部日志；PACEflow 不需要变成 runner manager。

来源：https://docs.github.com/en/actions/reference/runners/self-hosted-runners

### AWS IoT Jobs / Azure device twin

可借鉴 per-target execution、离线后同步、desired/reported 分离、进度与终态；不把 IoT device management 带入核心。

来源：

- https://docs.aws.amazon.com/iot/latest/developerguide/jobs-workflow-device-online.html
- https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-device-twins

这些先例证明中心化协调状态与远端执行者模式成立，但没有要求 PACEflow 管理远端执行者。

---

## 4. 与 PACEflow 的正确关系

### 保持原边界

```text
Agent/runtime（本机负责）
  模型 · 工具 · 权限 · sandbox · 实际执行 · 本机恢复
                     |
                     v
PACEflow coordination center
  task index · dependencies · assignment/claim · lease · progress · events
                     |
                     v
PACEflow artifact layer
  task/change/findings/walkthrough in git or vault，保持人可读真相
```

- artifact 内容仍是流程真相；
- 中心保存 materialized index 与易变协调状态；
- agent 通过 artifact refs 获取完整任务上下文；
- agent 自己决定是否接受、怎样执行；
- 中心只记录 agent 报告，不判断其本机权限或质量；
- 本地 hook/MCP adapter 可继续执行 PACEflow 流程门，但中心不假设所有 agent 都使用相同宿主。

### 任务类型保持开放

中心只固定最小 envelope：

```yaml
task_id: task-...
kind: opaque-or-namespaced-string
title: short human-readable summary
source_ref: artifact://...
status: ready
priority: 50
dependencies: []
target: null
labels: []
context_refs: []
```

代码实现、审查、诊断和运维可以使用不同 `kind` 和 artifact schema；中心无需内建 handler catalog、风险等级或权限矩阵。未来扩展可以声明这些字段，但核心将未知扩展当 opaque metadata 保存和转发。

---

## 5. 最小协议

首版只需要：

| 操作 | 语义 |
| --- | --- |
| `announce_agent` | agent/instance 自报 ID、labels、可选 capabilities、last seen |
| `list_work` | 查询 ready/owned/blocked/recent work |
| `assign` | 用户/上游把任务定向给某 agent |
| `claim_next` | agent 从匹配队列原子认领；返回 lease/fence |
| `accept/reject` | agent 按本机设定决定是否接受 |
| `heartbeat` | 续约并可附 progress/checkpoint 摘要 |
| `update_progress` | 报 stage、summary、blocked reason、artifact refs |
| `release` | 主动放回队列，不伪造失败 |
| `complete/fail` | 报终态和 result refs |
| `get_events` | 按 cursor 获取变化；重连后补齐 |
| `notify/message` | 非权威加速通道，sync/poll 兜底 |

最小公共状态可以是：

```text
backlog -> ready -> claimed -> running -> blocked -> completed/failed
                         \-> released -> ready
lease expiry -> stale -> ready or needs_takeover
```

状态只表示协调记录。agent 真实进程是否正在运行、是否有权限、是否完成本机动作，由 agent 自己负责并报告。

---

## 6. 原型价值门

### 最小原型——GO

- 一个中心进程；
- 至少两台独立机器/服务器环境；
- 至少三个 agent instance，可混合 Claude/Codex/模拟 agent；
- 创建和查看通用任务；
- targeted assign + `claim_next`；
- lease/heartbeat/release/takeover；
- progress、blocked、complete 和 artifact refs；
- agent 断线/重启后按 cursor 恢复；
- 简单任务/进度看板；
- 不安装、重启、提权或管理 agent。

任务内容可覆盖代码、审查、诊断和运维，但中心把它们视为同一 envelope 下的不同 `kind`，不实现领域 handler。

### 成功指标

- 同一任务同一时刻最多一个有效 claim；
- agent 断线后任务不丢，stale 可见；
- 旧 fence 的进度更新被拒绝；
- 用户能在一个看板知道谁在做什么；
- 跨 agent 交接只需 task/event/artifact refs，不必重新解释全部上下文；
- 未识别的 task kind/extension 不会破坏核心；
- 接入一个新 agent runtime 不要求修改中心 domain logic；
- 中心没有改变任何 agent 的本机权限或生命周期。

### 产品价值仍需验证

原型通过只证明机制可行。是否形成通用产品，还需不同用户验证：

- 多 agent 协调是否高频；
- 他们是否接受额外看板/状态维护；
- artifact 与现有任务系统如何对接；
- 最小核心相对现有任务队列/runner 的独特价值是什么；
- 哪些扩展真正普遍，而不是某个 dogfood 环境特例。

---

## 7. 路线

1. 定义最小 task/agent/claim/progress/event contract；
2. 做 in-memory 或单 DB 的 remote-first simulator；
3. 两机三 agent 验证 assign/claim/heartbeat/reconnect；
4. 接 PACEflow artifact refs 与 Claude/Codex adapter；
5. 加任务/进度看板；
6. 做重复、乱序、断线、lease expiry、旧 fence 故障注入；
7. dogfood 代码、审查、诊断、运维四种 opaque task kind；
8. 根据实际摩擦决定是否增加 DAG、capability matching、权限、组织或 host 管理扩展。

任何扩展都不能反向要求核心接管 agent 本机权限和生命周期。

---

## 8. 待确认输入

这些输入决定原型部署，不改变中心边界：

1. 预计首轮连接多少台机器和多少个 agent instance？
2. Claude Code、Codex、其他 agent 的大致比例？
3. agent 当前如何获得 PACEflow artifact 路径/项目上下文？
4. 机器之间现有网络通道是什么？
5. 中心先部署在哪里？
6. 看板首版最需要显示哪些字段？

---

## 9. 最终决定

> **值得继续做，但只做协调中心，不做 agent 管理平台。**

这个更窄的边界同时降低实现成本和产品锁定：本机 agent 保持自治，PACEflow 中心只成为它们共享的任务、进度和事件账本。将来权限、组织、调度优化或 host 管理确有价值时，以可选扩展添加，不提前写进核心合同。

最小中心层的职责、数据模型、协议、故障语义与原型路线见 `research-2026-08-17-remote-agent-coordination-center.md`。

---

## 10. 证据边界

- 一手先例支持远端控制面/执行者模式；具体最小协议是本研究的设计判断。
- 用户个人服务器是 dogfood 证据，不是产品 persona 的唯一来源。
- 本文不使用 GitHub star 或公共开源 PMF 决定是否做最小研究原型；通用产品价值仍需后续用户验证。
- transport authentication 与协调记录完整性是实现问题，不代表中心负责 agent 本机权限。
