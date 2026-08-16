# PACEflow v7.2.6 Codex 审计：发布面严格复核

> 类型：Codex 审计
> 日期：2026-06-15
> 审计对象：远端 `origin/master@f24f124ef42d31abbb6c2794f19b7336c7c3734e`
> 增量区间：`98c4ea2..f24f124`（v7.2.5 -> v7.2.6）
> 全量参照区间：`52f3461..f24f124`（v7.1.0 后发布面）

## 结论

v7.2.6 发布态未发现 P0/P1/P2 runtime 阻断。版本号发布面一致，`origin/master` 与本地 `HEAD` 均为 `f24f124`。本次主改动中的三项实质修复成立：

- v7.2.5 Codex P3-1：`REFERENCE.md` §5.1 已从旧 `denyOrHint` / `hardDeny 或 inline-deny` 口径改为 `emitDeny + DENY_REASONS.teammateMode`。
- v7.2.5 Codex P3-3：`tests/test-hooks-e2e.js` 新增 `EXPECTED_DENY_META`，逐项锁 53 个 deny action 的 `escapeHatch|dirHint|teammateMode` 三元组。
- `subagent-stop.js` transcript lazy 改动保持 PSP-02 同源不变量：廉价 candidate 命中时不读 transcript，廉价 candidate 全 miss 时仍读 transcript fallback。

本次严格审计新增/延续 P3 级问题 2 个：

1. `PACE_RELEASE_BASE` 能力已实现，但发布验证文档仍默认写 `node tests/run-all.js`；已 push 后默认命令仍无法自动检查上版到 HEAD 的 release diff。
2. README v7.2.5 计数仍不是机械直观口径：`b593063` 实际 `return hardDeny(` call site 为 26，当前文案写“24 站点不变；2 个 DIRECT_ARTIFACT_EDIT ...”。该解释可以被理解为“24 个非 DIRECT + 2 个 DIRECT”，但 release note 本身没有把 26 总数写清，仍会让机械计数复核者得到冲突结论。

## 发布验证

版本面：

- `.claude-plugin/marketplace.json` version = `7.2.6`
- `plugin/.claude-plugin/plugin.json` version = `7.2.6`
- `plugin/hooks/pace-utils/constants.js` `PACE_VERSION = 'v7.2.6'`
- `README.md` 页脚与版本历史为 `v7.2.6`
- `REFERENCE.md` 标题为 `v7.2.6`
- 未发现 `v7.2.6` git tag；当前发布追溯仍依赖 release commit 与 manifest version。

自动与静态验证：

- `PACE_RELEASE_BASE=98c4ea2 node tests/run-all.js`：8/8 PASS
  - `test-pace-utils`：290/290
  - `test-hooks-e2e`：438/438
  - `test-session-layers`：48/48
  - `test-migrate-v7`：16/16
  - `test-agent-tests-helpers`：11/11
  - `test-run-all`：6/6
  - `claude plugin validate ./plugin`：PASS
  - `git-diff-check`：PASS（含 `98c4ea2..HEAD` release 区间）
- `find plugin tests -name '*.js' -print0 | xargs -0 -n 1 node --check`：PASS
- `node tests/agent-tests/run-tests.js dummy`：PASS
- `bash -n tests/agent-tests/run-agent-cli-suite.sh`：PASS
- `git diff --check 98c4ea2..HEAD`：PASS
- `git diff --check 52f3461..HEAD`：PASS
- `git diff --check HEAD^..HEAD`：PASS

工作区边界：

- 测试后无 tracked 文件变化。
- 既存未跟踪文件 `2026-06-12-115732-v700-reload-session-dogfood-backl.txt` 未纳入发布态结论。
- `plugin/hooks/pace-hooks.log` 是 `.gitignore` 忽略的本地运行日志，不属于 tracked 发布内容。

## v7.2.6 改动复核

### 1. 版本发布面

状态：正确。

`marketplace.json`、plugin manifest、`PACE_VERSION`、README 页脚、REFERENCE 标题均为 v7.2.6。`CHANGELOG.md` 仍是 v5 历史冻结文件，v6+ 版本历史以 README 为准，不改不构成发布遗漏。

### 2. dead import / dead param 清理

状态：正确，无 runtime 漂移。

- `pre-tool-use.js` 删除 destructure `getProjectRuntimeDir` 与 `promptHasTrueField`；当前文件内无裸引用残留。
- `post-tool-use.js` 删除未用 `ts` destructure；当前文件无 `ts` 裸引用。
- `plans.js` `formatBridgeHint(cwd, artDir)` 改为 `formatBridgeHint(cwd)`，`collect-state.js` caller 同步改为单参。

注：测试里仍有 `paceUtils.formatBridgeHint(dir, dir)` 旧签名调用；JS 会忽略多余参数，不影响 runtime，但后续可顺手改成单参让测试形态也对齐。

### 3. REFERENCE deny 档位文档

状态：正确修复 v7.2.5 Codex P3-1。

`REFERENCE.md` §5.1 当前三档实现列已改为：

- `emitDeny` + `teammateMode: 'soft'`
- `emitDeny` + `teammateMode: 'hard-note'`
- `emitDeny` + `teammateMode: 'hard'`

并补充 v7.2.5+ 实现说明：新增 deny 分支必须登记 `DENY_REASONS`，未登记 `emitDeny` fail-fast，`hardDeny` 是薄包装，`denyOrHint` 已删除。

### 4. README v7.2.5 计数订正

状态：部分修复；仍有 P3 文档精确性问题。

已修正：

- `13 denyOrHint + 21 raw` 已改为 `13 denyOrHint + 22 raw`。
- `62` 总数按 `26 hardDeny + 13 denyOrHint + 22 raw + 1 catch` 可自洽。

仍不够机械直观：

- 独立脚本复核 `b593063:plugin/hooks/pre-tool-use.js`：`return hardDeny(` call site = 26。
- 当前 README v7.2.5 行仍写 `hardDeny` “24 站点不变”；v7.2.6 行解释为 “24 站点不变 + 2 个 DIRECT_ARTIFACT_EDIT 改预包”。
- 该解释可成立为“24 个非 DIRECT 调用点保持完全不变，2 个 DIRECT 调用点仍为 hardDeny 但去掉 caller 预包”，但 README v7.2.5 行本身没有写出 `24 + 2 = 26` 的口径。

建议：把 v7.2.5 行改成 `26 个 hardDeny call site 保留，其中 24 个调用形态不变、2 个 DENY_DIRECT_ARTIFACT_EDIT 去 caller 预包改由表 dirHint 富化；13 denyOrHint + 22 raw 迁移；1 个 catch raw 保留`。

### 5. SubagentStop transcript lazy

状态：正确，当前未发现行为漂移。

原实现先组装廉价字段 + transcript 全量 candidate，再按顺序找第一个 close/archive operation。新实现等价拆成两段：

- 先对 `toolInput.prompt`、`raw.tool_input.prompt`、`raw.prompt`、`raw.agent_prompt`、`lastMessage` 运行同一 matcher。
- 若廉价 candidate 命中 close/archive operation（含缺 target），立即返回，不读取 transcript。
- 只有廉价 candidate 全部没有 close/archive operation 时，才读 transcript fallback。

这保持了 PSP-02 的关键语义：operation 与 target 必须来自同一个 candidate；同源 candidate 缺 target 时不跨 transcript 借 target。`SST-LAZY` 与 `SST-LAZY-FALLBACK` 覆盖 lazy 命中和 fallback 两端。

### 6. DENY_REASONS 表值守护

状态：正确修复 v7.2.5 Codex P3-3。

当前 `test-hooks-e2e` 结构测试会解析 `pre-tool-use.js` 中 `DENY_REASONS` 表，并断言：

- 实际表解析 53 项。
- `EXPECTED_DENY_META` 也是 53 项。
- 键集双向一致。
- 每个 code 的 `escapeHatch|dirHint|teammateMode` 三元组逐项相等。

这已覆盖上一轮指出的“deferred action 表值写反但 golden 仍绿”的缺口。`DENY_DIRECT_ARTIFACT_EDIT` 的 `dirHint:true` 例外也已被显式锁定。

### 7. run-all release 区间检查

状态：实现正确；文档/默认流程仍有 P3 缺口。

正确部分：

- `tests/run-all.js` 新增 `whitespaceCheckRanges(upstream, releaseBase)`。
- `gitWhitespaceCheck()` 始终跑工作树 diff；有 upstream 时跑 `@{upstream}..HEAD`；有 `PACE_RELEASE_BASE` 时额外跑 `<base>..HEAD`。
- `RUN-6` 覆盖无 upstream、有 upstream、有 release base、base trim 等分支。
- 本次审计用 `PACE_RELEASE_BASE=98c4ea2 node tests/run-all.js` 实测通过，证明 release 区间检查能生效。

缺口：

- `CLAUDE.md` 常用验证仍只写 `node tests/run-all.js`。
- `REFERENCE.md` §7 验证入口仍只写 `node tests/run-all.js`。
- post-push 状态下 `@{upstream}..HEAD` 为空；若维护者按文档默认命令跑，整段 release diff 仍不会自动被检查。

建议：把发布验证入口改成明确双模式：

- 本地提交前：`node tests/run-all.js`
- 发布/审计复核：`PACE_RELEASE_BASE=<上版 commit> node tests/run-all.js`

## 已知未修复项复核

### K1. 真 artifact-writer contract suite 仍休眠且 fixtures 仍 v6

状态：仍未修复。

证据：

- `tests/agent-tests/README.md` 明确写本套件不在 `node tests/run-all.js` 内。
- `node run-tests.js dummy` 只跑 mock 框架自测，不碰真 agent。
- fixtures 仍为 v6 形态，最近真实非 dummy 跑停在 2026-06-02。

本次仅验证 dummy 通过，不能替代真实 artifact-writer LLM contract suite。

### K2. `LOCKS-001` 跨独立 clone 共享 vault 重复编号

状态：仍是已知限制。

README 仍写多个独立 clone 共享同一云同步 vault project 并发 reserve 时，本地 `.pace` counter/lock 不跨 clone，可能重复分配 CHG/HOTFIX/CORRECTION 编号。v7.2.6 未触碰 artifact-root-bound runtime 或跨 clone sequence 机制。

### K3. budget head 永不截严格版

状态：仍未按严格版修复；当前是有意设计取舍。

当前 `assembleWithBudget()` 已有 `headOverflow` 信号与 20 活跃 CHG 满载守护，`SL-HO-* / SL-CAP-* / SL-SAT` 覆盖通过。但核心语义仍是 head 永不截：head 超限时返回完整 head，只置 `headOverflow/truncated`。v7.2.6 release note 也明确列为“不在本批”。

### K4. foreign-worktree 写码搭便车

状态：仍在，且当前被测试锁为现状。

`tests/test-hooks-e2e.js` 仍有 `SIB-PTU-4. foreign worktree 写码搭便车现状不回归`；`pre-tool-use.js` 注释也写 foreign worktree 既有搭便车行为不动。是否要收紧仍是产品/并发模型裁定。

### K5. Stop `background_tasks` 上游漂移根治

状态：仍未根治。

`stop.js` 仍直接读取 `raw.background_tasks`；没有上移到 `parseHookStdin` 做 `background_tasks/backgroundTasks` 双写归一。当前 e2e 覆盖多种传入形态，但不是对上游字段名漂移的结构性修复。

### K6. require-cache 注释/协议

状态：仍未处理。

`pace-utils.js` 仍保留子模块 cache delete 逻辑；v7.2.6 release note 已把该项列为“机制疑似本就正确待独立验证”。本次未发现 runtime 问题，但注释与测试 reload 协议仍适合单独复核。

### K7. adoption / quickstart / lite profile / 证据门方向债

状态：仍未实现。

- `optimization-2026-06-13-release-surface-review.md` 仍记录 quickstart、lite profile、竞品对照为采用面方向债。
- `research-2026-06-13-does-paceflow-help.md` 仍支持按场景匹配最小严格度，而当前产品仍是 full ceremony 默认。
- `direction-2026-06-13-constraint-philosophy-evidence-gates.md` 提出的 V/R “声明 -> 证据”仍是方向记录，未进入实现。

## 审计边界

- 未执行真实 marketplace 安装/升级，只执行了本地 `claude plugin validate ./plugin`。
- 未跑真实 artifact-writer LLM agent contract suite；该缺口已列为 K1。
- 未复现实机多 clone + 云同步 vault 的编号冲突，只复核当前代码与文档状态。
- 没有复现 README 中提到的外部 “opus 对抗审计” 原始过程，只复核当前发布 commit 内可机械验证的代码、测试与文档证据。
