# Codex MVP 立项前探针实测(2026-08-15,codex-cli 0.147.0,独立 CODEX_HOME)

> 分支 `feat/codex-mvp`(自 research/codex-port 切出)。探针环境:scratchpad `codex-mvp/`(home = 独立 CODEX_HOME;mkt = 本地 marketplace `pace-mvp`;plugins/pace-probe = 探针插件;proj = 被管项目)。
> 用户决策:MVP 的 artifact 写盘走 **MCP**(不派子代理)。

## 一手结果(全部 `codex exec --dangerously-bypass-hook-trust < /dev/null` 实测)

| # | 问题 | 结果 |
|---|------|------|
| M1 | `.codex-plugin/plugin.json` 声明 `"hooks": "./hooks/hooks.codex.json"` 能否加载 | ✅ 加载(CUSTOM 标签触发);**默认位置 `hooks/hooks.json` 未被同时加载**(DEFAULT 标签零触发)——声明即替换,不双载。因此 Claude 形态 `hooks/hooks.json`(command+args)与 Codex 形态 `hooks/hooks.codex.json`(单 command 字符串)可并存于同一插件目录 |
| M2 | `.codex-plugin` 与 `.claude-plugin` 两 manifest 并存时 | ✅ Codex 取 `.codex-plugin`(hooks 走 CUSTOM2 路径),`.claude-plugin` 的 commands 不影响 |
| M3 | `${CLAUDE_PLUGIN_ROOT}` 在 hooks command 里 | ✅ 展开(从 `$CODEX_HOME/plugins/cache/pace-mvp/pace-probe/0.0.2/hooks/` 触发) |
| M4 | `${CLAUDE_PLUGIN_ROOT}` 在 `mcpServers.<name>` 里 | ❌ 在 `command`/`args`/`env` 里**均不展开**(`codex mcp list` 原样显示占位符,server 起不来,模型直接编造工具输出);`sh -c "$CLAUDE_PLUGIN_ROOT/…"` 也不行(server env 被过滤)。✅ **解法:`"cwd": "."`**——mcpServers 的相对 `cwd` 以插件根(cache 目录)为基准解析(`codex mcp list` 显示 `<plugin-root>/.`),配 `args:["mcp/server.js"]` 或 `command:"./mcp/run.sh"` 三种写法全部拉起(第二轮 G/H/I 实测);此时 server `process.cwd()` = 插件根,项目 cwd 只能从 `_meta.workspaces` / hook 注入参数取 |
| M5 | PreToolUse 对 `mcp__paceflow__*` 触发 + `updatedInput` 改写参数 | ✅ 触发,`tool_input` = 原始参数对象;返回 `permissionDecision:"allow"+updatedInput` 后 **server 收到的参数已含注入的 `_session_id/_cwd`**——hook 可把可信的 session/cwd 注进 MCP 参数 |
| M6 | MCP server 能否自己拿到 session/cwd | ✅ **原生可拿**:`tools/call` 的 `params._meta["x-codex-turn-metadata"]` 含 `session_id / thread_id / turn_id / workspaces{<cwd>} / model / sandbox`,另有 `_meta.plugin_id`、`threadId`;server 进程 `process.cwd()` = 项目 cwd;env 被过滤(无任何 CODEX_*/CLAUDE_* 变量) |
| M7 | Bash 工具环境变量 | ✅ 有 **`CODEX_THREAD_ID`**(= hook stdin 的 session_id)、`CODEX_HOME`、`CODEX_CI=1`;无 `CLAUDE_CODE_SESSION_ID`(本机因在 Claude 内嵌套跑,另见到 `CODEX_COMPANION_SESSION_ID`= 外层 Claude session,与 E6 同源,产品须优先 stdin/`CODEX_THREAD_ID`) |
| M8 | 插件安装形态 | `codex plugin add` 把插件**拷贝**到 `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/`;改动后必须 bump version(或 `+codex.<cachebuster>`)重装才生效;本地 marketplace 布局 `<root>/.agents/plugins/marketplace.json` + `<root>/plugins/<name>/` |

## 对 MVP 设计的直接含义

1. **同一插件目录双 manifest 双 hooks 文件**可行:`.claude-plugin/plugin.json`+`hooks/hooks.json`(原样)与 `.codex-plugin/plugin.json`(hooks→`hooks/hooks.codex.json`,mcpServers 内联)并存,互不干扰(M1/M2)。
2. **session 身份**:hooks 走 stdin `session_id`;helper(reserve 等)在 Codex Bash 里可读 `CODEX_THREAD_ID`(M7)——`session.js` 加此 fallback 即可让 reservation owner 对齐;MCP server 用 `_meta` 拿 session/cwd(M6),hook 侧 `updatedInput` 注入(M5)可作交叉校验/兜底。
3. **MCP server 启动路径已解**(M4 第二轮):`mcpServers.paceflow = {command:"node", args:["mcp/paceflow-server.js"], cwd:"."}`;server 进程 cwd = 插件根,项目 cwd 从 `_meta["x-codex-turn-metadata"].workspaces` 取。
4. PreToolUse 对 MCP 工具可 deny + 可读结构化参数 → 派遣门可以把 MCP 参数序列化成 artifact-writer 的 `key: value` 字段文本,**原样复用 agent-lifecycle-guard 全部门**(operation 白名单/必填/V→R 偏序/owner/reservation),零重复实现。

## 待办(下一步探针)
- ~~M4 三候选实测,选定 MCP 启动方式~~ 已解:`cwd:"."`
- Codex 下 SessionStart 纯文本→JSON 包装、Stop 的 stdout JSON 约束、apply_patch 多文件适配在真 hooks 上的行为(研究阶段 E1-E4 已证单文件)
- 交互模式(非 exec)子代理 hooks 触发复测(研究「待补」项,MCP 路线下优先级降低)
