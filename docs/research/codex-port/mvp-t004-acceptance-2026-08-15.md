# CHG-20260815-01 T-004 真机验收——PACEflow 插件原样装进 Codex,两硬门 + 注入实测(2026-08-15)

> 环境:codex-cli 0.147.0,独立 `CODEX_HOME`(scratchpad `codex-mvp/home`),本地 marketplace `pace-real` 的 `plugins/paceflow` 软链到 repo `plugin/`,`codex plugin add paceflow@pace-real` 装成 `…/plugins/cache/pace-real/paceflow/7.2.32/`(拷贝)。被管项目 `proj-real`(git 仓库 + `src.js`),`set-artifact-root.js --choice local` 启用 PACE。全部 `codex exec --dangerously-bypass-hook-trust < /dev/null`。
> 插件此时含:`.codex-plugin/plugin.json`(hooks→`hooks/hooks.codex.json`,mcpServers.paceflow 指向尚不存在的 `mcp/paceflow-server.js`)、`hooks/codex-adapter.js`、`session.js` CODEX_THREAD_ID fallback。MCP server 属 CHG-02/03,本轮不在。

## 场景 A:无活跃 CHG,让 Codex 用 apply_patch 建 `hello.py`

- 终端:`hook: PreToolUse Blocked` → 模型回显 deny 原文「本项目没有活跃 CHG/HOTFIX。请先创建 CHG 后再写代码。」+ 完整流程引导(reserve helper 命令 / create-chg 模板 / 逃生口)。
- `hello.py` **未创建**。
- 结论:写码门(DENY_V6_NO_ACTIVE)经 adapter 的 apply_patch→Write 翻译在 Codex 真实生效;deny 文案完整回流。
- 待改进(→CHG-04):deny 文案里「派 artifact-writer create-chg / Skill(paceflow:…)」是 Claude 宿主措辞,Codex 宿主应改说「调 MCP 工具 create_chg」(PACE_HOST=codex 已由 adapter 注入子进程 env,可据此切换 FORMAT_SNIPPETS)。

## 场景 B:有 in-progress CHG(手工种子 `task.md` + `changes/chg-20260815-90-codex-smoke.md`,APPROVED + T-001 `[/]`)

hooks 日志(插件缓存内 `pace-hooks.log`,sid=01a008e2…):

| 时刻 | hook | act | 备注 |
|---|---|---|---|
| 21:44:19 | SessionStart | INJECT group=artifact | output_bytes=2326,adapter 包成 JSON,Codex 报 Completed |
| 21:44:20 | SessionStart | INJECT group=core | output_bytes=3749(+ 宿主提示「=== 宿主: Codex CLI ===」) |
| 21:44:20 | UserPromptSubmit | INJECT candidates=1 category=running chars=66 | 活跃 CHG 一行注入 |
| 21:44:30 | PreToolUse | **PASS_V6** tool=Write | apply_patch Add hello.py → 翻译为 Write → 有活跃 CHG 放行 |
| 21:44:30 | PostToolUse | PASS tool=Write | adapter 对 PostToolUse 同样逐文件翻译 |
| 21:44:57 / 45:12 / 45:22 | Stop | BLOCK ×3 (blockCount 1→3, maxBlocks=3) | 「CHG-20260815-90 还有 1 个未完成任务(完成 0/1)…」——与 Claude 宿主同一 Stop 语义,exit 2 + stderr 被 Codex 当续跑提示 |
| 21:45:25 | Stop | DOWNGRADE | 三次后降级放行,与 Claude 一致 |

- `hello.py` **已创建**(`print("hi")`)。
- 模型最终回复「No callable PACEflow close_chg or update_chg MCP tool is available in this session. Directly editing PACEflow artifacts is prohibited.」——说明它读到了 core 注入里的宿主提示(MCP 工具名),且没有去直写 artifact;MCP server 落地(CHG-02/03)后该闭环即可跑通。

## 结论

CHG-01 四个验收点全部达成:① `codex plugin add` 原样安装、hooks.codex.json 全事件触发且 Codex 全报 Completed(无 Failed);② 写码门 deny/pass 两态真实生效;③ Stop 门 BLOCK/DOWNGRADE 语义与 Claude 一致;④ SessionStart 双组 + UserPromptSubmit 注入均 INJECT。Claude 侧 `claude plugin validate ./plugin` 仍通过,`hooks/hooks.json` 与真 hook 脚本零改动。
