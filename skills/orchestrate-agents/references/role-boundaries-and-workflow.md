# Role boundaries and workflow

Agent Orch is a sustained multi-agent workflow, not a convenience wrapper for occasional verification. The default policy uses Codex for planning and final acceptance, CC or AGY write for implementation, and AGY for independent investigation and verification. In multi-platform use, the current host is the coordinator, while planner/executor/reviewer/accepter are explicit roles recorded in Agent Orch state.

Worker implementation, reviewer, and job-control operations are only available through MCP tools. The CLI handles project lifecycle (init, resume, health), dashboard, and MCP configuration maintenance (mcp status, mcp install, mcp repair, mcp remove).

Read [agent-orch-protocol.md](agent-orch-protocol.md) before changing host/provider behavior.

## Hard role boundaries

### Codex should

- When Codex is the current host, read project rules, inspect existing architecture, and form the initial plan in the current Codex session before worker launch.
- Split broad work into small contracts with stable `task_id` values, narrow writable paths, forbidden paths, acceptance commands, and rollback or risk notes.
- Decide architecture, dependency, schema, data, security, deployment, and scope boundaries before delegating.
- Route implementation and repair through MCP tools: `auto` (recommended), `cc-exec`/`cc-continue`, or `agy-exec`/`agy-continue`.
- Route independent investigation or verification through `reviewer-investigate` or `reviewer-verify`.
- Inspect patches, worker logs, verification output, and AGY findings before accepting.
- Write or update orchestration-only artifacts, including `.agent-orchestrator/config.json`, `.agent-orchestrator/PROJECT.md`, `.agent-orchestrator/TODO.md`, `.agent-orchestrator/HANDOFF.md`, handoff notes, contracts, and status documentation.
- Tell the user which gates passed, which were waived, route evidence (including quota fallback), and what risk remains.

### Codex should not

- Invoke Codex CLI or a second Codex worker for planner/accepter work when the current host is already Codex.
- Use MCP tools `codex-exec`, `codex-continue`, or `planner-plan` — these are blocked for codex hosts by the policy module.
- Modify project code, tests, migrations, schemas, build files, application configuration, deployment files, or production-facing scripts while this skill is active.
- Use itself as the fallback implementation worker after a worker fails. If workers are unavailable, report the blocker and ask whether to leave Agent Orch mode.
- Start coding before creating a plan and at least one explicit contract.
- Accept worker prose without inspecting the actual diff and current-baseline evidence.
- Silently bypass reviewer evidence when a contract marked a reviewer gate as required.
- Commit, push, deploy, rotate credentials, or mutate remote systems as part of acceptance unless the user made that an explicit separate request.

### CC Desktop host should

- Use the MCP tools allowed for cc_desktop: `health`, `codex-exec`, `codex-continue`, `planner-plan`, `status`, `result`, `cancel`, `cleanup`.
- Coordinate CC sessions and delegate planning/acceptance to Codex externally.
- Run `agent-orch mcp install` to enable MCP configuration.

### CC Desktop host should not

- Use worker MCP tools (`cc-exec`, `agy-exec`, `auto`) — these are blocked by policy.
- Use `apply` — patching is reserved for Codex acceptance.
- Launch reviewers or verify through MCP.

### Terminal host should

- Use minimum maintenance MCP tools: `health`, `status`, `result`, `cancel`, `cleanup`.
- Run `agent-orch resume` to rebuild state before making decisions.

### CC (implementation worker) should

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

### AGY (investigation/verification specialist) should

- Investigate uncertain behavior, runtime failures, environment issues, UI/browser behavior, authentication boundaries, database integration assumptions, and remote deployment evidence.
- Verify non-trivial worker output from a separate perspective, with concrete evidence and failure reproduction when possible.
- Stay read-only for ordinary investigation and verification.
- State whether the contract should be accepted, rejected, or accepted with named residual risks.

### AGY should not

- Act as a second implementation writer for the same contract.
- Modify project files unless Codex created an explicit disjoint-write contract or the auto router selected AGY write as the primary writer.
- Rubber-stamp worker output without checking scope, behavior, and evidence.
- Perform destructive remote actions, deploy, rotate credentials, or mutate production systems.

### AGY write (implementation worker) should

- Implement the approved contract as the primary writer.
- Modify only writable paths and respect forbidden paths.
- Work in an isolated worktree (same as CC), producing a patch for Codex acceptance.
- Add or update tests that directly support the contract.
- Run the listed acceptance commands or explain exactly why a command could not run.
- Continue the same `task_id` for deterministic repair feedback.
- Report changed files, commands, test results, deviations, and unresolved risks.

### AGY write should not

- Redesign architecture, change dependencies, alter schemas, add migrations, change public APIs, or expand scope without returning the decision to Codex.
- Touch secrets, credentials, remote resources, production data, `.git/`, `.agent-orchestrator/state/`, or `.agent-orchestrator/runs/`.
- Commit, push, publish, deploy, rotate credentials, or operate remote systems.
- Hand off implementation to CC or ask CC to duplicate the same patch.

## Sustainable contract flow

1. The current host runs `agent-orch resume -ProjectDir <project> -HostProvider <host>`.
2. The planner reads project rules, generated state, and continuity docs; for a new or fluid project, use `grill-me` before turning decisions into contracts.
3. The planner writes a brief plan with ordered contracts.
4. The coordinator launches the implementation worker via MCP tools (`auto`, `cc-exec`, or `agy-exec`).
5. The accepter inspects worker evidence and diff.
6. The coordinator launches AGY for required investigation or verification gates via MCP.
7. The accepter accepts, rejects, or sends same-session delta feedback to the worker.
8. The coordinator applies only accepted patches (via `apply` MCP tool), then records/generated handoff state and remaining contracts.

Keep contracts small enough that a future agent can resume from the contract, run directory, and handoff note without reconstructing the whole conversation.

## Parallel execution policy

- Multiple CC workers may run in parallel for read-only contracts or clearly disjoint writable paths. Codex must still inspect each patch independently before applying anything.
- One AGY write worker should be allocated whenever multiple disjoint contracts run in parallel.
- Do not run two workers (CC or AGY write) against overlapping writable paths unless the user explicitly accepts merge conflict risk and Codex has a merge plan.
- Retain at most one concurrent AGY write worker by default on this machine.
- Run at most one AGY investigation/verification worker at a time unless the local AGY installation has passed a current multi-AGY smoke test.
- A local smoke test on 2026-07-04 found two concurrent CC jobs completed with isolated sessions, one of two concurrent AGY jobs completed, the other AGY job timed out after token/auth errors, and a later sequential AGY job completed. Treat AGY as serial by default in this environment.
- CC and one AGY investigation/verification can run in parallel when AGY is doing independent read-only work that does not gate CC's initial implementation choices.

## MCP policy enforcement

The shared core policy module (`scripts/lib/policy.mjs`) enforces host identity, tool allow-lists, and trust decisions at the MCP server level before any lower-layer orchestration:

- **Host identity**: normalized from config (`codex`, `cc_desktop`, `claude_desktop`, `terminal`, `unknown`).
- **MCP gate**: `mcp.enabled` must be true for all MCP tools except `health`.
- **Trust gate**: when `trusted` is false, only safe diagnostic tools are allowed (`health`, `status`, `result`, `cleanup`, `cancel`).
- **Host tool allow-lists**: each host has an explicit list of permitted MCP tools.

Denials return structured details with `reason`, `detail`, `host`, and `tool` fields.

## Reviewer gate guidance

Require a reviewer gate when a change affects:

- user-visible behavior or UI flows;
- database connection, schema, migration, or data integrity;
- authentication, authorization, secrets, or tenant boundaries;
- deployment, Docker, process supervision, networking, or remote runtime behavior;
- external APIs, webhooks, queues, or background workers;
- ambiguous bugs where reproduction matters more than patch size.

AGY may be optional for small documentation-only, formatting-only, or deterministic low-risk changes when Codex can verify the full outcome locally.

If AGY cannot run because of auth or sandbox limitations, record the limitation in the final report. Do not present the missing gate as completed.

## Provider-aware calibration

Ordinary work estimated as CC-high may generally be treated as AGY-medium with Claude Sonnet 4.6 (Thinking). Reserve AGY-high with Claude Opus 4.6 (Thinking) for exceptional complexity or risk:

- multi-service coordination or cross-cutting changes;
- security-critical implementation;
- complex algorithm or data-structure work;
- migration-heavy changes with multiple data paths;
- work the user explicitly classifies as high.

This calibration means the routing model ladder shifts: what would be CC-medium or CC-high in the old model often fits AGY-medium/Sonnet; AGY-high/Opus is reserved for genuinely exceptional work.
