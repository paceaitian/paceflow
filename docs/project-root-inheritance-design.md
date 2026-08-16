# PACEflow Project Root / 子目录继承设计

> **状态**：已按 v6.0.58 实现，本文保留为设计依据与审计 checklist
> **日期**：2026-05-22
> **目标版本**：v6.0.58
> **关联记录**：`docs/action-plan-2026-05-02.md` 的 `0.1.10e31`

## 1. 背景

真实观察：

- 用户在 `/mnt/k/AI/paceflow-hooks/paceflow` 打开 Claude Code。
- 父目录 `/mnt/k/AI/paceflow-hooks` 已是 PACEflow 管理项目，artifact root 在 Obsidian vault project `paceflow-hooks`。
- 子目录 `paceflow` 是独立 git repo，但没有自己的 PACE artifacts。
- 当前 PACEflow 只按当前 cwd 判断，结果是：
  - `isPaceProject(cwd)=code-count`
  - `getArtifactDir(cwd)` 默认推导到 vault project `paceflow`
  - SessionStart 只注入轻量启用提示和 Git 状态
  - 父项目的 active CHG / Stop / owner 上下文没有进入该子目录会话

这与用户心智不一致：在一个被 PACEflow 管理的项目子目录内工作，默认应仍属于父项目的 PACE 流程，除非用户显式把该子目录声明为独立项目。

## 2. Claude Code 参照

Claude Code 自身已有“父级项目上下文可继承，子级可覆盖”的心智模型：

- Memory / `CLAUDE.md`：Claude Code 会从当前工作目录向上递归读取 `CLAUDE.md`，并在进入子目录时按需加载更近的 `CLAUDE.md`。
- Settings：Claude Code 区分 user / project / local scopes，项目配置可被本地配置覆盖。
- Worktrees：git worktree 是独立 working copy。PACEflow 已有 worktree 归一逻辑，应保留；本设计只补普通子目录 / 嵌套 repo 的 Project Root 继承。

设计取向：

- PACEflow 应采用与 Claude Code 相近的项目边界心智：父级明确项目可继承，当前目录可显式覆盖。
- 不应简单把 git root 等同为 PACEflow project root。嵌套 git repo 可以仍属于父 PACEflow 项目，也可以显式独立。

参考：

- https://docs.anthropic.com/en/docs/claude-code/memory
- https://docs.anthropic.com/en/docs/claude-code/settings
- https://docs.anthropic.com/en/docs/claude-code/common-workflows

## 3. 术语

| 术语 | 含义 |
|---|---|
| Current CWD | Claude Code 当前打开目录，可能是 Project Root，也可能是其子目录。 |
| Project Root | PACEflow 管理的项目边界。代码 gate、CHG owner、runtime `.pace`、helper 默认归属都以它为准。 |
| Artifact Root | `spec.md / task.md / implementation_plan.md / walkthrough.md / findings.md / corrections.md / changes/**` 的存放目录，可等于 Project Root，也可在 Obsidian vault。 |
| Runtime Root | `.pace` 运行态目录，默认在 Project Root 下。 |

`local` artifact root 的语义应明确为：

```text
Artifact Root = Project Root 本地目录
```

不是：

```text
Artifact Root = 当前 cwd
```

当 Current CWD 是 Project Root 的子目录时，这个区别必须在 helper 输出和 SessionStart 文案里可见。

## 4. 目标行为

### 4.1 父项目子目录默认继承

```text
/mnt/k/AI/paceflow-hooks              # Project Root，有 PACE artifacts
/mnt/k/AI/paceflow-hooks/paceflow     # Current CWD，无自己的 PACE artifacts
```

在 `paceflow` 中启动 Claude Code时：

- PACEflow signal 应来自父 Project Root。
- Artifact Root 应指向父项目 artifacts。
- Runtime Root 应为父项目 `.pace`。
- SessionStart 应注入父项目 active CHG / owner / Stop 相关上下文。
- 对子目录普通代码/文档文件的写入应受父项目当前 CHG / approval / task 状态约束。

### 4.2 多层父项目最近者胜出

```text
/mnt/k/AI                         # Project Root A
/mnt/k/AI/paceflow-hooks          # Project Root B
/mnt/k/AI/paceflow-hooks/paceflow # Current CWD
```

Current CWD 应继承 `paceflow-hooks`，不是 `/mnt/k/AI`。

### 4.3 独立子项目显式断开继承

```text
/mnt/k/AI/paceflow-hooks           # 父 Project Root
/mnt/k/AI/paceflow-hooks/paceflow2 # 新方向，独立 PACEflow 项目
```

用户应先运行：

```bash
node "<plugin>/hooks/set-project-root.js" --mode independent
```

再选择 artifact root：

```bash
node "<plugin>/hooks/set-artifact-root.js" --choice local
```

或：

```bash
node "<plugin>/hooks/set-artifact-root.js" --choice vault
```

`independent` 一旦设置，当前目录不再继承父级 PACEflow 项目。

## 5. 解析规则

新增核心概念：

```js
resolveEffectiveProjectRoot(cwd)
```

返回值应至少包含：

```js
{
  cwd,
  projectRoot,
  runtimeRoot,
  mode,          // current | inherited | independent | worktree | disabled
  inheritedFrom, // inherited 时为父 Project Root；worktree 且宿主自身为 inherited 时为宿主的有效根（HOTFIX-20260816-02）；否则为空
  reason
}
```

解析优先级：

1. Current CWD 有 `.pace/disabled`：PACEflow disabled，不继承父级。
2. Current CWD 是真实 git worktree 或 `.claude/worktrees/*`：沿用既有 worktree 宿主归一逻辑；worktree 不允许用 `set-project-root --mode independent` 分裂运行态。
3. Current CWD 有 `.pace/project-root` 且内容为 `independent`：当前 cwd 是独立 Project Root。
4. Current CWD 有明确 artifact：当前 cwd 是 Project Root。
5. 向上查找最近的明确 PACE Project Root；若中间父级存在 `.pace/disabled`，停止查找并视为 disabled，不越过它继承更外层项目。
6. 没有明确父级 Project Root 时，才回到当前弱信号逻辑：manual / superpowers / code-count。

明确 PACE Project Root 的判定：

- 有 `.pace/artifact-root`；这是用户或 helper 明确写入的 root-choice 边界，即使 artifact 尚未懒创建也应作为 Project Root。
- 或本地 Project Root / vault project 存在 v6 artifacts：至少 `changes/`。
- 或存在 legacy v5 artifact，需触发迁移提示。
- 或存在显式 `.pace-enabled`。

不算明确 Project Root：

- 只有 `.pace/` 运行态残留。
- 只有 `.pace/.gitignore`、`stop-block-count`、`task-list-used` 等临时文件。
- 只有 `PACE_ARTIFACT_ROOT` / `PACEFLOW_ARTIFACT_ROOT` 环境选择；它只跳过 artifact-root 询问，不声明独立子项目边界。
- 只有 `PACE_PROJECT_NAME` / `PACEFLOW_PROJECT_NAME` 环境覆盖；它可在 Project Root 确定后选择 vault project name，或在强 Project Root 不存在时让扫描路径上最外层 git root 找到别名 vault artifact，不应把 nested repo 或任意 child / ancestor 目录伪装成 Project Root。
- 只有 `code-count`。
- 只有旧 Superpowers plan。

独立 git repo 不自动阻止继承。原因：

- PACEflow 管理边界是用户选择的工作范围，不必等同 git root。
- 嵌套 repo 可作为父项目的一部分维护。
- 真正独立时使用 `set-project-root.js --mode independent` 表达。

## 6. Helper 与文件接口

### 6.1 新增 helper

新增：

```text
plugin/hooks/set-project-root.js
```

首版支持：

```bash
node "<plugin>/hooks/set-project-root.js" --mode independent [--cwd <project-cwd>]
```

行为：

- 解析 `--cwd` 或当前 cwd。
- 创建当前 cwd 的 `.pace/`。
- 写入 `.pace/project-root`：

```text
independent
```

- 输出：

```text
current-cwd: <cwd>
project-root: <cwd>
runtime-root: <cwd>/.pace
mode: independent
next-step: node "<set-artifact-root.js>" --choice local 或 --choice vault
```

禁止：

- 不应自动创建 `task.md`、`changes/` 或 vault project。
- 不应替用户选择 artifact root。

### 6.2 更新 set-artifact-root 输出

`set-artifact-root.js` 成功输出应包含：

```text
current-cwd: <cwd>
project-root: <effective project root>
runtime-root: <project root>/.pace
artifact-root: <resolved artifact root>
choice: local|vault|/abs/path
config-file: <project root>/.pace/artifact-root
```

当 Current CWD 是继承父 Project Root 的子目录时，输出必须说明：

```text
当前 cwd 位于父级 PACEflow Project Root 内。本次配置写入父 Project Root 的 runtime，不写入当前 cwd。
```

### 6.3 更新 reserve / sync helper

`reserve-artifact-id.js` 与 `sync-plan.js` 应基于 effective Project Root：

- inherited 子目录中 reserve：给父项目分配 CHG/HOTFIX/CORRECTION 编号。
- inherited 子目录中 sync-plan：写父项目 `.pace/synced-plans`。
- independent 子项目中 reserve：给子项目分配编号。

## 7. Hook 接入

### 7.1 SessionStart

新增轻量项目上下文段：

```text
=== PACEflow 项目上下文 ===
Current CWD: /mnt/k/AI/paceflow-hooks/paceflow
Project Root: /mnt/k/AI/paceflow-hooks
Artifact Root: /mnt/c/.../Obsidian/projects/paceflow-hooks
Runtime Root: /mnt/k/AI/paceflow-hooks/.pace
模式: 继承父级 PACEflow 项目
若这是独立子项目，先运行 set-project-root.js --mode independent。
```

显示条件：

- PACEflow signal 非 false。
- 或当前 cwd 继承了父 Project Root。
- 或 root-choice pending。

必须避免冗长：

- 活跃 CHG 摘要仍按现有截断策略。
- Project Context 只输出 4 个路径和一个模式，不展开解释。

### 7.2 PreToolUse / Stop / PostToolUse / PreCompact

所有 gate 应使用 effective Project Root：

- artifact direct write 判断仍基于 Artifact Root。
- C/E gate、owner、Stop 检查读取父 Project Root 的 artifact 状态。
- Runtime `.pace` 写入父 Project Root。
- 日志同时记录：

```text
cwd=<current cwd>
project_root=<effective project root>
artifact_dir=<artifact root>
mode=<current|inherited|independent|worktree>
```

### 7.3 Worktree 保持优先

既有真实 git worktree / `.claude/worktrees` 语义保持：

- worktree 共享**宿主 checkout 的有效 Project Root**：宿主自身是根则为宿主目录；宿主是继承父级的子目录（嵌套 repo）时跟随其父级（HOTFIX-20260816-02 补齐——此前 worktree 分支直接返回宿主目录，宿主为 inherited 时 worktree 与主 cwd 解析到不同的根）。
- owner worktree / branch context 不变。
- 普通 ancestor scan 不应把 worktree 错归到更上层父项目（worktree 只沿宿主的解析结果走，不从 worktree 自身路径向上扫）。

## 8. 分阶段实施

### Phase 1：术语和输出准备

目标：引入 Project Root 概念，但不启用 ancestor inherit。

实现状态：已完成，随 Phase 2/3 一并落地。

改动：

- README / REFERENCE / skills 解释四个术语。
- `set-artifact-root.js` 输出补 Project Root / Runtime Root / Current CWD。
- SessionStart root-choice 提示补 Project Root。
- smoke 文档增加 Project Root 检查项。

验收：

- 现有 smoke 1/2/10 不改变行为。
- 文案不再把 `local` 说成 current cwd。

### Phase 2：独立子项目 helper

目标：先提供断开继承的明确出口。

实现状态：已完成。

改动：

- 新增 `set-project-root.js --mode independent`。
- `pace-utils` 能识别 `.pace/project-root=independent`。
- SessionStart / root-choice 文案提示该 helper。

验收：

- 父项目下新建 `paceflow2`，运行 helper 后不继承父级。
- 首次写代码触发当前目录自己的 root-choice。

### Phase 3：ancestor inherit

目标：启用最近父级明确 Project Root 继承。

实现状态：已完成。

改动：

- 新增 `resolveEffectiveProjectRoot(cwd)`。
- `getProjectStateDir()`、`getProjectRuntimeDir()`、`getArtifactDir()`、`isPaceProject()` 改用 effective root。
- helpers 和 hooks 基于 effective root。
- SessionStart 注入 Project Context。

验收：

- 父 PACE 项目子目录能看到父 active CHG。
- 子目录写代码受父 CHG gate。
- runtime `.pace` 写父 Project Root。

### Phase 4：smoke 与文档收口

目标：验证真实 installed runtime。

实现状态：本地回归已完成；production smoke 计划见 `docs/production-smoke-v6.0.58.md`。

改动：

- 增加 `docs/production-smoke-v6.0.58.md`。
- README 版本历史记录该变更。
- action book 标记落地结果。

## 9. 测试矩阵

自动化测试：

| 场景 | 预期 |
|---|---|
| 父目录有 v6 artifact，子目录无 artifact | 子目录继承父 Project Root |
| 多层父目录都有 artifact | 最近父级胜出 |
| 子目录 `.pace/project-root=independent` | 不继承父级 |
| 子目录是独立 git repo | 默认仍继承父级 |
| 子目录有自己的 `.pace/artifact-root` | 子目录成为 Project Root |
| 父级只有 `.pace/` 残留 | 不继承 |
| 父级只有 `code-count` | 不继承 |
| 父级 legacy v5 artifact | 子目录触发父级迁移提示 |
| 真实 git worktree 及其子目录 | 继续归一到宿主，不被 ancestor scan 或 independent helper 改坏 |
| 从 worktree 子目录写 checkout 根或 sibling 文件 | 仍按 worktree checkout 根进入 C/E gate，不漏到项目外豁免 |
| `set-artifact-root --choice local` from child | 写 Project Root，不写 Current CWD |
| 直接写 `.pace/project-root` | 被 PreToolUse 阻止，必须用 `set-project-root.js --mode independent` |
| `reserve-artifact-id --operation create-chg` from child | reservation 与模板写 Project Root runtime/artifact，不写 Current CWD |

Production smoke：

1. 在父 PACE 项目下创建普通子目录，打开 Claude Code，确认 SessionStart 显示 inherited Project Context 和父 active CHG。
2. 在子目录尝试写代码，无父项目 approved/running CHG 时应被 C/E gate 阻止。
3. 在子目录运行 `set-project-root --mode independent`，再选择 local/vault，确认后续 artifacts 属于子项目。
4. 在父项目下创建嵌套 git repo，默认继承父项目；设置 independent 后断开。
5. 真实 git worktree smoke 复跑，确认 worktree owner / runtime / artifact root 不退化，并覆盖从 worktree 子目录写 checkout 根/兄弟路径仍受 C/E gate。

## 10. 风险与约束

- 不要实现为“向上找 `.pace`”。`.pace` 运行态残留不是 Project Root 证据。
- 不要让 ancestor inherit 继承弱信号。`code-count` 只能用于当前 cwd，不应扩大到整棵父目录树。
- 不要把 independent 写成用户需要手动 touch 的隐藏协议；主入口必须是 helper。
- 不要把 `local` 继续描述为 current cwd。启用 Project Root 后，`local` 必须绑定 Project Root。
- 不要在 Phase 3 前省略 Phase 2。没有 independent 出口时启用继承，会让新子项目启动路径变得不清楚。
- 不要改变 PACEflow 对普通项目外文件的边界：PACEflow 只管理 artifacts / runtime / 当前 Project Root 内的流程 gate，不做全局 filesystem policy。

## 11. 未决但默认决策

| 问题 | 默认决策 |
|---|---|
| `.pace/no-inherit` 是否作为用户入口 | 否。可作为内部兼容，但主入口是 `set-project-root.js --mode independent`。 |
| 当前 cwd 有 `.pace/artifact-root` 但目标没有 `changes/` | 视为当前目录已选择 artifact root，但尚未初始化；不继承父级，首次写代码走当前目录 root-choice/init 流程。 |
| 子目录独立 git repo 是否默认断开 | 否。git root 不等同 PACE Project Root。 |
| ancestor scan 是否跨 filesystem boundary | 默认不跨 git/FS 边界做特殊规则；只按父路径查到第一个明确 PACE root。后续若真实误判，再加停止条件。 |
| vault project name 使用哪个目录 | 使用 effective Project Root 的 project name，不使用 Current CWD basename。 |
