---
name: orchestrate-external-agents
description: Plan and supervise software work by delegating implementation to the local Claude Code CLI and targeted investigation or verification to the local Antigravity CLI while Codex retains final acceptance. Use for project changes, bug fixes, refactors, test repair, UI verification, or long-running engineering tasks where the user wants CC as primary writer, AGY as a non-duplicating specialist, explicit session/model control, and reduced Codex implementation usage.
---

# Orchestrate External Agents

Keep Codex responsible for planning, decision boundaries, acceptance, and user communication. Delegate code production to CC and use AGY only for targeted evidence or a strictly disjoint subtask.

## Prepare the project

1. Read the applicable `AGENTS.md`, `CLAUDE.md`, and AGY project instructions.
2. Require `.agent-orchestrator/config.json` with `"trusted": true` before launching workers.
3. Ensure acceptance commands cover the requested outcome. Never accept a coding job with no deterministic verification unless the user explicitly accepts that limitation.
4. Call `worker_health` before the first worker task in a project/session.
5. Read [project-configuration.md](references/project-configuration.md) when creating or changing project configuration.

## Plan before delegating

Create one implementation contract containing:

- stable `task_id` scoped to the project and goal;
- concrete goal and approved plan;
- writable and forbidden paths;
- public API, dependency, data, and security boundaries;
- acceptance commands and completion criteria;
- complexity level and optional model override.

Make architecture, dependency, schema, security, and scope decisions in Codex. Let CC handle code edits, tests, mechanical debugging, and local implementation choices inside the contract.

## Route work

- Use `cc_execute_task` for the first implementation attempt.
- Use `cc_continue_task` with the same `task_id` for incremental feedback on the same goal.
- Use `agy_investigate` for reproduction, environment diagnosis, documentation, or evidence gathering.
- Use `agy_verify` for browser, UI, runtime, compatibility, or environment verification.
- Use `agy_execute_disjoint_subtask` only when the subtask is provably non-overlapping and writing has been explicitly allowed.
- Do not ask CC and AGY to implement the same solution.
- Do not write the implementation in Codex unless the user explicitly requests it or the worker path is unavailable and the user accepts the fallback.

Read [routing-and-sessions.md](references/routing-and-sessions.md) for model escalation, session rollover, and failure routing.

## Manage asynchronous jobs

1. Record the returned `job_id`.
2. Use `worker_status` sparingly; avoid tight polling loops.
3. Use `worker_result` only after completion to retrieve the compact Evidence Pack.
4. Use `worker_cancel` when the goal changes or the job is stuck.
5. Inspect raw logs by path only when the Evidence Pack is insufficient.

The broker may continue the same CC session for deterministic test repair. Re-enter Codex when a fix requires plan, dependency, scope, public API, security, or data-model changes.

## Accept or reject

Treat worker prose as a claim, not proof. Verify:

- changed files match the approved scope;
- forbidden paths are untouched;
- diff implements the approved plan without hidden redesign;
- deterministic commands passed;
- unresolved risks are acceptable;
- the Evidence Pack corresponds to the current Git baseline.

If rejected, send delta feedback through `cc_continue_task`; do not start a duplicate implementation. If accepted, call `worker_apply_result`, inspect the applied diff, then call `worker_cleanup`.

Report the plan, delegated work, verification evidence, deviations, remaining risks, selected models, and session continuity to the user.
