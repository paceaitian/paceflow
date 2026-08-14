# Superpowers 集成详情

> 本文件是 pace-workflow 的 Superpowers 集成参考。详细 brainstorming 流程、执行策略对比和开发方法。

---

## P 阶段：Brainstorming 详细流程

invoke `superpowers:brainstorming` 完整 6 步：

1. **探索项目上下文** — 扫描代码库结构和关键文件
2. **提问澄清需求** — 向用户确认模糊需求
3. **提出 2-3 方案** — 含 trade-offs 对比分析
4. **逐段展示设计** — 分模块讲解设计决策
5. **写设计文档** — `docs/plans/YYYY-MM-DD-<topic>-design.md` + git commit
6. **自动写计划** — invoke `superpowers:writing-plans` → `docs/plans/YYYY-MM-DD-<feature>.md`

### 搜索资源优先级

1. **Context7 MCP**：库/框架官方文档（优先，不消耗配额）
2. **互联网搜索**：通用问题、Stack Overflow、博客
3. **GitHub Issues/Discussions**：特定库的已知问题

---

## E 阶段：执行策略详细对比

### Step 1 — Worktree 隔离（推荐）

`EnterWorktree` 创建隔离分支。PACEflow 在 worktree 中完全可用（`resolveProjectCwd` 使用 `CLAUDE_PROJECT_DIR` 定位项目根，vault artifacts 正常访问）。

降级条件（不使用 worktree）：HOTFIX / 单文件修改 / 用户指定不用。

### Step 2 — 选择执行方式

| 条件 | 执行 skill | 说明 |
|------|-----------|------|
| task 有依赖 / 高风险 / 核心模块 | `superpowers:executing-plans` | 每 3 task 停下等人工反馈 |
| 独立 task + 不同 domain | `superpowers:dispatching-parallel-agents` | 多 agent 真并行 |
| 独立 task + 同 domain（**默认**） | `superpowers:subagent-driven-development` | 自动 Spec + Code Quality 双审 |
| 降级（HOTFIX / 简单任务） | 直接执行 | 不使用 Superpowers |

### Step 3 — TDD 开发方法（推荐）

invoke `superpowers:test-driven-development` — 写失败测试 → 确认失败 → 写最小实现 → 确认通过 → commit。

降级条件：HOTFIX / UI 样式改动 / 无测试框架。

### Step 4 — 收尾

invoke `superpowers:finishing-a-development-branch` — 验证测试 → 选择 merge/PR/keep/discard。

---

## E 阶段：纠偏触发条件示例

以下情况应走纠偏流程（暂停 → 诊断 → 修正 → 重新批准 → 恢复）：

- 选定的技术方案不可行（如 API 不支持预期功能）
- 架构决策错误导致后续多个任务需要重写
- 发现关键依赖冲突影响整体方案

以下情况**不需要**纠偏，直接调整：

- 修改单个任务的实现方式
- 补充遗漏的步骤
- 调整实现细节不影响整体架构

---

## V 阶段：验证分级

| 类别 | 要求 | 示例 |
|------|------|------|
| **必须测试** | 自动化测试 | API 端点、数据处理函数、安全逻辑 |
| **建议测试** | 自动化或手动 | 业务逻辑函数、工具函数 |
| **可选测试** | 手动验证即可 | UI 组件、一次性脚本 |

验证替代：无测试框架时通过 Terminal/Browser 手动验证。通过后优先派 `artifact-writer close-chg verification-confirmed=true complete-open-tasks=true` 记录验证摘要并归档；若暂不归档，才派 `update-chg action=verify`。

---

## R 阶段：对抗审计

V 通过后、close 之前，主 session 对本 CHG 的 diff 做一次**对抗审计**，把"审计这步跑过了"连同验证、归档一起记录。R 与 V 同构平行：标志 `reviewed-date` ↔ `verified-date`、`<!-- REVIEWED -->` ↔ `<!-- VERIFIED -->`（REVIEWED 紧邻 VERIFIED 下一行）、`review-confirmed` ↔ `verification-confirmed`、`action=review` ↔ `action=verify`。

**定位（铁律）**：R 只强制"审计发生 + 记录"，**从不裁决代码质量**。完整七条对抗审计方法论（独立发现 / 证据优先级 / 报告全部再验证 / 三件武器 / 严重度纪律 / 误报防御 / 记录基线）见同目录 `review-methodology.md`。

| 维度 | 要求 | 说明 |
|------|------|------|
| **审计棱镜** | 按 diff 内容自选，不固化"标准 agent" | 改控制流/边界/正则/状态机 → 逻辑正确性 + 路径追踪棱镜；改多处需对齐文件 → 一致性 + 实际 diff 棱镜；改对外契约/配置/安全 → 协议合规 + 鲁棒性棱镜；琐碎低风险 → 主 session 自己瞄一眼（`review-source: manual`） |
| **派发方式** | 审计报告未返回、findings 未路由前**不收尾本轮** | 宿主 v2.1.232 起 Agent 默认 background：能同步就同步（`run_in_background: false`）；只能 background 时必须等报告返回并路由完 findings 再收尾——R 阶段 Stop 不兜底（`running` + 后台任务在跑会软放行），全靠本约束 |
| **修前复核** | 路由 finding 到「修」前，主 session 独立复核为真 | review 报告是待评估建议、非命令；用三件武器（最小复现 / 路径追踪 / 设计意图）复核，复核不下来就不修（降级 / record-finding / won't-fix）；subagent Phase 2 不替代，与 `receiving-code-review` 一致 |
| **findings 路由** | 按 severity 分流，**不阻断 close** | P0/P1 → 复核为真后开 HOTFIX（`create-chg --type hotfix`）修，或判定不修则记 won't-fix（`record-finding`）；P2/P3 → 派 `record-finding` 进 backlog |
| **迭代闸** | 审计 findings 生出的 HOTFIX 默认不自动重审（深度=1） | 防止"审计→修→再审→再修"无止境递归 |

审计完成后优先派 `artifact-writer close-chg verification-confirmed=true complete-open-tasks=true review-confirmed=true review-source=<source> review-findings=<P0/P1/P2/P3 计数+处置>` 一把梭折叠 VERIFIED + REVIEWED + 归档；只想记录审计暂不归档时，才派 `update-chg action=review`。**阻断-on-步骤、不阻断-on-结论**：close 前必须"审计跑过并记录处置"，但绝不要求"P0/P1 修完"才让 close。

---

## Hook 强制行为汇总

| 阶段 | Hook | 行为 |
|------|------|------|
| A | PreToolUse | 无活跃 `[[chg-*]]` / `[[hotfix-*]]` 索引和详情文件 → **deny** |
| C | PreToolUse | 详情文件无 `<!-- APPROVED -->` 或状态不可执行 → **deny** |
| E | PreToolUse | 项目外文件豁免 PACE 检查 |
| V | Stop | `status: completed` 但缺 `verified-date` / `<!-- VERIFIED -->` → **block** |
| V | Stop | 已 verified 但仍在活跃索引中 → **block**，优先要求 `close-chg`；`archive-chg` 仅用于已 verified 的单独归档修复 |
| R | Stop | 已 verified 但未 reviewed（缺 `reviewed-date` / `<!-- REVIEWED -->`） → **block**（warning 级软门，连阻数次后自动降级放行），要求先跑 R 阶段对抗审计并记录 |
