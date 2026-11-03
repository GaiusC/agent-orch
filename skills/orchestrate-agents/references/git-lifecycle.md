# Git lifecycle (0.7)

Normal work ends in a commit and a closeout receipt. Dirty inherited work is
audited before execution, not copied into an automatic clone. A clean status is
not proof that a directory is disposable. Uncommitted work may remain when it
has an explicit owner/disposition; report that residual truthfully.

## Configuration and initialization

`init` and `resume` return an environment audit index when Git has a baseline.
New projects can establish their initial commit through reviewed exact-path
reconciliation. No-model-selection responses still write no project files.
`--GitPolicyFile <json>` supplies the user's policy; terminal init offers the
commit-policy choice. Existing policy survives resume.

```json
{
  "commit_policy": "ask",
  "target_branch": null,
  "max_worker_worktrees": 2,
  "max_worktrees": 3,
  "max_workspace_bytes": null,
  "allow_snapshot": false,
  "allow_in_place": false
}
```

`auto` authorizes only local commits after acceptance and final verification.
`ask` requires concrete per-milestone authorization. `manual` records a user-made
commit through `stage-finalize.record_commit` and verifies its accepted file
states; it does not create another commit. Push/release/history rewriting are
separate permissions. `target_branch` restricts the delivery branch if set.

The total worktree limit excludes the canonical source directory and includes
registered external linked worktrees. A worker cap and one integration slot
prevent unlimited expansion. `execution.workspace_wait_timeout_seconds` defaults
to 1800; capacity waits are cancellable and send one attention report. They never
create clones or evict unfinished work. The byte budget checks current linked
directories plus the estimated tracked checkout size before allocation; it is
admission control, not an operating-system disk quota. Dependencies, data and
artifacts should use configured external locations; no writable hardlink sharing
is introduced.

## Audit and provenance

Call `environment-audit` with project_dir, a compact context packet, optional
explicit clone_paths, and optionally measure=true for directory-byte measurement.
Previously supplied clone paths are remembered. There is no global filesystem
scan. Default output is counts plus audit_id/fingerprint/evidence_path; full
inventories remain on disk. Read-only inspection does not run git add -N or
refresh the real index; it never edits source/branches/stashes.

The context packet distinguishes known facts with evidence, inferences, user
permissions, task goals, and unknowns. Historical changes are labeled
preexisting_or_external, task_relation=unknown, completion=unknown,
authorization=preserve. Reviewer prose cannot upgrade provenance or permission.
An environment reviewer runs on the configured Review route and reports through
the existing wait-for-job protocol. Its evidence has review_kind=environment,
advisory_only=true and code_acceptance=false, and is never formal review evidence.
Before/after fingerprints detect concurrent modifications; they cannot prove who
made them or undo an external writer. Git operations/conflicts block mutation,
while audits can still report them.

## Concrete reconciliation

Prepare with audit_id, mode=prepare, actions, and baseline=head|snapshot|block.
Every non-cleanup action names exact paths and a reason; commit/WIP also supplies
a message. Do not silently classify or commit user history.

Actions:
- preserve: retain the listed historical modifications.
- commit: submit an explicitly approved, complete group using an isolated index.
- wip: save selected unfinished content to a new explicit codex/ branch, without
  moving the original branch or changing its files/index by default.
  clear_saved_paths=true explicitly restores only the saved paths to source HEAD;
  this must appear in the approved plan. WIP is not code acceptance.
- cleanup: name a registered job. Normal cleanup requires a delivery commit;
  disposition=wip explicitly preserves a local checkpoint and staged/working
  patch receipts before retiring incomplete work. Active references, unresolved
  Git operations, or ignored unique artifacts block retirement.

Execute with the prepared plan_id, same audit_id, mode=execute, confirm=true.
Main-chat confirmation must reflect actual user authorization, not reviewer
opinion. Source/worktree fingerprints are rechecked. Completed actions are
journaled; repeated completed plans return already_reconciled. A concurrent change
or interruption with ambiguous state stops and requires inspection, never reset.
Unknown clones remain manual-only. There is no automatic discard action.

An approved HEAD baseline can preserve unrelated dirty files. A snapshot baseline
also needs allow_snapshot=true and captures the explicitly reviewed dirty file
set into a reachable local ref; sensitive paths are refused. Snapshots/WIP record
file state; index/working distinctions need their separate receipts. Snapshots
are exceptions for takeover/recovery, not the normal way to end completed work.

## Task finalization and recovery

After formal Review/Accept, use stage-finalize with job_id, optional commit_message,
confirm_commit under ask policy, and cleanup (default true). It validates the
accepted patch, applies once, checks actual target content, reruns acceptance
commands, stages only exact task paths in a temporary index, and creates a local
commit. Unrelated staged/unstaged modifications remain untouched. Commit hooks
are honored; unexpected hook changes stop closeout and are never silently adopted.

Use background=true with consumer_id for long final checks. The tool immediately
returns a runtime finalization job; supervise it through the existing wait-for-job
and result endpoints. Its compact result contains commit/cleanup status and a
remaining-path count, while full details remain in evidence. Synchronous mode is
retained for short calls and library users. Cancellation interrupts verification;
an already-started atomic commit is recorded before cleanup is left pending.

Commit ids, intended trees, parent ids, index state and cleanup intentions are
persisted. Resume handles interrupted commit receipt recording or worktree removal
without duplicate application/commits. Ambiguous files/index or a changed commit
tree require manual inspection. No automated reset of the user's branch occurs.

Closeout phases distinguish applied_pending_commit, committed_pending_cleanup,
committed, closed and wip_preserved. closed means task delivery and workspace
retirement succeeded; it does not mean all historical modifications vanished.
Result/status summaries include closeout state and commit id without transcripts.

Cleanup checks exact registered paths and shared repository identity, live process
and reviewer references, independent worktree commits, extra staged/untracked/
ignored data, and patch identity. Evidence and reachable Git refs survive.
Exact provider-session continuation becomes unavailable after retirement.

Approved historical residuals are carried across the plugin's own commits only
when their working content and staged entries remain identical, so unchanged
legacy edits do not trigger the same question at every milestone. New or changed
residuals invalidate that readiness. If a task modifies a file that already had
historical edits, automatic whole-file commit is refused: reconcile those edits
first, or deliberately make and record a manual commit. Snapshot creation alone
does not authorize committing inherited content.

## Parallel integration

Start independent workers from recorded baselines; retain task results and exact
sessions. Dependent tasks wait for the appropriate integrated/applied state.
Create a separate Planner task/subtask for the combined deliverable, with the
union of allowed paths and meaningful combination tests.

Call stage-integrate with that task/subtask and 2-8 accepted job_ids. Runtime saves
input trees under local refs, serially merges into one bounded integration
worktree and runs combination verification. Conflict state is preserved; resolve
and stage it there, then resume stage-integrate with the same job_id. Combination
test failures can be repaired there and resumed. Original workers are untouched.
Checkpoint commits inside the owned integration workspace are recovery artifacts,
not delivery acceptance. The final patch is bound to the integration baseline.

Fresh independent code Review and Accept of the combined patch are mandatory,
even if each input passed. Finalize makes one delivery commit and retires source
worktrees only after that commit exists. Integration does not automatically
substitute another baseline if the main branch changed; investigate/rebase via
an explicit new integration task instead of overwriting newer work.

## Real validation

`node --test tests/git-lifecycle.test.mjs` uses real temporary Git repositories,
commits, worktrees, merge conflicts, hooks and injected interruption points.
`scripts/e2e-git-lifecycle.mjs` additionally uses real parallel Codex CLI workers,
AGY environment/code reviewers, combination review, exact commit and cleanup.
Set explicit AGENT_ORCH_E2E_CODEX_MODEL/AGENT_ORCH_E2E_REVIEW_MODEL; optional
AGENT_ORCH_E2E_SUMMARY records the evidence index. Temp artifacts are retained.
This does not assert installation or desktop-host hook activation.
