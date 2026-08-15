# PACEflow 移植 Codex CLI 可行性研究(2026-08-15)

> 状态:研究结论,未进入实现。分支 `research/codex-port`。
> 方法:本机 codex-cli 0.147.0 一手实测(探针 fixture 5 次 `codex exec` 会话 + PACEflow 真 hooks 直接挂 Codex)+ 官方文档(developers.openai.com/codex/hooks、/agent-configuration/subagents、/config-advanced)+ 两路研究 agent(扩展面 / 生态先例,二手已甄别)。
> 探针数据:session scratchpad `codex-port/probe-repo/probe-dump*.jsonl`、`pace-on-codex/pace-on-codex.log`。
> 本文属仓库维护材料(`docs/`),不随 marketplace runtime 发布。

## 一句话结论

**可以移植,且比预期容易得多——Codex 官方 hooks 系统与 Claude Code 高度同构并明确兼容 Claude 插件 hooks(自动设 `CLAUDE_PLUGIN_ROOT`)。两个确定性门(写码门 / Stop 门)加一个 ~40 行 apply_patch 适配层即可跑通(已实证);artifact-writer 子代理层是结构性障碍(派遣 prompt 加密不可读 + 子代理内 hooks 实测零触发),需改用不同机制;skill 层可移植但注入时机不同。**

## 一手实测证据(决定性)

| # | 实验 | 结果 |
|---|------|------|
| E1 | PACEflow 探针 probe.js 零改动挂 Codex 项目级 `.codex/hooks.json` | SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd **全触发**,stdin 字段(session_id/cwd/tool_name/tool_input/permission_mode)与 Claude Code 高度重合 |
| E2 | Codex 文件写入的 hook 形态 | `tool_name: apply_patch`,`tool_input.command` 为 patch 文本(`*** Add File: <abs>` / `*** Update File:` / `*** Delete File:`),**无 file_path** |
| E3 | PACEflow 真 pre-tool-use.js 直接挂 Codex,让模型写 hello.py | 拦下,`DENY_BAD_TOOL`(fail-closed 白名单不认 apply_patch)——deny 文案完整回流,模型服从停止;**证明整条 hook 链路已通,差的仅是 tool 名适配** |
| E4 | 加 40 行 apply_patch→Write/Edit 适配层后重跑(artifact-root 已配) | **`DENY_V6_NO_ACTIVE` 精准触发**——「本项目没有活跃 CHG,请先创建 CHG」,hello.py 未创建。写码门在 Codex 上真实生效 |
| E5 | 自定义 agent(`.codex/agents/note-writer.toml`)派遣 + 子代理内 hooks | 派遣工具 `collaborationspawn_agent`,`tool_input.agent_type` 可读(=可识别 artifact-writer 身份)但 **`message` 是加密 blob(prompt 不可读)**;**子代理内 apply_patch 零 PreToolUse、SubagentStart/SubagentStop 零触发**(项目级与用户级 CODEX_HOME 隔离双重实证,`codex exec` 模式) |
| E6 | Session 身份 | PACEflow session.js 的 `CLAUDE_CODE_SESSION_ID` env 兜底在 Codex 会话里读到了外层 Claude session id——移植需以 stdin `session_id` 为准、去掉该 env 兜底或改名 |

## 逐层移植度

### hooks 层(PACEflow 内核):**~85% 可移植,已实证核心门**

| PACEflow 依赖 | Codex 对应 | 状态 |
|---|---|---|
| hooks.json 三层结构(event → matcher → command handlers) | 完全同构,官方支持 `.codex-plugin/plugin.json` + `hooks/hooks.json` 默认发现;`${CLAUDE_PLUGIN_ROOT}` 兼容注入 | ✅ 零改 |
| PreToolUse deny(`hookSpecificOutput.permissionDecision: "deny"`) | 同形态支持,另支持 exit 2 + stderr | ✅ 零改 |
| Stop 阻止(exit 2 + stderr) | 同语义(Codex 把 reason 作为新 continuation prompt) | ✅ 零改 |
| SessionStart 注入(stdout 纯文本 / additionalContext) | 同构;`source` 值域 startup/resume/clear/compact 一致;`additionalContextLimit` 默认 ~2500 tokens(比 Claude 10K chars 严,需调高或拆分) | ⚠️ 预算调整 |
| UserPromptSubmit additionalContext | 同构 | ✅ 零改 |
| SubagentStart/SubagentStop | 事件存在但 **exec 模式实测零触发**(E5) | ❌ 待交互模式复测 |
| PostToolUseFailure / StopFailure / Notification | 不存在 | ❌ 三个 logging/提示 hook 退化(非核心) |
| Stop 的 `background_tasks` | 无此字段 | ⚠️ 后台软放行分支自然不生效(退化为原硬门语义,可接受) |
| tool_name 白名单(Write/Edit/MultiEdit/Bash/…) | Bash 同名;文件写入是 `apply_patch`(matcher 可写 `Edit\|Write` 别名但 stdin 仍报 apply_patch);Agent 派遣是 `collaborationspawn_agent` | ⚠️ **适配层**:解析 patch 头翻译为 Write/Edit + file_path;派遣 tool 名映射 |
| bash-guard(禁 Bash 改 artifact) | Bash 形态相同 | ✅ 零改 |
| 项目级 hooks 需信任 | Codex 要求 `/hooks` 审查信任(hash 绑定),自动化用 `--dangerously-bypass-hook-trust` | ⚠️ 安装体验差异 |

### subagent 层(artifact-writer):**~30%,结构性障碍**

| PACEflow 依赖 | Codex 现状 | 影响 |
|---|---|---|
| 自定义 agent 定义(markdown + tools 白名单 + model) | `.codex/agents/*.toml`(name/description/developer_instructions + model/sandbox_mode);**无 per-agent 工具白名单** | 可定义 artifact-writer 角色,但不能限制其只用 Read/Write/Edit/Bash |
| 派遣门读 prompt 字段(operation/target/approval-confirmed 等 10 道检查) | `collaborationspawn_agent` 的 `message` **加密不可读** | ❌ **整套字段门/V→R 偏序门无法在派遣时刻执行**——这是 PACEflow「确定性网关 > LLM-soft」内核的一半 |
| 子代理内的写入过 PreToolUse(artifact 完整性门:只有 artifact-writer 身份能写 artifact) | 子代理内 hooks **exec 模式零触发**(E5) | ❌ artifact 完整性门失效;若交互模式也如此,则「唯一写入路径」不变量无法保证 |
| SubagentStop 收口(锁释放/owner 关闭/报告观察) | 零触发 | ❌ |

**替代路径(需设计)**:①放弃「派遣时刻门」,把字段门下沉到**落盘时刻**——但依赖子代理内 PreToolUse 可见,E5 证伪(exec 模式);②不派子代理,artifact 写入改由**主线程直写 + PreToolUse 落盘门**兜底(丢失 context-hygiene 收益,但门仍在);③用 **MCP server** 承载 artifact 写入(artifact-writer 变成 MCP 工具集,PreToolUse 对 `mcp__paceflow__*` 可 matcher 拦截、字段以 MCP 参数形式结构化可读)——**最有前景**,把「读 prompt 猜字段」变成「读 JSON 参数」,反而比 Claude Code 版更确定性。

### skill / 指令层:**~70%**

| PACEflow 依赖 | Codex 对应 |
|---|---|
| SKILL.md 按需加载(pace-workflow/artifact-management/…) | Codex skills(`~/.codex/skills/<name>/SKILL.md`,插件 `skills/` 目录)同构;`skill_search` stable |
| CLAUDE.md 项目指令 | AGENTS.md(同定位) |
| slash commands(/paceflow:enable 等) | 无 plugin commands 概念;改为 skill 或 shell helper 直接调用 |
| SessionStart 注入 10K chars/hook | Codex additionalContextLimit 默认 2500 tokens(可调,官方警告勿设 0) |

## 不能/不宜移植的

1. **派遣时刻的字段门与 V→R 偏序门**(prompt 加密)——除非走 MCP 参数化
2. **子代理身份判定的 artifact 完整性门**(子代理内 hooks 不触发,exec 模式实证;交互模式待验)
3. PostToolUseFailure / StopFailure / Notification 三个观察 hook
4. Stop 的 background_tasks 软放行
5. Claude Code 特有:Agent 工具 `run_in_background`/`name`/`isolation`、SendMessage resume 编排、TaskCreate 系统——Codex 无对应,相关 skill 段落需按 Codex 派遣模型重写

## 建议

- **可做 MVP(1-2 天)**:两个确定性门 + SessionStart/UserPromptSubmit 注入 + apply_patch 适配层 + Codex plugin 打包(`.codex-plugin/plugin.json` + `hooks/hooks.json`),artifact 写入暂由主线程直写 + 落盘门兜底。这已覆盖 PACEflow「防长上下文遗忘」的两个硬门内核。
- **完整移植需先解决**:交互模式子代理 hooks 触发复测(决定 artifact-writer 路线);若仍零触发,走 MCP 参数化路线重做 artifact 写入层(工作量中等,但反而更确定性)。
- **不建议**:为 Codex 维护第二套 hook 源码——现有 hooks 零改动可跑,差异集中在一个适配层 + tool 名映射表,应做成同一代码库的 host adapter(检测 `hook_event_name` 存在 `model`/`turn_id` 字段即 Codex)。

## 未定锚 / 待补

- 交互模式(非 exec)下 SubagentStart/SubagentStop/子代理内 PreToolUse 是否触发(官方文档写会触发,exec 实测不触发)
- `additionalContextLimit` 调高到覆盖 PACEflow SessionStart 9.5K chars 的实际效果
- Codex plugin 安装流(marketplace.json)与 hook 信任审查的用户体验
- 生态先例(等 codex-ecosystem agent 报告)
