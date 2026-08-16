# 子代理报告原文：`.pace` 运行态协调逻辑现状地图（Explore agent，2026-08-16）

> **可信度**：只读代码探索，所有结论带 `文件:行号`；主 session 已对 4 处关键锚点抽检核实（`changeOwnerStatus` 三态 locks.js:616-629、`nextSequenceNumbers` locks.js:703-757、`get_context` 上下文来源 mcp/lib/context.js:2-30、`isTeammate` session.js:4 + `teammateMode` 表 pre-tool-use.js:105-111）。§6「2026-06-13 审计 6 bug 全部已修」是 agent 的判断性结论，引用前须逐条回代码定锚（记忆 subagent-review-secondhand）。行号以 2026-08-16 HEAD `a92ef85` 为准。

---

## 1. `.pace` 运行态目录清单

全部挂在 `getProjectRuntimeDir(cwd)`（`resolveEffectiveProjectRoot(cwd).runtimeRoot`，`plugin/hooks/pace-utils/path-utils.js:435-437`）——worktree、继承子目录都归一到宿主 `.pace/`；独立子项目（`set-project-root --mode independent`）才有自己的 `.pace`。

| 路径模式 | 内容/格式 | 写入者 | 读取者 | 生命周期 |
|---|---|---|---|---|
| `.pace/artifact-writer.lock` | JSON `{sessionId,agentId,artifactDir,cwd,operation,createdAt,timestampMs}` | v5 遗留流程 | `readArtifactWriterLock`/`artifactWriterLockMatches`（locks.js:21-88），pre-tool-use.js:481 legacy-lock 检测 | TTL 30min（`ARTIFACT_WRITER_LOCK_TTL_MS`），stale 自清 |
| `.pace/locks/artifacts/<resource>.lock` | JSON（`readJsonLock` 形态，locks.js:115-140） | `acquireArtifactResourceLock`（locks.js:252-271），pre-tool-use.js:955 | 同上；PostToolUse `releaseArtifactResourceLock`（post-tool-use.js:96-100） | TTL 5min（`ARTIFACT_RESOURCE_LOCK_TTL_MS`），`fs.openSync(wx)` 原子建锁 |
| `.pace/locks/sequences/<name>.lock` | 同上（non-reentrant） | `nextSequenceNumbers`（locks.js:703-730） | 同函数内 | TTL 30s，写完 counter 即释放（finally 块） |
| `.pace/sequences/<name>.counter` | 纯文本整数 | `nextSequenceNumbers`（locks.js:722-723） | 同函数 `current` 读取 | 永久累加，`Math.floor` 防浮点污染 |
| `.pace/reservations/<ownerKey>.json` + `.pace/reservations/<ownerKey>:<uniqueKey>.json` | JSON `{...reservation, sessionId, agentId, ownerKey, createdAt, timestampMs}` | `writeArtifactReservation`（locks.js:314-330） | `readArtifactReservation`/`findArtifactReservationForRel`（locks.js:300-393） | 30min TTL（随 `ARTIFACT_WRITER_LOCK_TTL_MS`，见 `findArtifactReservationForRel:388`），消费后 `clearArtifactReservationForRel` 删除；W6 sweep 兜底 |
| `.pace/change-owners/<slug>.json` | JSON，见 §3 | `writeChangeOwner`（locks.js:495-528） | `readChangeOwner`/`changeOwnerStatus` | 30min TTL（`CHANGE_OWNER_TTL_MS`），`markChangeOwnerClosed` 置 closed，W6 sweep 删 closed/超期 |
| `.pace/index-transactions/<ownerKey>.json` | **v7 已退役**（task.md+implementation_plan.md 双写事务，双文件合并后单文件直接释放不再产生新文件） | 无（仅历史遗留） | `releaseArtifactResourcesForOwner`（locks.js:418-419）逐个 unlink 清理残留 | 一次性清理，`migrate-v7.js` 也会整目录移除 |
| `.pace/paused-<sessionId>` | JSON `{sessionId,createdAt,timestampMs}` | `/paceflow:pause` → `writeSessionPause`（locks.js:650-658） | `isSessionPaused`（locks.js:669-679） | `/paceflow:resume` 或 SessionEnd 删除；TTL 24h（`SESSION_PAUSE_TTL_MS`）兜底 |
| `.pace/artifact-root` | 纯文本 `local`/`vault`/自定义路径 | `set-artifact-root.js` | `readRuntimeFile`（path-utils.js:106-112） | 用户一次性选择，长期存在 |
| `.pace/project-root` | 纯文本 `independent` | `set-project-root.js` | `projectRootMarkerMode`（path-utils.js:290-293） | 用户一次性声明 |
| `.pace/disabled` | 空标记文件 | `/paceflow:disable` | `hasDisabledMarker`（path-utils.js:114-116） | 用户显式停用 |
| `.pace/stop-block-count` | 计数 | session-start.js:34 定义路径，Stop hook 内部维护 | Stop 循环检测 | session 生命周期 |
| `.pace/findings-age-<today>` | 空标记 | `applyArtifactGroupEffects`（W12），session-start.js:169-171 快照存在性 | collectAgedFindings 判「今日已提醒」 | 每日一次 |
| `.pace/last-artifact-writer-transcript` | 纯文本 transcript 路径 | subagent-stop.js:206-210 | 调试/追溯用 | 每次覆写 |
| `.pace/<SESSION_SCOPED_FLAGS 项>` | 空标记，如 `degraded`/`task-list-used`/`archive-reminded` 等（constants.js:83-103） | 各处 session 内一次性提醒 | 各处判重复 | **注意：这批不是 per-session 键控**——项目级共享标志，被任意新 session 的 W3/W4 startup 清理（这正是 pause 标志必须走独立 `paused-<sessionId>` 命名而不能用这批的原因，locks.js:639-642 注释） |

## 2. 编号预留（reserve）

- 原子性：`nextSequenceNumbers`（locks.js:703-730）在**序列锁**保护下读 counter 文件 → `Math.max(current, existingMax)+1` 起连续取 N 个号 → 写回 counter。序列锁 `reentrant:false`（locks.js:714），batch 内不会重入误计数。
- `existingMax`（locks.js:756/773）额外**扫描共享 `artifact_dir/changes/` 目录**做双保险——落盘后的号即使 counter 丢失（换机/fresh clone）也不会重发。
- **跨进程安全**：同一 `.pace` runtime 内安全（`openSync(wx)` 原子建锁）。**跨 clone 不安全**——sequence lock 和 counter 都挂 `project-runtime`（per-clone），而 `existingMax` 扫的是共享 `artifact_dir`；两个独立 clone 配置同一 vault project 并发 reserve 时序列锁互不互斥、counter 互不可见，理论可撞号。这正是已知问题 **LOCKS-001**（详见 §6），已 **won't-fix 降级为文档化限制**（README.zh-CN.md:406）。git worktree/继承子目录不受影响（归一到宿主 `.pace`）。
- reservation 字段：`operation`/`kind`/`id`/`filePrefix`（末尾 `-` 留 slug 占位）+ `sessionId`/`agentId`/`ownerKey`（locks.js:764-767, 780-781）。
- 过期与消费：`findArtifactReservationForRel`（locks.js:373-393）判断超 30min 失效。**消费**由 PostToolUse 在 artifact-writer 实际落盘后 `clearArtifactReservationForRel`（pre-tool-use.js 侧也在 reservation 命中已存在文件时判 `reservationConsumed`，reserve-artifact-id.js:57-69）。
- `--cwd` 作用：`reserve-artifact-id.js` 默认用 `paceUtils.resolveProjectCwd()`（读 `CLAUDE_PROJECT_DIR`/`process.cwd()`），Bash 工具 cwd 在多条命令间会漂移，不显式 `--cwd` 时 reservation 可能写到错误 runtime（session-start.js:158 注入文案专门提示）。

## 3. 资源锁 / CHG owner / worktree owner

**先纠正一个前提**：代码里**没有独立的「worktree owner」数据结构**——worktree/branch 只是 change-owner 记录里的两个上下文字段（由 `executionContextForCwd` 产出），用来判定「CHG 是否属于同一 checkout」。owner 的唯一权威载体是 `.pace/change-owners/<slug>.json`（change-owner record）。

owner 记录结构（`writeChangeOwner`，locks.js:495-528）：
```
{ version:'change-owner-v1', changeId, sessionId, agentId, ownerKey,
  state, cwd, stateDir, worktree, branch, executionContext(text),
  operation, createdAt, updatedAt, timestampMs }
```
`ownerKey = agent:<agentId> || session:<sessionId>`（`lockOwnerInfo`，locks.js:96-101）。

**获取时机**（pre-tool-use.js:657-683，agent 派遣门内）：仅当 operation ∈ `create-chg/update-chg/close-chg/archive-chg` 且有 `targetChangeId` 时才 `writeChangeOwner`；`state` 按 operation/action 派生：`close-chg/archive-chg→closing`，`create-chg→backlog`，`approve→ready`，`update-status:[!]→blocked`，其余 `active`。**普通覆写不是原子创建**（per-tool-call 而非 per-operation 锁）。写盘路径（Edit/Write 实际落盘时）还有一次**二次复核**（pre-tool-use.js:849-865）：从 `artifactRelForMutation` 反解 CHG-ID 调 `changeOwnerStatus`，`foreign-fresh`/`sibling-fresh` 即 `DENY_WRITE_FOREIGN_OWNER`（`CHG-20260614-02 T-002`）。

**释放/降级**：
- `markChangeOwnerClosed`（locks.js:530-538）→ `state:closed`，调用点 `subagent-stop.js:165-169`（artifact-writer 报告 SUCCESS 终态且 target 已不在活跃索引时）；MCP 侧 `paceflow-server.js:238-241`（`close_chg`/`archive_chg` 后同步调用，Codex 无 SubagentStop）。
- `detachChangeOwnersForSession`（locks.js:588-590）→ `state:detached`，调用点 `session-end.js:16`（仅对 `['active','closing']` 生效）。crash 不触发 SessionEnd，靠 30min TTL 转 `sibling-stale` 兜底。
- `reviveDetachedChangeOwnersForSession`（locks.js:594-596）→ 同 session resume 后升回 `active`，调用点 pre-tool-use.js:332（`heartbeatChangeOwners`）。
- 心跳 `touchChangeOwnersForSession`：states `['active','closing','backlog','ready','blocked']`（pre-tool-use.js:333-337）。
- `sweepStaleRuntimeOwners`（locks.js:430-459）：SessionStart 每会话调用，`closed` 或 staleness（用记录内部 `timestampMs`，非文件 mtime，locks.js:441-444）即删除。

**disposition 状态机**（`changeOwnerStatus`，locks.js:598-630）：`unknown` / `current`/`current-closed`（同 session）/ `closed` / `current-worktree`（sid 空但同 checkout，STOP-03 保守放行）/ `sibling-fresh`/`sibling-stale`/`sibling-detached`（同 checkout 不同 session）/ `foreign-fresh`/`foreign-stale`（不同 checkout）。

**其他 session 碰到别人 owner 的行为**：
- 派遣门（pre-tool-use.js:616-655）：`foreign-fresh`/`sibling-fresh` 硬 deny（`DENY_AGENT_CHANGE_OWNER`）；`sibling-fresh` 带 `owner-takeover-confirmed/source/evidence` 三字段可放行；`foreign-stale`/`sibling-stale`/`sibling-detached` 同样要求 takeover 三字段（`DENY_AGENT_CHANGE_OWNER_STALE`）。
- 写盘门（pre-tool-use.js:856-864）：同构 `DENY_WRITE_FOREIGN_OWNER`。
- Stop（stop.js:207-229）：`foreign`/`sibling` 的 progress/deferred CHG **静默跳过**（不算本 session 硬 warnings）；`sibling` 推 `softReminders`。
- SessionStart 注入：`enrichSummaryOwner`（collect-state.js:203-211）挂 `ownerDisposition/ownerWorktree/ownerBranch/ownerState`，`foldForeignOwnedArtifactOutput`（layers.js:385, 681, 888-906）把非本 session 的 CHG 折叠成一行摘要。

`execution-context: [worktree:: <name>] [branch:: <name>]` 由 `executionContextForCwd`（path-utils.js:461-487）产出：`worktree` 取 `basename(worktreeCheckoutDir||resolved)`（非 worktree 固定 `main`），`branch` 走 `git rev-parse --abbrev-ref HEAD`（1s timeout）。**长驻进程注意**：结果被进程内 `_execCtxMemo`（Map，path-utils.js:458）按 resolved cwd 缓存，MCP server 每次调用入口 `_clearExecCtxMemo()`（paceflow-server.js:170）。

## 4. teammate 模式

- 判定：`isTeammate()`（session.js:3-5）= `!!process.env.CLAUDE_CODE_TEAM_NAME`。
- `DENY_REASONS` 三档（pre-tool-use.js:110-166）：**`soft`**（4 code：artifact-root 选择/迁移/桥接类流程引导门，teammate 转 additionalContext 提醒）；**`hard-note`**（8 code：写代码门/完整性门，硬 deny + 「任务管理归主 session，请回报 team-lead」note）；**`hard`**（其余 30+，无软化）。
- 语义（pre-tool-use.js:290-293）：「teammate = 纯执行者，任务管理归主 session（单一权威源）」。Stop 对 teammate 直接 `exit 0`（stop.js:417-418，I-6）。

## 5. SessionStart 注入 与 `get_context`

- 活跃 CHG / 任务列表数据源是**纯 `task.md` 单索引解析**：`getActiveChangeEntries`（change-analysis.js:386-399）→ `readChangeDetail` → `classifyChange`（change-analysis.js:330-384，纯函数；category backlog/ready/running/blocked/closing-required/inconsistent）→ `summarizeActiveChanges`（change-analysis.js:418-450）。
- owner 富化：`enrichSummaryOwner`（session-start/collect-state.js:203-211）。渲染：`buildLayers`（session-start/layers.js，纯函数）；`assembleWithBudget`（budget.js）。`session-start.js` 是瘦编排层（runtime-effects → collect-state → layers → budget），适合作为「协调核」消费方的参照实现。
- **`get_context`（`plugin/mcp/lib/context.js` + `paceflow-server.js:175-194`）当前返回**：`{ artifact_dir, project_root, cwd, session_id, execution_context, active_changes:[{ id, checkbox, status, category, approved, verified, tasks, detail }] }`——比 SessionStart 注入更精简：无 owner 字段、无 schema violation、无任务清单原文、无 findings/corrections/walkthrough。是 Codex MVP 功能子集，非同构镜像。

## 6. 已知问题摘要

- **`docs/artifact-locking-reference.md`（2026-06-11，基于 v6.6.2）——需标记 historical**：§1 锁类型总表第 2/4 行仍描述 `task.md`+`implementation_plan.md` 双索引 `index-transaction`，v7（`CHG-20260611-08`）已退役（`markIndexChangesTouchedAndMaybeRelease` 单文件直接释放，locks.js:681-688）。核心机制（openSync(wx) 原子锁、TTL 分层、owner 三态、worktree 归一）仍成立。
- **`docs/engineering-2026-06-13-concurrency-ownership-statemachine-audit.md`——agent 判断 6 个 bug 均已修**（Bug#2 heartbeat states 扩展 + sweep 用 `timestampMs`；Bug#3 `agent-lifecycle-guard.js:703-780` 确定性 V/R 前置；Bug#4 写盘 owner 复核 pre-tool-use.js:849-865；Bug#5 change-analysis.js:272-277；Bug#6 line-endings.js:5-17）。「异味 3」（资源锁是 per-tool-call mutex 而非 per-operation mutex，跨文件一致性靠 change-owner）**对协调核抽取直接相关**：要提供「一次 operation 的原子性」，权威点应抽 change-owner 而非 resource lock。
- **LOCKS-001**（vault finding 2026-06-04）：跨 clone 共享 vault 并发 reserve 可能撞号；won't-fix 降级为文档化限制（README.zh-CN.md:403-406）；原「建议方案」= 把 sequence lock+counter 从 project-runtime 迁到 artifact-root-bound 运行态——**协调核做可换后端时可一并解决**。

## 7. 抽取可行性初判

**纯函数/易抽**：`locks.js` 全部导出（`createLockUtils(ctx)` 工厂即依赖注入，`ctx` 只需 `getProjectRuntimeDir`/`normalizeSessionId`/`currentSessionId`/`executionContextForCwd`/`CHANGE_OWNER_TTL_MS` 等原语）；`path-utils.js` 的 `resolveEffectiveProjectRoot`/`executionContextForCwd`/`getProjectRuntimeDir`/`getArtifactDir`；`change-analysis.js` 的 `classifyChange`/`getActiveChangeEntries`/`summarizeActiveChanges`/`validateFrontmatterSchema`。MCP 层的 `plugin/mcp/lib/writer-pipeline.js` 通过**合成 Claude 形态 hook 事件再 spawnSync 真 hook** 复用判定——证明判定逻辑目前耦合在 hook 文件而非纯函数库；真正可换后端的协调核应把这层伪装换成直接函数调用。

**与宿主耦合紧（留在 hook/adapter 侧）**：`pre-tool-use.js` 本体（`emitDeny`/`DENY_REASONS`/teammate 降级/派遣门判定顺序，混杂 `hookSpecificOutput` 协议输出）；`agent-lifecycle-guard.js`（判定 + 人读文案耦合，需拆成「纯判定返回结构化结果」+「hook 侧转文案」）；`subagent-stop.js` 的 `inferCloseTarget`（Claude transcript JSONL 特有，Codex 无对应事件）。

**长驻进程缓存失效清单**：仅 `pace-utils.js:424 _artifactDirCache`（单槽）与 `path-utils.js:458 _execCtxMemo`（Map，按 resolved cwd 键控，**长驻多项目会无界增长**，需 TTL/LRU 或按请求清空）；`locks.js` 无模块级缓存（即时 fs 读写，对长驻进程友好）。

**关键文件**：`plugin/hooks/pace-utils/{locks,path-utils,session,change-analysis,constants}.js`、`plugin/hooks/{pre-tool-use,post-tool-use,stop,session-start,session-end,reserve-artifact-id,subagent-start,subagent-stop}.js`、`plugin/hooks/pre-tool-use/agent-lifecycle-guard.js`、`plugin/hooks/session-start/{collect-state,layers,runtime-effects,budget}.js`、`plugin/mcp/paceflow-server.js`、`plugin/mcp/lib/{context,writer-pipeline}.js`、`docs/artifact-locking-reference.md`、`docs/engineering-2026-06-13-concurrency-ownership-statemachine-audit.md`、vault `changes/findings/finding-2026-06-04-locks-001-cross-runtime-id-deferred.md`。
