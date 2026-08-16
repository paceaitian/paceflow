# CLAUDE.md

本文件只提供本仓库维护入口。不要把它当作 PACEflow 用户工作流规范，也不要在这里放个人回复风格。

PACEflow 的运行时行为必须由以下位置定义：

- Hook 代码：`plugin/hooks/**`
- Agent 契约：`plugin/agents/artifact-writer.md` 与 `plugin/agent-references/**`
- 用户 skill：`plugin/skills/**/SKILL.md` 与其 `references/**`
- 发布/安装说明：`README.md`、`REFERENCE.md`

`CLAUDE.md` 不承担 artifact 创建、批准、验证、归档、Stop gate、worktree owner 或 helper 使用规则的权威职责；这些规则应写回 hooks、skills、agent references 或 README/REFERENCE。

## 维护规则

- 修改运行时行为时，优先改 `plugin/` 下的实际发布面，并补测试。
- `docs/`、`internal/`、`tests/` 是仓库维护材料，不随 marketplace runtime 发布。
- 历史设计文档保留背景时必须标明 historical / pre-implementation，避免旧 v5 或早期 v6 语义被误当当前规则。
- 不要把用户个人格式要求（时间戳、固定结尾、口癖）写进仓库级 `CLAUDE.md`。

## 常用验证

```bash
# 一条命令聚合全部核心套件 + claude plugin validate + git diff --check
# 任一子套件非零退出即整体非零退出，杜绝手敲漏跑某套件致回归静默漏网
node tests/run-all.js

# 迭代时按名分片只跑某套件（子串匹配套件名：pace-utils / hooks-e2e /
# session-layers / migrate-v7 / agent-helpers / codex-adapter / mcp-server / run-all-self / plugin-validate / git-diff-check）
PACE_TEST_FILTER=hooks-e2e node tests/run-all.js

# 发版后核整段 release 区间 whitespace：push 后 @{upstream}..HEAD=0，upstream 区间查不到已推送的
# release diff；显式给上一个 release 的 commit 覆盖整段 release 区间 git diff --check（避免 post-push 盲区）
PACE_RELEASE_BASE=<上一个 release 的 commit> node tests/run-all.js
```

可选本地手动安装检查：如果当前工作区有未跟踪的 `install.js` 与 `tests/test-install.js` 本地副本，可以额外运行 `node tests/test-install.js`。`install.js` / `verify.js` 只作为本地 smoke 或手动安装健康检查工具；marketplace 安装以 `plugin/.claude-plugin/plugin.json`、`plugin/hooks/hooks.json` 和 `plugin/**` 发布面为准。

## 发版

版本号 bump 用 `bump-version.js`，一条命令同步 5 处，**不要手动逐个 Edit**（手动易漏某处或改错 changelog 行）：

```bash
# 从 paceflow/ 运行（或从仓库根 node paceflow/bump-version.js）
node bump-version.js --dry-run v7.2.16   # 先预览将改哪些文件
node bump-version.js v7.2.16             # 同步 6 处：constants.js PACE_VERSION / .claude-plugin/plugin.json / .codex-plugin/plugin.json / marketplace.json / REFERENCE.md 标题 / README.zh-CN.md 版本行（footer）
```

脚本**不覆盖**、仍需手动的两处：

- `README.md` 版本历史表格新增一行 changelog（人读描述，脚本不生成）
- `CLAUDE.md` 等散文里残留的版本号（如有）

收尾走上面「常用验证」：`node tests/run-all.js` 10/10 → commit → push → 三向确认 `git rev-parse HEAD` == `git rev-parse origin/master` == `git ls-remote origin master`（防 commit/push 链短路推旧 HEAD 静默漏发）。

push 三向确认后，**打 tag + 建 GitHub release**——漏这步会让版本史断档、用户看不到 release notes（v7.0~v7.2.14 就因发版流程没写这步全缺、后来批量回填）：

```bash
# tag 打在 release commit（version bump 那个），不是其后的 docs commit
git tag -a v7.2.16 <release-commit> -m "v7.2.16: <一句话标题>"
git push origin v7.2.16

# release notes 从 README changelog 当行整理成文件；gh 未认证先 gh auth login -h github.com
gh release create v7.2.16 --title "v7.2.16 — <标题>" --notes-file <notes-file>
```
