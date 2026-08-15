# update-finding 指令详细规范

> 关联 agent：`artifact-writer.md`
> 上层规范：`../artifact-writer-spec.md`

## When To Use

更新一个**已存在** finding 的状态、追加正文或补关联链接。这是 `record-finding`（创建）之后 finding 流转的对称操作——与 `update-chg` 之于 CHG/HOTFIX 同构。finding 用 date-slug id、无 reservation/counter 约束，状态变化只是改 `findings.md` 索引行 checkbox + 详情 frontmatter，可安全原地 update（无需另建新 finding）。

典型场景：finding 被某 CHG 修复 → `accepted` + `[change::]`；判定不是问题 → `rejected`；正在调查 → `investigating`；补充新证据 → `append` 正文。

## Correct Prompt Example

```text
artifact_dir: <hook 解析出的 artifact 目录>
operation: update-finding
target: FINDING-YYYY-MM-DD-slug      （或 finding-yyyy-mm-dd-slug，大小写不敏感）
status: accepted                     （可选；枚举见下）
change-link: [[chg-yyyymmdd-nn]]     （可选；与 accepted 搭配，表示由该变更处置。写入索引 [change:: ...] 时若目标是带 slug 详情文件，glob changes/chg-yyyymmdd-nn*.md 取 stem 写 [[<stem>|chg-yyyymmdd-nn]]，旧无 slug 文件保持纯 ID）
append: <要追加到详情正文末尾的 Markdown>   （可选，原样追加）
```

## 输入字段

- `target`（必填）：finding-id，解析到 `changes/findings/<slug>.md`
- `status`（可选，枚举：`open` | `investigating` | `accepted` | `rejected` | `merged` | `blocked`；与 record-finding 同一套）
- `rejection-reason`（status=rejected 时必填，≥ 10 字符）
- `change-link`（可选，CHG/HOTFIX wikilink）：写入索引行 `[change:: [[...]]]`，表示该 finding 由此变更处置/修复
- `merged-into`（可选，finding wikilink；status=merged 时写索引行 `[merged-into:: [[...]]]`）
- `append`（可选，Markdown 原文，追加到详情正文末尾）：opaque payload，逐字写入，不摘要 / 截断 / 重排；唯一允许的归一化是换行风格

至少提供 `status` / `change-link` / `append` 之一，否则 `format-violation`（无可更新内容）。

## 操作步骤

0. 前置检查：`test -d "$ARTIFACT_DIR/changes"` → MISSING 报 `not-pace-project`，不写任何文件。
1. 解析 target → `changes/findings/<slug>.md`；文件不存在 → `target-not-found`。
2. Read 详情文件 + `findings.md`。
3. 幂等检查：若 `status` 已等于目标值、且无 `change-link` / `append` / `merged-into` → SUCCESS 幂等（reason: `no change`），不写文件。
4. 若给 `status`：
   - Edit 详情 frontmatter `status: <new>`。
   - Edit `findings.md` 索引行 checkbox（映射见下）。
5. 若给 `change-link`：在 `findings.md` 索引行追加（或更新）`[change:: [[...]]]`。
6. 若给 `merged-into`：在 `findings.md` 索引行追加 `[merged-into:: [[...]]]`。
7. 若给 `append`：把原文追加到详情正文**末尾**（保留原有全部内容，只在末尾追加，不改既有正文）。
8. 报告 SUCCESS，`files_modified` 列出实际改动的文件。

## Batch 模式（一次 dispatch 流转 N 条 finding）

一次 dispatch 更新多条 finding（仪式降本，复刻 record-finding batch 先例——批量 won't-fix / 批量回链场景省去逐条派遣的重复上下文重载）。格式：共享头部 `finding-update-batch-total: N` + N 个 `--- FINDING i/N ---` 块，每块必含 `target`（同批互异，hook 前置校验），且 `status` / `change-link` / `append` 至少其一。

```text
artifact_dir: <hook 解析出的 artifact 目录>
operation: update-finding
finding-update-batch-total: 2
--- FINDING 1/2 ---
target: finding-yyyy-mm-dd-slug-a
status: rejected
rejection-reason: <≥10 字符>
append: <可选，追加到该 finding 详情正文末尾>
--- FINDING 2/2 ---
target: finding-yyyy-mm-dd-slug-b
status: accepted
change-link: [[chg-yyyymmdd-nn]]
```

batch 操作：对每个块按上方「操作步骤」单条流程执行（解析 target → Read → 幂等检查 → Edit 详情与索引），逐块独立完成；某一块 `target-not-found` 或 `format-violation` 时**该块 FAILED、其余块照常执行**——与 create-chg / record-finding batch 的 stop-and-report **不同**（update-finding 无 reserved-id 消费依赖，逐块独立无中断成本）。混合结果整体状态报 `FAILED`，在报告的部分产出段逐块列出已成功的 target，主 session **只重派 FAILED 块**——注意带 `append` 的块不幂等，勿整批重派（重派会把同一段正文追加两次）。

同批 target **字面**互异由 hook 前置校验（trim + 大小写归一；请统一用裸 finding-id 形态，`.md` 后缀或 wikilink 包裹的变体不在归一范围）。块内字段值须与冒号同行（hook 的块解析不跨行取值）；需要多行 `append` 的 finding 走单条 dispatch。块内字段校验（status 枚举 / rejection-reason 长度 / append 原样性）仍按单条规则逐块执行。

## status → checkbox 映射（与 record-finding / spec §4 一致）

- `open` → `[ ]`
- `investigating` → `[/]`
- `accepted` → `[x]`
- `rejected` / `merged` → `[-]`
- `blocked` → `[!]`

`accepted` + `[change:: [[chg]]]` 表示「该 finding 已被某变更处置/修复」（已闭环）；不带 `[change::]` 的 `accepted` 表示「接受为已知限制（won't-fix）」。两者都落 `[x]`，由是否有 `[change::]` 区分。

## 边界

- target 不存在 → `target-not-found`
- 既无 `status` 也无 `change-link` / `append` / `merged-into` → `format-violation`（无可更新内容）
- `status` 不在枚举 → `format-violation`
- status=rejected 缺 rejection-reason 或 < 10 字符 → `missing-fields`
- `append` 被摘要 / 截断 / 改写 / 重排 → `format-violation`
- `change-link` / `merged-into` wikilink 指向不存在的目标 → 警告但不阻止（建议主 session 检查）
- `$ARTIFACT_DIR/changes` 不存在 → `not-pace-project`

> **§边界 vs §9 通用验证规则关系**：本节是 lex specialis，优先级高于上层 `../artifact-writer-spec.md` §9 通用 wikilink 强校验。`change-link` / `merged-into` 允许"warn but don't block"，其他字段仍按 §9 通用强校验。
