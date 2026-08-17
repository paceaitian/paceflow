# 远端多 agent 协调中心：最小中心层研究与架构建议（2026-08-17）

> **状态**：research + minimal architecture proposal，**pre-implementation**。
> **目标**：分布在独立机器、服务器或会话上的 agent，通过中心获取任务与共享状态、认领工作、报告进度并交接 artifact。
> **核心边界**：中心协调任务，**不管理 agent**。本机 agent/宿主负责模型、权限、工具、sandbox、进程生命周期和实际执行。
> **PACEflow 边界**：中心是确定性的「账本 + 锁 + 通道」，不是中央 LLM 大脑；不做质量裁决；artifact 继续保持人可读和可 diff。
> **价值门**：研究与最小远端原型 GO；详见 `research-2026-08-17-coordination-core-value-gate.md`。

---

## 0. 架构结论

1. **只中心化协调状态**：任务索引、依赖、分配/认领、租约、进度、事件、消息和 agent presence。
2. **不中心化 agent 管理**：不安装/启动/停止/升级 agent，不设置本机权限，不选择模型/工具，不提供远程 shell。
3. **artifact/source system 保持内容真相**：任务正文、计划、findings、walkthrough 和结果仍可在 git/vault/现有系统；中心保存引用、摘要和物化索引。
4. **agent 是自治参与者**：它自行判断能否接受任务、如何执行、何时拒绝；中心记录决定，不越权替它执行。
5. **认领必须原子**：同一工作同一时刻最多一个有效 lease；过期后新 owner 获得更高 fence，旧 owner 的更新被拒绝。
6. **通知不是事实**：push/MQTT/WebSocket 只加速；agent 用 `sync/get_events` 找回漏消息。
7. **task kind 开放**：代码、审查、诊断、运维都用同一最小 envelope；领域字段作为 opaque extension 或 artifact 内容，不写死 handler catalog。
8. **适配器而非统一 runtime**：Claude、Codex、其他 agent 通过 MCP/HTTP/CLI adapter 映射到共同协议。
9. **先小后大**：首版不做权限平台、host manager、自动调度优化、组织、多租户或完整工作流引擎。
10. **remote-first**：直接验证两机三 agent，不以本地 `.pace` 后端抽取为前置。

---

## 1. 职责边界

### 1.1 核心负责

| 能力 | 最小语义 |
| --- | --- |
| Work index | 任务 ID、摘要、状态、来源、artifact refs、标签、优先级 |
| Dependency | ready/blocked 判据和显式 blocker |
| Dispatch | targeted assignment、共享 ready queue、notification |
| Claim | 原子认领、lease、heartbeat、release、takeover/fence |
| Progress | agent-reported stage、summary、checkpoint、blocked reason |
| Presence | agent/instance 自报 ID、labels、可选 capabilities、last seen |
| Event stream | 每次协调状态转移的追加事件和 cursor |
| Messaging | 中心到 agent / agent 到 agent 的轻量通知或引用 |
| Query | 按 project、agent、status、label、更新时间查询 |
| Adapter | MCP/HTTP/CLI/host-specific translation |

### 1.2 核心不负责

- agent process lifecycle；
- model/runtime/tool selection；
- 本机 OS、文件、shell、网络、云账号或 sudo 权限；
- agent credential provisioning 的产品语义；
- sandbox/容器/worktree 的实际创建；
- task 的领域执行逻辑；
- 质量判断、自动批准或自动修复；
- 服务器 inventory/monitoring/patch/deploy；
- 任意命令执行；
- 组织、计费、多租户和复杂 RBAC；
- 中央 LLM 自动拆任务/选 agent/改计划。

部署实现必须能区分连接者，避免 A 覆盖 B 的 claim/progress；但连接认证是可插拔 transport concern，不代表中心管理 agent 的本机权限。

### 1.3 将来可选扩展

- capability matching；
- domain-specific task schemas；
- policy/RBAC/organization；
- scheduler plugin / optimization；
- richer DAG / workflow templates；
- host inventory/agent lifecycle；
- billing/quota/multi-tenancy；
- Webhook/A2A/CI/issue tracker integrations。

扩展只能附加，不得要求最小核心接管 agent 自治边界。

---

## 2. 分层架构

```text
用户 / lead / 现有任务系统
         |
         v
PACEflow coordination center
  Work Index | Ready Set | Assign/Claim | Lease/Fence
  Progress   | Presence  | Events       | Notifications
         |
         | HTTP/MCP/CLI adapters
         v
独立 agent instances（任意机器/宿主）
  Claude | Codex | other agent | local daemon
         |
         | 本机自行负责权限、工具和执行
         v
repos / logs / servers / external systems

内容真相：PACEflow artifacts / git / vault / existing source systems
协调真相：center store
```

### 2.1 组件

| 组件 | 职责 |
| --- | --- |
| Coordination API | 最小操作、状态验证、幂等与查询 |
| Work Indexer | 从 artifact/source refs 建立/刷新物化索引 |
| Ready Evaluator | 依据状态和 blocker 求 ready set |
| Claim Store | 原子 claim、lease、fence、heartbeat |
| Event Journal | 追加状态转移并提供 cursor |
| Notifier | 非权威 push；失败可重试 |
| Projection | 任务/进度看板所需查询视图 |
| Adapter Layer | Claude/Codex/MCP/HTTP/CLI 转换 |

首版可以是一个进程和一个数据库；组件是逻辑边界，不要求微服务。

### 2.2 真相分层

| 数据 | 权威位置 | 中心角色 |
| --- | --- | --- |
| 任务正文/计划/验收 | artifact/source system | 保存 ref、摘要、hash/index |
| findings/walkthrough/result artifact | artifact/source system | 保存 ref 与 reported availability |
| task dependencies/priority | artifact 或中心输入 | 索引并求 ready |
| assignment/claim/lease/fence | **中心** | 唯一协调真相 |
| progress/checkpoint summary | **agent 报告到中心** | 当前投影 + 事件 |
| agent 本机权限/能力真实性 | 本机/宿主 | 中心只保存 self-declared metadata |
| agent process 实际状态 | 本机/宿主 | presence 只是 last reported/last seen |

中心不能因为 heartbeat 新鲜就断言 agent 本机任务正确，也不能因为中心标记 assigned 就断言 agent 已接受。

---

## 3. 最小数据模型

### 3.1 `AgentPresence`

```text
agent_id              # 稳定或由 adapter 映射
instance_id           # 当前 session/process；重启可变化
adapter/runtime        # claude, codex, other
labels[]               # agent 自报；中心不解释权限
capabilities[]?        # 可选、自报、仅作匹配提示
projects[]?            # 可选可见范围提示
state                  # online/idle/busy/offline/unknown（reported/derived）
last_seen_at
metadata{}             # opaque extension
```

presence 是目录与提示，不是 agent manager。中心不会据此启动、停止或升级 agent。

### 3.2 `WorkItem`

```text
work_id
kind                   # namespaced opaque string
title / summary
source_ref             # artifact://, git://, issue://, url:// ...
source_revision/hash?
project_id?
status                 # minimal coordination status
priority
dependencies[]
target_agent_id?
labels[]
context_refs[]
created_at / updated_at
extensions{}           # center stores/forwards unknown fields
```

中心不需要读取 `kind` 的领域 payload 才能完成 assign/claim/progress。adapter/agent 通过 `source_ref` 取得完整内容。

### 3.3 `ClaimLease`

```text
work_id
agent_id / instance_id
lease_id
fence                  # monotonically increasing per work item
claimed_at
expires_at
last_heartbeat_at
checkpoint_ref?
version
```

### 3.4 `Progress`

```text
work_id
agent_id / instance_id
fence
stage                  # opaque short string
summary
blocked_reason?
checkpoint_ref?
artifact_refs[]
reported_at
sequence
```

progress 是 agent report，不是中心质量结论。领域细节可以放 artifact，避免把聊天全文塞进中心。

### 3.5 `CoordinationEvent`

```text
event_id
cursor/server_seq
work_id?
agent_id / instance_id?
event_type
fence?
payload{}
created_at_server
idempotency_key?
```

核心事件：

```text
work.created / work.updated / work.ready / work.blocked
work.assigned / claim.acquired / claim.heartbeat / claim.released / claim.expired
progress.updated / work.completed / work.failed
agent.announced / agent.seen / agent.offline
message.sent
```

---

## 4. 最小状态机

```text
backlog
   |
   v
ready ---- assign(optional) ----+
   |                            |
   +--------- claim ------------+
                 |
                 v
              claimed
                 |
       accept / progress
                 v
              running <----> blocked
                 |
          complete / fail
                 v
        completed | failed

claimed/running -- release --> ready
lease expiry --> stale --> ready or needs_takeover
```

建议保留的区别：

- `assigned` 是中心/用户希望某 agent 看见；
- `claimed` 是中心成功授予唯一 lease；
- `running` 是 agent 报告已开始；
- `blocked` 是 agent 报告需要等待；
- `stale` 是中心根据 lease 观察到协调信息过期；
- `completed/failed` 是 agent 报告终态，不等于中心独立验证质量。

未知领域需要的状态放 extension；不要让核心枚举无限增长。

---

## 5. 最小 API / tool contract

### Agent/presence

```text
announce_agent(agent_id, instance_id, labels?, capabilities?, metadata?)
heartbeat_agent(agent_id, instance_id, state?, current_work_ids?)
list_agents(filters?)
```

### Work/query

```text
upsert_work_index(work_id, source_ref, summary, status, dependencies?, ...)
get_work(work_id)
list_work(filters, cursor?)
list_active_work(project_id?)
```

`upsert_work_index` 可以由 artifact indexer、用户或现有任务系统 adapter 调用；不要求 agent 自己创建任务正文。

### Dispatch/claim

```text
assign(work_id, target_agent_id)
claim(work_id, agent_id, instance_id, idempotency_key)
claim_next(agent_id, instance_id, selectors?, idempotency_key)
accept(work_id, lease_id, fence)
reject(work_id, reason, lease_id?, fence?)
release(work_id, lease_id, fence, reason)
```

`selectors` 只过滤中心已有字段/自报 labels；它不授予本机权限。

### Progress/terminal

```text
heartbeat_claim(work_id, lease_id, fence, checkpoint_ref?)
update_progress(work_id, lease_id, fence, sequence, stage, summary, refs?)
mark_blocked(work_id, lease_id, fence, reason, refs?)
complete(work_id, lease_id, fence, result_refs?, summary?)
fail(work_id, lease_id, fence, reason, result_refs?)
```

### Sync/events/messages

```text
get_events(after_cursor, filters?)
send_message(target_agent_id, work_id?, body_or_ref)
poll_inbox(agent_id, instance_id, after_cursor?)
```

通知丢失时 `get_events/list_work` 可恢复；消息本身不能改变 claim 状态，所有权只通过 claim API 改变。

---

## 6. 原子性、租约与故障

### 6.1 Claim

同一 work item 同一时刻最多一个 active lease。实现需使用后端事务/CAS：

```text
if status is claimable
and no unexpired active lease
then create lease, increment fence, set owner
else reject with current owner/status
```

重复 `idempotency_key` 返回同一个 claim 结果。

### 6.2 Heartbeat 与 expiry

- heartbeat 续租并可附 checkpoint ref；
- expiry 表示中心不再相信该 claim 新鲜，不表示本机 agent 被停止；
- 新 claim 产生更高 fence；
- 旧 fence 的 progress/complete 被拒绝；
- agent 收到 stale-fence 后应按其本机规则停止继续提交该工作并重新 sync；
- 是否自动回 ready、等待用户 takeover 或保持 stale，由 work/project policy extension 决定。

中心只能约束自己的协调账本，不能远程撤销 agent 已有本机权限。这正是“不管理 agent”边界的一部分。

### 6.3 Failure matrix

| 故障 | 核心行为 |
| --- | --- |
| notification 丢失 | agent 通过 poll/sync 找回 |
| notification 重复 | event/idempotency key 去重 |
| 两 agent 同时 claim | 后端事务只允许一个成功 |
| agent 断线 | lease 到期，状态 stale；不尝试管理进程 |
| agent 重启换 instance | 重新 announce/sync；旧 lease 仍按 fence 规则处理 |
| progress 乱序 | sequence/version 拒绝旧更新 |
| 中心重启 | DB/event cursor 恢复；agent 重连 sync |
| notifier 故障 | DB 状态不丢，恢复后重发或靠轮询 |
| artifact 暂时不可达 | work 保留 ref，报告 blocked/不可读；中心不复制伪真相 |
| unknown task kind | 保存/转发；由 adapter/agent 自己理解或 reject |
| agent 本机无权限 | agent reject/blocked；中心不修改其权限 |

---

## 7. Ready set 与依赖

首版可以支持最小 DAG：

- `dependencies[]` 只表达 blocking edge；
- 所有 blocker completed 才 ready；
- blocker failed/取消时下游进入 `blocked_failed` 或保持 blocked + reason；
- 写入依赖时做环检测；
- `claim_next` 在事务时重新检查 ready，不信任陈旧缓存；
- 优先级排序必须确定性。

建议排序：

```text
priority DESC,
created_at ASC,
work_id ASC
```

复杂 trigger rule、资源池、能力优化和自动重规划后加。中心不需要理解任务内容就能维护 blocking DAG。

### 跨任务域示例

```text
diagnose -> code change -> review -> verify -> ops follow-up
```

这些只是不同 `kind/source_ref` 的 work items。中心处理依赖和状态，具体执行与是否获准由各本机 agent/宿主负责。

---

## 8. Transport 与 adapter

### 8.1 Transport-neutral core

domain core 不依赖 MCP、HTTP 或 MQTT：

```text
coordination domain functions
        |
        +-- HTTP API
        +-- MCP server adapter
        +-- CLI adapter
        +-- Claude hook/skill adapter
        +-- Codex plugin/skill adapter
        +-- optional notification transport
```

### 8.2 首版建议

- HTTP/JSON 或同进程调用作为权威 request/response；
- poll/get_events 作为可靠基线；
- SSE/WebSocket/MQTT 可做 notification 加速；
- MCP 暴露给 Claude/Codex 的工具应调用同一 domain core；
- adapter 负责映射宿主 session/agent identity，不把宿主细节写进中心 schema。

### 8.3 MCP 位置

MCP Tasks 可以表示长时 tool call 和 cooperative cancel，但中心需要的是跨调用、跨 agent 的共享 work registry、claim lease 和 events。因此：

- MCP 是接口，不是协调真相；
- MCP task handle 可映射到 center work ID，但不能取代它；
- 不依赖所有 agent 都支持同一 MCP extension；
- 非 MCP agent 仍可通过 HTTP/CLI 使用同一中心。

---

## 9. 看板

### 9.1 Tasks

- work ID、kind、title/summary、source ref；
- backlog/ready/claimed/running/blocked/completed/failed/stale；
- priority、dependencies、labels；
- owner agent/instance、lease freshness；
- latest progress/checkpoint/artifact refs。

### 9.2 Agents

- agent/instance、adapter/runtime；
- self-reported labels/capabilities；
- reported state、last seen；
- current claimed work；
- recent events。

此视图是 presence board，不是 agent 控制台：不提供 start/stop/update/permission 按钮。

### 9.3 Events

- 按 time/cursor 的状态变化；
- actor/agent/work/fence；
- progress/blocked/release/takeover/terminal；
- artifact refs；
- 可用于断线恢复与审计。

首版看板只显示中心真正知道的事实，并把 `reported`、`last seen`、`lease expires` 明示出来。

---

## 10. Storage

### 接口要求

- atomic claim/CAS；
- unique active lease per work；
- monotonic fence per work；
- append event + cursor；
- idempotency keys；
- transactional state/event update；
- indexed queries by status/agent/project/time；
- schema versioning。

### 实现阶梯

| 阶段 | 后端 | 说明 |
| --- | --- | --- |
| unit/simulator | in-memory | 快速验证合同与故障 |
| single-center POC | SQLite 或 PostgreSQL | 所有远端 agent 只访问 API，不共享 DB 文件 |
| multi-instance/HA | PostgreSQL 类 server DB | 事务、并发写者、备份与运维 |

remote-first 不等于一开始做分布式数据库。只要所有协调写入收敛到中心服务，单节点 DB 就能先验证价值。

---

## 11. PACEflow 集成

### Artifact indexer

- 扫描/监听 PACEflow task/change artifacts；
- 提取 ID、摘要、状态、依赖、优先级和 refs；
- 更新中心 work index；
- 不把 owner lease 写回 markdown；
- artifact 变更与中心索引不一致时标记 drift，保留 source hash。

### Agent adapter

- SessionStart/skill/MCP 注入 `list_active_work/list_work`；
- agent 选定任务后调用 claim；
- 本地 PACEflow hook 继续执行原有流程门；
- agent 报 progress/checkpoint/artifact refs；
- SessionEnd/异常由 adapter 尽力 release/detach；lease expiry 兜底。

### 双宿主

- Claude 与 Codex 共享 center work ID 和 artifact refs；
- adapter 各自处理 session/tool 事件；
- center 不要求两者权限、工具或生命周期一致；
- 新宿主只需实现最小 contract，不改核心。

---

## 12. 最小原型路线

### P0：Contract + simulator

- WorkItem/AgentPresence/ClaimLease/Progress/Event schema；
- in-memory store；
- deterministic state transitions；
- two simulated agents race claim；
- lease expiry/fence/idempotency tests。

### P1：Remote center

- 单中心 API + SQLite/PostgreSQL；
- 两台独立机器/环境、三个 agent instance；
- announce/list/assign/claim/progress/release/complete；
- event cursor + reconnect sync；
- basic tasks/agents/events board。

### P2：PACEflow adapters

- artifact indexer；
- Claude adapter；
- Codex adapter；
- 至少四个不同 kind 的 dogfood task：代码、审查、诊断、运维；
- 中心对 kind 保持 opaque。

### P3：Fault injection

- duplicate/out-of-order request；
- notification loss；
- agent crash/restart；
- center restart；
- lease expiry + old fence；
- artifact temporarily unavailable；
- unknown kind/extension；
- adapter unavailable。

### P4：Value check

- 一个看板是否真的减少逐 agent 查询；
- assign/claim 是否减少重复工作；
- 中断恢复是否更快；
- artifact handoff 是否减少上下文重述；
- agent 接入成本是否足够低；
- 中心字段维护是否产生过多 ceremony。

只有真实使用要求后，才从 §1.3 选择扩展进入下一版。

---

## 13. 待确认输入

1. 首轮预计连接的机器数和 agent instance 数？
2. Claude、Codex、其他 agent 的比例？
3. 当前 artifact root/project root 如何在不同机器定位？
4. 中心与 agent 之间已有何种网络可达方式？
5. 中心部署位置与是否需要公网访问？
6. 首版看板最重要的 5 个字段？

这些只决定部署和 UI，不改变“不管理 agent”的核心边界。

---

## 14. 一手来源

- Kubernetes kubelet sync loop: https://kubernetes.io/docs/reference/node/kubelet-sync-loop/
- Kubernetes Leases: https://kubernetes.io/docs/concepts/architecture/leases/
- Kubernetes objects/spec/status: https://kubernetes.io/docs/concepts/overview/working-with-objects/
- GitHub self-hosted runners: https://docs.github.com/en/actions/reference/runners/self-hosted-runners
- AWS IoT Jobs workflow: https://docs.aws.amazon.com/iot/latest/developerguide/jobs-workflow-device-online.html
- Azure device twins: https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-device-twins
- PostgreSQL queue locking: https://www.postgresql.org/docs/current/sql-select.html
- OASIS MQTT 5.0: https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html
- MCP 2026-07-28 release: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- MCP Tasks: https://modelcontextprotocol.io/extensions/tasks/overview
- A2A latest specification: https://a2a-protocol.org/latest/specification/

---

## 15. 证据与决策边界

- 一手先例支持共享控制面、远端执行者、heartbeat/lease、任务队列和 reported progress；最小合同是本研究的设计判断。
- 本文有意不设计 agent 权限、host lifecycle 和领域 handler；这些不是遗漏，而是边界决定。
- 用户环境用于 dogfood，不限制产品只服务个人服务器。
- transport authentication 是部署完整性要求，不扩张为 agent 本机权限管理。
- 本文替代同日较早的 `research-2026-08-17-industrial-remote-agent-control-plane.md`；后者按错误的 OT/server-fleet-manager 范围写成，已删除。
