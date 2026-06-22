# PACEflow

> **PACEflow 是一套 Claude Code hook，强制 AI 编码按「先规划、获批，再写代码、验证、收尾」的顺序走——靠在工具调用层拦截，而不是靠提示词提醒。**

## 核心理念

### 它不做什么

- 不会让 AI 更聪明，它不改模型能力。
- 不抓 bug、不管代码质量。代码好坏取决于 AI 能力和你的测试、review，流程管不了。
- 不替你写 spec、不替你做设计，它不产出任何内容。
- 不判断你「验证得对不对、审计得够不够」，它只确认这些步骤发生过、留了记录，内容对错交给人。
- 不防 AI 或你刻意绕过。你随时能关掉它；它防的是无意的跳步和遗忘，不是蓄意作弊。

### 它做什么

AI 写代码时的典型问题不在质量，在过程：一上来就动手、中途迷失方向、改完不验证就收工。CLAUDE.md 里写「请先规划」AI 可以无视（自然语言指令常被忽略，遵守率不稳定）。PACEflow 把这些约束放进 hook，确定性执行：

- 没有获批的活跃变更（CHG），写代码的工具调用会被拒绝。
- 没验证就想结束会话，会被 Stop hook 拦下。
- 跳过顺序（没批准就验证、没验证就审计），会被拒绝。

它只保证一件事：该走的步骤走到了、顺序对、留下了记录。

### 它和 TDD / SDD / OpenSpec / Spec Kit 不是竞品

它们决定写什么——什么测试、什么 spec、什么设计；PACEflow 只保证这些被执行。两者在不同的层：

| 层 | 工具 | 负责 |
|----|------|------|
| 内容 | TDD / SDD / OpenSpec / Spec Kit | 写什么测试、spec、设计 |
| 执行 | **PACEflow** | 确保它们真的被做（hook 拦截） |

OpenSpec、Spec Kit 也有「spec → plan → tasks」的流程，但它们靠约定推动；PACEflow 靠 hook 兜底。它们告诉你做什么，PACEflow 保证你做了。两者一起用（用 `pace-bridge` 把外部 plan 接进 CHG），不必二选一。

### 它适合谁

价值取决于项目。长期、较大、多人、生产或高风险的项目，过程失控代价高，PACEflow 回报明显；一次性原型、抛弃脚本、随手试验，它只是负担——别用，或只开最轻的档。

### PACE 六阶段

| 阶段 | 含义 | Hook 保障 |
|------|------|-----------|
| **P**lan | 规划任务 | PreToolUse deny 未规划的代码修改 |
| **A**rtifact | 派 agent 创建/更新索引与 `changes/` 详情 | 模板自动注入 + 格式守门 |
| **C**heck | 用户审批 | PreToolUse 检查详情文件 `<!-- APPROVED -->` |
| **E**xecute | 执行 | PostToolUse 归档提醒 |
| **V**erify | 验证 | Stop 完成度检查 + `verified-date` / `<!-- VERIFIED -->` |
| **R**eview | 审计 | 收口前对本 CHG diff 做对抗审计并记录；Stop 检查 + `reviewed-date` / `<!-- REVIEWED -->` |

### CHG 是最小变更单元

CHG/HOTFIX 不是大计划容器，而是连续执行、可验证、可关闭的最小变更单元。大计划应拆成多个可以独立完成和验证的 CHG，例如数据结构/迁移、后端接口、前端调用、文档/配置分别记录。

每个 CHG 内可以有多个 `T-NNN`，但这些任务应服务于同一个闭环，并默认在一次执行流中完成。连续执行时不需要为每个中间任务都派 `update-status`；验证通过后优先用 `close-chg complete-open-tasks:true` 一次收口、写 VERIFIED、归档并写 walkthrough。

### 4 个索引文件 + spec.md + changes/详情 = 项目记忆

| 文件 | 用途 |
|------|------|
| `spec.md` | 项目元数据、技术栈 |
| `task.md` | CHG/HOTFIX 唯一索引 |
| `findings.md` | finding 摘要索引 |
| `corrections.md` | correction 摘要索引 |
| `walkthrough.md` | 工作总结索引 |
| `changes/` | CHG/HOTFIX/finding/correction 详情文件 |

索引文件使用 `<!-- ARCHIVE -->` 分隔：活跃区保持精简，归档区保留历史。详情文件由 `artifact-writer` agent 统一维护。

---

## v6 相比 v5 改进了什么

v6 是 breaking change，不继续兼容 v5 的活跃运行格式。已有 v5 内容应迁移或保留在 `<!-- ARCHIVE -->` 下方作为历史，不再参与新的 P-A-C-E-V-R 流程。

| 维度 | v5 | v6 |
|------|----|----|
| Artifact 写入 | 主 session 直接编辑 `task.md` / `implementation_plan.md` / `findings.md` 等主文件 | `artifact-writer` agent 统一创建、更新、验证、归档 artifact；主 session 只负责业务判断和代码实现 |
| 文件结构 | CHG、任务详情、finding/correction 详情大量内嵌在主文件活跃区 | 主文件只保留轻量 wikilink 索引；完整详情写入 `changes/**` |
| 状态权威 | 主文件 checkbox 与正文段落混合承载状态 | `changes/<id>.md` frontmatter 是权威；索引 checkbox 只做展示和快速检查 |
| 审批/验证 | C/V 标记容易被主 session 手写或写错位置 | `APPROVED` / `VERIFIED` / `verified-date` 只能由 `artifact-writer` 写入，hook 会拦截主 session 直写 |
| 上下文成本 | SessionStart 注入较多历史内容，compact 后恢复依赖主文件长文本 | 只注入活跃索引和活跃 CHG 摘要，compact 后由 SessionStart 重新注入当前状态 |
| 多项目/Obsidian | vault 路由和 worktree 共用 artifact 的边界较弱 | 首次启用可选择 Obsidian vault 或本地项目目录；worktree 自动归一到宿主项目 artifact |
| Claude 任务列表 | 主要按顶层 `task.md` checkbox 判断 | 不作为 PACE hook 约束对象；主模型可自行使用任务面板，PACE 权威仍是 `changes/<id>.md ## 任务清单` |
| 失败恢复 | 工具失败后主要依赖模型自觉重试 | PostToolUseFailure 明确提醒失败不能视为完成，SubagentStop 观察 artifact-writer 报告协议 |

核心收益是把“结构正确性”从提示词建议下沉到 hook 和 agent contract：hook 只做机械兜底，不判断业务内容真伪；内容质量仍由主 session、subagent 和用户确认共同负责。

### v6 用户升级到 v7

v7 改变了 artifact 数据布局（task.md 单索引、frontmatter 9 key 封闭合同、implementation_plan.md 退役为 tombstone），升级分**插件升级**与**数据迁移**两步，顺序不能反：

```text
1. 升级插件到 7.x（marketplace update / 重装）
2. 关闭或 reload 全部 session——包括其他 worktree、后台 session，一个都不能漏
3. 开新 session，确认 SessionStart 注入的 helper 路径含 /7.x.x/（说明新 hook 已生效）
4. 预览迁移：node "${CLAUDE_PLUGIN_ROOT}/migrate/migrate-v7.js" --cwd <项目目录> --dry-run
5. 阅读 dry-run 报告确认后，去掉 --dry-run 真正执行（执行前自动备份到
   <项目>/.pace/backups/v7-migration/<时间戳>/，验收失败自动还原）
```

> `${CLAUDE_PLUGIN_ROOT}` 是 Claude Code 注入 hook 的插件根路径，在普通终端里未定义。手动运行上面（以及下文）的命令前，先在终端解析它：
> ```bash
> export CLAUDE_PLUGIN_ROOT="$(ls -d ~/.claude/plugins/cache/paceaitian-paceflow/paceflow/*/ | sort -V | tail -n1)"
> ```

> [!WARNING]
> **为什么必须先升级、reload 所有 session，再迁移数据**：兼容性是不对称的——新 hook 对未迁移的旧数据只做软提示、不拦截；但**旧 hook（6.x）对已迁移的 v7 数据会拒绝一切项目文件写入并阻断会话结束**（实测）。只要还有任何一个 session 在跑旧 hook，先迁数据就会把它「锁死」。同理，迁移完成后**不要降级回 6.x**——那等于主动制造同一种锁死。

**万一已经被锁死（旧 hook + 已迁移数据）怎么办**：

1. 首选：关闭该 session 重开（或 reload 插件），新 hook 生效后锁死即消失；
2. 暂时无法 reload 时：`node "${CLAUDE_PLUGIN_ROOT}/migrate/migrate-v7.js" --cwd <项目> --restore <备份目录>` 把数据还原回迁移前，等全部 session 升级后再迁；
3. **不要照旧 hook 拒绝信息里的指引去「修复索引」**——那会把索引行写回已退役的 implementation_plan.md，等于撤销迁移。

migrate-v7 的其他能力：`--dry-run` 预览（不写盘）、`--restore <备份目录>` 整体还原、迁移产物 100% 通过 schema 验收否则自动回滚。

### v5 用户

PACEflow 不再提供 v5 自动迁移。检测到 v5 时代布局（artifact 根目录有 `task.md` 活跃详情但没有 `changes/`）时只会提示一句：新变更直接按当前合同写入（task.md 仅追加索引行，详情在 `changes/<id>.md`，首个 create-chg 会建出 `changes/`），v5 存量内容保持原样；如需保留历史，可手动归档到 `<!-- ARCHIVE -->` 下方。

---

## 安装

当前版本的 hook 注册使用 Claude Code `2.1.139` 新增的 `hooks[].args` exec form。请使用 Claude Code `2.1.139` 或更高版本；`2.1.138` 及更早版本不支持该字段，可能只执行 `command: "node"` 而不传脚本路径，导致 hook 没有实际运行。

```bash
# 在 Claude Code 中执行（2 条命令）
/plugin marketplace add paceaitian/paceflow
/plugin install paceflow@paceaitian-paceflow
```

安装后 9 类 hook 事件、配套 helper 脚本、4 个用户 skill、5 个用户命令和 `artifact-writer` agent 自动注册，零配置。重启 Claude Code 生效。

> **可选**：设置环境变量 `PACE_VAULT_PATH` 指向你的 Obsidian Vault。新项目首次写代码或派 `artifact-writer` 时，PACEflow 会要求主 session 询问 artifact 存放在 `$PACE_VAULT_PATH/projects/<项目名>/` 还是本地项目目录，并把选择持久化到 Project Root 的 `.pace/artifact-root`；`local` 表示 Project Root 本地目录，不是当前子目录，也不是 `.pace/`。已有 `changes/` 的项目沿用现有位置。真实 Git worktree 和 `.claude/worktrees/<name>` 会自动归一到宿主项目名；也可用 `PACE_PROJECT_NAME` 显式指定项目名。自动化/headless 环境可设置 `PACE_ARTIFACT_ROOT=local|vault|/abs/path` 跳过询问。

### Project Root 与子目录继承

PACEflow 区分三个路径：

- **Current CWD**：Claude Code 当前打开的目录。
- **Project Root**：PACEflow 管理的项目边界，`.pace` 运行态、CHG owner、Stop 检查和 `local` artifact root 都以它为准。
- **Artifact Root**：`spec.md / task.md / walkthrough.md / findings.md / corrections.md / changes/**` 的存放目录，可等于 Project Root，也可位于 Obsidian vault。

在被 PACEflow 管理的父项目子目录中启动 Claude Code 时，子目录默认继承最近的父级 Project Root。这样在 `packages/api`、`plugin/`、嵌套 git repo 等目录里工作时，仍能看到同一个父项目的 active CHG、owner 和 Stop 状态。

如果当前子目录是一个真正独立的新项目，先运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/set-project-root.js" --mode independent
```

再运行 `set-artifact-root.js --choice local|vault` 选择它自己的 artifact root。不要手写子目录 `.pace/project-root` 或 `.pace/artifact-root`。

---

## 快速开始

前提：插件已安装（见上方「安装」），并在项目运行过 `/paceflow:enable`。

### 一次改动

以「加一个小功能」为例：

1. 让 Claude 写代码。没有活跃且已获批的 CHG 时，写代码的工具调用被 deny。
2. Claude 创建 CHG（标题 + 任务清单）。
3. 你批准（一句「开始」）。批准前详情无 `APPROVED`，写代码持续被 deny；`APPROVED` 只能由你触发写入，AI 不能自批。
4. 批准后写代码放行。

前四步是一次改动的最短闭环。

### 收尾时发生什么

5. 验证：Claude 运行验证并记录；未验证时 Stop 阻止结束会话。
6. 审计：收尾前对本次改动做一次 review 并记录。
7. 收尾：`close` 补全任务状态、写验证/审计标记、归档、追加一条工作记录。

命令：`/paceflow:status` 状态 · `/paceflow:pause` 本会话暂停 · `/paceflow:disable` 停用（不删 artifact）。

---

## 特色功能

### Superpowers 全流程集成

无缝对接 [Superpowers](https://github.com/andyjakubowski/superpowers)，从需求探索到代码交付的全链路自动化：

```
brainstorming（需求探索 + 方案设计）
  → writing-plans（生成实施计划）
      → pace-bridge（派 artifact writer 创建 CHG）
      → auto-APPROVED（设计阶段已参与决策，跳过重复审批）
        → 选择执行策略（串行 / 并行 agent / TDD）
```

用户只需参与设计决策，后续 `changes/<id>.md`、任务编号、变更 ID 和索引全部由 agent 自动生成。不使用 Superpowers 时回退 PACE 原生规划。

### Claude Code `/plan` 桥接

原生支持 Claude Code 的 `/plan` 模式——计划文件自动检测，pace-bridge skill 一键转换为 PACE CHG（`changes/<id>.md` + `task.md` 单索引）。Compact 后计划丢失？自动恢复提醒。

### 智能上下文管理

索引文件活跃内容和活跃 CHG 摘要每次会话自动注入，按相关性智能截断：

- 已完成的变更/调研/工作记录自动省略
- walkthrough 只保留最近记录，findings 只注入未解决项
- **显著降低 token 消耗**，大幅减少 Compact 频率

### Obsidian 知识中枢

设置 `PACE_VAULT_PATH` 后解锁跨项目知识管理：

- 首次启用可选择将 Artifact 存储到 `projects/<项目名>/` 或本地项目目录，选择写入 `.pace/artifact-root`
- Git worktree 自动沿用宿主项目的 artifact 目录，避免临时 worktree 分叉出独立记录
- `artifact-writer` 派遣前可用 `hooks/reserve-artifact-id.js` 预留 CHG/HOTFIX/CORRECTION 编号；pace-bridge 收尾可用 `hooks/sync-plan.js` 标记 plan 已同步；真实写入时按详情文件或索引资源短暂加锁，多 worktree 只在共享索引写入窗口串行
- 想看 SessionStart 实际注入给模型什么（新 session / compact 后均可），运行 `hooks/print-session-context.js`（加 `--compact` 看 compact 后注入）；它设 `PACE_PRINT_ONLY` 只读预览、不重置 Stop 计数器也不写 `.pace`
- `knowledge/` + `thoughts/` 沉淀可复用经验
- 会话启动自动注入关联笔记摘要
- 兼容 Obsidian Tasks / Dataview 跨项目查询

### Agent Teams 兼容性

Teammate 身份自动检测（`CLAUDE_CODE_TEAM_NAME` 环境变量）。定位 **teammate = 纯执行者**：主 session 负责任务编排与更新，teammate 不参与任务管理（artifact 状态需单一权威源）。流程引导类 deny（artifact-root 选择、迁移、桥接——需主 session 与用户交互）对 teammate 降级为提示避免死锁；批准/完整性/runtime-control 类 deny（C/E 阶段门、无活跃 CHG、索引完整性、marker 伪造、删锁、直接写 artifact）对 teammate **仍硬阻断**。详见 REFERENCE「PreToolUse 拒绝档位与 teammate 降级」。

---

## 核心功能模块

### Project Root 与 Artifact Root

PACEflow 明确区分当前打开目录、项目管理边界和 artifact 存放位置。普通子目录默认继承最近的父级 Project Root，因此在 `packages/api`、`plugin/` 或嵌套 git repo 中启动 Claude Code 时，仍能沿用父项目的 `.pace` 运行态、CHG owner、Stop 检查和 artifact root。真正独立的新子项目先用 `set-project-root.js --mode independent` 断开继承，再选择自己的 artifact root。

`local` artifact root 表示 Project Root 本地目录，不是当前子目录，也不是 `.pace/`。`vault` artifact root 表示 `$PACE_VAULT_PATH/projects/<项目名>/`；项目名可用 `PACE_PROJECT_NAME` 覆盖。

### Worktree 路由与 Owner

Git worktree 和 `.claude/worktrees/*` 自动归一到宿主 Project Root，避免临时分支目录分裂出独立 `task.md` 或 `changes/**`。普通代码文件仍写当前 worktree；只有 PACEflow artifacts 和 `.pace` 运行态走共享 Project Root。

每个活跃 CHG 都有 `.pace/change-owners/<id>.json` owner 记录，包含 session、agent、cwd、worktree、branch 和 heartbeat。SessionStart 会折叠其他 worktree/session 的 fresh owner CHG，Stop 不因外部 owner 的正常进度阻断当前 session；结构损坏、索引不一致、详情缺失仍是全局问题，会继续阻断。相同 worktree/branch 新开 session 可接续当前 CHG，跨 checkout 接手 stale owner 必须带用户明确接手证据。

### Artifact 并发控制

CHG/HOTFIX/CORRECTION 编号由 `reserve-artifact-id.js` 原子预留；真实 artifact 写入按资源短暂加锁。详情文件、根索引和编号计数器分别使用 `.pace/locks/artifacts/`、`.pace/sequences/`、`.pace/reservations/` 保护，允许多 worktree 并行写代码，但共享索引写入窗口会串行。

Bash、PowerShell、Monitor、Write/Edit/MultiEdit 都不能手写或破坏 `.pace` 控制面文件，例如 lock、sequence、reservation、index transaction。锁冲突时提示等待或重试，不要求模型删除锁。

### CHG 生命周期与 Deferred

`changes/<id>.md` 是 CHG 状态权威；索引 checkbox 只做展示和快速检查。`[ ] planned` 是 backlog；`[ ] + APPROVED` 是 ready/deferred，允许 Stop 但执行前仍必须 start；`[/] in-progress` 是当前执行；`[!]` 是 blocked/deferred，表示暂停或外部阻塞；`[x] completed` 仍需 verify/close；`archived` 才是完整闭环。

Stop hook 对当前 session 的 running、completed 未验证、verified 但未审计、reviewed 后未归档和结构不一致问题统一 block（exit 2）；这些完成度检查共用 `stop-block-count` 计数器、连阻 3 次后降级放行不死锁，其中 verified 但未审计要求先跑 R 审计；对 ready/deferred/blocked CHG 使用可见提醒允许结束。Claude Code v2.1.145+ 在 Stop 输入提供 `background_tasks` 时，PACEflow 会把“running CHG 仍有未完成 T-NNN，但后台 Workflow/subagent/team/shell 任务仍在运行”的场景视为主 session 暂停等待后台结果，放行 Stop 并显示可见提醒；结构损坏、未验证、待归档仍照常阻断。`update-status` 只用于暂停、阻塞、跳过、跨 session 可见性或长任务状态维护；连续完成的 CHG 优先用 `close-chg complete-open-tasks:true` 一次收口。

### Artifact 写保护与 Agent Contract

主 session 不直接编辑 `task.md`、`walkthrough.md`、`findings.md`、`corrections.md` 或 `changes/**`，这些由 `paceflow:artifact-writer` 统一维护。主 session 也不能手写 `<!-- APPROVED -->`、`<!-- VERIFIED -->` 或 `verified-date`；C/V 标记必须由 artifact-writer 按 contract 写入。`spec.md` 是项目规格文件，不归 artifact-writer 管理，仍允许主 session 按项目需要编辑。

Agent 派遣前会校验必填字段：`create-chg` 需要预留编号、标题和任务；`approve-and-start` 需要批准来源、证据和 `task-id`；`close-chg` 需要主 session 已运行并读取验证结果，且提供 `verify-summary` 与 `walkthrough-summary`。更新、验证、归档已有 CHG 必须显式写 `target: CHG-...`，不能只在正文中提到 ID。

### 任务面板边界

Claude 任务面板只是主模型的工作记忆，不是 PACEflow artifact 权威。PACEflow 不注册 `TodoWrite`、`TaskCreate`、`TaskUpdate` hook，也不要求主模型把面板步骤同步成 T-NNN。继续、恢复或收口已有 CHG 前，模型应读取 `changes/<id>.md` 的任务清单、实施详情和工作记录；最终判断以 CHG 详情文件为准。

### 终态修复与工具失败恢复

PostToolUse 默认只做 schema、wikilink、归档和 correction 提醒。少数机械终态问题使用 `decision:"block" + continue:true` one-shot 修复，目前只用于 artifact-writer 写 `walkthrough.md` 后缺正确 wikilink 或 `[worktree:: ...] [branch:: ...]` 上下文的场景。

PostToolUseFailure 会在写入或验证工具失败后提醒模型不要把失败调用视为完成。SubagentStop 观察 artifact-writer 报告标题和状态，并在 close/archive 已离开活跃索引后兜底关闭 owner。

---

## 工作原理

### 9 类 Hook 事件覆盖完整生命周期

| Hook | 触发时机 | 做什么 |
|------|----------|--------|
| **SessionStart** | 会话开始 / Compact 后 | 注入索引活跃区 + 活跃 CHG 摘要 |
| **PreToolUse:Write/Edit/MultiEdit/Bash/PowerShell/Monitor/Agent** | AI 写代码、运行命令或派 artifact-writer 前 | 无活跃 CHG / 无审批 / 状态不一致 / 直接写 artifact 或 `.pace` 控制面 → deny |
| **PostToolUse** | AI 写代码后 | schema/wikilink/归档/correction 提醒 |
| **PostToolUseFailure** | 写入/验证工具失败后 | 提醒不要把失败工具调用视为完成 |
| **SubagentStop** | `artifact-writer` 结束后 | 观察报告标题/状态并记录 transcript |
| **Stop** | AI 想结束会话 | 未完成 / 未验证 / 未审计 / 未归档 → exit 2 阻止退出（共用计数器连阻 3 次降级、不死锁）；已验证未审计要求先跑 R 审计 |
| **PreCompact** | Compact 前 | native plan 兜底检测（快照机制已退役）|
| **StopFailure** | API 错误中断 | 记录异常中断事件 |
| **SessionEnd** | 会话正常结束 | 本 session 的 CHG owner 降级 detached（其他 session 可接手）+ 清除 session 级 pause 标志 |

### 多信号激活

PACEflow 分两层检测项目是否需要 PACE 流程。**强信号自动激活并启用流程门；软信号只提醒 AI 询问用户，不自动激活、不 deny。**

**强信号 → 自动激活**（直接进入写码门 / Stop 门）：

| 信号 | 条件 | 说明 |
|------|------|------|
| 已有 artifact | 项目中存在 `changes/` | 最强信号 |
| artifact-root 配置 | Project Root runtime 中存在 `.pace/artifact-root` | 手动选择 local/vault/自定义路径后启用 |
| 手动标记 | `.pace-enabled` 文件存在 | 显式启用（由 `/paceflow:enable` 写入）|
| 独立子项目标记 | `.pace/project-root` 由 helper 写入 | 子目录作为独立 Project Root |
| legacy v5 | 检测到旧 `task.md` / `implementation_plan.md` 活跃内容 | 一句布局提示；新变更按当前合同写入，存量不迁移 |

**软信号 → 仅提醒，不自动激活、不 deny**（提示 AI 询问用户是否运行 `/paceflow:enable`，优先级 code-count > 清单 > 计划）：

| 信号 | 条件 |
|------|------|
| 代码文件数 | 项目根目录 3+ 代码文件 |
| 项目清单文件 | `package.json` / `tsconfig.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `pom.xml` / `build.gradle` 之一存在 |
| 计划文件 | `docs/plans/` 下有日期计划文件（mtime 新鲜或当前 native plan）|

**豁免**：`.pace/disabled` 存在 → 最高优先级跳过（由 `/paceflow:disable` 写入）。

### 用户命令

5 个 slash 命令手动控制激活状态，均经 `hooks/set-activation.js`（唯一写入路径，不要手写 `.pace-enabled` / `.pace/disabled`）：

| 命令 | 作用 |
|------|------|
| `/paceflow:enable` | 在当前项目启用 PACEflow；首次启用引导选择 artifact 存放位置（Obsidian vault / 本地目录）|
| `/paceflow:disable` | 停用整个项目的 PACEflow（写 `.pace/disabled`）；仅用户明确不想用 PACE 管理本项目时运行 |
| `/paceflow:pause` | 仅本 session 暂停流程门（写码门 / Stop 门）；artifact 完整性门保留，session 结束自动失效 |
| `/paceflow:resume` | 恢复本 session 被 `pause` 暂停的流程门 |
| `/paceflow:status` | 显示当前项目 / session 的 PACEflow 激活与暂停状态 |

> `disable` / `pause` 是用户的退出权，不是 AI 绕过门控的手段：被 PACE deny 拦住时正确做法是走流程（建 CHG / approve-and-start），而非自行 disable/pause。

### 防无限循环

Stop hook 连续阻止 3 次后自动降级为放行，防止 AI 陷入死循环。SessionStart 重置计数器。

---

## 项目结构

```
paceflow/
├── .claude-plugin/marketplace.json   # Marketplace 入口；source 指向 ./plugin
├── plugin/                           # 发布运行时根目录
│   ├── .claude-plugin/plugin.json    #   Plugin 元数据
│   ├── agents/                       #   Artifact writer agent
│   │   └── artifact-writer.md
│   ├── agent-references/             #   Agent 运行规范与 instruction contracts
│   │   ├── artifact-writer-spec.md
│   │   └── instructions/
│   ├── hooks/                        #   Hook 注册脚本 + helper + 公共工具
│   │   ├── hooks.json                #     自动注册配置
│   │   ├── pace-utils.js             #     公共工具库
│   │   ├── pace-utils/               #     公共工具子模块
│   │   ├── pre-tool-use.js           #     写代码前：任务检查 + 审批检查
│   │   ├── pre-tool-use/             #     PreToolUse guard helper modules
│   │   │   ├── agent-lifecycle-guard.js
│   │   │   ├── bash-guard.js
│   │   │   ├── command-recognition.js
│   │   │   ├── marker-guard.js
│   │   │   └── powershell-guard.js
│   │   ├── post-tool-use.js          #     写代码后：归档提醒 + 格式检查
│   │   ├── post-tool-use-failure.js  #     工具失败后：恢复提示
│   │   ├── session-start.js          #     会话启动：上下文注入
│   │   ├── session-start/            #     SessionStart 注入层子模块
│   │   │   ├── budget.js
│   │   │   ├── collect-state.js
│   │   │   ├── layers.js
│   │   │   └── runtime-effects.js
│   │   ├── subagent-stop.js          #     artifact-writer 报告观察
│   │   ├── stop.js                   #     会话结束：完成度检查
│   │   ├── stop-failure.js           #     API 错误中断：事件日志
│   │   ├── session-end.js            #     会话结束：CHG owner 降级 detached + 清 session pause
│   │   ├── task-list-sync.js         #     任务列表：legacy observer（当前不注册）
│   │   ├── pre-compact.js            #     Compact 前 native plan 兜底检测
│   │   ├── reserve-artifact-id.js    #     ID 预留 helper
│   │   ├── set-artifact-root.js      #     artifact root 选择 helper
│   │   ├── set-project-root.js       #     独立 Project Root 声明 helper
│   │   ├── set-activation.js         #     enable/disable/pause/resume/status 状态 helper
│   │   ├── print-session-context.js  #     SessionStart 注入预览 helper（只读）
│   │   ├── sync-plan.js              #     plan bridge 同步 helper
│   │   └── templates/                #     5 个 artifact 模板 + 1 个 knowledge 参考模板
│   ├── skills/                       #   4 个用户 Skill
│   │   ├── pace-workflow/            #     PACE 核心流程
│   │   ├── pace-bridge/              #     Superpowers 桥接
│   │   ├── artifact-management/      #     Artifact + 变更管理规则
│   │   └── pace-knowledge/           #     Obsidian 知识库管理
│   ├── commands/                     #   5 个用户命令
│   │   ├── enable.md                 #     /paceflow:enable
│   │   ├── disable.md                #     /paceflow:disable
│   │   ├── pause.md                  #     /paceflow:pause
│   │   ├── resume.md                 #     /paceflow:resume
│   │   └── status.md                 #     /paceflow:status
│   └── migrate/                      #   v6 → v7 数据迁移脚本（migrate-v7.js）
├── internal/                          # 内部开发资料，不随 marketplace 发布
│   └── skills/audit/                 #   PaceFlow 自身审计流程
└── tests/                            # Hook + agent contract 测试
```

---

<details>
<summary><strong>技术细节（Hook I/O 协议、状态文件、兼容性）</strong></summary>

## Hook I/O 协议

| Hook | 输入 | 成功输出 | 阻止方式 |
|------|------|----------|----------|
| SessionStart | stdin JSON（eventType）| stdout 纯文本 | N/A |
| PreToolUse | stdin JSON（tool_name, tool_input）| stdout JSON（additionalContext / permissionDecision）| `permissionDecision: "deny"` |
| PostToolUse | stdin JSON（tool_name, tool_input）| stdout JSON（additionalContext；少量终态修复可 `decision:"block" + continue:true`）| 默认不阻止；walkthrough 终态修复 one-shot continue block |
| Stop | stdin JSON（stop_hook_active）| stderr + exit 2 | `exit 2` |
| PreCompact | stdin JSON | 无 stdout（native plan 兜底检测，不写快照）| N/A |
| PostToolUseFailure | stdin JSON | stdout JSON（additionalContext）| N/A |
| SubagentStop | stdin JSON | stdout JSON（additionalContext）| N/A |
| StopFailure | stdin JSON | 无 stdout | 记录日志 |
| SessionEnd | stdin JSON（sessionId）| 无 stdout | N/A |

**关键规则**：
- `exit 0 + stderr` = 完全忽略（AI 看不到）
- `exit 0 + JSON stdout additionalContext` = AI 能看到
- `exit 2 + stderr` = 阻止操作 + stderr 反馈给 AI

## 运行时状态文件（`.pace/`）

| 文件 | 用途 |
|------|------|
| `stop-block-count` | Stop 连续阻止计数（≥3 降级）|
| `degraded` | 降级标记 |
| `task-list-used` | legacy 任务面板 observer 标志；当前插件不注册任务面板 hook |
| `artifact-root` | artifact 存放位置选择：`local` / `vault` / 绝对路径 / 相对路径 |
| `project-root` | 独立子项目标记；只允许 helper 写入 `independent`，不要手写 |
| `change-owners/*.json` | 活跃 CHG 的 session / worktree / branch owner 与 heartbeat |
| `locks/artifacts/*.lock` | artifact resource lock；按详情文件或索引资源保护真实写入窗口 |
| `sequences/*.counter` | CHG/HOTFIX/CORRECTION 编号计数器，由 hook 原子分配 |
| `reservations/*.json` | 当前 session/agent 的预留编号 |
| `disabled` | 豁免标记（由 `/paceflow:disable` 写入，不要手写；不是 `project-root=disabled`）|
| `synced-plans` | 已桥接的 plan 文件列表 |

## PreToolUse 触发档位

| 级别 | 条件 | 动作 |
|------|------|------|
| Deny | 强信号已激活 + 无活跃 CHG / 未批准 / 状态不一致 | deny + 懒创建模板 |
| Soft Warn | 软信号（3+ 代码文件 / 清单文件 / 计划文件）未激活 | additionalContext 提示运行 `/paceflow:enable` |

## C/V/R 阶段检查

- **C 阶段**：详情文件有 `<!-- APPROVED -->` 且状态可执行 → 放行。无批准 → deny，并提示用户批准后用 `approve-and-start approval-confirmed:true approval-source approval-evidence task-id`
- **V 阶段**：验证结果必须由主 session 先运行并读取；通过后优先 `close-chg complete-open-tasks:true`，一次完成最后任务收口、VERIFIED、归档和 walkthrough。`update-chg action=verify` 只用于暂不归档
- **R 阶段**：CHG 收口前主 session 对本 CHG diff 做对抗审计，findings 按 severity 路由（P0/P1 起 HOTFIX 或标记 won't-fix，P2/P3 派 `record-finding` 进 backlog），不阻断 close。审计跑过后由 `close-chg` 写 `<!-- REVIEWED -->` + `reviewed-date` + `## 审查记录`；暂不归档时才派 `update-chg action=review`（需 `review-confirmed/source/findings`）。R 只记录「审计这步发生过」，不裁决质量好坏

## Subagent / Agent Teams 兼容性

**Subagent**（Task 工具）：在主进程内执行，共享 hooks，所有 hook 均生效。

**Agent Teams**：独立平级进程（≠ subagent 的主进程内子调用），各自加载 hooks。定位 **teammate = 纯执行者**，任务管理（批准 / 建 CHG / 改状态 / 归档）归主 session 单一权威源。`isTeammate()` 自动检测后：
- **流程引导类** deny（artifact-root 选择、native plan 桥接——需主 session 交互完成）→ 降级为 HINT（避免死锁 teammate）
- **批准 / 完整性 / runtime-control 类** deny（C/E 阶段门、无活跃 CHG、索引完整性两门、marker 伪造、删锁、直接写 artifact）→ **不降级，teammate 也硬阻断**
- 信息性 hook → 保持生效

调研 fan-out 这类「给结果就好、回流主 session」的场景应用 **subagent**（Task / Agent 工具），不用 teammate。完整三档 × teammate 降级表见 REFERENCE「PreToolUse 拒绝档位与 teammate 降级」。

**已知限制**：
- Claude 任务面板不作为 PaceFlow artifact 权威；任务面板和 CHG 详情不一致时，以 `changes/<id>.md` 为准。
- 多 teammate 并发修改 `.pace/` 理论竞态风险（未实际触发）
- 多个独立 clone（各自 `.git` + 各自本地 `.pace`）共享同一云同步 vault project 并发开 CHG 时，编号串行化（sequence counter/lock）绑本地 project-runtime、不跨 clone，可能分配重复 CHG/HOTFIX/CORRECTION 编号（LOCKS-001）。`.pace` 含 counter 本地不同步、仅 `changes/` 经云端同步，触发需两端近乎同时 reserve 且云同步状态恰好一致，概率极低。建议单人单活跃 clone，避免多机并发对同一 vault project 开 CHG

## 日志

共享日志写在当前安装的插件 hooks 目录中，例如 `~/.claude/plugins/cache/paceaitian-paceflow/paceflow/<version>/hooks/pace-hooks.log`；本仓库本地测试会写 `plugin/hooks/pace-hooks.log`。

</details>

<details>
<summary><strong>版本历史</strong></summary>

| 版本 | 日期 | 主要变更 |
|------|------|----------|
| v7.2.26 | 2026-06-22 | **CI 首跑即抓到价值——修 pace-utils 21 测试非自洽（依赖 ambient `PACE_VAULT_PATH` 的假绿）**（CHG-20260622-02 T-003 闭环）：v7.2.25 的三平台 CI 首跑**全三平台**（含 ubuntu，与维护者本地同 POSIX 环境）都挂 `run-all 7/8`——失败的不是平台、也不是新增的 /tmp 改动，而是 `pace-utils` 21 个 vault/PACE_PROJECT_NAME/scanRelatedNotes/WIKI 测试。根因：`constants.js:28 VAULT_PATH = process.env.PACE_VAULT_PATH || ''` 在 require 时固化，而 `test-pace-utils.js` require 前从不设 env，于是这些测试**依赖维护者 shell 的 ambient `PACE_VAULT_PATH`**——干净环境（CI 无此变量）下 `VAULT_PATH=''`、`path.join('','projects',name)` 退化为相对路径 `projects/<name>` 致断言崩。本地长期 `8/8` 全靠 shell 变量撑出的**假绿**，CI 第一次在干净环境跑 `run-all` 就抓到了（印证「干净环境与目标平台一样不可本地自证」，扩展 [[cross-platform-fix-needs-target-platform-run]]）。修法：`test-pace-utils.js` 在 require pace-utils **之前**把 `PACE_VAULT_PATH` 固定为进程私有临时 vault 根（`os.tmpdir()/pace-test-vault-root`），让测试自洽（hermetic），副带不再污染真实 Obsidian vault。验证：`env -u PACE_VAULT_PATH node tests/run-all.js` 8/8（pace-utils 302/302，本地精确复现并消除 CI 干净环境失败）；手动 R 复核无 P0-P2。纯测试改动，不动 marketplace runtime。三平台 CI 转绿后 CHG-20260622-02 T-003 闭环。 |
| v7.2.25 | 2026-06-22 | **GitHub Actions 三平台 CI 矩阵 + 修 agent-helpers `/tmp` 硬编码（跨平台工程底座）**（CHG-20260622-02）：承接 codex v7.2.21 方向建议最高优先级之一——机制化解「主 session 只能 POSIX/WSL 跑、无法验 Windows」的结构性盲区（v7.2.22 正因 POSIX 8/8 推断 Windows、实际 7/8 翻车，靠维护者手动实跑兜住，见记忆 cross-platform-fix-needs-target-platform-run）。**T-001（修 /tmp 硬编码）**——抽 `subagent-runner.js` 的 `defaultVaultRoot()=os.tmpdir()/pace-test-vault` + `defaultVaultDir(fixture)` 为临时 vault 路径单一来源并 export，替换原硬编码 `/tmp/test-vault/${fixture}`（Windows 不识别 /tmp、落 C:\tmp 污染跨盘）；落地核实实为 **34 个** YAML case（非草案误写的 4 个）各有一行冗余 `project_path: /tmp/test-vault/<fixture>`（值恒等默认、纯重述 setup.fixture）全删（variables 留 date）；`run-tests.js` 三处默认（cmdVerify/cmdTeardown/cmdVerifyMulti）+ `run-agent-cli-suite.sh`（case_target_dir/--add-dir，去 python3 依赖）全接单源；`fixture-teardown.js` 安全门从 `startsWith('/tmp/')` 改「path.resolve 后严格位于 os.tmpdir() 之下（含 sep 防兄弟前缀）」跨平台判据；`.gitattributes` 补 `*.yaml`/`*.yml eol=lf`（Windows 护城河）。**T-002（CI yml）**——`.github/workflows/ci.yml`：三平台矩阵 ubuntu/macos/windows-latest + fail-fast:false + checkout fetch-depth:0 + node 20 + 装 claude CLI（plugin-validate 纯本地校验无 API key）+ `node tests/run-all.js`；**落地核实修正**：`git rev-parse --show-toplevel` = paceflow 本身（git 根即 paceflow），删掉草案里会致 CI 失败的 `working-directory: paceflow`（无此目录）。**R 对抗审计（opus inline）无 P0/P1**：P2-1 抓到 rename test-vault→pace-test-vault 自引入的 sh harness 分叉（--add-dir 授权错目录致 live harness 在维护者 Linux 全 FAIL）→ 本 CHG 内修；P2-2 doc 过时（README/baseline/smoke）→ 本 CHG 内修 current-impl 部分。`node tests/run-all.js` 8/8（agent-helpers 11/11、helper 代码无 /tmp 字面）。**T-003 三平台真绿待 push 后 GitHub Actions 首跑实测**（头号观察点 windows-latest 的 agent-helpers 退出码），CI 绿后 close-chg。含 `docs/research-2026-06-22-ci-roi-feasibility-and-rollout.md` 调研文档。 |
| v7.2.24 | 2026-06-22 | **accepted-risk 锚定测试——锁定 GS-1~4 + ES-1/ES-2 已知绕过现状（收紧时转 DENY 的回归基线）**（CHG-20260622-01）：v7.2.21 审计 + 补轮发现的已知守卫绕过（GS-1~4 blocklist 枚举 + ES-1/ES-2 embed-scan 静态扫描天花板，均 P3 accepted-risk）此前散在 finding backlog、无锚定测试（正向覆盖缺口）。补一组锚定测试做回归基线：test-hooks-e2e 新增两组 test（53 行）——GS test 移植 `internal/audit/pace-gs-verify.js` 的 20 case（对照组 CTRL rm/while/for/sed/Remove-Item 直接形态断言 true=应拦、证 predicate 判别力 + GS-1 if;then/else;elif、GS-2 eval、GS-3 ed/vi-es/patch、GS-4 iex/Invoke-Expression 当前绕过断言 false），ES test 用 `bashCommandEmbedsArtifactWriteScript` 构造 fixture（CTRL 小文件=true、ES-1 >256KB 跳扫=false、ES-2 require 链不跟随=false，断言值主 session 一手实测）。每条注释标编号 + 守卫位置 + 收紧路径（收敛 anchor/提高 size 上限/跟随 require 图时改 true），顶部钉死「锁定现状非设计期望」+ 关联 finding。与既有 widen-matcher-verify-reverse 反向锁同构（它锁 over-block 误伤，本组锁 under-block 绕过现状）。独立价值：防 anchor 被无意改动而无人知；白名单化重构时是一次性「全转 DENY」回归网。artifact 路径运行时拼接规避 dogfood embed-scan。纯测试新增不动产品。`node tests/run-all.js` 8/8（test-hooks-e2e 474，+2 锚定测试）。 |
| v7.2.23 | 2026-06-21 | **HOTFIX：修 choicePath 显示三处漏正斜杠归一——Windows hooks-e2e 17 GOLDEN 漂移 + 产品输出同行分隔符不一致**（HOTFIX-20260621-01）：v7.2.22 发版后维护者 Windows 本机实跑暴露 run-all 仍 7/8——migrate-v7 已由 TH-1b 修好，但 hooks-e2e 17 个 GOLDEN 仍漂。根因不是测试 harness（**推翻 TH 组「产品代码不受影响」误诊**）：产品 `pace-utils.js` 同文件 L236/237 有正确归一模板，但 `artifactRootConfigError`(L313)/`artifactRootChoiceMessage`(L390)/`artifactDirRuntimeHint`(L405) 三处复制 `getArtifactRootChoicePath` 时漏抄 `.replace` → Windows 上 `配置文件=` 裸插反斜杠、同一行三路径两种分隔符（Artifact 根目录/Project Root 正斜杠、配置文件 反斜杠）。TH-1a 的 goldenNormalize 双形态只归一路径 token 前缀（修好 4 个 GOLDEN），够不到 `<DIR>\.pace\artifact-root` 后缀，修不了这 17 个——它们是产品输出 bug 非测试假设。修法：三处显示边界 `.replace` 正斜杠归一（与同行 stateDir 一致、不动变量本身）；把 `artifactDirRuntimeHint` 格式化抽成纯函数 `formatArtifactDirHint`（导出）便于注入 Windows 反斜杠路径做 POSIX 判别测试（补 TH-1a 缺的产品可测性）；连带修 `test-pace-utils.js:1394`（断言同步归一防 Windows 新红）；加守卫判别测试。完整性扫描确认 choicePath 三处是该类全部、同族路径（projectRoot/markerPath/cwd/artDir）均已归一。**诚实记录**：主 session 此前以 POSIX 8/8 间接推断 Windows、walkthrough 写「修 Windows 6/8」是验证纪律失败，由维护者 Windows 实跑兜住——本次明确不以 POSIX 代替 Windows 端到端。验证：POSIX run-all 8/8（pace-utils 302 含守卫、hooks-e2e 472）+ 判别力 node -e 旁证 + **维护者 Windows 本机实跑确认 17 GOLDEN 修复、run-all 8/8**。 |
| v7.2.22 | 2026-06-21 | **v7.2.21 全量审计 A 组 + TH 组落地（change-set v7221-audit-fix，2 CHG）+ 8 条 finding 归属**：**CHG-20260620-02（A 组，文档与对称性低风险修复）**——CA-1 `constants.js` ARCHIVE_PATTERN 容忍 ARCHIVE 标记行尾随空格、与 `change-analysis.js:457` findActiveIndexBelowArchive 单源对齐（消除「尾随空格→readActive 退回全文→归档区 entry 冒泡回活跃集」缺口）；SA-1 `set-activation.js` parseArgs 裸 positional fail-closed（→ `args.unknown` → `DENY_UNKNOWN_OPTION`），补齐 CHG-20260620-01 漏的第 5 个写 `.pace` 状态 helper 对称；AUD-1 `internal/skills/audit/` SKILL+agent-prompts 共 8 处 v6 基线/口径改 v7（v5 legacy 迁移语义保留）；AC-1/AC-2 `artifact-writer.md` 速查补 `merged-into`/`rejection-reason ≥10 字符`条件字段——guard 派遣骨架按 V7D-2/V7D-4 三向等价锁既有约定**保持不变**（条件-on-可选字段不进最小骨架，update-finding 骨架即先例，强加破锁），文档归速查+权威 spec；PK-1 `pace-knowledge` SessionStart 注入条数订正为按 kind 名额（wiki 3/knowledge 2/thoughts 3，startup 与 compact 统一）对齐 `layers.js:998-1000`。**CHG-20260620-03（TH 组，测试发版门 Windows 可移植 + 审计 harness 入仓）**——TH-1a `test-hooks-e2e.js` goldenNormalize 路径 token 反斜杠+正斜杠双形态归一、TH-1b `test-migrate-v7.js` snapshotAll key `path.sep`→`/` 归一，修维护者 Windows 本机 `node tests/run-all.js` 结构性 6/8（harness 路径分隔符 POSIX-only 假设，产品代码不受影响），POSIX 幂等不回归 + 反斜杠 winDir 判别力单测；一手实证 harness 入 `internal/audit/pace-gs-verify.js` 并 gitignore 备查不进 git。**附 record-finding 8 条进 backlog**：GS-1~4 守卫 blocklist 枚举绕过簇（bash-guard then/eval/ed + powershell iex，一手 harness 20/20 坐实，报告 P1→按门是兜底+blocklist 宿命降 P3）、C 组 PL-3/LK-1/SO-1/LL-1/MV-2/FSW-1（真但触发窄 P3）、ST-1 stop.js 降级锯齿 won't-fix（`stop.js:411` 注释 T-424 证实有意防 MAX_BLOCKS 永久冻结，feature 非 bug）。`node tests/run-all.js` 8/8：test-hooks-e2e 472、test-pace-utils 301、test-session-layers 51、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.21 | 2026-06-20 | **v7.2.18 审计 P3 收尾（2）——4 个 CLI helper parseArgs 多余 positional fail-closed 对称 + record-finding 收口（审计 12 条全归属）**（CHG-20260620-01）：审计 P3-3——reserve-artifact-id / set-project-root / set-artifact-root / sync-plan 的 parseArgs 第一个 positional 落 operation/mode/choice/plan，但第 2+ 多余 positional 无 else 兜底→**静默丢弃**，与 unknown-flag（`args.unknown`→`DENY_UNKNOWN_OPTION`）的 fail-closed 不对称。修：前 3 helper 的 for 循环补 `else { args.unknown.push }`；**sync-plan 原最不对称**（无 `args.unknown` 字段、连未知 flag 都静默吞），补齐字段 + flag 分支 + 多余 positional else + main `DENY_UNKNOWN_OPTION` 出口。`cwd` 永从 `--cwd`/默认取、**无写错目录/数据丢失**（审计已证），fail-closed 利于 fail-fast 排错。TDD 红→绿（9hc-helper-pos1-5 多余 positional/未知 flag → DENY + pos6 单 positional 反向不误伤）；R 审计 systematic 定位**唯一回归** 9hc-helper1a（误传 `--project-dir /tmp/x` 的值 `/tmp/x` 因 reserve 不认 `--project-dir` 成裸 positional、被新 else 一并 fail-closed 报出，DENY 文案变 `--project-dir, /tmp/x, --artifact-root, local`），判为**行为正确变化**（fail-closed 更完整、非 bug），断言放宽为分别校验两误传 flag（非为绿改断言）。同批 record-finding 收口审计余条：**P3-5** 魔法数 `count===34` won't-fix（有意的「误删 case 检测」机制，改动态丢检测意图）、**P3-6** migrate-v7 写盘无回滚 backlog（低可达 + 备份循环先跑完可手动恢复）；至此 v7.2.18 审计 **12 条全部归属**（修 5 CHG / 已登记 2 / record 2 / won't-fix 1，P0-P3 无悬空）。`node tests/run-all.js` 8/8：test-hooks-e2e 470（+9hc-helper-pos1~6）、test-pace-utils 300、test-session-layers 51、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.20 | 2026-06-19 | **v7.2.18 审计 P3 收尾——update-index/update-finding hook 早期字段门 + ts/todayISO 去硬编码时区**（CHG-20260619-07）：承接 v7.2.18 全量审计余下两条 P3。**T-001（P3-4）**——agent-lifecycle-guard `agentLifecyclePromptDenyReason` 补 update-index（target∈{findings.md,corrections.md}，firstToken 容错 + action=reorder）/ update-finding（target 非空）早期字段门 + `promptTemplateForOperation` 增 update-index 模板；补齐与 create-chg/update-chg 等 gated op 对称的「缺字段 hook 早拦」体验（省一次 agent spawn 往返），只读结构化 target/action 非话术，agent 第三层 fail-closed 仍是权威安全网。范围收窄未碰 pre-tool-use.js:594/locks.js（target-required 门本不覆盖这两 op）。**T-002（P3-7）**——path-utils `ts()`/`todayISO()` 去硬编码 `timeZone:'Asia/Shanghai'` 改跟随宿主系统时区 + 同步两处测试耦合（test-hooks-e2e today() / test-pace-utils dateCompact，免非 Shanghai 主机假红）；aging 比较两侧 + CHG-ID date + date 字段均同源 todayISO，去硬编码后仍自洽无 off-by-one，marketplace 非中国用户得本地日历日、宿主即 Asia/Shanghai 时行为不变。TDD 红→绿；opus inline R 审计五棱镜抓出并即修 1 处 over-block（update-index target 漏 firstToken 致尾随说明误 DENY，加 firstToken + 9hc-ui4 回归），P0/P1/P3=0。`node tests/run-all.js` 8/8：test-hooks-e2e 463（+9hc-ui1~ui4/uf1/uf2）、test-pace-utils 300（+T-002 tz）、test-session-layers 51、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.19 | 2026-06-19 | **v7.2.18 全量审计修复——删 2 处话术门 + 修 LOG-ISOLATION dogfood flaky + README 树补漏**（CHG-20260619-03/04/05，change-set v7218-audit-fix）：承接 v7.2.18 全量审计（Opus ultracode 12 维 finder + 主 session 亲核，P0/P1=0）。**CHG-A（话术门）**——agent-lifecycle-guard 删两处散文 blocklist 分支：`promptApproveContainsStartIntent:422`「开始实施/开始执行/...」（扫整段含 approval-evidence 用户原话、approve-only 误伤）+ `promptMentionsVerifyAction:395/396`「执行 verify 操作」（扫 status-reason 猜串联意图，而单次派遣 action 已唯一确定、update-status+verify 串联执行层不可达），保各自结构化分支（420/421 status→in-progress、393/394 action:verify）；对齐 CHG-20260616-04 删 COMPLETION_PHRASES 的「门读结构化字段绝不解析话术」原则。审计原评 P2-1，用户质疑「approve 守卫非自动扫描、误伤需多重条件且仅多一次往返」+ 同构 P3-1 必同级，复核降 P3（记忆 audit-severity-complete-harm-chain：危害链走完别把反模式存在当高危）；删的理由是架构一致性非误伤频率。改门必验反向：9hc1e（approve evidence 含触发词放行）/9hc2d（update-status 散文 verify 放行）over-block 消失 + 9hc1c/9hc2 结构化仍 DENY under-block 守护。**CHG-B（测试 flaky）**——LOG-ISOLATION 等价锁从「源码树 pace-hooks.log mtime/size before/after」（锚定被 dogfood live session hook 并发写的可变资源 → flaky 污染 release gate、训练「重跑即绿」）改按内容正向判定（本测试 proj 标识应进 E2E 不进源码树，无关并发写 proj 不同免疫、漏注入污染仍抓）；node -e 确定性对比验证三点（原误红/新免疫/保检测意图）。**CHG-C（文档）**——README 项目结构树补 `command-recognition.js`（pre-tool-use/ 漏第 5 文件）+ `session-start/` 子目录 4 文件（完全漏列、v7.2.18 layers.js 改动落点）。三 CHG 各 manual/对抗 R 审计 P0-P3=0。`node tests/run-all.js` 8/8：test-hooks-e2e 458（+9hc1e/9hc2d）、test-pace-utils 299、test-session-layers 51、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.18 | 2026-06-19 | **SessionStart 双层场景注入文件归属防呆句**（CHG-20260619-02）：`renderProjectContext`（layers.js）在 inherited/worktree 双层场景（Current CWD ≠ Project Root）注入文件归属原话「主 session 修改普通项目文件仍以当前 cwd/worktree 为准；只有 PaceFlow artifacts 与 .pace 运行态走 Project Root 共享位置」——直接搬 `pace-workflow SKILL.md:140` 原话保证注入==skill 单源一致（加对齐注释防 doc-sync 漂移），防呆前移到注入层（注入先于 skill 被 AI 看到、不需 invoke skill）。源起一个 fresh session 在子目录启动、Project Root 解析为父级（mode=inherited 是子目录继承父项目的**设计本意**非 bug——correction-2026-06-19-04 记我误判设计意图为「算法巧合」被用户纠正），把 audit 误放到父级 docs/audits；回 design doc §7.1 查清「项目上下文段只输出路径、不展开解释」是被实践证伪的旧取舍。TDD 红→绿（SL-43 inherited / SL-44 worktree 正向 + SL-45 independent 反向守护无增噪）；R 审计 grep 字字比对注入句==skill 原话（仅 `.pace` 反引号为 markdown→纯文本载体适配）P0-P3=0。附 REFERENCE v6 措辞修正（「v6 决策」→「兼容性」、去冗余「v6 正式安装路径」）。`node tests/run-all.js` 8/8：test-session-layers 51（+SL-43/44/45）、test-hooks-e2e 456、test-pace-utils 299、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.17 | 2026-06-19 | **reserve --cwd 对称内联补全**（CHG-20260619-01）：补 v7.2.16（CHG-03 T-002）遗漏的 hook 内 reserve 命令 --cwd——`FORMAT_SNIPPETS.reserveHelper`（写码门 deny + agent 派遣 deny 共享 snippet）从静态常量升级为接 cwd 的函数 `reserveHelper(cwd)`（有值内联 `--cwd "实际值"`、无值 fallback 兼容），+ `pace-utils:393` artifactRootChoiceMessage + agent-lifecycle `reservationRequiredReason`/`reservationExplicitMissingReason` 的 reserve/record-correction 命令全部补 --cwd。hook deny 有 cwd scope 故注入真实值（对齐 SessionStart、copy 即用根治 Bash cwd 漂移致 reservation 写错 runtime），skill 静态模板保持占位符。源起 CHG-4 dogfood 写码门 deny 时核 deny 载荷发现「门 deny 触发 ≠ 门正确」（correction-2026-06-19-03 链 verification-discipline）。opus R 审计抓出 `:386` 同根残留 + 守护 regex `${operation}` 变量盲区虚假绿灯，本 CHG 内补全（守护放宽 `/--operation \S/`）。新增对称守护测试防再漏。`node tests/run-all.js` 8/8：test-hooks-e2e 456、test-pace-utils 299、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.16 | 2026-06-18 | **入口闭环修复路线——pace-workflow 纯化 + record-correction 字段 hard-deny + knowledge 评估信号**（CHG-20260618-01/02/03）：承接 ultracode 入口自闭环审计，PACEflow 激活/流程引导单源化。**CHG-01**——被纠正→记 correction（N11）、finding 评估通用性→pace-knowledge（N13）、验证失败重验（N17）引导进 pace-workflow skill；artifact-writer frontmatter 加 `skills: [pace-knowledge]` 预加载（官方 subagent 字段，实测 tool_uses:0）；record-finding/correction 加「knowledge 评估信号」段（agent 给信号、主 session 裁决沉淀）；修 pace-knowledge stale「无 modify-finding」句（`update-finding` 可 append 追加正文）。**CHG-02**——agent-lifecycle-guard 补 record-correction 五必填 + knowledge-link/project-scope 二选一字段 hard-deny（复用 `DENY_AGENT_LIFECYCLE_PROMPT`、对齐 approve/review/close、不自创 code），含子串污染回归护栏测试。**CHG-03**——pace-workflow 纯化为「已启用后流程」（删激活 flowchart + 回退 N01 自判判据 + 删豁免表，激活权威归 hook 的 `detectSoftSignal`/`isPaceProject`/AskUserQuestion，slash command 发现靠 Claude 内置 `/help`）；reserve `--cwd` 模板对称内联（4 skill + SessionStart 动态注入，根治主 session Bash cwd 漂移致 reservation 写错 runtime）；N07 Stop verify 前缀单列（消除默认前缀「不要执行新任务」与正文「去验证 / 审计」抵触）；N15 reserve deny 内联完整命令 + batch 对称；N14 活跃 CHG 摘要状态符号图例。三 CHG 各 opus R 审计 P0/P1=0（CHG-03 P0/P1/P2=0）。`node tests/run-all.js` 8/8：test-hooks-e2e 456、test-pace-utils 298、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.15 | 2026-06-16 | **finding 索引补 `[type::]` 落点 + bash 反引号命令替换写保护对称补全**（CHG-20260616-06/07）：**CHG-06**——finding 索引格式全发布面加 `[type:: <type>]` meta（修正 artifact-writer-spec「type 由正文 / `#finding` hashtag 承载」失效声称，7 处格式定义点同步），删 `FORMAT_SNIPPETS` 两个零引用死 snippet（`findingsFormat` 同为唯一无 `#finding` 的漂移源，删后存活定义点全收敛带 `#finding`）；实测派 record-finding 印证 agent 实际落 `[type:: observation]`——旧文档不仅空转、还与 artifact-writer 既有 meta 行为相悖，本 CHG 让文档对齐既有行为。**CHG-07**——bash-guard `MUTATING_ANCHOR` extraChars 补反引号，让反引号命令替换（与 `$(rm task.md)` 是 POSIX 等价语法、对称）内 mutating 动词被段首锚定，补全 CHG-20260616-02 对「命令替换」同概念覆盖；brace expansion / eval 属「语法展开 / 运行时求值」不同概念，按「不堆特例」取向保持 backlog。TDD 红→绿 + over-block 反向验证（含 artifact 名只读反引号不误伤）。opus R 审计各 1 P3 won't-fix（migrate 表头守卫未对齐 / 转义反引号既存对称 over-block）。`node tests/run-all.js` 8/8：test-hooks-e2e 450、test-pace-utils 298、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.14 | 2026-06-16 | **删 Stop hook 的 lastMessage 话术门（COMPLETION_PHRASES）——确定性门回归「事件信号 + 确定状态」**（CHG-20260616-04/05）：Stop 是 Claude Code 提供的确定性事件信号，原 `stop.js` 两处额外读 `lastMessage` 用 `COMPLETION_PHRASES` 正则猜「AI 声称完成」来调制放行。控制流逐分支推导证 artifact 路径话术门是**净误伤**——`completionPending>0` 的真实「未完成」拦截全由确定性的 running-pending 检查（294 行）兜底，话术门唯一能独立改变结果的场景就是越过 background 软放行（实测 805：后台任务真在跑、AI 说「任务完成」被误 BLOCK）。删 artifact + legacy 两处话术门 + 清死变量（`completionPending`/`lastMessage`/import）+ 顺手摘除已无消费者的 `COMPLETION_PHRASES` 常量（constants/pace-utils 4 处导出链）。TDD 红→绿（10a2 反转为软放行 + 10a2b 证确定性兜底不丢 + 10a2c 证 legacy 不拦）；opus R 审计四棱镜（路径追踪 + old vs new 差异运行）无 P0/P1。沉淀 spec 设计宪法第 8 条「门读事件信号+确定状态、不解析 AI 话术」。`node tests/run-all.js` 8/8：test-hooks-e2e 450、test-pace-utils 297、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.13 | 2026-06-16 | **P3 工程卫生收口——文档修正 + 小代码守护 + 测试补全**（v7.2.10 审计 P3 清单 11 条）：**文档**——REFERENCE §3 补 `update-finding`/`update-index` 行；README:217 补 HOTFIX（`CHG/HOTFIX/CORRECTION`）+ 版本表 v6.0.12 跳号注 + :17「指令遵守率 70-85%」软化为定性（去未证实数字）；artifact-writer-spec §5 加退役注脚（§5.2/§5.6.2 是 implementation_plan 退役空位——R 审计发现初版重编号会漂移 9 处指令文件入向引用，改注脚消除困惑、不动引用、零耦合）。**小代码**（每条配套测试 + 验反向）——bash-guard `MUTATING_VERB_SOURCE` 加 `ln`（`ln -sf`/hard link 覆盖 artifact 绕过缺口，反向验非 artifact `ln` 放行）；locks.js counter 读取加 `Math.floor` 整数化（防外部写浮点 `'3.7'` 产非整数编号 `CHG-date-4.7`，NaN 经 `||0` 兜底）；agent-lifecycle-guard 默认恢复模板补 `update-index`。**测试守护**（纯加不动产品代码）——9hc4a1c（action 空值不吞字段，对称 operation 版）/ 9dm（marker date-only 旁路 Edit 仍 DENY_V6_MARKER，经 3 次 systematic-debug 定位真实可达路径是 Edit 让位 marker 门）/ 23d（subagent-stop target-still-active 兜底不误标 owner closed）。opus 对抗审计 P0=0 + 1 P1（§5 重编号引用漂移）复核为真后改 B 方案（撤回重编号+注脚）修毕。`node tests/run-all.js` 8/8：test-hooks-e2e 448、test-pace-utils 297、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.12 | 2026-06-16 | **修子shell/命令替换内紧贴闭合符绕过 Bash/PS 写保护 + REFERENCE 补 background_tasks Stop 放行说明**（v7.2.10 审计 P2 剩余）：**#3**——动词锚点 extraChars 含 `(){}`（当分隔符识别动词）但三处 token/redirect 停止集（command-recognition `scanRedirectTargets` / bash-guard / powershell-guard）漏分组闭合符，致 `(rm task.md)` 切成 `task.md)` 精确匹配 artifact 失配，`(rm task.md)`/`$(rm task.md)`/`(Remove-Item task.md)` 子shell/命令替换绕过写保护（实测 `bashCommandMutatesArtifact('(rm task.md)')`=false vs 裸 rm=true）。修：bash/共享侧只加 `()`（不加 `{}`——bash command-group `}` 前语法必有 `;`、紧贴不存在，且加 `{}` 会切坏 brace expansion `cp a.{js,ts}`）；**R 审计补 PS 侧加 `{}`**——PS `{cmd}` 脚本块紧贴 `}` 合法且 PS 无 brace expansion，`{Remove-Item task.md}` 漏被 reviewer 抓出、主 session 实测复核坐实后本 CHG 修（同一「分组闭合符」概念两 shell 语法约束不同、不能一刀切）。over-block 反向：引号目标走引号分支不受影响。**#10**——REFERENCE §5 补 background_tasks Stop 放行说明对齐 README（避免「有未完成任务一律阻断」错误心智模型）。R 审计另发现 bash 反引号命令替换形式绕过（MUTATING_ANCHOR 缺反引号字符、与停止集正交、预存缺口）→ record-finding 留 backlog。TDD 红→绿 + opus 对抗审计 P0/P1=0。`node tests/run-all.js` 8/8：test-hooks-e2e 445、test-pace-utils 295、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.11 | 2026-06-16 | **写码门回归单一判据——删执行期完整性门第二分支 + 补主流语言 CODE_EXTS 白名单**：审计 #1 揭示写码门两问题——(a) `CODE_EXTS` 仅 10 种扩展名，C/Ruby/PHP/Shell 等真源码在无 owned CHG 时被当「非代码」放行（under-block，写码门对这些语言用户失效）；(b) `projectMutationNeedsGate` 第二分支让非代码文件门控依赖「是否持有 owned CHG」，同一文件有无 CHG 行为不一致、且误伤 plan md（曾打 `isPlanningArtifact` 补丁救场）。定锚确认第二分支声称的「把改动归属到 CHG」**架构不可达**（hook 无文件↔CHG 账本、放行只看「有 ≥1 runnable CHG」不绑具体 CHG、`implementation-notes` 是 AI 自我声明无 diff 核对），实际只在用 deny 文档写入逼 `approve-and-start`、服务不可达目标却制造真实痛点。**T-001**——删第二分支（连 `isPlanningArtifact`/`PLANNING_ARTIFACT_DIRS` 补丁一起删）+ 简化 `gatedEntries`：非代码文件（文档/配置）不再因「持有 owned CHG」进 C/E 流程门、一律放行；artifact 完整性门（marker/直写/索引损坏/详情缺失）独立保留不动。**T-002**——`CODE_EXTS` 补 28 个无歧义主流语言扩展名（C/C++/Ruby/PHP/C#/Swift/Kotlin/Scala/Dart/Lua/Shell/Elixir/Clojure/Haskell/Erlang/Julia/ObjC++），歧义项 `.m/.r/.pl/.sql` 不补（over-block 代价 > under-block，宁漏不误伤）。定位：写码门是「行动时刻流程在场门」，非变更账本/路径裁判/攻防完备；确定性门是兜底非主防线（要靠后缀才拦得住时前面入口引导已全失效）。TDD 红→绿（CGS-1 非代码放行 / CEX-1 补的扩展名 deny）+ opus 对抗审计 P0/P1/P2=0。`node tests/run-all.js` 8/8：test-hooks-e2e 445、test-pace-utils 293、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.10 | 2026-06-15 | **codex v7.2.9 审计 P3 收口——operation/action 空行 parser same-line 化 + REFERENCE 日期同步**：**P3-1（operation 空行 parser 缺口）**——`promptFieldValue` / `operationFromAgentPrompt` 冒号后的空白匹配会跨换行吞掉下一字段，`operation:` 后直接换行再写 `title:` 会被解析成 operation=`title:`，致 v7.2.9「缺啥列啥」漏掉空 operation 形态、补 artifact_dir 后 lifecycle 门报误导性「operation『title:』不在受支持的 8 类指令内」而非「缺少明确 operation」（安全上仍 deny，非放行漏洞）。新增 `promptFieldValueSameLine`（冒号后只吞同行空白、不跨换行），`promptDeclaredOperation` / `promptDeclaredAction` + `operationFromAgentPrompt` byField 改用之；**全局 `promptFieldValue` / `promptHasNonEmptyField` 一律不碰**——保护 implementation-notes / verify-summary 等「字段名后换行接缩进列表」的多行值靠跨换行匹配判非空的行为（codex 建议的「全局让分隔空白不跨换行」方案经主 session 复核会把这些多行值误判为缺失 → close-chg missing-fields 误 deny，故弃用，改采其 same-line parser 第一方案）。lifecycle 门已有「operation 为空 → 缺少明确 operation」分支，修好取值后自动走对、无需改门。**P3-2**——REFERENCE「最后更新」2026-06-13 同步 2026-06-15。TDD 红→绿（9haa0e 缺 artifact_dir 路径列全 / 9haa0f lifecycle 路径报缺 operation 非 unknown）。`node tests/run-all.js` 8/8：test-hooks-e2e 442、test-pace-utils 293、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.9 | 2026-06-15 | **DX/文档收口——派遣门缺失项聚合提示 + 勘误约定文档化 + PACE_RELEASE_BASE 发布验证入口 + 死参清理**：**派遣门「缺啥列啥」（用户提议）**——artifact-writer 派遣缺 `artifact_dir:` 时是串行早返第一道、到不了后面的 operation 校验层，缺 artifact_dir + operation 两样要撞两次 deny；`agentArtifactDirDenyReason` 加 operation 缺失检测（`promptDeclaredOperation` 为空即缺），同一条 deny 一并点名两项、免二次往返（operation 在则不追加、零回归；golden artifact_dir case 含 operation 声明故快照不变）。**勘误约定文档化**——artifact-writer-spec §7.2 加：CHG 执行中 create 时规划态（Why/How）前提被证伪时走 `update-chg section=work-record` 追加 ⚠️勘误、不重写 create 段（保留原始计划作历史；artifact-writer 无「改写已归档规划段」操作是有意设计）。**PACE_RELEASE_BASE 发布验证入口（codex v7.2.8 审计 #2）**——能力 v7.2.6 已实现但 CLAUDE.md/REFERENCE 验证文档只写 `node tests/run-all.js`、维护者照文档跑不会做 release 区间检查；两处补 `PACE_RELEASE_BASE=<上版 commit>` 说明（治 push 后 @{upstream}..HEAD=0 盲区）。**死参清理（用户 flag）**——`legacyArtifactWriterLockDenyReason` / `artifactResourceLockDenyReason` 的未用 context 参数（lock / lockAttempt / resource）删除 + caller 同步。TDD 红→绿（9haa0c 缺俩列全 / 9haa0d operation 在零回归）+ opus 对抗审计 P0/P1/P2=0（不改 pass/deny 决策、operation 检测正确、golden 不破）。`node tests/run-all.js` 8/8：test-hooks-e2e 440、test-pace-utils 293、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.8 | 2026-06-15 | **工程卫生——structure-backlog 组1 收尾（1.3 runtime-control 守卫去重 + 2.6 reservation 契约锁）**：**1.3**——命令工具（Bash/PowerShell/Monitor × {localArtifactRootChoice, projectRootMarker}）runtime-control deny 守卫原在 paceEntrySignal 块内（signal 路径）与块外（no-signal 兜底）逐字写两遍、靠人工同步；抽 `commandLocalArtifactRootChoiceDeny` / `commandProjectRootMarkerDeny` 两 helper（返 `{reason,action,fields}` 或 null——hardDeny 是主函数局部闭包故 helper 只返描述符），区 A / 区 B 两调用点共用消漂移（−76 行）。**首次误判区 B 为死代码直接删除、被 e2e `9hc-helper4b` 抓到 no-signal 路径漏拦、revert 改为正确抽函数**——TDD 价值实证。**2.6**——`reservationMatchesArtifactRel` 的 fail-open（无 reservation/rel → ok）是「检查不适用」文档化意图 + agent 派遣门 `reservationMatchesExplicit` 前置兜底，补契约单测锁三态（null fail-open / 匹配两路 slug+精确 / 真 mismatch ok:false+expected/actual / 不适用兜底），把「反向断言护栏」落成回归锁。**纯重构/纯测试零产品行为漂移**：等价锁 = helper 体与原内联守卫逐字一致 + signal/no-signal 双路径 e2e（`9hc-helper4b`/`9hc-helper4d`）保绿；opus 对抗审计 P0/P1/P2=0。组1 余项 reject：1.5（别名 bashCommand/powershellCommand 同值、用错零后果）、1.7（reservationMatchesExplicit 判 prompt vs reservationMatchesArtifactRel 判写盘 rel 是两半异质检查、已双向 @see + startsWith 一致）。组2 按 finding 自身「大重构配套」指导收尾：2.4 命名空间拆分 / 3.4 truncate 耦合 / 3.5 字面量 / 1.6 collectWarnings 均 gold-plating reject；2.2 vault-notes 子模块抽离 defer 到 artifact 大重构窗口。`node tests/run-all.js` 8/8：test-hooks-e2e 438、test-pace-utils 293、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.7 | 2026-06-15 | **工程卫生——命令工具 mutatesArtifact 谓词链去重（structure-backlog 组1 项 1.4）**：pre-tool-use.js 中 Bash 与 Monitor 工具分支原各内联**逐字相同**的 4 项 mutatesArtifact 谓词链（redirect / shell-wrapped redirect / 内嵌写脚本 / mutating 动词引用 artifact），靠人工同步易漂移；抽 `bashCommandMutatesArtifact` / `powershellCommandMutatesArtifact` 命名谓词到 `bash-guard.js` / `powershell-guard.js`（与组成谓词同源 co-locate），三分支改调命名谓词，Monitor 经 bashCommand 复用 bash 识别栈消漂移。同步清 pre-tool-use 因去重而死的 8 个组件谓词 destructure 导入（`bashCommandLooksMutating`/`powershellCommandLooksMutating` 仍由 dispatcher 用故保留）。**纯重构零行为漂移**：等价锁 = `git show` 原内联链 vs 新谓词体字符级一致（仅形参 bashCommand→command）；e2e 行为网（Bash/PS/Monitor artifact 拦截 9hf~9hgd + Monitor）全绿。TDD 红→绿（新谓词单测各覆盖正例 + 只读反例防 over-block）+ opus 对抗审计 P0/P1/P2=0（逐项核等价、8 死导入零残留引用、runtime-control 路径未动、PS 链本该 3 项无 shell-wrap 项）。`node tests/run-all.js` 8/8：test-hooks-e2e 438、test-pace-utils 292、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.6 | 2026-06-15 | **工程卫生扫尾——死码/导入清理 + 发布面文档订正 + SubagentStop transcript lazy + 结构测试表守护 + run-all 区间检查（v7.2.5 后用户复核 + codex P3 审计 + IDE lint 定锚批）**：贴入 lint 半数 stale/by-design，回当前代码定锚剔除（`denyOrHint:278`/`eventType:960` 行号漂移指已删/已改符号、`eventType:275` 签名稳定故意保留、5× CommonJS→ESM 是 hook 运行时设计选择，均不动）。**死码**——删 `pre-tool-use.js` 死 destructure（`getProjectRuntimeDir` 实走 `paceUtils.*` 命名空间 / `promptHasTrueField` 零引用、本体仍在 agent-lifecycle-guard）、`post-tool-use.js`（`ts`）、`plans.js` `formatBridgeHint` 死参 `artDir` + `collect-state.js` caller。**文档（codex P3-1/P3-2）**——REFERENCE §5.1 拒绝档位表「实现」列旧名 `denyOrHint(...)`/`hardDeny() 或 inline-deny` 更新为 `emitDeny` + `DENY_REASONS` `teammateMode`（soft/hard-note/hard）+ 维护者注脚；README v7.2.5 计数订正「21 raw→22」（`git show` 旧版 b593063 精确计数 26 hardDeny+13 denyOrHint+22 raw+1 catch=62 自洽；codex 误报的「24→26」按「24 站点不变 + 2 个 DIRECT_ARTIFACT_EDIT 改预包」实属正确、不动）。**logic（codex 3.3）**——`subagent-stop.js` `inferCloseTarget` 从 transcript eager 展开改两段式惰性（廉价 candidate 先试、全 miss 才读可达 200KB transcript），抽 `matchCloseTargetFromCandidates`，PSP-02 同源不变量逐字保留。**测试（codex P3-3）**——结构测试加 `EXPECTED_DENY_META` 逐项锁 53 个 action 的 {escapeHatch,dirHint,teammateMode} 三元组（`DENY_DIRECT_ARTIFACT_EDIT` dirHint:true 例外已锁），防 deferred action 富化位写反而行为 golden（仅 33 出口）未覆盖。**run-all（codex #3）**——抽 `whitespaceCheckRanges` 纯函数 + `PACE_RELEASE_BASE` 环境变量，置位时额外查 `base..HEAD`，根治 post-push `@{upstream}..HEAD=0` 漏检整段 release 区间 whitespace。3 TDD 红→绿（SST-LAZY/SST-LAZY-FALLBACK/RUN-6）+ opus 对抗审计 P0/P1/P2=0（逐路径验证 lazy≡eager）。不在本批（在案）：budget head 永不截严格版（有意设计取舍）、finding foreign-worktree（by-design 待裁定）、finding stop-background-tasks（阻塞上游 harness 探针）、pace-utils require-cache 注释（机制疑似本就正确待独立验证）。`node tests/run-all.js` 8/8：test-hooks-e2e 438、test-pace-utils 290、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 6 |
| v7.2.5 | 2026-06-14 | **deny 网关收敛——emitDeny 单出口 + DENY_REASONS 元数据表（1.8 re-anchor，纯重构零行为漂移）**：`pre-tool-use.js` 原 62 个手写 deny 出口（三族 `hardDeny`/`denyOrHint`/内联 raw，逃生口/dirHint 富化不一致）收敛为单一 `emitDeny(action, reason, fields)` + 模块级 `DENY_REASONS` 表（action→{category, escapeHatch, dirHint, teammateMode}）。`hardDeny` 改薄包装委托 emitDeny（24 站点不变）；2 个 `DENY_DIRECT_ARTIFACT_EDIT` 去 caller 预包改表 dirHint 富化；13 denyOrHint + 22 raw 直迁、`denyOrHint` 函数删除；**reason 文案留各 call site 保零漂移**；全局 catch fail-closed 故意保留独立 raw。**先黄金基线后迁**——`tests/golden/deny-outlets.snapshot.json` 全文快照逐字锁 33 个可达出口（teammate 三模 soft/hard-note/hard × 三族 + fail-closed/agent 派发/integrity，路径/日期归一保跨机跨天稳定，对未重构 HEAD 生成防自指 characterization），每批迁移保绿即证 byte-exact。结构测试断言 `DENY_REASONS` 53 项完整 + emitDeny fail-fast 未登记 code + 手写 deny 出口收敛至 2。**opus 对抗审计 P0/P1/P2=0**；29 个未被 golden 行为锁定的降级出口表值经主 session `git show HEAD:` byte-diff **逐条锚定 0 mismatch**（确定性收口，闭合审计 P3-1）；P3-2 log 字段保真无自动守护记 finding（诊断面非契约面）。`node tests/run-all.js` 8/8：test-hooks-e2e 437、test-pace-utils 288、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 5 |
| v7.2.4 | 2026-06-14 | **SessionStart 注入调优 + bash-guard over-block 修复 + release hygiene（1.8 emitDeny 仍延后）**：**注入调优（用户反馈）**——walkthrough 表格截断 `WALK_KEEP` 10→5（低价值背景 5 条够）+ corrections cap 6→30（rank-1 高价值「避免重犯」记录尽量全量，单块极端规模优雅降级而非去 cap 的 all-or-nothing）；两块在 L3 可截层 net head≈0，截断 `group==='artifact'` 门控、startup/compact 双事件断言锁。**HOTFIX bash-guard over-block**——`isPaceflowValidationScriptTarget` 白名单从硬编码 2 文件放宽为 `tests/*.js` 模式（bash + PowerShell 两侧对称，消「移植不对称」漂移），根治含 artifact fixture 的 PACE 测试（如 test-session-layers）跑 `node` 被 `bashCommandEmbedsArtifactWriteScript` 当 artifact-write-script 误拦；仍由 `plugin.json name==='paceflow'` gate 限定 paceflow 仓库本身、用户项目不受削弱。**release hygiene（codex v7.2.3 审计 P3）**——删 v7.2.3 提交残留的 EOF 空行 + `run-all` 的 `git-diff-check` 增强为工作树 + `@{upstream}..HEAD` 区间复合检查（catch「已 commit 但无区间检查漏掉」的 whitespace）。TDD 红→绿（SL-CORR-1/SL-34 双事件、BG-WHITELIST forward+reverse+PS parity、RUN-5 run-fn）+ opus 对抗审计（HOTFIX 白名单放宽 P0/P1=0，P2 maintainer-trusted 盲区 won't-fix、P3a PS 对称当场修）+ codex v7.2.3/v7.2.4 独立交叉验证 → `node tests/run-all.js` 8/8：test-hooks-e2e 402、test-pace-utils 288、test-session-layers 48、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 5 |
| v7.2.3 | 2026-06-14 | **工程卫生 change-set（re-anchor 到 c083ea2 逐条定锚的 6 CHG，1.8 emitDeny 延后 v7.2.4）**：**测试基建**——新建 `tests/run-all.js` 聚合 runner（忠实透传退出码 + `PACE_TEST_FILTER` 分片，根治手敲漏跑回归漏网）+ 验证清单收敛；e2e 日志可注入 `PACE_LOG_PATH`（logger 集中 `defaultLogPath()`，15 hook 统一经它、零 env 重复，e2e 每轮注入独立 tmp 日志、源码树 `pace-hooks.log` 零写，`LOG-ISOLATION` 锁实证）根治结构性 flaky + 删 logDelta 兜底；契约套件轻量保活（`verify-output` 加 schema 值漂移检测 + README 诚实标注 fixtures 仍 v6 形态/套件休眠，非全面复活）。**robustness**——SessionStart budget head 预算化：`renderActiveChangeSummary` header + `renderChangeSetProgress` group 各 cap 前 12 + 长尾指针（防 30+ 活跃 CHG header 无界撑爆 head 超 10K char/hook cap 致上下文恢复残废）+ `headOverflow` 信号 → `OVER_BUDGET` 日志兜底，head 仍永不截保 CHG-B 信噪比优先。**去重**——项目检测 `hasChangesDir`/`legacyV5FilesInDir` 双实现下沉单一 `detection.js`（门面与 path-utils 共享，消除 v5 检测正则单边改致激活层与提示层静默分叉），三方等价锁 + git byte-diff 证零漂移。**helper**——reserve `--count` 改用 `flagValue` peek 补全 A4（后跟 flag 走统一缺值 fail-closed、不吞后续 flag，codex 审计指出）。**文档六项**——字段速查补 update-finding/update-index、spec 加 WARN 强制层级注脚、pace-bridge 补 set-project-root 行、REFERENCE §6 补 Claude Code ≥2.1.139 下限、close-chg 示例顺序三源对齐、reservation 双 matcher `@see` 不变量；`.gitignore` 补 run-all/test-run-all 豁免。20+ TDD 红→绿 + 2 次 opus 对抗审计（R1/D1，P0/P1=0，change-set 第二无界源当场补 cap）+ codex 独立交叉验证 → `node tests/run-all.js` 8/8：test-hooks-e2e 402、test-pace-utils 287、test-session-layers 47、test-migrate-v7 16、test-agent-tests-helpers 11、run-all-self 4 |
| v7.2.2 | 2026-06-14 | **三源审计工程修复（concurrency/owner/状态机审计 + release-surface 评审，v7.2.2-engineering-fixes 5 CHG）**：**A1 确定性网关补齐**——agent-lifecycle-guard 加 V/R 偏序确定性门（verify 需 APPROVED / review 需 VERIFIED / close 需 APPROVED，artDir 直读 detail + fail-open 不误伤路径异常）+ unknown-operation 8 类白名单 hard-deny（修并发审计 Bug#3 + release-surface 4.3，对齐确定性网关哲学）。**A2 change-owner 一致性**——heartbeat states 扩 backlog/ready/blocked（排 detached 保 takeover 窗口）+ sweep 改用内部 timestampMs 与 changeOwnerStatus 一致（修 Bug#2 活跃 session 的 blocked owner 被 30min 误清）；写盘 change-detail 加 owner 复核 foreign/sibling-fresh deny（修 Bug#4 越权改他人活跃 CHG 详情，闭合 dispatch→write 判定割裂）。**A3 schema/解析器对齐**——validateFrontmatterSchema 加 per-kind status 枚举校验（修 Bug#5 typo status 退化 base-only）+ hasNonNull*Date 重写复用 parseFrontmatter 同口径 last-wins、去 whole-doc fallback（修 Bug#6 双解析器分叉）+ BOM 转义。**A4 helper 健壮性**——cli-args.js 公共 flagValue peek 下沉，reserve/sync-plan 的 `--cwd`/`--operation`/`--plan` 等改用 + missingValue fail-closed（修 release-surface 行动项2残：codex v7.2.1 只修 set-project-root 的 asymmetry）。**A5 发布面文档/合规**——README `$PLUGIN_DIR`→`${CLAUDE_PLUGIN_ROOT}`+终端解析、token 57% 失源改定性、CLAUDE.md 补 test-session-layers+test-migrate-v7、移除 migrate HYGIENE 私人 vault 文档名。15 TDD 红→绿 + 2 次 opus 对抗审计（A1/A2 高风险，P0/P1/P2/P3=0）→ test-hooks-e2e 401、test-pace-utils 280、test-session-layers 42、test-migrate-v7 16、test-agent-tests-helpers 9 |
| v7.2.1 | 2026-06-13 | **codex v7.2.0 审计补遗（helper fail-fast + schema guard 路径完整性 + 文档/合规）**：codex 对 v7.2.0 独立审计补出原 77 条严格审计漏掉的 5 条——**P1** migrate-v7 未知参数 fail-fast（`--dryrun` 误拼少一连字符不再被静默忽略致执行真迁移）+ `--cwd`/`--restore` 缺值 fail-fast；**P2** schema 前向兼容 guard 覆盖 artifact-writer Agent 派遣路径（8.0 数据 deny + 升级提示，不走 7.0 lifecycle 裁判/模板创建写坏新数据，补 CHG-04 guard 缺口）；**P2/P3** set-project-root `--cwd`/`--mode` 缺值 fail-closed（复用 set-artifact-root H-01 missingValue 对称）；**P3** README/REFERENCE 当前功能段 v6 CHG/task-impl 双索引口径修正（G-doc 漏网）+ 补 LICENSE（MIT 正文，对齐 plugin.json 声明）。3 TDD 红→绿（V7E-1d/9hc-helper4e/V7F-7）+ opus 对抗审计（确认 Agent deny 非 brick、钉死 deny 断言、补 --restore 缺值）→ test-pace-utils 275、test-hooks-e2e 392、test-migrate-v7 16、test-session-layers 42、test-agent-tests-helpers 9 |
| v7.2.0 | 2026-06-13 | **v7 严格审计修复二/三/四批（七组 findings 全部清零，v7-audit-fix-wave2/3/4）**：**G-legacy / G-doc**——hook 运行时 24+ 处 v6 自称 + 已退役「索引事务」deny 文案改版本无关措辞、correction「仅本项目」标注 4 处发布面对齐 `[scope::]`；README/REFERENCE 按 v7 运行时同步（激活模型重写为强/软信号两层、5 个用户命令文档、PreCompact 快照退役、8→9 类 hook + SessionEnd、发布检查 schema-version 6.0→7.0、索引完整性三门→两门）。**G-template / G-schema**——agent.md close-chg 补 `implementation-notes` 消 guard deny 漂移、update-finding/update-index 补正向模板、删 implementation_plan.md 死模板；archived 必填集补 verified/reviewed-date 对齐 §4.1 状态机表（cancelled 豁免）、post-tool-use 兜底正则适配带 slug 文件名、change-set/change-set-seq 成对不变量校验。**G-migrate / G-test / G-spec**——migrate-v7 status 判定剥引号使含引号 status 野外 v6 vault 可迁移（消除整库 exit=1）+ 续行正则补零缩进块序列；新增 V7D-4 锁 agent.md 6 个正向模板块（mutation 实测漂移即红，修 V7D overclaim）+ V7C-2 引用 SCHEMA_V7_KEYS 代码常量 + runner async fail-fast；set-activation 未知参数报错首句补全。5 条 TDD 红→绿（V7B-6/V7B-7/15a0c/V7E-1b/1c）+ V7D-4 mutation 实测 + opus/manual 对抗审计 + 低价值 P3 按可达性降级备案 → test-pace-utils 275、test-hooks-e2e 390、test-session-layers 42、test-agent-tests-helpers 9、test-migrate-v7 14 |
| v7.1.0 | 2026-06-13 | **v7 严格审计修复第一波（v7-audit-fix-wave1，77 条 findings 经对抗验证后的 P1 级收口）**：**v5 迁移路径退役**——v5 deny/fail 门控全部撤除（写码门/agent 派遣门/reserve/Stop），batch-archive-v5.js 与 v5-migration-state 三态机制删除，检测降级为一句布局提示（首个 create-chg 建出 changes/ 后自动消失），v5 项目新内容直接走当前合同；**v6→v7 升级指引**——README 新增升级章节（先升级 reload 全部 session 再迁数据的顺序铁律、兼容不对称警告、锁死恢复三路径），spec 兼容论证三处 historical 勘误；**schema 前向兼容 guard**——数据 schema 高于 hook 支持上限时流程门让位为升级提示（pre-tool-use/Stop/SessionStart 三面对称、写保护不软化），v7→v8 升级窗口不再 brick；**reserve 重复发号修复**（HOTFIX）——existingMax 适配带 slug 文件名，counter 丢失（fresh clone/换机）不再同日重发同 ID。mutation 红绿闭环验证测试判别力；剩余 P2/P3 已全部入库为 7 条分组 finding 待批次消化 → test-pace-utils 272、test-hooks-e2e 389、test-migrate-v7 12、test-session-layers 42、test-agent-tests-helpers 9 |
| v7.0.0 | 2026-06-12 | **v7 大重构（artifact-schema-v7-refactor change-set 6 CHG）**：**单索引**——`task.md` 是唯一 CHG 索引，`implementation_plan.md` 退役（存量由 migrate-v7 改写为 tombstone），跨索引一致性校验与 `.pace/index-transactions` 双写事务随之退役；**7.0 封闭合同**——CHG 帧 9 key / finding 帧 3 key / correction 帧 2 key，「敲定字段必须存在，不写入即非法」（缺失/多余都报 format-violation；key 恒在、未到阶段值为 null），`validateFrontmatterSchema` 三层确定性接线（agent 写盘即时打回 / Stop 兜底 / SessionStart 渲染）；**发布面目标态重写**——agent.md/spec/instructions/SKILL 全发布面按「目标态合同非变更态 diff」重写 + 规范单源化指针化（操作模板/状态映射/helper 来源/CRLF 块各立单源）+ V7D 三组一致性测试锁（漏改即红灯）；**migrate-v7.js**——frontmatter 瘦身/tombstone/索引卫生（findings 三态重排、corrections [scope::] 修正）/dry-run 预览/执行前备份/验收失败还原/--restore 整体还原/--hygiene 卫生，SessionStart 检测未迁移布局注入迁移命令 + PostToolUse 催办一次。真实 vault 121 文件迁移验收 100% 通过；每 CHG opus 对抗审计（验收 skip 假绿 P1、行内 ARCHIVE 文本误切 P0 等真跑前后拦截修复）→ test-pace-utils 275、test-migrate-v7 12、test-hooks-e2e 391、test-session-layers 42、test-agent-tests-helpers 9 |
| v6.4.0 | 2026-06-08 | audit-2026-06-07 后续处置 + 缺口补全（两个 change-set，dogfood batch create）：**追踪层正确性**——change-set 进度不再按 max 分母虚报 done（CS-PROGRESS，只报确切待执行数、仅多成员同分母附「共 N」）、Stop change-set 软提醒跳过 foreign owner（CS-FOREIGN，与 SessionStart 对称）；**复核流程**——把「主 session 修 finding 前必须独立复核为真」从 internal 审计 rigor 传导到发布面 R 段（review-methodology step4 修前复核闸 + action=review 复核证据上链），与 `receiving-code-review` 对齐；**文档/注释一致性**——walkthrough 截断 tie-breaker 注释更正、plugin.json/marketplace.json 协议串升 P-A-C-E-V-R、通用方法论去 superpowers/internal 耦合自包含；**SessionStart 注入可见性 helper**——`print-session-context.js`（startup / `--compact` + `PACE_PRINT_ONLY` 隔离 .pace 写盘）让用户首次能看到 SessionStart 实际注入；**update-finding 操作**——补 record-finding（创建）→ finding 无更新的对称缺口（status 迁移 + checkbox 联动 + append + change-link，与 update-chg 同构）。全程 R 审计（每 CHG 派 reviewer + 主 session 复核，P0/P1=0、P2 当场修）→ test-pace-utils 217/217、test-hooks-e2e 324/324、test-agent-tests-helpers 9/9 |
| v6.3.0 | 2026-06-07 | batch create CHG——把多阶段变更的规划一次性持久化为 artifact，不依赖单一 session 存活：痛点是一个完整变更天然拆成多个可闭环 CHG（如 Phase 1-4），但旧流程只能「执行完一个才创建下一个」，后续 CHG 规划只存在于 session 上下文，compact/中断即丢失。中间路径设计——CHG frontmatter 加 `change-set` + `change-set-seq` nullable 字段（无独立 epic artifact）。四 CHG 落地：**A 数据模型**（`reserve --count N` 同锁取 N 连号、counter 推进 first+n-1、owner-scoped + unique-key reservation 自然共存；`change-set`/`change-set-seq` nullable frontmatter + `frontmatterNullable` 解析；`MAX_RESERVE_COUNT=20` 严格 `^\d+$` fail-closed，count>1 限 create-chg）；**B 核心机制**（batch create 多块 prompt：共享头部 `change-set`/`change-set-total` + N 个 `--- CHG i/N ---` 块；`agent-lifecycle-guard` 确定性前置校验——缺块/块缺 reserved-id·title·tasks/块数≠total/缺 change-set/reserved-id 不匹配即派遣前 DENY；`blockFieldValue` same-line 匹配防跨行吞行；`findActiveIndexBelowArchive` 空活跃区索引错位确定性检测 + create-chg.md 锚点契约——新索引恒锚 `<!-- ARCHIVE -->` 上方）；**C 追踪层**（SessionStart 注入 `change-set 整体进度`——按 change-set 聚合活跃 CHG、done=N-未完成成员；Stop 对 change-set 未执行 planned 成员发**不阻断**软提醒，仅 `warnings.length===0` 时经 `emitAllowedStopReminders` 发出，提示逐个 approve-and-start 续接，绝不死锁）；**D 文档对称**（bridge 批量创建小节 + pace-workflow「可独立验证/回滚/关闭的最小闭环单元」原则 + artifact-management batch 模板/操作表/`reserve --count` 三 skill 对齐）。全程 TDD + 对抗 R 审计（每 CHG P0/P1=0，mutation testing 补测试判别力洞）；feature 自身开发即验证其核心场景——空活跃区索引错位 bug 被实证并确定性根治（finding 归档）→ test-pace-utils 217/217、test-hooks-e2e 316/316、test-agent-tests-helpers 9/9 |
| v6.2.1 | 2026-06-07 | Review gate 空门修复 + 全量 R↔V 对称补齐（HOTFIX-20260607-01）：v6.2.0 live test（中性 CHG）确认 REVIEWED 是空门——`close-chg` 网关只校验 `verification-confirmed`、缺 `review-confirmed` 检查，`agent-lifecycle-guard.js` 放行后 artifact-writer 在主 session 未审计时仍折叠并伪造 `REVIEWED` + `## 审查记录`。根因是确定性网关缺 R 系字段检查（指令层 LLM-soft 不可靠）。修复：close-chg 必填项加 `review-confirmed`/`review-source`/`review-findings`（缺即 hard-deny，与 approve/verify 同构）、`update-chg` 白名单加 `action=review` + gate 分支 + 模板。经 3 路对称审计补齐 21 类 R↔V 缺口：post-tool 产物校验补 `reviewed-date`（新增 `hasNonNullReviewedDate`）+ claimed-but-null 反向校验、`marker-guard` 补 REVIEWED 伪造识别与精确原因码、`session-start` 收尾清单插入 R 步骤、`FORMAT_SNIPPETS` 补 reviewed snippet、顶层流程升级 **P-A-C-E-V-R**、`archive-chg` 补 R 强制（completed 要求 reviewed、cancelled 豁免）、reference/README/模板/internal 自审全面对称；新增 6 个 e2e（REVIEWED 直写 DENY、close/action=review 缺 review-confirmed DENY、reviewed-date 校验）→ 291/291 |
| v6.2.0 | 2026-06-06 | Review gate（REVIEWED 状态机门）：CHG 收口前新增与 VERIFIED 同构的 `REVIEWED` 阶段——状态机加「completed+verified 但未 reviewed」门（`stop.js` warning 级软门，复用现成 `stop-block-count` counter 连阻 3 次降级、不死锁），主 session 按本 CHG diff **自选** review agent、用可发布通用方法论 `review-methodology.md` direct、对抗审计、按 severity 闸（P0/P1 处置、P2/P3 backlog）+ 迭代闸（HOTFIX 深度=1）路由 findings；`update-chg action=review` / `close-chg` 折叠落 `reviewed-date` + `<!-- REVIEWED -->` + `## 审查记录` 证据，**只记录「审计这步跑过」不裁决质量**（阻断-on-步骤、非-on-结论）。五阶段落地：hooks 触发层 + artifact-writer 写侧 + pace-workflow R 段编排 + 可发布方法论 + REFERENCE；经 dogfood 三棱镜对抗审计自审（无 P0/P1，2 P2 + 便宜 P3 全修，含「测试全绿但未机械验 REVIEWED」诚实性缺口闭合） |
| v6.1.4 | 2026-06-06 | 审计 audit-2026-06-05 核心残留精准修复 + over-block 回归 HOTFIX（纪律工具定位，不做 blocklist 架构根治）：TM① teammate shell 删/覆 artifact 升 hardDeny、`xargs` 入 wrapper、PowerShell `` `n `` 引号感知归一化（修 PSG-03 反噬且不 over-block 字符串字面）、`open(mode=)` 关键字 bash↔powershell 对称（BG-05/HCR-01 回归）、ARCHIVE 层2 footer 按 UTF-8 字节截断使 CJK 缺失警告可达（修 v6.1.2 债）、VT-01 9a04 去 vacuous（三重门去信号 + revert 判别力实证）、MIGV5-02-REG force+hasBackup 回滚逐字节保真；守卫识别层 blocklist 结构性架构债 + 6 个 P3 record-finding 归档；HOTFIX 修 CHG-08 T-003 引入的 PS over-block 回归（normalize 引号感知，对抗式回归验证发现并钉死） |
| v6.1.3 | 2026-06-05 | walkthrough 格式漂移修复 + prompt 文档正向化 + 表格 prepend 统一 + correction frontmatter YAML 修复：walkthrough instruction 补正向表头健壮性条款、存量段落迁回表格行；7 模式约 70 处负向 framing 改正向对齐官方 prompting practices（18 文档 skills/instructions/agent/spec）；walkthrough 表格 prepend 统一（session-start tie-breaker + 新增 e2e 2e3 + instruction）；correction frontmatter 回归原始简述设计（spec §2.3 五字段简述 single-quoted + 正文完整 + 补 `## 触发引用`）修复长文本含引号破 YAML |
| v6.1.2 | 2026-06-05 | ARCHIVE 缺失检测盲区两层修复（defense-in-depth）：层1 `checkArchiveFormat` 检测应有 ARCHIVE 的双区文件（排除无双区的 spec.md）完全缺失标记并在 post-tool-use 编辑时 / stop 退出时提醒修复；层2 `session-start` 注入对缺标记且超 `ARCHIVE_MISSING_INJECT_LIMIT` 的大文件截断兜底，防 findings/walkthrough 等 ARCHIVE 被删时全文灌爆 context。补上 pre-tool-use 归档 deny 仅覆盖 task/impl 的范围缺口 |
| v6.1.1 | 2026-06-05 | v6.1.0 发布后完整性收尾：LOCKS-001 跨 runtime 重复 ID 复核后降级为已知限制（README 文档化 + finding accepted，因需 artifact-root-bound 运行态架构改动且触发条件苛刻）；审计 P2 代码类 6 处修复——bash-guard `open` 仅写模式判 mutating 消除 read-only over-block（BG-05）、内联写检测扩 deno/bun/ts-node/ruby/php（BG-06）、`changeOwnerStatus` sid 空判 unknown 不漏检 running CHG（STOP-03）、`hasChangesDir` isDirectory 区分同名文件（PU-002）、change-owners/reservations stale sweep 遏制无界增长（RSL-01/02）；审计 P3/I 级 record-finding 归档为技术债 |
| v6.1.0 | 2026-06-04 | audit-2026-06-01/06-03 修复批次：PU-001 批准门伪造（路径 `.` 段绕过 marker-guard，改用 `path.posix.normalize` 折叠）；抽取 bash/powershell 共享守卫识别层根治单点污染多分支；解析/生命周期五处（operation 首 token / checkbox 归一 / v5 ignored 死锁 / owner 同源 / Edit 对称）；v5→v6 迁移闭环四处；compact 注入 walkthrough 详情截断方向（同日多条保留最新）；并发/fail-open 七处（锁原子上线 / stdin null / 配置缺失 fail-closed / Stop counter 死循环）；**TEAMMATE 纯执行者边界**——写代码门（C/E/no-active/索引）升 hardDeny + 三档降级文档化；测试基建（日志 delta 截断守卫 + agent-tests raw 非空断言）；`.gitattributes` 行尾归一 + P2 文档一致性。LOCKS-001 跨 runtime 重复 ID 因需 artifact-root-bound 运行态架构决策 deferred |
| v6.0.61 | 2026-06-03 | 修复 agent-tests YAML parser 回归 + 补 framework 单元测试 |
| v6.0.60 | 2026-05-30 | 修复 hook guard 审计发现：bash-guard 不再因脚本源码出现裸 artifact 文件名字面量而误拦普通脚本与官方验证命令（改用精确路径解析），并补齐 `change-owners` 运行态目录的 Bash 写保护使其与 PowerShell guard 对等；序列号锁改用非重入模式，杜绝同 session 并发预留生成重复编号；移除 `post-tool-use.js` 未注册的 Agent 死代码分支与无生产调用的 artifact-writer 锁原语；`pre-tool-use.js` 顶层异常改为 fail-closed deny |
| v6.0.59 | 2026-05-25 | 收敛 Claude 任务面板边界：移除 `TodoWrite` / `TaskCreate` / `TaskUpdate` hook 注册，`task-list-sync.js` 降级为 legacy observer；SessionStart 改为 CHG 执行上下文，明确任务面板只是工作记忆，PACE 权威仍是 `changes/<id>.md ## 任务清单`；workflow/artifact-management skill 增加继续/恢复/收口 CHG 前先 Read 详情文件的软提醒 |
| v6.0.58 | 2026-05-22 | 引入显式 Project Root 解析：普通子目录默认继承最近父级 PACEflow 项目，artifact/root choice、runtime `.pace`、CHG owner、Stop 和 plan sync 都归属 effective Project Root；新增 `set-project-root.js --mode independent` 让真正独立子项目断开继承；SessionStart/helper 文案显示 Current CWD / Project Root / Artifact Root 边界 |
| v6.0.57 | 2026-05-16 | 将 `PostToolUse` 的 `decision:"block" + continue:true` 引入生产最小试点：artifact-writer 写入 `walkthrough.md` 后若 wikilink 或 `[worktree:: ...] [branch:: ...]` 上下文仍不符合 v6 规范，hook 会让当前 turn 继续修复；每 session/目标只触发一次，避免循环 |
| v6.0.56 | 2026-05-16 | 覆盖 Claude Code 2.1.143 后的 Windows 工具面：PreToolUse 新增 `PowerShell` / `Monitor` matcher，PowerShell 原生命令写 artifact 或 `.pace` 写入控制运行态会被阻止；Monitor 只能做只读观察，不能作为后台命令绕过 Bash artifact guard；PostToolUseFailure 同步覆盖 PowerShell/Monitor 失败恢复提示 |
| v6.0.55 | 2026-05-12 | 修复 v6.0.54 Smoke3/4 后续缺口：首次 root-choice SessionStart 输出当前 reserve helper 命令；helper 明确拒绝 `--artifact-dir` / `--artifact-root` / `--project-dir`；当前 session owner 的 README/文档/配置等非代码写入也进入 C/E gate，foreign fresh owner 不阻断普通非代码写入但结构损坏仍全局阻断；SubagentStop 兜底清理 close/archive 后的 owner `closing` 残留 |
| v6.0.54 | 2026-05-12 | 修复 worktree 完成记录可读性：close/archive 写 `walkthrough.md` 时同步保留索引行的 `[worktree:: ...] [branch:: ...]` 执行上下文；PostToolUse/Stop 机械校验 walkthrough 行与 task/implementation 索引上下文一致 |
| v6.0.53 | 2026-05-12 | 收紧 worktree owner 边界：SessionStart/PreCompact active CHG 摘要 owner-aware，foreign owner CHG 在活跃区注入中折叠且不计入当前 session 任务列表；Stop 对 foreign running/closing 降噪但仍阻断结构不一致；代码阶段工具调用刷新 owner heartbeat；update/close/archive 要求显式 target；close/archive Agent 只有目标离开活跃索引后才标记 owner closed |
| v6.0.52 | 2026-05-12 | 修复 production Smoke1-6 暴露的 v5 最小 fixture 迁移漏检、helper 旧版本路径误导、`--artifact-dir` 静默忽略、close/archive 半归档恢复、worktree 跨 session Stop 干扰和宿主普通文件误写；新增 `.pace/change-owners` 运行态 owner、索引 execution-context 与 worktree 普通文件保护 |
| v6.0.51 | 2026-05-11 | 拆分 `pre-tool-use.js` 热路径：Bash 写保护、artifact-writer Agent 生命周期门禁、C/V marker 与直接 artifact mutation 判断分别下沉到 `hooks/pre-tool-use/*-guard.js` helper；主入口保留事件路由、输出和日志，降低后续审计/修改误碰风险 |
| v6.0.50 | 2026-05-10 | 收紧 CHG 粒度语义：CHG 是连续执行、可验证、可关闭的最小变更单元，大计划应拆成多个 CHG；连续执行默认由 `close-chg complete-open-tasks:true` 收口，`update-status` 只用于暂停/阻塞/跳过/跨 session/长任务可见性。新增 `hooks/reserve-artifact-id.js` helper，主 session 可先预留 create-chg / record-correction 编号；新增 `hooks/sync-plan.js` helper，pace-bridge 收尾可幂等写入宿主 `.pace/synced-plans` |
| v6.0.49 | 2026-05-10 | 补齐 production Smoke1 暴露的 Paceflow skill 入口提示：首次启用 SessionStart 只注入轻量 `Skill(paceflow:pace-workflow)` 提醒；artifact-root 选择、reserved-id 重派、approve-and-start 缺字段、close-chg 缺验证摘要等 hook deny 均提示读取 `paceflow:pace-workflow` / `paceflow:artifact-management`；扩宽 workflow skill 触发描述，覆盖已启用 PACEflow 项目中的 1-2 文件代码修改 |
| v6.0.48 | 2026-05-10 | 修复 production Smoke1 暴露的 artifact-writer reserved-id 传递缺口：不再依赖 `PreToolUse:Agent additionalContext` 被 subagent 读取；`create-chg` / `record-correction` 首次派遣会先预留编号并 deny，要求主 session 把 `reserved-id` / `reserved-file` 或 `reserved-file-prefix` 原样写入 prompt 后重派；同时收紧首次 artifact-root 选择后的提示，避免直接重试代码写入而跳过 create/approve 流程 |
| v6.0.47 | 2026-05-10 | 重构 artifact-writer 并发锁：Agent 派遣不再持有项目级锁；create-chg / record-correction 由 hook 原子预留编号；真实 Write/Edit/MultiEdit 按资源短暂加锁，详情文件可并发写入，`task.md` + `implementation_plan.md` 作为一组索引事务串行；Bash/Write/Edit/MultiEdit 禁止手写 `.pace/locks` / `sequences` / `reservations` / `index-transactions` 控制面 |
| v6.0.46 | 2026-05-09 | 补齐 P2 release sanity：plugin manifest 与 marketplace version 纳入单元测试，plugin runtime root 机械检查不含 docs/tests/internal/ticket 等开发资料；agent baseline 扩到 29 case，Phase C 增加 close-chg、archive-chg、record-finding、record-correction 正向 contract |
| v6.0.45 | 2026-05-09 | 修复 production dogfood 暴露的 native plan 桥接收尾遗漏：pace-bridge Step 5 改为硬收尾，明确将源 plan basename 幂等写入宿主项目运行态 `.pace/synced-plans`；PreToolUse / SessionStart 的桥接提醒同步给出实际 synced-plans 路径，worktree 场景不再依赖模型猜测路径 |
| v6.0.44 | 2026-05-09 | 优化 v5→v6 归档式迁移可读性和重跑安全性：旧 v5 文件顶部 frontmatter 不再原样落在 `<!-- ARCHIVE -->` 下方，而是转换为“v5 原始 frontmatter”历史 YAML 代码块；归档区增加 v5 历史说明，旧 H1 继续降级；`--force` 遇到已有 `.v5-backup` 时使用备份作为迁移源且不覆盖备份 |
| v6.0.43 | 2026-05-09 | 修复真实 `ccauth` worktree 暴露的迁移提示断点：PreToolUse / Stop / PostToolUse / PostToolUseFailure / TaskSync / SubagentStop 的 artifact 相关拦截和提醒统一带当前 Artifact 根目录；legacy v5 下 Bash 手动 `mkdir changes/` 会被拦截，避免把旧 vault 伪装成未迁移的 v6 |
| v6.0.42 | 2026-05-09 | 加固 v5→v6 归档式迁移脚本：legacy 文件内多个 `<!-- ARCHIVE -->` 历史边界会全部降级为 v5 历史注释，迁移后仍只保留一个 v6 标准 ARCHIVE 标记；同时兼容 CRLF legacy 文件。已用真实 `ccauth` v5 vault 副本完成 dry-run 与正式迁移 rehearsal |
| v6.0.41 | 2026-05-09 | 修复 Smoke6 暴露的 artifact 直接编辑绕过：主 session / 非 artifact-writer 现在不能用 `Write` / `Edit` / `MultiEdit` 直接修改 `task.md`、`implementation_plan.md`、`walkthrough.md`、`findings.md`、`corrections.md` 或 `changes/**`；这些流程 artifact 只能由持有写锁的 `paceflow:artifact-writer` 写入。`spec.md` 仍是项目规格文件，不归 artifact-writer 管理 |
| v6.0.40 | 2026-05-09 | 修复 Smoke4 暴露的 legacy v5 迁移提示歧义：hook 现在明确说明被拒绝的工具调用没有落盘、dry-run 后必须再次询问用户确认、迁移只处理 artifact 状态且原始代码任务仍需按 v6 P-A-C 重试；Smoke 手册同步区分迁移确认前/后的预期 |
| v6.0.39 | 2026-05-09 | 同步 Claude Code native build 工具面变化：主 session 可能没有独立 `Glob` / `Grep` 工具，skill / smoke 文档改为允许只读 Bash `find` / `rg` / `grep` fallback；不改变 hook 行为 |
| v6.0.38 | 2026-05-09 | 代码质量收尾：PostToolUse 对同一 CHG 的状态类提醒改为每会话一次；SessionStart 清理对应 per-CHG flags；`PACE_ARTIFACT_ROOT` 超长输入截断；logger lock stale 阈值从 5s 提到 30s；提取 artifact mutation 判定 helper 并补回归测试 |
| v6.0.37 | 2026-05-09 | 修复二轮审计确认项：PreCompact 只桥接匹配当前项目的 Claude native plan，避免 `~/.claude/plans` 跨项目串线；Bash artifact 写保护覆盖 `bash -c` 内层脚本、`npx --write/--fix` 与 package runner 等间接写入；Stop walkthrough 提示改为由 close-chg 自动补写；同步 artifact-root、pace-bridge 与模板说明 |
| v6.0.36 | 2026-05-09 | 修复审计确认项：findings 过期提醒改用本地日历日差，避免 UTC 解析偏差；Stop 不再对仍有 pending task 的执行中 CHG 提前要求 walkthrough；SessionStart walkthrough 截断按日期保留最近记录；清理 PostToolUse 死代码并补齐 close-chg / finding / agent reference 文档一致性 |
| v6.0.35 | 2026-05-08 | 拆分 plugin runtime root：marketplace `source` 改为 `./plugin`，发布包只包含 hooks / skills / agent / agent-references / migrate 等运行时资产，仓库根目录继续保留 docs / tests / internal / tickets 作为开发资料 |
| v6.0.34 | 2026-05-08 | 修复全面审计确认项：Bash artifact/lock 写保护改为解析等价路径；worktree 运行态 `.pace` 统一到宿主项目；`artifact-root=vault` 缺 `PACE_VAULT_PATH` 时 fail-closed；Stop 防循环计数在 `.pace` 缺失时仍可降级但 idle PASS 不落盘；C/V 与 PostToolUse artifact 判定统一到 artifact root；同步 `close-chg`、`pace-bridge`、correction/knowledge 文档契约 |
| v6.0.33 | 2026-05-08 | 修复 production Smoke0-5 暴露的问题：Bash 不再允许删除/改写 `.pace/artifact-writer.lock`；锁 payload 不再暴露 hook `pid`；并发锁拒绝文案改为等待/重试；idle code-count Stop 不再打扰首次闲聊；runtime config 写入不再触发无任务提醒；artifact-writer 顺序写索引时抑制瞬时不一致噪声；worktree local 模式显示修正；lifecycle prompt 字段支持 `field=value` 与中文逗号分隔 |
| v6.0.32 | 2026-05-08 | 修复 artifact-writer Agent 失败恢复链路：`PostToolUseFailure` matcher 覆盖 `Agent`，Agent 工具失败时会立即释放项目级 artifact 写锁，不必等待 TTL |
| v6.0.31 | 2026-05-08 | 增加 session_id 日志串联与 artifact-writer 项目级写锁：多 worktree / 多 session 并发派 artifact-writer 时会串行化 artifact 写入，避免 CHG-ID、索引和归档竞争；明确 `T-NNN` 是 CHG 内局部编号 |
| v6.0.30 | 2026-05-08 | 新增 v5 升级半自动迁移保护：hook 检测 legacy v5 artifact 时先要求用户确认迁移，不再让懒创建 `changes/` 混入旧 v5 根文件；迁移脚本增加 `changes/` / `.v5-backup` 防重复执行 guard |
| v6.0.29 | 2026-05-08 | 清理发布面：`audit` skill 移至 `internal/skills/audit`，不再随 marketplace 发布；修正 PreCompact I/O、ARCHIVE 标记范围、guidebook/action-plan 历史状态等文档口径 |
| v6.0.28 | 2026-05-08 | 修复 v6.0.27 审计确认项：`close-chg` 派遣强制 `complete-open-tasks:true`，统一 verified-date 检测，补 compact snapshot 边界、knowledge 时间戳示例与 hook 数量文档；移除对 plugin 安装链路无保护价值的 `ConfigChange` / `config-guard` |
| v6.0.27 | 2026-05-07 | 吸收 Claude Code 2.1.76-2.1.131 调研中的低风险 P1：新增 `SubagentStop` artifact-writer 报告协议观察、`PostToolUseFailure` 工具失败恢复提示、SessionStart 50KB 输出保护，并补齐 startup/compact/PreCompact/StopFailure 继承测试 |
| v6.0.26 | 2026-05-07 | 明确 artifact root 选择语义：`local` 是项目根目录而非 `.pace/`；PreToolUse / SessionStart / skill / agent 提示统一说明 `.pace/` 仅存配置与运行态；结构化 hook 日志新增 `ROUTE`、`artifact_dir`、`choice` 等字段并单行化多行 reason |
| v6.0.25 | 2026-05-07 | C 阶段确认语义收紧：`approve` 与 `approve-and-start` 都必须带 `approval-confirmed/source/evidence`；`approve` 只允许纯批准，若要开始执行必须用 `approve-and-start`；create-chg 后续提示改为优先合并批准+开始 |
| v6.0.24 | 2026-05-07 | 收紧 lifecycle agent prompt 语义：`approve-and-start` 缺 `approval-confirmed:true` 会被拒绝；禁止把 `update-status` 与 `verify` 串成一次派遣；`close-chg` 必须带验证确认和摘要字段，并推荐 `complete-open-tasks:true` 合并最后任务收尾 |
| v6.0.23 | 2026-05-07 | 修复 Bash artifact 写保护误判：`grep "^<!-- ARCHIVE -->$" artifact.md` 这类只读 HTML 注释匹配不再被 `>` 重定向检测误拦；真正写入 artifact 的重定向仍会被拒绝 |
| v6.0.22 | 2026-05-07 | 修复 artifact CRLF 换行导致 `Edit` 匹配失败的问题：模板写入统一 LF，`Edit/MultiEdit` 前自动归一化已有 artifact 换行，并新增 Bash 侧 artifact 写保护，禁止用 `sed -i` / 重定向等绕过 Write/Edit hook |
| v6.0.21 | 2026-05-07 | 修复 `artifact-writer` prompt 中 `artifact_dir` 子串误匹配：现在必须精确匹配 hook 解析出的 artifact 根目录，`/project/docs` 这类错误子目录会被 deny，避免 agent 写出第二套 artifact |
| v6.0.20 | 2026-05-07 | 修复 SessionStart 在首次启用或选择 local 时创建 Obsidian 空项目目录的副作用；vault 项目目录只在用户选择 vault 或 vault 已有 artifact 时创建 |
| v6.0.19 | 2026-05-07 | 修复首次选择 artifact root 后直接派 `artifact-writer` 的初始化缺口：`PreToolUse:Agent` 在放行前会创建所选 local/vault 的 `changes/` 与根索引模板，失败时 fail-closed，禁止 agent 自行创建 base `changes/` |
| v6.0.18 | 2026-05-07 | artifact 目录首次选择改为真正动手前触发：SessionStart 只记录 pending，不再向普通闲聊注入选择提示；PreToolUse 写代码/派 artifact-writer 时仍强制询问 |
| v6.0.17 | 2026-05-07 | 修复首次 artifact 目录选择的容错：`.pace/artifact-root` / `PACE_ARTIFACT_ROOT` 支持带引号和大小写差异的 `local` / `vault`；SessionStart 非 git 项目不再泄漏 git fatal stderr |
| v6.0.16 | 2026-05-07 | 新项目首次懒创建时支持选择 artifact 存放位置（Obsidian vault project 或本地项目目录），选择持久化到 `.pace/artifact-root`；worktree 沿用宿主选择，自动化可用 `PACE_ARTIFACT_ROOT` 跳过询问 |
| v6.0.15 | 2026-05-06 | 新增 `update-chg action=approve-and-start` 与 `close-chg`，合并批准+开始、验证+归档收尾链路；hook/skill/guidebook 同步推荐合并操作 |
| v6.0.14 | 2026-05-06 | `todowrite-sync.js` 更名为 `task-list-sync.js`，公开文档统一为 Claude 任务列表同步；Stop 对活跃区残留 `archived/cancelled/[-]` 增加阻断修复 |
| v6.0.13 | 2026-05-06 | Stop / SessionStart / Claude 任务列表同步改用统一 CHG 分类器，planned backlog 不再阻断 Stop 或计入当前任务列表 |
| v6.0.12 | — | 版本号跳过，无单独 release（开发中递增，未独立发布） |
| v6.0.11 | 2026-05-06 | 修复 worktree 本地 `changes/` 详情 artifact 分裂风险；PACE 项目写入 hook 解析失败 fail-closed；显式覆盖 MultiEdit；SessionStart 任务列表提示改看详情 T-NNN；worktree 识别收紧；marker 日志补 agent 身份；plugin validate clean pass |
| v6.0.10 | 2026-05-06 | 重新验证 Claude Code 任务工具语义：交互式 `TaskCreate/TaskUpdate` + 非交互/SDK `TodoWrite` 双轨；任务同步提示改为 Claude 任务列表，并补 TaskCreate/TaskUpdate 回归测试 |
| v6.0.9 | 2026-05-06 | 修复 `artifact-writer` subagent 写入 `APPROVED` / `VERIFIED` 被 PreToolUse 误伤；主 session 直接手写仍 deny |
| v6.0.8 | 2026-05-06 | 修复 worktree artifact 路由：Git worktree 归一到宿主项目名，优先沿用 `$PACE_VAULT_PATH/projects/<project>/changes` |
| v6.0.7 | 2026-05-06 | agent 显示名改为 `artifact-writer` 并添加 `color: orange`；审计 skill 改为 `audit`；legacy v5 活跃分支统一提示迁移/桥接 |
| v6.0.6 | 2026-05-05 | 将 `artifact-writer` 默认提升为 `effort: max`；新增 production release gate（20 个结构性用例，不含 D2）；production 资源预算改为 warning，TC-D2 作为内容保真 benchmark |
| v6.0.5 | 2026-05-05 | 收紧 `create-chg` 必填字段失败路径，明确 `record-finding body` 必须原样写入，并补强 fixture unchanged 验证 |
| v6.0.4 | 2026-05-05 | 修复 Phase B baseline 缺口：base `changes/` 不再懒创建，未知 operation 固定 `out-of-scope`，`report_title_strict` 改为第一行严格校验 |
| v6.0.3 | 2026-05-05 | 将 `report_title_strict` 硬约束同步到 runner prompt、通用 spec 与 create-chg instruction |
| v6.0.2 | 2026-05-05 | 收紧 TC-A1 agent prompt 路径，避免无关索引读取、插件目录搜索和报告统计工具调用 |
| v6.0.1 | 2026-05-05 | 校准 agent fixture 资源预算，补齐 duration/tool-use 校验，收紧 artifact writer 资源纪律 |
| v6.0.0 | 2026-05-04 | 引入 `artifact-writer` agent，v6-only `changes/` 详情模型，C/V 双表示验证 |

v5 历史快照见 `CHANGELOG.md`；v6 当前历史以本表为准。

</details>

## 友链

在此特别感谢 linuxdo，学 AI 上 [Linux.do](https://linux.do)

---

**版本**: v7.2.26 | **运行时**: Node.js | **平台**: Windows / macOS / Linux | **协议**: PACE (Plan-Artifact-Check-Execute-Verify-Review)
