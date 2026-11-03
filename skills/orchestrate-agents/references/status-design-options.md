# Supervision, progress and result protocol (0.6.0)

The separate wait-for-change proposal has been merged into wait-for-job.

## Coordinator calls

- stage-work / stage-work-continue / stage-review: compact stage/job identity and notification.consumer_id. Supply a stable consumer_id for the current chat.
- wait-for-job: project_dir plus exactly one of job_id or job_ids (1-8 unique IDs). until is update or terminal (default terminal). timeout_ms is 0-60000 (default 30000). Optional cursor is a nonnegative delivery revision for this project/consumer.
- status: summary by default, without transcript, route chain or paths. detail=progress/full explicitly reads historical worker messages for diagnostics.
- result: summary by default. detail=verification/changes/findings/attempts/full expands the requested existing evidence. It never waits or re-runs a model/test.

Example wait:

```json
{"project_dir":"<project>","job_ids":["<worker>","<reviewer>"],"consumer_id":"<stable-chat-id>","until":"update","cursor":3,"timeout_ms":30000}
```

```json
{"cursor":4,"events":[{"job_id":"<worker>","role":"worker","type":"progress","checkpoint":"implementation_done","message":"Implementation is ready; running compatibility tests.","source":"agent_report"}]}
```

No update:

```json
{"cursor":4,"events":[],"timed_out":true}
```

Terminal mode suppresses normal progress but returns blocked/interrupted attention early. Late consumers receive the current terminal snapshot once. An MCP restart does not require an in-memory Promise: the waiter reads persisted jobs and reporting files, checks worker/supervisor PIDs, and distinguishes external work from interruption.

## Worker and reviewer reports

The runtime provides a per-job report_progress MCP server to Codex/CC. AGY can invoke the supplied report-progress.mjs CLI with the bound reporting directory. The same helper CLI is available to every provider.

Accepted checkpoints: inspection_done, implementation_done, testing, reviewing, finding, blocked. Messages are limited to 240 Unicode characters. Repeated identical consecutive messages are suppressed. Normal reports have a hard per-job cap (16 total reports); attention reports have an independent cap of 4. Prompts ask for only 2-4 meaningful nodes. Reporting is advisory and does not pause a job or alter its authoritative status.

Reporting directories are instrumentation outside the implementation patch. The report-only MCP server exposes no planner, work-launch, review, acceptance or general file tools. Sandbox access is added only to that job's reporting directory.

## Durable delivery

Delivery state lives under .agent-orchestrator/notifications/, scoped by project and consumer_id. A cross-process file lock serializes Hook and wait delivery, so concurrent waits and overlapping job batches share consumed offsets/signatures. A stale cursor does not replay already claimed events. Use a different consumer_id to intentionally observe independently. Corrupt ledgers fail closed.

Cursors count delivered batches, not timestamps, heartbeat updates, or model progress percentages. Reports that arrive in a burst are coalesced to the latest ordinary report per job; attention has priority and terminal events supersede pending ordinary progress. Full report history stays in the job's reporting/progress.jsonl.

The ledger records delivery claims; it is not an end-to-end acknowledgement from the UI. On a host failure during delivery, inspect the preserved report history/current snapshot or use a fresh recovery consumer. This implementation does not claim exactly-once delivery across host crashes.

## Hooks

hooks/hooks.json is bundled in the plugin manifest. Async PostToolUse observes work/review starts and waits. UserPromptSubmit checks registered jobs on the next turn. The command waits up to 45 seconds, returns a short event batch as additionalContext, and emits nothing if unchanged. It does not send complete status/result objects or agent transcripts.

Hooks and wait-for-job must use the same consumer_id to share delivery. The stage response supplies the identity; a session alias helps UserPromptSubmit find it for the same project. Keep explicit waiting as the fallback when the main chat has no independent work. Hook commands require host trust/review and cannot start a new idle turn. No indefinite Stop continuation loop is installed.

Set notifications.hook_enabled=false to disable automatic delivery for a project. The explicit wait API remains available. Manual desktop plugin installation supports bundled hooks; public plugin-directory eligibility differs for hook-bearing plugins.

## Evidence and compatibility

Completed is not accepted. Review PASS is not formal acceptance. The coordinator still inspects current patch-bound verification/review evidence before stage-accept and apply.

0.6.0 intentionally changes default MCP status/result and stage-start return shapes. Callers requiring the old diagnostic/evidence packs must request detail=full. The internal WorkerOrchestrator API keeps full defaults for existing integrations. The existing single job_id argument remains supported; wait returns an event envelope rather than a full job.

Source references: [Codex Hooks](https://learn.chatgpt.com/docs/hooks#run-hooks-in-the-background), [plugin hooks](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks).
