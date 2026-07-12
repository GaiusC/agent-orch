# Agent Orch

Agent Orch is a local multi-agent orchestration runtime for supervising external coding agents through MCP tools. Codex is the default planner/accepter, Claude Code or Antigravity implements, and Antigravity provides targeted investigation or verification.

Agent Orch is designed to be resumable across hosts. Codex, Claude Desktop/Claude Code, and plain terminal workflows all resume from `.agent-orchestrator/` state before continuing a project. When the current host is Codex, planning and acceptance happen in the current Codex session; Agent Orch must not start Codex CLI just to plan or accept.

The default path:

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

### Review gate

Agent Orch enforces a review gate for implementation jobs by default. After a CC or AGY write implementation completes, the `apply` command requires one of:

- A completed reviewer verification job (`reviewer-verify`) for the same project and `task_id`, confirming the implementation evidence; or
- An explicit `review_waiver: true` set on the job contract metadata.

Configurable in `.agent-orchestrator/config.json`:

```json
{
  "review_gate": {
    "require_reviewer_for_implementation": true,
    "allow_waiver": true
  }
}
```

- Set `require_reviewer_for_implementation` to `false` to disable the gate entirely. Legacy `require_agy_verify_for_implementation: false` is still honored for older projects.
- Set `allow_waiver` to `false` to require reviewer evidence on every implementation apply - no exceptions.
- Reviewer `investigate` and `verify` jobs are exempt (they are read-only review work, not implementation).
- Review-gate status, blocked jobs, and explicit waivers are visible in the audit dashboard and in `current-state.json`.

### AGY proxy injection

Agent Orch can inject proxy environment variables into every AGY subprocess (`agy-exec`, `agy-continue`, `reviewer-investigate`, `reviewer-verify`) through the `cli.agy_env` configuration map. This works without modifying WinHTTP, without a wrapper script, and without requiring MCP callers to pass proxy fields.

The project template defaults `agy_env` to an empty object `{}`, disabling injection. Set `agy_env` to `{}` explicitly to confirm no proxy is needed.

Configure proxy values in `.agent-orchestrator/config.json` only if your environment requires them:

```json
{
  "cli": {
    "agy_env": {
      "HTTP_PROXY": "http://127.0.0.1:10100",
      "HTTPS_PROXY": "http://127.0.0.1:10100",
      "ALL_PROXY": "http://127.0.0.1:10100",
      "NO_PROXY": "localhost,127.0.0.1,::1"
    }
  }
}
```

The values shown (`http://127.0.0.1:10100`) are only a localhost example. Adjust host and port to match your actual proxy. The process environment is always preserved; explicit `agy_env` values override it.

### Audit dashboard views

> The `audit-orch` standalone skill is disabled in v0.4.0. The dashboard remains
> available through the CLI (`agent-orch dashboard`). Use the CLI to inspect job
> state, review-gate status, and run evidence.

The audit dashboard (launched via `agent-orch dashboard`) exposes role/provider/stage
views for every project:

- **Role lanes**: Planner (Codex or configured planner), Executor (CC/AGY write), Reviewer (configured reviewer, currently AGY-backed), Accepter/Coordinator.
- **Provider counts**: CC, AGY, AGY write, Codex.
- **Lifecycle stages**: plan, execute, review, repair, accept, cleanup.
- **Stale running jobs**: jobs running but with no recent update (15-minute threshold), flagged in project summary and handoff.
- **Fallback/escalation chains**: jobs that triggered quota fallback or CC-to-AGY escalation, with chain evidence.
- **Review-gate status**: jobs blocked by the review gate (ready for acceptance but missing reviewer evidence).

Dashboard data is read-only and served from `.agent-orchestrator/runs/` and `current-state.json`.

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

In any host, resume project state first:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 resume -ProjectDir <project> -HostProvider codex
```

Use `-HostProvider cc_desktop` from Claude/CC Desktop hosts and `-HostProvider terminal` from a plain shell.

In a Codex session for a configured project, use MCP tools to route work:

- Delegate implementation via `auto`, `cc-exec`/`cc-continue`, or `agy-exec`/`agy-continue`.
- Route verification or investigation through `reviewer-verify` or `reviewer-investigate`.
- Inspect job evidence with `status` (compact snapshot with bounded assistant-only progress) and `result` (full evidence pack).
- Apply an accepted patch with `apply`, then clean up with `cleanup`.

Codex should inspect evidence under `.agent-orchestrator\runs` before accepting, request same-session repair via continuation tools if needed, and apply the patch only after verification.

Open the dashboard without talking to an agent:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 dashboard -ProjectDir <project>
```

For substantial work, Codex should first split the goal into small contracts, route implementation contracts via `auto` (which handles provider and model selection), route required investigation or verification gates through `reviewer-investigate` or `reviewer-verify`, and record any waived gate or residual risk for the user.

## CLI Commands

The CLI handles project lifecycle, dashboard, and MCP configuration maintenance. Worker implementation, reviewer, and job-control operations are only available through MCP tools.

```
agent-orch init              -ProjectDir <project> [-ExistingProject] [-HostProvider codex|cc_desktop|terminal]
agent-orch health            -ProjectDir <project>
agent-orch resume            -ProjectDir <project> [-HostProvider codex|cc_desktop|terminal|unknown]
agent-orch dashboard         -ProjectDir <project> [-PreferredPort 15788]
agent-orch dashboard-close   -ProjectDir <project> [-PreferredPort 15788]
agent-orch mcp status        -ProjectDir <project>
agent-orch mcp install       -ProjectDir <project>
agent-orch mcp repair        -ProjectDir <project>
agent-orch mcp remove        -ProjectDir <project>
```

Worker, reviewer, and job-control commands (auto, cc-exec, cc-continue, agy-exec, agy-continue, reviewer-investigate, reviewer-verify, planner-plan, status, result, apply, cleanup) return an explicit MCP-only error if called from the CLI. Run `agent-orch mcp install` to set up the MCP server for a project.

### Host tool access

| Host | Available via MCP |
| --- | --- |
| Codex | cc-exec, cc-continue, agy-exec, agy-continue, auto, reviewer-investigate, reviewer-verify, status (includes bounded assistant-only progress), result, cancel, apply, cleanup, health |
| CC Desktop / Claude Desktop | health, codex-exec, codex-continue, planner-plan, status (includes bounded assistant-only progress), result, cancel, cleanup |
| Terminal | health, status (includes bounded assistant-only progress), result, cancel, cleanup |

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
