# PACEflow v7.2.7 Codex 审计：发布面严格复核

> 类型：Codex 审计
> 日期：2026-06-15
> 审计对象：远端 `origin/master@0c47832262e43bece93dc4813d0b01f9c3ebd078`
> 增量区间：`f24f124..0c47832`（v7.2.6 -> v7.2.7）
> 全量参照区间：`52f3461..0c47832`（v7.1.0 后发布面）

## 结论

v7.2.7 发布态未发现 P0/P1/P2 runtime 阻断。`HEAD` 与 `origin/master` 一致，均为 `0c47832`。本次发布是窄范围工程卫生重构：把 `pre-tool-use.js` 中 Bash 与 Monitor 分支重复内联的 artifact mutation 组合谓词抽到 `bash-guard.js`，并把 PowerShell 分支的同类组合谓词抽到 `powershell-guard.js`。

主结论：

- 版本发布面一致：marketplace manifest、plugin manifest、`PACE_VERSION`、README、REFERENCE 均为 v7.2.7。
- Bash 与 Monitor 的新 `bashCommandMutatesArtifact()` 等价于旧 4 项内联链：redirect / shell-wrapped redirect / embedded write script / mutating verb references artifact。
- PowerShell 的新 `powershellCommandMutatesArtifact()` 等价于旧 3 项内联链：redirect / embedded write script / mutating cmdlet references artifact。PowerShell 没有新增 shell-wrapped 项，符合旧实现。
- runtime-control 拦截顺序与谓词未动：Bash、PowerShell、Monitor 仍先拦 runtime-control，再判 artifact mutation。
- 去重带来的导入清理正确：被删的是不再由 `pre-tool-use.js` 直接调用的组件谓词；`bashCommandLooksMutating` / `powershellCommandLooksMutating` 仍被 dispatcher 使用，保留正确。

本次没有发现 v7.2.7 新增回归。上一版在案的发布流程/文档/产品债仍存在，列在“已知未修复项复核”。

## 发布验证

远端与工作区：

- `git fetch --prune origin`：完成。
- `git status --short --branch`：`master...origin/master`，无 tracked 修改。
- `git rev-parse HEAD origin/master`：两者均为 `0c47832262e43bece93dc4813d0b01f9c3ebd078`。
- 既存未跟踪文件：
  - `2026-06-12-115732-v700-reload-session-dogfood-backl.txt`
  - `docs/audits/audit-2026-06-15-codex-v7.2.6-release-surface.md`
- 本审计新增未跟踪文件：
  - `docs/audits/audit-2026-06-15-codex-v7.2.7-release-surface.md`

增量范围：

- `git diff --stat f24f124..HEAD`：9 files changed, 53 insertions(+), 27 deletions(-)。
- 变更文件：
  - `.claude-plugin/marketplace.json`
  - `README.md`
  - `REFERENCE.md`
  - `plugin/.claude-plugin/plugin.json`
  - `plugin/hooks/pace-utils/constants.js`
  - `plugin/hooks/pre-tool-use.js`
  - `plugin/hooks/pre-tool-use/bash-guard.js`
  - `plugin/hooks/pre-tool-use/powershell-guard.js`
  - `tests/test-pace-utils.js`

版本面：

- `.claude-plugin/marketplace.json` version = `7.2.7`
- `plugin/.claude-plugin/plugin.json` version = `7.2.7`
- `plugin/hooks/pace-utils/constants.js` `PACE_VERSION = 'v7.2.7'`
- `REFERENCE.md` 标题为 `PACEflow v7.2.7 参考手册`
- `README.md` 版本历史新增 v7.2.7 行，页脚版本为 v7.2.7
- 未发现 `v7*` git tag；当前发布追溯仍依赖 release commit 与 manifest version。

自动与静态验证：

- `PACE_RELEASE_BASE=f24f124 node tests/run-all.js`：8/8 PASS
  - `test-pace-utils`：292/292
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
- `git diff --check f24f124..HEAD`：PASS
- `git diff --check 52f3461..HEAD`：PASS
- `git diff --check HEAD^..HEAD`：PASS
- 独立等价探针：重建旧 Bash 4 项链与旧 PowerShell 3 项链，对比新命名谓词，`equivalence probe PASS: bash=9, powershell=7`。

## v7.2.7 改动复核

### 1. 版本发布面

状态：正确。

`marketplace.json`、plugin manifest、`PACE_VERSION`、README 页脚、README 版本历史、REFERENCE 标题均同步到 v7.2.7。`CHANGELOG.md` 仍是 v5 历史冻结文件，v6+ 版本历史以 README 为准，不改不构成发布遗漏。

### 2. Bash / Monitor artifact mutation 谓词链去重

状态：正确，未发现行为漂移。

旧实现中 Bash 分支与 Monitor 分支分别内联同一条 4 项链：

```js
bashCommandRedirectsToArtifact(command, cwd, artDir) ||
  bashShellCommandRedirectsToArtifact(command, cwd, artDir) ||
  bashCommandEmbedsArtifactWriteScript(command, cwd, artDir) ||
  (bashCommandLooksMutating(command) &&
    (bashCommandReferencesArtifact(command, cwd, artDir) || bashShellCommandReferencesArtifact(command, cwd, artDir)))
```

当前 `bash-guard.js` 的 `bashCommandMutatesArtifact(command, cwd, artDir)` 保留同一组合，只把分支局部变量名 `bashCommand` 泛化为形参 `command`。`pre-tool-use.js` 中 Bash 分支和 Monitor 分支均改为调用该命名谓词。

复核要点：

- 4 项链没有漏项、没有新增项、没有改变短路顺序。
- Monitor 原本经 `bashCommand` 走 bash 识别栈，新实现继续复用 bash 识别栈。
- runtime-control 路径仍调用 `bashCommandMutatesArtifactRuntimeControl()`，且仍在 artifact mutation 判定之前。
- 新单测 `bash-guard 1.4-dedup: bashCommandMutatesArtifact 组合谓词链` 覆盖 redirect、shell wrapper redirect、mutating verb reference，以及只读 `cat` / `grep` 不 over-block。

### 3. PowerShell artifact mutation 谓词链去重

状态：正确，未发现行为漂移。

旧实现中 PowerShell 分支内联的是 3 项链：

```js
powershellCommandRedirectsToArtifact(command, cwd, artDir) ||
  powershellCommandEmbedsArtifactWriteScript(command, cwd, artDir) ||
  (powershellCommandLooksMutating(command) &&
    powershellCommandReferencesArtifact(command, cwd, artDir))
```

当前 `powershell-guard.js` 的 `powershellCommandMutatesArtifact(command, cwd, artDir)` 保留同一组合。没有把 Bash 的 shell-wrapped redirect 项强行移植到 PowerShell，这是正确的：旧 PS 栈本来没有该项。

复核要点：

- 3 项链没有漏项、没有新增项、没有改变短路顺序。
- runtime-control 路径仍调用 `powershellCommandMutatesArtifactRuntimeControl()`，且仍在 artifact mutation 判定之前。
- 新单测 `powershell-guard 1.4-dedup: powershellCommandMutatesArtifact 组合谓词链` 覆盖 `Set-Content`、redirect、`Remove-Item` 引用 artifact，以及只读 `Get-Content` 不 over-block。

### 4. `pre-tool-use.js` 导入清理

状态：正确。

本次从 `pre-tool-use.js` 删除的组件谓词包括：

- Bash：`bashCommandRedirectsToArtifact`、`bashShellCommandRedirectsToArtifact`、`bashCommandEmbedsArtifactWriteScript`、`bashCommandReferencesArtifact`、`bashShellCommandReferencesArtifact`
- PowerShell：`powershellCommandRedirectsToArtifact`、`powershellCommandEmbedsArtifactWriteScript`、`powershellCommandReferencesArtifact`

这些组件谓词现在只由 guard 模块内部组合调用，`pre-tool-use.js` 不再需要直接 destructure。`bashCommandLooksMutating` 与 `powershellCommandLooksMutating` 仍在 `commandExecutionLooksMutating()` 使用，保留正确，不是死导入。

### 5. 行为网覆盖

状态：足以支撑本次纯重构结论，但不替代休眠的真实 agent contract suite。

覆盖成立点：

- `test-pace-utils` 新增 Bash/PowerShell 组合谓词单测，并保留既有 guard 细粒度测试。
- `test-hooks-e2e` 仍覆盖 Bash / PowerShell / Monitor artifact 拦截与 runtime-control 拦截路径。
- golden deny snapshots 与 `DENY_REASONS` 结构守护仍通过，说明 deny 出口、action code、富化元数据未因本次重构漂移。
- 独立等价探针用当前组件谓词重建旧链，对 9 个 Bash case 和 7 个 PowerShell case 验证新旧结果一致。

边界：

- 本次未执行真实 artifact-writer LLM agent contract suite；`node tests/agent-tests/run-tests.js dummy` 只验证 mock 框架。
- 未执行真实 marketplace 安装/升级，只执行本地 plugin validate。

## 已知未修复项复核

### K1. `PACE_RELEASE_BASE` 已实现，但发布验证文档仍默认 `node tests/run-all.js`

状态：仍未修复，P3 发布流程文档缺口。

证据：

- `tests/run-all.js` 已支持 `PACE_RELEASE_BASE=<上版 commit>`，本次用 `PACE_RELEASE_BASE=f24f124 node tests/run-all.js` 验证通过。
- `CLAUDE.md` 常用验证仍写 `node tests/run-all.js`。
- `REFERENCE.md` 验证入口仍写 `node tests/run-all.js`。

风险：post-push 后 `@{upstream}..HEAD` 为空，维护者若按默认文档命令跑，仍不会自动检查整段 release diff。建议发布/审计入口显式写：

```bash
PACE_RELEASE_BASE=<上版 commit> node tests/run-all.js
```

### K2. README v7.2.5 `hardDeny` 计数仍不够机械直观

状态：仍未修复，P3 文档精确性问题。

当前 README v7.2.5 行仍写 `hardDeny` “24 站点不变”，同时说明 2 个 `DENY_DIRECT_ARTIFACT_EDIT` 去 caller 预包改表 dirHint 富化。按上一轮机械复核，`b593063` 实际 `return hardDeny(` call site 为 26。现文案可解释为 “24 个非 DIRECT 调用点保持完全不变 + 2 个 DIRECT 调用点仍是 hardDeny 但 caller 预包改变”，但 v7.2.5 行本身没有写出 26 总数，继续容易与机械计数冲突。

建议改成：`26 个 hardDeny call site 保留，其中 24 个调用形态不变、2 个 DENY_DIRECT_ARTIFACT_EDIT 去 caller 预包改由表 dirHint 富化；13 denyOrHint + 22 raw 迁移；1 个 catch raw 保留`。

### K3. 真 artifact-writer contract suite 仍休眠且 fixtures 仍 v6

状态：仍未修复。

证据：

- `tests/agent-tests/README.md` 明确写本套件不在 `node tests/run-all.js` 内。
- `node run-tests.js dummy` 只跑 mock 框架自测，不碰真 agent。
- fixtures 仍为 v6 形态，最近真实非 dummy 跑停在 2026-06-02。

本次验证的 dummy 通过不能替代真实 artifact-writer LLM contract suite。

### K4. `LOCKS-001` 跨独立 clone 共享 vault 重复编号

状态：仍是已知限制。

README 仍记录多个独立 clone 共享同一云同步 vault project 并发 reserve 时，本地 `.pace` counter/lock 不跨 clone，可能重复分配 CHG/HOTFIX/CORRECTION 编号。v7.2.7 未触碰 artifact-root-bound runtime 或跨 clone sequence 机制。

### K5. budget head 永不截严格版

状态：仍未按严格版修复；当前是有意设计取舍。

`session-start/budget.js` 仍明示 `head 永不截`，head 超限时返回完整 head，只置 `headOverflow/truncated`。这不同于“最终注入绝不超过 limitChars”的严格修法。v7.2.7 未触碰该文件。

### K6. foreign-worktree 写码搭便车

状态：仍在，且当前被测试锁为现状。

`tests/test-hooks-e2e.js` 仍有 foreign worktree 写码搭便车现状不回归测试；`pre-tool-use.js` 注释也写 foreign worktree 既有搭便车行为不动。是否收紧仍是产品/并发模型裁定。

### K7. Stop `background_tasks` 上游字段漂移根治

状态：仍未根治。

`plugin/hooks/stop.js` 仍直接读取 `raw.background_tasks`，没有上移到 stdin parse 层做 `background_tasks/backgroundTasks` 双写归一。当前 e2e 覆盖多种传入形态，但不是对上游字段名漂移的结构性修复。

### K8. adoption / quickstart / lite profile / V-R evidence gates 方向债

状态：仍未实现。

- `docs/optimization-2026-06-13-release-surface-review.md` 仍记录 quickstart、lite profile、竞品对照为采用面方向债。
- `docs/research-2026-06-13-does-paceflow-help.md` 仍支持按场景匹配最小严格度，而当前产品仍是 full ceremony 默认。
- `docs/direction-2026-06-13-constraint-philosophy-evidence-gates.md` 提出的 V/R “声明 -> 证据”仍是方向记录，未进入实现。

## 审计边界

- 本审计只审 `origin/master@0c47832` 的 tracked 发布内容；未跟踪本地文件不纳入发布态结论。
- 未执行真实 marketplace 安装/升级。
- 未跑真实 artifact-writer LLM agent contract suite。
- 未复现实机多 clone + 云同步 vault 的编号冲突，只复核当前代码与文档状态。
- 未复现 README 中提到的外部 “opus 对抗审计” 原始过程，只复核当前 release commit 内可机械验证的代码、测试与文档证据。
