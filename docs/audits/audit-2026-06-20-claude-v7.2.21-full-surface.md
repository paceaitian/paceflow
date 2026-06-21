# audit-2026-06-20 PACEflow v7.2.21 全维度严格审计

## 审查摘要

- 审查时间：2026-06-20T17:35:00+08:00
- 审查基线：git HEAD == origin/master == `4fc6a97`（v7.2.21）；工作区干净，仅 6 个未跟踪历史审计文档（`docs/audits/audit-2026-06-1*.md`），所有 tracked 文件 == HEAD，直读工作区。
- 审查方法：ultracode 多 agent workflow——**9 维度独立 finder（不加约束保广度）→ 对抗验证（默认立场=误报，C/H 逐条 + W/I 批量分诊）→ 完整性 critic**；随后**主 session 亲自端到端一手实证**每条 C/H + 代表性 W/I，并与历史审计报告/findings backlog 逐条交叉。补一轮覆盖空洞 finder（change-analysis.js / post-tool-use.js / plans.js）。
- 发布面规模（Glob 动态发现）：37 hook .js（pre-tool-use 编排 + 5 子守卫 + 4 session-start 子模块 + 11 pace-utils 模块 + 4 CLI helper + 生命周期）、4 用户 skill + references/templates、1 agent + 9 instruction、migrate-v7、6 测试套件、6 模板。

### Phase 统计

- 独立发现维度：9（其中 tests-architecture-docs 维度首轮配额中断、resume 补全）。
- 对抗验证 C/H：8 确认/部分（0 误报）；W/I 保留 22+。
- 主 session 一手实证：**4 守卫绕过全部用 `node require` 直调真实 gate 复现**（harness 见下）；GOLDEN 根因用判别实验厘清；CA-1/PL-3 由覆盖 finder 实证。
- 误报率（C/H 层）：0%——但主 session 修正了 **1 处根因误判**（GOLDEN 失败被 lifecycle finder 归因 PACE_VAULT_PATH，实为路径分隔符）与 **2 处验证员严重度变异**（GS-2/GS-4，一手实证定锚）。

### 验证基线说明（关键）

- `node tests/run-all.js` 在维护者本机 Windows 上实测 **6/8**（hooks-e2e + migrate-v7 失败）。**经判别实验确认：失败是测试 harness 的 POSIX-only 假设，产品代码不受影响**（详见 P2-TH）。`PACE_TEST_FILTER=pace-utils` 300/300 绿、`migrate-v7` 仅 V7E-6 一条红、`hooks-e2e` 21 条 GOLDEN 红。
- 主 session 一手实证脚本（临时 .pace 工程为 cwd，危险字面运行时拼接绕过 dogfood 自阻断）逐条复现守卫 gate 布尔值。

---

## 确认发现

### P1 必修——守卫 blocklist 残留簇（4 条，全部一手实证）

> 共性：4 条都是 `command-recognition.js` 段首锚点（MUTATING_ANCHOR）/ in-place 编辑器枚举 / eval-iex 命令替换识别的**枚举残留**。删 `.pace/locks/*` 非 git 可恢复（破坏序号唯一性/并发写锁/索引事务）；改 `task.md`/`changes/**` 绕过 artifact-writer 唯一写入门。**fix 解决「不对称」≠ 解决「blocklist 不完整」**——根治方向是白名单 / redirect 式 source-target 路径解析。

| ID | 文件:行 | 缺口 | 一手实测 |
|----|---------|------|---------|
| **GS-1** | `bash-guard.js:14` + `command-recognition.js:32` | `if;then`/`else`/`elif` 后的 mutating 动词不被段首锚定 | `if true; then rm -f .pace/locks/a.lock; fi` → rt=**false**；`else rm`、`elif…then rm` 同绕过；**`bash -c "if…then rm"` / `$(eval rm)` 放大同样绕过** |
| **GS-2** | `bash-guard.js:114`（shellCommandScripts）| `eval "<verb>"` / 裸 `eval rm` 不被解包（只解 `eval … bash\|sh -c`）| `eval "rm -f .pace/locks/a.lock"` → rt=**false**；`eval "sed -i … task.md"` → art=**false** |
| **GS-3** | `bash-guard.js:17-25`（INPLACE_EDITOR_SOURCE）| `ed`/`vi -es`/`vi -e -s`(拆分)/`ex`(无 -c)/`patch` 漏枚举 | `ed task.md`、`vi -es task.md`、`vi -e -s task.md`、`ex task.md`、`patch task.md < p.diff` → art=**false**；`ed .pace/locks/x` → rt=**false** |
| **GS-4** | `powershell-guard.js:38-61,87-97`（normalizePowerShellSearchText）| `iex`/`Invoke-Expression "<mutating cmdlet>"` 包裹的 cmdlet 在引号内不升格为命令边界，锚点匹配 `iex` | `iex "Remove-Item .pace/locks/a.lock"` → rt=**false**；`Invoke-Expression 'Remove-Item …'` 同绕过（finder 真实 PowerShell 7 执行复现真删）|

**根因机理**：
- `MUTATING_ANCHOR = (?:^|[\n;&|(){}\`]\s*)(?:(?:wrapper)\s+)*<verb>`。`segmentAnchorPrefix(allowLoops:true)` 只把 `do` 并入 wrapper 集（覆盖 `for/while/until…do`）；bash 复合关键字 `then`/`else`/`elif` 既不在 wrapper 也不在 extraChars，故 `; then rm` 中 `rm` 脱锚。`(){}` 在 extraChars 故 `case )`/`{ }`/function 体被拦——只有裸关键字语句列表漏。
- `shellCommandScripts` 的 `\beval\s+` 分支必须后接 `(?:bash|sh|zsh|fish)\s+-c` 才抽脚本体；`eval "rm…"` 直接跟动词不匹配。
- `INPLACE_EDITOR_SOURCE` 枚举了 sed -i/perl -pi/-i/sponge/awk -i/`ex -…c`/`vim -…es`，独漏 `ed`/`vi`(非 vim)/`ex`(无 -c)/`patch`。
- PowerShell 侧 `normalizePowerShellSearchText` 引号状态机把双引号内 `Remove-Item` 当字符串内容，`iex`/`Invoke-Expression` 不被当命令替换层递归剥包裹。

**历史交叉**：GS-2(eval) 与 GS-3(ed) 是 **2026-06-03 审计 BG-01/BG-02「点名未修」残留**（BG-01 已 confirmed P0 建议「裸 eval 递归当子脚本」；BG-02 点名 ed/ex/vim-es，仅部分修）。GS-1/GS-4 为新发现。均**不在当前 open backlog**。验证员对 GS-2/GS-4 出现 confirmed↔partial / H↔W 变异，**主 session 一手 harness 定锚：4 条全为真绕过**。

**严重度**：均 **P1（H）**——删 `.pace/locks` 非 git 可恢复、绕过 hardDeny 级 runtime-control 门；未升 C 因需 PACEflow 激活 + 主 session 主动发该形态命令（非被动数据丢失）。GS-1 的 `if cond; then rm` 是地道条件删除惯用法，可达性偏高；GS-4 `iex` 是地道 PowerShell。

### P2 必修——测试发布门 Windows 结构性失效（TH 簇，一手判别实验）

> **TH：`node tests/run-all.js`（CLAUDE.md 强制的发版门）在文档指定的 Windows 开发平台上结构性无法 8/8。产品代码不受影响，但发版验证纪律被掏空。**

| ID | 文件:行 | 根因 | 证据 |
|----|---------|------|------|
| **TH-1a** | `test-hooks-e2e.js:8791`（goldenNormalize）| `s.split(dir)` / `s.split(HOOKS_DIR)` 用 OS 原生（Windows 反斜杠）串替换；hook 显示路径是正斜杠归一形态，Windows 上两形态不等 → 21 个 GOLDEN 快照漂移 | 我捕获的 diff 显示 `<HOOKS>` 未替换 + `配置文件=<DIR>\.pace\artifact-root`(反斜杠) vs want 正斜杠；**判别实验：`env -u PACE_VAULT_PATH` 复跑仍 21 红** → 证否 lifecycle finder 的 vault-leak 归因；dimension-9 finder 独立确认分隔符根因（三重印证）|
| **TH-1b** | `test-migrate-v7.js:215`（snapshotAll）+ `:345` | `snapshotAll` 用 `path.relative`（Windows 反斜杠）做 key，V7E-6 循环用硬编码正斜杠字面量 `'changes/chg-…md'` 查表得 `undefined` | 前 4 个 flat 文件过、唯一带子目录的 `changes/chg-…` 红；`fs.existsSync(backed)` 已过 → migrate-v7.js 产品备份正常，纯测试 key 不匹配 |

**判定**：golden+snapshot 测试是 **POSIX-only**——POSIX 上 `dir` 正斜杠，`s.split(dir)` 命中所有形态；Windows 上只命中 `path.join` 那份、漏显示路径。维护者必在 WSL/Linux/Mac 跑发版门；Windows 本机照 CLAUDE.md 跑得 6/8 会误判为产品回归。**不在 backlog，新发现。** 严重度 P2（测试基建 + 发版门完整性，非产品缺陷），但因直接掏空文档强制门、且维护者本机即 Windows，列为 P2 最高优先。

### P2 建议——一致性/健壮性（部分一手实证）

| ID | 文件:行 | 问题 | 验证 |
|----|---------|------|------|
| **CA-1** | `change-analysis.js`（`ARCHIVE_PATTERN` constants.js:52）vs `:457` | `ARCHIVE_PATTERN=/^<!-- ARCHIVE -->\r?$/m` 不容忍标记行尾随空格，与 `findActiveIndexBelowArchive` 的 `[ \t]*$` 不对称 → 尾随空格时 `readActive` 退回全文 → **归档 CHG `[x]`/`[-]` 行被 parseChangeIndex 当活跃 entry，冒泡回活跃集**，污染 SessionStart 注入 + owner/close 门判定 | 覆盖 finder 实证：LF trailing-space → readActive-split N、findArchive Y |
| **WF-1** | `update-finding.md:56` | won't-fix 双口径：把「不带 change-link 的 accepted」叫 won't-fix 落 `[x]`，与全仓 ~10 处权威口径「won't-fix = status:rejected + rejection-reason → `[-]`，不注入」相左 | 主 session grep 全发布面交叉确认（pace-workflow:223-224 / record-finding:75 / artifact-management:251/275 / artifact-writer:370）|
| **AUD-1** | `internal/skills/audit/SKILL.md:48,50,51,101` + `agent-prompts.md:20,176,206,237` | 内部 audit skill 仍用「v6 基线 / v6-only / v6 注册一致性」标签，与 schema v7.0、PACE_VERSION v7.2.21、含 R/REVIEWED 的 v7 协议不一致 → 派出的审计 subagent 以 v6 校准误判 v7 模型 | 主 session 直读确认 |

### P3 延后——记 backlog

| ID | 文件:行 | 问题 | 状态 |
|----|---------|------|------|
| **SA-1** | `set-activation.js:41` | parseArgs 末尾 `else if(arg.startsWith('-'))` 只捕获 `-` 前缀 unknown，裸 positional 静默丢弃；是 5 个写 .pace 状态 hook 中**唯一无 positional guard** 者，与 CHG-20260620-01 刚加固的 4 helper 不对称 | 新发现（critic 抓出 + 主 session 一手核验），同 CHG-20260620-01 的 P3 定级 |
| **AC-1** | `artifact-writer.md:203` | update-finding 速查漏 `merged-into` 字段（update-finding.md:61 纳入「至少其一」与 format-violation）| 主 session 直读确认 |
| **AC-2** | `artifact-writer.md:195` + `agent-lifecycle-guard.js:186-195` | record-finding 速查 / hook recovery 模板未列条件必填 `rejection-reason`（record-finding.md:32 规定 status=rejected 时 ≥10 字符必填）| citation |
| **PK-1** | `pace-knowledge/SKILL.md:17` | 注入条数「startup 最多5 / compact 最多3」与 layers.js:987-1000 实际（按 kind 名额 wiki3/knowledge2/thoughts3、startup/compact 已统一）不符 | citation（layers.js:995-997 注释佐证）|
| **PL-3** | `plans.js:168-170` | `syncPlanFile` finally 无条件 `unlinkSync` 忽略 `lock.reentrant`，与 sequence 路径(locks.js:725-728)不对称；同 session 并发时删外层锁 | 覆盖 finder 实证 |
| **LK-1** | `locks.js:170-178` | stale-cleanup 仅凭 TTL 无 fencing token/owner liveness → 持有者超 TTL 时被误删致双持 | 主 session 直读源码确认（窄触发）|
| **SO-1** | `subagent-stop.js:133` | close-owner 门只看 task.md 活跃索引；close-chg 多步 Edit 非事务，索引先归档而 detail 终态 Edit 失败时过早 markChangeOwnerClosed | citation |
| **LL-1** | `pre-tool-use.js:482-493` | legacy `artifact-writer.lock` 带新鲜 timestampMs 时阻断新版 agent ≤30min，migrate-v7 不清该文件 | citation（critic 标需实证）|
| **FSW-1** | `migrate/fix-slug-wikilinks.js:89-92` | parseArgs 无 unknown-flag 拒绝、`--artifact-dir` 不 peek，与 CHG-20260620-01 加固工具不对称；`--dryrun` 拼错被静默吞→真写 | 仓库根一次性工具、非发布面 |
| **MV-2** | `migrate-v7.js:90-103` | restoreFromBackup 还原前未 mkdir 父目录，子目录被删时还原抛错（与备份侧 :349 mkdir 不对称）| citation |
| **ST-1** | `stop.js:405-421` | 降级后 setBlockCount(0) → 同 session 内「阻止3次→放行1次」锯齿而非永久软提醒（degraded 标记保证不死循环）| citation（critic 标需实证）|
| **TC-1** | `test-pace-utils.js:694` | eval/then/ed 残留簇 0 回归测试，知情保留无 accepted-risk 锚定 → 行为变更不触发信号 | 与 P1 守卫簇关联 |
| **TV-1** | `test-migrate-v7.js:366-368` | V7E-7 用本地时区 `new Date()` 自拼 today 断言，与 v7.2.20 调整后的 product `todayISO` 口径潜在不一致 → 跨午夜跨时区偶发误红 | 新发现 |
| 死代码/I 簇 | `locks.js:703-730`（reentrant finally 死代码）、`marker-guard.js:28-56`（MultiEdit 抵消 fail-open，被兜底）、`pace-utils.js`（isProjectRootMarkerPath 非对称排除）、`pre-tool-use.js:222`（isUnderDir 空串当 base，当前不可达）、`locks.js`（孤儿资源/序列锁无周期清理、safeLockName %→_ 碰撞面）| 可读性/防御性 I | citation |

### 已记录 backlog（本轮重新独立发现，确认仍 open）

- **MV-1**（= `finding-2026-06-20-migrate-v7-write-loop-no-try-catch`）：migrate-v7.js:344-374 写盘循环无 try/catch，IO 崩溃留半迁移态。一手交叉：备份循环先于写盘完整跑完、`--restore` 可字节级还原（V7E-15 已测）、一次性 dev 工具 → 验证员从 H 降 W，与既有 P3 定级一致。
- **BH-1**（= `finding-2026-06-15-sessionstart-budget-head-no-hard-cap`）：layers.js:796-828 renderFormatWarnings 按违规 CHG 数无界累积到永不截的 head，极端态可超 10K cap。
- **AT-1**（= `finding-2026-06-14-agent-tests-v6-fixture-stale`）：artifact-writer 契约套件 17 个 v6 fixture、套件休眠不在自动回归网；+ agent-tests/README 目录树漏 phase-v、empty-v6 注释含 v6 implementation_plan。

---

## 部分正确 / 有意设计（不修）

- **GS 簇「根治建议」**：把 then/else 并入 wrapper、补 ed/vi/ex、递归 eval/iex 都是堆 blocklist 特例；真正的有意设计取舍是「blocklist 锚点枚举 vs 白名单」——见 `direction-2026-06-13-constraint-philosophy-evidence-gates.md`。本报告按「先补点名残留 + e2e 锚定，根治另立项」处理，非要求立即重构。
- **CA-2**（change-analysis status 大小写敏感）：spec 明确 status 全小写，整条流水线一致按小写假设，`unknown-value` 是正确结果，非分叉 bug，仅 Info 备忘。
- **post-tool-use.js**：覆盖 finder 读全 348 行未发现可报 bug（health 9/10）；澄清它是纯读+告警 hook、不做 line-ending 回写。

---

## 误报分析

- **C/H 层 0 误报**，但主 session 修正了对抗验证的两类偏差，印证「confirm 不可盲信、根因需一手」：
  1. **根因误判**：lifecycle finder 把 21 个 GOLDEN 失败归因 `PACE_VAULT_PATH` env 泄漏。判别实验 `env -u PACE_VAULT_PATH` 复跑仍 21 红 → 证否；真因是 goldenNormalize 路径分隔符。**修法完全不同**（修归一器分隔符 vs scrub env）。
  2. **严重度变异**：GS-2(eval) run1 partial→run2 confirmed；GS-4(iex) run1 confirmed/H→run2 partial/W。主 session 一手 harness 定锚两者均真绕过，按「PS/bash 地道形态 + 非 git 可恢复」统一 P1。

---

## 验证矩阵（C/H + 关键 W）

| 发现 | 验证方法 | 结论 |
|------|---------|------|
| GS-1/2/3/4 | **主 session `node require` 直调真实 gate**（pace-audit-harness.js/harness2.js，临时 .pace 工程，危险字面运行时拼接）+ 源码追踪 + regex 级实证 + 兄弟形态穷举 + bash -c/$()/elif 放大验证 | ✅ 全确认 P1，0 误报 |
| TH-1a GOLDEN | 捕获 diff + goldenNormalize 源码 + **判别实验 env -u PACE_VAULT_PATH** + dimension-9 独立确认 | ✅ 确认 P2，根因=分隔符（非 vault）|
| TH-1b V7E-6 | 测试失败追因 + snapshotAll/path.relative 源码 | ✅ 确认 P2，测试 key 不匹配（产品正常）|
| CA-1 ARCHIVE | 覆盖 finder 实证（readActive-split vs findArchive） | ✅ 确认 P2 |
| WF-1 won't-fix | 主 session grep 全发布面交叉（~10 处权威 vs 1 处离群）| ✅ 确认 P2 |
| SA-1 set-activation | 主 session 直读 parseArgs + 与 4 加固 helper 对比 | ✅ 确认 P3 |
| PL-3 / LK-1 | 覆盖 finder 实证 / 主 session 源码确认 | ✅ 确认 P3 |
| MV-1/BH-1/AT-1 | 历史 backlog 交叉，本轮独立复现 | ✅ 仍 open，定级不变 |
| 其余 W/I | 验证员 code-cited + 主 session 抽查 | 见各条「验证」列 |

---

## 剩余风险 / 未覆盖（诚实披露）

critic 标注、本轮未深入实证的覆盖空洞：

1. **守卫绕过家族**：`bash -c`/`$()`/`elif` 放大已一手确认绕过；`while/until…do` 已确认**被拦**（安全）。但 Monitor 工具继承 bash 全部绕过（同识别栈，已确认）、Agent embed-scan 绕过面（>256KB 脚本跳过、symlink 目标、depth>2 链式 require）未审。
2. **并发写 .pace 的 command hook**：`reserve-artifact-id.js`、`set-activation.js` 的多 session 并发（同时 enable/disable、reserve 与 release 交错）未审。
3. **失败/退出事件 hook**：`post-tool-use-failure.js`（含 releaseArtifactResourceLock 释放路径——并发敏感）、`stop-failure.js`、`pre-compact.js`、`session-end.js` 零发现，未深审；尤其 post-tool-use-failure 的「失败时主动释放他人锁」路径（isArtifactWriterAgentType 误判/owner 缺失）值得专审。
4. **正向回归防护**：tests-architecture 三条 W 都是 Windows 误红；但 test-pace-utils.js 对 eval/if-then/ed 绕过簇 **0 正向覆盖**（TC-1），意味着即便修了 P1 守卫，CI 也无法拦住回归——比 Windows flaky 更关键。

---

## 证据来源

- 源码：`plugin/hooks/pre-tool-use/{bash-guard,powershell-guard,command-recognition,marker-guard,agent-lifecycle-guard}.js`、`pre-tool-use.js`、`pace-utils/{locks,change-analysis,plans,constants}.js`、`session-start/layers.js`、`stop.js`、`subagent-stop.js`、`post-tool-use.js`、`set-activation.js`、`migrate/migrate-v7.js`、`migrate/fix-slug-wikilinks.js`。
- 契约/文档：`plugin/agents/artifact-writer.md`、`plugin/agent-references/instructions/{update-finding,record-finding,close-chg}.md`、`plugin/skills/*/SKILL.md`、`internal/skills/audit/{SKILL.md,references/agent-prompts.md}`。
- 测试：`tests/{run-all,test-hooks-e2e,test-migrate-v7,test-pace-utils}.js`（实跑 + 失败追因）。
- 一手实证：`pace-audit-harness.js` / `pace-audit-harness2.js`（直调真实 gate）、`env -u PACE_VAULT_PATH` 判别实验、真实 PowerShell 7 执行（finder）。
- 历史交叉：`docs/audits/audit-2026-06-{03,19}-*.md`、`findings.md` backlog、`corrections.md`。

---

## 修复方案（建议分组为 CHG/HOTFIX）

### HOTFIX-A：守卫 blocklist 残留簇（P1，建议 `create-chg --type hotfix`）

一处共享识别层根因，建议**同批 bash↔PowerShell 对称落地 + 同批补 e2e**：

1. **GS-1**：`command-recognition.js:30-35` `segmentAnchorPrefix` 新增 `allowConds` 选项（或直接把 `then`/`else`/`elif` 并入 `do` 同档 wrapper），`bash-guard.js:14` MUTATING_ANCHOR 传 `allowConds:true`。
2. **GS-3**：`bash-guard.js:17-25` INPLACE_EDITOR_SOURCE 补 `ed\b`、`vi\s+-[^\s;]*e[^\s;]*s?\b`（覆盖 `vi -es`/`vi -e -s` 拆分）、`ex\b`（放宽不强制 -c）、`patch\b`。
3. **GS-2 / GS-4**：把 `eval`（含 `eval --`/引号变体）与 PowerShell `iex`/`Invoke-Expression` 当**命令替换层递归剥包裹**——抽出其后引号/裸串作为子命令送回 `commandTextLooksMutating` + `referencesArtifact/RuntimeControl`（与 `$()`/反引号递归同构）。
4. **e2e（必补，否则回归无护栏，对应 TC-1）**：`test-hooks-e2e.js` 钉死 `if;then rm <lock>`、`else rm`、`elif…then rm`、`eval "rm <lock>"`、`ed task.md`、`vi -es task.md`、`bash -c "if…then rm"`、`$(eval rm)`、PowerShell `iex "Remove-Item <lock>"` 全部 **deny**；bash↔PS 对称用例。
5. **根治另立项（非本 HOTFIX）**：blocklist 锚点枚举 → 白名单/redirect 式 source-target 路径解析（见约束哲学文档）。

> 注意（来自历史教训 `audit-guard-fix-residuals`）：① 修复必查反噬——归一/收窄正则勿打破另一侧或重开旧洞；② bash↔PS 对称核查（GS-1 当前 PS 因 `{}` 锚定不漏，但保持识别层对称防未来 extraChars 改动引入不对称）；③ 改 `plugin/**.js` 源码会被代码写入门拦，须在活跃 CHG 下走 artifact-writer 流程或配对单测验证判别力。

### CHG-B：测试发布门 Windows 可移植（P2）

1. **TH-1a**：`goldenNormalize` 对每个路径 token 同时替换原生形态与正斜杠形态——`for (const tok of [dir, dir.replace(/\\/g,'/')]) s = s.split(tok).join('<DIR>')`，HOOKS_DIR/REPO_ROOT 同理；并确保 golden 快照用正斜杠占位。
2. **TH-1b**：`snapshotAll` key 归一正斜杠——`files[path.relative(dir,p).split(path.sep).join('/')]=…`（或 V7E-6 循环改用 `path.join` 构造 key）。
3. 或在 CLAUDE.md「常用验证」段显式注明发版门需在 POSIX（WSL/Linux）跑——但首选修 harness 让 Windows 本机也能 8/8。

### CHG-C：一致性/文档（P2/P3，可顺手批量）

- **CA-1**：`constants.js:52` ARCHIVE_PATTERN 收敛为 `/^<!-- ARCHIVE -->[ \t]*\r?$/m`，与 findActiveIndexBelowArchive 对齐（或反向统一两处到单一常量），补尾随空格回归用例。
- **WF-1**：删 `update-finding.md:56`「(won't-fix)」括注，保留「接受为已知限制」，钉死 won't-fix 单一口径走 rejected/[-]。
- **AUD-1**：`internal/skills/audit/SKILL.md` + `agent-prompts.md` 的「v6 基线/v6-only」改 v7.0 口径。
- **AC-1/AC-2**：`artifact-writer.md` update-finding 速查补 `merged-into`、record-finding 速查补条件必填 `rejection-reason`；`agent-lifecycle-guard.js` recovery 模板同步。
- **PK-1**：`pace-knowledge/SKILL.md:17` 改按 kind 名额或泛化描述。
- **SA-1**：`set-activation.js:41` parseArgs 补 positional fail-closed，与 CHG-20260620-01 对称。

### record-finding（P3 backlog）

PL-3 / LK-1 / SO-1 / LL-1 / MV-2 / ST-1 / FSW-1 / TV-1 / TC-1 + 死代码 I 簇——派 `record-finding` 进 backlog（actionable 留 `[ ]`）。MV-1/BH-1/AT-1 已在 backlog，无需重记。

---

## 审查输入版本记录

- git HEAD：`4fc6a97`（== origin/master，== `git ls-remote origin master`）
- 工作区：clean（仅 6 个未跟踪 `docs/audits/audit-2026-06-1*.md`）
- 动态发现：37 hook .js + 4 skill + 1 agent/9 instruction + migrate-v7 + 6 测试套件 + 6 模板
- 可用证据：`tests/run-all.js`（Windows 6/8，已追因）、`PACE_TEST_FILTER` 分片、临时 .pace 工程一手 gate 实证、真实 PowerShell 7 执行、`env -u` 判别实验
- 未用作 bug 证据：guidebook/action-plan/repo 内 pace-hooks.log（含 e2e 噪声）
