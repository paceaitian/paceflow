# PACEflow v7.2.21 参考手册

> 最后更新：2026-06-20
> 协议：PACE (Plan-Artifact-Check-Execute-Verify-Review)
> 兼容性：不兼容 v5 活跃流程；v5 内容只作为 ARCHIVE 历史。

---

## 1. 权威入口

| 范围 | 权威文件 |
|------|----------|
| Marketplace 入口 | `.claude-plugin/marketplace.json`，`source` 指向 `./plugin` |
| 用户安装 | `plugin/.claude-plugin/plugin.json` + `plugin/hooks/hooks.json`，通过 Claude Code `/plugin install` |
| Artifact 写入 | `plugin/agents/artifact-writer.md` |
| Artifact schema | `plugin/agent-references/artifact-writer-spec.md` |
| Agent 操作步骤 | `plugin/agent-references/instructions/*.md` |
| Hook 运行逻辑 | `plugin/hooks/*.js` + `plugin/hooks/pre-tool-use/*.js` + `plugin/hooks/pace-utils.js` |
| 仓库维护入口 | `CLAUDE.md`（不承载 PACEflow 用户工作流规范） |
| 用户 Skill 规则 | `plugin/skills/*/SKILL.md` |
| 内部审计资料 | `internal/skills/audit/` |
| v6 迁移 guidebook | `docs/paceflow-v6-guidebook.md` |
| v6→v7 升级指引（顺序铁律 / 锁死恢复 / migrate-v7 用法） | `README.md` §「v6 用户升级到 v7」 |

`install.js` / `verify.js` 只允许作为本地 smoke/健康检查工具，不是正式安装路径；对应本地测试文件 `tests/test-install.js` 也不属于 tracked release gate。

---

## 1.1 Project Root / Artifact Root / CWD

PACEflow 的运行边界使用以下术语：

| 名称 | 含义 |
|------|------|
| Current CWD | Claude Code 当前打开目录，可能是 Project Root，也可能是其子目录 |
| Project Root | PACEflow 管理的项目边界；`.pace` 运行态、CHG owner、Stop 检查和 `local` artifact root 归属这里 |
| Artifact Root | `spec.md / task.md / walkthrough.md / findings.md / corrections.md / changes/**` 的存放目录 |

普通子目录默认继承最近的父级 PACEflow Project Root。真实 git worktree 仍共享宿主 Project Root。只有当前子目录确实是独立项目时，运行：

```bash
node "<plugin>/hooks/set-project-root.js" --mode independent
```

再运行 `set-artifact-root.js --choice local|vault` 选择该子项目自己的 Artifact Root。

---

## 2. 文件结构

```text
projects/<project>/
├── spec.md
├── task.md
├── walkthrough.md
├── findings.md
├── corrections.md
└── changes/
    ├── chg-yyyymmdd-nn.md
    ├── hotfix-yyyymmdd-nn.md
    ├── findings/finding-yyyy-mm-dd-slug.md
    └── corrections/correction-yyyy-mm-dd-nn-slug.md
```

索引文件只保留摘要/wikilink 行。所有 CHG/HOTFIX/finding/correction 详情都写在 `changes/**`。

---

## 3. Agent 操作

| 操作 | 用途 |
|------|------|
| `create-chg` | 创建 `changes/<id>.md`，同步 `task.md` 索引 |
| `update-chg action=approve` | C 阶段批准，写 `<!-- APPROVED -->` |
| `update-chg action=approve-and-start` | 用户已批准后插入 `APPROVED`、标记首个 T-NNN `[/]`、推 `in-progress` |
| `update-chg action=update-status` | 更新 T-NNN 状态，联动 frontmatter 与根索引 |
| `update-chg action=append/replace` | 更新实施详情、工作记录、关联调研 |
| `update-chg action=verify` | V 阶段验证，写 `verified-date` + `<!-- VERIFIED -->` |
| `update-chg action=review` | R 阶段记录审计：写 `reviewed-date` + `<!-- REVIEWED -->` + `## 审查记录`，暂不归档（对标 `action=verify`） |
| `archive-chg` | 归档已 verified CHG/HOTFIX |
| `close-chg` | 验证确认后合并完成、折叠 VERIFIED + REVIEWED + 归档与 walkthrough |
| `record-finding` | 写 `changes/findings/<id>.md` + `findings.md` 摘要索引 |
| `update-finding` | 改已记录 finding 状态（如改判 won't-fix：`status: rejected` + `rejection-reason`） |
| `record-correction` | 写 `changes/corrections/<id>.md` + `corrections.md` 摘要索引 |
| `update-index` | 重排索引（`findings.md`/`corrections.md` 活跃区按日期降序新→旧，`action=reorder`） |

主 session 禁止直接写 `APPROVED`、`VERIFIED`、`verified-date`、`REVIEWED`、`reviewed-date`，也禁止在索引文件（`task.md`）中写内嵌详情。

## 3.1 batch create CHG（变更集批量创建）

一个完整变更常天然拆成多个可独立验证 / 回滚 / 关闭的闭环 CHG（如 Phase 1-N）。batch create 把这些 CHG 的规划**一次性持久化为 artifact**，不依赖单一 session 存活——避免后续阶段规划只留在 session 上下文、compact 或中断即丢失。采用中间路径：复用现有 CHG artifact，frontmatter 加两个 nullable 字段标记其所属变更集，不引入独立 epic artifact。

**change-set frontmatter（仅 batch 成员非 null）**

| 字段 | 含义 | 单建 CHG | batch 成员 |
|------|------|----------|-----------|
| `change-set` | 变更集名（同一批共享） | `null` | 如 `review-gate` |
| `change-set-seq` | 本 CHG 在集内序号 `i/N` | `null` | 如 `2/4` |

**Step 1 — 批量预留连号**

```bash
node "<hooks>/reserve-artifact-id.js" --operation create-chg --count N
```

同锁取 N 个连续编号（counter 一次推进到 `first+N-1`），输出 N 个 `# --- reserved i/N ---` 块。`--count` 严格 `^\d+$`、范围 `1..MAX_RESERVE_COUNT`（=20）、`count>1` 仅允许 `create-chg`（非法值 / correction 批量等 fail-closed）。

**Step 2 — batch create prompt（共享头部 + N 块）**

```text
artifact_dir: <artifact 目录>
operation: create-chg
change-set: <变更集名>
change-set-total: <N，必须等于下面 CHG 块数>
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
（重复到第 N 块）
```

artifact-writer 逐块建 N 个 `changes/<id>.md`（各写 `change-set` + `change-set-seq: i/N`）+ N 行活跃区索引。

**确定性前置校验（`agent-lifecycle-guard.js`）**：派遣前对 batch prompt 做硬校验，任一不符即 **DENY**（不靠 agent 自觉）——

- 缺 `change-set` 头部 / 块数 ≠ `change-set-total`；
- 某块缺 `reserved-id` / `title` / `tasks`（`blockFieldValue` 同行匹配，防空字段把下一行吞进去）；
- 块内 `reserved-id` 与实际预留不匹配 / 重复 id。

**索引强制锚点**：新索引行恒插入 `<!-- ARCHIVE -->` **上方**活跃区，绝不插到下方。活跃 CHG 全归档后活跃区为空时尤易踩此错位；`findActiveIndexBelowArchive` 确定性检测，post-tool-use 编辑后告警。

**追踪层**

| Hook | batch 行为 |
|------|-----------|
| `session-start.js` | 按 `change-set` 聚合活跃 CHG，注入 `=== change-set 整体进度 ===`（已完成 = N − 未完成成员数） |
| `stop.js` | 变更集尚有未执行 planned 成员时发**不阻断**软提醒（仅 `warnings.length === 0` 时经 `emitAllowedStopReminders` 发出），提示逐个 `approve-and-start` 续接、勿遗漏后续阶段 |

**执行模型（A2）**：batch create 只一次性落地**规划**；执行仍逐个 `approve-and-start`，不自动开工后续阶段，与单 CHG 生命周期一致。

---

## 4. 状态机

| frontmatter status | verified-date | VERIFIED | reviewed-date | REVIEWED | 索引位置 / Stop |
|---|---|---|---|---|---|
| `planned` | null | 缺 | null | 缺 | 活跃区 `[ ]` |
| `in-progress` | null | 缺 | null | 缺 | 活跃区 `[/]` |
| `completed` | null | 缺 | null | 缺 | 活跃区 `[x]`，Stop 拦「未验证」 |
| `completed` | 非 null | 有 | null | 缺 | 活跃区 `[x]`，Stop 拦「**未审计**」（新增状态） |
| `completed` | 非 null | 有 | 非 null | 有 | 活跃区 `[x]`，待 `close-chg` / `archive-chg` |
| `archived` | 非 null | 有 | 非 null | 有 | ARCHIVE 下方 `[x]` |
| `cancelled` | null | 缺 | null | 缺 | ARCHIVE 下方 `[-]` |

`verified-date` 是机器权威；`<!-- VERIFIED -->` 是人读/hook 信号。两者必须一致。`reviewed-date` 是机器权威、`<!-- REVIEWED -->` 是人读/hook 信号，两者一致；REVIEWED 与 VERIFIED 同构，只证「审计步骤执行+记录」，不裁决代码质量。

> **升级行为注**：升级到含 review gate 的版本后，已存在的「`completed` + verified 但未 reviewed」活跃 CHG 会落进上表新增的「未审计」状态。下次 `stop.js` 触发时会以 warning 提醒补一次审计并派 `update-chg action=review` 或 `close-chg` 写入 REVIEWED。这是 warning 级软门，连阻 3 次后由全局 `stop-block-count` counter 自动降级放行，不会永久阻塞会话。

---

## 5. Hook 覆盖

| Hook | 职责 |
|------|---------|
| `session-start.js` | 创建/注入索引模板，输出活跃 CHG 摘要 |
| `pre-tool-use.js` | 写代码、运行 Bash/PowerShell/Monitor 命令或派 artifact-writer 前，检查活跃 CHG、详情文件、APPROVED、可执行状态，并阻止直接写 artifact / `.pace` 控制面 |
| `post-tool-use.js` | schema/wikilink/直接 C-V 写入/correction knowledge 提醒；verified 未 reviewed 时 `review-missing` 软提醒 |
| `post-tool-use-failure.js` | 写入/验证工具失败后提醒不要误判完成 |
| `subagent-stop.js` | 观察 `artifact-writer` 报告标题/状态并记录 transcript |
| `stop.js` | 阻止未完成、未 verified、verified 未归档、索引不一致；阻止「completed+verified 但未 reviewed」（未审计）退出；CC v2.1.145+ 提供 `background_tasks` 时后台任务运行场景放行（详见下方） |
| `task-list-sync.js` | legacy 兼容 observer；当前插件不注册任务面板 hook，PACE 权威仍是 `changes/<id>.md` |
| `pre-compact.js` | native plan 兜底检测（落 current-native-plan 供 SessionStart 桥接消费）；快照机制已退役 |
| `stop-failure.js` | API 错误中断日志 |
| `session-end.js` | session 正常结束时把本 session 持有的 CHG owner 降级 detached + 清除 session 级 pause 标志 |

Helper 脚本不是 hook 事件，但属于发布运行时入口：

| Helper | 用途 |
|--------|------|
| `reserve-artifact-id.js` | 原子预留 CHG/HOTFIX/CORRECTION 编号 |
| `set-artifact-root.js` | 写入 Project Root runtime 的 artifact-root 选择 |
| `set-project-root.js` | 将当前 cwd 声明为独立 Project Root |
| `sync-plan.js` | pace-bridge 成功后记录已桥接 plan |
| `print-session-context.js` | 查看 SessionStart 实际注入内容（startup / `--compact`；设 `PACE_PRINT_ONLY` 隔离 .pace 写盘，只读预览） |
| `set-activation.js` | enable / disable / pause / resume / status 激活状态切换（用户命令唯一写入路径）|

Helper 成功返回 exit code 0；业务校验失败返回 exit code 2 并在 stdout 给出可读修复信息。Hook 脚本自身通常以容错为主，除 PreToolUse/Stop 的明确阻断外，不把内部错误升级为 shell 崩溃。

REVIEWED 门是 `stop.js` 的 Stop hook 门、不是 PreToolUse 门，因此不进 §5.1 的 PreToolUse 档位表。它在 teammate 模式跟随 `stop.js` 现有的「teammate 全门 exit 0」放行，与 verify 门同（未审计提醒与未验证提醒同属一组 warning，teammate 下一并软化）。

`stop.js` 的后台任务放行：Claude Code v2.1.145+ 在 Stop 输入提供 `background_tasks` 时，PACEflow 把「running CHG 仍有未完成 T-NNN，但后台 Workflow/subagent/team/shell 任务仍在运行」的场景视为主 session 暂停等待后台结果，放行 Stop 并显示可见提醒；结构损坏、未验证、待归档仍照常阻断。与 README「CHG 生命周期与 Deferred」一致，避免读本节形成「有未完成任务一律阻断」的错误心智模型。

## 5.1 PreToolUse 拒绝档位与 teammate 降级

PreToolUse 的拒绝分三档。**teammate 模式（`CLAUDE_CODE_TEAM_NAME` 非空）只软化第一档**，另两档不降级。

| 档位 | 实现 | 正常模式 | teammate 模式 | 典型守卫 |
|------|------|----------|---------------|---------|
| 流程引导类 | `emitDeny` + 表 `teammateMode: 'soft'` | deny | **降级为 additionalContext（放行+提示）** | artifact-root 选择、native plan 桥接、强信号/code-count 引导 |
| 批准/完整性类 | `emitDeny` + 表 `teammateMode: 'hard-note'` | deny | **仍 deny（不降级）+ 回报主 session 引导** | C 阶段批准门、E 阶段就绪门、无活跃 CHG、索引完整性两门（malformed / detail-missing）|
| 完整性/安全类 | `emitDeny` + 表 `teammateMode: 'hard'`（`hardDeny` 薄包装 / 全局 catch raw）| deny | **仍 deny（不降级）** | marker 伪造（APPROVED/VERIFIED）、runtime-control 删锁、改 `.pace` 控制面、直接 Write/Edit artifact、bad stdin/tool、ID 预留、status 校验、change-owner 隔离 |

> **实现（v7.2.5+）**：三档统一经 `emitDeny(action, reason, fields)` 单出口，档位由模块级 `DENY_REASONS` 表的 `teammateMode`（`soft` / `hard-note` / `hard`）决定；逃生口 / artifact-dir 提示富化由表的 `escapeHatch` / `dirHint` 控制。新增 deny 分支必须在 `DENY_REASONS` 登记 action（未登记 `emitDeny` fail-fast 抛错）。`hardDeny` 改为 `emitDeny` 薄包装、保留原调用点；`denyOrHint` 函数已删除。

**设计定位：teammate = 纯执行者。** 主 session 负责任务编排与更新（批准、建/归档 CHG、改任务状态），teammate 只在主 session 已批准的 CHG 范围内执行（写代码、跑测试、调研）。根本理由：artifact 状态必须有单一权威源，否则多个独立 teammate session 并发改 artifact 会让任务状态失去一致视图，无法维护上下文。

在此定位下，「无阻断」与「遵循规则」自动统一：teammate 跟随已批准 CHG 执行时所有写代码门天然通过（无阻断）；一旦在未批准 / 无活跃 CHG / 索引损坏时写代码，或试图碰任务管理、runtime，则硬阻断（遵循规则）。流程引导类（artifact-root 选择、迁移、桥接）保持软化，因为它们需主 session 与用户交互完成，硬拦会死锁 teammate。

**日志 action 的 `_TEAMMATE` 后缀 ≠ 被降级。** marker 伪造、runtime-control 等带 `_TEAMMATE` 后缀但走 `hardDeny`，teammate 下仍硬阻断——后缀只标记"在 teammate 进程触发"，不代表软化。

**teammate ≠ subagent。** subagent（Task / Agent 工具）在主进程内执行、结果回流主 session、共享主 session 上下文、不独立触发 PACE owner；teammate 是独立平级 session，有自己的 session_id。调研 fan-out 这类「给结果就好、回流主 session」的场景应用 subagent，不用 teammate。

---

## 6. 安装

在 Claude Code 中：

```text
/plugin marketplace add paceaitian/paceflow
/plugin install paceflow@paceaitian-paceflow
```

> 需 Claude Code `2.1.139` 或更高版本：hook 注册使用 `2.1.139` 新增的 `hooks[].args` exec form，`2.1.138` 及更早版本不支持该字段，可能只执行 `command: "node"` 而不传脚本路径，导致 hook 静默不运行（最隐蔽的失效模式）。与 README 安装要求同源。

安装后应包含：
- `hooks/`
- `skills/`
- `agents/`
- `.claude-plugin/plugin.json`
- `hooks/hooks.json`

源码仓库中这些运行时资产位于 `plugin/`；安装到 Claude Code cache 后，`plugin/` 目录本身不会作为额外前缀出现。

---

## 7. 验证入口

Hook 单元/E2E（聚合入口，任一子套件失败即整体非零退出）：

```bash
node tests/run-all.js
# 迭代分片：PACE_TEST_FILTER=<套件名子串> node tests/run-all.js
# 发版后核整段 release 区间 whitespace（push 后 @{upstream}..HEAD=0 时显式覆盖 previous-release..HEAD）：
PACE_RELEASE_BASE=<上一个 release commit> node tests/run-all.js
```

Agent contract smoke：

```bash
node tests/agent-tests/run-tests.js dummy
```

语法：

```bash
for f in plugin/hooks/*.js; do node -c "$f" || exit 1; done
```

---

## 8. 发布检查

- `PACE_VERSION` 与 `plugin/.claude-plugin/plugin.json` 均为当前发布版本
- artifact frontmatter `schema-version` 仍为 `"7.0"`；不要随插件 patch 版本滚动
- `.claude-plugin/marketplace.json` 的 `source` 指向 `./plugin`
- `plugin/hooks/templates/` 有 `corrections.md`
- `plugin/hooks/hooks.json` 注册 `StopFailure`
- `plugin/agents/artifact-writer.md` 与 `plugin/agent-references/**` 存在
- README/CLAUDE/skills 不再要求主 session 直接 Edit artifact
- README/CLAUDE/skills/hooks 模板不再出现 v5 活跃详情区、task 承载 C/V 标记、task 任务权威、findings 内 correction 区等旧口径
