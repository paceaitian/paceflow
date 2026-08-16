# 子代理报告原文：Claude Code 跨机协同宿主能力文档盘点（claude-code-guide，2026-08-16）

> **可信度警告**：本文是 claude-code-guide 研究 agent 基于官方文档（code.claude.com）的**二手**盘点，未经探针实测。已知偏差（主 session 复核）：
> - 「`--mcp-config` 文档未提及」**有误**——`claude --help` 明确列出 `--mcp-config <configs...>  Load MCP servers from JSON files or strings`（2.1.232 实测）。
> - 「`/clear` 后 session_id 不变」与「MCP 工具 defer 无文档」等条目属推断，**以探针为准**（`docs/research/claude-code-plugin-mcp-probe-2026-08-16.md` 已实测：plugin MCP 工具被 defer；`/clear` 行为未验）。
> - 「插件 `plugin.json` mcpServers 仅支持 stdio」与探针一致（`cwd` 字段亦不生效），但「不支持 http」需要在阶段 3 前探针确认。
> 引用本文任何「X 支持/不支持」断言进入设计正文前，须探针定锚（见记忆/方法 host-probe-fixture-method）。

---

## 1. 远程 MCP 传输与配置

### 支持的传输方式

**文档明确写了：**
- **stdio**（默认）：标准输入/输出协议
- **HTTP**：通过 `--transport http` 连接托管服务

**OAuth 授权流程：**
- Claude Code 使用浏览器登陆 + 验证回调（标准 OAuth 2.0）
- Token 存储位置：**文档未提及** —— 推断在 `~/.claude.json` 或系统密钥库
- 静态 Token 方案：`--header "Authorization: Bearer <token>"` 传递

```bash
# OAuth 服务器示例
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp

# 静态 Token 服务器
claude mcp add --transport http github --header "Authorization: Bearer ghp_xxxx" https://mcp.github.com
```

### 配置文件与占位符

**MCP 配置（用户级 `~/.claude.json` 或项目级 `.mcp.json`）：**
```json
{
  "mcpServers": {
    "server-name": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}
```

**插件 `plugin.json` 的 MCP 支持：**
- **仅支持 stdio 类型**（本地进程）✗ 不支持 HTTP/SSE 远程
- 支持的字段：`command`（必需）、`args`（可选）、`env`（可选）
- Claude Code 将所有服务器运行在 stdio 上，即使配置声明 `socket`

**环境变量占位符：**
| 变量 | 含义 |
|------|------|
| `${CLAUDE_PLUGIN_ROOT}` | 插件安装目录（引用脚本、配置、可执行文件） |
| `${CLAUDE_PLUGIN_DATA}` | 插件持久化数据目录（更新后保留） |
| `${CLAUDE_PROJECT_DIR}` | 项目根目录 |

## 2. MCP 工具与 Hooks

### PreToolUse Matcher 命名规则

| 工具类型 | Matcher 模式 | 示例 |
|---------|-------------|------|
| 内置工具 | 精确名称 | `Bash`, `Edit`, `Read` |
| MCP 工具 | `mcp__<server>__<tool>` | `mcp__memory__create_entities` |
| 插件 MCP | `mcp__plugin_<plugin>_<server>__<tool>` | `mcp__plugin_acme_database__query` |
| 正则/管道 | 模式匹配 | `^mcp__memory__.*` 或 `Bash\|PowerShell` |

### Hooks stdin 输入字段

```json
{
  "session_id": "abc123-xyz",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "agent_id": "unique-id",
  "agent_type": "security-reviewer"
}
```

### `hookSpecificOutput` 字段定义

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "原因说明",
    "additionalContext": "提供给 Claude 的额外上下文",
    "updatedInput": { "修改后的": "input" }
  }
}
```

**Exit Code 语义：** 0 成功（解析 JSON 输出）；2 阻止（stderr 作为原因）；其他 非阻止错误。

### MCP 工具的 Defer / ToolSearch

**文档未明确写了** MCP 工具是否被 defer 或 ToolSearch 的控制变量。相关概念存在但无配置项文档；推断 MCP 工具默认延迟加载。（主 session 注：探针已实测 plugin MCP 工具被 defer。）

## 3. Agent Teams（实验特性）

| 特性 | Subagents | Agent Teams |
|------|-----------|-------------|
| 通信 | 仅向主 agent 报告结果 | Teammates 互相直接消息 |
| 协调 | 主 agent 管理工作 | 通过共享任务列表自协调 |
| 上下文 | 结果汇总回主 | 各自独立，仅共享任务 |
| Token 成本 | 低 | 高（每个 teammate 独立实例） |

**任务操作：** TaskCreate / TaskUpdate / TaskList / TaskGet；状态 pending → in progress → completed；`blockedBy` 依赖链（完成被依赖任务才能 claim）；teammate 自主从共享队列领取未分配任务。

**Hooks：** `TeammateIdle`、`TaskCreated`、`TaskCompleted`（exit 2 阻止并反馈）。**权限：** teammates 继承 lead 权限模式，不支持独立设置。

**限制：** 单机架构；无嵌套（teammate 不能再生 teammate）；每 session 一个 team、不跨会话。`ListAgents` / Remote Control 的跨机能力文档未提供。

## 4. 会话身份与生命周期

`CLAUDE_CODE_SESSION_ID`：**文档未明确说明**（hooks 经 stdin `session_id` 访问；主 session 注：探针实测该 env 会传给插件 MCP server 进程）。

| 命令 | Session ID（agent 判断，未实测） |
|------|-----------|
| `claude --continue` | 不变 |
| `claude --resume` | 不变 |
| `claude --fork-session` | 变化（复制历史） |
| `/clear` | 不变（**存疑，需探针**） |
| 新会话 | 变化 |

MCP server 进程重启：`/reload-plugins` 时若 server 配置未变则保持现有连接（文档部分提及）；其他情形未明确。

## 5. Workflow / 云端 Routines

| 特性 | Subagents | Workflows | Routines |
|------|-----------|-----------|----------|
| 执行 | 当前会话内 | 后台脚本编排 | 云基础设施 |
| 跨机 | ❌ | ❌ 本机后台 | ✅ 云执行 |

Routines 触发器：Schedule / API（`POST /fire` + bearer token）/ GitHub 事件；与本地通信只能间接（git push、Slack、Linear 等 connector），无回调到本地会话。

## 总结：跨机协调设计的原语清单

**宿主已提供**：Routines API 触发云会话；Connectors；Git push；GitHub webhooks；hooks stdin `session_id`/`cwd`。
**明确不提供（需自建）**：Routine → 本地会话回调；跨 routine 共享状态/全局任务队列；routine 内 subagent；插件 MCP 的 http/sse；Agent Teams 跨机。
**文档不确定（需探针）**：`CLAUDE_CODE_SESSION_ID` 保证；MCP OAuth token 持久化位置；`--mcp-config`（主 session 注：CLI help 已列出，此条有误）；ToolSearch/defer 控制；routine 内 hooks 触发。

信息源：https://code.claude.com/docs — 查询时间 2026-08-16
