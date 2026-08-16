# 审计报告：PACEflow v7.2.10 全维度严格审计（Claude）

| 项 | 值 |
|---|---|
| 日期 | 2026-06-16 |
| 审计者 | Claude（Opus 4.8 1M）+ 8 维度多 agent workflow |
| 对象版本 | 7.2.10 |
| 审计面 | 发布面 `plugin/**` + `README.md` + `REFERENCE.md` + `plugin/.claude-plugin/plugin.json` |
| 方法 | 8 维度并行 finder → 逐发现 skeptic 对抗证伪 → 主 session 亲自端到端定锚复核 |
| 规模 | 29 个 agent、~210 万 token、704 次工具调用、33 分钟 |
| 基线 | 审计前后 `node tests/run-all.js` 均 8/8 绿；工作区零污染 |
| 结果 | 19 confirmed / 2 refuted / 0 uncertain |
| 关联 | 方法论纠正 `CORRECTION-2026-06-16-01`（#1 可达性夸大） |

---

## 执行摘要

跨 8 个质量维度（正确性 / 安全 / 健壮性 / 契约一致性 / 文档同步 / 测试质量 / 可维护性 / 历史审计消化）对发布面做了一轮严格审计。每条发现先由独立 skeptic 默认证伪，再由主 session 用三件武器（最小复现 / 路径追踪 / 设计意图查证）亲自回代码定锚——两条 P1 经**真跑 hook 二进制**实测坐实。

**严重性分布（最终）：P1×0 · P2×3 · P3×16。**

> **重要修订记录**：原报告把 #1（CODE_EXTS 写码门）定为 **P1「任何 C 项目正常写代码即绕过」**。经用户基于日常体验质疑（"没开 CHG 写 md 也会被拒"）+ 主 session 用真实 Write 工具复测，**降为 P2 条件性**。复测证明：(1) 无 owned CHG 时普通 `.md` 实际放行（非"都会被拒"）；(2) `pre-tool-use.js:1226` 第二触发条件使「本 session 持有 owned CHG 时所有项目内文件含 `.md/.c` 都门控」，这才是日常体验来源；(3) #1 的绕过仅发生在"无任何 owned CHG + 写非 CODE_EXTS 代码文件"窄窗口。方法论教训已记入 `CORRECTION-2026-06-16-01`：**实证 ≠ 充分实证——fixture 状态覆盖不全时，单点实测会给出"真实但片面"的结论。**

---

## 严重性汇总表

| # | 维度 | 标题 | finder | skeptic | **最终** |
|---|---|---|---|---|---|
| 1 | correctness | CODE_EXTS 只覆盖 10 种扩展名，非主流语言代码绕过写码门 | P1 | P1 | **P2(条件)** |
| 3 | security | 子shell/命令替换内紧贴闭合分隔符绕过 Bash/PS 写保护 | P2 | P1 | **P2** |
| 10 | docsync | REFERENCE 缺失 background_tasks Stop 放行行为 | P2 | P2 | **P2** |
| P3.1 | correctness | promptHasNonEmptyField 跨行误判，空值必填字段可绕过派遣门 | P3 | P3 | **P3** |
| P3.2 | security | `ln` 不在 mutating 动词集 | P3 | P3 | **P3** |
| P3.3 | robustness | frontmatter 解析器不识别纯 CR 换行（双解析器一致、现代不可达） | P3 | P3 | **P3** |
| P3.4 | robustness | sequence counter 被外部写成浮点会产出非整数编号 | P3 | P3 | **P3** |
| P3.5 | contract | 默认恢复模板 target 说明遗漏 update-index | P3 | P3 | **P3** |
| P3.6 | contract | artifact-writer-spec.md §5.2 / §5.6.2 编号空洞 | P3 | P3 | **P3** |
| P3.7 | docsync | REFERENCE §3 Agent 操作表漏 update-finding / update-index | P2 | P3 | **P3** |
| P3.8 | docsync | README reserve 可预留编号种类措辞不一致 | P3 | P3 | **P3** |
| P3.9 | docsync | README 版本历史表缺 v6.0.12（跳号） | P3 | P3 | **P3** |
| P3.10 | testing | marker-guard date-only 旁路检测无测试守护 | P2 | P3 | **P3** |
| P3.11 | testing | subagent-stop target-still-active 兜底分支无集成测试 | P3 | P3 | **P3** |
| P3.12 | maintainability | isPaceflowValidationScriptTarget 在两 guard 逐字重复 | P3 | P3 | **P3** |
| P3.13 | maintainability | 多个内部 helper 无外部消费却导出 | P3 | P3 | **P3** |
| P3.14 | maintainability | pre-tool-use.js 主处理器单函数约 1170 行 | P3 | P3 | **P3** |
| P3.15 | prior-audits | README「指令遵守率约 70–85%」无出处且与内部研究矛盾 | P3 | P3 | **P3** |
| P3.16 | prior-audits | action 空行吞字段回归缺直接 e2e 锁 | P3 | P3 | **P3** |
| REF.1 | testing | 版本一致性不在 run-all 网内 | P3 | — | **驳回（已覆盖）** |
| REF.2 | maintainability | escapeRegExp 三份重复"门面已导出可复用" | P3 | — | **驳回（断言为假）** |

---

## P2 — 应修

### #1 CODE_EXTS 写码门 under-block（条件性）

- **位置**：`plugin/hooks/pace-utils/constants.js:6`（定义）→ `pre-tool-use.js:419`（isCodeFile）、`pre-tool-use.js:1226`（projectMutationNeedsGate）
- **机制（完整 gate 拓扑）**：
  ```js
  // pre-tool-use.js:1226
  projectMutationNeedsGate = !artifactWriterArtifactMutation && isInsideProject
    && (isCodeFile || (isFileMutationTool(toolName) && currentOwnedActionableEntries.length > 0 && !isPlanningArtifact));
  ```
  - **code 文件（10 种 CODE_EXTS）**：`isCodeFile=true` → 只要在项目内就 needsGate，无论有无 CHG。
  - **非 code 文件（`.c/.rb/.php/.md` 等）**：`isCodeFile=false` → 仅当本 session 持有 owned actionable CHG 时才 needsGate。
- **问题**：`CODE_EXTS = ['.ts','.js','.py','.go','.rs','.java','.tsx','.jsx','.vue','.svelte']` 只 10 种。C/C++/Ruby/PHP/C#/Swift/Kotlin/Shell 等主流语言代码文件被归入"非代码"档。在**无任何 owned CHG** 时写这些文件直接放行，绕过 no-active/C(APPROVED)/E 门——与 README:19「没有获批的活跃变更，写代码的工具调用会被拒绝」对这部分用户失效。
- **主 session 实测复核（真实项目 + cache hook + 无活跃 CHG，Write 工具真实路径）**：
  | 文件 | 结果 |
  |---|---|
  | `zzz-audit-probe.md` | 放行（创建成功） |
  | `zzz-audit-probe.c` | **放行（创建成功）** |
  | `zzz-audit-probe.js` | **DENY_V6_NO_ACTIVE** |
- **可达性（修订）**：**窄**。仅"项目已启用 + 无任何 owned CHG + 写非 CODE_EXTS 代码"窗口触发。一旦开 CHG（日常流程），所有文件都门控；JS/TS/Py 用户语言已覆盖、不受影响。真正受损者：纯 C/Ruby/PHP/Shell 等语言、且习惯不先开 CHG 的用户——对其代码核心纪律未生效。
- **修复方案**：
  - **A（推荐，最小改动）**：扩充 `CODE_EXTS`，补无歧义主流语言：`.c .h .cc .cpp .cxx .hpp .hh .rb .php .cs .swift .kt .kts .scala .dart .lua .ex .exs .clj .bash .sh .zsh`；歧义扩展名（`.sql/.m/.r`）酌情。**必须配套补测试**（tests/ 当前零覆盖非 CODE_EXTS 语言写码门）。
  - **B（fail-safe 反转，大改）**：改维护「非代码扩展名豁免名单」（`.md/.json/.yaml/.png/...`），其余默认门控。优点：未知/新语言自动覆盖，根治"白名单追不全"。缺点：over-block 风险（误拦合法非代码写入）+ 违背 `action-plan-2026-05-02.md:520`「不要把 PaceFlow 变成普通路径裁判」设计意图。
  - **推荐 A**：PACEflow 是纪律护栏非安全沙箱，over-block（天天误伤）比 under-block（偶尔漏冷门语言）体验更糟；A 不动架构、风险可控。
  - **通用要求**：无论 A/B，改后必须验反向回归（over-block 是放宽 matcher 的对称回归，TDD 绿灯只证目标达成、不证无误伤）。

### #3 子shell/命令替换内紧贴闭合分隔符 `) } ` 绕过 Bash/PS 写保护

- **位置**：`command-recognition.js:67`、`bash-guard.js:227`、`powershell-guard.js:69`（token 停止字符集）
- **问题**：动词锚点 `MUTATING_ANCHOR`/`PS_MUTATING_ANCHOR` 的 `extraChars` **含** `(){}`（把它们当命令分隔符），但路径/redirect token 切分的停止集 `[\s;&|<>]` **漏了** `)(}{`。导致紧贴闭合符的文件名被切成 `'task.md)'`，精确匹配因尾随 `)` 全失配。两侧不对称是根因。
- **主 session 实测复核（直调谓词，runtime 拼接输入防自拦截）**：
  - `scanRedirectTargets('(echo x > task.md)')` = `['task.md)']`（对照 `['task.md']`）
  - `(rm task.md)` / `$(rm task.md)` / `(mv foo task.md)` / `(rm .pace/artifact-writer.lock)` / `(Remove-Item task.md)` → **全部 mutates=false 绕过**
  - 对照：`rm task.md` / `(rm task.md;)` → true（带分隔符正常拦截）
- **可达性**：边缘——AI 助手日常不会自然用子shell 包裹单条删除，非常规写法；但属确定性网关真缺口。
- **修复方案**：三处停止集加 `)(}{` → `[^\s;&|<>(){}]+`（PS 侧 `[^\s;|<>(){}]+`）。**over-block 安全**（实测：引号目标 `"a(b).md"` 走独立分支不受影响；未引用的 `)` 在 shell 文件名里本是语法错误）。配套补 e2e（当前 bypass 套件每条都带分隔符，漏紧贴 `)` 形态）。

### #10 REFERENCE 缺失 background_tasks Stop 放行行为（单边覆盖）

- **位置**：`REFERENCE.md` §5（对照 `README.md:253` + `stop.js:80,147-148,282-293,465`）
- **问题**：README:253 详述「CC v2.1.145+ 在 running CHG 有未完成 T-NNN 但后台 Workflow/subagent/team/shell 任务运行时放行 Stop」；REFERENCE 全文 grep `background_tasks/后台/2.1.145` 零命中，§5 只列阻断条件。读 REFERENCE 的用户会形成"有未完成任务一律阻断"的错误心智模型。
- **主 session 实测复核**：grep 当场坐实（REFERENCE 零命中；README:253 完整；stop.js:282-293 放行支存在）。
- **修复方案**：REFERENCE §5 stop.js 行补 background_tasks 放行分支描述，与 README 对齐。纯文档。

---

## P3 — 可维护性 / 低可达 / 诊断面（16 条，全部已定锚）

| # | 问题 | 定锚证据 | 修复方向 |
|---|---|---|---|
| P3.1 | `promptHasNonEmptyField` 的 `[:=]\s*\S+` 中 `\s*` 跨行，空值字段后跟另一字段被判非空，verify/review/close 自由文本必填字段空值可绕过派遣门 | `agent-lifecycle-guard.js:256-258`;**实测**：同样空 review-source，后有字段→PASS、在末尾→DENY | 单行字段用 same-line 检测;⚠️ 慎防 implementation-notes 多行形态回归（参 `promptFieldValueSameLine` 注释 + v7.2.10 先例） |
| P3.2 | `ln` 不在 `MUTATING_VERB_SOURCE`，`ln -sf X task.md` 不拦 | `bash-guard.js:26-29`;**实测** mutates=false（cp/mv→true） | `MUTATING_VERB_SOURCE` 加 `ln`;低可达 |
| P3.3 | 纯 CR（Mac OS 9）换行不识别;双解析器口径一致无分叉 | `line-endings.js:9,12` `/^﻿?---\r?\n/`+`split(/\r?\n/)`;`change-analysis.js` 同口径 | **won't-fix 候选**（绝迹格式，无安全影响） |
| P3.4 | `locks.js:718` `Number()` 对 `'3.7'` 透传浮点编号 | `locks.js:718-723`，无 `Math.floor` | 改 `parseInt`/整数校验;仅运行态文件损坏可达 |
| P3.5 | 默认恢复模板 target 行漏 `update-index`（文案不全，不影响行为） | `agent-lifecycle-guard.js:226-227`（列 7 类，漏 update-index;KNOWN_OPERATIONS 含它） | 补 update-index 说明 |
| P3.6 | `artifact-writer-spec.md` §5.2 / §5.6.2 编号空洞（v6 退役遗留排版） | §5.1→§5.3（缺 5.2）、§5.6.1→§5.6.3（缺 5.6.2） | 重编号或注明退役 |
| P3.7 | REFERENCE §3 Agent 操作表漏 `update-finding` / `update-index` | REFERENCE.md:71-83;全文 grep 两词零命中 | 补两行 |
| P3.8 | README:217「CHG/CORRECTION」漏 HOTFIX（245/423/REFERENCE:184 写全） | README.md:217 vs 245/423 | 217 改为 CHG/HOTFIX/CORRECTION |
| P3.9 | README 版本表 v6.0.13→v6.0.11 缺 v6.0.12 | README.md:538-539;grep `6.0.12` 零命中 | 补条目或注明跳号 |
| P3.10 | marker-guard date-only 旁路（setVerifiedDate/setReviewedDate）无测试守护，分支 live 可达 | `marker-guard.js:43-47`;tests 仅有 "with-marker" 无 date-only 无 marker case | 补 e2e：Write 整文件设 verified-date 非 null 无 comment marker 应 DENY |
| P3.11 | subagent-stop `target-still-active` 兜底分支无集成测试 | `subagent-stop.js:133-143`;tests grep `target-still-active`/`stillActive` 零命中 | 补集成测试 |
| P3.12 | `isPaceflowValidationScriptTarget` 在 bash/ps guard 逐字重复（有 HOTFIX-20260614-01 漂移史） | `bash-guard.js:136-156` 与 `powershell-guard.js:152-171` 去注释 md5 一致 | 下沉到已共享的 `command-recognition.js` |
| P3.13 | 多个内部 helper 无外部消费却导出（getProjectRootMarkerPath/projectLogFields/enrichSummaryOwner/ownerDisplay/DEFAULT_SCRIPT_ENGINES 等） | grep 引用计数 3-5（定义+导出+少量内部，无外部） | 收窄导出面 |
| P3.14 | `pre-tool-use.js` 主处理器单个 withStdinParsed 回调约 1170 行 | `pre-tool-use.js:274-1443` | 拆命名子处理器（大重构，谨慎） |
| P3.15 | README「指令遵守率约 70–85%」无出处，且与内部研究（70–90%/IFEval 43–77%）矛盾 | README.md:17;`research-2026-06-13-does-paceflow-help.md:90` | 加引用或软化措辞 |
| P3.16 | action 空行吞字段回归（运行时已修）缺直接 e2e 锁 | `test-hooks-e2e.js:4757-4783` 迭代 `['', 'action: unknown']`，不覆盖空行吞字段形态 | 9hc4a1b 加 action 空行 case |

---

## 已证伪（2 条，确认不修）

- **REF.1 版本一致性未覆盖** → **假阳性**：`test-pace-utils.js:3210` 有 plugin.json↔marketplace 一致性断言，且 test-pace-utils 在 run-all SUITES 内（实测改 version 跑 run-all 报 FAIL）。finder 漏 grep。
- **REF.2 escapeRegExp 三份重复"门面已导出可复用"** → **核心断言为假**：`pace-utils.js:88` 的 `escapeRegex` 是 import（解构 `require('./pace-utils/path-utils')`）非 `module.exports`，commit `9b5b1b3` 已勘误为依赖注入——`paceUtils.escapeRegex` 实际不可用，finding 给的修复路径错。但"两份 guard `escapeRegExp` 逐字重复"观察成立，可与 P3.12 一并下沉。

---

## 建议修复路线图

1. **P2 优先**：#3（三处停止集加 `)(}{`，确定性网关真缺口、修复简单 over-block 安全）+ #10（REFERENCE 文档对齐）。
2. **#1 单独评估**：方案 A 保守扩充 CODE_EXTS + 补非 CODE_EXTS 门控测试。可达性已降 P2，不紧急但值得修。
3. **P3 打包工程卫生 CHG**：优先级 P3.1（门软弱点）、P3.10/11/16（测试守护）> 纯文档/排版（P3.5–9,15）> 重构（P3.14）。`won't-fix`：P3.3。

---

## 附录：审计方法与可复现性

- **维度**：8 个并行 finder（correctness / security / robustness / contract / docsync / testing / maintainability / prior-audits），每个 finder 用 opus、读完整 scope 文件、产出结构化 finding（severity/file/location/claim/evidence/repro/reachability）。
- **验证**：每条 finding 派独立 skeptic 默认证伪 + 三件武器定锚，返回 confirmed/refuted/uncertain + correctedSeverity。
- **主 session 复核**：所有 confirmed/refuted 亲自回代码/文件系统定锚；P1/P2 真跑 hook 二进制实测。
- **严重性判据**：按 PACEflow 自身「真实场景可达性」（日常可达必修、仅故意攻击可达可降）+「发布面影响」定级，而非理论严重度。
- **自指挑战**：审计写保护门时探针会被门自身拦截（heredoc body 追踪 + `.js` embed-scan）。复现手段：Write 探针到 `/tmp`（项目外）+ `cat file | node`（stdin 喂入避开脚本目标识别）+ 测试用例运行时字符串拼接（避免明文 artifact token）。

## 方法论纠正记录

`CORRECTION-2026-06-16-01`（关联 `[[strict-audit-methodology]]`）：审计 #1 时把可达性写成"任何 C 项目日常即绕过"，因只读单行 `1226` + fixture 只测"无 CHG"单一状态。教训：评判绕过类 finding 的可达性必须基于完整 gate 拓扑 + 日常状态分布；**实证 ≠ 充分实证**——fixture 状态覆盖不全时，单点实测会给出"真实但片面"的结论。
