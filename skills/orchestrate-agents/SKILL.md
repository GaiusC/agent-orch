---
name: orchestrate-agents
description: Use the Agent Orch MCP-driven workflow to plan and supervise multi-agent software work with CC Codex and AGY providers. Use for project initialization, partially built projects, bug fixes, refactors, test repair, UI verification, long-running engineering tasks, and Codex-coordinated multi-agent orchestration. Worker and reviewer operations are only available through MCP tools.
---

# Orchestrate Agents

Use Agent Orch as a platform-neutral MCP-driven orchestration runtime. Worker implementation, reviewer investigation, verification, and job control are only available through MCP tools. The CLI handles project lifecycle (init, resume, health), dashboard, and MCP configuration maintenance (mcp status, mcp install, mcp repair, mcp remove).

In a Codex-hosted session, keep the current Codex session responsible for planning, scope, routing, acceptance, and user communication. Do not invoke Codex CLI from inside Codex for planner or accepter work; those roles are in-session. Codex is the orchestrator/accepter, not the implementation worker: do not edit project code, tests, schemas, migrations, build files, or deployment files directly while this skill is in use unless the user explicitly cancels Agent Orch for that task.

Read [role-boundaries-and-workflow.md](references/role-boundaries-and-workflow.md) before planning substantial work, when the user asks about Agent Orch policy, or when role ownership is ambiguous.

## Prepare the project

1. Read applicable `AGENTS.md`, `CLAUDE.md`, and project rules.
2. Resume project state before deciding what to do:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 resume -ProjectDir <project> -HostProvider codex
```

3. If `.agent-orchestrator/config.json` is missing, initialize the project:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 init -ProjectDir <project>
```

4. For a partially built project, add `-ExistingProject`.
5. Ensure the project continuity docs exist: `.agent-orchestrator/PROJECT.md`, `.agent-orchestrator/TODO.md`, `.agent-orchestrator/HANDOFF.md`, plus generated state files `.agent-orchestrator/current-state.json` and `.agent-orchestrator/handoff.generated.md`.
6. For a new project or early project framing, use the installed `grill-me` skill before launching implementation workers when the goal, users, scope, architecture, or definition of done is still fluid. Record the resulting decisions in `PROJECT.md`, convert the work into contracts in `TODO.md`, and initialize `HANDOFF.md` with the current state.
7. Ensure `trusted` is true only after reviewing the repository config.
8. Ensure `verification.commands` covers the requested outcome.
9. For CC Desktop hosts, run `agent-orch mcp install` to enable the MCP server. Codex hosts use MCP tools directly (MCP is auto-configured).
10. Read [project-configuration.md](references/project-configuration.md) when creating or changing config.

## Host and provider switching

Agent Orch must be resumed with the current host before routing work. Use `-HostProvider codex` for Codex Desktop/CLI, `-HostProvider cc_desktop` or `claude_desktop` for Claude-hosted control, and `-HostProvider terminal` for shell-driven control.

Each host has a specific set of MCP tools it is permitted to use via the shared policy module:

- **Codex**: planner-plan, cc-exec, cc-continue, agy-exec, agy-continue, auto, reviewer-investigate, reviewer-verify, accepter-accept, status, result, cancel, apply, cleanup, health. Codex uses planner-plan only to persist the contract it produced in the current session; this does not invoke an external planner. Codex must NOT self-invoke via codex-exec/codex-continue.
- **CC Desktop**: health, codex-exec, codex-continue, planner-plan, status, result, cleanup, cancel. CC Desktop must NOT launch workers, reviewers, auto, or apply.
- **Terminal**: health, status, result, cleanup, cancel (minimum maintenance set).

For platform or provider changes, inspect and update `.agent-orchestrator/config.json` explicitly:

- `host.provider` and `host.in_session_roles`: which platform is currently coordinating and which roles it performs in-session.
- `mcp.enabled`: single project-level gate for MCP tool access. Set to true to enable MCP tools; only health is available when disabled.
- `providers.codex`, `providers.cc`, and `providers.agy`: which provider can act as planner, executor, reviewer, accepter, or coordinator.
- `roles.primary_writer`, `roles.specialist`, and `roles.duplicate_implementation`: implementation ownership and duplicate-work policy.
- `routing.auto`: automatic executor routing policy.
- `models.cc`, `models.agy`, and `models.agy_write`: provider-specific model names.

When the host is Codex, do not invoke Codex CLI for planner/accepter work; planning and acceptance stay in the current session. When the host is not Codex, only invoke an external Codex planner/accepter if `providers.codex.external_invocation` permits it for that host and the exact Codex CLI model/reasoning settings have been verified.

## Plan before delegating

Start with a Codex-owned plan. For non-trivial work, split the goal into small, durable contracts before launching workers. Each contract should be independently reviewable, have narrow writable paths, and produce evidence that can survive session rollover.

Before delegating substantial work, read `.agent-orchestrator/current-state.json`, `.agent-orchestrator/handoff.generated.md`, `.agent-orchestrator/PROJECT.md`, `.agent-orchestrator/TODO.md`, and `.agent-orchestrator/HANDOFF.md`. Treat generated state as the machine fact source and Markdown docs as human context.

Create one contract per work unit with:

- stable `task_id`;
- concrete goal and approved plan;
- writable and forbidden paths;
- public API, dependency, data, and security boundaries;
- acceptance commands;
- expected reviewer gate, when verification needs independent evidence;
- complexity and optional model override.

Make architecture, dependency, schema, security, and scope decisions in Codex. Let the implementation worker handle code edits, tests, mechanical debugging, and local implementation choices inside the contract. Codex may read files, inspect diffs, run deterministic verification, and write orchestration or handoff documentation, but must not become the project patch author.

## Route work with MCP tools

Worker implementation, reviewer, and job-control operations are ONLY available through MCP tools — the CLI no longer supports these commands. Use the MCP tools directly from your host:

### MCP tool reference

| Tool | Hosts | Description |
| --- | --- | --- |
| `health` | all | Check CLI availability and project trust/mcp configuration |
| `cc-exec` | codex | Delegate implementation to Claude Code in isolated worktree |
| `cc-continue` | codex | Continue an existing CC session with repair feedback |
| `agy-exec` | codex | Delegate implementation to AGY as primary writer |
| `agy-continue` | codex | Continue an existing AGY write session |
| `auto` | codex | Auto-route implementation (CC-first with AGY escalation) |
| `reviewer-investigate` | codex | Read-only specialist investigation via AGY |
| `reviewer-verify` | codex | Read-only review/verification via AGY |
| `codex-exec` | cc_desktop | External Codex planner/accepter (NOT for codex hosts) |
| `codex-continue` | cc_desktop | Continue external Codex session |
| `planner-plan` | codex, cc_desktop | Persist the fixed Planner contract; for a Codex host this records the current in-session plan without invoking Codex CLI |
| `status` | all* | Compact job status, including `progress` with at most two newest assistant-only messages (no tool calls, no raw logs). Use `result` for full evidence. |
| `result` | all* | Job result/evidence |
| `cancel` | all* | Cancel running job |
| `apply` | codex | Apply accepted patch to project |
| `cleanup` | all* | Remove worktree and clear session |

*Subject to host allow-list and trust gate.

### PowerShell usage

- Dashboard operations are CLI-driven:
  `powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 dashboard -ProjectDir <project>`
  `powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 dashboard-close -ProjectDir <project>`
- MCP configuration maintenance:
  `powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 mcp status -ProjectDir <project>`
  `powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 mcp install -ProjectDir <project>`
  `powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 mcp repair -ProjectDir <project>`
  `powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 mcp remove -ProjectDir <project>`

Do not ask CC and AGY to implement the same solution. AGY write is a primary writer, not a duplicate. Use `reviewer-investigate` and `reviewer-verify` as real workflow gates for high-risk, user-facing, remote-runtime, database, authentication, migration, security, or ambiguous behavior changes. If the reviewer provider is unavailable, report the missing gate and either reduce scope to low-risk deterministic checks or ask the user before accepting higher-risk work.

Read [routing-and-sessions.md](references/routing-and-sessions.md) for session rollover, model escalation, CC-first auto routing, CC-to-AGY escalation on verify failure, and quota fallback.

## Accept or reject

Treat worker prose as a claim, not proof. Verify:

- changed files match approved scope;
- forbidden paths are untouched;
- diff implements the approved plan without hidden redesign;
- deterministic commands passed;
- required reviewer gate passed or was explicitly waived;
- review-gate status is visible in the dashboard: apply requires reviewer evidence or an explicit `review_waiver` for implementation jobs;
- unresolved risks are acceptable;
- evidence corresponds to the current Git baseline.

If rejected, send delta feedback through the same `task_id` continuation tool; do not start a duplicate implementation. If accepted, apply the patch with `apply`, inspect the applied diff, then run `cleanup`.

After every accepted contract or abandoned job, update `.agent-orchestrator/HANDOFF.md` and `.agent-orchestrator/TODO.md` with completed work, remaining contracts, job IDs, evidence paths, failed or waived gates, and the next recommended action.

Report the plan, delegated work, verification evidence, deviations, remaining risks, selected models, route evidence (including any quota fallback), generated handoff state, and session continuity to the user.
