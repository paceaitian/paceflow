# 子代理报告原文：「去中央 LLM 调度器」的反例与教训调研（opus 研究员，2026-08-16）

> **可信度**：在线调研（prior-art 研究员派出的子研究员，主 session 从其 transcript 提取最终报告原文）；一手来源（Cognition / Anthropic 工程博客、CrewAI/AutoGen/Beads GitHub issues、MAST arXiv、git-bug 设计文档、sqlite.org）附 URL，Nesbitt 复盘标注为二手；末节列出「未核实」项。主 session 未逐条复核外部来源。

---

# 「去中央 LLM 调度器」的反例与教训调研

## 1. Cognition：Don't Build Multi-Agents

**作者** Walden Yan，**2025-06-12**，https://cognition.com/blog/dont-build-multi-agents （原 cognition.ai 域名 301 到 cognition.com）。

两条原则原文：**"Share context, and share full agent traces, not just individual messages"**；**"Actions carry implicit decisions, and conflicting decisions carry bad results"**。反对并行 subagent 的机制论证：subagent 在缺乏原任务上下文与同伴决策可见性的情况下并行工作，各自补全隐含决策，产出互相冲突且 coordinator 无法调和。Flappy Bird 例子：subagent 1 做出 Super Mario 风格背景、subagent 2 做出不匹配的小鸟。提出的替代是**单线程线性 agent** + 引入一个 **context compression 模型**把历史压成关键细节以延长可运行时长。还提到 Claude Code 只把 subagent 用于「回答问题」这种不产生冲突决策的只读用途。

**启示**：这篇是对「中央 LLM 分派 + 并行 worker 自由裁量」的最强反例，但它反的是**隐式决策冲突**，不是并行本身。确定性核的对策不是退回单线程，而是让「谁做什么」从 LLM 裁量变成**可外化的显式决策**：租约（谁持有）+ 标签匹配（凭什么匹配）+ 依赖图（何时可做）三者都是可读、可校验、可被所有 agent 看到的状态。换句话说，Cognition 的「share full traces」在我们这里退化成更强的形式——**共享的不是 trace 而是 schema 化的状态**，冲突在写入时被拒绝而不是在合成时被发现。Flappy Bird 失败在「背景」和「小鸟」之间缺一条接口契约；依赖图正是这条契约的机器可读形式。

## 2. Anthropic：Building Effective Agents

**2024-12-19**，https://www.anthropic.com/engineering/building-effective-agents。

核心区分：**workflow** = "systems where LLMs and tools are orchestrated through **predefined code paths**"；**agent** = "systems where LLMs **dynamically direct their own processes** and tool usage"。五种 workflow 模式中的 orchestrator-workers：中央 LLM 动态拆解并委派，与 parallelization 的关键差别是 **"subtasks aren't pre-defined, but determined by the orchestrator"**，适用条件是**「你无法预测需要哪些子任务」**。成本警告：**"Agentic systems often trade latency and cost for better task performance"**，以及 "higher costs, and the potential for compounding errors"，总原则是 "only increasing complexity when needed"。

**启示**：这是我们最有力的正面背书。Anthropic 自己把 orchestrator-workers 的适用条件限定在「子任务不可预先确定」——而共享任务板的场景恰恰相反：任务由人或上游流程显式录入，依赖关系显式声明，**子任务是预先确定的**。按其分类法，我们要做的不是 agent 而是 **workflow**（predefined code paths），中央 LLM 调度器在这里属于「未被条件触发就引入的复杂度」。文档里 orchestrator 与 parallelization 的区分句可以直接引用为设计辩护。

## 3. Anthropic：How we built our multi-agent research system

**2025-06-13**，作者 Jeremy Hadfield 等 6 人，https://www.anthropic.com/engineering/multi-agent-research-system。

架构：lead agent 协调 + 并行 subagent，各自独立 context window 压缩后回传合成。**关键数字**：agent 比 chat 多用约 **4×** token；multi-agent 系统比 chat 多用约 **15×** token；multi-agent（Opus 4 lead + Sonnet 4 workers）比单 Opus 4 在内部研究评测上高 **90.2%**；token 用量单独解释 BrowseComp 评测方差的 **80%**；并行化把研究耗时降低 **up to 90%**；规模档位为简单查询 1 agent / 3-10 次工具调用，对比类 2-4 subagent，复杂研究 10+ subagent。

**明确不适合的场景**（原文）：**"Most coding tasks involve fewer truly parallelizable tasks than research"**；需要 **"all agents to share the same context"** 的领域；**"many dependencies between agents"** 的任务；需要实时协调的场景。工程教训：**"minor changes cascade into large behavioral changes"**；agent 长时间运行并跨大量工具调用维持状态，**"minor system failures can be catastrophic"**；**"agents make dynamic decisions and are non-deterministic between runs, even with identical prompts"**，调试困难；部署需要 rainbow deployment，因为 "agents might be anywhere in their process"；subagent 目前**同步**执行，"waiting for each set to complete before proceeding"，无法实时操舵；**"we can't just restart from the beginning: restarts are expensive"**，必须 checkpoint + durable execution。

**启示**：Anthropic 用自家最成功的多 agent 案例，明确把**编码任务**和**强依赖任务**划到不适用区，这是对「不给 coding 任务板配中央 LLM 调度器」的直接背书。15× token 是中央 LLM 决策的价格标签：租约+标签匹配是 O(1) 的确定性查表，成本近乎零。「相同 prompt 跨轮不确定」这条更致命——它意味着**中央调度器的分配结果不可复现、不可审计**，而租约表是可复现的。他们自己需要的 checkpoint / durable execution / 恢复能力，恰恰是「持久状态外置于 agent」的论证；我们把状态外置到任务板，是把他们事后补的东西做成架构前提。

## 4. CrewAI / AutoGen / Swarm 的 manager 模式实证问题

**CrewAI hierarchical process**（官方文档 https://docs.crewai.com/en/learn/hierarchical-process 强调 "Configuring the `manager_llm` parameter is crucial"，但**未给出任何「何时不该用」的告诫或成本说明**）。官方 issue 实证：

- #4783（2026-03-09，closed，6 comments）「manager agents cannot delegate to worker agents」——即使 `allow_delegation=True`，manager 只用自己的工具执行，**hierarchical 退化成 sequential**：https://github.com/crewAIInc/crewAI/issues/4783
- #2606（2025-04-15，closed，18 comments）manager 向 `DelegateWorkToolSchema` 传 dict 而 schema 要 string，**类型校验失败导致委派整体失败**：https://github.com/crewAIInc/crewAI/issues/2606
- #1503（2024-10-24，closed，7 comments）「Manager LLM doesn't seem to be working properly」——给出完全错误答案且不委派：https://github.com/crewAIInc/crewAI/issues/1503

**AutoGen GroupChat / SelectorGroupChat**：官方文档承认选人完全依赖 name/description 的 LLM 推断，并告诫 **"Try not to overload the model with too much instruction in the selector prompt"**，条件一复杂就建议改用 `selector_func` 自定义逻辑或拆成顺序 workflow（https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html）。issue 实证：#1064（2023-12-26）"select_speaker failed to resolve the next speaker's name… returned: TERMINATE" —— **LLM 返回了不存在的 agent 名**；#2499（2024-04-24，26 comments）`speaker_selection_method='auto'` 时选人 prompt **包含全部会话历史**，且 `TransformMessages` 钩子在 `select_speaker` 路径上根本不触发，无法裁剪 → 上下文爆炸；#3462（2024-09-02）小模型下 GroupChat 提示改用 `round_robin`（确定性策略）。

**OpenAI Swarm**：官方 README 已注明 **"Swarm is now replaced by the OpenAI Agents SDK"**，自我定位为 **"an educational resource"**，并且 **"does not store state between calls"**，明确 "We recommend migrating to the Agents SDK for all production use cases"（https://github.com/openai/swarm）。

**启示**：三家的失败点高度同构——**把「谁做下一步」交给一次自由文本 LLM 调用**，于是产生四类可复现故障：名字解析失败（幻觉出不存在的执行者）、schema 类型不符导致委派丢失、静默退化成串行/自循环、选人 prompt 无限膨胀。这四类在租约+标签匹配下**结构性不存在**：执行者来自注册表（不存在即匹配失败而非幻觉），匹配是集合运算（无 schema 解析），可做集合由依赖图闭包给出（无「不知道该轮到谁」）。AutoGen 官方在复杂时建议退回 `selector_func`/顺序 workflow、AutoGen issue 建议 `round_robin`，本身就是「确定性优于 LLM-soft」的官方承认。注意 CrewAI 官方文档只讲收益不讲代价，是典型的营销面——判据要以 issue tracker 为准。

## 5. 学术分析：Why Do Multi-Agent LLM Systems Fail?（MAST）

**arXiv:2503.13657**，v1 **2025-03-17**，v2 2025-04-22，v3 2025-10-26。作者 Mert Cemri、Melissa Z. Pan、Kurt Keutzer、Dan Klein、Matei Zaharia、Joseph E. Gonzalez、Ion Stoica 等（UC Berkeley 等）。https://arxiv.org/abs/2503.13657 ，正文数据取自 https://arxiv.org/html/2503.13657v3

**MAST 分类法**：14 个失败模式 / 3 大类；基于 150 条 trace 严格构建、1600+ 条标注 trace；标注者一致性 **Cohen's kappa = 0.88**；7 个开源 MAS 框架（ChatDev、MetaGPT、HyperAgent、AppWorld、AG2/MathChat、Magentic-One、OpenManus）的失败率 **41% – 86.7%**；摘要指出 MAS 相对单 agent 或 best-of-N 采样这类简单基线 **"performance gains on popular benchmarks are often minimal"**。

**14 个模式与占比**（1642 条 trace 口径）：
- **FC1 系统设计**：FM-1.1 违反任务规格 11.8% / FM-1.2 违反角色规格 1.5% / FM-1.3 **步骤重复 15.7%（单项最高）** / FM-1.4 丢失会话历史 2.80% / FM-1.5 **不知道终止条件 12.4%**
- **FC2 agent 间错位**：FM-2.1 会话重置 2.20% / FM-2.2 不主动澄清 6.80% / FM-2.3 任务脱轨 7.40% / FM-2.4 信息扣留 0.85% / FM-2.5 忽略同伴输入 1.90% / FM-2.6 **推理-行动不一致 13.2%**
- **FC3 任务验证**：FM-3.1 过早终止 6.20% / FM-3.2 无/不完整验证 8.20% / FM-3.3 错误验证 9.10%

**干预实验**（ChatDev）：改进角色规格 **+9.4%** 任务成功率；加入高层任务目标验证 **+15.6%**。

**启示**：三个占比最高的模式——步骤重复 15.7%、推理-行动不一致 13.2%、不知终止条件 12.4%——**全部可由确定性核直接消除或大幅压制**：租约（唯一持有者 + 到期回收）在结构上禁止两个 agent 重复同一步；状态机的显式终态就是终止条件，不靠 agent「感觉做完了」；「推理说 A 做了 B」在有写入门（状态转移必须落到任务板）时会被检出为状态未变更。验证类（FC3 合计约 23.5%）不在协调核职责内，但依赖图能保证「下游任务只在上游进入终态后才 ready」，等于把 FM-3.1 过早终止转成结构约束。**这篇是我们最好的量化弹药**：不是「多 agent 不好」，而是「失败集中在协调与终止这类本可确定性解决的地方」。另注意干预实验只有 +9.4%/+15.6%——**靠改 prompt 修协调问题回报有限**，支持「用机制而非提示词」。

## 6. Durable state：文件（git）vs 服务

### 6.1 git 作数据库的先例与坑

**git-appraise**（Google，https://github.com/google/git-appraise）：review 数据存 git-notes，`refs/notes/devtools/{reviews,ci,analyses,discuss}`，单行 JSON，靠 notes 的 **`cat_sort_uniq` 合并策略**自动合并——即**只支持「集合并集」语义的无冲突合并**，README 未讨论真正的并发/冲突/通知问题。**启示**：append-only 集合语义是文件后端唯一真正无痛的东西；一旦要表达「状态从 A 改到 B」（租约转移、状态机迁移），并集就不再是正确语义。

**git-bug**（https://raw.githubusercontent.com/git-bug/git-bug/trunk/doc/design/data-model.md）：不存最终状态，存 `Operation` 序列打包成 `OperationPack`（JSON blob），commit 链构成 DAG，挂在 `refs/<namespace>/<id>`。用 **operation-based CRDT** + **Lamport 逻辑时钟**：`L1 < L2` 表示先后，`L1 == L2` 表示**并发编辑**，时钟值编码在 tree entry 名里（如 `create-clock-4`）；并发时先按逻辑时钟排序，再按 OperationPack 标识**字典序**——原文承认这个次序 **"doesn't carry much meaning, but it's unbiased and hard to abuse"**。架构文档（doc/design/architecture.md）说明必须额外维护内存+磁盘的 **cache 与 `BugExcerpt` 预摘要**才能快速查询全集，并保证「同一 Bug 进程内只有一份实例，避免多副本丢数据」。**启示**：这是文件后端做多写者的**完整代价清单**——你必须自己实现 CRDT、逻辑时钟、确定性 tie-break，还必须在 git 之上再叠一层索引缓存，最终仍无事务、无 watch/notify。租约这种「互斥」语义**天然不是 CRDT**（CRDT 保证收敛，不保证互斥），强行做只能退化成「两个 agent 都以为拿到了租约，事后按字典序判一个输」——对已经开始改代码的 agent，事后回滚是不可接受的。

**Beads**（Steve Yegge，https://github.com/gastownhall/beads ，26k+ star，2025-10 起）——**最有价值的反面先例，因为它就是「AI agent 任务板」并且已经走完一轮**：
- 早期形态即「SQLite 本地库 + 后台 daemon 导出 `issues.jsonl` 提交进 git」。用户 issue #158（2025-10-26，https://github.com/gastownhall/beads/issues/158）标题即「Beads approach to merge conflicts?」，正文：*"I want agents to work in parallel, update issues independently, merge… I get in a LOT of trouble with sync issues, concurrency, and **corruption of the json store**（一度出现 4 个不同 prefix）… there's still the issue of **merge conflicts**. The `issues.jsonl` representation does not seem great for having agents handle these."* 场景正是多个 Claude 容器 bind-mount 同一份文件。
- **现状已迁移到 Dolt**（版本化 SQL 数据库）。官方 README + https://raw.githubusercontent.com/gastownhall/beads/main/docs/architecture/dolt.md ：两种模式——**embedded**（`.beads/embeddeddolt/`，**"single writer, file-locked"**，"Single-writer (one process at a time)"）与 **server**（外部 `dolt sql-server`，**"for multiple concurrent writers"**）。选 Dolt 的理由原文含 "cell-level diffs and merges, **not line-based**" 与 "Multi-writer support — server mode enables concurrent agents"。故障排查节直接写着 **"Lock Contention (Embedded Mode) — Symptom: 'database is locked' errors. Embedded mode is single-writer (enforced via file lock). If you need concurrent access, switch to server mode."**
- **JSONL 被降级**：README 原文 **"`.beads/issues.jsonl` is an export for viewers and interchange, not the source of truth or a backup"**；dolt.md 补充 JSONL 导出 "do not capture Dolt branches, full commit history, working-set state, or non-issue tables"。
- **代价被用户抓到**：issue #2489（2026-03-10，https://github.com/gastownhall/beads/issues/2489）*"Dolt migration breaks atomic code+issues-in-same-commit model"*——「issue 与代码同一个 commit/PR 原子同步」这个 git 原生杀手锏**随迁移丢失**，JSONL 变成 best-effort 异步快照，多机同步只能靠 Dolt remote 或「单向导出、无 merge」的 JSONL 往返。

**启示（最重要一条）**：一个和我们同题的 26k star 项目，从「文件 in git」实测走到「版本化 SQL + 单写者文件锁 / 多写者服务」，并**公开承认丢掉了 git 原子性**。这条演化轨迹本身就是结论：**「durable state 放 git 文件」与「多写者并发」二选一**，Beads 选了后者。我们要么接受单写者（用文件锁把并发串行化，多 agent 只能排队写板），要么接受服务进程。中间路线只有一种可行：**把板拆成两层——只追加、天然无冲突的事件流放文件/git（可审计、可进 PR），把互斥语义（租约获取）交给一个有原子 compare-and-swap 的小后端**。

### 6.2 反面：为什么 issue tracker 通常是服务

Nesbitt 的复盘（**二手**，但列举的是各项目一手公告，2025-12-24，https://nesbitt.io/2025/12/24/package-managers-keep-using-git-as-a-database.html）：Cargo 的 crates.io index 因 clone/delta 解析退化，经 RFC 2789 转 sparse HTTP，2025-04 时 99% 请求走稀疏协议；Homebrew 被 GitHub 要求停止 shallow clone（homebrew-core 331MB 传输、`.git` 达 1GB），4.0.0（2023-02）改为下载 JSON，维护者原话 *"they are expensive to git fetch and git clone… this provides a bad experience to end users"*；CocoaPods 1.8 因 GitHub 对 shallow clone 施加 CPU 限流而全面转 CDN/HTTP；Go modules 引入 GOPROXY（Go 1.13 起默认）+ checksum DB。文中归纳的机制：目录内文件数上限、大小写敏感性冲突、Windows 260 字符路径限制，以及**「git 缺少 CHECK/UNIQUE 约束、锁、事务、schema 迁移」**。

**启示**：这不是「git 不好」，是**访问模式错配**——git 给的是全量文档同步协议，任务板要的是点查、条件写、约束校验。我们的板如果要支持「按标签查 ready 任务」，在文件后端就必须像 git-bug 那样自建索引缓存（且缓存与真值可能不一致）。UNIQUE 约束的缺失尤其致命：**「一个任务同一时刻只有一个有效租约」正是一条 UNIQUE 约束**，git 无法表达。

### 6.3 SQLite 作并发后端的边界（一手，sqlite.org）

- https://www.sqlite.org/howtocorrupt.html §「Filesystems with broken or missing lock implementations」原文：*"some filesystems contain bugs in their locking logic such that the locks do not always behave as advertised. **This is especially true of network filesystems and NFS in particular.** If SQLite is used on a filesystem where the locking primitives contain bugs, and if two or more threads or processes try to access the same database at the same time, then **database corruption might result**."*（NFS 上可改用 dot-file locking VFS 规避 POSIX advisory lock 缺失。）
- https://www.sqlite.org/wal.html 原文：*"**All processes using a database must be on the same host computer; WAL does not work over a network filesystem.** This is because WAL requires all processes to share a small amount of memory and processes on separate host machines obviously cannot share memory with each other."*；*"since there is only one WAL file, **there can only be one writer at a time**"*；另有长事务读者阻塞 checkpoint、exclusive locking 模式下其他查询直接 `SQLITE_BUSY`、上次连接崩溃后首个连接持排它锁做 recovery 期间第三方查询也拿 `SQLITE_BUSY`。

**启示**：SQLite 能做「同机多进程互斥」，且 WAL 让读写并发，但**写者仍严格串行**——这对任务板其实够用（租约获取是短事务）。真正的红线是**跨主机**：只要 agent 可能跑在不同机器/容器挂网络卷上，SQLite 从「串行但正确」直接掉到「可能静默损坏」。这与 Beads「embedded=单写者文件锁 / server=多写者」的分野完全一致，两条独立一手源互相印证。**设计判据由此明确**：先钉死「所有 writer 是否同机」——同机 → SQLite/文件锁 + WAL 足够，durable 副本导出到 git 供审计；跨机 → 必须有服务端做原子 CAS，git 只能是只读镜像。

## 综合结论（对我们的设计）

1. **反中央 LLM 调度器的证据是充分且一手的**：Anthropic 官方把 orchestrator-workers 限定在「子任务不可预知」、把 coding 与强依赖任务排除；MAST 量化出占比最高的三类失败（步骤重复、推理-行动不一致、不知终止条件，合计 ~41%）正是确定性机制的靶心；CrewAI/AutoGen 的 issue 给出 LLM 选人失败的可复现形态。
2. **但要小心边界**：Cognition 反的是隐式决策冲突，不是并行。去掉中央 LLM 不自动解决「两个 agent 对同一接口做出不兼容假设」——依赖图必须能表达**接口契约**，否则 Flappy Bird 问题会在我们这里以「两个 ready 任务改同一文件」的形式重现。
3. **durable state 的取舍已被 Beads 用真金白银试过**：文件 in git ↔ 多写者并发是硬取舍，租约的互斥语义**不是 CRDT 能表达的**。推荐形态是分层——事件流/审计追加进 git（保住 PR 可见性与原子提交），租约与状态机迁移走单写者原子后端（同机 SQLite 文件锁，跨机则服务），并明确写进设计文档「所有 writer 同机」这条前提，因为它一旦被打破（网络卷 / 跨容器），SQLite 的失败模式是**静默损坏**而非报错。
4. **未核实**：git-bug 是否有官方声明的 notification/watch 缺失（README 与 design 文档未见明确表述）；MAST 三大类的类别级汇总百分比论文中未以单一数字给出（上文为各失败模式逐项占比）；Beads 从 SQLite+JSONL 迁往 Dolt 的官方 rationale 文档只见结果陈述（dolt.md「Why Dolt?」），未找到一手的「为什么放弃 JSONL」决策记录，issue #158 与 #2489 是用户侧证据。