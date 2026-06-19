# 审计报告：PACEflow v7.2.18 全维度严格审计

- **日期**：2026-06-19
- **审计者**：Claude (Opus 4.8 1M) — ultracode 多 agent workflow + 主 session 亲核
- **范围**：发布面全维度（plugin/** + README + REFERENCE + tests + migrate）
- **基线**：HEAD 6fea51b（v7.2.18），`node tests/run-all.js` 8/8

## 方法论

12 维度并行 finder（24 agents / 1.41M tokens / ~19min）→ 每条 finding 对抗复核（默认 refute、回 file:line 定锚、查设计意图、按真实可达性校准）→ 完整性批判 → **主 session 逐条端到端再定锚**（verifier 结论全部当二手处理，回代码/规格/测试/确定性 repro 复判）。

校准原则（项目既有方法论 + 记忆）：severity 按真实日常可达性（非数学可能性）；PACEflow 是纪律工具非质量控制非安全沙箱；门是兜底非主防线、是时刻门非账本、读事件+状态非话术（blocklist 数学宿命）。

## 结论速览

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| P0 / P1 | **0** | 核心运行时门（写码门 / Stop 门 / 规格符合 / 安全 / 打包）全清 |
| P2 | 4 | 测试基建 + 文档树 |
| P3 | 8 | 健壮性/一致性瑕疵 + 2 条话术门 + 2 条已登记 finding 的具体实例 |

| 驳回/关闭 | 4 | artifact-dir-cache / BOM / commands 断引用 / 注入 |

> **复核更正（2026-06-19，维护者质疑后）**：原 P2-1（approve 守卫扫 evidence）经复核**降为 P3**——`action` 由结构化字段决定（AI 正确判断在先），deny 文案为条件句（不误导正常 AI），触发面窄且无数据丢失；与孪生话术门 P3-1 同构同级。下文条目位置保留以存审计轨迹，severity 以本表为准（P2=4 / P3=8）。

**最高信号主题**：`agent-lifecycle-guard.js` 残留 2 处 prose blocklist 话术门，与项目自己删除 COMPLETION_PHRASES（CHG-20260616-04）确立的「确定性门读事件+状态、绝不解析话术」原则自相矛盾。值得修的理由不是误伤频率，是架构一致性。

零 P0/P1 表明这是成熟、测试充分的代码库。

---

## 解决状态（截至 2026-06-20 v7.2.20）

本审计发现已大部分闭环：

| 发现 | 级别 | 状态 | 修复版本 / CHG |
| --- | --- | --- | --- |
| P2-1 approve evidence 话术门 | P3（复核降级） | ✅ 已修 | v7.2.19 / CHG-20260619-03 |
| P3-1 update-status verify 话术门 | P3 | ✅ 已修 | v7.2.19 / CHG-20260619-03 |
| P2-2 LOG-ISOLATION flaky | P2 | ✅ 已修 | v7.2.19 / CHG-20260619-04 |
| P2-4 README 漏 command-recognition.js | P2 | ✅ 已修 | v7.2.19 / CHG-20260619-05 |
| P2-5 README 漏 session-start/ 子目录 | P2 | ✅ 已修 | v7.2.19 / CHG-20260619-05 |
| P3-4 update-index/finding 早期字段门 | P3 | ✅ 已修 | v7.2.20 / CHG-20260619-07 |
| P3-7 ts/todayISO 去硬编码时区 | P3 | ✅ 已修 | v7.2.20 / CHG-20260619-07 |
| P3-2 format-warnings head 无 cap | P3 | ⏳ 未修（= 已登记 finding-2026-06-15-sessionstart-budget-head） | — |
| P3-3 helper 多余 positional 静默丢弃 | P3 | ⏳ 未修（backlog） | — |
| P3-5 agent-yaml count===34 脆性 | P3 | ⏳ 未修（backlog） | — |
| P3-6 migrate-v7 写盘无原子/回滚 | P3 | ⏳ 未修（backlog） | — |

注：R 审计在 CHG-07 内另抓出并即修 1 处 update-index target over-block（firstToken 容错，未列入原审计、v7.2.20 内闭环）。剩余 4 条 P3 均为低优可维护性 backlog，无日常功能影响。

---

## P2 发现（5 条）

### P2-1 ⭐ approve 守卫扫 approval-evidence 用户原话做话术拦截 — 复核后降 P3
**位置**：`plugin/hooks/pre-tool-use/agent-lifecycle-guard.js:418-423, 548-556`

第 422 行 `/(?:开始实施|开始执行|立即开始|启动任务|标记为\s*\[\/\]|标记.*进行中)/i` 扫**整段 prompt**（含 `approval-evidence`）。而 `agent-references/instructions/update-chg.md:137` 明文规定 approval-evidence 是「用户原话，agent 不验证证据真伪」。approve-only 场景用户原话（如「等我确认后再开始执行」「先批准，暂不开始执行」）逐字引用即误伤 DENY；deny 文案反向指引改用 `approve-and-start`，与「暂不开始」意图相悖；唯一绕法是篡改本应逐字保留的原话，与 spec 矛盾。

**亲核**：读代码 + 配套测试。测试 9hc1d（test-hooks-e2e.js:4586）刻意选「稍后再开始」（不含正向起始动词）才绕开 blocklist，反证误伤面真实存在。测试 9hc1c（:4559）的 DENY 另有 `将 status 改为 in-progress` 指令行触发，删第 422 行后仍绿。

**校准**：verifier P1 → 初判 P2 → **复核后 P3**。危害链复核：① `action` 由结构化字段决定（`promptDeclaredAction:410-412` 先读 `action:`），AI 的正确判断在先，守卫只是在已正确的结构化决定上做二次散文猜疑；② deny 文案是条件句（line 552「approve 适用于先批准但暂不执行」+ line 553「若准备开始才改 approve-and-start」），self-aware，正常 AI 不会被误导启动；③ 触发须 AI 正确选 approve ＋ 原话含正向起始动词（非常见措辞），命中后仅一次 re-dispatch 摩擦、无数据丢失。守卫正向价值也低（AI 几乎不会「声明 approve 却想启动」自相矛盾）。与孪生 P3-1 同构同级。修它的理由是**架构一致性/清理低价值守卫**，非修常见 bug。

**修法**：删第 422 行纯散文分支（结构化分支 420/421「status→in-progress」可保留）。理想态：只读结构化字段判「approve 夹带启动意图」，不扫 evidence 自由文本。

### P2-2 ⭐ LOG-ISOLATION 等价锁锚定全局共享文件 → dogfood 下 flaky
**位置**：`tests/test-hooks-e2e.js:1526-1539`

测试断言「注入 PACE_LOG_PATH 后源码树 `plugin/hooks/pace-hooks.log` 的 mtime/size 不变」，锚定的是**会被外部并发写的可变资源**，违反等价锁应锚定不变量的原则。

**亲自确定性证明**：
1. 主 session 亲跑 `node tests/run-all.js` = **8/8 全绿**（LOG-ISOLATION PASS）；
2. workflow verifier 同代码跑出 **7/8 FAIL**（捕获 mtime/size 漂移）；
3. repro：`delete process.env.PACE_LOG_PATH; createLogger()(logEntry(...))` 向源码树 srcLog **append 132 bytes**（`defaultLogPath()` 无 env 时解析到 `plugin/hooks/pace-hooks.log`）。

三者组合 = 非确定性 = flaky 坐实。根因：live Claude session 的 hook 不注入 PACE_LOG_PATH（回退源码树日志），dogfood（本仓库 PACEflow 已激活时跑测试）期间任一 hook 写落进 `before=stat()` 与 assert 之间的窗口即红。

**可达性**：日常可达（维护者发版前跑测试的常态）。污染 release gate（CLAUDE.md「run-all 8/8 → push」），训练「重跑即绿」掩盖真回归。**P2**（测试基建，非产品功能错误）。

**修法**：断言改为按内容正向判定——验 `E2E_LOG_PATH` 被写 + 源码树日志在测试窗口内无本测试 dir/sid 标识的新行，免疫无关并发写，同时保留「某 hook 漏用 createLogger 仍污染源码树」的检测意图。

### P2-3 agent-tests 20 个用例 fixture 仍 v6 schema（套件休眠）
**位置**：`tests/agent-tests/cases/**`（grep `schema-version: "6.0"` = 20 文件）

产品已 7.0 封闭合同（`change-analysis.js:260` 对非 7.0 帧返回 `ok:true + skipped`）。套件复活真跑时负向用例会 fail-open。**已登记** `finding-2026-06-14-agent-tests-v6-fixture-stale-suite-dormant`；run-tests.js 不在 run-all SUITES（仅 mock 自测 test-agent-tests-helpers.js 在），无 CI 影响。受控技术债。

**修法**：复活前批量升 20 文件至 7.0 9-key + 接 `frontmatter_schema_version` 期望。

### P2-4 README 结构树漏 command-recognition.js
**位置**：`README.md` 项目结构树 pre-tool-use/ 段

pre-tool-use/ 实有 5 文件，树以 `└──` 穷举列 4，漏 `command-recognition.js`（被 bash-guard.js:9 / powershell-guard.js:9 `require`）。文档过时。**修法**：marker-guard.js 后按字母序补一行。

### P2-5 README 结构树完全漏 session-start/ 子目录
**位置**：`README.md` 项目结构树 session-start.js 段

session-start/ 实有 4 文件（layers/budget/collect-state/runtime-effects），树**完全无 session-start/ 子目录行**——而 pace-utils/、pre-tool-use/ 都列了（非对称遗漏），且漏的正是 v7.2.18 改动落点 layers.js。**修法**：session-start.js 行下补 session-start/ 子目录行。

> 注：树**正确**列了 commands/ 5 文件 → 证伪 release-packaging 维度对「commands/ 断引用」的怀疑。

---

## P3 发现（7 条）

| # | 位置 | 问题 | 修法 / 备注 |
| --- | --- | --- | --- |
| P3-1 ⭐ | agent-lifecycle-guard.js:391-396, 558 | update-status 守卫第 395/396 行散文正则 `/执行\s*verify\s*操作/`、`/\bverify\s+操作/` 扫 `status-reason` 做话术拦截。单次派遣 action 已唯一确定，无 update-status+verify 串联机制，纯属猜意图（话术门） | 删散文分支，保结构化(393/394)。触发面窄（须 literal "verify 操作"），写"验证"即绕。verifier P2 → **P3** |
| P3-2 | session-start/layers.js:801 | `renderFormatWarnings` schemaViolation 循环无 `ACTIVE_CHG_SUMMARY_MAX` cap（姊妹 section 722/769 都有）→ head 可无界撑爆 | 加 `.slice(0,12)` + 长尾指针。**= 已登记** `finding-2026-06-15-sessionstart-budget-head-no-hard-cap` 的具体实例；需数十破损 CHG 才触发 + 有 OVER_BUDGET 日志可见性 |
| P3-3 | reserve / set-project-root / set-artifact-root / sync-plan 的 parseArgs | 多余 positional 静默丢弃，与 unknown-flag 的 fail-closed 不对称 | 补 else 计入 unknown 走 DENY_UNKNOWN_OPTION。cwd 永从 `--cwd`/默认取，**无写错目录/数据丢失风险** |
| P3-4 | agent-lifecycle-guard.js（update-index/update-finding 落 return ''） | 这两个 operation 无早期字段门 | **设计一致**（agent fail-closed 自校验，缺字段仅多一次往返）。isDesignIntent=true，可 won't-fix |
| P3-5 | test-agent-tests-helpers.js:67 | `assert.strictEqual(count, 34)` 硬编码魔法数，增删 case 必手改否则套件红 | 改动态推导 / 断言文件名集合（`>=30` 会丢"误删检测"，非纯优） |
| P3-6 | plugin/migrate/migrate-v7.js:352-354 | 写盘循环无 try/catch；仅 schema 验收失败(367-374)才回滚。IO 崩溃→部分覆盖无自动回滚 | **备份循环(347-351)已先于写盘完整跑完→可手动恢复，无永久数据丢失**。一次性脚本，低可达。建议补原子写(temp+rename)/异常回滚 + 失败模式测试 |
| P3-7 | path-utils.js:20,24 | 硬编码 `Asia/Shanghai` 时区 | date 字段与 aged-finding "今天" **同源 Shanghai，不存在门 off-by-one**；仅非中国用户看到的日历日偏移（cosmetic）。单作者有意选择，**可 won't-fix** |

---

## 驳回 / 关闭（亲核证伪）

| 项 | 维度 | 证伪依据 |
| --- | --- | --- |
| artifact-dir-cache stale | pace-utils | `_clearArtifactDirCache` 在 test-pace-utils.js 有 12+ 调用（test seam，非死导出）；生产单进程 + set-artifact-root 回读走 getConfiguredArtifactDir 不经此缓存，不可达。**驳回** |
| BOM/CRLF 绕过确定性门 | 完整性盲区 | `change-analysis.js:43` 与 `line-endings.js:9` 正则 `/^﻿?---\r?\n…/` 已显式处理 BOM + CRLF；isChangeApproved/Verified/Reviewed 的 marker 正则无行锚。**非 finding** |
| commands/ 断引用 | release-packaging | plugin/commands/ 实有 5 文件，plugin.json 引用全有效。`claude plugin validate` 通过。**驳回** |
| 命令注入 / 路径遍历 / 密钥泄露 | security | execFile 数组传参、零 `shell:true`、零 eval；path-utils 有 PU-001 normalize 纵深防御；pace-hooks.log 已 gitignore 且 grep 无密钥。**无**（仅攻击可达的自定义 artifact-root path 属设计内配置，符合「纪律工具非沙箱」） |

---

## 各维度健康

| 维度 | 结果 |
| --- | --- |
| 写码门(pre-tool-use) | 清（matcher 全覆盖 + fail-closed + 无话术残留） |
| Stop/SubagentStop 门 | 清（COMPLETION_PHRASES 已删干净无回潮 + 读事件状态决策） |
| pace-utils | 清（1 条驳回） |
| SessionStart 注入/预算 | P3-2（已登记类） |
| PostToolUse/lifecycle | P3-4（设计一致） |
| CLI helpers | P3-3 |
| 测试质量 | P2-2 + P2-3 + P3-5 |
| 文档一致性 | P2-4 + P2-5（版本号 5 处同步干净，bump-version 覆盖准确） |
| 规格符合性 | 清（9-key 合同 ↔ SCHEMA_V7_KEYS 一致，强制层级与 spec 吻合） |
| 门设计(元审计) | P2-1 + P3-1（其余门均合理） |
| 发布面打包 | 清（plugin/commands/agents/hooks/LICENSE/marketplace 全有效） |
| 安全/注入 | 清 |

---

## 修复方案优先级建议

1. **优先**：P2-2 LOG-ISOLATION 改按内容断言（独立 CHG，修发版门可靠性——唯一会污染 release gate 的真 flaky）。
2. **次优（一个 CHG 可闭环，但属低价值清理）**：P2-1(降P3) + P3-1 两条话术门——删散文 blocklist 分支，对齐「门只读结构化字段」原则。同源同文件，天然一个闭环；危害低，做它是为架构一致性，非修常见 bug。
3. **文档**：P2-4/P2-5 README 树补两行。
4. **backlog**：P3-2~P3-7 进 findings 待修 / won't-fix（P3-4、P3-7 倾向 won't-fix）。

> 本次为只读审计：未改任何代码、未写 finding artifact。后续修复须走 PACE 流程（建 CHG + 批准）。
