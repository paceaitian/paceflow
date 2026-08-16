# 子代理报告原文：DAG ready-set 调度先例调研（opus 研究员，2026-08-16）

> **可信度**：在线调研，12 次 WebFetch（用满预算），一手抓取成功项附 URL；标注「未能抓取」的条目仅依据 WebSearch 摘要，可信度低一档（报告末尾有失败清单）。主 session 未逐条复核外部来源，引用进设计正文时按「一手抓取 / 二手摘要」区分。

---

## 1. Apache Airflow —— trigger rule 是「下游可运行判据」的成熟词汇表

**机制要点**（官方 stable 文档，2026-08-16 抓取）：Airflow 用 `trigger_rule` 决定一个 task 在上游到达某组合状态时是否可运行，共 13 种：`all_success`（默认）、`all_failed`、`all_done`、`all_done_setup_success`、`all_done_min_one_success`、`all_skipped`、`one_failed`、`one_success`、`one_done`、`none_failed`、`none_failed_min_one_success`、`none_skipped`、`always`。关键是**上游失败不是让下游卡住，而是给下游一个新终态** `upstream_failed`——`all_failed` 的定义原文就是「All upstream tasks are in a `failed` or `upstream_failed` state」，说明 `upstream_failed` 参与后续判据。文档明确警告 skip 会级联：「Skipped tasks will cascade through trigger rules `all_success` and `all_failed`」。文档承认 DAG 得名于 acyclic，但**这一节没有描述任何环检测机制**。
来源：https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html

**出队优先级**：`priority_weight`（默认 1，越大越优先，上限 2147483647）配 `weight_rule`——`downstream`（默认，权重=全部下游后代之和，让上游更激进地跑）、`upstream`（=全部上游祖先之和，让已开工的 run 先收尾）、`absolute`（不做聚合，超大 DAG 有性能收益）。
来源：https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/priority-weight.html

**并发一致性**：scheduler 的选取放在一个**临界区**里，对 pool 表行加写锁（约等于 `SELECT ... FOR UPDATE NOWAIT`），原文理由是「we need to ensure that only a single scheduler is in this critical section at once - otherwise limits would not be correctly respected」；多 scheduler 靠共享元数据库，不用共识算法；`max_tis_per_query` 控制批大小，且不应超过 `core.parallelism`。
来源：https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html

**可借鉴**：把「ready 判据」做成**每任务可配的一小组枚举规则**而不是硬编码「全部依赖 completed」。**坑**：13 种规则是十年演化出来的复杂度，skip 级联是 Airflow 用户最经典的困惑源；我们只需要 3–4 种。

## 2. Argo Workflows / Temporal —— 表达式 vs 代码

**Argo**（readthedocs latest，抓取成功）：`depends` 字段用 `<task>.<result>` 作操作数，result 取 `Succeeded` / `Failed`（非 0 退出码）/ `Errored`（非退出码类错误）/ `Skipped`（`when` 为假）/ `Omitted`（`depends` 为假）/ `Daemoned`，聚合选择器 `.AnySucceeded` / `.AllFailed`，布尔算子 `&& || !`。**默认语义**（省略 result 时）是 `(task.Succeeded || task.Skipped || task.Daemoned)`，以兼容老的 `dependencies` 数组。`Skipped` 与 `Omitted` 的产物解析为空串。
来源：https://argo-workflows.readthedocs.io/en/latest/enhanced-depends-logic/

**可借鉴**：`Omitted` 这个状态很值得抄——「因为依赖判据为假而根本没跑」必须与「跑了但失败」区分开，否则下游无法写出正确条件。**坑**：布尔表达式一旦开放就要写 parser，且 Argo 自己有多个 issue 记录 `depends` 与 `withParam` / omitted task 组合下的语义困惑（GitHub issues #10321、#14774）；对我们这种协调核，表达式自由度是负债。

**Temporal**（官方文档，抓取成功）：**没有静态 DAG**，依赖由通用语言代码的控制流表达；代价是 workflow 必须**确定性**——「has to make the same decisions when given the same history」，不能直接用 `Date.now()`/随机数；恢复靠 event history 全量 replay，activity 结果在 replay 时复用而不重算。
来源：https://docs.temporal.io/workflows

**取舍**：代码表达依赖 = 无限灵活但**无法在调度器侧静态算 ready-set**（谁能跑只有 replay 到那一步才知道）。我们要的恰恰是「协调核确定性地算出 ready-set」，所以**必须选静态依赖声明这条路**，Temporal 是反面参照，不是模仿对象。

## 3. 构建系统 ready queue 与 Kahn 算法

**Ninja**（官方 manual，抓取成功）：按文件 mtime 判定脏，依赖满足的 edge 即「ready」，可立刻占用并行槽；`-j` 控总并行度；`pool ... depth = N` 限制特定 rule 的并发（例如 `link_pool depth=4`），且**任何 pool 都不会突破 `-j` 总上限**；内置 `console` pool depth=1 且独占 stdio。`restat` 让命令跑完后重新检查输出时间戳，没变则把反向依赖从待办里摘掉，避免级联重建。
来源：https://ninja-build.org/manual.html
（Evan Martin 的 AOSA 章节 https://aosabook.org/en/v1/ninja.html **未能抓取，404**。）

**Bazel / Buck2 的 critical-path 优先**：**未能抓取，据 WebSearch 摘要**——通用调度文献的做法是全局 ready queue + critical path 启发式（优先跑「到 sink 的最长路径」上的任务）；Buck2 的公开介绍强调各阶段非阻塞、目标可并行穿越状态机（https://www.tweag.io/blog/2023-07-06-buck2/ 、https://www.buildbuddy.io/blog/buck2-review/ ）。没能找到 Buck2 调度器细节的一手文档，这条不要当结论用。

**Kahn 算法**（据 WebSearch 摘要，无一手抓取）：维护每节点 in-degree，in-degree=0 入队即 ready-set；处理完一个节点就给后继减 1，减到 0 再入队。**环检测是副产品**：若跑完仍有节点未出队，说明存在环（环内节点 in-degree 永不归零）。对生产系统的优势是确定性顺序 + 显式环检测 + 非递归。

## 4. Beads (bd) —— 最贴近我们场景的先例

**一手抓取**：README（raw.githubusercontent）与 AGENTS.md 抓取成功；官方文档站 https://steveyegge.github.io/beads/ **未能抓取，404**。

- `bd ready` 的定义就是「tasks with no open blockers」——**只看 blocker，不做复杂 trigger rule**；README 没给遍历算法细节。
- 依赖/链接类型：`blocks`、`related`、`parent-child`（支持 epic `bd-a3f8` → `bd-a3f8.1` → `bd-a3f8.1.1` 的层级编号）、`discovered-from`，另有 `duplicates`、`supersedes`、`replies-to`。**只有 `blocks` 参与 ready 计算**，其余是知识图谱语义——这个分层非常重要。
- ID：hash 型 `bd-a1b2`，README 原话是「Hash-based IDs prevent merge collisions in multi-agent/multi-branch workflows」——**用 ID 生成方式消灭并发冲突，而不是加锁**。
- 存储：主存已从 SQLite 迁到 Dolt（版本化 SQL，cell-level merge、原生 branch/merge）；`.beads/issues.jsonl` 被明确降级为「an export for viewers and interchange, **not the source of truth or a backup**」。嵌入式 Dolt 面向单写者，多写者要走 server 模式。
- Agent 契约（AGENTS.md 原文命令）：`bd ready --json` 找活 → `bd update <id> --claim --json` 原子认领 → `bd close <id> --reason "..." --json` 收尾；新发现的活用 `bd create "..." -p 1 --deps discovered-from:<parent-id>`。AGENTS.md **没有**写并发锁或互斥协议。
来源：https://github.com/steveyegge/beads 、https://raw.githubusercontent.com/steveyegge/beads/main/AGENTS.md 、https://deepwiki.com/steveyegge/beads/4-cli-commands-reference （后者为二手）

**坑**：`--claim` 的原子性依赖底层 DB 事务；一旦退回纯文件后端（JSONL），这个原子性就没了——Beads 自己也是靠「JSONL 不是真相源」绕开的。

## 5. Claude Code Agent Teams（v2.1.178+，官方文档抓取成功）

三态：pending / in progress / completed。原文：「a pending task with unresolved dependencies cannot be claimed until those dependencies are completed」；认领两条路径——lead 指派，或 teammate 自取「the next unassigned, unblocked task」。**并发一致性明确用文件锁**：「Task claiming uses file locking to prevent race conditions」。解阻塞是自动的：「when a teammate completes a task that other tasks depend on, it unblocks the dependent tasks without any action from you」。任务列表落在 `~/.claude/tasks/{team-name}/`。
**官方承认的坑**（Limitations 节）：「**Task status can lag**: teammates sometimes fail to mark tasks as completed, which blocks dependent tasks」——即**没有租约/超时，漏标 completed 会永久卡死下游，只能人工改**。文档全篇未提环检测。
来源：https://code.claude.com/docs/en/agent-teams

## 6. 产品先例：GitHub / Linear（简述）

- GitHub Issues 的 blocked by / blocking 已 GA，每种关系最多链 50 个 issue，API + webhook 全支持，2026-06 起 `gh` CLI 有 `--blocked-by` / `--blocking` 及 `--add-*` / `--remove-*`。**据 WebSearch 摘要**（changelog：https://github.blog/changelog/2025-08-21-dependencies-on-issues/ 、https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/ ；API：https://docs.github.com/en/rest/issues/issue-dependencies ）。
- Linear（官方文档抓取成功）：四种关系 blocks / blocked by / related / duplicate；blocked 显示橙旗、blocking 显示红旗；**有自动流转**——「Once the blocking issue has been resolved, the relationship moves under _Related_」。
来源：https://linear.app/docs/issue-relations

**共同点**：产品侧只做「可视化 + 关系降级」，**不阻止你开工**。这是软门；我们要的是硬门，别照抄它们的宽松语义。

## 7. 对我们设计的直接建议

**(a) ready-set 最小算法与数据结构。** 用 Kahn 的增量版而非每次全图重算：为每个任务维护 `open_blocker_count`（未完成的 `blocked-by` 数）与反向边 `blocks[]`。ready-set = `{t | t.status == pending ∧ t.open_blocker_count == 0 ∧ 能力标签匹配}`。任务终结时只对其 `blocks[]` 逐个减 1，减到 0 的入 ready 索引——O(出度) 而非 O(V+E)。**依赖类型分层照抄 Beads**：只有 `blocked-by` 进计数器，`related` / `parent-child` / `discovered-from` 一律不参与 ready 计算，否则 epic 的 parent 会把所有子任务锁死。`claim_next` 只读这个物化索引，不做图遍历。

**(b) 优先级出队。** 不要一上来就上 critical path。建议三级确定性排序键：`(priority_weight DESC, unblocked_downstream_count DESC, created_at ASC)`。第二项是 Airflow `weight_rule=downstream` 的廉价近似（解锁下游多的先跑），且**必须有 `created_at` 兜底保证全序**——同分随机出队会毁掉「确定性协调核」这个卖点。Airflow 提供了 `absolute` 逃生舱的先例：给一个「关掉聚合、只认显式权重」的开关，供大图或人工插队用。

**(c) 上游失败/取消时下游状态。** 抄 Airflow 的 `upstream_failed` + Argo 的 `Omitted`：下游**必须离开 pending 进入一个显式终态**（建议 `blocked-failed`），绝不能停在 pending 里——停在 pending 会让 ready-set 永远漏掉它，人也看不出为什么没人做（这正是 Agent Teams 文档承认的「task status can lag」故障形态）。默认判据用 `all_success`；再提供 `all_done`（不管上游成败都放行，给 cleanup 类任务）和 `none_failed`（允许上游被跳过）两条，**三种就够**，别做 13 种，更别做 Argo 那样的布尔表达式 parser。取消（cancelled）与失败走同一条传播路径，但终态区分开，便于 resume 时批量重开。

**(d) 并发 `claim_next` 一致性。**
- **文件后端**：单写者最省事但会成瓶颈；推荐**乐观并发 + CAS**——每个任务带 `version`/`etag`，认领时 `O_EXCL` 创建 `claims/<task-id>.<agent>.lock` 或用「读 version → 写 version+1，写前比对」，写用 `tmp + rename()`（同目录 rename 在 POSIX 上原子）。**关键补 Agent Teams 缺的那一环：租约（lease）**——claim 写入 `claimed_by` + `lease_expires_at`，agent 心跳续租，过期自动回 ready-set。Agent Teams 的文件锁只防了同时抢，没防**抢到后死掉**，这是它文档里唯一自曝的死穴，我们必须补。
- **HTTP 后端**：走 DB 事务，`SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` 单语句出队（Airflow 用 `FOR UPDATE NOWAIT` 保护 pool 临界区是同一思路的一手先例）；对外用 `If-Match: <etag>` 暴露 CAS，409 让客户端重试。租约字段与文件后端共用，保证两个后端语义一致。
- 两个后端都要保证 `claim_next` **幂等可重试**：同一 agent 重复 claim 同一任务返回同一结果，不产生第二次占用。

**(e) 环检测放写入时。** 写入时检测（新增 `blocked-by` 边时从目标点做一次 DFS/正向可达性判断，命中即拒绝写入并报出环路径）优于 claim 时检测。理由：写入是低频且有明确责任人——谁加的边谁看到报错，能立刻修；claim 时才发现则表现为「ready-set 莫名为空」，且报错抛给一个跟建图无关的 agent，无法归因。**但要同时保留 claim 时的兜底断言**：一次全图 Kahn，若有节点 `open_blocker_count > 0` 却全部前驱已终结，说明计数器与图漂移了（增量维护的经典 bug），记 warning 并触发重算——**这条兜底必须真能走到，别写成不可达的假兜底**。写入时拒绝 + claim 时对账，两层都要。

---

**抓取失败清单**（结论请勿引用为一手）：`aosabook.org/en/v1/ninja.html`（404）、`steveyegge.github.io/beads/`（404）；Buck2/Bazel critical-path 调度、Kahn 算法工程实践、GitHub issue dependencies 三项**仅有 WebSearch 摘要**，无一手文档抓取。
