---
name: orchestrate-agents
description: Use the Agent Orch stage-first MCP workflow to plan and supervise software work with CC, AGY, and Codex Worker providers. Use for project initialization, partially built projects, bug fixes, refactors, test repair, independent review, long-running tasks, and durable continuation.
---

# Orchestrate Agents

Use Agent Orch as a Codex-standard, stage-first plugin. The CLI manages project lifecycle; all planning persistence, provider work, formal review, acceptance, and job control occur through MCP.

When Codex is the host, keep planning and acceptance in the current Codex task. Do not invoke Codex CLI as an external planner/accepter. Codex Worker is a distinct work-stage provider and may edit only inside its isolated worktree.

Read [role-boundaries-and-workflow.md](references/role-boundaries-and-workflow.md) when ownership or acceptance responsibility is unclear.

## Require an MCP-capable host model

Before using the stage workflow, require a Codex host model that exposes local MCP tools. `gpt-5.6-terra` is the default and has been verified with Agent Orch. `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.6-sol` are also verified.

## Prepare

1. Read project `AGENTS.md`, `CLAUDE.md`, and local rules.
2. Run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 resume -ProjectDir <project> -HostProvider codex
   ```

3. If uninitialized, run `init` first.
4. Review `.agent-orchestrator/config.json`; require `version: 2`, `trusted: true`, `mcp.enabled: true`, and an MCP-capable Codex Plan route.
5. Confirm continuity documents and `verification.commands`.
6. Treat `.agent-orchestrator/runtime-env.json` as the durable provider environment snapshot. If AGY requests OAuth, resume from the shell whose proxy/runtime environment makes `agy --print` work.

## Use the stage contract

The default MCP workflow is:

1. `stage-plan`
2. `stage-work`
3. `wait-for-job`, `status`, and `result`
4. `stage-work-continue` when focused repair is needed
5. `stage-review` when the contract requires independent evidence
6. `stage-accept`
7. `apply`
8. `cleanup`

Do not route by calling provider-specific wrappers. They are hidden by default and exist only for explicitly enabled diagnostics.

### Plan

Call `stage-plan` with a stable `task_id`, the current Planner contract, and a stable identifier for the current Codex planning/acceptance task. The runtime persists an immutable Plan execution identity containing provider, model, invocation mode, session, contract id, and contract digest.

Contracts must define narrow executor subtasks with:

- `subtask_id`;
- objective and complexity;
- dependencies;
- writable and forbidden paths;
- deterministic tests;
- acceptance criteria;
- reviewer tasks where independent evidence is required.

The contract must not select a provider or model. Stage routing belongs to project configuration.

### Work

Call `stage-work` with `task_id` and `subtask_id`. The runtime resolves `stages.work.routes` and records the complete route chain.

Fallback is allowed only for classified retryable runtime failures. Authentication, OAuth, permission, sandbox, read-only, forbidden-path, and out-of-scope failures must be surfaced rather than hidden by rerouting.

Provider write guarantees:

- CC: isolated worktree, non-interactive `bypassPermissions`;
- AGY write: isolated worktree, explicit non-interactive write permission;
- Codex Worker: isolated worktree, `workspace-write`, approval policy `never`; on Windows, a recognized sandbox-helper startup failure may continue in the same thread using Codex's externally-isolated bypass mode, with the reason recorded in evidence.

### Continue

Use `stage-work-continue` only for the same task and prior work job. It must reuse the exact provider, model, session, and worktree. Never use it to change provider or restart an unrelated implementation.

If status reports `external_process_alive`, do not continue yet. If it reports `interrupted`, inspect preserved logs, session, PID, and worktree. Continue only when the exact session is present; otherwise fail closed and request an explicitly approved new work stage.

### Review

Use `stage-review` for the persisted `review_id`. Reviewer evidence must be read-only, patch-bound, contract-bound, and newer than the implementation it evaluates.

AGY review may run headless verification commands, but Agent Orch enforces read-only behavior by comparing the implementation patch digest before and after review. Formal review rejects conversation-store fallback text and requires `VERDICT: PASS`. An OAuth URL is a provider availability failure, not review evidence.

### Accept

Treat worker and reviewer prose as claims. Inspect the diff and deterministic evidence before calling `stage-accept`.

`stage-accept` must use the same Plan provider, model, invocation, and session identity recorded by `stage-plan`. It calls the formal acceptance kernel; it must not create a shortcut artifact or silently fall back.

After acceptance, call `apply`, inspect the applied diff, run final deterministic checks, then call `cleanup`.

## Durable state

Use explicit `project_dir` with job-control tools, especially after a task or MCP restart. Durable state includes:

- jobs and evidence under `.agent-orchestrator/runs/`;
- provider sessions under `.agent-orchestrator/state/sessions.json`;
- StageRuns under `.agent-orchestrator/stages/`;
- Plan execution identities under `.agent-orchestrator/plans/`;
- `events.jsonl`, `current-state.json`, and generated handoff;
- allowlisted provider environment in `runtime-env.json`.

An absent in-memory promise is not proof that a worker is dead. Status checks the persisted PID before classifying the run.

## Plugin updates

Develop in the source checkout, never in `.codex/plugins/cache`.

Before releasing:

1. run `npm test`;
2. validate the plugin manifest and skill;
3. bump the plugin cachebuster/version;
4. reinstall `agent-orch@personal`;
5. open a new Codex task;
6. use an MCP-capable host model and verify real calls to `health` and `stage-*`;
7. run real CC, AGY, and Codex Worker E2E tasks and an independent reviewer gate.

Existing Codex tasks do not automatically reload a changed plugin tool catalog.
