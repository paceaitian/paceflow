# 多 agent 协调核：研究结论与架构提案（2026-08-16）

> **状态**：historical candidate design / **pre-implementation**。本文按「多台开发机上的 Claude/Codex 编程 agent」写成，机制研究仍可复用，但产品边界和 local-first 路线已不再有效。
> **2026-08-17 最终范围纠正与价值门**：目标是面向通用远端 agent 的任务/进度看板与下发/认领通道。中心只管理工作协调状态，**不管理 agent 的本机权限、工具、模型、进程或 host**；用户个人服务器只是 dogfood 场景。此前针对本地编程协作给出的 NO-GO 已撤销；当前决策为 **研究与最小远端协调原型 GO**。详见 `research-2026-08-17-coordination-core-value-gate.md` 和 `research-2026-08-17-remote-agent-coordination-center.md`。
> **任务域确认**：代码实现、独立审查、日志诊断和服务器运维都会进入中心，但中心将 kind/领域内容视为开放扩展或 artifact 引用，不内建 handler/权限体系。
> **阅读约束**：本文主体保留为租约、DAG、fencing、协议和 durable state 的先例材料；不得把阶段 2 本地后端视为远端中心前置，也不得把 CHG/git/hook 或 server-fleet-manager 假设外推到最小核心。
> **触发**：v7.3.0（Codex MCP artifact server）发布后的讨论——「artifact 读写全 MCP 化 → 是否可中心化 → 多个 Claude/Codex 分布在不同机器如何协同、如何知道自己做什么」。
> **原决策锚（历史）**：本文曾把「真实多机多人编程用户」作为阶段 3 前置。当前已有跨服务器 dogfood 场景，足以验证最小协调机制；通用产品价值仍需更多用户验证，但不以个人场景限定核心。
> **方法**：六份子代理报告（原文与可信度标注见 `docs/research/coordination-core/`）：`.pace` 运行态现状地图（代码定锚）、Claude Code 宿主能力（文档盘点，二手，已标偏差）、租约/心跳先例（在线核实）、DAG ready-set 先例（在线核实）、A2A/MCP 协议先例（在线核实）、反例与 durable-state 教训（在线核实）；加 2026-08-16 探针实测（`docs/research/claude-code-plugin-mcp-probe-2026-08-16.md`）。外部来源由研究员一手抓取，主 session 未逐条复核，引用时按各报告标注的「一手/二手」区分。

---

## 0. 历史提案结论（TL;DR；不适用于当前最小远端协调核心）

1. **中心要有，但它是「账本 + 锁」，不是「大脑」**：做一个确定性的协调核——任务板索引 + 依赖图 + 租约/心跳 + 锁/编号 + 事件；agent 靠 `claim_next(能力)` 自己知道该做什么。**不做中央 LLM 调度器**（证据见 §2.6：Anthropic 自己把 orchestrator-workers 限定在「子任务不可预知」并把 coding/强依赖任务排除；MAST 量化的最高三类失败恰是确定性机制的靶心；CrewAI/AutoGen 的 LLM 选人有四类可复现故障）。
2. **真相仍是文件**（git / Obsidian vault 里的 artifact markdown，人可读、可 diff、可进 PR）；**只有协调状态可以中心化**（租约、锁、编号、在册 agent、事件）。这是 Beads 用 26k star 的项目实测走出来的分野：durable state 放 git 文件 ↔ 多写者并发是硬取舍，租约的互斥语义不是 CRDT 能表达的。
3. **调度四问里三问是规则**：哪些任务现在能做（依赖图 + 锁）、给谁（能力标签 AND 全匹配 + 先到先得）、先做哪个（规划时定的优先级 + 确定性排序键）——都不需要 LLM；第四问「计划要不要改」需要判断，但它是**重规划**，交给有人看着的规划/lead **会话**（有 transcript、走 A 阶段批准、能被叫停），不是服务里的 headless LLM。
4. **现有 `.pace` 已是协调核的地基**：change-owner 记录就是现成的租约（session/worktree/branch/state/timestampMs、30min TTL、心跳、detached/closed、十态 disposition、takeover 三字段），`locks.js` 是依赖注入工厂且无模块级缓存——抽成可换后端的接口成本低；LOCKS-001（跨 clone 撞号）正是共享后端天然能消掉的缺口。
5. **要补的是 Agent Teams 自曝的死穴**：宿主的共享 TaskList 有 `blockedBy` + 文件锁防同时抢，但**没有租约**——「teammate 漏标 completed 就永久卡死下游」（官方 Limitations）。租约 + 过期回池 + fencing 是我们的差异化。
6. **路线**：阶段 1（Claude 走 MCP，已立项）→ 阶段 2（协调核抽取，本地后端，`claim_next` 等工具，`blocked-by`/`requires`/`priority` 进 CHG frontmatter）→ 阶段 3（远端后端，仅在有真实多机团队用户后；本地 stdio server 代理到 HTTP，因插件 `mcpServers` 只支持 stdio）。

---

## 1. 历史问题与范围（开发机编程 agent）

**问题**：claude1 / claude2 / codex1 / codex2 分布在不同机器，没有中心 LLM 派活时，各自如何知道该做什么、如何不互相踩、挂了怎么办。

**范围内（协调）**：任务身份与状态、依赖、认领与租约、能力匹配、锁与编号、事件与可见性、失效恢复。
**范围外（判断）**：怎么拆任务、分给谁更合适、冲突怎么解、质量好坏——留给规划会话 + 用户（P/A 阶段），协调核只提供事实。
**非目标**：不做质量控制（记忆 `paceflow-not-quality-control`）；不改 P-A-C-E-V-R 协议；不替代宿主自身的单机 Agent Teams；不把 artifact 真相搬进服务。

---

## 2. 研究结论

### 2.1 现状：`.pace` 运行态（报告：pace-runtime-map，代码定锚）

- 运行态全部挂宿主 Project Root 的 `.pace/`（worktree/继承子目录归一）：`locks/artifacts/*.lock`（资源锁，5min TTL，`openSync(wx)` 原子建锁）、`locks/sequences/*.lock` + `sequences/*.counter`（编号，30s 锁 + 扫共享 `changes/` 目录取 existingMax 双保险）、`reservations/*.json`（30min）、**`change-owners/<slug>.json`**（`{changeId, sessionId, agentId, ownerKey, state, cwd, worktree, branch, executionContext, operation, timestampMs}`，30min TTL）、`paused-<sid>`、`artifact-root`/`project-root`/`disabled` 等。
- **owner 就是租约**：state 由 operation 派生（backlog/ready/active/blocked/closing/closed/detached）；心跳 = 每次文件变更/Bash 工具调用 `touchChangeOwnersForSession`；SessionEnd → detached；同 session resume → revive；SessionStart sweep 清 closed/超期；disposition 十态（`current* / sibling-fresh|stale|detached / foreign-fresh|stale`）；他人 fresh owner 派遣门与写盘门硬 deny，stale/detached 需 `owner-takeover-confirmed/source/evidence` 三字段。
- **没有独立「worktree owner」结构**——worktree/branch 只是 owner 记录的两个上下文字段（`executionContextForCwd`，1s git 超时，进程内 memo 需 `_clearExecCtxMemo`）。
- **teammate**：`CLAUDE_CODE_TEAM_NAME` 单布尔；deny 表三档（soft 流程引导门转提醒 / hard-note 写码与完整性门硬 deny+回报 lead / hard 其余）；Stop 对 teammate 直接放行；语义「teammate = 纯执行者，任务管理归主 session」。
- **`get_context`（MCP）是 SessionStart 注入的子集**：`{artifact_dir, project_root, cwd, session_id, execution_context, active_changes[{id, checkbox, status, category, approved, verified, tasks, detail}]}`——无 owner disposition。
- **可抽取性**：`locks.js`（`createLockUtils(ctx)` 工厂）、`path-utils` 的 root/execution-context、`change-analysis` 的 classify/summarize 全是纯函数级；耦合宿主的只有 `pre-tool-use.js` 的判定顺序与 deny 文案、`agent-lifecycle-guard` 的判定+文案、`subagent-stop` 的 transcript 解析——这些应留在 hook/adapter 侧。MCP `writer-pipeline` 目前靠「合成 hook 事件 spawnSync 真 hook」复用判定，协调核成型后可换成直接函数调用。长驻缓存只有 `_artifactDirCache` 与 `_execCtxMemo`（后者多项目会无界增长）。
- **已知缺口**：LOCKS-001——sequence lock/counter 挂 per-clone `.pace`，多 clone 共享 vault 并发 reserve 可撞号（won't-fix 文档化）；`docs/artifact-locking-reference.md` 仍描述 v7 已退役的 index-transaction，需标 historical。

### 2.2 宿主能力：Claude Code（报告：cc-host-caps 二手 + 探针一手）

- 插件 `.claude-plugin/plugin.json` 的 `mcpServers` **只支持 stdio**（command/args/env；探针另证 `cwd` 字段不生效、`${CLAUDE_PLUGIN_ROOT}` 在 args/env 展开）；远程 http/OAuth 走用户级 `.mcp.json` / `claude mcp add --transport http`。
- **Agent Teams**（实验）：lead/teammate、共享 TaskList `blockedBy`、teammate 自取「next unassigned, unblocked task」、**「Task claiming uses file locking」**、**单机、每 session 一个 team、无跨机**；官方 Limitations：「Task status can lag: teammates sometimes fail to mark tasks as completed, which blocks dependent tasks」。
- Routines 可云端跑但只能单向回写（git push / connector），无本地回调——可当云 worker，不能当协调中心。
- 探针一手（2.1.232）：Pre/PostToolUse 对 plugin MCP 工具触发，`tool_name = mcp__plugin_<plugin>_<server>__<tool>`；`allow + updatedInput + additionalContext` 共存；default 权限模式下 hook allow = 授权；server 进程 cwd = 项目 cwd，env 透传含 `CLAUDE_CODE_SESSION_ID/CLAUDE_PROJECT_DIR`；`_meta` 仅 toolUseId；工具被 defer 需 `ToolSearch select:` 全名。

### 2.3 租约 / 心跳先例（报告：lease-research，在线核实）

| 先例 | 关键语义 | 数值 |
|---|---|---|
| SQS visibility timeout | 短租约 + `ChangeMessageVisibility` 续约 + timeout=0 主动释放；硬顶不因续约重置；DLQ | 默认 30s，硬顶 12h，最佳实践「先 2min + heartbeat」 |
| Temporal | worker 主动 poll；activity heartbeat 携带 checkpoint；心跳节流 ≤ timeout×0.8 | 默认超时/重试均 ∞（依赖 durable execution，我们不能照抄） |
| k8s Lease | 三参数分层：lease-duration > renew-deadline（**自我下台线**）> retry-period；v1.36 退出主动释放 | 15s / 10s / 2s（选主，据 WebSearch 摘要） |
| DynamoDB Lock Client + Kleppmann | RVN 条件写续约；**fencing token**——单调递增、由被写资源侧校验；efficiency vs correctness lock | 示例 10s / 3s（非默认） |
| GitHub Actions runner | 能力标签 **AND 全匹配** + 自动注入内建标签 + group 第二维度；无匹配 → 排队 24h 后取消 | job 排队上限 24h |
| Celery / RQ | `acks_late` 崩溃重复执行必须幂等；Redis `visibility_timeout` 3600s 超时任务无限重投的经典事故；RQ 独立 maintenance 回收孤儿 | RQ 180s job / 420s worker TTL / +60s 余量 |

**建议**：lease:heartbeat 3:1–5:1；自我下台线（续约连续失败超 lease×2/3 即停写）；主动释放（正常结束/Ctrl-C 秒级回池）；硬顶（单次 claim 2–4h）；**fencing 是必要的（correctness lock）**——WSL 休眠/合盖/长工具调用会让 agent 在租约过期后「醒来继续写」，文件系统不会替我们拒绝；at-least-once 下 claim/complete 幂等（幂等键、重复 complete 返回 no-op、attempts 上限 3 → failed 列、独立清扫回收过期租约、ready-set 在 claim 时刻求值不缓存）；能力匹配抄 GitHub Actions（AND、内建标签 `host/os/machine/repo`、排队而非失败但 24h `stalled`）。

### 2.4 DAG ready-set 先例（报告：dag-research，在线核实）

- Airflow：13 种 trigger rule 是十年演化的复杂度，**上游失败给下游一个显式终态 `upstream_failed` 而非卡住**；`priority_weight` + `weight_rule`（downstream/upstream/absolute）；scheduler 临界区用 `FOR UPDATE NOWAIT`。
- Argo：`depends` 表达式，`Omitted`（判据为假没跑）≠ `Failed`（跑了失败）值得抄；布尔表达式自由度是负债。Temporal 无静态 DAG（代码表达 → 无法在调度侧算 ready-set）——反面参照。
- Ninja：ready queue + `-j` + 命名 pool 限并发；Kahn 增量维护 in-degree，环检测是副产品。
- **Beads**：`bd ready` = 「无未关闭 blocker」；依赖类型分层——**只有 `blocks` 参与 ready 计算**，`related/parent-child/discovered-from` 是知识图谱语义；hash id 防合并冲突；契约 `bd ready → --claim → close`。
- Agent Teams：三态 + `blockedBy` + 文件锁；**无租约、无环检测**。Linear/GitHub：blocked-by 只做可视化/关系降级，软门。

**建议**：`open_blocker_count` + 反向边 `blocks[]` 增量维护，claim_next 只读物化索引；排序键 `(priority DESC, unblocked_downstream_count DESC, created_at ASC)` 保证全序；上游失败/取消 → 下游进显式终态 `blocked-failed`；trigger rule 三种够（`all_success` 默认 / `all_done` / `none_failed`）；并发 claim：文件后端 CAS（version + `tmp+rename`）+ 租约，HTTP 后端 `SELECT … FOR UPDATE SKIP LOCKED` + `If-Match`；**环检测放写入时**（谁加边谁看到）+ claim 时全图对账兜底（计数器漂移告警重算——兜底必须真可达）。

### 2.5 协议先例：A2A / MCP（报告：protocols-a2a-mcp，在线核实）

- **两者都没有 lease / lock / 依赖图 / 认领原语**——协调语义必须自造，协议只当壳。
- A2A v1.0：任务状态机含 `REJECTED`（拒接≠失败）与 `INPUT_REQUIRED/AUTH_REQUIRED`（阻塞是状态不是错误）；AgentCard 能力三层（传输/协议开关/skill.tags）；`ListTasks` 过滤 + 游标分页 + 按更新时间倒序 + **授权 scoping**——可直接抄成任务板查询；Message 用于沟通、Artifact 用于产出分账本；webhook 至少一次必须幂等；无 CAS/ETag。
- MCP：`2026-07-28` 版删协议级 session/SSE 可恢复、无状态化，跨调用状态的合规出路是「**服务器铸造的显式 handle 当普通参数传**」（SEP-2567）；tasks 移为扩展 `io.modelcontextprotocol/tasks`（`working/input_required/completed/failed/cancelled`，`ttlMs` 可变、`pollIntervalMs`、故意不提供 `tasks/list` 防跨调用者泄露、taskId 高熵当 bearer）；授权 OAuth 2.1 + RFC 9728/8707，stdio 走 env 凭据。
- **含义**：lease token / lock handle 就该是高熵显式句柄；通知只能当加速、**轮询必须是可用的兜底**；每条记录写 schema 版本（对应记忆 `upgrade-window-hook-data-lockstep`）；未声明能力的调用硬拒并给确定性错误码。

### 2.6 反例与 durable-state 教训（报告：anti-patterns-central-llm，在线核实）

- **Cognition《Don't Build Multi-Agents》**反的是**隐式决策冲突**，不是并行——对策不是退回单线程，而是把「谁做什么」外化成 schema 化状态；依赖图是接口契约的机器可读形式。**边界警示**：去掉中央 LLM 不自动解决「两个 ready 任务改同一文件」——需要任务声明作用域（见 §3.2 `scope`）。
- **Anthropic《Building Effective Agents》**：orchestrator-workers 适用条件是「子任务不可预先确定」；任务板场景恰相反（人/上游显式录入、依赖显式），按其分类是 **workflow（predefined code paths）**——中央 LLM 属「未被条件触发就引入的复杂度」。
- **Anthropic 多 agent 研究系统**：明确「Most coding tasks involve fewer truly parallelizable tasks than research」、强依赖任务不适用；multi-agent ≈ 15× token；「non-deterministic between runs, even with identical prompts」→ 中央调度器的分配不可复现不可审计；他们事后补的 checkpoint/durable execution 正是「状态外置于 agent」——我们把它做成架构前提。
- **CrewAI / AutoGen / Swarm** issue 实证四类同构故障：幻觉出不存在的执行者、schema 不符致委派丢失、静默退化串行/自循环、选人 prompt 膨胀；AutoGen 官方复杂时建议退回 `selector_func`/`round_robin`；Swarm 已被官方标为教育资源。这四类在「注册表 + 集合匹配 + 依赖闭包」下**结构性不存在**。
- **MAST（arXiv 2503.13657）**：14 模式，7 框架失败率 41–86.7%；最高三类——步骤重复 15.7%、推理-行动不一致 13.2%、不知终止条件 12.4%——分别对应租约唯一持有、写入门状态转移、显式终态；prompt 干预只 +9.4%/+15.6% → 用机制不用提示词。
- **durable state**：git-appraise 只支持并集合并；git-bug 用 operation CRDT + Lamport 时钟 + 字典序 tie-break 且要叠索引缓存、仍无事务/无 watch——**租约互斥不是 CRDT 能表达的**；**Beads** 从「SQLite + JSONL in git」实测走到 Dolt（embedded 单写者文件锁 / server 多写者），JSONL 降级为导出，并被用户抓到丢掉了「issue 与代码同 commit」的原子性（issue #2489）；sqlite.org 一手红线：网络文件系统上锁可能静默损坏、WAL 不跨主机。**判据**：所有 writer 同机 → 文件锁/SQLite 够；跨机 → 必须服务端原子 CAS，git 只能只读镜像。

---

## 3. 架构提案

### 3.1 分层

```
L3 会话层   worker 会话(claude/codex, 任意机器): claim_next → 执行 → heartbeat → complete/release
            规划/lead 会话(有人): 拆任务、写 blocked-by/requires/priority、重规划 —— 走 P/A 批准
L2 门层     Claude hooks / Codex codex-adapter —— 策略(deny/allow/注入), 调协调核 API, 宿主适配
L1 协调层   协调核(宿主无关, 可换后端): 任务板索引 · 依赖图 ready-set · 租约/心跳/fence · 锁/编号 · 在册 agent · 事件
            后端: local(同机 .pace 文件, O_EXCL + tmp/rename CAS) | remote(HTTP, DB 事务, 仅阶段 3)
L0 真相层   artifact markdown(task.md / changes/*.md / findings…) in git 或 vault —— 不变
```

- **真相与索引的关系**：L1 的任务板是对 L0 的**物化索引**（可从 artifact 全量重建）+ L1 自有的易失协调状态（租约/锁/编号/在册/事件）。`blocked-by`、`requires`、`priority`、`scope` 是**任务定义**，写进 CHG frontmatter / task.md（可 review、进 PR）；`holder`、`lease`、`fence`、`attempts` 是**协调状态**，只在 L1 后端。这对应 §2.6 的分层结论：可追加/可审计的进 git，互斥语义进原子后端。
- **中心 = 账本 + 锁**：L1 从不做「该做什么」的判断；它回答的全是集合运算与状态转移。

### 3.2 数据模型（增量，兼容现有 CHG/T-NNN）

任务单位仍是 CHG（及其 T-NNN）。新增字段（frontmatter，schema-version 升一号，旧 hook 读新布局须按记忆 `upgrade-window-hook-data-lockstep` 实测 deny 级别）：

| 字段 | 位置 | 语义 |
|---|---|---|
| `blocked-by: [CHG-…]` | 定义 | 唯一参与 ready 计算的依赖类型；写入时检环（拒绝并报环路径） |
| `related / parent / discovered-from` | 定义 | 知识图谱语义，**不参与** ready（抄 Beads） |
| `trigger-rule: all_success \| all_done \| none_failed` | 定义 | 默认 all_success；只三种 |
| `requires: {host?: claude\|codex, os?, repo?, tags?: []}` | 定义 | AND 全匹配；agent 内建标签自动注入 `host/os/machine/repo/worktree` |
| `priority: int`（默认 1） | 定义 | 排序键第一项 |
| `scope: [路径 glob]` | 定义 | 任务声明要动的文件范围；claim 时与其他持有中任务的 scope 求交，重叠即互斥（Cognition 边界的机器化） |
| `holder {agent_id, session_id, host, machine, worktree, branch}` | 协调 | 沿用 change-owner 记录字段 |
| `lease {fence, claim_seq, expires_at, heartbeat_at, claim_started_at, hard_deadline}` | 协调 | fence 单调递增、高熵句柄随 claim 返回 |
| `attempts`, `version/etag`, `checkpoint`（heartbeat 携带的进度笔记） | 协调 | 幂等与恢复 |
| `status` 增补 | 索引 | 现有 backlog/ready/running/blocked/closing 之外增 `blocked-failed`（上游失败/取消传播终态）、`stalled`（无匹配 agent 超 24h）、`lease-expired`（瞬时态，回池） |
| `events.jsonl` | 协调（可选进 git） | 只追加：claimed/heartbeat/released/expired/completed/failed/blocked-failed/stalled/cycle-rejected |

### 3.3 工具 / API（MCP 工具，宿主无关；参数含 `_pace_*` 注入）

| 工具 | 语义 | 幂等 |
|---|---|---|
| `register_agent {capabilities}` | 在册 + 返回内建标签 | 是 |
| `list_active_work {filter}` | `get_context` 的超集：每 CHG 的 owner disposition / worktree / branch / lease / 最近活动 / 锁住的 scope；过滤 + 游标分页 + 按更新时间倒序（抄 A2A ListTasks），授权 scoping 留接口 | 是 |
| `claim_next {capabilities, idempotency_key}` | 排序键 `(priority DESC, unblocked_downstream DESC, created_at ASC)` 出队；AND 匹配；scope 互斥；返回 `{task, lease{fence, expires_at, heartbeat_interval}}`；无可领 → 空 + 原因（none-ready / no-match / all-held） | 同键返回同 fence |
| `heartbeat {task, fence, checkpoint?}` | 续约；fence 不符 → 拒绝并令 agent 自我下台 | 是 |
| `release {task, fence, reason}` | 主动放回；attempts 不变 | 是 |
| `complete` | 并入现有 `update_chg` / `close_chg`：条件更新 `holder==me ∧ fence==current`；重复 → no-op 成功 | 是 |
| `who_owns {path \| task}` | 反查持有者/scope 冲突 | 是 |
| `get_events {since}` | 事件流轮询（通知只是加速） | 是 |
| 既有 `reserve_artifact_id / create_chg / update_chg / close_chg / archive_chg / record_finding` | 不变；`reserve` 后端从 per-clone 迁到共享（修 LOCKS-001） | — |

**门层集成**：写码门/写盘门在放行前校验 `fence == current`（不只比 session）——这是 fencing 的「被写资源侧校验」；派遣门/MCP 桥 `allow` 前先做同一校验。SessionEnd → `release`（现有 detach 语义）；SessionStart 注入改为读 `list_active_work` + 若本会话是 worker 则提示 `claim_next`。

**参数建议**：租约沿用现有 `CHANGE_OWNER_TTL_MS = 30min` 量级（AI agent 单次工具调用可达数分钟，通用先例的 120s 不适用），心跳搭 hook 事件便车（每次工具调用即续约，零成本）+ 长任务显式 `heartbeat`；自我下台线 20min；硬顶 8h；attempts 上限 3 → `failed` 列等人工；清扫在 SessionStart 与每次 `claim_next` 时确定性执行（独立于抢锁者）。

### 3.4 后端

| | local（阶段 2 默认） | remote（阶段 3） |
|---|---|---|
| 位置 | 同机 `.pace/`（**不放云同步 vault**——OneDrive/NFS 上文件锁与 rename 语义不可靠，与 sqlite.org 红线同因）；编号/租约可选绑 artifact-root 以覆盖多 clone 同机场景 | 服务端 DB；插件 `mcpServers` 只支持 stdio → 本地 stdio server 代理到 HTTP（或用户级 `.mcp.json` http 类型） |
| 原子性 | `O_EXCL` 建锁 + `tmp+rename` CAS + `version` 比对 | 事务 `FOR UPDATE SKIP LOCKED`；`If-Match` etag，409 重试 |
| 时间权威 | 本机时钟（记录内 `timestampMs`） | 服务端时钟 |
| 失联行为 | — | 已持租约可用到期；不可 claim；只读回退本地索引 |
| 前提 | **所有 writer 同机**（网络卷即破坏前提） | 认证（MCP OAuth 2.1 或 bearer）；租约/事件字段与 local 完全同构 |

### 3.5 失效模式

| 场景 | 行为 |
|---|---|
| agent 崩溃 / 机器休眠 | 租约到期 → 回池（attempts+1，checkpoint 保留） |
| agent 休眠后醒来继续写 | fence 不符 → 写门 deny，agent 自我下台 |
| 两个 agent 同时 claim | CAS 只成一个；另一个拿到确定性拒绝 |
| 上游失败/取消 | 下游 → `blocked-failed`（显式终态，不留在 pending） |
| 无匹配 agent | 排队；24h → `stalled` + 事件告警 |
| 依赖成环 | 写入时拒绝并报路径；claim 时全图对账兜底 |
| 计数器漂移 | claim 时对账告警并重算 |
| 远端不可达 | 见 §3.4 |
| 板子上没有可领任务 / 反复失败 | 发事件，通知规划会话/用户重规划——协调核不决定 |

### 3.6 阶段路线

| 阶段 | 内容 | 版本 | 前置 |
|---|---|---|---|
| **1**（已立项） | Claude 走 MCP 替代 artifact-writer：manifest `mcpServers`、hook 桥抽共享模块、补 `update_finding/record_correction/update_index`、skill 文案；顺手 `get_context → list_active_work`（补 owner disposition/worktree/branch） | minor | 探针已过 |
| **2** | 协调核抽取：`plugin/coordination/`（接口 + local 后端 = 现有 locks.js 语义 + fence + `blocked-by` ready-set + trigger rule + scope 互斥）；hooks/MCP 直接调函数替代「合成 hook 事件 spawnSync」；新字段进 frontmatter（schema bump + 迁移实测）；`claim_next/heartbeat/release/who_owns/get_events/register_agent`；SessionStart worker 提示 | minor | 阶段 1 dogfood 一个 change-set |
| **3** | remote 后端 + 本地 stdio 代理 + 认证；编号迁共享（LOCKS-001 关闭）；跨机 `list_active_work` | minor | **有真实多机多人用户**（先访谈） |

### 3.7 明确不做

中央 LLM 调度器（§2.6）；真相进服务；用 CRDT 表达租约；布尔 trigger 表达式与 13 种 trigger rule；无限重试；把协调状态挂在连接/session 上（用显式高熵句柄）；把 vault（云同步目录）当协调后端。

### 3.8 开放问题 / 需探针或实测

- `/clear`、`--resume` 后 MCP server 进程与 env `CLAUDE_CODE_SESSION_ID` 是否陈旧（headless 难测）。
- 心跳搭 hook 便车的粒度 vs 单次超长工具调用（>30min 测试）——是否需要 PreToolUse 前置续约「预告时长」。
- Windows 上 `rename` 原子性与 `O_EXCL`；OneDrive 目录下 `.pace` 若被用户误放的失败形态。
- 真实 marketplace 安装下的插件 MCP 工具全名。
- `scope` 冲突的判定粒度（路径 glob 交集 vs git 文件级）与误伤率。
- schema bump 的升级窗口（旧 cache hook 读新 frontmatter 字段是否 deny 级）。
- 未覆盖的先例：Backlog.md / Taskmaster / Shrimp（研究员子任务挂起被停，未补）。

---

## 附：报告索引

- `docs/research/coordination-core/agent-report-pace-runtime-map-2026-08-16.md`（现状，代码定锚，4 处抽检）
- `docs/research/coordination-core/agent-report-cc-host-caps-2026-08-16.md`（宿主能力，二手，已标偏差）
- `docs/research/coordination-core/agent-report-lease-research-2026-08-16.md`（租约/心跳，在线核实）
- `docs/research/coordination-core/agent-report-dag-research-2026-08-16.md`（DAG ready-set，在线核实）
- `docs/research/coordination-core/agent-report-protocols-a2a-mcp-2026-08-16.md`（A2A/MCP，在线核实）
- `docs/research/coordination-core/agent-report-anti-patterns-central-llm-2026-08-16.md`（反例与 durable state，在线核实）
- `docs/research/claude-code-plugin-mcp-probe-2026-08-16.md`（探针一手）
