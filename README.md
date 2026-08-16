# PACEflow

[![CI](https://github.com/paceaitian/paceflow/actions/workflows/ci.yml/badge.svg)](https://github.com/paceaitian/paceflow/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/paceaitian/paceflow)](https://github.com/paceaitian/paceflow/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

> **Deterministic workflow enforcement and persistent engineering memory for long-running coding agents.**

PACEflow keeps coding agents on a verifiable engineering workflow during long, stateful tasks. It enforces workflow transitions at tool boundaries, persists task state outside the model context, and restores that state across sessions and context compaction.

PACEflow ships as a **Claude Code plugin** that also installs into **OpenAI Codex CLI** (same plugin directory, same hook scripts, artifact writes via a bundled MCP server on Codex — see [Codex CLI (MVP)](#codex-cli-mvp)). Its underlying reliability model—deterministic gates, persistent artifacts, verification, and review—addresses problems common to long-running coding agents.

## Why PACEflow?

Long-running coding-agent tasks introduce workflow continuity failures:

- implementation begins before the plan is approved;
- task state drifts during a long session;
- important context disappears after compaction or a new session;
- verification or review is skipped at closure;
- process instructions written only in prompts remain probabilistic.

PACEflow addresses these failures at the workflow layer. Instead of asking the model to remember every transition, it places deterministic hooks around tool use and session completion, persists the working state, and delegates record-keeping to a dedicated `artifact-writer` agent.

## Deterministic gates, not deterministic intelligence

The model still plans, implements, verifies, and reviews the code. A PACEflow gate confirms that a required step occurred in the expected order and left an auditable record; it does not claim that the result of that step is correct.

`VERIFIED` means verification was performed and recorded. `REVIEWED` means review was performed and recorded. Correctness remains the responsibility of tests, CI, reviewers, model capability, and human judgment.

## What PACEflow does

| Boundary | Enforcement |
| --- | --- |
| Before code changes | When PACEflow is enabled, an active CHG or HOTFIX must exist and carry explicit user approval. |
| During implementation | Managed workflow artifacts (except the user-maintained `spec.md`) and runtime control files are protected from direct main-session edits. |
| Before session completion | Open work must be completed, verified, reviewed, and archived. |
| Across sessions | Active change state and relevant project memory are restored on startup, resume, and compaction. |
| During record-keeping | A dedicated `artifact-writer` maintains structured artifacts, reducing record-keeping in the main coding context. |

The current implementation uses the host's lifecycle hooks (Claude Code hooks; Codex CLI hooks through a thin host adapter), so the gates run at tool boundaries rather than depending only on prompt compliance.

## The PACE lifecycle

| Stage | Meaning | Recorded outcome |
| --- | --- | --- |
| **P**lan | Define the change | Scope and task list |
| **A**rtifact | Create a persistent change record | `changes/<id>.md` plus indexes |
| **C**heck | Obtain user approval | `<!-- APPROVED -->` |
| **E**xecute | Implement the approved change | Work record |
| **V**erify | Run and record relevant checks | Verification evidence and `<!-- VERIFIED -->` |
| **R**eview | Review the change before closure | Review evidence and `<!-- REVIEWED -->` |

`CHG` and `HOTFIX` records are deliberately small: each one should be independently executable, verifiable, and closable. Large plans are split into multiple changes rather than treated as one permanent project container.

```text
Plan → Artifact → Check → Execute → Verify → Review → Close
  P        A         C        E          V         R
```

## Installation

On Claude Code, PACEflow requires **Claude Code 2.1.218 or newer** (Codex CLI: see [below](#codex-cli-mvp)). Two hard dependencies: the hook manifest uses the `hooks[].args` execution form (introduced in 2.1.139), and it registers the `SubagentStart` hook event (earliest version verified to support it: 2.1.218). **A host that does not recognize any event name in a plugin's hooks.json silently drops the plugin's entire hook set** (verified empirically) — on older hosts every PACEflow gate would fail without any warning.

Run these commands inside Claude Code:

```text
/plugin marketplace add paceaitian/paceflow
/plugin install paceflow@paceaitian-paceflow
```

Restart Claude Code after installation, then enable PACEflow in a project:

```text
/paceflow:enable
```

The plugin registers twelve hook event types, four user skills, five user commands, and one `artifact-writer` agent.

### Optional Obsidian storage

Set `PACE_VAULT_PATH` to an Obsidian vault if you want implementation artifacts outside the source repository. On first use, PACEflow asks whether the project should store artifacts locally or under:

```text
$PACE_VAULT_PATH/projects/<project-name>/
```

The choice is persisted in `.pace/artifact-root`. Headless environments can set `PACE_ARTIFACT_ROOT` to `local`, `vault`, or an absolute path.

### Codex CLI (MVP)

PACEflow also installs into OpenAI Codex CLI (verified end-to-end on codex-cli 0.147.0 on Linux and Windows). Codex reads the same plugin directory through `.codex-plugin/plugin.json`: hooks are registered from `hooks/hooks.codex.json` — every entry runs `hooks/codex-adapter.js`, which translates Codex events (`apply_patch`, MCP tool calls, plain-text output) for the shared hook scripts, so the gate logic is the same code — and artifact writes go through the bundled `paceflow` MCP server instead of the `artifact-writer` subagent (Codex subagent prompts are opaque to hooks and hooks do not fire inside subagents).

```text
# 1. Register the marketplace (Codex reads the same .claude-plugin/marketplace.json at the repo root)
codex plugin marketplace add paceaitian/paceflow
# 2. Install the plugin (copied into $CODEX_HOME/plugins/cache/paceaitian-paceflow/paceflow/<version>/)
codex plugin add paceflow@paceaitian-paceflow
# 3. Inside Codex: /hooks → review and trust the PACEflow hooks (non-managed hooks are skipped until trusted;
#    automation can pass `codex exec --dangerously-bypass-hook-trust`), then start a new thread.
# 4. Per project: run the helper printed by the SessionStart injection, e.g.
#    node "<plugin-root>/hooks/set-artifact-root.js" --choice local     (or --choice vault)
# Upgrade: codex plugin marketplace upgrade && codex plugin add paceflow@paceaitian-paceflow
# Uninstall: codex plugin remove paceflow@paceaitian-paceflow
```

Verified: `codex plugin add` reports `Installed plugin root: …/paceflow/<version>`, `codex mcp list` shows the `paceflow` server, and a `codex exec` turn prints `hook: SessionStart Completed`.

MVP scope on Codex: the write gate on `apply_patch`/Bash, the Stop gate, SessionStart/UserPromptSubmit injection, and the MCP tools `get_context` / `reserve_artifact_id` / `create_chg` / `update_chg` (approve, approve-and-start, update-status, append, verify, review) / `close_chg` / `record_finding`. Not covered yet: `archive-chg`, `update-finding`, `record-correction`, `update-index`, batch create — and, as a host limitation, file writes made inside Codex subagents are not gated. Details in the [reference manual](REFERENCE.md#52-codex-cli-宿主).

## Quick start

After installation and `/paceflow:enable`:

1. Ask Claude Code to make a change.
2. If no active, approved change exists, the PreToolUse gate rejects code writes and directs the workflow to create a CHG.
3. Review the proposed scope and approve it. PACEflow does not allow the agent to self-approve.
4. The agent implements the approved tasks.
5. Relevant verification is run and recorded.
6. The change receives a review, then is closed and archived.

The shortest implementation path is still small: create a CHG, approve it, and execute. Verification, review, and archival become mandatory when the work is closed.

Available commands:

| Command | Purpose |
| --- | --- |
| `/paceflow:enable` | Enable PACEflow for the project |
| `/paceflow:disable` | Disable it without deleting artifacts |
| `/paceflow:status` | Show the current workflow state |
| `/paceflow:pause` | Pause enforcement for the current session |
| `/paceflow:resume` | Resume enforcement |

## Persistent project memory

PACEflow separates runtime control state from durable implementation records.

| Artifact | Purpose |
| --- | --- |
| `spec.md` | Project metadata and technical context |
| `task.md` | Active CHG/HOTFIX index |
| `changes/` | Detailed change, finding, correction, and walkthrough records |
| `findings.md` | Finding index |
| `corrections.md` | Correction index |
| `walkthrough.md` | Completed-work index |
| `.pace/` | Local runtime state, locks, ownership, and configuration |

On `SessionStart`, PACEflow injects the active change summary and relevant indexes so a resumed or compacted session can recover what was being changed and why.

## How enforcement works

PACEflow registers hooks for twelve lifecycle events:

- `SessionStart` restores project and change context.
- `UserPromptSubmit` injects a one-line active-change summary on each user turn when this session has a running or closing-required change (second anti-forgetting channel; silent when paused or nothing matches).
- `PreToolUse` guards code writes made through Write/Edit/MultiEdit (the code-write gate), agent dispatches, approvals, and artifact / runtime-control writes — including shell commands that would mutate artifacts or `.pace`. Shell writes to ordinary code files are not gated: the gate is a reminder against forgetting, not a sandbox.
- `PostToolUse` and `PostToolUseFailure` record or surface follow-up requirements.
- `SubagentStart` and `Notification` are logging-only observers (lifecycle accounting and host-event field collection).
- `SubagentStop` fires on every subagent stop (including mid-run idles on host 2.1.232+); it observes `artifact-writer` reports and closes change ownership only on a terminal SUCCESS report.
- `PreCompact` preserves native-plan bridging signals.
- `Stop` checks completion, verification, review, and archival state.
- `StopFailure` records abnormal interruption.
- `SessionEnd` releases session ownership and clears session-scoped pause state.

The Stop gate has bounded anti-deadlock behavior: repeated blocking eventually degrades instead of trapping a session permanently. See the [reference manual](REFERENCE.md) for the exact state machine, guard levels, and teammate behavior.

## Integrations

### Claude Code `/plan`

Native plan files can be detected and bridged into persistent PACEflow CHGs. If a compacted session loses the live plan, the stored change record remains available.

### Superpowers

PACEflow can bridge planning output from the Superpowers brainstorming and writing-plans workflow into the PACE lifecycle.

```text
brainstorming → writing-plans → pace-bridge → CHG → Execute → Verify → Review
```

### Obsidian

Artifacts can live in an Obsidian vault, with optional cross-project knowledge and thought summaries injected at session start.

### Worktrees and Agent Teams

Git worktrees and Claude Code worktrees share PACEflow artifacts and runtime state through the host Project Root while ordinary code edits remain in the current worktree. Teammates receive differentiated enforcement so workflow guidance does not create deadlocks while approval and integrity boundaries remain hard.

## Runtime scope and trust boundary

The released implementation targets **Claude Code** and, as an MVP, **OpenAI Codex CLI** — both expose the lifecycle hooks PACEflow needs (Codex implements the same hook protocol; the differences are handled by `hooks/codex-adapter.js`, and Codex lacks subagent-aware hooks, so on Codex the artifact writer is an MCP server rather than a subagent). The broader model—persistent workflow state, deterministic tool gates, human approval, verification, review, and session recovery—can be evaluated on other coding-agent runtimes only where equivalent lifecycle controls exist.

PACEflow is not:

- a coding model or autonomous software engineer;
- a bug detector, static analyzer, or quality judge;
- a replacement for tests, CI, code review, or human decisions;
- a specification generator or source of project truth;
- protection against a user intentionally pausing, disabling, or bypassing the plugin.

It is a workflow reliability layer around a coding agent.

## Development and verification

The repository contains hook, contract, migration, session-layer, agent-helper, and runner tests. GitHub Actions runs the same aggregate suite on Linux, macOS, and Windows.

Run the full local suite from the repository root:

```bash
node tests/run-all.js
```

The aggregate runner also performs Claude plugin validation and `git diff --check`. For focused iteration, set `PACE_TEST_FILTER` to a suite-name substring before running the same command.

The runtime published through the Claude Code marketplace lives under `plugin/` (Codex reads the same directory through `plugin/.codex-plugin/plugin.json`). Repository maintenance material, tests, and historical design documents live under `tests/`, `docs/`, and `internal/` — the Codex port research and acceptance records are in `docs/research-2026-08-15-codex-port-feasibility.md` and `docs/research/codex-port/`.

## Documentation

- [完整中文说明](README.zh-CN.md)
- [Reference manual / 参考手册](REFERENCE.md)
- [GitHub releases](https://github.com/paceaitian/paceflow/releases)
- [Legacy v5 changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## Contributing

Issues, bug reports, design discussions, and pull requests are welcome. When reporting a workflow failure, please distinguish among model behavior, PACEflow enforcement behavior, and Claude Code runtime behavior where possible.

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository-specific contribution notes.

## License

[MIT](LICENSE)
