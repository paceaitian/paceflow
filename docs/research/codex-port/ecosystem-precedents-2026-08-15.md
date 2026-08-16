# Codex 插件生态与 Claude Code 移植先例(主 session 补研,2026-08-15)

> 原派 codex-ecosystem 研究 agent 因额度中断 10 小时无响应,本节由主 session 时间盒 web 研究补齐(WebSearch + WebFetch,二手来源逐条标注)。

## 移植先例(社区,二手)

| 来源 | 类型 | 要点 |
|---|---|---|
| [ussumant/cc2codex](https://github.com/ussumant/cc2codex) | 非官方迁移助手 | Claude Code → Codex 配置/skill 迁移工具,beta |
| [yibie/plugin-claude-2-codex](https://github.com/yibie/plugin-claude-2-codex) | 插件转换工具 | Claude plugin 结构 → Codex plugin |
| [Migrating from Claude Code to Codex is not a search-replace](https://dev.to/pratikbin/migrating-from-claude-code-to-codex-is-not-a-search-replace-90k) | 经验文 | 「hooks 验证命令依赖 Claude 应用层拦截模型;Codex 里等价安全由 sandbox_mode 而非 hooks 强制」;side-effect 类 hook(logging/通知)可直接移植 Stop/SessionStart |
| [ofox.ai: 12 Configs, 1 Dead End](https://ofox.ai/blog/migrate-claude-code-to-codex-2026/) | 经验文 | ConfigChange hooks / output styles 在 Codex 无对应(dead end) |
| [Codex Knowledge Base: 原生迁移系统](https://codex.danielvaughan.com/2026/05/13/codex-cli-agent-migration-system-import-claude-code-sessions-skills-config/) | 详解 | 见下节 |
| [blakecrosley 迁移指南](https://blakecrosley.com/blog/claude-code-to-codex-migration) / [workflowswithai](https://workflowswithai.substack.com/p/how-to-migrate-from-claude-code-to) | 经验文 | 哲学差异:Claude 应用层治理(17 hook 事件、CLAUDE.md 层级、紧耦合 subagent)vs Codex 内核级(Seatbelt/Landlock+seccomp)+ profile 驱动 |

## Codex 原生 `/import` 迁移系统(v0.128.0–0.130.0 引入,二手详解 + 本机二进制 strings 佐证)

可迁移:CLAUDE.md→AGENTS.md(术语重写)、settings.json→config.toml(键映射)、skills→`.agents/skills/` SKILL.md、MCP→`[mcp_servers.*]`、**hooks→`.codex/hooks/`(仅同步 command 型;条件分组/async/HTTP hooks 跳过)**、**subagents→`.codex/agents/*.toml`(兼容字段保留)**、近 30 天 sessions→rollout。
不可迁移:`$ARGUMENTS`/`@file` 运行时展开、源模型名、禁用的 MCP、含占位符的提示模板。
作者核心告诫:「移植操作合约而非文件树」,分阶段验证。

**对 PACEflow 的含义**:官方迁移工具能把 hooks.json 结构和 artifact-writer.md 机械搬过去,但 PACEflow 的价值不在文件树而在**操作合约**(派遣门字段协议、artifact 唯一写入路径、V→R 偏序)——正是迁移工具明确不保证的部分,与本文一手实测的「结构层白送、约束层需重设计」结论一致。

## 官方 issue 佐证

- [openai/codex#16226](https://github.com/openai/codex/issues/16226)(2026-03-30 开,仍 open):hooks 区分子代理事件与主代理事件——诉求把 agent_id/agent_type 暴露给 hooks(Claude Code v2.1.69 已做)。**说明 subagent-aware hooks 在 Codex 是社区正在争取、尚未完全落地的能力**,与本文 E5「子代理内 hooks exec 模式零触发」实测互相印证:PACEflow 依赖 subagent 身份判定的那层在 Codex 当前版本没有可靠基础。
- 相关 subagent 稳定性 issue:#14866(subagent 卡 awaiting instruction)、#24342(No agents completed yet)——multi_agent 仍在演进期。

## 社区共识提炼(推测级,供定位)

Codex 生态对「hooks 做治理」的期望明显低于 Claude Code——主流叙事是 sandbox/approval 内核级约束,hooks 定位为 side-effect 与轻量策略。PACEflow「确定性 hook 门 + 记录层」的定位在 Codex 生态属**差异化而非主流**;若移植,产品叙事应贴 Codex 用户熟悉的「AGENTS.md + skill + 可选 hook 策略」表述,而非照搬 Claude 侧「hook 强制门」表述。
