# create-chg 指令详细规范

> 关联 agent：`artifact-writer.md`
> 上层规范：`../artifact-writer-spec.md`（schema / wikilink / ARCHIVE 等通用规则）

## When To Use

用于创建新的 CHG/HOTFIX 详情文件和根索引行。主 session 必须先通过 reserve helper 取得 `reserved-id` / `reserved-file-prefix`，再派本操作。

## Correct Prompt Example

```text
artifact_dir: <hook 解析出的 artifact 目录>
operation: create-chg
execution-context: <reserve helper 输出>
reserved-id: <reserve helper 输出>
reserved-file-prefix: <reserve helper 输出（原样含 <slug>.md 占位，不替换 slug——slug 由你按 title 生成）>
title: <变更标题>
tasks:
  - T-001: <任务标题与验收>
background: <Why>
scope: <What>
technical-decision: <How>
```

## 输入字段

- `title`（必填）
- `tasks`（必填，至少 1 个；推荐格式 `["任务描述", ...]`，artifact-writer 为当前 CHG/HOTFIX 分配 `T-001...`）
- `type`（默认 change，可选 hotfix——决定文件名前缀与 hashtag）
- `related-finding`（可选，wikilink——写入正文 `## 关联调研` 段）
- `background` / `scope` / `technical-decision`（可选）
- `execution-context`（可选但推荐，由 reserve helper 输出，例如 `[worktree:: main] [branch:: main]`）

缺失必填字段时立即报告 `missing-fields`，字段值以 prompt 原样为准：
- 缺 `title` 或 `title` 为空 → `missing-fields: title`，`title` 只能取自 prompt 显式 `title`，与 `background` / `scope` / task 描述无关
- 缺 `tasks` 或 `tasks` 为空 → `missing-fields: tasks`
- 任一必填字段缺失时仅报告 `missing-fields`：跳过 hook 预留编号写入、跳过读取索引、跳过对任何 artifact 的 Write / Edit

## 操作步骤

> **报告标题强制**：最终输出的第一行字面是 `## artifact-writer 报告`，第一个字符为 `#`，标题前直接进入该行（无说明文字、无空行）。`report_title_strict` 会机械检查，标题不匹配即 FAIL。权威定义见 `artifact-writer-spec.md` §10。

0. 前置检查：先校验必填字段；缺字段 → 报告 `missing-fields` 并停止（不写文件）。再用 `test -d "$ARTIFACT_DIR/changes" && echo EXISTS || echo MISSING` 判断 base changes 目录；`MISSING` 时报告 `not-pace-project` 并停止，不写任何文件（base `changes/` 由项目初始化负责创建）。目录存在性以该 `test -d` 结果为准。
1. 计算 chg-id（详见下方"CHG-ID 推算"段）
2. 为当前 CHG/HOTFIX 分配局部任务 ID：按输入顺序生成 `T-001...T-NNN`；若迁移/测试输入已显式带 `T-NNN:`，保留该 CHG 内编号。任务编号始终是 CHG 局部的，编号来源限于本次输入顺序或输入自带的 `T-NNN`。
3. 写入前生成并自检详情文件 payload（frontmatter 顺序、任务清单、4 段结构）
4. 按 title 生成描述性 slug（英文 kebab-case），用 reserved-file-prefix 拼成 `changes/chg-yyyymmdd-nn-<slug>.md` 后 Write（详情文件结构见下，slug 规则见下方「文件名 slug」段）
5. Read + Edit `task.md` 添加索引行（task.md 是唯一 CHG 索引；新行插在活跃区末尾、`<!-- ARCHIVE -->` 之前——与下方「索引插入契约」一致；不要插到活跃区顶部）
6. 基于 payload + Edit 成功 + hook 反馈做低成本验证；验证只依据这三项信号即可，仅当 hook 报告本次目标问题时才重新 Read 详情文件或索引文件

资源约束（本操作只触达详情文件与 `task.md` 一个索引）：
- 读取范围限于上述目标文件，`walkthrough.md` / `findings.md` / `corrections.md` 与 `~/.claude` 均不在本操作范围内
- 报告中的体量描述基于已掌握的 payload，无需运行 `wc` / `du` 统计大小或行数

## CHG-ID 分配（hook reservation + 二次防御）

并发派多 agent 时，编号唯一来源是 hook 预留：主 session 先运行 hook/skill 提供的 `reserve-artifact-id.js --operation create-chg` 绝对路径命令，原子预留 `CHG-YYYYMMDD-NN` 或 `HOTFIX-YYYYMMDD-NN`，再把 helper 输出的 `reserved-id` / `reserved-file-prefix` 原样写进 Agent prompt。artifact-writer 始终使用 prompt 中的 hook 预留编号（`reserved-id` 是 nn 的权威来源）。

二次防御：

1. 若 prompt 已包含 helper 或 hook deny 文案给出的 `reserved-id` / `reserved-file-prefix`：直接使用该编号与文件路径。
2. 若缺少 reserved 信息：报告 `hook-deny` 并停止，由主 session 重新预留后再派遣 artifact-writer（新建 `changes/chg-*.md` / `changes/hotfix-*.md` 始终以 reserved 信息为前提）。
3. 写入目标文件已存在 → 报告 `file-conflict` 并停止，由主 session 重新派遣；已有详情保持原样（Write 仅用于尚不存在的预留文件）。

## 文件名 slug（对称 finding/correction）

`reserved-file-prefix` 由 helper 原样输出，形如 `changes/chg-yyyymmdd-nn-<slug>.md`（含字面 `<slug>.md` 占位，与上方 prompt 字段说明一致）。你按 title 生成英文 kebab-case slug（中文 title 语义概括为英文）替换 `<slug>`，得到 `changes/chg-yyyymmdd-nn-<slug>.md` 作为详情文件名。CHG ID 由文件名唯一承载。task.md 索引行与 walkthrough.md 的 wikilink 用**文件名全名 + `|` 纯 ID 别名**：`[[chg-yyyymmdd-nn-<slug>|chg-yyyymmdd-nn]]`（HOTFIX 别名大写 `HOTFIX-YYYYMMDD-NN` 或小写均可；Obsidian 按文件名解析 wikilink，写全名才能解析到详情文件）。无 slug 文件（`chg-yyyymmdd-nn.md`）的索引行直接用 `[[chg-yyyymmdd-nn]]`。

## 详情文件结构

```markdown
---
[frontmatter, 见 spec §2.1]
---

# <title>

## 任务清单

- [ ] T-NNN <task description>
- [ ] T-NNN <task description>

## 实施详情

**背景（Why）**：<background>

**范围（What）**：<scope>

**技术决策（How）**：<technical-decision>

（各任务的实施说明在收口时由 `close-chg implementation-notes` 字段写入，中途可用 `update-chg section=implementation` append；create 阶段任务未实施，不在此预填占位符。）

## 工作记录

| 日期 | 完成内容 |
| --- | --- |

## 关联调研

- [[<related-finding>]] <关联说明>（如有）
```

## 任务 ID 与索引行

`T-NNN` 是 **当前 CHG/HOTFIX 内的局部任务 ID**，不是全项目全局 ID。不同 CHG 都可以有 `T-001`，后续操作必须同时带 `target: CHG-...` 与 `task-id: T-...` 消除歧义。主 session 不需要为新 CHG 预分配 T-ID。

```
- [ ] [[chg-yyyymmdd-nn-<slug>|chg-yyyymmdd-nn]] <title> #change [tasks:: T-NNN~T-NNN] [worktree:: <name>] [branch:: <branch>]
```

### 索引插入契约

目标输出是：每条 CHG/HOTFIX 索引独占一行，且该行从行首 `- [` 开始，位于说明注释之后、`<!-- ARCHIVE -->` 之前。

**插入锚点永远是 `<!-- ARCHIVE -->` 标记本身（插在它前面），绝不是任何已有索引行。** 即使活跃区当前为空、且 `<!-- ARCHIVE -->` 下方已有归档条目（`[x]` / `[-]`），新索引也必须插到 `<!-- ARCHIVE -->` **之前**的活跃区——绝不能插到第一个归档条目之前（那会落进归档区，新 CHG 会被当作已归档）。因此 Edit 的 `old_string` 必须把 `<!-- ARCHIVE -->` 这一行包含进来作为锚点，而不是去匹配某条已有索引行。batch 创建多块时同理：每个块的索引都要插在 `<!-- ARCHIVE -->` 之前。

<example>
Read 到的空活跃区：

```markdown
<!-- 详情与任务清单位于 changes/<id>.md；本文件只保留索引。 -->


<!-- ARCHIVE -->
```

Edit 使用的替换片段：

```text
old_string:


<!-- ARCHIVE -->

new_string:

- [ ] [[chg-yyyymmdd-nn-<slug>|chg-yyyymmdd-nn]] <title> #change [tasks:: T-001~T-001] [worktree:: main] [branch:: main]

<!-- ARCHIVE -->
```

替换后的目标片段：

```markdown
<!-- 详情与任务清单位于 changes/<id>.md；本文件只保留索引。 -->

- [ ] [[chg-yyyymmdd-nn-<slug>|chg-yyyymmdd-nn]] <title> #change [tasks:: T-001~T-001] [worktree:: main] [branch:: main]

<!-- ARCHIVE -->
```
</example>

写入前自检 `new_string`：如果 `old_string` 以换行开头，`new_string` 也保留一个前导换行，使新增索引行与上一行注释、标题或正文之间保留空行隔开。验证"跨索引一致性"时，按行首格式 `^- \[[ x/!-]\] \[\[(chg|hotfix)-YYYYMMDD-NN\]\]` 逐行匹配（以行首 checkbox + wikilink 的完整格式为准）。

刚创建的 CHG 默认状态 `[ ]`（planned），详情文件 **不包含** `<!-- APPROVED -->` 标记。

若 prompt 包含 `execution-context`，task.md 的索引行必须保留其中的 `[worktree:: ...] [branch:: ...]` 字段，方便多 worktree 并发时人读区分。artifact 索引只写 `[worktree:: ...] [branch:: ...]` 这类人读上下文；session id、lock、owner state 等运行态只写 `.pace/`。

## batch 模式（一次创建多个 CHG）

主 session 可一次创建一个变更集（change-set）的 N 个可闭环 CHG（batch create CHG）。触发信号：prompt 含 `change-set` + `change-set-total` 头部字段，且用 `--- CHG i/N ---` 分隔的 N 个块，每块含独立的 `reserved-id` / `title` / `tasks`。

输入格式：

```text
artifact_dir: <hook 解析出的 artifact 目录>
operation: create-chg
change-set: <变更集名>
change-set-total: <N，必须等于块数>
--- CHG 1/N ---
reserved-id: <第 1 个 reserved-id（reserve --count N 输出）>
title: <第 1 个 CHG 标题>
tasks:
  - T-001: <任务与验收>
--- CHG 2/N ---
reserved-id: <第 2 个 reserved-id>
title: <第 2 个 CHG 标题>
tasks:
  - T-001: <任务与验收>
（重复到第 N 块）
```

处理规范：

1. 逐块独立执行单 CHG 创建流程：每块按该块 title 生成 slug 写 `changes/<id>-<slug>.md`（索引 wikilink 用全名 + `|` 纯 ID 别名，见「文件名 slug」段），frontmatter 把恒在的 `change-set: null` + `change-set-seq: null` 改为 `change-set: <变更集名>` + `change-set-seq: i/N`（i 取自该块 `--- CHG i/N ---` 标记；两 key 恒在，只改值不插行）；再写 task.md 一行活跃区索引（**每个块的索引都插在 `<!-- ARCHIVE -->` 之前**，见上方「索引插入契约」）。
2. `change-set-total` 只是 prompt 字段，用于校验块数，**不写入 frontmatter**；写入 frontmatter 的是 `change-set` + `change-set-seq`（两者均为 §2.1 可空字段，仅 batch 成员写入）。
3. 全部块成功才报告 `SUCCESS`；中途某块失败 → 报告已成功建了哪些 CHG、失败在第几块及原因，未消费的 reserved-id 保留，由主 session 修正后重派剩余块（已建好的不重复创建）。
4. hook（`agent-lifecycle-guard`）已对 batch 做确定性前置校验：缺块 / 某块缺 reserved-id·title·tasks / 块数与 `change-set-total` 不符 / 缺 `change-set` / reserved-id 与 hook 预留不匹配，都会在派遣前 DENY；agent 收到的 batch prompt 已通过结构校验。
5. 执行模型不变：batch 只是一次性把 N 个 CHG 落为 `planned` artifact，持久化整组规划；批准与执行仍逐个 `approve-and-start`（A2）。

## 边界

- 缺 `title` 或 `title` 为空 → `missing-fields: title`（`title` 只取自 prompt 显式字段）
- 缺 `tasks` 或 `tasks` 为空 → `missing-fields: tasks`
- `$ARTIFACT_DIR/changes` 不存在 → `not-pace-project`

PACE 流程后续：
- 若用户批准并准备开始 → 主 session 优先调用 `update-chg action=approve-and-start approval-confirmed:true approval-source:<source> approval-evidence:<evidence> task-id:T-NNN`
- 若用户只批准但暂不执行 → 才调用 `update-chg action=approve approval-confirmed:true approval-source:<source> approval-evidence:<evidence>` 添加 `<!-- APPROVED -->`
- 实施推进 → 连续执行时由主 session 写代码、运行验证，验证通过后优先 `close-chg complete-open-tasks:true` 收口；`update-chg action=update-status` 仅用于暂停、阻塞、跳过、跨 session 或暂不验证（详见 update-chg 规范）
