# Claude Code 插件 MCP 探针实测（2026-08-16）

> 目的：回答「Claude Code 宿主能否像 Codex 一样，用插件自带 MCP server 替代 `artifact-writer` 子代理写 artifact」的四个宿主前提。
> 可信度：**一手实测**（探针 fixture + headless 子会话），非 changelog/文档二手。宿主 Claude Code **2.1.232**，Linux（WSL2），Node v24.14.1，模型 haiku。
> 方法：沿用 `docs/claude-code-2.1.126-2.1.232-paceflow-evaluation.md` §五 的探针方法——scratchpad 建独立探针插件 `pace-probe`（`--plugin-dir` 会话级加载），hooks 只 dump stdin / 定向注入 / 定向 deny，MCP server 只 dump 启动信息与每条请求并回显参数；`claude -p … --output-format stream-json --verbose` 捕获整段事件流。fixture 与原始 JSONL 在 scratchpad `cc-mcp-probe/`（会话级临时目录，本文已摘录全部关键字段）。

## 一、结论表

| # | 问题 | 结论 | 证据 |
|---|------|------|------|
| P1 | PreToolUse / PostToolUse 对 plugin MCP 工具是否触发；`tool_name` 形态；`mcp__.*` matcher 是否命中 | ✅ 两者都触发。**tool_name = `mcp__plugin_<plugin>_<server>__<tool>`**（本例 `mcp__plugin_pace-probe_probeA__echo`），非 Codex 形态 `mcp__<server>__<tool>`。matcher `mcp__.*` 与空 matcher 均命中 | hooks.jsonl：`pre-mcp` / `pre-any` / `post-mcp` 三条各对同一 tool_use_id 触发；stdin 字段 `session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id`（Post 另有 `tool_response, duration_ms`） |
| P2a | PreToolUse 返回 `permissionDecision:allow` + `updatedInput` + `additionalContext` 三者是否共存生效 | ✅ 全部生效：`updatedInput` 追加的 `_pace_session_id / _pace_cwd / _pace_marker` **原样到达 MCP server 的 `tools/call.params.arguments`**；`additionalContext` 中的暗码 `PROBE-CTX-7f3a` 出现在模型最终回复；PostToolUse 的 `tool_input` 已是**注入后**的参数 | serverA.jsonl `tools/call` 参数；s1/s2 事件流末行 |
| P2b | `permissionDecision:deny` 是否拦住 MCP 调用 | ✅ server **零收到**（S2 全程 `tools/call` 仅 1 次 = 被允许的 echo），模型看到 `permissionDecisionReason` 原文 | serverA.s2.jsonl；s2 事件流 tool_result = `PROBE-DENY-4b2d: …` |
| P2c | `default` 权限模式（非 `--dangerously-skip-permissions`）下 hook `allow` 是否等价于授权 | ✅ **hook allow = 免提示放行**：对照组 `echo_plain`（hook 不表态）在 default 模式被拒 `Claude requested permissions to use … but you haven't granted it yet`（`result.permission_denials` 记一条），而 hook allow 的 `echo` 直接执行 | s2（allow 通过）vs s3（对照组被拒） |
| P3a | `.claude-plugin/plugin.json` `mcpServers` 里 `${CLAUDE_PLUGIN_ROOT}` 是否展开 | ✅ **args 与 env 均展开**（与 Codex 相反——Codex 均不展开） | serverA 启动 dump：`argv[1]` = 插件根绝对路径；`env.PROBE_ENV_ROOT` = 插件根 |
| P3b | `mcpServers.<name>.cwd` 是否支持 | ❌ **不生效**：`cwd:"."` + 相对 args → `MODULE_NOT_FOUND`（相对路径按**项目 cwd** 解析）；`cwd:"${CLAUDE_PLUGIN_ROOT}"` 亦 `failed`。Claude 侧必须用 `${CLAUDE_PLUGIN_ROOT}/…` 绝对路径 | mcp-logs-plugin-pace-probe-probeB：`Cannot find module '<proj>/mcp/server.js'`；两轮 init `status:"failed"` |
| P3c | server 进程 cwd / env | `process.cwd()` = **项目 cwd**（Codex 是插件根）；env **完整透传**（71 个），含 `CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`（`~/.claude/plugins/data/<plugin>`）、`CLAUDE_PROJECT_DIR`、**`CLAUDE_CODE_SESSION_ID`**、`CLAUDECODE=1`、`CLAUDE_PID`、`CLAUDE_CODE_ENTRYPOINT=sdk-cli`、`CLAUDE_EFFORT`（Codex 是空 env） | serverA 启动 dump |
| P3d | `tools/call` 的 `_meta` 是否带 session/cwd | ❌ 只有 `{"claudecode/toolUseId":"toolu_…","progressToken":N}`——无 session、无 cwd、无 workspaces（Codex 有 `x-codex-turn-metadata`） | serverA.jsonl |
| P3e | 客户端握手 | `initialize.protocolVersion = 2025-11-25`，`clientInfo.name = claude-code`，capabilities `roots.listChanged` + `elicitation`；序列 `server/discover → initialize → notifications/initialized → tools/list` | serverA.jsonl |
| P4 | plugin MCP 工具是否被 defer（需先 `ToolSearch`） | ✅ **被 defer**：init `tools` 列表含 `mcp__plugin_pace-probe_probeA__*` 与 `ToolSearch`；模型每次都先 `ToolSearch select:<全名>` 再调用；模糊查询（`"probeB echo"`）会返回不相关工具，**skill 必须给出精确全名** | s1/s2/s3 事件流 tool_use 序列 |

## 二、对「Claude Code 也走 MCP」设计的直接含义

1. **manifest**：`.claude-plugin/plugin.json` 加 `mcpServers.paceflow = { command:"node", args:["${CLAUDE_PLUGIN_ROOT}/mcp/paceflow-server.js"] }`——不写 `cwd`；与 `.codex-plugin`（`cwd:"."` + 相对 args）是两份文件、各用各的写法，互不干扰。
2. **hook 桥**：`hooks/hooks.json` PreToolUse/PostToolUse 加 matcher `mcp__plugin_paceflow_paceflow__.*`（安装后须用真实插件名复核一次全名——名字由 plugin name + server name 拼接）；把 `codex-adapter.js` 里「MCP 调用 → 合成 artifact-writer 派遣事件 → 过真派遣门 → `updatedInput` 注 `_pace_*` + 合并 `additionalContext`」抽成宿主无关模块，两宿主共用。**hook allow 同时就是授权**（P2c）——派遣门必须先校验再 allow，deny 时 server 零执行（P2b），与 Codex 语义一致。
3. **server 侧上下文来源优先级**：hook 注入 `_pace_session_id / _pace_cwd` > env `CLAUDE_CODE_SESSION_ID / CLAUDE_PROJECT_DIR`（进程启动快照，`/clear` 换 session id 后是否陈旧**未验**）> `process.cwd()`（= 项目 cwd，可靠）。`_meta` 无用。
4. **skill 文案**：给精确工具全名并写明「先 `ToolSearch select:mcp__plugin_paceflow_paceflow__create_chg`」（P4）；否则模型模糊搜索会拿错工具或判定不存在。
5. **PostToolUse 看到的是注入后参数**（P2a）——现有 post-tool-use 逻辑若按 `tool_input` 做校验/日志，能拿到 `_pace_*`。

## 三、未验 / 后续

- `/clear`、`--resume`、`--continue` 后 MCP server 进程是否复用、env 里的 `CLAUDE_CODE_SESSION_ID` 是否陈旧（headless 难以模拟，需交互会话或 SDK 验）。
- 真实安装（marketplace cache）下的插件名/工具全名与 `--plugin-dir` 会话级加载是否一致。
- Windows 路径（`${CLAUDE_PLUGIN_ROOT}` 反斜杠、`node` spawn）——按仓库惯例以 CI windows-latest 为准。
- `plan` 权限模式 / Agent Teams 下的 hook allow 语义。
- 每 op 逐次 spawn 真 hook 的耗时（finding P3 已记）在 Claude 侧成主路径前需合并同文件预检。

## 附：探针 fixture 摘要

- `plugin/.claude-plugin/plugin.json`：`hooks:"./hooks/hooks.json"`；`mcpServers.probeA`（`args:["${CLAUDE_PLUGIN_ROOT}/mcp/server.js","A"]`，`env:{PROBE_ENV_ROOT:"${CLAUDE_PLUGIN_ROOT}",PROBE_PLAIN:"plain-ok"}`）、`probeB`（`args:["mcp/server.js","B"]`，`cwd:"."` / 第二轮 `cwd:"${CLAUDE_PLUGIN_ROOT}"`）。
- `hooks/hooks.json`：PreToolUse `mcp__.*`→`dump.js pre-mcp`、``→`dump.js pre-any`；PostToolUse `mcp__.*`→`dump.js post-mcp`。`dump.js`：dump stdin；`*__echo` → allow + updatedInput(`_pace_*`) + additionalContext(暗码)；`*__echo_deny` → deny；其他不表态。
- `mcp/server.js`：NDJSON stdio；dump 启动 argv/cwd/env(CLAUDE|PROBE|MCP 前缀)；工具 `echo` / `echo_plain` / `echo_deny` 回显 `received_arguments` + `_meta` + `server_cwd`。
- 三次会话：S1（skip-permissions；echo A + echo B）、S2（default 模式；echo / echo_deny / echo B）、S3（default 模式；echo_plain 对照）。命令：`env -u CLAUDE_PROJECT_DIR -u CLAUDE_CODE_SESSION_ID claude -p "<prompt>" --plugin-dir <fixture>/plugin --model haiku [--dangerously-skip-permissions] --output-format stream-json --verbose`。
