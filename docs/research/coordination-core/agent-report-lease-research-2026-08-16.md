# 子代理报告原文：分布式租约 / 心跳先例调研（opus 研究员，2026-08-16）

> **可信度**：在线调研，12 次 WebFetch（用满预算）+ 2 次 WebSearch 补位；一手抓取项附 URL，末节「抓取失败 / 降级标注汇总」列出仅据 WebSearch 摘要的数值（K8s 选主三参数、RQ 数值、Celery `task_acks_late` 默认值、DynamoDB Lock Client 示例参数非默认值）。主 session 未逐条复核外部来源。

---

## 1. AWS SQS Visibility Timeout

**机制要点**：消息被 receive 后不出队，只是对其他消费者「暂时不可见」；处理完必须显式 `DeleteMessage`。超时未删则重新可见，可被同一或另一消费者再取。

**默认/参数**（https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html ，2026-08-16 查）：
- 默认 visibility timeout **30 秒**；可按队列设，也可按单条消息设。
- `ChangeMessageVisibility` 可随时延长/缩短；设为 **0 秒** 即立即释放（主动 nack）。
- **硬顶 12 小时**，从消息首次被接收算起，**续约不重置这个 12 小时**。
- 标准队列 in-flight 上限约 **120,000** 条（超限报 `OverLimit`）。
- 官方最佳实践原文：不确定处理时长时「begin with a shorter timeout (for example, **2 minutes**) and extend it as necessary. Implement a **heartbeat mechanism** to periodically extend the visibility timeout」。
- 失败多次的消息配 **Dead-Letter Queue (DLQ)** 单独收容。

**可借鉴语义**：短租约 + 显式续约 + 主动释放（timeout=0）三件套；失败 N 次进 DLQ 而非无限循环。
**坑**：明确写着 at-least-once —「Amazon SQS doesn't guarantee that a message won't be delivered more than once **within** the visibility timeout period」。即**租约期内也可能重复投递，租约不是互斥保证**。租约设太长则死 worker 的任务迟迟不回池。

## 2. Temporal

**机制要点**：Worker **主动 poll** Task Queue 拉取任务（https://docs.temporal.io/workers ：「A Worker Process is responsible for polling a Task Queue, dequeueing a Task, executing your code in response to a Task, and responding to the Temporal Service with the results.」），不是服务端 push；Worker 无状态，阻塞中的 Workflow 可从一个 Worker 移除，later「resurrected on the same or different Worker」。Activity 用 Heartbeat 向服务端证明存活：「a ping from the Worker that is executing the Activity to the Temporal Service」。

**默认/参数**（https://docs.temporal.io/encyclopedia/detecting-activity-failures 与 https://docs.temporal.io/encyclopedia/retry-policies ）：
- Heartbeat Timeout = 两次心跳之间的最大间隔；超时则 Activity Task 失败并按重试策略重试。**无显式默认值**（不设即不检测）。
- 心跳节流：Worker 实际发送频率取 `min(heartbeatTimeout × 0.8 或 defaultHeartbeatThrottleInterval, maxHeartbeatThrottleInterval)`；`defaultHeartbeatThrottleInterval = 30s`，`maxHeartbeatThrottleInterval = 60s`。
- Schedule-To-Start / Start-To-Close / Schedule-To-Close 默认全是 **∞**。
- Activity 默认重试策略：initial interval **1s**，backoff coefficient **2.0**，max interval **100 × initial**，max attempts **∞**；Activity 默认自动重试，Workflow Execution 默认不重试。
- Workflow Task 不走 Retry Policy，而是重试到 Workflow Execution Timeout（默认无限），指数退避、max interval **10 分钟**。
- Heartbeat details 可携带进度，重试时从断点恢复——但前提是「the Worker itself did not crash **before delivering it**」。

**可借鉴语义**：心跳发送频率 ≈ 超时的 **0.8 倍以内**（至少留 20% 余量）是官方内建的节流上限；heartbeat 顺带带 checkpoint 数据，让重试不从零开始（对我们＝重新领到任务的 agent 能看到上一个 agent 的进度笔记）。
**坑**：默认超时全 ∞ + 默认重试 ∞ 次，是「durable execution 事件历史兜底」前提下的选择；我们没有重放能力，不能照抄无限重试。

## 3. Kubernetes `coordination.k8s.io/Lease`

**机制要点**（https://kubernetes.io/docs/concepts/architecture/leases/ ）：Lease 是 k8s 原生分布式租约对象，字段 `spec.holderIdentity` / `leaseDurationSeconds` / `renewTime` / `acquireTime` / `leaseTransitions`。两大用途：
- **节点心跳**：每个 Node 在 `kube-node-lease` 命名空间有同名 Lease，kubelet 的每次心跳就是一次 update，只刷 `spec.renewTime`；控制面据此判断节点存活。
- **选主**：kube-controller-manager / kube-scheduler HA 用它保证只有一个实例在跑。
- apiserver identity lease：`leaseDurationSeconds: 3600`，过期后 1 小时 GC。
- v1.36 alpha 特性 `ControllerManagerReleaseLeaderElectionLockOnExit`：退出时**主动释放锁**，避免干等 TTL 过期才能重新选主。

**选主默认参数**（*该 flag 参考页正文被截断未抓全，以下据 WebSearch 摘要*，页面 https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/ ）：`--leader-elect-lease-duration` **15s**、`--leader-elect-renew-deadline` **10s**、`--leader-elect-retry-period` **2s**；约束 lease-duration **必须大于** renew-deadline，否则组件启动 panic。

**可借鉴语义**：三参数分层——**租约时长（别人多久敢抢）> 续约截止（我多久续不上就自我下台）> 重试周期（尝试频率）**。「自我下台」这一层最值得抄：持有者自己发现续不上就主动停手，不等别人来抢。
**坑**：15s 级参数是同机房 etcd 的假设；跨机器、跨 WSL/笔记本休眠的 agent 场景必须放大一个量级。

## 4. DynamoDB Lock Client + Kleppmann 的 fencing 论证

**机制要点**（https://aws.amazon.com/blogs/database/building-distributed-locks-with-the-dynamodb-lock-client/ ）：锁是 DynamoDB 里的一条 item，存 owner 主机名、lease duration（毫秒）、UUID、系统时钟。核心是 **Record Version Number (RVN)**：每次获取或心跳都换新 UUID；抢锁方两次读取间隔 ≥ lease duration 后发现 **RVN 没变**，即判定持有者已死。续约通过 `UpdateItem` 条件写完成（「uses the DynamoDB UpdateItem API to heartbeat and extend locks each host owns」），靠 **conditional writes** 保证原子性。

**参数**（文档示例配置，**非库内建默认值**）：`withLeaseDuration(10L)` + `withHeartbeatPeriod(3L)`，`withTimeUnit(TimeUnit.SECONDS)`，`withCreateHeartbeatBackgroundThread(true)` → **租约:心跳 ≈ 3.3:1**，后台线程自动续约。

**Kleppmann 的论证**（https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html ）：光有租约过期**不安全**——「if the GC pause lasts longer than the lease expiry period, and the client doesn't realise that it has expired, it may go ahead and make some unsafe change.」解法是 **fencing token**：「a fencing token is simply a number that increases (e.g. incremented by the lock service) every time a client acquires the lock」，且**存储侧**必须拒绝携带旧 token 的写入。他区分 efficiency lock（丢了只是重复干活）和 correctness lock（丢了会损坏数据），并指出 Redlock 依赖「delays, pauses and drift are all small relative to the time-to-live of a lock; if the timing issues become as large as the time-to-live, the algorithm fails」的同步系统假设，不适合正确性场景。
**坑**：RVN 判死依赖本地时钟测量的时间间隔；fencing 的关键在于**校验方是被写的资源本身**，锁服务单方面发 token 毫无意义。

## 5. GitHub Actions self-hosted runner

**机制要点**（https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow ）：`runs-on` 写标签数组，**全匹配 AND 语义**——「a self-hosted runner must have **all four labels** to be eligible to process the job」。Runner 自动带三类内建标签：`self-hosted`、OS（`linux`/`windows`/`macOS`）、架构（`x64`/`ARM`/`ARM64`）。Runner group 用 `runs-on: group: <name>` 路由；group 与 labels 同时给出时「the runner must meet **both** requirements to be eligible to run the job」。

**限额**（https://docs.github.com/en/actions/reference/limits ）：自托管 runner 单 job 最长 **5 天**（GitHub 托管为 **6 小时**）；**job 排队 24 小时后自动取消**（「A job can be in the queue for 24 hours before it is automatically cancelled」）；单次 workflow run **35 天**（含审批等待）；runner 注册 **1500 个 / 5 分钟 / 仓库或组织**；单 group 上限 **10,000 runner**；GitHub 托管并发按套餐 20–500（larger runner 最高 1,000）。

**可借鉴语义**：能力标签**全匹配 AND** + 自动注入内建标签 + group 作为隔离/授权维度，这正是 `claim_next(能力标签)` 最接近的成熟先例。「无匹配 runner → 排队而不是失败，但有 24h 硬上限」是极好的默认策略。
**坑**：标签是 runner 自我声明的，没有能力校验；打错标签 = 任务无声排队到超时。另：「runner 是否长轮询」「一个 runner 是否只跑一个 job」该页**未覆盖，未确认**，正文不作断言。

## 6. Celery / RQ

**Celery**：`task_acks_late` 默认 **False**（执行前就 ack）；置 True 则执行后才 ack，「the task may be executed twice if the worker crashes mid execution」，因此**必须幂等**（https://docs.celeryq.dev/en/stable/userguide/tasks.html 、https://docs.celeryq.dev/en/stable/userguide/configuration.html ，*默认值据 WebSearch 摘要，配置单页过大未直抓*）。陷阱：即使开了 acks_late，worker 进程被 KILL/INT 突然退出时仍会 ack，需配 `task_reject_on_worker_lost` 才会重排队。

Redis broker 的 `visibility_timeout` 默认 **3600 秒（1 小时）**（https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/redis.html ）：「If a task isn't acknowledged within the Visibility Timeout the task will be redelivered to another worker and executed. This causes problems with ETA/countdown/retry tasks where the time to execute exceeds the visibility timeout; in fact if that happens **it will be executed again, and again in a loop**.」——这是租约设计最经典的事故模式。官方建议远期调度改用数据库支撑的周期任务，而不是无限调大 visibility_timeout。

**RQ**（https://python-rq.org/docs/workers/ 正文未含具体数值，以下**据 WebSearch 摘要 + 源码** https://github.com/rq/rq/blob/master/rq/worker.py ）：默认 job timeout **180 秒**，超时则 worker 杀掉 work horse 并置失败；job 注册进 `StartedJobRegistry` 的 TTL = `(job.timeout or 180) + 60`；`DEFAULT_WORKER_TTL` **420 秒**（worker 心跳有效期）；maintenance 间隔默认 **600 秒**，负责把 StartedJobRegistry 里超期的孤儿 job 以 `AbandonedJobError` 挪进 `FailedJobRegistry`。

**可借鉴语义**：注册表 TTL = 任务超时 + 固定余量（+60s）；**独立的清扫进程**负责回收孤儿，而不是靠抢锁方顺手判死。

## 7. 对我们设计的直接建议

### (a) lease 时长与 heartbeat 周期的推荐比例

先例数据点收敛得很一致：K8s 选主 15s lease / 2s retry ≈ **7.5:1**（renew-deadline 10s 是 2/3 处的自我下台线）；DynamoDB Lock Client 示例 10s / 3s ≈ **3.3:1**；Temporal 心跳节流上限是 `heartbeatTimeout × 0.8`，即最少留 20% 余量。

**建议：lease : heartbeat = 3:1 到 5:1**。理由：允许连丢 2–4 次心跳（一次网络抖动、一次长工具调用、一次 GC）才判死，同时把死 agent 的回收延迟压在一个 lease 内。考虑 AI agent 的现实节奏（单次 LLM 调用可达数分钟、WSL 休眠、笔记本合盖），具体取 **lease 120s + heartbeat 30s**（4:1）。另外抄三条：
1. **自我下台线**（K8s renewDeadline 语义）：agent 续约连续失败超过 `lease × 2/3` 就**主动停止一切写入**，不等被抢；
2. **主动释放**（SQS `VisibilityTimeout=0` / K8s v1.36 退出释放锁）：agent 正常结束或用户 Ctrl-C 时立即释放租约，任务秒级回池；
3. **硬顶**（SQS 12 小时不因续约重置）：单次 claim 设总时长上限（建议 2–4 小时），到点强制回池，防止一个卡死但心跳仍在的 agent 永久占用任务。

### (b) fencing token 在「写 artifact 文件」场景是否需要

**需要，而且这是 correctness lock 不是 efficiency lock。** Kleppmann 的 GC-pause 场景在我们这里不是理论风险：WSL 休眠、笔记本合盖、单次工具调用阻塞十几分钟，都会让一个 agent 在租约早已过期后「醒来继续写」。文件系统不会替我们拒绝这次写。

**落地方案**（对齐 DynamoDB Lock Client 的 RVN 条件写）：
- 任务板为每次 claim 分配**单调递增**的 `fence`（全局计数器，或 `task_id` 上的 `claim_seq`），随 claim 返回给 agent；任务记录里存 `holder` + `fence`。
- **所有对该任务 artifact 的写入必须经由一个 CAS 提交点**：写临时文件 → 提交时原子校验「任务记录中的 `fence` == 我持有的 `fence`」→ 相等才 `rename()` 生效，不等则拒绝并让该 agent 自杀。
- 两条现成实现路径：任务板在 git 里 → 用 `update-ref` 的 old-value CAS；任务板在共享/本地文件系统 → 「单一 owner 文件 + `O_EXCL` 临时文件 + 原子 rename」，把 fence 写进被保护文件的 frontmatter，提交前先读回比对。
- 关键判据：**校验必须发生在被写资源侧**。只由任务板发 token 而 artifact 写入不校验，等于没做 fencing。

### (c) at-least-once 下 claim / complete 的幂等设计

至少一次是这些系统的共同底线（SQS 明说租约内也可能重复投递，Celery acks_late 明说崩溃会执行两次），所以按「重复必然发生」设计：
- **claim 幂等**：请求带 `(agent_id, task_id, attempt)` 作幂等键；同一 agent 重复 claim 同一任务返回**同一个 fence**而非新的；不同 agent claim 已被持有且租约未过期的任务，确定性拒绝。
- **complete 幂等**：complete 是条件更新——仅当 `status == in-progress AND holder == me AND fence == current` 才置 done；重复 complete 返回 **no-op 成功**（不是错误）。
- **artifact 写幂等**：写临时文件 + 原子 rename；同内容重写无害。避免 append 型副作用（append 天然不幂等）。
- **重试上限 + 死信**：抄 SQS DLQ / RQ `FailedJobRegistry` —— attempt 计数超阈值（建议 3）就移入 `failed` 列等人工介入。**不要抄 Temporal 的 max attempts = ∞**（那建立在 durable execution 兜底上，我们没有）。
- **孤儿清扫独立化**：抄 RQ 的 maintenance 任务，用一个独立的确定性清扫步骤回收过期租约（注册表 TTL = lease + 固定余量），而不是靠下一个抢锁者顺手判死——后者在没人来抢时任务会永久卡住。
- **`blocked-by` 求值**：`claim_next` 只从「依赖全部 done」的 ready 集合取，依赖在 claim 时刻确定性求值，不缓存 ready 集合（否则并发 complete 会产生陈旧视图）。

### (d) 「能力标签匹配」的最接近先例

**最接近的是 GitHub Actions 的 `runs-on` 标签匹配**：AND 全匹配、runner 自动带内建标签（`self-hosted` / OS / 架构）、runner group 作为第二维度且必须同时满足、无匹配时排队 24 小时后取消。直接映射到我们：
- 标签语义用 **AND 全匹配**，不做打分/权重/最优匹配——非确定性匹配会让「为什么这个任务没人领」无法调试；
- **自动注入内建标签**：`host=claude-code|codex-cli`、`os=linux|windows`、`machine=<hostname>`、`repo=<path>`，任务只需声明真正差异化的能力标签；
- group/域作为可选隔离维度（哪些 agent 有权领哪些任务）；
- 无匹配 agent 时**排队而非失败**，但设排队硬上限（如 24h）后自动标记 `stalled` 并告警——这是「标签打错导致无声饿死」的唯一防线。

次接近的先例是 **Temporal Task Queue**（worker 声明监听哪个 queue，等价于粗粒度单标签；多能力需开多队列，组合爆炸）和 **Celery 的 queue / routing key**（同样是队列名路由而非标签集合）。二者共同说明：**队列名路由不足以表达「能力集合」，标签集合 + AND 匹配才是对的抽象**——这正是 GitHub Actions 做法胜出的原因。

## 抓取失败 / 降级标注汇总

- `kubernetes.io/.../kube-controller-manager/`：页面正文在 flag 列表中途截断，选主三参数默认值（15s / 10s / 2s）**据 WebSearch 摘要**，建议落地前用 `kube-controller-manager --help` 一手复核。
- `python-rq.org/docs/workers/`：正文不含具体数值，RQ 的 180s / 420s / 600s / `+60` **据 WebSearch 摘要 + rq/worker.py 源码**。
- Celery `task_acks_late` 默认值 **据 WebSearch 摘要**（configuration.html 单页过大未直抓）；Redis `visibility_timeout` 3600s 为**直抓官方页原文**。
- `docs.temporal.io/workers`：未含 Sticky Execution、long-polling 端口细节、Workflow Task Timeout 默认 10s，这些**未能确认**，正文中未作断言。
- DynamoDB Lock Client 的 10s / 3s 是**官方博客示例配置**，非库内建默认值，请勿当作 default 引用。

## 来源清单

- https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html
- https://docs.temporal.io/encyclopedia/detecting-activity-failures
- https://docs.temporal.io/encyclopedia/retry-policies
- https://docs.temporal.io/workers
- https://kubernetes.io/docs/concepts/architecture/leases/
- https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/ （截断）
- https://aws.amazon.com/blogs/database/building-distributed-locks-with-the-dynamodb-lock-client/
- https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
- https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow
- https://docs.github.com/en/actions/reference/limits
- https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/redis.html
- https://docs.celeryq.dev/en/stable/userguide/tasks.html
- https://docs.celeryq.dev/en/stable/userguide/configuration.html
- https://python-rq.org/docs/workers/
- https://github.com/rq/rq/blob/master/rq/worker.py
