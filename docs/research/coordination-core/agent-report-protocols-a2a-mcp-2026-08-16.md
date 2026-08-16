# 子代理报告原文：Agent 间协议先例调研——A2A 与 MCP（opus 研究员，2026-08-16）

> **可信度**：在线调研（prior-art 研究员派出的子研究员，主 session 从其 transcript 提取最终报告原文）；断言附一手 URL（a2a-protocol.org / A2A proto / modelcontextprotocol.io spec 与 changelog / ext-tasks 草案）。主 session 未逐条复核外部来源；其中 MCP `2026-07-28` 版规范细节属最新变更，实施前须再核。文末「🐱」为研究员按用户全局规则附加的结尾，非内容。

---

# Agent 间协议先例调研：A2A 与 MCP（一手源核实版）

---

## A. Google A2A（Agent2Agent），现由 Linux Foundation 托管

**版本与托管**（一手）：文档站 `a2a-protocol.org`，仓库 `github.com/a2aproject/A2A`。当前发布版 **v1.0.0（2026-03-12）**，其后有补丁版 **v1.0.1（2026-05-28）**；上一代 0.3.0（2025-07-30）、0.2.6（2025-07-17）。规范首页仍标注 "Latest Released Version `1.0.0`"。治理：Linux Foundation 新闻稿 **2025-06-23** 宣布 A2A 项目落地 LF（Google 4 月创建、100+ 公司支持，AWS/Cisco/Salesforce/SAP/Microsoft/ServiceNow/Google Cloud 参与）。
来源：https://a2a-protocol.org/latest/specification/ ｜ https://github.com/a2aproject/A2A/releases ｜ https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents

**⚠️ 关键提醒**：v1.0 相对 0.3 是破坏性重构。数据模型的权威源是 protobuf（`specification/a2a.proto`），文档里的字段表由 proto 生成。网上（含二手博客）广泛流传的 `message/send`、`tasks/get`、AgentCard 的 `url` / `preferredTransport` / `additionalInterfaces` 全是 0.3 时代的形态，**v1.0 已不存在**。

### A-1. Task 状态机（proto `enum TaskState`，逐字）

`TASK_STATE_UNSPECIFIED(0)` / `TASK_STATE_SUBMITTED(1)` / `TASK_STATE_WORKING(2)` / `TASK_STATE_COMPLETED(3)` / `TASK_STATE_FAILED(4)` / `TASK_STATE_CANCELED(5)` / `TASK_STATE_INPUT_REQUIRED(6)` / `TASK_STATE_REJECTED(7)` / `TASK_STATE_AUTH_REQUIRED(8)`。

- **终态（proto 注释明确写 "This is a terminal state"）**：COMPLETED、FAILED、CANCELED、**REJECTED**（agent 拒接活，可在创建时也可在中途）。
- **中断态（interrupted state）**：INPUT_REQUIRED、AUTH_REQUIRED —— 非终态，等客户端动作后可回到 WORKING。
- JSON 序列化按 ProtoJSON，枚举就是 SCREAMING_SNAKE 字符串（`"TASK_STATE_INPUT_REQUIRED"`），其它字段 camelCase。
- `SubscribeToTask` 对终态任务必须报 `UnsupportedOperationError`；流在任务进终态时必须结束。
来源：https://raw.githubusercontent.com/a2aproject/A2A/main/specification/a2a.proto ｜ https://raw.githubusercontent.com/a2aproject/A2A/main/docs/specification.md

**可借鉴**：把「拒绝接活」建模为独立终态（REJECTED）而不是 FAILED —— 我们的租约核里 agent 因 `requires` 不匹配拒领，正需要这条与「执行失败」分开的边。AUTH_REQUIRED 也提示：阻塞原因应是**状态**，不是错误。

### A-2. AgentCard（能力标签的先例）

顶层字段（proto，必填标注 REQUIRED）：`name*`、`description*`、`supported_interfaces*`（**有序数组，第一个是首选**）、`provider`、`version*`、`documentation_url`、`capabilities*`、`security_schemes`（map<string,SecurityScheme>）、`security_requirements`、`default_input_modes*`、`default_output_modes*`、`skills*`、`signatures`（JWS）、`icon_url`。

- `AgentInterface{url*, protocol_binding*("JSONRPC"|"GRPC"|"HTTP+JSON"或自定义 URI), tenant, protocol_version*("0.3"|"1.0")}` —— **同一 agent 可同时暴露多传输、多协议版本**；`tenant` 是单端点后多 agent 的路由标识。
- `AgentCapabilities{streaming, push_notifications, extensions[], extended_agent_card}`；能力未声明就调用 → 必须返回 `UnsupportedOperationError` / `PushNotificationNotSupportedError`（§3.3.4 Capability Validation）。
- `AgentSkill{id*, name*, description*, tags*, examples, input_modes, output_modes, security_requirements}` —— **`tags` 是自由关键词数组**，这正对应我们的 `requires:{host,repo,tags}` 标签匹配；`skills` 是描述性的、不是可执行契约。
- 发现：`https://{domain}/.well-known/agent-card.json`（已提交 IANA well-known 注册模板），另有认证后的 `GetExtendedAgentCard`。

**可借鉴**：把「能力」拆成三层——传输/版本（interfaces）、协议开关（capabilities，硬校验）、语义标签（skill.tags，软匹配）。我们的 `requires.host=claude|codex` 属第二层（应可硬拒），`tags` 属第三层。

### A-3. 消息 / Artifact 数据模型

- `Message{message_id*, context_id, task_id, role*(ROLE_USER|ROLE_AGENT), parts*, metadata, extensions[], reference_task_ids[]}`
- `Part` = oneof `text` / `raw`(bytes，JSON 里 base64) / `url` / `data`(任意 JSON Value)，加 `metadata`、`filename`、`media_type`
- `Artifact{artifact_id*, name, description, parts*, metadata, extensions[]}`
- `Task{id*, context_id, status*(TaskStatus{state*, message, timestamp}), artifacts[], history[], metadata}`
- **§3.7 硬规矩：Message 用于沟通，Artifact 用于产出**——"Messages SHOULD NOT be used to deliver task outputs"；history 里哪些 message 被持久化由 agent 自行决定（**不保证全留**）。

**可借鉴**：沟通流水与产物分账本，正是我们 artifact/notes 与事件流应有的切分。

### A-4. 三种更新投递 + webhook

方法映射表（§5.3，11 个操作，JSON-RPC 方法名在 v1.0 改成 **PascalCase**）：`SendMessage`/`SendStreamingMessage`/`GetTask`/`ListTasks`/`CancelTask`/`SubscribeToTask`/`Create|Get|List|DeleteTaskPushNotificationConfig`/`GetExtendedAgentCard`；REST 侧用自定义动词 `POST /message:send`、`POST /tasks/{id}:cancel` 等。

- **轮询**：`GetTask`。**流**：SSE，事件 `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`；同一 task 允许**多路并发流广播**、事件顺序不得重排、关一路不影响其它路；`SubscribeToTask` 首帧必须先发 Task 快照（消除 Get→Subscribe 之间的丢事件窗口）。
- **Push（webhook）**：`TaskPushNotificationConfig{tenant, id, task_id, url*, token, authentication{scheme*, credentials}}`；payload 是 `StreamResponse`（task / message / statusUpdate / artifactUpdate 四选一）；**至少一次投递**，客户端必须 2xx ack、**必须幂等处理**、必须校验 task id 匹配；agent 可指数退避重试、连续失败可停投。
- **ListTasks 的过滤/分页语义**（对「共享任务板」最直接的先例）：按 `context_id`、`status`、`status_timestamp_after` 过滤；`page_size` 默认 50 / 上限 100；游标分页 `page_token`/`next_page_token`（**末页必须返回空串而非缺字段**）；**必须按状态更新时间倒序**；`include_artifacts` 默认 false 以压 payload；**必须做授权 scoping，只返回该调用者可见的 task**。

### A-5. 其它可借鉴语义与坑

- **taskId 一律服务端生成**，"Client-provided taskId values for creating new tasks is **NOT** supported"；客户端带 taskId 必须指向已存在任务，否则 `TaskNotFoundError`。`contextId` 是会话分组键，服务端可拒绝客户端自带的 contextId。
- **幂等性**（§3.3.1）：Get 天然幂等；SendMessage **MAY** 用 messageId 去重（不保证）；CancelTask 幂等，但**任务已被 purge 时可能返回 TaskNotFoundError**。
- **版本协商**：HTTP 头 `A2A-Version: 1.0`（或 query 参数），只比 Major.Minor，**空头一律按 0.3 解释**，不支持则 `VersionNotSupportedError`。
- 错误码 `-32001..-32009`（TaskNotFound / TaskNotCancelable / PushNotificationNotSupported / UnsupportedOperation / ContentTypeNotSupported / InvalidAgentResponse / ExtendedAgentCardNotConfigured / ExtensionSupportRequired / VersionNotSupported），三 binding 有强制映射表。
- **坑（对我们最要命的）**：A2A **没有** lease/租约、没有 lock、没有依赖图、没有「认领/指派」原语，也**没有任务保留期字段**（purge 策略实现自定，只在 Cancel 的幂等描述里承认任务会被 purge）；Task 无版本号/ETag，**并发写没有 CAS 语义**；`return_immediately=false` 是默认，即默认阻塞到终态或中断态——跨机器长任务必须显式设 true。取消无保证（可能已完成）。

---

## B. MCP（Model Context Protocol）

### B-1. 版本历史（一手：schema 目录 + versioning 页）

`2024-11-05` → `2025-03-26` → `2025-06-18` → `2025-11-25` → **`2026-07-28`（Current）**，外加 `draft`。版本号即「最后一次破坏性变更的日期」，向后兼容改动不 bump。
来源：https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/contents/schema ｜ https://modelcontextprotocol.io/specification/versioning

### B-2. Streamable HTTP：2026-07-28 是分水岭

Streamable HTTP 于 `2025-03-26` 引入替代 2024-11-05 的 HTTP+SSE。**`2026-07-28` 把它大改**（见 changelog）：

- **删除 GET stream 端点**、**删除协议级 session（`Mcp-Session-Id`）**（SEP-2567）、**删除 SSE 可恢复性与重投（`Last-Event-ID` + 事件 id）**（SEP-2575）——"Resumable SSE streams via `Last-Event-ID` are not supported"，断流即丢失在途请求，客户端**必须用新 request id 重发**。
- 协议**无状态化**：删 `initialize`/`notifications/initialized` 握手，每个请求在 `_meta` 里自带 `io.modelcontextprotocol/protocolVersion`、`clientCapabilities`、`clientInfo`；新增**强制 RPC `server/discover`**。
- 头：每个 POST 必须带 `MCP-Protocol-Version`（须与 body `_meta` 一致，不一致 → 400 + `-32020 HeaderMismatch`）、`Mcp-Method`，以及 `tools/call`/`resources/read`/`prompts/get` 的 `Mcp-Name`；可选 `Mcp-Param-{Name}`（tool schema 里 `x-mcp-header` 标注，供 LB/网关路由）。
- 服务端→客户端请求改为 **MRTR**（SEP-2322）：返回 `InputRequiredResult{resultType:"input_required", inputRequests}`，客户端**重发原请求并附 `inputResponses`**；所有结果强制带 `resultType`（`"complete"` / `"input_required"`）。
- 长驻通知改为 `subscriptions/listen` 的响应流（POST 打开，服务端 ack 后持续推 list_changed/resources updated），请求级通知（progress/message）只走该请求自己的响应流。
- 取消 = 关闭 SSE 响应流（Streamable HTTP 上不再发 `notifications/cancelled`）。
- 安全：必须校验 `Origin`（非法 → 403），本地服务 SHOULD 只绑 127.0.0.1。
来源：https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http ｜ https://modelcontextprotocol.io/specification/2026-07-28/changelog

### B-3. `Mcp-Session-Id` 语义（2025-03-26 ~ 2025-11-25 时代，**现已移除**）

一手逐条（2025-11-25 §Session Management）：服务器**可**在 `InitializeResult` 的响应头分配 session id（应全局唯一+加密安全，仅 0x21–0x7E 可见 ASCII）；一旦分配，客户端**必须**在后续所有 HTTP 请求带 `MCP-Session-Id`；要求 session 的服务器对缺头请求应答 **400**；服务器**可随时终止 session，其后对该 id 必须返回 404**；客户端收到 404 **必须**重新发不带 session id 的 `InitializeRequest` 开新 session；客户端**应**用 **HTTP DELETE + 该头**显式终止，服务器可用 **405** 表示不允许客户端终止。多连接：客户端可同时连多条 SSE 流，但服务器**不得**把同一条消息广播到多条流（每条消息只走一条流），丢失风险靠 resumability 兜。**关于"多客户端并发连同一 server 的 session 隔离"，spec 未定义隔离规则**（只要求 id 全局唯一+加密安全，并指向 session hijacking 安全最佳实践）——未核实之外的隔离保证一律不存在。

2026-07-28 对旧客户端的处置：GET/DELETE → **405**；收到 `Mcp-Session-Id` **忽略且不回显**；`Last-Event-ID` 忽略。**SEP-2567 给出的替代路径正是我们要的**：需要跨调用状态的服务器改用「**服务器铸造的显式 handle，作为普通 tool 参数传递**」。
来源：https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

### B-4. 授权（2026-07-28）

OAuth 2.1（draft-ietf-oauth-v2-1-13）为基；MCP server = **资源服务器**，AS 独立（可同宿可分离）。MUST 级：server **MUST** 实现 **RFC 9728 Protected Resource Metadata**，client **MUST** 用 PRM 做 AS 发现；AS **MUST** 至少提供 RFC 8414 或 OIDC Discovery 之一，client **MUST** 两者都支持；client **MUST** 实现 **RFC 8707 `resource` 参数**（authorization + token 请求都带，用 MCP server 规范 URI），且无论 AS 是否支持都要发；server **MUST** 校验 token audience 是自己，**MUST NOT** 接受或透传其它 token；401 用 `WWW-Authenticate: Bearer resource_metadata=..., scope=...`，运行期 scope 不足用 **403 + `error="insufficient_scope"`** 走 step-up（客户端应取「已请求 scope ∪ 挑战 scope」的并集）；RFC 9207 `iss` 校验（AS SHOULD 带，client MUST 按表校验）。**动态客户端注册（RFC 7591）已降级为 MAY 且标记 Deprecated**，改推 **Client ID Metadata Documents**（用 HTTPS URL 当 client_id）。stdio 传输 **SHOULD NOT** 走这套，改用环境变量取凭据。
来源：https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

### B-5. **重点：MCP 有没有 task / long-running 原语？——有，且已两次改形**

**结论：不用自造 task 原语的"协议壳"，但要自造"协调语义"。**

1. **SEP-1686「Tasks」**：Created **2025-10-20**，作者 Surbhi Bansal、Luca Chang，PR #1686，状态 **Final（Standards Track）**。它**作为 experimental 特性进入了 `2025-11-25` 正式 spec 核心**。那一代形态：请求 `_meta` 带 `modelcontextprotocol.io/task {taskId, keepAlive}`（**客户端生成 taskId**），方法 `tasks/get`（返回 `status`、`keepAlive`、`pollFrequency`，含 `"submitted"` 状态）、**`tasks/result`（阻塞取结果）**、`tasks/list`。
   来源：https://modelcontextprotocol.io/seps/1686-tasks

2. **SEP-2663「Tasks extension」**：`2026-07-28` **把 tasks 移出核心协议**，改为官方扩展 **`io.modelcontextprotocol/tasks`**，仓库 `modelcontextprotocol/ext-tasks`，规范文件 `specification/draft/tasks.md`。变更：**删 `tasks/result`（改 `tasks/get` 轮询）、删 `tasks/list`、新增 `tasks/update`、任务创建改为服务端主导且 taskId 服务端生成**。
   来源：https://modelcontextprotocol.io/specification/2026-07-28/changelog（Major changes 第 6 条）｜ https://modelcontextprotocol.io/extensions/tasks/overview ｜ https://raw.githubusercontent.com/modelcontextprotocol/ext-tasks/main/specification/draft/tasks.md

**当前扩展的确切语义**（逐字于 ext-tasks 草案）：
- **状态**：`working` / `input_required` / `completed` / `failed` / `cancelled`；**终态 = completed、failed、cancelled**（"once reached, the task's state does not change"）；`working ↔ input_required` 可来回。注意**没有 `submitted`**（那是 2025-11-25 那代的）。
- **Task 字段**：`taskId`、`status`、`statusMessage?`、`createdAt`、`lastUpdatedAt`、**`ttlMs: number | null`（null=无限，服务器可在 TTL 后丢弃，**该值生命周期内可变**）**、`pollIntervalMs?`（客户端 SHOULD 遵守）。派生形态 `WorkingTask/InputRequiredTask{inputRequests}/CompletedTask{result}/FailedTask{error}/CancelledTask`。
- **创建**：服务器对任意受支持请求（当前仅 `tools/call`）**自行决定**返回 `CreateTaskResult = Result & Task`，判别器 `resultType: "task"`；**客户端不能在请求上要求 task**，只能在每请求 `_meta.io.modelcontextprotocol/clientCapabilities.extensions["io.modelcontextprotocol/tasks"] = {}` 声明支持；服务器 **MUST NOT** 对未声明的客户端返回 task。
- **durability 硬要求**：服务器 **MUST NOT** 在 task 持久化前返回 —— "until a `tasks/get` for the returned `taskId` would resolve"，最终一致环境下必须等一致再回。
- **轮询/通知**：`tasks/get`；或服务器推 `notifications/tasks`（全量 task 状态，省一次 get），客户端经 `subscriptions/listen {notifications:{taskIds:[...]}}` 订阅，服务器在 `notifications/subscriptions/acknowledged` 里**回自己同意订阅的 taskIds 子集**。
- **取消**：`tasks/cancel` 只返回空 ack；**cooperative + eventually consistent**，可能最终停在非 `cancelled` 的终态；客户端发出取消后即可丢弃本地关联状态。
- **错误分层**：协议级错误 → `failed` + `error`；业务错误（如 tool `isError: true`）→ **`completed` + result**（"strong separation between protocol-level faults and other faults"）。taskId 不存在/已过期 → `-32602`，且"servers are not required to retain tasks indefinitely"。
- **安全**：taskId 可被当作 bearer token，**必须高熵不可枚举**；**故意不提供 `tasks/list`**，理由是「没有 list 就不会把一个调用者的 task 泄露给另一个」——明确把 2025-11-25 的 list 视为安全缺陷。

**⚠️ 已核实的规范内部不一致**：changelog（Minor #12）说 `MissingRequiredClientCapability` 错误码由 `-32003` **重编号为 `-32021`**，但 ext-tasks 草案文全篇仍写 `-32003`。实现时别照抄单边。

---

## 对我们协调核的可借鉴与红线（要点）

1. **不要指望 MCP/A2A 现成原语覆盖协调核**：两者都**没有 lease/租约、lock、依赖图、认领/指派**。A2A 有 `ListTasks`（含过滤+游标分页+按更新时间倒序+授权 scoping）可直接抄成"任务板查询"语义；MCP **刻意删掉了 `tasks/list`**，若我们的 MCP 后端要暴露看板，必须自建 list 并自己承担 A2A 已写明的授权 scoping 责任。
2. **状态机取交集再加我们的两态**：working / input_required / completed / failed / cancelled 是两边共识；A2A 额外的 **rejected（拒接）** 与 **auth_required** 值得吸收；我们还需 `blocked`(依赖未满足) 与 `lease_expired`，这两个两边都没有。终态不可变（MCP 明写）应作为硬不变量。
3. **租约 = TTL + 心跳 + 服务端权威时间**：MCP 的 `ttlMs`（可为 null、生命周期内**可变**）+ `pollIntervalMs`（服务端下发的轮询节奏）是现成范式；配 A2A 的 `status.timestamp` 与 `status_timestamp_after` 过滤即可做"陈旧租约扫描"。
4. **无状态化是趋势，别把协调状态挂在连接上**：MCP 2026-07-28 删掉 session、删掉 SSE 可恢复，并把跨调用状态的唯一合规出路定为「**服务器铸造的显式 handle 当普通参数传**」（SEP-2567）。我们的 lease token / lock handle 应当就是这种显式句柄，且**必须高熵**（MCP 把 taskId 当 bearer token 对待）。
5. **写侧幂等要自己造**：A2A 只给到 "SendMessage MAY 用 messageId 去重"、webhook 至少一次 + 客户端必须幂等；两边都没有 CAS/ETag。跨机器抢锁必须我们自己提供 compare-and-swap 或 fencing token。
6. **通知只能当加速，不能当真相**：A2A webhook 至少一次可重复，MCP 通知需订阅且服务端可只同意子集、断流不重放。**轮询必须始终是可用的兜底路径**（与我们「门是兜底非主防线」的一贯判据一致）。
7. **能力声明分三层**（传输/协议开关/语义标签），未声明能力的调用**硬拒**并给出确定性错误码 —— A2A §3.3.4 与 MCP 的 `-32003/-32021 Missing Required Client Capability` 是同一套做法，可直接用于 `requires:{host:codex}` 的拒绝路径。
8. **协议版本必须在每个请求上自证**（MCP `_meta.protocolVersion` + `MCP-Protocol-Version` 头且要求一致；A2A `A2A-Version` 头、空值按 0.3 解释）。我们的文件后端同样要在每条记录写 schema 版本，避免旧 hook 读新布局。

🐱：喵~~~