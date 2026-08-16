# PACEflow v7.2.9 Codex 审计：发布面严格复核

> 类型：Codex 审计
> 日期：2026-06-15
> 审计对象：`origin/master@1eac877091c1a673810d511e6ea3a00e2ac96c38`
> 增量区间：`f2ef778..1eac877`（v7.2.8 -> v7.2.9）
> 复核目标：严格核实 v7.2.9 发布内容、v7.2.8 审计遗留项的修复状态，以及新增发布面风险。

## 结论

v7.2.9 已在远端发布，`HEAD == origin/master == 1eac877`。本次 tracked 发布面未发现 P0/P1/P2 runtime 阻断；核心改动与 release note 大体属实：

- 版本号五处已同步到 `7.2.9` / `v7.2.9`。
- `PACE_RELEASE_BASE` 发布验证入口已补到 `CLAUDE.md` 与 `REFERENCE.md`，v7.2.8 审计指出的“能力有了但文档默认流程仍漏 release 区间”已关闭。
- artifact-writer 缺 `artifact_dir` 的派遣门确实新增“同时缺 operation 时一并提示”的 DX 文案，并补了两条 e2e。
- 勘误约定已进入 `plugin/agent-references/artifact-writer-spec.md`。
- 两个未用参数删除没有发现行为漂移。

新增发现 2 个 P3，均不影响本次发布可用性：

1. **P3：`operation:` 空行仍绕过新增“缺 operation”提示，后续报错误导为 `operation「title:」` 不支持。** 这是既有 `promptFieldValue()` 跨行吞下一字段的问题在 v7.2.9 新文案路径上的暴露：`operation:\ntitle: 测试` 会被解析成 operation=`title:`，所以 `agentArtifactDirDenyReason()` 不追加“也未声明 operation”提示；补上 artifact_dir 后，生命周期门报 unknown operation 而不是 missing operation。安全上仍 deny，不是放行漏洞；但 v7.2.9 “缺啥列啥/免二次往返”没有覆盖这个常见空字段形态。
2. **P3：`REFERENCE.md` 元数据仍写 `最后更新：2026-06-13`。** 本次 v7.2.9 实际修改了 REFERENCE 标题和验证入口，但日期未同步到 2026-06-15。

## 发布面核实

增量文件 10 个：

- `.claude-plugin/marketplace.json`
- `CLAUDE.md`
- `README.md`
- `REFERENCE.md`
- `plugin/.claude-plugin/plugin.json`
- `plugin/agent-references/artifact-writer-spec.md`
- `plugin/hooks/pace-utils/constants.js`
- `plugin/hooks/pre-tool-use.js`
- `plugin/hooks/pre-tool-use/agent-lifecycle-guard.js`
- `tests/test-hooks-e2e.js`

增量统计：`10 files changed, 62 insertions(+), 10 deletions(-)`。

版本面：

- `.claude-plugin/marketplace.json:12` version = `7.2.9`
- `plugin/.claude-plugin/plugin.json:4` version = `7.2.9`
- `plugin/hooks/pace-utils/constants.js:5` `PACE_VERSION = 'v7.2.9'`
- `README.md:421` 新增 v7.2.9 版本历史；`README.md:514` 页脚版本 = `v7.2.9`
- `REFERENCE.md:1` 标题 = `PACEflow v7.2.9 参考手册`

`v7.2.8` 在本次扫描中只作为 README 版本历史行保留，未发现 runtime/manifest 版本错配。

## 自动验证

已执行并通过：

- `PACE_RELEASE_BASE=f2ef778 node tests/run-all.js`：8/8 PASS
  - `test-pace-utils`：293/293
  - `test-hooks-e2e`：440/440
  - `test-session-layers`：48/48
  - `test-migrate-v7`：16/16
  - `test-agent-tests-helpers`：11/11
  - `test-run-all`：6/6
  - `claude plugin validate ./plugin`：PASS
  - `git-diff-check`：PASS
- `git diff --check f2ef778..HEAD`：PASS
- `git diff --check 52f3461..HEAD`：PASS
- `find plugin tests -name '*.js' -print0 | xargs -0 -n 1 node --check`：PASS

## 改动复核

### T-001 派遣门“缺啥列啥”

状态：主体成立，但有 P3 边界缺口。

当前调用顺序仍正确：`pre-tool-use.js:462-470` 在 artifact-writer 进入 lifecycle 校验前先检查 `artifact_dir`，因此缺 `artifact_dir` 时原本到不了 operation/lifecycle 门。v7.2.9 在 `agentArtifactDirDenyReason()` 中增加了 `promptDeclaredOperation(prompt)` 为空时的附加提示（`agent-lifecycle-guard.js:232-245`）。

新增 e2e 覆盖：

- `tests/test-hooks-e2e.js:2428-2444`：prompt 只有 `title: 测试` 时，一条 deny 同时包含 artifact_dir 与 operation 缺失。
- `tests/test-hooks-e2e.js:2446-2461`：prompt 已有 `operation: create-chg` 时，不重复追加 operation 提示。

边界缺口：

- `promptFieldValue()` 使用 `\s*`，会跨换行吞掉下一字段（`agent-lifecycle-guard.js:261-263`）。
- `promptDeclaredOperation()` 直接取 `promptFieldValue(prompt, 'operation')` 的首 token（`agent-lifecycle-guard.js:395-397`）。
- 实测：
  - `title: 测试` -> 新提示出现。
  - `operation:\ntitle: 测试` -> 新提示不出现。
  - `artifact_dir: /tmp/art/\noperation:\ntitle: 测试` -> lifecycle 报 `operation「title:」不在受支持的 8 类指令内`，不是“缺少明确 operation”。

建议修法：给 operation/action 这类 lifecycle 字段改用 same-line parser，或至少让 `promptFieldValue()` 的分隔空白不跨换行；补一条 e2e 锁 `operation:` 空值应按 missing operation 处理。

### T-002 勘误约定文档化

状态：成立。

`plugin/agent-references/artifact-writer-spec.md:368-370` 新增“create 时规划态前提被证伪的勘误约定”：不重写 create 段，改走 `update-chg section=work-record action=append` 追加醒目勘误。这个修的是未来操作协议；当前远端 tracked repo 没有 `changes/**` artifact 文件，因此本审计没有可核实的历史 CHG 详情修正文档。

### T-003 `PACE_RELEASE_BASE` 发布验证入口

状态：正确修复，v7.2.8 审计 P3 已关闭。

- `CLAUDE.md:32-34` 明确发布后使用 `PACE_RELEASE_BASE=<上一个 release 的 commit> node tests/run-all.js`。
- `REFERENCE.md:246-247` 同步了同一入口。
- `tests/run-all.js:15-20` 的 `whitespaceCheckRanges()` 在 release base 置位时追加 `<base>..HEAD`。
- `tests/run-all.js:27-34` 的 `gitWhitespaceCheck()` 实际执行该区间。
- 本次用 `PACE_RELEASE_BASE=f2ef778 node tests/run-all.js` 实跑通过，证明文档入口和 runner 行为连通。

### 死参清理

状态：正确，未发现行为漂移。

- `legacyArtifactWriterLockDenyReason()` 不再接收未用 `lock` 参数，调用点同步为无参；原本输出只依赖固定文案，`emitDeny` fields 里仍保留 `lock` / `owner`。
- `artifactResourceLockDenyReason()` 不再接收未用 `lockAttempt` / `resource` 参数，只保留实际用于文案的 `artifactRel`；`emitDeny` fields 里仍保留 `resource` 与 `reason`。

## 已知未修项复查

### 已关闭

- **v7.2.8 审计：`PACE_RELEASE_BASE` 文档默认入口缺失。** v7.2.9 已补 `CLAUDE.md` 与 `REFERENCE.md`，并用 release base 实跑 `run-all` 通过。

### 仍未修，理由基本成立

- **budget head 严格硬上限。** `tests/test-session-layers.js:201-208` 仍明确锁定“head 超 9500 也全保留，只置 `headOverflow`”；`SL-SAT` 则锁满载 20 CHG 下 cap 后不超预算（`tests/test-session-layers.js:237-252`）。这仍是已知设计取舍，不是 v7.2.9 本批目标。
- **真 artifact-writer agent contract suite 休眠。** `tests/agent-tests/README.md:8-11` 仍写明真套件不在 `run-all` 内、dummy 只测 mock 框架、fixtures 仍 v6、真实跑停在 2026-06-02。v7.2.9 未触碰此项。
- **foreign worktree 写码搭便车。** `tests/test-hooks-e2e.js:7865` 仍有现状锁定用例：foreign worktree 写码由当前测试明确保持放行。是否收紧仍是产品边界裁定。
- **README v7.2.5 hardDeny 计数抗误读。** v7.2.9 未修改该历史行；按 v7.2.8 审计结论，实质不构成必须修 bug，但可读性仍可优化。

### 仍未修，不能视为关闭

- **Stop `background_tasks` 字段漂移。** `plugin/hooks/stop.js:80` 仍只读取 `raw.background_tasks`；若上游 harness 字段名或结构已漂移，仍需要冷启动 dump-stdin 探针确认。当前 e2e 覆盖的是既定 `background_tasks` 形态，不等于验证了真实最新 harness。

## 审计边界

- 本审计只审远端 tracked 发布面；未审本地未跟踪审计文档、未跟踪 `2026-06-12-...txt`、以及不在 git 中的外部 vault artifact。
- 未执行真实 marketplace 安装/升级，只执行 `claude plugin validate ./plugin`。
- 未跑真实 artifact-writer LLM agent contract suite，只跑了 `tests/agent-tests/run-tests.js dummy` 所在的 helper 自动回归。
- 未做 Stop dump-stdin 冷启动探针，因此不声称已确认最新 Claude Code harness 的真实 `background_tasks` 字段形态。
