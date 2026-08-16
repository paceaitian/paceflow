# PACEflow v7.2.8 Codex 审计：Claude Code 回答核实与未修项理由复核

> 类型：Codex 审计
> 日期：2026-06-15
> 审计对象：`origin/master@f2ef7785e087d49679efb964450f77abcaf5906b`
> 增量区间：`0c47832..f2ef778`（v7.2.7 -> v7.2.8）
> 全量参照区间：`52f3461..f2ef778`（v7.1.0 后发布面）
> 复核目标：严格核实 Claude Code 08:45:48 回答中“做了/做了一部分/没做”的真实性，并重新评估未修项理由是否充分。

## 结论

v7.2.8 tracked 发布态未发现 P0/P1/P2 runtime 阻断。`HEAD == origin/master == f2ef778`。本次发布核心只有两类：

- 1.3 runtime-control 命令守卫去重：`pre-tool-use.js` 抽 `commandLocalArtifactRootChoiceDeny()` 与 `commandProjectRootMarkerDeny()`，signal 路径和 no-signal 兜底路径共用，`pre-tool-use.js` 净减 76 行。
- 2.6 reservation 契约测试：新增 `reservationMatchesArtifactRel()` 直接单测，锁 fail-open 不适用路径、slug/精确两路匹配、真 mismatch。

Claude Code 回答的大方向成立：v7.2.8 确实发布到远端，核心代码改动与测试覆盖成立；组1 也已在 artifact finding 中标记为闭合。

新增审计发现 1 个 P3：

1. **CHG 详情文件存在自相矛盾的历史残留**：`changes/chg-20260615-02...md` 前段 T-001 / Why / How 仍写“区 B 是死代码、删除即可”，但后段 T-001 工作记录、审查记录和 README 均写“首次误删后被 e2e 抓到，最终改抽 helper”。当前代码是正确抽 helper，不是删区 B；残留不影响 runtime，但会误导后续审计。

未修项理由复核：

- **充分**：1.5 commandInput 双别名 reject、1.7 reservation 双实现 reject、2.3 require-cache 注释 reject、2.2 vault-notes defer、2.4/3.4/3.5/1.6 gold-plating reject、foreign-worktree 待产品裁定、agent-tests 真套件休眠、budget head 严格版记 finding。
- **部分充分**：README v7.2.5 hardDeny 计数不改的实质理由成立，但现文案仍容易被机械计数复核者误读；Stop background_tasks 的“需手动探针”对根因精修成立，但当前代码仍只有 `raw.background_tasks` 单字段暴露面，结构性兜底仍未做。
- **仍未修且理由不足以视为关闭**：`PACE_RELEASE_BASE` 能力已实现并通过 dogfood，但 `CLAUDE.md` / `REFERENCE.md` 发布验证入口仍默认 `node tests/run-all.js`，post-push release diff 盲区在文档流程上仍存在。

## 发布验证

远端与工作区：

- `HEAD` 与 `origin/master` 均为 `f2ef7785e087d49679efb964450f77abcaf5906b`。
- 当前 release commit：`release(v7.2.8): 工程卫生——structure-backlog 组1 收尾（1.3 守卫去重 + 2.6 契约锁）（CHG-20260615-02）`。
- 未发现 `v7*` git tag；发布追溯仍依赖 release commit 与 manifest version。
- 测试后无 tracked diff。

增量文件：

- `.claude-plugin/marketplace.json`
- `README.md`
- `REFERENCE.md`
- `plugin/.claude-plugin/plugin.json`
- `plugin/hooks/pace-utils/constants.js`
- `plugin/hooks/pre-tool-use.js`
- `tests/test-pace-utils.js`

增量统计：

- 总计：7 files changed, 61 insertions(+), 119 deletions(-)
- `plugin/hooks/pre-tool-use.js`：38 insertions / 114 deletions，净减 76 行。
- `tests/test-pace-utils.js`：17 insertions。

版本面：

- `.claude-plugin/marketplace.json` version = `7.2.8`
- `plugin/.claude-plugin/plugin.json` version = `7.2.8`
- `plugin/hooks/pace-utils/constants.js` `PACE_VERSION = 'v7.2.8'`
- `REFERENCE.md` 标题为 `PACEflow v7.2.8 参考手册`
- `README.md` 版本历史新增 v7.2.8 行，页脚版本为 v7.2.8

自动与静态验证：

- `PACE_RELEASE_BASE=0c47832 node tests/run-all.js`：8/8 PASS
  - `test-pace-utils`：293/293
  - `test-hooks-e2e`：438/438
  - `test-session-layers`：48/48
  - `test-migrate-v7`：16/16
  - `test-agent-tests-helpers`：11/11
  - `test-run-all`：6/6
  - `claude plugin validate ./plugin`：PASS
  - `git-diff-check`：PASS
- `find plugin tests -name '*.js' -print0 | xargs -0 -n 1 node --check`：PASS
- `node tests/agent-tests/run-tests.js dummy`：PASS
- `bash -n tests/agent-tests/run-agent-cli-suite.sh`：PASS
- `git diff --check 0c47832..HEAD`：PASS
- `git diff --check 52f3461..HEAD`：PASS
- `git diff --check HEAD^..HEAD`：PASS
- require-cache env reload 探针：`PACE_VAULT_PATH` A -> B -> unset 后重新 `require('./plugin/hooks/pace-utils')` 均读到新值，PASS。

## v7.2.8 核心改动复核

### 1.3 runtime-control 守卫去重

状态：正确修复，未发现行为漂移。

当前实现：

- helper 定义在 `pre-tool-use.js`：
  - `commandLocalArtifactRootChoiceDeny(toolName, bashCommand, powershellCommand, cwd)`
  - `commandProjectRootMarkerDeny(toolName, bashCommand, powershellCommand, cwd)`
- helper 内部顺序保持 `Bash -> PowerShell -> Monitor`。
- local artifact-root choice 仍先于 project-root marker。
- helper 只返回 `{reason, action, fields}` 或 `null`，由主闭包调用 `hardDeny()`，这个选择合理，因为 `hardDeny` 依赖主函数局部上下文。
- 两个调用点都存在：
  - signal 路径：`paceEntrySignal` 块内命令分支前。
  - no-signal 兜底路径：文件工具守卫之后、artifact runtime-control 文件守卫之前。

关键验证：

- `test-hooks-e2e` 中 `9hc-helper4b`、`9hc-helper4d` 均通过，覆盖 no-signal 兜底路径。
- `DENY_BASH/POWERSHELL/MONITOR_LOCAL_ARTIFACT_ROOT_CHOICE` 与 `DENY_BASH/POWERSHELL/MONITOR_PROJECT_ROOT_MARKER` 仍在 `DENY_REASONS` 表与结构测试中。
- 6 个底层命令谓词全仓只剩 import + helper 内使用，无重复内联块残留。

### 2.6 reservation fail-open 护栏

状态：正确落成测试护栏。

当前 `reservationMatchesArtifactRel()`：

- `!reservation || !artifactRel` 返回 `{ ok: true }`，明确是不适用路径。
- CHG/HOTFIX `filePrefix` 同时接受：
  - `changes/chg-YYYYMMDD-NN.md`
  - `changes/chg-YYYYMMDD-NN-<slug>.md`
- 真 mismatch 返回 `{ ok: false, expected, actual }`。
- 非 reserved-id 模式 rel 返回 `{ ok: true }`。

新增单测覆盖上述四类，且 `PACE_RELEASE_BASE=0c47832 node tests/run-all.js` 中实测通过。

## Claude Code 回答逐项复核

### 已做项

状态：基本属实。

- v7.2.5 -> v7.2.8 四个 release commit 都在当前 `master` 历史中，v7.2.8 已推到 `origin/master`。
- v7.2.6 声称的 dead import / dead param 清理、`PACE_RELEASE_BASE`、REFERENCE deny 档位、`EXPECTED_DENY_META`、SubagentStop lazy 均仍在当前代码与测试中。
- v7.2.7 的 `mutatesArtifact` 谓词链去重仍在，相关单测仍通过。
- v7.2.8 的 1.3 和 2.6 已在代码与测试中落地。
- findings 维护确实发生：`finding-2026-06-15-sessionstart-budget-head-no-hard-cap` 已创建并在 `findings.md` 活跃区；`finding-2026-06-14-v721-release-surface-structure-p3-backlog` 已更新到“组1 全闭、组2 收尾”。

保留意见：

- “TDD 红 -> 绿”和“opus 对抗审计”过程本身无法从当前 git snapshot 独立复演，只能核实当前代码、测试结果与 artifact 记录。
- v7.2.8 的 CHG 详情文件前段残留“删死代码”的旧叙述，与最终实现矛盾，见本审计 P3。

### 做了一部分

状态：实质理由多数成立。

README v7.2.5 计数：

- 独立重数 `b593063:plugin/hooks/pre-tool-use.js`：`return hardDeny(` call site = 26。
- 其中与 `DENY_DIRECT_ARTIFACT_EDIT` 同一调用片段的 hardDeny = 2。
- 因此 Claude Code 所说“24 站点不变 + 2 个 DIRECT_ARTIFACT_EDIT 改预包 = 26”实质成立。
- 但 README v7.2.5 行仍写 `hardDeny` “24 站点不变”，没有把 26 总数写成机械计数口径。严格审计角度，这不构成必须修的 bug，但仍是 P3 可读性/抗误读问题。

2.2 vault-notes 子模块抽离：

- 当前 `parseYamlList()` 与 `scanRelatedNotes()` 仍在 `pace-utils.js` 门面内，确实未抽。
- 二者基本自包含，技术上可抽；但会触碰 `pace-utils.js` 顶部 cache-bust 列表，且组2在 finding 中被归类为大重构配套。
- 作为 v7.2.8 收尾不做，理由充分；作为长期可维护性债，仍应保留在 finding 中。

### 未做项理由

状态：分三类。

理由充分：

- 2.3 require-cache 注释：独立探针确认门面重载会刷新子模块并重读 `PACE_VAULT_PATH`；“env 冻结”不是当前事实。
- 1.5 commandInput 双别名：`bashCommand` 与 `powershellCommand` 都是同一个 `commandInput`，当前用错别名无行为后果，属于可读性问题。
- 1.7 reservation 双实现：prompt 声明匹配与写盘 rel 匹配是不同阶段的两半检查；当前已有 `@see` 和 `filePrefix startsWith` 同步注释，拒绝强合并合理。
- 2.4 命名空间拆分、3.4/3.5 truncate/layers 字面量、1.6 collectWarnings：当前没有可达 bug，重构会扩大 churn；按 gold-plating 拒绝合理。
- foreign-worktree 写码搭便车：测试明确锁为现状，是否收紧是产品边界裁定，不应在工程卫生 release 中擅自改。
- agent-tests 真套件休眠：README 明确写 dummy 只测 mock 框架，fixtures 仍 v6，复活需要单独 v7 fixture 重写和真实 agent 跑。
- budget head 严格版：当前主要可达风险已 cap + `headOverflow` 可观测；严格硬上限会改变“head 永不截”取舍，记 P3 finding 合理。

部分充分：

- Stop `background_tasks`：需要 dump-stdin 冷启动探针来确认当前 Claude Code harness 的真实字段，这个理由对“精准修根因”充分。但当前代码仍只读 `raw.background_tasks`，无 `backgroundTasks` 或 parse 层归一兜底；P2 finding 不能关闭。
- adoption / quickstart / lite profile / V-R evidence gates：作为产品方向债保持 open 合理，但它们不属于 v7.2.8 runtime release 阻断。

理由不充分或记录需修正：

- `PACE_RELEASE_BASE` 文档入口：能力实现正确，但 `CLAUDE.md` 和 `REFERENCE.md` 仍只写 `node tests/run-all.js`。这不能算“post-push 区间盲区已在流程上完全闭合”，只能算“工具能力已闭合，文档默认流程仍有 P3 缺口”。
- v7.2.8 CHG 详情文件：最终代码是抽 helper，不是“删死命令守卫”。CHG 详情文件前段旧叙述应修正，否则 artifact 记录自身会成为后续审计噪声。

## 已知未修项当前状态

- `PACE_RELEASE_BASE` 文档默认入口：仍在。
- README v7.2.5 hardDeny 计数抗误读：仍可优化，但拒改理由实质成立。
- 真 artifact-writer contract suite：仍休眠，fixtures 仍 v6。
- `LOCKS-001` 跨独立 clone 共享 vault 重复编号：仍是已知限制。
- budget head 严格版：仍未做 final hard cap，已记录 P3 finding。
- foreign-worktree 写码搭便车：仍在，测试锁为现状。
- Stop `background_tasks` 上游字段漂移：仍在，需外部探针确认。
- 结构 backlog 剩余：7.5 e2e TOC、7.4 契约 fixture、5.6 task-list-sync legacy、D1 status-reason guard 收窄、2.2 vault-notes defer。

## 审计边界

- 未执行真实 marketplace 安装/升级，只执行本地 `claude plugin validate ./plugin`。
- 未跑真实 artifact-writer LLM agent contract suite，只跑了 dummy 与 helper 单测。
- 未做 Stop dump-stdin 冷启动探针，因此不能确认当前 Claude Code harness 的 `background_tasks` 新字段形态。
- 未修改源码；本审计只新增本地 Codex 审计文档。
