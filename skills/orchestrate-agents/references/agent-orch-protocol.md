# Agent Orch protocol

## Lifecycle

```text
stage-plan -> stage-work -> stage-review -> stage-accept -> apply -> cleanup
                   |
                   +-> stage-work-continue
```

`stage-plan` creates the formal contract and immutable Plan execution identity. Work and review stages create durable StageRuns linked to asynchronous jobs. A StageRun remains `running` until its linked job is terminal.

## Identity

Plan identity contains:

- task and contract identity;
- provider and model;
- invocation mode;
- planner/accepter session id;
- contract digest.

Acceptance must match every identity field and must call the formal acceptance kernel.

## Process and session durability

Persist provider PID, cwd, model, worktree, and session id. CC session identity is known before spawn. AGY and Codex Worker session identities are persisted as soon as they are emitted.

After MCP restart:

- a live PID means `external_process_alive`;
- an in-process managed promise means `managed_in_process`;
- a non-terminal job with neither is `interrupted`, not automatically failed.

All job-control calls should include `project_dir`.

## Failure classes

Retryable route fallback:

- executable unavailable;
- timeout;
- quota/rate exhaustion;
- transient connection or service unavailability.

Fail closed without fallback:

- OAuth/authentication;
- permission, sandbox, or read-only mismatch;
- forbidden or unauthorized path changes;
- missing continuation session/worktree;
- Plan/acceptance identity mismatch.
