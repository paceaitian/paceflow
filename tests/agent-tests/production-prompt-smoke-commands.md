# Production Prompt Test Commands

> 本文件验证 agent fixture / CLI runner 的 production prompt。它不等同于已安装
> marketplace plugin 后的真实交互 smoke。真实主 session smoke 见
> `docs/production-smoke-v6.0.32.md`。
>
> 用途：验证真实主 session 派发路径。`prepare --mode production` 只输出
> `ARTIFACT_DIR`、`operation`、`fields`，不注入 harness 里的详细规范、spec 绝对路径、
> report title 约束或资源约束。
>
> Production release gate 只阻断可机械判断的结构性合同：文件创建/修改、frontmatter
> schema、wikilink、状态机、错误码、fixture 不变性。资源预算在 production 模式记录为
> warning，用于发现异常回环，不作为发布阻断。TC-D2 large-body 不放入 hard gate，
> 单独作为模型内容保真 / 长文本搬运能力 benchmark。
>
> Production 模式下，`## artifact-writer 报告` 必须存在；若 agent 在标题前添加
> 自然语言前缀，runner 记录 `report_title_prefix_warning`，不阻断结构/功能断言。

```bash
cd /mnt/k/AI/paceflow-hooks/paceflow
mkdir -p /tmp/paceflow-agent-baseline-production
```

## Production Release Gate

28 个结构性用例，不含 TC-D2。发布前优先跑这个。

```bash
cd /mnt/k/AI/paceflow-hooks/paceflow
MODE=production OUTDIR=/tmp/paceflow-agent-baseline-production-gate tests/agent-tests/run-agent-cli-suite.sh production-gate
```

## Production Smoke

```bash
cd /mnt/k/AI/paceflow-hooks/paceflow
MODE=production OUTDIR=/tmp/paceflow-agent-baseline-production tests/agent-tests/run-agent-cli-suite.sh production-smoke
```

## Merged Operation Smoke

```bash
cd /mnt/k/AI/paceflow-hooks/paceflow
MODE=production OUTDIR=/tmp/paceflow-agent-merged tests/agent-tests/run-agent-cli-suite.sh merged
```

## Optional Content Fidelity Benchmark

```bash
cd /mnt/k/AI/paceflow-hooks/paceflow
MODE=production OUTDIR=/tmp/paceflow-agent-baseline-production-content tests/agent-tests/run-agent-cli-suite.sh content
```

TC-D2 失败代表当前模型/输入链路在长正文原样搬运上存在波动，不代表 v6 artifact
结构合同失败。它应进入模型选择或 prompt 压缩评估，不直接阻断 production release gate。

如需指定模型：

```bash
MODEL=sonnet EFFORT=max MODE=production tests/agent-tests/run-agent-cli-suite.sh production-gate
```

脚本默认使用 Claude CLI 中的插件限定 agent 名：

```bash
AGENT_NAME=paceflow:artifact-writer MODE=production tests/agent-tests/run-agent-cli-suite.sh production-gate
```

不要并行执行使用同一 fixture 的 `prepare`。多个 case 共用 `os.tmpdir()/pace-test-vault/empty-v6`（POSIX 下即 `/tmp/pace-test-vault/empty-v6`），
必须按 prepare → verify → teardown 串行跑。

## Core Structural Cases

```bash
node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a1-create-chg.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a1-create-chg.yaml /tmp/paceflow-agent-baseline-production/tc-a1-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a1-create-chg.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a8-update-chg-verify.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a8-update-chg-verify.yaml /tmp/paceflow-agent-baseline-production/tc-a8-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a8-update-chg-verify.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a9-close-chg.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a9-close-chg.yaml /tmp/paceflow-agent-baseline-production/tc-a9-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a9-close-chg.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a10-approve-and-start.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a10-approve-and-start.yaml /tmp/paceflow-agent-baseline-production/tc-a10-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a10-approve-and-start.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-c/tc-c3-close-chg-success.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-c/tc-c3-close-chg-success.yaml /tmp/paceflow-agent-baseline-production/tc-c3-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-c/tc-c3-close-chg-success.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-c/tc-c4-archive-chg-success.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-c/tc-c4-archive-chg-success.yaml /tmp/paceflow-agent-baseline-production/tc-c4-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-c/tc-c4-archive-chg-success.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-c/tc-c5-record-finding-success.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-c/tc-c5-record-finding-success.yaml /tmp/paceflow-agent-baseline-production/tc-c5-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-c/tc-c5-record-finding-success.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-c/tc-c6-record-correction-dual-write.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-c/tc-c6-record-correction-dual-write.yaml /tmp/paceflow-agent-baseline-production/tc-c6-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-c/tc-c6-record-correction-dual-write.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b1-missing-title.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b1-missing-title.yaml /tmp/paceflow-agent-baseline-production/tc-b1-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b1-missing-title.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b7-out-of-scope.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b7-out-of-scope.yaml /tmp/paceflow-agent-baseline-production/tc-b7-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b7-out-of-scope.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b8-unknown-operation.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b8-unknown-operation.yaml /tmp/paceflow-agent-baseline-production/tc-b8-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b8-unknown-operation.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b9-not-pace-project.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b9-not-pace-project.yaml /tmp/paceflow-agent-baseline-production/tc-b9-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b9-not-pace-project.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-d/tc-d5-broken-wikilink.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-d/tc-d5-broken-wikilink.yaml /tmp/paceflow-agent-baseline-production/tc-d5-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-d/tc-d5-broken-wikilink.yaml
```

## Optional Content Fidelity Case

```bash
node tests/agent-tests/run-tests.js prepare cases/phase-d/tc-d2-large-body.yaml --mode production
node tests/agent-tests/run-tests.js verify cases/phase-d/tc-d2-large-body.yaml /tmp/paceflow-agent-baseline-production/tc-d2-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-d/tc-d2-large-body.yaml
```

## Review Outputs

```bash
git status --short --branch
```

审查：
- `/tmp/claude-1000/response.md`
- `/tmp/paceflow-agent-baseline-production/*-report.json`
- `tests/agent-tests/results/<date>/*.report.md`
