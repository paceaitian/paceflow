---
name: pace-bridge
effort: medium
description: >
  Use to bridge a confirmed Superpowers/native plan into PACEflow CHG/HOTFIX
  artifacts, create artifact-writer prompts, and mark the specific plan as synced.
---

# Plan → PACEflow 桥接

pace-bridge 不直接 Edit `task.md`。桥接的唯一写入路径是派 `artifact-writer`。

---

## 触发场景

- PreToolUse / Claude 任务列表同步 DENY 提示检测到项目内计划文件。
- SessionStart 注入 Superpowers/native plan 桥接提醒。
- 用户要求“同步计划”“桥接计划”“把 plan 转成 PACE”。

---

## 前提

- 存在未同步的项目内 plan 文件：`docs/plans/` 或 `docs/superpowers/plans/`。
- `~/.claude/plans/` 不由 hook 自动扫描；只有当用户或 SessionStart/Claude 明确给出具体路径时，才手动读取并桥接该文件。
- 当前没有同一计划对应的活跃 CHG。
- 如果计划来自已获用户确认的 brainstorming/writing-plans，可执行 auto-APPROVED；否则桥接后进入 C 阶段等待用户批准。
- Claude Code 原生 plan 的文件名/会话名可能随版本变化；桥接只以 hook 提供的明确路径、文件内容和最近修改时间为依据，不凭文件名是否随机判断。
- Project Root 是 PACEflow 管理边界；普通子目录默认继承最近父级 Project Root。若当前子目录确实是独立项目，先运行 hook 提示的 `set-project-root` helper（`--mode independent`），再选择 artifact root。
- 若用户已经明确选择 artifact root，但配置尚未写入，正确做法是先运行 hook 提示的 `set-artifact-root` helper（`--choice vault`、`--choice local`，或 `--choice <绝对路径或相对 Project Root 路径>`），再从目标项目 cwd 运行 reserve helper。`.pace/artifact-root` 只由 `set-artifact-root` helper 写入；git worktree 与继承父 Project Root 的子目录走宿主项目共享位置。helper 接受自身文档列出的参数，自动化用 `--cwd` 指定项目 cwd。
- Helper 命令来源顺序的权威定义见 Skill(paceflow:pace-workflow)「Helper 命令来源」（本节不再复制）。速记：优先复制 SessionStart / PreToolUse 给出的完整命令；无 hook 输出但本 skill 已加载时以 skill 根目录拼 fallback；不扫描 `~/.claude/plugins/cache` 猜版本。按当前动作选择下面一条模板运行；这不是顺序执行清单：

```bash
node "<skill-root>/../../hooks/set-project-root.js" --mode independent
node "<skill-root>/../../hooks/set-artifact-root.js" --choice local|vault
node "<skill-root>/../../hooks/reserve-artifact-id.js" --operation create-chg --cwd <项目 cwd>
node "<skill-root>/../../hooks/sync-plan.js" --plan "<已桥接的 plan 绝对路径>"
```

---

## 桥接步骤

### Step 1：读取计划

读取最新未同步 plan，提取：
- 标题与目标
- 任务列表
- 影响文件/模块
- 技术决策与风险
- 验收条件
- 推荐执行方式（串行、TDD、subagent-driven、parallel agents）

### Step 2：组织 create-chg 输入

先按 CHG 粒度拆分 plan。CHG 不是大计划容器，而是连续执行、可验证、可关闭的最小变更单元：

- 如果计划横跨前端、后端、存储、迁移、文档/配置，默认拆成多个 CHG。
- 如果某部分可以独立验证、独立回滚、独立交给一个 worktree/session 执行，就拆成独立 CHG。
- 每个 CHG 内可以有多个 `T-NNN`，但这些任务必须服务于同一个闭环，并默认连续完成。
- 按闭环边界拆分功能：4-5 个独立功能拆成各自的 CHG，而非按原 plan 层级合并。

每个 CHG 派遣前先预留编号。优先使用 SessionStart / PreToolUse 提示中的 reserve helper 完整命令；如果上下文没有完整命令，按上方 helper 命令来源从当前 skill 根目录拼出同版本绝对路径。

```bash
node "<SessionStart/PreToolUse 输出的 reserve-artifact-id.js 绝对路径>" --operation create-chg --cwd <项目 cwd>
# 若没有 hook 输出但本 skill 已加载：
node "<skill-root>/../../hooks/reserve-artifact-id.js" --operation create-chg --cwd <项目 cwd>
```

如果当前桥接出的单元是 HOTFIX，预留时必须声明类型：

```bash
node "<SessionStart/PreToolUse 输出的 reserve-artifact-id.js 绝对路径>" --operation create-chg --cwd <项目 cwd> --type hotfix
# 若没有 hook 输出但本 skill 已加载：
node "<skill-root>/../../hooks/reserve-artifact-id.js" --operation create-chg --cwd <项目 cwd> --type hotfix
```

同一 session 默认复用尚未消费的 `create-chg` reservation；如果已预留过普通 CHG 但当前单元应是 HOTFIX，或确实需要另一个新编号，加 `--new`：

```bash
node "<SessionStart/PreToolUse 输出的 reserve-artifact-id.js 绝对路径>" --operation create-chg --cwd <项目 cwd> --type hotfix --new
# 若没有 hook 输出但本 skill 已加载：
node "<skill-root>/../../hooks/reserve-artifact-id.js" --operation create-chg --cwd <项目 cwd> --type hotfix --new
```

把 helper 输出的 `artifact_dir` / `operation` / `execution-context` / `reserved-id` / `reserved-file-prefix` 放到 Agent prompt 顶部，再追加：

```text
title: <计划标题>
tasks:
  - T-001: <任务标题，含验收条件>
  - T-002: <任务标题，含验收条件>
background: <从 plan 提炼 Why>
scope: <影响文件/模块与改动范围>
technical-decision: <关键设计决策和取舍>
```

每个任务自包含目标与验收标准，让后续执行者不回读 plan 也能据此执行。若需要生成多个 CHG，标题应体现各自的闭环范围，如“数据结构/迁移”“后端接口”“前端调用”“文档配置”。

**批量创建（batch create CHG，推荐用于一次桥接整个 plan）**：当一个 plan 按闭环边界拆成 N 个 CHG 时，一次预留 N 个连号、一次 batch create，而非逐个执行完一个再建下一个（后者会把后续阶段的规划只留在 session 上下文，compact 或中断即丢失）。先 `reserve --operation create-chg --cwd <项目 cwd> --count N` 取 N 个连号 `reserved-id`，再组织一个 batch create prompt（共享头部 + N 个 `--- CHG i/N ---` 块）：

```text
artifact_dir: <hook 解析出的 artifact 目录>
operation: create-chg
change-set: <变更集名（如 plan 主题）>
change-set-total: <N，必须等于块数>
--- CHG 1/N ---
reserved-id: <第 1 个 reserved-id>
title: <第 1 个闭环 CHG 标题>
tasks:
  - T-001: <任务与验收>
--- CHG 2/N ---
reserved-id: <第 2 个 reserved-id>
title: <第 2 个闭环 CHG 标题>
tasks:
  - T-001: <任务与验收>
（每块一个 reserved-id，重复到第 N 块）
```

artifact-writer 逐块建 N 个 `changes/<id>.md`（各写 `change-set` + `change-set-seq: i/N`）+ N 行活跃区索引。hook（agent-lifecycle-guard）对 batch 做确定性前置校验：缺块 / 某块缺 reserved-id·title·tasks / 块数与 `change-set-total` 不符 / 缺 `change-set` / reserved-id 与预留不匹配，都会在派遣前 DENY。整个 plan 的多阶段规划一次性落为 artifact，不依赖单一 session 存活；执行仍逐个 approve-and-start（见 Step 4，A2 模型不变）。

### Step 3：派 artifact writer

派 `artifact-writer` 执行 `create-chg`。agent 会创建：
- `changes/chg-yyyymmdd-nn.md`
- `task.md` 活跃 wikilink 索引（唯一 CHG 索引）

若没有先运行 helper，hook 会要求带 `reserved-id` / `reserved-file-prefix` 重派；把提示中的字段原样加入 Agent prompt 后重派。编号一律来自 helper 预留。

### Step 4：auto-APPROVED（可选）

如果用户已在上游计划流程中参与并确认设计，且准备开始当前 CHG 的首个任务，继续派：

```text
artifact_dir: <SessionStart hook 提供的 artifact 目录>
operation: update-chg
target: <CHG-ID>
action: approve-and-start
task-id: <首个 T-NNN>
approval-confirmed: true
approval-source: prior-approved-plan
approval-evidence: <上游计划流程中用户确认的方案摘要>
```

批准标记写在 `changes/<id>.md`，首个任务会同步为 `[/]`；`task.md` 只保留索引。若一个 plan 被拆成多个 CHG，只 auto-APPROVED 当前准备连续执行的 CHG；其余 CHG 保持 planned。

### Step 5：标记已同步（硬收尾）

桥接成功后必须标记主计划文件已同步。运行 sync helper 完成这一步，后续会话才能审计这个 plan 是否已经桥接。

优先使用 SessionStart / PreToolUse 提示中的 plan 同步 helper 完整命令；如果上下文没有完整命令，按上方 helper 命令来源从当前 skill 根目录拼出同版本绝对路径。

```bash
node "<SessionStart/PreToolUse 输出的 sync-plan.js 绝对路径>" --plan "<已桥接的 plan 绝对路径>"
# 若没有 hook 输出但本 skill 已加载：
node "<skill-root>/../../hooks/sync-plan.js" --plan "<已桥接的 plan 绝对路径>"
```

helper 会写入项目运行态 `.pace/synced-plans`，并在 worktree 场景写宿主项目运行态。`--plan` 传入已桥接的单个 plan 文件路径（单个文件，非目录名或通配路径）。

---

## 验证

桥接完成后确认：
- `task.md` 有对应 `[[chg-*]]` 活跃索引。
- `changes/<id>.md` 存在，frontmatter `status: planned` 或后续已批准。
- auto-APPROVED 场景下详情文件含 `<!-- APPROVED -->`。
- 项目运行态 `.pace/synced-plans` 已包含源计划 basename。

---

## 转换摘要格式

```text
=== pace-bridge 转换摘要 ===
源计划: <plan path>
变更 ID: CHG-YYYYMMDD-NN
任务范围: T-NNN ~ T-NNN（共 N 个）
批准状态: pending / auto-approved-started
执行方式推荐: subagent-driven-development / executing-plans / dispatching-parallel-agents / direct
```
