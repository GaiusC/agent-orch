# Agent Orch Protocol

Agent Orch is a local orchestration protocol that can be followed from Codex, Claude Desktop, Claude Code, Antigravity, or a plain terminal. The current host coordinates the conversation, but project truth lives in `.agent-orchestrator`.

## Host and role model

- `host_provider`: the platform currently talking with the user (`codex`, `claude_desktop`, `cc_desktop`, `terminal`, or `unknown`).
- `planner`: creates contracts and scope boundaries.
- `executor`: edits code in an approved contract.
- `reviewer`: independently investigates or verifies.
- `accepter`: inspects evidence/diff and decides apply, reject, or repair.
- `coordinator`: advances the workflow and reports to the user.

Default roles are Codex planner/accepter, CC executor, AGY reviewer, and the current host as coordinator.

## Required resume step

Every host must resume state before continuing:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 resume -ProjectDir <project> -HostProvider <host>
```

Read `.agent-orchestrator/current-state.json` and `.agent-orchestrator/handoff.generated.md` before trusting older handwritten notes.

## Codex in-session rule

When `host_provider` is `codex`, Codex planner and accepter work must happen in the current Codex session. Do not launch Codex CLI or a second Codex worker for planning or acceptance from inside Codex.

When the host is not Codex, a configured external Codex provider may be used only if the project policy allows it. If Codex is unavailable, a configured fallback such as AGY Opus may act as planner/accepter, but the fallback must be recorded in events and user-facing reports.

## Continuity artifacts

- `events.jsonl`: append-only machine timeline.
- `current-state.json`: latest resumable project state.
- `handoff.generated.md`: generated human-readable handoff.
- `PROJECT.md`, `TODO.md`, `HANDOFF.md`: human context and planning notes.
- `runs/<job-id>/`: worker evidence, logs, patches, and transcripts.
