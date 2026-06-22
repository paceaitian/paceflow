# CI 测试矩阵 + ROI 数据 — 可行性调研与落地方案（2026-06-22）

> 状态：**调研完成，待落地（compact 后执行）**。
> 背景：codex v7.2.21 方向建议（`docs/audits/2026-06-20-v7.2.21-codex方向建议.txt`）把「CI 测试矩阵」「ROI 数据」列为高优先级——它们是**数据底座**（先有跨平台工程数据 + 价值数据，才能数据驱动地动三档位/简化/真实证据等方向性改造）。本文档为两项的调研结论 + 落地 tasks，对应预建的 CI CHG 与 ROI CHG。
> 落地顺序：**CI 先**（工程确定性 + 直接机制化解「我只能 POSIX 跑、无法验 Windows」的结构性盲区），**ROI 后**（产品洞察，但日志污染 + 单人样本 → 只能自证非 PMF）。

---

## Part 1 — CI 测试矩阵

### 调研结论（已读代码核实）

- 仓库**无 `package.json`** → CI 必须直接 `node tests/run-all.js`，不能 `npm test`。
- 有 `paceflow/.gitattributes` 强制 `*.js/*.json/*.md/*.sh` → `eol=lf`，是 **Windows CI 的关键护城河**（覆盖 runner 默认 `autocrlf=true`，git-diff-check 不会误报 CRLF 空白错）。
- `run-all.js` 编排 8 套件：6 个 `node test-*.js` 子进程 + `plugin-validate`（spawn 外部 `claude`）+ `git-diff-check`（函数）。子进程失败（含命令不存在）被 catch 标 `ok=false`、整体 exit 1（不崩溃）。

#### 各套件 CI 可跑性
| 套件 | 判定 | 说明 |
|---|---|---|
| pace-utils / hooks-e2e / session-layers / migrate-v7 / run-all-self | ✅ 能跑 | 纯 node，所有 spawn 都是 `node`/`process.execPath`，从不 spawn bash/sh。hooks-e2e 里的 `bash -c <<heredoc` 是作为 tool_input **数据**喂给 hook 静态分析、不经 shell 执行（假阳性已排除） |
| git-diff-check | ✅ 能跑 | 靠 `.gitattributes` eol=lf 在 Windows 安全。CI detached HEAD 无 upstream → `@{upstream}` 抛错被 catch → 区间检查**优雅降级只查工作树**（不 fail，但区间空白门空转；要查 PR 区间需 `fetch-depth:0` + `PACE_RELEASE_BASE`） |
| plugin-validate | ⚠️ 需装 CLI | spawn 外部 `claude`。CI 无 CLI → ENOENT → 标 fail。**`claude plugin validate` 是纯本地 manifest 校验、不需 API key**（本地实测 exit 0）。解法：CI `npm i -g @anthropic-ai/claude-code` |
| agent-helpers | 🔴 **唯一真 Windows 隐患** | `subagent-runner.js` 无 child_process、不联网、无 API key——**无 key 能跑**。但 34 个 YAML case 硬编码 `project_path: /tmp/test-vault/...`（`subagent-runner.js:342-343`）+ teardown 硬门 `if(!targetDir.startsWith('/tmp/')) throw`（`fixture-teardown.js:11`）。Windows 上 Node 把 `/tmp` 映射 `C:\tmp` **大概率碰巧跑**但未实测、可能污染 C 盘根或跨盘失败 |

#### 跨平台雷
- **已修安全**：goldenNormalize 双形态（v7.2.21 TH-1a）、snapshotAll path.sep 归一（TH-1b）、choicePath 三处归一（v7.2.23 HOTFIX）、line-endings 全程归一、日期用 `toLocaleDateString('sv-SE')`、临时目录用 `os.tmpdir()`、无 symlink/chmod/X_OK 依赖。
- **剩余真雷**：agent-helpers 的 `/tmp` 硬编码（见上，**头号观察点**）。
- **低风险待验**：`TZ=Etc/GMT-14` 子进程时区测试（test-pace-utils.js:1225）在 Windows Node（ICU）应生效、未实测。

#### `.github/workflows/ci.yml` 草案
```yaml
# .github/workflows/ci.yml — PACEflow 跨平台测试矩阵
# 落地核实修正：git rev-parse --show-toplevel = paceflow 本身（git 根即 paceflow，
# run-all.js 在 tests/run-all.js、插件在 ./plugin），故无需 working-directory 切换。
name: ci
on:
  push:
    branches: [master]
  pull_request:
jobs:
  test:
    name: tests (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false   # 一个平台挂不掩盖其他平台
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # git-diff-check 区间需历史；.gitattributes 保 LF
      - uses: actions/setup-node@v4
        with:
          node-version: '20'   # 维护者本机 v24；20 LTS 更稳，代码用 fs.cpSync(16.7+)/fs.rmSync(14.14+) 都安全
      - name: Install claude CLI (plugin-validate 需要，纯本地校验无需 API key)
        run: npm install -g @anthropic-ai/claude-code
      - name: Run full suite
        run: node tests/run-all.js
```

### 落地 tasks（CI CHG）
- **T-001**：修 agent-helpers 的 `/tmp` 硬编码——抽单一来源 `subagent-runner.defaultVaultDir(fixture)=os.tmpdir()/pace-test-vault/<fixture>`，替换 `subagent-runner.js:342-343` 默认 + `run-tests.js` 三处（cmdVerify/cmdTeardown/cmdVerifyMulti）默认；`fixture-teardown.js` 的 `startsWith('/tmp/')` 硬门改为「严格位于 `os.tmpdir()` 之下」跨平台判据；删 **34 个**（落地核实，非草案误写的 4 个）YAML case 里冗余的 `project_path: /tmp/test-vault/<fixture>` 行（其值恒等于默认、纯重述 `setup.fixture`，删后 `variables:` 仍留 `date`）；`.gitattributes` 补 `*.yaml`/`*.yml eol=lf`。验收：POSIX run-all 仍 8/8 + helper 代码无 `/tmp` 字面（仅注释存历史说明）。
- **T-002**：写 `.github/workflows/ci.yml`（上方草案），含三平台矩阵 + 装 claude CLI + fetch-depth 0（落地核实 git 根即 paceflow，无需 working-directory）。
- **T-003**：push 触发首跑，**实测验证三平台真绿**（头号观察点：windows-latest 的 agent-helpers 退出码）。三平台绿后此 CHG 才算闭环。
- 工作量：约 1–1.5 人天。

---

## Part 2 — ROI 数据

### 调研结论（已读代码核实）

**关键发现（决定方案形态）**：现有 `plugin/hooks/pace-utils/logger.js` 的 `pace-hooks.log` 是 **diagnostic-only 污染日志**，不能当可信账本：
1. 自截断 1MB（`logger.js` MAX_LOG_SIZE，超限砍前半 → ROI 历史静默丢失）；
2. 测试污染严重（当前 1906 行、468 个 distinct proj，多数 `/tmp/pace-e2e-*`，真实 `proj=paceflow-hooks` 占极小比例）；
3. 锁竞争丢行（争锁直接 return 不写 → 计数偏低）。
→ 这印证「门是时刻门非账本」（[[paceflow-gate-not-ledger]]）。**ROI 只能定位为「只读快照近似」，不是精确遥测/账本**。

#### codex 6 类指标可行性
| # | 指标 | 判定 | 数据源 / 埋点 |
|---|---|---|---|
| ① | 拦截次数 vs 覆盖(pause/disable)次数 | **现有可聚合** | log `act=DENY_*/SOFT_WARN/BLOCK` 对 `act=PAUSE/DISABLE`（set-activation.js:112/193），按 proj 分组 |
| ② | 误拦截率 | **本质难量化、诚实放弃** | 无 ground truth。只能给摩擦代理：`act=DOWNGRADE`（stop.js:413，Stop 门 3 次 block 后放弃）+ pause-after-deny 时序共现。明确标注「摩擦代理」非误拦率。PACEflow 不做质量控制/不猜意图 |
| ③ | 每个 CHG 流程耗时 | **现有可聚合(天粒度)** | CHG frontmatter `date`→`archived-date`。注意 `date` 是天粒度无时分秒，同日 CHG 耗时显示 0，只能天级分布 |
| ④ | 恢复的跨 session 上下文量 | **现有可聚合(近似)** | log `act=INJECT group=artifact` 的 `files=...(NNNN)` 字节 + `output_bytes`。量的是**注入量**非**被利用量**，诚实表述为「注入规模」 |
| ⑤ | Review 发现的 P0/P1 | **现有可聚合** | findings.md 正则 `\[impact:: (P0\|P1)\]`，可叠加 `[x]`(accepted) + `[change::]` 过滤「真正导致修复的」 |
| ⑥ | 在哪一步 pause/disable | **需 1 个最小埋点** | 现有 PAUSE/DISABLE 只记 proj/sid、不记流程阶段。补 1 个 `phase` 字段（从活动 CHG status 推断）：`logEntry('SetActivation','PAUSE',{proj,sid,phase})` |

### 落地 tasks（ROI CHG）
- **T-001**：写一个**只读聚合脚本**（放 `internal/`，仓库维护材料不随 marketplace 发布、零运行时改动），读 `pace-hooks.log` + `changes/*.md` frontmatter + `findings.md` + `.pace/`，**先按 proj/cwd 过滤掉 `/tmp/pace-e2e-*` 测试污染**，产出 ①③④⑤ 四个指标的报告。验收：脚本只读、不改任何运行时代码、报告含 4 指标 + 诚实标注粒度限制。
- **T-002（可选）**：set-activation.js 的 doPause(:193)/doDisable(:112) 的 logEntry 补 `phase` 字段（值从活动 CHG status 推断），拿到指标⑥。最小日志字段扩展、非新系统。
- **诚实边界**：②误拦率不做精确值（只给摩擦代理）；④是注入量非利用量；③天粒度。不建任何「ROI 账本文件 / 独立遥测 hook / 跨调用状态累加器」——与「门非账本」原则冲突且是 codex 警告的复杂度债。

---

## Part 3 — 落地顺序与定位

1. **CI 先**：工程确定性收益，直接机制化解「POSIX 推断 Windows」盲区（v7.2.22 翻车根因，见 [[cross-platform-fix-needs-target-platform-run]]）。现成 run-all + 草案 yml，唯一障碍 agent-helpers /tmp 小修。
2. **ROI 后**：纯只读聚合脚本（4 指标）+ 可选 1 字段埋点，符合 codex「轻量+不上传+不加复杂度」。但日志污染 + 单人小样本 → **自证非 PMF**；真说服力需外部用户（codex「缺外部实证」的点，ROI 工具是前提非充分条件）。
3. 两者都**不碰**方向性大改（三档位/artifact 简化/真实证据替代仪式）——那些等 CI/ROI 给出数据后再数据驱动地动。
