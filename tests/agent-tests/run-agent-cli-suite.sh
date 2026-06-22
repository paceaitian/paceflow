#!/usr/bin/env bash
# Run PACEflow artifact-writer cases through the Claude Code CLI.
#
# Defaults to production prompt smoke:
#   tests/agent-tests/run-agent-cli-suite.sh
#
# Production release gate (structural / mechanical checks, excludes optional content fidelity):
#   MODE=production tests/agent-tests/run-agent-cli-suite.sh production-gate
#
# Full harness baseline:
#   MODE=harness tests/agent-tests/run-agent-cli-suite.sh 29
#
# Useful env:
#   MODEL=sonnet|opus|...       Pass --model to claude
#   EFFORT=low|medium|high|xhigh|max
#   MODE=production|harness     Prompt mode for run-tests.js prepare
#   AGENT_NAME=...              Defaults to paceflow:artifact-writer
#   OUTDIR=/tmp/...             Output directory
#   PLUGIN_DIR=/path/to/plugin  Defaults to this repository

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACEFLOW_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER="$SCRIPT_DIR/run-tests.js"
PARSER="$SCRIPT_DIR/helpers/claude-output-to-report.js"

SUITE="${1:-production-smoke}"
MODE="${MODE:-production}"
OUTDIR="${OUTDIR:-/tmp/paceflow-agent-baseline-${MODE}}"
PLUGIN_DIR="${PLUGIN_DIR:-$PACEFLOW_ROOT}"
AGENT_NAME="${AGENT_NAME:-paceflow:artifact-writer}"
SESSION_CWD="${SESSION_CWD:-$OUTDIR/session-cwd}"
PRESERVE_FAILED_FIXTURE="${PRESERVE_FAILED_FIXTURE:-1}"
SUMMARY="$OUTDIR/summary.txt"
# vault 根（单一来源，与 JS 端 defaultVaultRoot 一致），用于 --add-dir 授权真实 vault 父目录
VAULT_ROOT="$(cd "$PACEFLOW_ROOT" && node -e 'process.stdout.write(require("./tests/agent-tests/helpers/subagent-runner").defaultVaultRoot())')"

if [[ "$MODE" != "production" && "$MODE" != "harness" ]]; then
  echo "MODE must be production or harness; got: $MODE" >&2
  exit 2
fi

mkdir -p "$OUTDIR" "$SESSION_CWD"
: > "$SUMMARY"

CLAUDE_ARGS=()
if [[ -n "${MODEL:-}" ]]; then
  CLAUDE_ARGS+=(--model "$MODEL")
fi
if [[ -n "${EFFORT:-}" ]]; then
  CLAUDE_ARGS+=(--effort "$EFFORT")
fi

case_target_dir() {
  # 单一来源：复用 subagent-runner 的 defaultVaultDir（含 project_path override 优先级），
  # 避免 shell 端硬编码 /tmp/test-vault 与 JS 端 os.tmpdir()/pace-test-vault 目录分叉。
  (cd "$PACEFLOW_ROOT" && node -e '
const r = require("./tests/agent-tests/helpers/subagent-runner");
const tc = r.loadYaml(process.argv[1]);
const v = (tc.setup && tc.setup.variables) || {};
process.stdout.write(v.project_path || r.defaultVaultDir(tc.setup.fixture));
' "$1")
}

copy_failed_fixture() {
  local target_dir="$1"
  local tc_id="$2"
  [[ "$PRESERVE_FAILED_FIXTURE" == "1" ]] || return 0
  [[ -d "$target_dir" ]] || return 0
  local snapshot_dir="$OUTDIR/failed-fixtures/${tc_id,,}"
  rm -rf "$snapshot_dir"
  mkdir -p "$(dirname "$snapshot_dir")"
  cp -R "$target_dir" "$snapshot_dir"
  echo "  preserved fixture: $snapshot_dir"
}

run_case() {
  local yaml_rel="$1"
  local tc_id="$2"
  local prompt_file="$OUTDIR/${tc_id,,}-prompt.txt"
  local prepare_log="$OUTDIR/${tc_id,,}-prepare.log"
  local claude_json="$OUTDIR/${tc_id,,}-claude.json"
  local claude_stderr="$OUTDIR/${tc_id,,}-claude.stderr"
  local report_file="$OUTDIR/${tc_id,,}-report.json"
  local verify_log="$OUTDIR/${tc_id,,}-verify.log"
  local yaml_abs="$SCRIPT_DIR/$yaml_rel"
  local target_dir
  target_dir="$(case_target_dir "$yaml_abs")"

  echo "----------------------------------------------------------------"
  echo "[$(date '+%H:%M:%S')] $tc_id  $yaml_rel"
  echo "----------------------------------------------------------------"

  (cd "$PACEFLOW_ROOT" && node "$RUNNER" teardown "$yaml_rel" >/dev/null 2>&1 || true)

  echo "  [1/4] prepare ($MODE)"
  if ! (cd "$PACEFLOW_ROOT" && node "$RUNNER" prepare "$yaml_rel" --mode "$MODE" --prompt-file "$prompt_file" > "$prepare_log" 2>&1); then
    echo "  FAIL: prepare failed"
    echo "$tc_id FAIL prepare" >> "$SUMMARY"
    return 1
  fi

  echo "  [2/4] claude agent"
  if ! (cd "$SESSION_CWD" && claude \
      "${CLAUDE_ARGS[@]}" \
      --agent "$AGENT_NAME" \
      --plugin-dir "$PLUGIN_DIR" \
      --add-dir "$PACEFLOW_ROOT" \
      --add-dir "$VAULT_ROOT" \
      --no-session-persistence \
      --dangerously-skip-permissions \
      --output-format json \
      -p "$(cat "$prompt_file")" \
      > "$claude_json" 2> "$claude_stderr"); then
    echo "  WARN: claude exited non-zero; continuing to parse output"
  fi

  if ! node "$PARSER" "$claude_json" "$report_file" --prompt-mode "$MODE" > /dev/null 2>&1; then
    echo "  FAIL: could not parse claude output"
    copy_failed_fixture "$target_dir" "$tc_id"
    (cd "$PACEFLOW_ROOT" && node "$RUNNER" teardown "$yaml_rel" >/dev/null 2>&1 || true)
    echo "$tc_id FAIL parse" >> "$SUMMARY"
    return 1
  fi

  echo "  [3/4] verify"
  local passed=0
  if (cd "$PACEFLOW_ROOT" && node "$RUNNER" verify "$yaml_rel" "$report_file" > "$verify_log" 2>&1); then
    passed=1
    cat "$verify_log"
  else
    cat "$verify_log"
  fi

  if [[ "$passed" == "1" ]]; then
    echo "  [4/4] teardown"
    (cd "$PACEFLOW_ROOT" && node "$RUNNER" teardown "$yaml_rel" >/dev/null 2>&1 || true)
    echo "$tc_id PASS" >> "$SUMMARY"
    return 0
  fi

  echo "  [4/4] snapshot + teardown"
  copy_failed_fixture "$target_dir" "$tc_id"
  (cd "$PACEFLOW_ROOT" && node "$RUNNER" teardown "$yaml_rel" >/dev/null 2>&1 || true)
  echo "$tc_id FAIL verify" >> "$SUMMARY"
  return 1
}

ALL_CASES=(
  "cases/phase-a/tc-a1-create-chg.yaml TC-A1"
  "cases/phase-a/tc-a2-update-chg.yaml TC-A2"
  "cases/phase-a/tc-a3-archive-chg.yaml TC-A3"
  "cases/phase-a/tc-a4-record-finding.yaml TC-A4"
  "cases/phase-a/tc-a5-record-correction.yaml TC-A5"
  "cases/phase-a/tc-a6-hotfix.yaml TC-A6"
  "cases/phase-a/tc-a7-merges-field.yaml TC-A7"
  "cases/phase-a/tc-a8-update-chg-verify.yaml TC-A8"
  "cases/phase-a/tc-a9-close-chg.yaml TC-A9"
  "cases/phase-a/tc-a10-approve-and-start.yaml TC-A10"
  "cases/phase-b/tc-b1-missing-title.yaml TC-B1"
  "cases/phase-b/tc-b2-target-not-found.yaml TC-B2"
  "cases/phase-b/tc-b3-archive-with-in-progress.yaml TC-B3"
  "cases/phase-b/tc-b4-summary-too-long.yaml TC-B4"
  "cases/phase-b/tc-b5-wrong-behavior-too-short.yaml TC-B5"
  "cases/phase-b/tc-b6-id-mismatch.yaml TC-B6"
  "cases/phase-b/tc-b7-out-of-scope.yaml TC-B7"
  "cases/phase-b/tc-b8-unknown-operation.yaml TC-B8"
  "cases/phase-b/tc-b9-not-pace-project.yaml TC-B9"
  "cases/phase-c/tc-c1-approve-and-start.yaml TC-C1"
  "cases/phase-c/tc-c2-approve-requires-confirmation.yaml TC-C2"
  "cases/phase-c/tc-c3-close-chg-success.yaml TC-C3"
  "cases/phase-c/tc-c4-archive-chg-success.yaml TC-C4"
  "cases/phase-c/tc-c5-record-finding-success.yaml TC-C5"
  "cases/phase-c/tc-c6-record-correction-dual-write.yaml TC-C6"
  "cases/phase-d/tc-d1-corrections-md-missing.yaml TC-D1"
  "cases/phase-d/tc-d2-large-body.yaml TC-D2"
  "cases/phase-d/tc-d3-archive-marker-missing.yaml TC-D3"
  "cases/phase-d/tc-d5-broken-wikilink.yaml TC-D5"
)

PRODUCTION_GATE_CASES=(
  "cases/phase-a/tc-a1-create-chg.yaml TC-A1"
  "cases/phase-a/tc-a2-update-chg.yaml TC-A2"
  "cases/phase-a/tc-a3-archive-chg.yaml TC-A3"
  "cases/phase-a/tc-a4-record-finding.yaml TC-A4"
  "cases/phase-a/tc-a5-record-correction.yaml TC-A5"
  "cases/phase-a/tc-a6-hotfix.yaml TC-A6"
  "cases/phase-a/tc-a7-merges-field.yaml TC-A7"
  "cases/phase-a/tc-a8-update-chg-verify.yaml TC-A8"
  "cases/phase-a/tc-a9-close-chg.yaml TC-A9"
  "cases/phase-a/tc-a10-approve-and-start.yaml TC-A10"
  "cases/phase-b/tc-b1-missing-title.yaml TC-B1"
  "cases/phase-b/tc-b2-target-not-found.yaml TC-B2"
  "cases/phase-b/tc-b3-archive-with-in-progress.yaml TC-B3"
  "cases/phase-b/tc-b4-summary-too-long.yaml TC-B4"
  "cases/phase-b/tc-b5-wrong-behavior-too-short.yaml TC-B5"
  "cases/phase-b/tc-b6-id-mismatch.yaml TC-B6"
  "cases/phase-b/tc-b7-out-of-scope.yaml TC-B7"
  "cases/phase-b/tc-b8-unknown-operation.yaml TC-B8"
  "cases/phase-b/tc-b9-not-pace-project.yaml TC-B9"
  "cases/phase-c/tc-c1-approve-and-start.yaml TC-C1"
  "cases/phase-c/tc-c2-approve-requires-confirmation.yaml TC-C2"
  "cases/phase-c/tc-c3-close-chg-success.yaml TC-C3"
  "cases/phase-c/tc-c4-archive-chg-success.yaml TC-C4"
  "cases/phase-c/tc-c5-record-finding-success.yaml TC-C5"
  "cases/phase-c/tc-c6-record-correction-dual-write.yaml TC-C6"
  "cases/phase-d/tc-d1-corrections-md-missing.yaml TC-D1"
  "cases/phase-d/tc-d3-archive-marker-missing.yaml TC-D3"
  "cases/phase-d/tc-d5-broken-wikilink.yaml TC-D5"
)

PRODUCTION_SMOKE_CASES=(
  "cases/phase-a/tc-a1-create-chg.yaml TC-A1"
  "cases/phase-a/tc-a8-update-chg-verify.yaml TC-A8"
  "cases/phase-a/tc-a9-close-chg.yaml TC-A9"
  "cases/phase-a/tc-a10-approve-and-start.yaml TC-A10"
  "cases/phase-c/tc-c1-approve-and-start.yaml TC-C1"
  "cases/phase-c/tc-c2-approve-requires-confirmation.yaml TC-C2"
  "cases/phase-c/tc-c3-close-chg-success.yaml TC-C3"
  "cases/phase-c/tc-c4-archive-chg-success.yaml TC-C4"
  "cases/phase-c/tc-c5-record-finding-success.yaml TC-C5"
  "cases/phase-c/tc-c6-record-correction-dual-write.yaml TC-C6"
  "cases/phase-b/tc-b1-missing-title.yaml TC-B1"
  "cases/phase-b/tc-b7-out-of-scope.yaml TC-B7"
  "cases/phase-b/tc-b8-unknown-operation.yaml TC-B8"
  "cases/phase-b/tc-b9-not-pace-project.yaml TC-B9"
  "cases/phase-d/tc-d5-broken-wikilink.yaml TC-D5"
)

OPTIONAL_CONTENT_CASES=(
  "cases/phase-d/tc-d2-large-body.yaml TC-D2"
)

MERGED_OPERATION_CASES=(
  "cases/phase-a/tc-a9-close-chg.yaml TC-A9"
  "cases/phase-a/tc-a10-approve-and-start.yaml TC-A10"
  "cases/phase-c/tc-c1-approve-and-start.yaml TC-C1"
  "cases/phase-c/tc-c2-approve-requires-confirmation.yaml TC-C2"
  "cases/phase-c/tc-c3-close-chg-success.yaml TC-C3"
)

case "$SUITE" in
  21|23|25|29|all)
    if [[ "$MODE" == "production" ]]; then
      echo "NOTE: suite '$SUITE' includes optional content fidelity case TC-D2; use production-gate for release blocking." >&2
    fi
    CASES=("${ALL_CASES[@]}")
    ;;
  production-gate|gate|structural)
    CASES=("${PRODUCTION_GATE_CASES[@]}")
    ;;
  production-smoke|smoke)
    CASES=("${PRODUCTION_SMOKE_CASES[@]}")
    ;;
  content|optional-content)
    CASES=("${OPTIONAL_CONTENT_CASES[@]}")
    ;;
  merged|new-agent)
    CASES=("${MERGED_OPERATION_CASES[@]}")
    ;;
  *)
    echo "Unknown suite: $SUITE" >&2
    echo "Available: production-gate, production-smoke, content, merged, 29, 25, 23, 21" >&2
    exit 2
    ;;
esac

echo "PACEflow agent CLI suite"
echo "  suite: $SUITE"
echo "  mode:  $MODE"
echo "  root:  $PACEFLOW_ROOT"
echo "  out:   $OUTDIR"
echo "  cwd:   $SESSION_CWD"
echo "  agent: $AGENT_NAME"
if [[ -n "${MODEL:-}" ]]; then echo "  model: $MODEL"; fi
if [[ -n "${EFFORT:-}" ]]; then echo "  effort: $EFFORT"; fi
echo

failures=0
for entry in "${CASES[@]}"; do
  yaml_rel="${entry% *}"
  tc_id="${entry##* }"
  if ! run_case "$yaml_rel" "$tc_id"; then
    failures=$((failures + 1))
  fi
  echo
done

echo "================================================================"
echo "Summary"
echo "================================================================"
cat "$SUMMARY"
total="$(wc -l < "$SUMMARY" | tr -d ' ')"
passed="$(grep -c ' PASS' "$SUMMARY" || true)"
echo
echo "Passed: $passed / $total"
echo "Output: $OUTDIR"

exit "$failures"
