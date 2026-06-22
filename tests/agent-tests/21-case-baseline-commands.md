# 29-case Agent Baseline Commands

自动化入口：

```bash
cd /mnt/k/AI/paceflow-hooks/paceflow
MODE=harness OUTDIR=/tmp/paceflow-agent-baseline tests/agent-tests/run-agent-cli-suite.sh 29
```

下面是手工分步命令，主要用于单 case 调试。

> 用途：PACEflow v6 agent fixture 全量 baseline（Phase A 10 个 + Phase B 9 个 + Phase C 6 个 + Phase D 4 个）。
> 本文使用默认 `harness` prompt。真实主 session 派发路径见
> `tests/agent-tests/production-prompt-smoke-commands.md`。
> `29` 全量 baseline 包含 TC-D2 长正文内容保真用例；它适合作为 harness / model benchmark，
> 不作为 production release gate。发布阻断请跑：
> `MODE=production tests/agent-tests/run-agent-cli-suite.sh production-gate`。
> `21` / `23` / `25` 仍作为历史兼容 alias 保留，当前等价于 `29`。
>
> 每个 case 的流程固定为：
> 1. `prepare` 输出 agent prompt
> 2. 在 Claude Code 主 session 派遣 `artifact-writer`
> 3. 将 agent 报告保存为 `/tmp/paceflow-agent-baseline/<tc-id>-report.json`
> 4. `verify`
> 5. `teardown`

```bash
cd /mnt/k/AI/paceflow-hooks/paceflow
mkdir -p /tmp/paceflow-agent-baseline
```

不要并行执行使用同一 fixture 的 `prepare`。多个 case 共用 `os.tmpdir()/pace-test-vault/empty-v6`（POSIX 下即 `/tmp/pace-test-vault/empty-v6`），
必须按 prepare → verify → teardown 串行跑。

## Phase A

```bash
node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a1-create-chg.yaml
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a1-create-chg.yaml /tmp/paceflow-agent-baseline/tc-a1-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a1-create-chg.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a2-update-chg.yaml
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a2-update-chg.yaml /tmp/paceflow-agent-baseline/tc-a2-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a2-update-chg.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a3-archive-chg.yaml
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a3-archive-chg.yaml /tmp/paceflow-agent-baseline/tc-a3-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a3-archive-chg.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a4-record-finding.yaml
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a4-record-finding.yaml /tmp/paceflow-agent-baseline/tc-a4-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a4-record-finding.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a5-record-correction.yaml
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a5-record-correction.yaml /tmp/paceflow-agent-baseline/tc-a5-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a5-record-correction.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a6-hotfix.yaml
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a6-hotfix.yaml /tmp/paceflow-agent-baseline/tc-a6-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a6-hotfix.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a7-merges-field.yaml
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a7-merges-field.yaml /tmp/paceflow-agent-baseline/tc-a7-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a7-merges-field.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a8-update-chg-verify.yaml
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a8-update-chg-verify.yaml /tmp/paceflow-agent-baseline/tc-a8-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a8-update-chg-verify.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a9-close-chg.yaml
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a9-close-chg.yaml /tmp/paceflow-agent-baseline/tc-a9-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a9-close-chg.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-a/tc-a10-approve-and-start.yaml
node tests/agent-tests/run-tests.js verify cases/phase-a/tc-a10-approve-and-start.yaml /tmp/paceflow-agent-baseline/tc-a10-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-a/tc-a10-approve-and-start.yaml
```

## Phase B

```bash
node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b1-missing-title.yaml
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b1-missing-title.yaml /tmp/paceflow-agent-baseline/tc-b1-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b1-missing-title.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b2-target-not-found.yaml
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b2-target-not-found.yaml /tmp/paceflow-agent-baseline/tc-b2-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b2-target-not-found.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b3-archive-with-in-progress.yaml
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b3-archive-with-in-progress.yaml /tmp/paceflow-agent-baseline/tc-b3-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b3-archive-with-in-progress.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b4-summary-too-long.yaml
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b4-summary-too-long.yaml /tmp/paceflow-agent-baseline/tc-b4-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b4-summary-too-long.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b5-wrong-behavior-too-short.yaml
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b5-wrong-behavior-too-short.yaml /tmp/paceflow-agent-baseline/tc-b5-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b5-wrong-behavior-too-short.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b6-id-mismatch.yaml
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b6-id-mismatch.yaml /tmp/paceflow-agent-baseline/tc-b6-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b6-id-mismatch.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b7-out-of-scope.yaml
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b7-out-of-scope.yaml /tmp/paceflow-agent-baseline/tc-b7-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b7-out-of-scope.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b8-unknown-operation.yaml
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b8-unknown-operation.yaml /tmp/paceflow-agent-baseline/tc-b8-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b8-unknown-operation.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-b/tc-b9-not-pace-project.yaml
node tests/agent-tests/run-tests.js verify cases/phase-b/tc-b9-not-pace-project.yaml /tmp/paceflow-agent-baseline/tc-b9-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-b/tc-b9-not-pace-project.yaml
```

## Phase C

```bash
node tests/agent-tests/run-tests.js prepare cases/phase-c/tc-c1-approve-and-start.yaml
node tests/agent-tests/run-tests.js verify cases/phase-c/tc-c1-approve-and-start.yaml /tmp/paceflow-agent-baseline/tc-c1-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-c/tc-c1-approve-and-start.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-c/tc-c2-approve-requires-confirmation.yaml
node tests/agent-tests/run-tests.js verify cases/phase-c/tc-c2-approve-requires-confirmation.yaml /tmp/paceflow-agent-baseline/tc-c2-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-c/tc-c2-approve-requires-confirmation.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-c/tc-c3-close-chg-success.yaml
node tests/agent-tests/run-tests.js verify cases/phase-c/tc-c3-close-chg-success.yaml /tmp/paceflow-agent-baseline/tc-c3-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-c/tc-c3-close-chg-success.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-c/tc-c4-archive-chg-success.yaml
node tests/agent-tests/run-tests.js verify cases/phase-c/tc-c4-archive-chg-success.yaml /tmp/paceflow-agent-baseline/tc-c4-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-c/tc-c4-archive-chg-success.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-c/tc-c5-record-finding-success.yaml
node tests/agent-tests/run-tests.js verify cases/phase-c/tc-c5-record-finding-success.yaml /tmp/paceflow-agent-baseline/tc-c5-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-c/tc-c5-record-finding-success.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-c/tc-c6-record-correction-dual-write.yaml
node tests/agent-tests/run-tests.js verify cases/phase-c/tc-c6-record-correction-dual-write.yaml /tmp/paceflow-agent-baseline/tc-c6-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-c/tc-c6-record-correction-dual-write.yaml
```

## Phase D

```bash
node tests/agent-tests/run-tests.js prepare cases/phase-d/tc-d1-corrections-md-missing.yaml
node tests/agent-tests/run-tests.js verify cases/phase-d/tc-d1-corrections-md-missing.yaml /tmp/paceflow-agent-baseline/tc-d1-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-d/tc-d1-corrections-md-missing.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-d/tc-d2-large-body.yaml
node tests/agent-tests/run-tests.js verify cases/phase-d/tc-d2-large-body.yaml /tmp/paceflow-agent-baseline/tc-d2-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-d/tc-d2-large-body.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-d/tc-d3-archive-marker-missing.yaml
node tests/agent-tests/run-tests.js verify cases/phase-d/tc-d3-archive-marker-missing.yaml /tmp/paceflow-agent-baseline/tc-d3-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-d/tc-d3-archive-marker-missing.yaml

node tests/agent-tests/run-tests.js prepare cases/phase-d/tc-d5-broken-wikilink.yaml
node tests/agent-tests/run-tests.js verify cases/phase-d/tc-d5-broken-wikilink.yaml /tmp/paceflow-agent-baseline/tc-d5-report.json
node tests/agent-tests/run-tests.js teardown cases/phase-d/tc-d5-broken-wikilink.yaml
```

## After Run

```bash
git status --short --branch
```

跑完后审查：
- `/tmp/claude-1000/response.md`
- `/tmp/paceflow-agent-baseline/*-report.json`
- `tests/agent-tests/results/<date>/*.report.md`
