# Role boundaries and workflow

Agent Orch is a sustained multi-agent workflow, not a convenience wrapper for occasional verification. Codex owns orchestration and final acceptance; CC owns implementation; AGY owns independent investigation and verification.

## Hard role boundaries

### Codex should

- Read project rules, inspect existing architecture, and form the initial plan before worker launch.
- Split broad work into small contracts with stable `task_id` values, narrow writable paths, forbidden paths, acceptance commands, and rollback or risk notes.
- Decide architecture, dependency, schema, data, security, deployment, and scope boundaries before delegating.
- Route implementation and repair to CC through `cc-exec` and same-task `cc-continue`.
- Route independent investigation or verification to AGY through `agy-investigate` or `agy-verify`.
- Inspect patches, worker logs, verification output, and AGY findings before accepting.
- Write or update orchestration-only artifacts when useful, such as `.agent-orchestrator/config.json`, handoff notes, contracts, and status documentation.
- Tell the user which gates passed, which were waived, and what risk remains.

### Codex should not

- Modify project code, tests, migrations, schemas, build files, application configuration, deployment files, or production-facing scripts while this skill is active.
- Use itself as the fallback implementation worker after CC or AGY fails. If workers are unavailable, report the blocker and ask whether to leave Agent Orch mode.
- Start coding before creating a plan and at least one explicit contract.
- Accept worker prose without inspecting the actual diff and current-baseline evidence.
- Silently bypass AGY when a contract marked an AGY gate as required.
- Commit, push, deploy, rotate credentials, or mutate remote systems as part of acceptance unless the user made that an explicit separate request.

### CC should

- Implement only the approved contract.
- Modify only writable paths and respect forbidden paths.
- Add or update tests that directly support the contract.
- Run the listed acceptance commands or explain exactly why a command could not run.
- Continue the same `task_id` for deterministic repair feedback.
- Report changed files, commands, test results, deviations, and unresolved risks.

### CC should not

- Redesign architecture, change dependencies, alter schemas, add migrations, change public APIs, or expand scope without returning the decision to Codex.
- Touch secrets, credentials, remote resources, production data, `.git/`, `.agent-orchestrator/state/`, or `.agent-orchestrator/runs/`.
- Commit, push, publish, deploy, rotate credentials, or operate remote systems.
- Hand off implementation to AGY or ask AGY to duplicate the same patch.

### AGY should

- Investigate uncertain behavior, runtime failures, environment issues, UI/browser behavior, authentication boundaries, database integration assumptions, and remote deployment evidence.
- Verify non-trivial CC output from a separate perspective, with concrete evidence and failure reproduction when possible.
- Stay read-only for ordinary investigation and verification.
- State whether the contract should be accepted, rejected, or accepted with named residual risks.

### AGY should not

- Act as a second implementation writer for the same contract.
- Modify project files unless Codex created an explicit disjoint-write contract.
- Rubber-stamp CC output without checking scope, behavior, and evidence.
- Perform destructive remote actions, deploy, rotate credentials, or mutate production systems.

## Sustainable contract flow

1. Codex reads project rules and current state.
2. Codex writes a brief plan with ordered contracts.
3. Codex launches CC for the first implementation contract.
4. Codex inspects CC evidence and diff.
5. Codex launches AGY for required investigation or verification gates.
6. Codex accepts, rejects, or sends same-session delta feedback to CC.
7. Codex applies only accepted patches, then records handoff status and remaining contracts.

Keep contracts small enough that a future agent can resume from the contract, run directory, and handoff note without reconstructing the whole conversation.

## Parallel execution policy

- Multiple CC workers may run in parallel for read-only contracts or clearly disjoint writable paths. Codex must still inspect each patch independently before applying anything.
- Do not run two CC workers against overlapping writable paths unless the user explicitly accepts merge conflict risk and Codex has a merge plan.
- Run at most one AGY worker at a time unless the local AGY installation has passed a current multi-AGY smoke test.
- A local smoke test on 2026-07-04 found two concurrent CC jobs completed with isolated sessions, one of two concurrent AGY jobs completed, the other AGY job timed out after token/auth errors, and a later sequential AGY job completed. Treat AGY as serial by default in this environment.
- CC and one AGY can run in parallel when AGY is doing independent read-only investigation or verification that does not gate CC's initial implementation choices.

## AGY gate guidance

Require an AGY gate when a change affects:

- user-visible behavior or UI flows;
- database connection, schema, migration, or data integrity;
- authentication, authorization, secrets, or tenant boundaries;
- deployment, Docker, process supervision, networking, or remote runtime behavior;
- external APIs, webhooks, queues, or background workers;
- ambiguous bugs where reproduction matters more than patch size.

AGY may be optional for small documentation-only, formatting-only, or deterministic low-risk changes when Codex can verify the full outcome locally.

If AGY cannot run because of auth or sandbox limitations, record the limitation in the final report. Do not present the missing gate as completed.
