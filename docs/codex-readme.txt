可以。下面是一版我建议的 README 草稿。定位改成“防遗忘的少数硬门 + 可靠记录 + context hygiene”，不再把重点放在“完整流程强制系统”这个容易被误读成重 SDD 的 framing 上。

```md
# PACEflow

> PACEflow is a Claude Code hook system that prevents long-running AI coding sessions from forgetting the work protocol: create an approved change record before editing code, then verify, review, and close the change before the session ends.

PACEflow does not make the model smarter. It does not judge code quality. It does not prove that a verification or review is correct.

It enforces a smaller, more mechanical contract:

1. Before code changes, there must be an approved CHG.
2. Before stopping, the CHG must be verified, reviewed, and recorded.
3. The project must keep a usable trail of what changed, why, and how it was closed.

The point is not to stop a malicious model. The point is to keep a cooperative model from losing track of the process in long contexts, compacted sessions, multi-step changes, and worktree-heavy development.

---

## Why PACEflow exists

In short sessions, a good model often remembers to plan, ask for approval, make changes, run tests, and summarize.

In long sessions, this becomes unreliable.

The failure mode is usually not dishonesty. It is forgetting:

- the model starts editing before writing down the change;
- it continues after a compact without the right active context;
- it finishes without recording verification;
- it leaves no walkthrough for the next session;
- multiple sessions or worktrees drift into different views of the same change.

Natural-language instructions such as “please plan first” are useful, but they are not deterministic. PACEflow moves the few critical constraints into Claude Code hooks, so the protocol is enforced at tool-call boundaries instead of relying on the model to remember.

---

## What PACEflow is not

PACEflow is deliberately narrow.

It is not:

- a quality checker;
- a test framework;
- a spec generator;
- a replacement for human review;
- a security sandbox;
- a way to prevent deliberate bypass;
- a claim that `VERIFIED` or `REVIEWED` means the work is correct.

`VERIFIED` means the verification step was recorded.  
`REVIEWED` means the review step was recorded.  
Correctness still depends on tests, CI, runtime behavior, human judgment, and the model’s actual ability.

PACEflow enforces process occurrence and ordering. It does not certify truth.

---

## The core idea

PACEflow has one main job:

> turn “the model probably would have remembered” into “the project definitely has a change record.”

That record matters because it survives:

- long contexts;
- compaction;
- session restarts;
- parallel work;
- worktree switches;
- future debugging;
- future review.

The record is not just bookkeeping. It is also how the next session recovers context.

---

## The two hard gates

PACEflow intentionally keeps the hard enforcement surface small.

### 1. No approved CHG, no code write

If Claude tries to edit project code without an active approved CHG, the PreToolUse hook blocks the write.

This forces the session to first create a concrete change record:

- what is being changed;
- why;
- what tasks are in scope;
- what counts as done.

The user approves the CHG. The model cannot self-approve by directly writing the protected marker.

### 2. No verified/reviewed closure, no clean stop

If a session tries to end while the active CHG is incomplete, the Stop hook blocks normal completion and asks the model to verify, review, and close the change.

This prevents the common failure where the code is changed but the work record is left half-open.

To avoid deadlocks, Stop blocking is bounded and eventually downgrades to a reminder.

---

## Why artifacts are written by `artifact-writer`

PACEflow uses a dedicated `artifact-writer` agent to maintain CHG files, indexes, findings, corrections, and walkthrough records.

This is intentional.

The main session should spend its context budget on the actual engineering task: reading code, reasoning about changes, debugging, testing, and explaining decisions.

If the main session also performs every artifact edit directly, bookkeeping pollutes the same context that PACEflow is trying to protect. In large sessions, that makes forgetting worse.

So PACEflow separates responsibilities:

| Component | Responsibility |
|---|---|
| Main Claude session | understand the task, modify code, run verification, make engineering decisions |
| Hooks | enforce the few protocol invariants |
| `artifact-writer` | maintain structured records without bloating the main context |

This is context hygiene, not just token optimization.

---

## P-A-C-E-V-R

PACEflow names the lifecycle as P-A-C-E-V-R:

| Phase | Meaning | What PACEflow enforces |
|---|---|---|
| P | Plan | there must be an explicit change intent |
| A | Artifact | the change is represented as a CHG artifact |
| C | Check | the CHG must be approved before code edits |
| E | Execute | implementation happens under the active CHG |
| V | Verify | verification must be recorded before closure |
| R | Review | review/audit must be recorded before closure |

The important part is not the acronym. The important part is that work starts with an approved record and ends with a closed record.

---

## CHG: the smallest unit of work

A CHG is the smallest continuous, verifiable unit of change.

Good CHGs are:

- specific enough to verify;
- small enough to close;
- large enough to represent one coherent change;
- not just a random checklist bucket.

Examples:

- good: “Add Windows path normalization to golden snapshot tests”
- good: “Make artifact writer resume per CHG”
- too broad: “Improve PACEflow”
- too small: “Rename one local variable”

Large projects should become multiple CHGs, not one huge CHG.

---

## Project memory

PACEflow maintains a small set of project artifacts:

| File / directory | Purpose |
|---|---|
| `spec.md` | stable project facts and technical context |
| `task.md` | CHG / HOTFIX index |
| `findings.md` | finding index |
| `corrections.md` | correction index |
| `walkthrough.md` | completed work trail |
| `changes/` | detailed CHG, HOTFIX, finding, and correction records |

The detailed record lives under `changes/`. Index files are for navigation and session context.

---

## When PACEflow is a good fit

PACEflow is useful when losing process memory is expensive.

Good fits:

- long-lived codebases;
- production projects;
- multi-session AI development;
- work that frequently hits context compaction;
- projects where future debugging needs a reliable trail;
- teams that want consistent change records;
- higher-risk code where “what changed and how was it verified?” matters.

Poor fits:

- throwaway prototypes;
- one-off scripts;
- exploratory hacking;
- tiny edits where a CHG would cost more than the change;
- users who expect the tool to judge quality for them.

PACEflow is not meant to be invisible. It adds discipline. Use it where the discipline is worth the cost.

---

## One default mode

PACEflow intentionally does not expose multiple enforcement modes.

The core gates are few and necessary. Making them optional would mostly add configuration burden without removing the actual protocol cost.

For exceptions, use the existing escape hatches:

| Command | Purpose |
|---|---|
| `/paceflow:pause` | pause PACEflow for the current session |
| `/paceflow:resume` | resume after pause |
| `/paceflow:disable` | disable PACEflow for the project |
| `/paceflow:enable` | enable PACEflow |
| `/paceflow:status` | inspect current state |

The design goal is one tuned default, not a matrix of modes.

---

## Installation

PACEflow requires Claude Code `2.1.139` or newer because it depends on the `hooks[].args` exec form.

Install from Claude Code:

```bash
/plugin marketplace add paceaitian/paceflow
/plugin install paceflow@paceaitian-paceflow
```

Restart Claude Code after installation.

Then enable PACEflow in a project:

```text
/paceflow:enable
```

---

## Quick start

Ask Claude to make a code change.

If there is no approved CHG, PACEflow will block code edits and ask for a CHG first.

A normal flow looks like this:

1. You ask for a change.
2. Claude creates a CHG.
3. You approve the CHG.
4. Claude edits code.
5. Claude runs verification.
6. Claude reviews the diff.
7. Claude closes the CHG and writes a walkthrough entry.

You can inspect state at any time:

```text
/paceflow:status
```

---

## Obsidian and artifact storage

PACEflow can store artifacts either inside the project or in an Obsidian vault.

If `PACE_VAULT_PATH` is set, PACEflow can place project artifacts under:

```text
$PACE_VAULT_PATH/projects/<project-name>/
```

Otherwise, artifacts are stored in the project.

PACEflow records the artifact root under `.pace/artifact-root`, so later sessions and worktrees resolve to the same artifact location.

This matters for multi-session work: every session should see the same active CHG and the same project memory.

---

## Worktrees and parallel sessions

PACEflow supports worktree-aware artifact resolution.

The goal is not to encourage unnecessary parallelism. The goal is to prevent records from splitting when parallel work does happen.

PACEflow tries to keep:

- the active CHG;
- artifact root;
- ownership state;
- indexes;
- walkthrough records;

aligned across sessions and worktrees.

Most users do not need to think about this. It exists to keep the record correct when the environment becomes complicated.

---

## Integrations

PACEflow can work alongside planning/spec/testing tools.

It does not replace them.

| Tool type | Role |
|---|---|
| TDD / test frameworks | executable correctness checks |
| CI | external verification |
| OpenSpec / Spec Kit / SDD tools | requirements and design structure |
| Claude `/plan` | planning surface |
| Superpowers | planning and execution workflow |
| PACEflow | deterministic process guardrails and durable work records |

PACEflow is the enforcement and memory layer. It is not the source of product truth.

---

## Migration notes

PACEflow v7 changed the artifact layout.

At a high level:

- `changes/<id>.md` is the detailed source of truth for each change;
- `task.md` is an index, not the full change body;
- old v6/v5 layouts should be migrated carefully;
- all running Claude sessions should be restarted after plugin upgrade and before data migration.

Use the migration tool only after upgrading the plugin and reloading sessions.

For detailed migration steps, see the migration documentation or the release notes for your installed version.

---

## Development

The runtime implementation lives primarily under:

```text
plugin/hooks/
```

The plugin manifest is:

```text
plugin/.claude-plugin/plugin.json
```

PACEflow has no business-domain opinion. The hooks enforce mechanical workflow invariants; project-specific quality still belongs to tests, CI, review, and human judgment.

Typical local checks:

```bash
claude plugin validate ./plugin
node tests/test-pace-utils.js
node tests/test-session-layers.js
node tests/test-migrate-v7.js
node tests/test-hooks-e2e.js
```

---

## License

MIT
```