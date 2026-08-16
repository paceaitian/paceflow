# PACEflow v7.2.10 Codex 审计：发布面严格复核

> 类型：Codex 审计
> 日期：2026-06-15
> 审计对象：`origin/master@40dd3fac043bedfc34c2dae1f416861d0a869cc1`
> 增量区间：`1eac877..40dd3fa`（v7.2.9 -> v7.2.10）
> 本地边界：当前本地 `master` 另有 `8ca595d`、`9b5b1b3` 两个未推文档 commit，不纳入本次 v7.2.10 发布审计。

## 结论

v7.2.10 远端发布面未发现 P0/P1/P2 runtime 阻断。release commit 声称修复的两个 v7.2.9 Codex P3 均已实质关闭：

- `operation:` 空行不再被下一行 `title:` 吞成 operation 值；缺 `artifact_dir` 路径和已有 `artifact_dir` 的 lifecycle 路径都进入正确 missing-operation 文案。
- `REFERENCE.md` 标题与最后更新日期已同步到 v7.2.10 / 2026-06-15。

新增 P3 2 个，均不影响发布可用性：

1. **README 顶部新增的“指令遵守率约 70-85%”是精确数字但未给出处。** 这个数值用于论证 soft instruction 不可靠，方向与项目已有研究/定位一致，但 public README 中直接给区间会被读者当成外部统计。建议改成定性表述，或在 README/研究文档中给明确来源。
2. **action 空行修复缺直接 e2e 锁。** v7.2.10 同时把 `promptDeclaredAction()` 改为 same-line parser，定向探针确认 `action:\nverify-summary: ...` 会报 missing action；但新增 e2e 只覆盖 `operation:` 空行，现有 `9hc4a1b` 只测 action 缺失和 unknown，没有锁 action 空行吞下一字段这个具体回归。

## 发布面核实

远端区间包含两个 commit：

- `d983fde`：README 顶部加入“诚实边界定位一页”。
- `40dd3fa`：v7.2.10 release，修 v7.2.9 P3-1/P3-2 并 bump 版本。

增量文件 8 个：

- `.claude-plugin/marketplace.json`
- `README.md`
- `REFERENCE.md`
- `plugin/.claude-plugin/plugin.json`
- `plugin/hooks/pace-utils/constants.js`
- `plugin/hooks/pace-utils/locks.js`
- `plugin/hooks/pre-tool-use/agent-lifecycle-guard.js`
- `tests/test-hooks-e2e.js`

增量统计：`8 files changed, 95 insertions(+), 17 deletions(-)`。

版本面：

- `.claude-plugin/marketplace.json:12` version = `7.2.10`
- `plugin/.claude-plugin/plugin.json:4` version = `7.2.10`
- `plugin/hooks/pace-utils/constants.js:5` `PACE_VERSION = 'v7.2.10'`
- `README.md:443` 新增 v7.2.10 版本历史；页脚版本为 v7.2.10
- `REFERENCE.md:1-3` 标题为 v7.2.10，最后更新为 2026-06-15

## 自动验证

在临时 detached worktree `/tmp/paceflow-v7210-audit-TWMbVz` 上执行，避免本地未推 commit 污染结果：

- `PACE_RELEASE_BASE=1eac877 node tests/run-all.js`：8/8 PASS
  - `test-pace-utils`：293/293
  - `test-hooks-e2e`：442/442
  - `test-session-layers`：48/48
  - `test-migrate-v7`：16/16
  - `test-agent-tests-helpers`：11/11
  - `test-run-all`：6/6
  - `claude plugin validate ./plugin`：PASS
  - `git-diff-check`：PASS
- `git diff --check 1eac877..40dd3fa`：PASS
- `git diff --check 52f3461..40dd3fa`：PASS
- `find plugin tests -name '*.js' -print0 | xargs -0 -n 1 node --check`：PASS
- `node tests/agent-tests/run-tests.js dummy`：PASS

定向探针：

- `agentArtifactDirDenyReason('/tmp/art', '', 'operation:\ntitle: 测试')`：包含“也未声明 operation”。
- `agentLifecyclePromptDenyReason('artifact_dir: /tmp/art/\noperation:\ntitle: 测试')`：返回“缺少明确 operation”，不再返回 `operation「title:」` unknown。
- `agentLifecyclePromptDenyReason('artifact_dir: /tmp/art/\noperation: update-chg\ntarget: ...\naction:\nverify-summary: ok')`：返回 missing action。
- close-chg prompt 中 `verify-summary:` / `review-findings:` / `implementation-notes:` / `walkthrough-summary:` 后接缩进列表：返回 allow，确认多行字段未被 same-line 修法误伤。

## 改动复核

### P3-1 operation/action 空行 parser

状态：主修复正确。

当前实现：

- `promptFieldValueSameLine()` 新增于 `agent-lifecycle-guard.js:271-275`，冒号后只吞同行空白，不跨换行。
- `promptDeclaredOperation()` 改用 same-line parser 读取 `operation` / `指令`，再 fallback 到 `operationFromAgentPrompt()`（`agent-lifecycle-guard.js:405-407`）。
- `promptDeclaredAction()` 改用 same-line parser 读取 `action`（`agent-lifecycle-guard.js:410-414`）。
- `operationFromAgentPrompt()` by-field 正则同样改成 `[^\S\n]*`（`locks.js:50-53`）。

这个局部修法比全局修改 `promptFieldValue()` 更稳：`promptFieldValue()` / `promptHasNonEmptyField()` 仍保留跨行能力，避免 `verify-summary:\n  - ...`、`implementation-notes:\n  - ...` 被误判为空。定向探针与 full `run-all` 均确认未出现 close-chg 多行字段误 deny。

新增 e2e：

- `tests/test-hooks-e2e.js:2463-2479` 覆盖缺 `artifact_dir` 路径下 `operation:` 空行一并点名。
- `tests/test-hooks-e2e.js:2481-2506` 覆盖已有 `artifact_dir` 路径下 lifecycle 报 missing operation 而非 unknown `title:`。

保留意见：

- release note 写的是 `operation/action 空行 parser same-line 化`，但直接新增测试只覆盖 operation。action 路径靠同一 helper 与定向探针证明，不是发布阻断；建议补 `action:\nverify-summary:` e2e，避免以后 action 回归只靠人工推理。

### P3-2 REFERENCE 日期

状态：正确修复。

`REFERENCE.md:1-3` 已从 v7.2.9 / 2026-06-13 改为 v7.2.10 / 2026-06-15。

### README 顶部定位

状态：方向正确，但有一个 P3 表述风险。

README 新增“它不做什么 / 它做什么 / 与 TDD、SDD、OpenSpec、Spec Kit 的关系 / 它适合谁”，总体与项目既有定位一致：PACEflow 是执行层 hook 兜底，不是质量控制器，也不替代 spec/test/review 内容本身。

风险点是 `README.md:17` 的“指令遵守率约 70-85%”。这是 public README 中的精确数字，但本段没有引用来源；如果这是经验值或内部估计，建议改为“软指令可能被忽略/遵守率无法保证”等定性说法，或在研究文档中给来源并链接。

## 已知未修项复查

### 已关闭

- **v7.2.9 P3-1：operation 空行被下一字段吞掉。** 已关闭。
- **v7.2.9 P3-2：REFERENCE 日期 stale。** 已关闭。

### 仍未修，理由基本成立

- **budget head 严格硬上限。** `tests/test-session-layers.js:201-208` 仍明确锁定 head 超 9500 也全保留，只置 `headOverflow`。v7.2.10 未触碰该设计取舍。
- **真 artifact-writer agent contract suite 休眠。** `tests/agent-tests/README.md:8-11` 仍写明真套件不在 `run-all` 内、dummy 只测 mock 框架、fixtures 仍 v6、真实跑停在 2026-06-02。
- **foreign worktree 写码搭便车。** `tests/test-hooks-e2e.js:7910` 仍有现状锁定用例；是否收紧仍是产品边界裁定。

### 仍未修，不能视为关闭

- **Stop `background_tasks` 字段漂移。** `plugin/hooks/stop.js:80` 仍只读 `raw.background_tasks`。e2e 覆盖既定字段形态，但没有冷启动 dump-stdin 证明当前 Claude Code harness 未漂移；该项仍需外部探针或归一层兜底。

## 审计边界

- 本审计对象是远端 `origin/master@40dd3fa`。本地之后的 `8ca595d`、`9b5b1b3` 未纳入。
- 未执行真实 marketplace 安装/升级，只执行 `claude plugin validate ./plugin`。
- 未跑真实 artifact-writer LLM agent contract suite；只跑了 dummy 和 helper 自动回归。
- 未做 Stop dump-stdin 冷启动探针，因此不声称已确认最新 Claude Code harness 的真实 `background_tasks` 字段形态。
