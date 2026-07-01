---
name: orchestrate-agents
description: Use the local Agent Orch CLI workflow to plan and supervise software work by delegating implementation to Claude Code CLI and targeted investigation or verification to Antigravity CLI while Codex retains final acceptance. Use for project initialization, partially built projects, bug fixes, refactors, test repair, UI verification, long-running engineering tasks, explicit CC-as-primary-writer workflows, AGY-as-specialist verification, session control, and reduced Codex implementation usage.
---

# Orchestrate Agents

Keep Codex responsible for planning, scope, routing, acceptance, and user communication. Use the Agent Orch CLI runner; do not rely on MCP tools unless the user explicitly asks for the legacy MCP path.

## Prepare the project

1. Read applicable `AGENTS.md`, `CLAUDE.md`, and project rules.
2. If `.agent-orchestrator/config.json` is missing, initialize the project:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 init -ProjectDir <project>
```

3. For a partially built project, add `-ExistingProject`.
4. Ensure `trusted` is true only after reviewing the repository config.
5. Ensure `verification.commands` covers the requested outcome.
6. Read [project-configuration.md](references/project-configuration.md) when creating or changing config.

## Plan before delegating

Create one implementation contract with:

- stable `task_id`;
- concrete goal and approved plan;
- writable and forbidden paths;
- public API, dependency, data, and security boundaries;
- acceptance commands;
- complexity and optional model override.

Make architecture, dependency, schema, security, and scope decisions in Codex. Let CC handle code edits, tests, mechanical debugging, and local implementation choices inside the contract.

## Route work with CLI

- Health check:
  `powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 health -ProjectDir <project>`
- First implementation:
  `... agent-orch.ps1 cc-exec -ProjectDir <project> -Contract <contract-json-or-file>`
- Same-goal feedback:
  `... agent-orch.ps1 cc-continue -ProjectDir <project> -Contract <contract-json-or-file>`
- AGY investigation:
  `... agent-orch.ps1 agy-investigate -ProjectDir <project> -Contract <contract-json-or-file>`
- AGY verification:
  `... agent-orch.ps1 agy-verify -ProjectDir <project> -Contract <contract-json-or-file>`
- Result/apply/cleanup:
  `... agent-orch.ps1 result|apply|cleanup -ProjectDir <project> -JobId <job-id>`

Do not ask CC and AGY to implement the same solution. AGY is a specialist/verifier, not a duplicate writer. Do not write the implementation in Codex unless the user explicitly requests it or the worker path is unavailable and the user accepts the fallback.

Read [routing-and-sessions.md](references/routing-and-sessions.md) for session rollover, model escalation, and failure routing.

## Accept or reject

Treat worker prose as a claim, not proof. Verify:

- changed files match approved scope;
- forbidden paths are untouched;
- diff implements the approved plan without hidden redesign;
- deterministic commands passed;
- unresolved risks are acceptable;
- evidence corresponds to the current Git baseline.

If rejected, send delta feedback through `cc-continue` with the same `task_id`; do not start a duplicate implementation. If accepted, apply the patch with `apply`, inspect the applied diff, then run `cleanup`.

Report the plan, delegated work, verification evidence, deviations, remaining risks, selected models, and session continuity to the user.
