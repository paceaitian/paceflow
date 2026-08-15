# Codex CLI 可扩展面研究报告 — PACEflow 移植可行性(研究 agent 原文存档)

> 来源:研究 agent `codex-ext-surface`(opus),2026-08-15。本机 codex-cli 0.147.0,独立 CODEX_HOME 实测 + 二进制 strings 挖掘 + 官方文档。原文存档,主 session 已逐条对照一手实测(见 research-2026-08-15-codex-port-feasibility.md)。

**环境**:codex-cli 0.147.0(`~/.codex/packages/standalone/releases/0.147.0-x86_64-unknown-linux-musl/bin/codex`,247MB Rust 二进制)。所有实测在独立 `CODEX_HOME=<scratchpad>/codex-home` 下进行。

**核心结论先行**:Codex 的 hook 系统不是"类似 Claude Code",而是**照着 Claude Code 协议实现的**。二进制内嵌 JSON Schema 里留着原话:

> `"reason"`: `"description": "Claude requires \`reason\` when \`decision\` is \`block\`; we enforce that semantic rule during output parsing rather than in the JSON schema."`

且 `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` 字面量直接躺在 Codex 二进制的 hook 引擎字符串区里。

---

## 0. 方法论警告:`features list` 的 `removed` ≠ 功能不可用

`codex features list` 输出里 `plugin_hooks removed false`、`external_migration removed false`,但两个硬实测反证:

| flag | features list | 实测结果 |
|---|---|---|
| `plugin_hooks` | `removed false` | 插件自带 `hooks/hooks.json` **确实被加载并触发**(PACEflow 装进去后 SessionStart×2 / UserPromptSubmit / Stop 全部触发) |
| `external_migration` | `removed false` | `.claude-plugin/plugin.json` **实测安装成功**,且 `commands/*.md` 被自动转换成 skills |

`removed` 的语义是"这个 gate 已从代码里拿掉"——功能要么已并入主路径成为默认行为,要么真的删了,两种情况在表里长得一模一样。**不能拿 `removed` 反推能力缺失,必须实测。**

相关 flag:hooks stable true / plugins stable true / plugin_sharing stable true / remote_plugin stable true / skill_search stable true / guardian_approval stable true / multi_agent stable true / multi_agent_v2 stable false / exec_permission_approvals under development / request_permissions_tool under development / plugin_hooks removed / external_migration removed / multi_agent_mode removed。

---

## 1. 生命周期 hooks — **确认存在**,协议与 Claude Code 同构

**11 个事件**(二进制内嵌 21 份 JSON Schema,按 `<event>.command.<input|output>` 命名):

| Codex 事件 | Claude Code | 说明 |
|---|---|---|
| PreToolUse | ✅ 同名 | 可 deny |
| PostToolUse | ✅ 同名 | 只能事后反馈 |
| UserPromptSubmit | ✅ 同名 | |
| Stop | ✅ 同名 | 可 block |
| SubagentStop | ✅ 同名 | 可 block |
| SessionStart | ✅ 同名 | 可注入 additionalContext |
| SessionEnd | ✅ 同名 | **不可阻断**(schema 无 .output) |
| SubagentStart | ✅ 同名 | |
| PreCompact | ✅ 同名 | |
| **PermissionRequest** | ❌ Codex 独有 | 专管审批请求,可 allow/deny |
| **PostCompact** | ❌ Codex 独有 | |
| — | **Notification** | **Codex 确认不存在** |

**协议**:外部进程,stdin JSON,stdout JSON,exit 2 + stderr 阻断。实测 PreToolUse payload 字段:session_id / turn_id / transcript_path / cwd / hook_event_name / model / permission_mode / tool_name / tool_input / tool_use_id。`permission_mode` 枚举同名(default / acceptEdits / plan / dontAsk / bypassPermissions)。Codex 扩展 model / turn_id / agent_id / agent_type。

**deny 实测生效**,三种写法均支持:`hookSpecificOutput.permissionDecision: "deny"`(枚举 allow/deny/ask,ask 未实现)、旧式 `{"decision":"block","reason"}`、exit 2 + stderr。支持 `permissionDecision:"allow"` + `updatedInput` 改写入参。

**Stop 阻断实测生效**,语义:把 reason 当作新的用户提示续跑;第二次 Stop(`stop_hook_active: true`)才放行。对 PACEflow Stop gate 用途语义等价。

**超时**:`timeout` 单位秒,实测生效——超时 hook 被杀标 Failed,会话照常继续(软失败)。node 冷启动 + 文件扫描要留足预算。

**配置位置(四层)**:`~/.codex/hooks.json` ✅实测、config.toml `[hooks]` 内联、`<repo>/.codex/hooks.json`、**插件的 `hooks/hooks.json`** ✅实测。

**Command handler 字段(6 个)**:command、commandWindows、timeout、async、statusMessage、additionalContextLimit。**没有 `args` 字段**。

**hook trust**:非 managed command hook 按内容 hash 记录信任,新建/改动后默认跳过,需 `/hooks` 审阅;`--dangerously-bypass-hook-trust` 一次性绕过。企业 `requirements.toml` 可设 `allow_managed_hooks_only = true` 屏蔽所有 user/project/session/plugin hook——**PACEflow 在受管企业环境可能被整体禁用的风险点**。

**Codex 独有增强**:handler type 除 command 外还有 **prompt** 和 **agent**(二进制 `HookHandlerConfig::Command/::Prompt/::Agent`)。

**大输出**:超约 2500 token spill 到 `<temp_dir>/hook_outputs/<session_id>/<uuid>.txt`,模型拿头尾预览,阈值 `additionalContextLimit` 可调——比 Claude Code 10K chars 硬截断更友好。

差距:无 Notification;SubagentStart/SubagentStop 实测未触发(第 3 节);handler 无 args;stdout 必须 JSON(Claude 允许 SessionStart 纯文本)。

---

## 2. 权限/审批模型与 guardian_approval — PACEflow 站在更外层

`approval_policy`: untrusted / on-request / never。`sandbox_mode`: read-only / workspace-write / danger-full-access。

**guardian_approval(stable 默认开)是自动审批评审器,不是 PreToolUse 对应物**——用模型评估风险自动裁决(`GuardianAssessmentPayload`: risk_level / user_authorization / outcome / rationale),同时管网络访问策略。方向与 PACEflow 相反(放宽 vs 收紧)。

**实测:PACEflow deny 不被 Guardian 冲掉,且站在更外层。**
- 实验 A(guardian on + auto_review + on-request + workspace-write,PreToolUse deny):照拦,PermissionRequest 根本没触发。
- 实验 B(approval_policy=untrusted 强制审批,PreToolUse 放行):链路 PreToolUse → PermissionRequest(hook 返回 deny)→ `exec_command failed: Rejected` → Blocked。

**执行顺序:PreToolUse →(需审批时)PermissionRequest → 执行。两层都能 deny,hook deny 优先于 Guardian。** 写码门放 PreToolUse 即最外层,不受 Guardian / approval_policy / sandbox_mode 任何组合影响(never+danger-full-access 与 untrusted+workspace-write 两极端各验一次)。PermissionRequest 是白送的第二道门。其 `updatedInput/updatedPermissions/interrupt` 是保留位,填了 fail closed。

---

## 3. 子代理派遣 multi_agent — 确认存在,但拿不到约束力

自定义 agent 是 **TOML**(`~/.codex/agents/` 或 `<repo>/.codex/agents/`),必填 name / description / developer_instructions,可选 model / model_reasoning_effort / sandbox_mode / mcp_servers / skills.config。实测创建 `artifact_writer` 并派遣成功,developer_instructions 生效(埋点前缀 `ARTIFACT_WRITER_ACK_8Q4:` 回传)。

派遣工具 `collaborationspawn_agent`,参数 `{agent_type, fork_turns, message, task_name}`。内置 default / worker / explorer。`[agents]` 表配置。二进制模块 `multi_agents/spawn.rs`、`wait.rs`、`send_input.rs`、`close_agent.rs`、`resume_agent.rs`、`multi_agents_v2/`。

**差距(全压在 artifact-writer 上)**:
1. **没有工具白名单**——只能靠 sandbox_mode + MCP 挂载范围粗粒度约束,"只准碰 artifact"从硬约束降级为软指令。
2. **`message` 加密**(Fernet 形态 `gAAAAAB…`)——hook 拿不到子代理 prompt 明文,无法校验派遣内容。
3. **SubagentStart/SubagentStop 未触发**——schema 齐备,两种 matcher 配置两次独立实测日志文件都没创建;归「需交互模式复验」(exec 非交互路径确认不触发)。

---

## 4. Skills / 指令注入 — 零改动直接可用

SKILL.md 格式**完全同构**(YAML frontmatter,Codex 只读 name + description 决定加载)。路径 `$CODEX_HOME/skills` 与插件 `skills/` 自动发现。AGENTS.md = CLAUDE.md 等价物。

**实测最强证据**:PACEflow 插件挂本地 marketplace 安装后 Codex 自报 skill:`paceflow:artifact-management / pace-bridge / pace-knowledge / pace-workflow` + `paceflow:source-command-disable/-enable/-pause/-resume/-status`(自动从 commands/ 转换)——4 skill 零改全部被发现,plugin.json 未声明 skills 字段,纯靠默认发现。

差距:正文里 Claude 专有工具名(AskUserQuestion、Skill(paceflow:…))需改写;非标准 frontmatter 字段 Codex 不读(无害)。

---

## 5. 插件系统 — Codex 原生识别 `.claude-plugin`

二进制中三种 manifest 并列:`.codex-plugin/plugin.json` / `.claude-plugin/plugin.json` / `.cursor-plugin/plugin.json`。

**实测**:PACEflow(仅有 .claude-plugin)经 `codex plugin add paceflow@pace-probe` **安装成功**,版本 7.2.32 正确读取,自动生成 `.codex-plugin/migrated-command-skills/`(5 个 commands/*.md 转 SKILL.md)。marketplace 布局 `<root>/.agents/plugins/marketplace.json`,个人默认 `~/.agents/plugins/marketplace.json`。plugin.json 支持 hooks(默认 hooks/hooks.json)/ skills / mcpServers / apps / interface。官方 plugin-creator 文档自相矛盾(spec 列 hooks 字段,validator 说拒绝)——实测不声明也靠默认发现生效。

`/import` + `external-agent-migration` 模块支持从 claude-code / Cursor 迁移(MCP servers / hooks / skills / commands / subagents / sessions)。

---

## 6. 会话/上下文管理

`codex resume / fork / archive / unarchive / delete`,`--ephemeral`,`-p/--profile`。SessionStart additionalContext 注入实测生效(埋点 `PACE_MARKER_7F3A` 被模型答出)。source 值域 startup/resume/clear/compact。compact 有 PreCompact + PostCompact。

---

## 7. 移植改造点 — 实测精确定位

PACEflow 插件原样装进 Codex,hooks 被正确加载并全部触发,但全部 Failed——**事件注册层 100% 兼容**,失败全在 handler 层。3 个机械改造点:

**① handler 无 args**:`{"command":"node","args":[…]}` → 合并单 command 字符串。`${CLAUDE_PLUGIN_ROOT}` 原生支持不用改。
**② stdout 必须 JSON**:SessionStart 纯文本输出需包 `hookSpecificOutput.additionalContext`。脚本本体不用改(手工喂 stdin 直跑 session-start.js 行为完全正常)。
**③ 写码门工具形态**:apply_patch + patch 文本,`matcher: "Write|Edit|MultiEdit"` + `tool_input.file_path` 全部失效 → matcher 改 apply_patch,路径提取解析 `*** Add/Update/Delete File:`。Bash 照旧。

外加 2 个能力缺口:SubagentStop 未触发致终态校验失效;subagent 无工具白名单 + spawn message 加密,artifact-writer 强约束降级。skill/command 正文 Claude 专有工具名需改写。

---

## 总判断

| 层 | 可移植度 | 依据 |
|---|---|---|
| **hooks 层** | **85%** | 事件模型/stdin schema/deny/matcher/CLAUDE_PLUGIN_ROOT 全同构实测通过;写码门位置比 Claude Code 更靠外。扣分:3 个机械转换 + SubagentStop 未触发 |
| **subagent 层** | **60%** | 能定义/派遣/设 model+sandbox 实测生效;但无工具白名单、md→toml、prompt 加密、SubagentStop 不触发 |
| **skill 层** | **90%** | 加载零改动通过(4 skill + 5 command 自动转换);仅正文 Claude 专有工具名需改写 |

**一句话**:hooks 和 skills 层几乎白送(Codex 主动做了 Claude 兼容),真正要重新设计的是 **artifact-writer 的隔离保证**——工具白名单缺失 + prompt 加密 + SubagentStop 不触发,三件事叠在同一组件。

**可行替代设计**:PreToolUse 拦 apply_patch 时,把 patch 目标路径是否在 artifact 目录、与 agent_type 字段(PreToolUse input 含 agent_id/agent_type)在同一确定性门交叉判断——比工具白名单迂回但可达,仍是确定性门。

## 官方文档来源

- https://developers.openai.com/codex/hooks(→ https://learn.chatgpt.com/docs/hooks)
- https://developers.openai.com/codex/agent-configuration/subagents
- https://developers.openai.com/codex/build-plugins
- https://developers.openai.com/codex/config-file/config-advanced
- 本机官方 skill:`~/.codex/skills/.system/plugin-creator/references/plugin-json-spec.md`、`skill-creator/SKILL.md`
