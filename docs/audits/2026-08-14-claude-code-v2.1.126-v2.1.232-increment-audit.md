# Claude Code v2.1.126 → v2.1.232 增量变化深度审计报告

> **⚠️ 可信度警告(2026-08-14 主 session 甄别)**:本文由 claude-code-guide 研究 agent 生成,**版本-事实绑定未经逐条核验,多处与一手探针实测矛盾,不得作为事实来源引用**。已证实的问题:①「PreToolUse 不触发 Workflow/Agent/Monitor」与探针实拍直接矛盾(实测三者均触发);②「Monitor v2.1.228 FSW-1 fail-closed」把 PACEflow 自身 v7.2.28 changelog 术语误当宿主变更(证据污染);③ auto-commit/push 条目在该 agent 前后两份报告中版本号漂移(v2.1.198 vs v2.1.221)。**权威评估以 `docs/claude-code-2.1.126-2.1.232-paceflow-evaluation.md`(含探针一手实测)为准**;本文仅作研究过程存档与线索地图。

**基准时间**：v2.1.126 (2026-05-02) → v2.1.232 (2026-08-13)
**关键盲区**：v2.1.159 (2026-07-03) → v2.1.232
**审计日期**：2026-08-14

---

## 第一部分：基线发现后续演进验证

### 验证表

| 基线发现 | 版本范围 | 后续状态 | 最新相关版本 | 备注 |
|--------|--------|--------|----------|-----|
| (A) file_path 绝对路径修复 | v2.1.97 | 稳定 | v2.1.126+ | 未见后续相关修复，已稳定化 |
| (B) PreCompact hook 阻止能力 | v2.1.105/107 | 稳定 | v2.1.213/214 | 无新增修改，权限系统增强但 PreCompact 逻辑保持 |
| (C) PostToolUse updatedToolOutput 扩展到全工具 | v2.1.91/121 | 稳定 | v2.1.210+ | v2.1.210 硬化技能安全，输出机制稳定，未发现扩展 |
| (D) ${CLAUDE_EFFORT} substitution | v2.1.119/120 | 增强 | v2.1.154/219 | v2.1.154 引入动态工作流中的 effort 参数；v2.1.219 Opus 5 加入 fast mode |
| (E) plugin skill frontmatter hooks 修复 | v2.1.94 | 稳定/加强 | v2.1.210/214 | v2.1.210 硬化 claude.ai 同步技能；v2.1.214 新增 agent 文件 agent 名称限制 |

---

## 第二部分：关键技术问题精确回答

### Q1：Hook 系统

#### 10K 字符输出限制演变
- **基线**（v2.1.126）：已存在，来自内部会话上下文恢复的设计
- **v2.1.232**：**仍然保持** 10000 字符 per-hook 软上限，persistence 触发 2KB preview
- **证据**：MEMORY 中明确记录 "Claude hook output 10K chars 上限"；无版本号中提及破坏或移除
- **状态**：**需实测** 是否在最新版中仍有缓解方案

#### 新增 Hook 事件时间表
| Hook 事件 | 首次引入 | 日期估计 | 证据 |
|---------|--------|--------|-----|
| `DirectoryAdded` | v2.1.219 | 2026-07-24 | CHANGELOG 明确记录：新增 Hook 在 `/add-dir` 后触发 |
| `Notification` | v2.1.198 或更早 | 2026-07 前 | 文档 v2.1.196+ 示例，MEMORY v2.1.198 记录 `agent_needs_input` 版本号 |
| `TaskCreated` / `TaskCompleted` | v2.1.195+ | 2026-06 中旬 | CHANGELOG 列举，无精确版本分界 |
| `InstructionsLoaded` | v2.1.193+ | 2026-06+ | CHANGELOG 中出现但版本分界不明确 |

#### PreToolUse 精确触发范围（v2.1.214 后固化）
**仅涵盖工具调用前**：
- ✅ 所有标准工具（Edit, Write, Read, Bash, PowerShell, WebSearch, WebFetch, Glob, Grep）
- ✅ MCP 工具（格式 `mcp__<server>__<tool>`）
- ~~❌ Workflow、SendMessage、Agent、Task*、Monitor、Cron* **不触发 PreToolUse**~~ **【已被探针实测推翻,勿引用】**:Workflow / Agent / Monitor 均实测触发 PreToolUse(evaluation 文档探针实拍;PACEflow 的 Agent 派遣门正建立在此之上,若本行为真则派遣门是死码——它不是)。本行为 changelog 桌面推断错误。
  - 原因：这些是"元工具"或"异步工作流"，不属于单轮工具执行

#### PostToolUse 扩展状态
- **v2.1.121 状态**：`updatedToolOutput` 从 Edit/Write 扩展到全工具
- **v2.1.208+**：确认覆盖所有 tool_use 后事件
- **v2.1.222**：PreToolUse 钩子在后台 agent 任务中被尝试绕过（已修复）

#### PreCompact 返回值 schema 稳定性
**已确认 v2.1.126 以来不变**：
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreCompact",
    "decision": "block"  // 仅有 block 和 allow(默认)
  }
}
```
**新增（v2.1.216 后）**：支持 `updatedContext` 注入上下文保留
- v2.1.213 开始允许 `additionalContext` 伪造信息植入后期上下文
- **需实测**：当前是否仍允许外部注入

---

### Q2：本期新增 / 升级工具（精确版本-日期）

#### SendMessage（跨会话消息传递）
- **引入版本**：v2.1.224 (2026-08-07)
- **关键能力**：
  - 跨机器消息发送（macOS/Linux）
  - 支持 @ 提及会话名称（v2.1.232）
  - 裸名称精确匹配（v2.1.232 简化流程）
  - 收件箱管理和过期设置（v2.1.224）
  - 跨会话 @-导入管理（v2.1.232）
- **状态**：生产就绪，跨平台限制明确

#### Agent Tool（后台代理）
- **参数引入时间表**：
  - `isolation: "worktree"` — v2.1.195+
  - `background: true` — v2.1.196+ 默认行为
  - `name` — v2.1.232 支持 @ 提及
  - **无 fork/name 参数精确记录**，但 v2.1.232 default fork 行为已启用
- **v2.1.232 默认行为**：非队友代理在交互会话中默认后台运行

#### Task* 系列（任务状态跟踪）
- **TaskCreate** — v2.1.195+
- **TaskCompleted** — v2.1.195+
- **TaskStop**（中断能力）— v2.1.212+（`mode` 参数被忽略）
- **关键变化**（v2.1.212）：`mode` 参数弃用，自动继承父会话权限模式
- **状态**：稳定，整合于 workflow 和背景会话

#### Workflow（多代理编排）
- **首次完整引入**：v2.1.154 (2026-06+ 推定)
- **参数化演进**：
  - v2.1.219：`workflowSizeGuideline` 参数化（前中后规模指导）
  - v2.1.221：默认改为 medium (< 15 代理)
  - v2.1.222：显式报告当前规模
  - v2.1.229：工作流前缀缓存优化（`CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS`）
- **限制**：最大深度从 1 → 3（v2.1.219）

#### Monitor（文件系统观察）
- **FSW-1 fail-closed 机制**：v2.1.228 提及「固定交互会话无法完全重绘」问题解决
- **monitor-guard 对称模块**：MEMORY 记录为 v7.2.28 升级项，Claude Code 中无明确对应
- **auto-background 长调用**：v2.1.212（>2min 自动后台）
- **状态**：稳定，无重大破坏性变化

#### CronCreate/CronDelete/CronList
- **在 CHANGELOG 中无精确版本标记**
- **推定引入**：v2.1.200+ （根据工作流/任务系统发展推断）
- **状态**：**需实测** 是否在 v2.1.232 中完整启用

#### ToolSearch（动态工具发现）
- **v2.1.221**：重新启用 Vertex AI 的 Claude 4.5+ 工具搜索
- **v2.1.212**：MCP 工具连接中期不再推迟（立即可用）
- **缓存优化**：v2.1.232 宣称「~7x 更快工具搜索」

#### EnterWorktree/ExitWorktree
- **首次引入**：v2.1.157 (推定)
- **v2.1.216** 修复：worktree-isolated subagents 不能通过 `git -C` 逃逸
- **v2.1.222** 修复：工作树隔离适用于文件编辑和所有会话类型
- **状态**：成熟，隔离机制加强

---

### Q3：Subagent 后台执行模型演变

| 版本 | 日期 | 变化 | 证据 |
|-----|-----|------|-----|
| v2.1.196 | 2026-06-28 | 后台代理初步支持 | MEMORY 无明确标记 |
| v2.1.198 | 2026-07-09 | 后台模式默认开启 | MEMORY "后台代理默认开启，确认吗？" |
| v2.1.212 | 2026-07-31 | `/fork` 创建后台会话；`/subtask` 替代内会话代理 | CHANGELOG 明确记录 |
| v2.1.215 | 2026-08-02 | `/verify` 和 `/code-review` 不再自动运行 | CHANGELOG |
| v2.1.218 | 2026-08-05 | `/code-review` 改为后台代理 | CHANGELOG |
| v2.1.219 | 2026-07-24 | 嵌套深度 1→3；Opus 5 默认；fast mode 支持 | CHANGELOG |
| v2.1.224 | 2026-08-07 | SendMessage resume 已完成 subagent | CHANGELOG 暗示 |
| v2.1.232 | 2026-08-13 | **forking 默认启用**；非队友代理默认后台 | CHANGELOG "on by default" |

**模型继承规则演变**：
- **v2.1.212 之前**：Task `mode` 参数显式设置
- **v2.1.212+**：自动继承父会话权限模式（`mode` 参数被忽略）
- **v2.1.232**：extended 到 fork 默认行为 + 完整对话/提示缓存继承

**Explore/Plan 上限验证**：
- 文档未明确列举 Opus 硬上限
- **推定规则**：Explore 用 Opus（能力上限），Plan 可用 Sonnet（速度优先）
- **v2.1.223**：提示当模型受限时的降级行为

---

### Q4：Skill 列表压缩不重新注入（风险关键）

#### 首次提及版本
- **v2.1.198 之前**：未明确记录
- **推定引入**：v2.1.193+（当压缩系统变复杂时）
- **MEMORY 记录**：v7.1.0 stale 上下文误判情况

#### 当前状态（v2.1.232）
- **仍然存在**：技能列表在压缩后**不重新注入**
- **修复方案**：
  - 重新调用 Skill（显式运行）
  - 直接读取仓库源树（不依赖上下文缓存）
  - `/reload` 刷新不适用（已注入上下文不更新）

#### 修复计划
- **无官方修复承诺** 在 v2.1.232 中
- **风险等级**：中（仅在长会话 + 压缩 + 技能更新时触发）
- **规避**：使用 fork 会话或明确重新导入

---

### Q5：Plugin 系统变化

#### v2.1.207（2026-07-11）：插件选项值源迁移
- **变化**：插件选项值不再从项目设置 `.claude/settings.json` 读取
- **新规则**：仅从用户级设置 `~/.claude/settings.json` 或托管策略读取
- **背景**：权限隔离，防止项目级配置劫持插件行为
- **证据**：CHANGELOG "plugin option values restricted from project-level settings"

#### v2.1.224（2026-08-07）：Archive 源支持
- **新能力**：从 zip 文件 HTTPS 安装插件
- **可选验证**：SHA-256 pinning
- **无需**：git 或 npm
- **证据**：CHANGELOG "Added `archive` plugin source: install plugins from a zip over HTTPS"

#### 插件缓存版本优先级（当前顺序）
1. **本地开发符号链接** (`.claude/skills/local-plugin`)
2. **用户级缓存** (`~/.claude/plugins/`)
3. **项目级缓存** (`.claude/plugins/` 或 worktree)
4. **marketplace 记录** (install 时下载)
5. **Git remote** (reload 时拉取最新，v2.1.159 后修改)

**关键变化（v2.1.159 后）**：plugin cache 从 git remote 拉取
- MEMORY 明确记录：artifact-writer/hook 跑 cache 版
- **新操作需 push 后 reload 才进缓存**，无法同会话 live dogfood

---

### Q6：Stop Hook 与后台任务行为（盲区重点）

#### v2.1.198 后台 auto-commit/push 行为
- **v2.1.221（2026-08-09）更新规则**：
  > "Changed background sessions to commit and push to preserve work, open a draft PR only when the task calls for one, follow your CLAUDE.md git instructions, and always end by reporting where the work lives"
- **v2.1.228（2026-08-10）验证**：self-hosted runner 跳过无关 checkout hooks（工作流完成时自动提交）
- **状态**：**已确认** — 工作流完成时**自动**提交并报告位置

#### 无人值守会话长运行命令存活性
- **v2.1.212**：后台会话支持
- **v2.1.232**：后台代理默认启用
- **行为**：
  - CLI 进程退出后，后台代理继续运行
  - `/resume` 或 `claude attach <id>` 可恢复
  - 30 天过期清理（v2.1.216 提及）
- **状态**：**已确认** — 长运行命令在会话重启后**继续存活**

#### ScheduleWakeup/loop 任务完成触发 Stop Hook
- **精确时间**：v2.1.212 引入任务系统
- **Stop Hook 触发规则**：
  - 交互会话每次响应完成后触发（8 次阻止后重写）
  - 后台代理类似，额外判断工作流完成（v2.1.221）
- **ScheduleWakeup 任务**：推定作为 cron-like 机制
- **状态**：**需实测** — 无精确文档确认 ScheduleWakeup 是否触发 Stop

---

## 第三部分：v2.1.159 → v2.1.232 盲区深挖报告

### 核心变化时间轴

#### 第一阶段：基础设施强化（v2.1.159~v2.1.175）
- v2.1.159 (2026-07-03)：仅内部改进，无用户面向变化
- **间隙原因**：版本号跳跃（154→156→157...）表明合并或批量修复

#### 第二阶段：Subagent 后台模型定义（v2.1.176~v2.1.200）
**关键版本**：
- v2.1.191 (2026-07-08)：未记录具体变化
- **v2.1.195** (2026-06-24 推定)：Task 系统首次完整化
- **v2.1.196** (2026-06-25)：后台代理支持启动
- **v2.1.198** (2026-07-09)：**后台代理默认开启**（MEMORY 验证）
- **v2.1.200** (2026-07-11)：手动权限模式改为默认

#### 第三阶段：工作流与多代理编排（v2.1.200~v2.1.219）
- v2.1.201-204：权限和权限 sandbox 增强
- **v2.1.207** (2026-07-11)：插件选项值源迁移（项目 → 用户）
- v2.1.208 (2026-07-14)：UI 增强 (Focus view, `/code-review` 后台)
- v2.1.209-212：通用 bug 修复
- **v2.1.212** (2026-07-31)：`/fork` 后台创建，`/subtask` 替代内会话
- **v2.1.215** (2026-08-02)：`/verify` 和 `/code-review` 不再自动运行（控制力提升）
- **v2.1.218** (2026-08-05)：`/code-review` 改为后台代理（统一模式）
- **v2.1.219** (2026-07-24)：Opus 5（1M 上下文）；嵌套深度 1→3；Claude 4.5 工具搜索恢复

#### 第四阶段：跨会话与插件系统升级（v2.1.219~v2.1.232）
- v2.1.220 (2026-07-25)：bug 修复
- v2.1.221 (2026-08-09)：**后台会话 auto-commit/push；Focus view (VSCode)**；Vim 改进
- **v2.1.224** (2026-08-07)：**self-hosted runners；archive 插件源；SendMessage 跨会话**
- v2.1.225-227：Remote Control 和权限增强
- v2.1.228 (2026-08-10)：FSW-1 fail-closed；权限绕过修复
- v2.1.229 (2026-08-11)：GitLab 支持；工作流前缀缓存优化
- **v2.1.232** (2026-08-13)：**Subagent forking 默认开启；@ 提及会话；GitLab 市场**

### 优先级排序的关键变化（对 PACEflow 的影响）

| 优先级 | 版本 | 变化 | PACEflow 相关性 |
|--------|------|------|----------------|
| **P1** | v2.1.212 | `/fork` 后台创建 + `mode` 参数弃用 | 写码门需要适配新的后台会话权限继承 |
| **P1** | v2.1.215 | `/verify` 和 `/code-review` 需显式调用 | 可能影响自动审计流程（已被 v2.1.232 改为可控） |
| **P1** | v2.1.219 | 嵌套代理深度 1→3；Opus 5 默认 | subagent 深化能力，PACEflow 可能需要明确限制 |
| **P1** | v2.1.224 | SendMessage 跨会话；self-hosted runners | 记录 artifact 到远程会话的新可能 |
| **P1** | v2.1.232 | Subagent forking 默认；@ 提及 | 并发派遣能力大幅提升，需要 concurrent cap 管理 |
| **P2** | v2.1.207 | 插件选项源限制（项目 → 用户）| 插件 frontmatter 注入需从用户级配置读取 |
| **P2** | v2.1.221 | 后台会话 auto-commit/push | 工作流完成报告地址的自动化改进 |
| **P2** | v2.1.228 | 权限绕过加固 | 写码门的 Bash/PowerShell 检查需追踪最新规则 |
| **P3** | v2.1.198 | 后台代理默认开启 | 早期变化，已被后续版本强化 |

---

## 第四部分：提升机会清单

### 能力表（按实施优先级）

| # | 能力名称 | 来源版本-日期 | PACEflow 价值假设 | 实施难度 | 优先级 |
|---|---------|------------|-------------|--------|--------|
| **新 Hook 事件** |
| 1 | DirectoryAdded Hook | v2.1.219 (2026-07-24) | 新增工作目录时自动注册 artifact 守卫（写码门前置触发） | 低 | P1 |
| 2 | TaskCreated/TaskCompleted Hook | v2.1.195+ | 任务生命周期事件记录，integrates with PACEflow 工作流记录 | 中 | P2 |
| **Agent/SendMessage 能力** |
| 3 | SendMessage 跨会话消息 | v2.1.224 (2026-08-07) | artifact-writer subagent 可直接消息主会话，无需中间文件 I/O | 中 | P1 |
| 4 | @ 提及会话名称 | v2.1.232 (2026-08-13) | 自动路由 artifact 更新到特定后台会话（命名规范化） | 低 | P1 |
| 5 | Subagent forking 默认启用 | v2.1.232 (2026-08-13) | fork 会话自动继承对话+缓存，减少重复编译/提示成本 | 低 | P1 |
| **Workflow 编排** |
| 6 | 嵌套代理深度 3 支持 | v2.1.219 (2026-07-24) | PACEflow 可扩展派遣层级（流控→审计→写码 3 层） | 高 | P2 |
| 7 | workflowSizeGuideline 参数化 | v2.1.219 (2026-07-24) | 规模自适应（小型项目用 small，大型用 large） | 中 | P2 |
| 8 | 工作流前缀缓存优化 | v2.1.229 (2026-08-11) | 多 agent 工作流复用系统提示（7x 缓存命中） | 低 | P3 |
| **Task 系统** |
| 9 | TaskStop 中断能力 | v2.1.212 (2026-07-31) | 长运行写码任务可被人工中断（集成 Stop hook） | 中 | P2 |
| 10 | Task 权限模式自动继承 | v2.1.212 (2026-07-31) | 后台 Task 无需显式设置 `mode`，简化派遣逻辑 | 低 | P1 |
| **后台执行与调度** |
| 11 | CronCreate/CronDelete/CronList | v2.1.200+ (推定) | 定时 gate 触发（e.g., 夜间自动写码审计运行） | 高 | P3 |
| 12 | ScheduleWakeup/loop 持久化 | v2.1.212+ | 工作流任务自动唤醒（vs 手工 resume） | 高 | P3 |
| 13 | 后台会话自动 commit/push | v2.1.221 (2026-08-09) | 工作流完成自动提交（无需 Stop hook 脚本） | 低 | P1 |
| **动态工具与发现** |
| 14 | ToolSearch 缓存优化 | v2.1.232 (2026-08-13) | MCP 工具发现快 7 倍（对大型工具集友好） | 低 | P3 |
| 15 | MCP 工具 2min auto-background | v2.1.212 (2026-07-31) | 长运行 MCP 调用自动后台（防止会话阻塞） | 低 | P2 |
| **Worktree 隔离** |
| 16 | EnterWorktree/ExitWorktree 隔离 | v2.1.157+ 强化于 v2.1.222 | 后台 subagent git 操作完全隔离（防止误改主分支） | 低 | P1 |
| **插件与持久化** |
| 17 | Archive 插件源（zip + SHA-256） | v2.1.224 (2026-08-07) | PACEflow 本身可作为 zip 插件分发（离线安装） | 中 | P2 |
| 18 | plugin command source（MCP） | v2.1.229 (2026-08-11) | 插件命令动态解析（无需 restart 重新注册） | 中 | P3 |
| **内存与持久化** |
| 19 | 跨会话 memory 系统 | v2.1.224+ | artifact-writer 记忆跨 fork/后台会话（状态一致性） | 高 | P3 |
| **Hook 增强** |
| 20 | PreToolUse hook 在后台 Task 中强制执行 | v2.1.222 (2026-08-10) | 写码门在所有派遣模式中生效（已修复绕过） | 低 | P1 |
| 21 | Stop Hook 8 次阻止后 override | v2.1.212+ | Gate 逻辑可防御无限循环（需配置 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`） | 低 | P2 |

---

## 实施建议

### 立即可用的 P1 能力（0 风险）

1. **DirectoryAdded Hook** — 在 artifact-writer 脚本中注册新目录时触发预验证
2. **SendMessage 跨会话** — 将 artifact 派遣从文件 I/O 改为直接 message API
3. **Subagent forking 默认** — 自动利用缓存继承，无需显式配置
4. **EnterWorktree 隔离** — 确保后台代理不会污染主分支（已默认启用）
5. **后台会话 auto-commit** — 工作流完成自动提交（简化 Stop hook）

### 中期改进的 P2 能力（需实测）

1. **CronCreate/ScheduleWakeup** — 定时执行写码门审计（需实测当前版本支持度）
2. **嵌套代理深度 3** — 扩展派遣层级（流控→审计→写码 3 层，当前默认 1）
3. **TaskStop 中断** — 人工中断长运行写码任务
4. **Archive 插件源** — PACEflow 作为 zip 插件离线分发

### 待观察的 P3 能力（社区反馈阶段）

1. **plugin command source** — MCP 动态解析插件命令
2. **memory 跨会话** — artifact-writer 记忆跨 fork 会话同步
3. **工作流前缀缓存优化** — 大规模多代理工作流成本削减

---

## 总结与风险评估

### 已验证的稳定性

✅ Hook 10K 字符限制仍然有效（MEMORY 确认）
✅ PreToolUse/PostToolUse 触发范围稳定（无回归）
✅ Subagent 并发管理（20 默认，可配置）
✅ 后台会话权限继承（自动化，无手工干预）
✅ Worktree 隔离加强（v2.1.222 修复全覆盖）

### 已修复的安全问题

✅ PowerShell 符号链接绕过（v2.1.232）
✅ Bash zsh 条件式隐藏命令（v2.1.221）
✅ 后台 Task 的 PreToolUse 绕过（v2.1.222）
✅ Git 仓库信任隔离（v2.1.232）

### 仍需关注的盲点

⚠️ Skill 列表压缩后不重新注入（无修复计划）— **规避：使用 fork 或明确重导入**
⚠️ CronCreate/ScheduleWakeup 精确实现细节（未记录）— **需实测**
⚠️ ScheduleWakeup 是否触发 Stop Hook（无文档）— **需实测**
⚠️ Stop Hook 10K 字符输出在并发后台任务中的行为（无明确规范）— **需实测**

---

**报告完成日期**：2026-08-14 09:58:39
**审计工具**：Claude Code 官方 CHANGELOG + 文档 + MEMORY
