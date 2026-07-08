---
name: orchestrate-agents
description: Use the local Agent Orch CLI workflow to plan and supervise software work by delegating implementation to Claude Code CLI or Antigravity CLI with automatic routing, while Codex retains final acceptance. Use for project initialization, partially built projects, bug fixes, refactors, test repair, UI verification, long-running engineering tasks, CC-as-primary-writer or AGY-as-primary-writer workflows, AGY-as-specialist verification, session control, and reduced Codex implementation usage.
---

# Orchestrate Agents

Use Agent Orch as a platform-neutral local orchestration runtime. In a Codex-hosted session, keep the current Codex session responsible for planning, scope, routing, acceptance, and user communication. Do not invoke Codex CLI from inside Codex for planner or accepter work; those roles are in-session. Codex is the orchestrator/accepter, not the implementation worker: do not edit project code, tests, schemas, migrations, build files, or deployment files directly while this skill is in use unless the user explicitly cancels Agent Orch for that task. Use the Agent Orch CLI runner for worker, state, dashboard, and resume operations; do not rely on MCP tools unless the user explicitly asks for the legacy MCP path.

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
9. Read [project-configuration.md](references/project-configuration.md) when creating or changing config.

## Plan before delegating

Start with a Codex-owned plan. For non-trivial work, split the goal into small, durable contracts before launching workers. Each contract should be independently reviewable, have narrow writable paths, and produce evidence that can survive session rollover.

Before delegating substantial work, read `.agent-orchestrator/current-state.json`, `.agent-orchestrator/handoff.generated.md`, `.agent-orchestrator/PROJECT.md`, `.agent-orchestrator/TODO.md`, and `.agent-orchestrator/HANDOFF.md`. Treat generated state as the machine fact source and Markdown docs as human context.

Create one contract per work unit with:

- stable `task_id`;
- concrete goal and approved plan;
- writable and forbidden paths;
- public API, dependency, data, and security boundaries;
- acceptance commands;
- expected AGY gate, when verification needs independent evidence;
- complexity and optional model override.

Make architecture, dependency, schema, security, and scope decisions in Codex. Let the implementation worker handle code edits, tests, mechanical debugging, and local implementation choices inside the contract. Codex may read files, inspect diffs, run deterministic verification, and write orchestration or handoff documentation, but must not become the project patch author.

## Route work with CLI

- Health check:
  `powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 health -ProjectDir <project>`
- Resume project state:
  `... agent-orch.ps1 resume -ProjectDir <project> -HostProvider codex`
- Dashboard:
  `... agent-orch.ps1 dashboard -ProjectDir <project>`
- Automatic routing (recommended for most implementation):
  `... agent-orch.ps1 auto -ProjectDir <project> -Contract <contract-json-or-file>`
- CC implementation:
  `... agent-orch.ps1 cc-exec -ProjectDir <project> -Contract <contract-json-or-file>`
- CC continuation:
  `... agent-orch.ps1 cc-continue -ProjectDir <project> -Contract <contract-json-or-file>`
- AGY write implementation:
  `... agent-orch.ps1 agy-exec -ProjectDir <project> -Contract <contract-json-or-file>`
- AGY write continuation:
  `... agent-orch.ps1 agy-continue -ProjectDir <project> -Contract <contract-json-or-file>`
- AGY investigation:
  `... agent-orch.ps1 agy-investigate -ProjectDir <project> -Contract <contract-json-or-file>`
- AGY verification:
  `... agent-orch.ps1 agy-verify -ProjectDir <project> -Contract <contract-json-or-file>`
- Result/apply/cleanup:
  `... agent-orch.ps1 result|apply|cleanup -ProjectDir <project> -JobId <job-id>`

Do not ask CC and AGY to implement the same solution. AGY write is a primary writer, not a duplicate. Use AGY investigation/verify as a real workflow gate for high-risk, user-facing, remote-runtime, database, authentication, migration, security, or ambiguous behavior changes. If AGY is unavailable, report the missing gate and either reduce scope to low-risk deterministic checks or ask the user before accepting higher-risk work.

Read [routing-and-sessions.md](references/routing-and-sessions.md) for session rollover, model escalation, failure routing, and quota fallback.

## Accept or reject

Treat worker prose as a claim, not proof. Verify:

- changed files match approved scope;
- forbidden paths are untouched;
- diff implements the approved plan without hidden redesign;
- deterministic commands passed;
- required AGY gate passed or was explicitly waived;
- unresolved risks are acceptable;
- evidence corresponds to the current Git baseline.

If rejected, send delta feedback through the same `task_id` continuation command; do not start a duplicate implementation. If accepted, apply the patch with `apply`, inspect the applied diff, then run `cleanup`.

After every accepted contract or abandoned job, update `.agent-orchestrator/HANDOFF.md` and `.agent-orchestrator/TODO.md` with completed work, remaining contracts, job IDs, evidence paths, failed or waived gates, and the next recommended action.

Report the plan, delegated work, verification evidence, deviations, remaining risks, selected models, route evidence (including any quota fallback), generated handoff state, and session continuity to the user.
