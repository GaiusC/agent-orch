# Agent Orch

Agent Orch is a local multi-agent orchestration runtime for supervising external coding agents without depending on a Codex MCP server. Codex is the default planner/accepter, Claude Code or Antigravity implements, and Antigravity provides targeted investigation or verification when its local auth is usable.

Agent Orch is designed to be resumable across hosts. Codex, Claude Desktop/Claude Code, and plain terminal workflows all resume from `.agent-orchestrator/` state before continuing a project. When the current host is Codex, planning and acceptance happen in the current Codex session; Agent Orch must not start Codex CLI just to plan or accept.

The default path is Skill + CLI:

- Codex owns task planning, scope boundaries, and final acceptance.
- Codex does not author project patches while Agent Orch is active; it plans, delegates, verifies, and accepts or rejects.
- Worker changes are produced in an isolated Git worktree by default and applied only after acceptance.
- Sessions are reused by project, provider, task id, and model to keep context stable.
- Machine continuity is recorded in `events.jsonl`, `current-state.json`, and `handoff.generated.md`.

## Routing

Agent Orch supports three implementation paths:

| Path | Command | Description |
| --- | --- | --- |
| CC implementation | `cc-exec` / `cc-continue` | Claude Code as the primary writer (isolated worktree + patch + verify + apply/cleanup) |
| AGY write | `agy-exec` / `agy-continue` | Antigravity as the primary writer with Thinking models (same worktree/patch/verify/apply cycle) |
| Automatic | `auto` | CC-first routing: all complexities start with CC. Low/medium use deepseek-v4-flash, high uses deepseek-v4-pro. After two failed CC verification cycles, escalates to AGY write with Claude Sonnet 4.6 (Thinking). |

### Model defaults

CC uses a two-tier default policy:
- **Low and medium** complexity -> `deepseek-v4-flash` (for cc-exec, cc-continue, and all auto routing)
- **High** complexity -> `deepseek-v4-pro`
- Per-contract explicit model overrides take priority over defaults

AGY read-only (investigate/verify): Gemini 3.5 Flash (low) / Gemini 3.1 Pro (medium/high)
AGY write: Claude Sonnet 4.6 (Thinking) (medium) / Claude Opus 4.6 (Thinking) (high)

### Automatic routing with CC-first + AGY escalation

The `auto` command routes all implementation contracts to CC by default. Low and medium complexity use `deepseek-v4-flash`; high complexity uses `deepseek-v4-pro`. If CC completes with `verification_failed` after at least two verification/review cycles (the initial attempt plus at least one repair), the router escalates the contract to AGY write using the exact model `Claude Sonnet 4.6 (Thinking)`. If AGY write fails with a quota/credit/rate-exhaustion error during escalation, the router cleans up the AGY workspace and retries with CC at high complexity using `deepseek-v4-pro`, recording the full escalation chain as evidence. Other AGY failures (authentication, permission, internal errors) are NOT silently swallowed - they surface normally so Codex can respond.

Direct `agy-exec` and `agy-continue` commands bypass the auto router and write with AGY directly.

Provider-aware calibration: ordinary work estimated as CC-high may generally be treated as AGY-medium/Sonnet. Reserve AGY-high/Opus for exceptional complexity or risk.

### Migration compatibility

The default `routing.auto` policy is `"cc_first"` (all complexities route to CC; AGY escalation after CC verification failure). Legacy configs with `routing.auto: "agy_preferred"` route low to CC and medium/high to AGY write. Legacy configs with `"cc"` route all contracts to CC without escalation. Existing project configs with `primary_writer: "cc"` still work without changes.

## Parallel allocation policy

- Multiple CC workers can run in parallel for read-only contracts or clearly disjoint writable paths.
- One AGY write worker should be allocated whenever multiple disjoint contracts run in parallel.
- Retain at most one concurrent AGY by default on this machine.
- Multiple concurrent AGY write jobs require a successful multi-AGY smoke test.

## Requirements

- Codex CLI/Desktop with plugin support.
- Node.js 18.18 or newer.
- Git.
- Local `claude` CLI.
- Local `agy` CLI if AGY verification or writing is desired.

## Install

```powershell
git clone git@github.com:GaiusC/agent-orch.git
cd agent-orch
npm install
```

Add the cloned plugin to a personal Codex plugin marketplace, then install:

```powershell
codex plugin add agent-orch@personal
```

Open a new Codex session after installation.

## Project Setup

Initialize each target project:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 init -ProjectDir <project>
```

For a partially built project, add `-ExistingProject`.

This creates:

```text
.agent-orchestrator/
  config.json
  state/
  runs/
```

Review `.agent-orchestrator/config.json`, keep `duplicate_implementation` false, and configure real verification commands before accepting worker output. The default template launches CC with `bypassPermissions` and AGY without sandbox so both workers can run non-interactively in local desktop workflows; tighten these settings only if your local CLIs can still complete delegated contracts without blocking.

## Usage

In any host, resume first:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 resume -ProjectDir <project> -HostProvider codex
```

Use `-HostProvider claude_desktop` from Claude/CC hosts and `-HostProvider terminal` from a plain shell.

In a Codex session for a configured project:

```text
Use agent-orch. Plan this change, delegate implementation to CC or AGY via the auto router, use AGY for targeted verification, and apply the patch only after acceptance.
```

Codex should call `scripts\agent-orch.ps1`, inspect evidence under `.agent-orchestrator\runs`, request same-session repair if needed, and apply the patch only after verification.

Open the dashboard without talking to an agent:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 dashboard -ProjectDir <project>
```

For substantial work, Codex should first split the goal into small contracts, route implementation contracts via `auto` (which handles provider and model selection), route required investigation or verification gates to AGY, and record any waived gate or residual risk for the user.

Parallel routing is allowed, but bounded: multiple CC workers can run for read-only or disjoint contracts; AGY write should be serialized unless the current local AGY account has passed a fresh multi-AGY smoke test. In this environment, a 2026-07-04 smoke test showed parallel CC working, but two concurrent AGY jobs were unstable while sequential AGY recovered successfully.

## CLI Commands

```
agent-orch init      -ProjectDir <project> [-ExistingProject]
agent-orch health    -ProjectDir <project>
agent-orch resume    -ProjectDir <project> [-HostProvider codex|claude_desktop|terminal|unknown]
agent-orch dashboard -ProjectDir <project> [-PreferredPort 15788]
agent-orch cc-exec   -ProjectDir <project> -Contract <json-or-file>
agent-orch cc-continue -ProjectDir <project> -Contract <json-or-file>
agent-orch agy-exec  -ProjectDir <project> -Contract <json-or-file>
agent-orch agy-continue -ProjectDir <project> -Contract <json-or-file>
agent-orch agy-investigate -ProjectDir <project> -Contract <json-or-file>
agent-orch agy-verify -ProjectDir <project> -Contract <json-or-file>
agent-orch auto      -ProjectDir <project> -Contract <json-or-file>
agent-orch status    -ProjectDir <project> -JobId <id>
agent-orch result    -ProjectDir <project> -JobId <id>
agent-orch apply     -ProjectDir <project> -JobId <id>
agent-orch cleanup   -ProjectDir <project> -JobId <id>
```

## Legacy MCP

The previous MCP server remains in the repository for legacy use, but it is not registered by default. The CLI path is recommended for multi-account Codex setups and environments where MCP startup or AGY OAuth state is unstable.

## Safety Notes

- Keep `duplicate_implementation` false unless you have a very specific reason.
- Do not commit `.agent-orchestrator/state/` or `.agent-orchestrator/runs/`.
- Review project-provided `.agent-orchestrator/config.json` before setting `trusted` to true.
- Treat worker output as a claim; Codex still needs to verify diffs, forbidden paths, and acceptance commands.
- Do not let Codex become the implementation worker unless the user explicitly leaves Agent Orch mode for that task.
- AGY write work produces the same isolated worktree + patch + verification evidence as CC. Apply and cleanup work identically.
- Quota fallback from AGY to CC only triggers for explicit quota/credit/rate-exhaustion errors. Auth, permission, and internal errors are NOT silently swallowed.

## License

MIT
