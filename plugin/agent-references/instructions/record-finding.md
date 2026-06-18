# record-finding 指令详细规范

> 关联 agent：`artifact-writer.md`
> 上层规范：`../artifact-writer-spec.md`

## When To Use

用于记录调研、观察、对比或 bug-report finding。`body` 是主 session 提供的完整 Markdown 正文，artifact-writer 只做原样写入和索引。

## Correct Prompt Example

```text
artifact_dir: <hook 解析出的 artifact 目录>
operation: record-finding
title: <finding 标题>
summary: <≤200 字摘要>
type: research | observation | comparison | bug-report
impact: P0 | P1 | P2 | P3
body: <完整 Markdown 正文>
```

## 输入字段

- `title`（必填）
- `summary`（必填，≤ 200 字符）
- `type`（必填，枚举：`research` | `observation` | `comparison` | `bug-report`——写入索引行 `[type:: <type>]` meta）
- `impact`（必填，枚举：`P0` | `P1` | `P2` | `P3`）
- `body`（必填，Markdown 内容，含背景/发现/方案/调研来源）
- `related-changes`（可选，wikilink list——写入索引行 `[change::]` meta）
- `merges`（可选，wikilink list——写入索引行 `[merges::]` meta）
- `status`（默认 `open`，可选 `investigating` / `accepted` / `rejected` / `merged` / `blocked`）
- `rejection-reason`（status=rejected 时必填，≥ 10 字符——写入正文末尾「拒绝理由」段）

> frontmatter 只含 `status` / `date` / `schema-version` 三个 key（spec §2.2 封闭合同）；`title`/`summary`/`impact`/`type` 等输入写入索引行（`type` 落 `[type:: <type>]` meta）与正文。

`body` 是 opaque Markdown payload，必须原样写入详情文件：
- body 按主 session 原文逐字符写入，保持段落顺序、代码块、表格、引用块、重复内容完全不变
- 正文中的 wikilink 视为正文文本本身（仅 frontmatter 字段参与 wikilink 强约束）
- 唯一允许的归一化是换行风格（CRLF/LF）
- 只有 body 完整写入后才报告 SUCCESS

## 操作步骤

0. 前置检查：用 `test -d "$ARTIFACT_DIR/changes" && echo EXISTS || echo MISSING` 判断 base changes 目录；`MISSING` 时报告 `not-pace-project` 并停止，不写任何文件（base `changes/` 由项目初始化负责创建）。目录存在性以该 `test -d` 结果为准。
1. 生成 finding-id（FINDING-YYYY-MM-DD-slug，slug 参考 spec slug 规则）
2. `mkdir -p changes/findings/`（仅在 base `changes/` 已存在时）
3. Write `changes/findings/finding-yyyy-mm-dd-slug.md`（详情文件结构见下；`body` 必须使用输入原文）
4. Read + Edit `findings.md`：在活跃区**第一个 finding 索引行之前**插入新索引行（最新在顶，prepend）。活跃区 = 文件头到第一个 `<!-- ARCHIVE -->`；已有 `- [<状态>] [[finding-` 索引行时插到第一个之前，暂无索引行时插到活跃区最后一个标题（`## 未解决问题` 或 `## 摘要索引`）下方。格式见 spec §5.4

## 详情文件结构

```markdown
---
[frontmatter, 见 spec §2.2]
---

# <title>

[body 内容，按主 session 提供]
```

## 索引行

```
- [<checkbox>] [[finding-yyyy-mm-dd-slug|<title>]] — <summary> #finding [date:: YYYY-MM-DD] [impact:: P<N>] [type:: <type>] [<extra-meta>]
```

`<checkbox>` 按 status 映射（spec §4）：
- `open` → `[ ]`
- `investigating` → `[/]`
- `accepted` → `[x]`
- `rejected` / `merged` → `[-]`
- `blocked` → `[!]`

> **finding `[-]` = 已决定不修的追踪记录**（won't-fix / rejected / merged），语义区别于任务状态 `[-]`（跳过）与 CHG 状态 `[-]`（取消）。**记录即 won't-fix**：判定不修的 finding 一落地就传 `status: rejected` + `rejection-reason`，直接落 `[-]`（无需先 open 再 `update-finding`）。`[-]` 不被 SessionStart 注入（注入只取 active `[ ]`），避免已决定不修的技术债污染上下文成噪音。

`<extra-meta>` 可选：
- `[change:: [[chg-yyyymmdd-nn-<slug>|chg-yyyymmdd-nn]]]`（status=accepted 时；带 slug 详情文件用全名+别名，旧无 slug 文件用 `[[chg-id]]`，规则见 spec §5.4）
- `[merges:: [[finding-id]]]`（合并自）
- `[merged-into:: [[finding-id]]]`（被合并到）

## 边界

- summary > 200 字符 → `format-violation`
- body 缺失 → `missing-fields`
- body 被摘要 / 截断 / 改写 / 重排 → `format-violation`
- status=rejected 但缺 rejection-reason 或长度 < 10 → `missing-fields`
- merges 中 wikilink 指向不存在的 finding → 警告但不阻止（建议主 session 检查）
- related-changes 中 wikilink 指向不存在的 CHG → 警告但不阻止（建议主 session 检查）
- `$ARTIFACT_DIR/changes` 不存在 → `not-pace-project`

> **§边界 vs §9 通用验证规则关系**：本节是 lex specialis（特殊条款），优先级高于上层 `../artifact-writer-spec.md` §9 通用 wikilink 强校验。merges / related-changes 字段允许"warn but don't block"，其他字段仍按 §9 通用强校验。

## knowledge 评估信号（报告内附加，给信号不给结论）

写入 finding 详情成功后，在 artifact-writer 报告**末尾**附一个 `### knowledge 评估信号` 子段（报告内 H3，不另起顶层 H2），供主 session 裁决是否沉淀到 `knowledge/`（本 agent 已预加载 `pace-knowledge` skill，按其「Findings → Knowledge 提取 SOP」检索 vault 根 `knowledge/`）：

1. **通用性初判**：基于 `body` 判断该结论跨项目通用（Hook I/O 协议、AI 验证纪律、路径处理等）还是项目特有——一句初判 + 一句依据。
2. **同主题检索**：只读检索 `knowledge/` 列同主题已有笔记（无 vault 路径或检索失败如实说明，不阻塞）。
3. **一句建议**：「建议沉淀 / 已有 [[note]] 可追加 / 项目特有不沉淀」三选一。

**边界（钉死）**：本 agent 只产出**信号**，不做沉淀决策、不写 / 改 `knowledge/` 笔记、不越 CRUD 职责；是否沉淀及沉淀到哪条笔记由主 session 用完整 CHG 上下文裁决。该信号为可选附加，不影响 finding 写入的 SUCCESS 判定（检索失败照常 SUCCESS，信号段注明检索未完成即可）。
