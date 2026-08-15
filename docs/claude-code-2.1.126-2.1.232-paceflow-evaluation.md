# Claude Code v2.1.126 → v2.1.232 PACEflow 影响评估与机会分析

> 评估日期:2026-08-14。基线:PACEflow v7.2.29(cache == dev == 05a86e5),宿主 Claude Code 2.1.232。
> 接续 `docs/claude-code-2.1.76-2.1.131-paceflow-evaluation.md`(2026-05-02)与 findings.md 的 v91-126 评估;v2.1.159 以上区间此前仓库零覆盖。
> 方法:三源交叉——① claude-code-guide agent 读官方 changelog/文档(二手,已甄别);② cache 日志 2026-05-15→08-14 全量统计(一手);③ 探针 fixture 实测(一手,方法同 audit-2026-05-31:独立 dump-stdin hook + headless 子会话,5 次会话捕获 Stop/SubagentStart/SubagentStop/PreToolUse/UserPromptSubmit 真实 stdin)。
> 探针数据与直喂测试记录:session scratchpad `test-matrix-results.md` + `probe-host/probe-dump-{A,B,C,D}.jsonl`(session 临时目录,证据已摘录本文)。
> 本文属仓库维护材料(`docs/`),不随 marketplace runtime 发布。

---

## 执行摘要

**兼容性总体良好:PACEflow 依赖的核心宿主契约(hook stdin 字段、background_tasks 判活假设、transcript JSONL、SubagentStop 字段)在 v2.1.232 全部实测无回归。** 需要行动的影响集中在三处,且最大的一处(SendMessage resume 绕派遣门)是 v7.2.29 自己引入、被宿主新能力放大的:

1. **P1|SendMessage resume-per-CHG 绕过整套 Agent 派遣门**(自引入 + 宿主 v2.1.224 SendMessage 常态化放大)
2. **P1|Agent 工具默认后台化**(v2.1.198→232 渐进),artifact-writer/审计 agent 的同步派遣语义现在依赖模型自觉传 `run_in_background: false`,无确定性门
3. **P2|SubagentStop 语义漂移**:每轮 idle 触发(非仅完成)+ 命名 agent 的 `agent_type` 传 name 非类型,冲击 subagent-stop.js 识别与锁/owner 收口

机会面最大的三项:**SubagentStart 事件**(派遣时刻确定性观察点)、**Notification 事件 agent_completed**(background 收口的可靠信号)、**UserPromptSubmit**(每轮注入时点,可部分替代被 10K cap 压制的 SessionStart 注入)。

---

## 一、实测确认无回归(测试矩阵通过项)

| # | 依赖面 | 实测方法 | 结果 |
|---|--------|---------|------|
| 1 | Stop `background_tasks` 判活假设(完成即移出) | 探针会话 A:bg sleep 3 → 前台等 10s → Stop | `[]`,**假设仍成立**(与 2026-05-31 v2.1.158 实测一致) |
| 2 | background_tasks shell 形态结构 | 探针会话 B | `{id,type:"shell",status:"running",description,command}` 无变化 |
| 3 | background_tasks workflow 形态 | 探针会话 E | `{id,type:"workflow",status:"running",description,name}` 仍报数组、完成移出 |
| 4 | SubagentStop 字段完整性 | 探针会话 C | agent_id/agent_type/agent_transcript_path/last_assistant_message 全在 |
| 5 | subagent transcript JSONL 逐行可 parse | 会话 C transcript 11/11 行 | 无回归(subagent-stop.js close 目标推断可用) |
| 6 | SessionStart source 字段 | 探针 | `source` 仍在,值 startup(changelog:值域增加 `fork`) |
| 7 | hooks[].args exec form / 13 hook 条目加载 | 本 session + 探针会话 PACEflow hook 正常执行 | 无回归 |
| 8 | **写码门对 Workflow 路径闭合** | 探针会话 E:workflow agent 用 Write 写 .py | **workflow agent 的 Write/Bash 各自触发 PreToolUse 且带 agent_id** → 写码门/artifact 直写保护兜底仍拦得住 |
| 9 | PostToolUseFailure / StopFailure 仍被派发 | cache 日志(最后记录 07-11 / 06-30) | 事件未废除(低频,中性证据) |

宿主 stdin 字段变化(均无影响):Stop/SubagentStop 新增 `prompt_id`、移除 `effort`;PACEflow 不读这两个字段。

---

## 二、影响面(需要行动,按危害链排序)

### P1-1 SendMessage resume-per-CHG 绕过整套 Agent 派遣门(v7.2.29 自引入)

- **定锚**:`plugin/skills/pace-workflow/SKILL.md:187-193` 指示同一 CHG 后续 op 用 `SendMessage(to: <agentId>)` resume artifact-writer;`SendMessage` 不在任何 PreToolUse matcher(hooks.json),plugin 代码零引用。本 session live 证据:多次 SendMessage 调用零 hook 记录。
- **危害链**:resume 路径上,派遣门 10 道检查(approve 的 `approval-confirmed` 三件套、close-chg 八项必填、V→R 偏序、change-owner 归属、reservation)一次都不触发,唯一剩余防线是 agent 第三层自校验(LLM-soft)。REVIEWED 空门(v6.2.0)已证明 LLM-soft 必被伪造/遗忘——`SKILL.md:193`「不软化任何门」在确定性层面不成立,与设计宪法「确定性网关 > LLM-soft」直接冲突。落盘层(资源锁/status 校验)仍在,但字段门与偏序门是派遣时刻专属,resume 全空。
- **修法方向**(三选一,见 §四):A) 收回 resume 编排(回到 per-op fresh spawn);B) resume 仅允许无门槛 op(append/update-status),有 confirmed 字段门的 op(approve/verify/review/close)必须 fresh spawn;C) 把字段门下沉到落盘层(写 APPROVED/VERIFIED/REVIEWED/CLOSED 状态时按 .pace 侧 session 级确认记录做确定性核验)。推荐 B(最小改动、门语义不变)。

### P1-2 Agent 默认后台化,同步派遣无确定性保障(宿主 v2.1.198→v2.1.232)

- **定锚**:changelog v2.1.198 后台代理默认开启、v2.1.232 非队友代理默认后台;探针会话 C/D 实证——模型要前台等待必须显式传 `run_in_background: false`(tool_input 实拍);本 session 未显式传时全部 background(spawn 即返回)。
- **危害链**:① artifact-writer 派遣:SKILL.md/agent 契约假设「派遣→等报告→继续」同步语义,默认后台化后这依赖模型每次自觉传 `run_in_background: false`——LLM-soft;后台化的 artifact-writer 会打乱 SubagentStop 收口时序、报告读取、resume agentId 捕获。② 审计 subagent:`SKILL.md:228` 等三处「必须 inline/foreground 派发」散文约束,现在默认值反了,散文更容易失效。③ agent-lifecycle-guard 不读 `run_in_background` 字段(全仓 grep 零命中)。
- **修法**:agent-lifecycle-guard 对 artifact-writer 派遣增加确定性检查:`tool_input.run_in_background !== false` 即 hard-deny(要求显式前台),配 deny 文案模板。一行判断,与既有字段门同构。审计 agent 的 inline 约束同步更新散文(注明宿主默认已翻转)。

### P2-3 SubagentStop 语义漂移:每轮 idle 触发 + 命名 agent agent_type=name

- **定锚**:本 session 日志 10+ 次 SubagentStop——同一 background agent 每轮 idle 触发一次(surface-map/claude-code-guide 各 2+ 次);2026-06-23 resume dogfood 当天 artifact-writer(同一 agent_id)已双触发,`CHANGE_OWNER_CLOSE_SKIP reason=missing-target` 侥幸跳过 owner 提前关闭。命名 agent 的 `agent_type` 传自定义 name(日志 `agent_type=paceflow-surface-map`),未命名传类型名(探针会话 C `general-purpose`);另有 25 条 `agent_type=-`(字段缺失)。
- **危害链**:① resume 编排下 artifact-writer 每轮 idle 都会跑一遍资源锁释放 + owner 关闭尝试——中间轮如果 transcript 推断出 close 目标,owner 被提前置 closed(operation 级一致性的权威机制被打断,见 artifact-locking-reference §1 #6);② 若未来派 artifact-writer 带 `name` 参数,`agent_type` 变 name → subagent-stop.js:180 识别失败 → 锁释放/owner 收口/报告观察全部静默失效(锁靠 5min TTL 自愈,owner 靠 30min sweep,无数据损坏但有所有权混淆窗口)。
- **修法**:① subagent-stop.js 识别加固:SubagentStart 时刻(新事件,见机会面)把 `agent_id → subagent_type` 映射记入 `.pace` runtime,SubagentStop 按 agent_id 查表识别,不依赖 agent_type 值形态;②短期先加「artifact-writer 派遣禁带 name 参数」的 guard 检查(一行);③ close/owner 关闭动作幂等化(对每轮触发免疫——现状 missing-target skip 恰好幂等,补测试锁定)。

### P2-4 Workflow 的 agentType 参数绕过 Agent 派遣门(宿主新工具)

- **定锚**:探针会话 D/E——Workflow 工具调用本身触发 PreToolUse(`tool_name=Workflow`,script 全文在 `tool_input.script`),但**内部 agent() spawn 不触发 PreToolUse Agent 事件**,子 agent 的 `agent_type` 恒为 `workflow-subagent`。
- **危害链**(实测已收窄):workflow agent 的 Write/Edit/Bash **各自触发 PreToolUse 且带 agent_id**(会话 E 实拍),且 `workflow-subagent` 不被识别为 artifact-writer → 写码门、artifact 直写保护对 workflow 路径全部兜底闭合。真正被绕的只有派遣门:`Workflow(script 含 agentType: 'paceflow:artifact-writer')` 的派遣检查不存在,但该 agent 落盘 artifact 时会被 DENY_DIRECT_ARTIFACT_WRITE 拦(它不是 artifact-writer 身份)。**净效果:workflow 路径不能用来写 artifact,只是没有派遣时刻的字段引导**——按「门是兜底非主防线」原则可接受,低优处置:pace-workflow 散文加一句「artifact-writer 不经 Workflow 派遣」即可,无需 hook 改动。
- 顺带:PACE 项目内 fail-closed 白名单(pre-tool-use.js:760,直喂实测 DENY_BAD_TOOL)意味着未来给任何新工具补门时 **matcher 与代码分支必须同 commit 改**,只改 matcher 就是无差别硬拦事故。

### P3-5 PreCompact/compact 通路萎缩 + skill 列表 compact 后不重注入(宿主上下文管理演进)

- **定锚**:cache 日志近两月 PreCompact 仅 1 次(2026-06-24);changelog:summarization(LLM 摘要)与 compact 并存,PreCompact 未废除,skill 描述列表 compact 后不重新注入(v2.1.198+),SessionStart source 增 `fork` 值(matcher 不含 fork)。
- **影响**:① pre-compact.js 的 native plan 检测近两月实际未工作——但它本来就是低频兜底,维持现状可接受;② skill 列表丢失恰好被 PACEflow SessionStart 注入的工作流入口提示(「先调用 Skill(paceflow:pace-workflow)」)缓解——**这是 PACEflow 对新宿主环境的意外增值**,SessionStart 注入的入口提示比以往更关键,不可削减;③ source=fork 未注入:fork agent 继承主上下文,PACE 上下文随之继承,暂无缺口;确认 matcher 加 `fork` 的成本与收益后再决定(低优)。

### P3-6 杂项(记录即可)

- `.ipynb`/NotebookEdit 双缺口(直喂实测 Write .ipynb 放行):按「门是兜底非主防线」维持现状,显式判定不修。
- Stop 拦截计数器重置缺陷(本 session 实测:第 3 次警告「下次降级」后计数回到「第 2 次」):`.pace/stop-block-count` 的重置条件与新交互模式(AskUserQuestion 轮次、teammate 消息轮次、background 等待)不匹配,降级承诺不兑现,形成拦截乒乓。真实 UX 缺陷,建议修(计数键改绑「同一问题指纹」而非轮次连续性)。
- `CLAUDE_CODE_SUBAGENT_MODEL` env(v2.1.198+)可全局覆盖 artifact-writer 的 `model: sonnet`——用户须知,文档一句话。
- teammate 判定仍依赖 `CLAUDE_CODE_TEAM_NAME`;新「单隐式 team」模型下该 env 的赋值行为待观察(本轮未见异常)。
- changelog agent 报告的「后台 agent 在 worktree 完成时自动 commit/push/开 draft PR(v2.1.198)」**未经原文核验,存疑待查**;即便为真也是 harness 层行为,PACEflow hook 不可见、不可拦,属用户须知而非 plugin 修复项。
- isolation: remote(云端执行)的本地 hooks 行为文档未明确,无法本地实测;PACEflow 用户场景中 remote 占比趋零,标注文档缺口即可。

---

## 三、机会面(新能力 → PACEflow 提升候选,按 ROI 排序)

| # | 宿主能力 | 版本 | 对 PACEflow 的价值 | 成本 |
|---|---------|------|-------------------|------|
| O1 | **SubagentStart 事件**(agent_id/agent_type,探针实拍) | ≤2.1.232 | 派遣时刻确定性观察点:记 `agent_id→subagent_type` 映射解决 P2-3 识别问题;artifact-writer 生命周期日志闭环(start/stop 对账) | S |
| O2 | **Notification 事件**(agent_needs_input/agent_completed) | 2.1.198 | background agent 完成的可靠信号——比「每轮 idle 的 SubagentStop」语义干净;若 artifact-writer 未来允许后台,收口应挂这里;近期可先只做 logging-only 观察(同 StopFailure 先例) | S |
| O3 | **UserPromptSubmit 事件**(含 prompt 字段,探针实拍) | 早已有 | 每轮 prompt 时点的轻量注入通道:活跃 CHG 一行摘要/门状态提醒,补 SessionStart 10K cap 之外的「防长上下文遗忘」第二注入点(设计宪法「记录/恢复层是真护城河」正中靶心);注意控制频率与体积,避免每轮税 | M |
| O4 | **PreCompact 阻止能力**(`decision:block`/`shouldCompact:false`) | 2.1.105/107(上轮已知,本轮确认仍在) | compact 前有未收口 CHG 时可阻止/提醒——但 compact 通路本身萎缩(两月 1 次),ROI 下降,继续搁置 | - |
| O5 | **同步 helper 模式扩展**(对照 engineering-2026-06-13 异味 4) | - | 宿主 resume/后台化时代,「机械单行 op 走受 hook 校验的同步 helper(如 reserve-artifact-id 模式)」比 SendMessage resume 更符合确定性原则,可作为 resume-per-CHG 的替代降本路径重新评估 | M-L |
| O6 | Archive 插件源(HTTPS zip + SHA-256 pin) | 2.1.224 | 发布渠道备份:无 git 环境用户可装;对现有 marketplace 用户零影响 | S(发版流程加一步) |
| O7 | `DirectoryAdded` 事件 | 2.1.219 | /add-dir 时补注入 PACE 上下文(多目录 session 的 Project Root 判定提醒);低频,backlog | S |

不采纳项:Task* 系列与 PACEflow task.md 双轨(README 已明确「任务面板是工作记忆非权威」,维持);CronCreate/ScheduleWakeup(与 PACEflow 无交集);isolation: worktree(现有 worktree 归一已覆盖)。

---

## 四、建议行动(按优先级)

1. **CHG-A(P1)resume-per-CHG 编排收窄**:SKILL.md E 段改为「resume 仅限 append/update-status 等无字段门 op;approve/verify/review/close 必须 fresh spawn 过派遣门」+ agent-lifecycle-guard 无需改(fresh spawn 路径门已全)。同 CHG 内把「artifact-writer 派遣必须 `run_in_background: false`、禁带 `name` 参数」两条确定性检查加进 agent-lifecycle-guard(P1-2/P2-3 的短期修),配 deny 文案与 e2e 负例。
2. **CHG-B(P2)SubagentStop 识别与收口加固**:注册 SubagentStart(logging + agent_id→type 映射入 .pace runtime),subagent-stop.js 改按映射识别 + owner 关闭幂等化测试。
3. **CHG-C(P3)Stop 计数器乒乓修复**:stop-block-count 键绑问题指纹,降级承诺可兑现。
4. **散文同步(随 CHG-A)**:审计 agent inline 约束三处注明宿主默认翻转;pace-workflow 加「artifact-writer 不经 Workflow 派遣」;README/REFERENCE「Subagent 在主进程内执行同步等待」表述更新为「默认后台,PACEflow 要求 artifact-writer 显式前台派遣」。
5. **观察项(不动代码)**:Notification/UserPromptSubmit 机会(O2/O3)待 CHG-A/B 落地后按需评估;auto-commit 传言核验;PreCompact 维持退役态。

---

## 五、方法论备注

- 三源交叉印证再次生效(记忆 multi-auditor-blind-spots):changelog agent 二手报告中「Workflow 内部 spawn 各自触发 PreToolUse hook」的表述不精确——实测区分出「工具调用层触发、派遣层不触发」的双层真相;「auto-commit/push」条目未采信待核验。二手结论逐条定锚仍是铁律。
- 探针方法(独立 dump-stdin + headless 子会话)复用 audit-2026-05-31 方案,单次会话成本 <1 分钟,建议沉淀为常备工具(未来每次宿主大版本用同一 fixture 重跑五连测)。
