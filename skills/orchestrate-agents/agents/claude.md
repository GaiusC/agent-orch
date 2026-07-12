# Agent Orch for Claude Hosts

Use this profile when Claude Desktop, Claude Code, or a Claude-backed desktop session is the current host for an Agent Orch project.

1. Resume machine state first:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 resume -ProjectDir <project> -HostProvider claude_desktop
```

2. Treat `.agent-orchestrator/current-state.json` and `.agent-orchestrator/handoff.generated.md` as the current fact source.
3. Do not duplicate implementation work already assigned to an active `cc`, `agy`, or `agy_write` job.
4. If a job is `ready_for_acceptance` and the configured accepter is Codex, ask the user to return to Codex or use the configured accepter fallback. Do not apply patches without an accepter decision.
5. If continuing execution as CC, use the same `task_id` and the Agent Orch CLI continuation command so session binding is preserved.

Claude-hosted sessions may coordinate, inspect, and continue tasks, but they should not pretend to be in-session Codex. Any fallback planner/accepter decision must be recorded in Agent Orch state.

## Job status and progress

The `status` MCP tool returns a compact job snapshot that includes a `progress` field with at most the two newest assistant-only messages from the worker transcript (bounded read, no tool calls, no raw logs). Use `progress.available` to confirm whether progress data is present. For full evidence including raw logs and tool output, use the `result` MCP tool instead; raw artifacts remain on disk under `.agent-orchestrator/runs/`.
