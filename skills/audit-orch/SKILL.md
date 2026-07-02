---
name: audit-orch
description: Inspect Agent Orch progress with a read-only CLI report or live dashboard. Use when the user asks to check CC/AGY/subagent progress, view agent-orch status, inspect visible conversations/tool use/logs, or open a real-time monitor/dashboard for Agent Orch jobs.
---

# Audit Orch

Use this skill to inspect Agent Orch jobs and worker activity without mutating any job state.

This skill is read-only. It must not start, stop, continue, apply, cleanup, cancel, or modify Agent Orch jobs. It may read `.agent-orchestrator`, process metadata, logs, transcripts, evidence files, patches, and isolated worktree status.

## Quick Status

When the user asks for a text status report, progress summary, active process list, or "what is CC/AGY doing", run the auditor script from the current project or one of its subdirectories:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\skills\audit-orch\scripts\audit-orch.ps1
```

Summarize active processes, recent jobs, stale-running jobs, models, visible transcript/log availability, and any obvious blocker shown by job metadata or logs.

## Live Dashboard

When the user asks for a dashboard, monitor, web page, live view, real-time progress, visible conversation, tool use, transcript, stdout/stderr, or logs:

1. Treat the current working directory as the project context. The server searches upward for `.agent-orchestrator`.
2. Check whether `http://localhost:15788` is already serving the dashboard.
3. If it is not running, start the server from the project directory as a hidden background process:

```powershell
Start-Process -WindowStyle Hidden -FilePath python -WorkingDirectory <project> -ArgumentList @('<plugin-root>\skills\audit-orch\scripts\server.py')
```

4. Open the dashboard:

```powershell
Start-Process "http://localhost:15788"
```

5. Tell the user the dashboard URL.

## Dashboard Capabilities

The dashboard shows:

- active Agent Orch, Claude Code, Antigravity, and relevant training/script processes;
- recent CC and AGY jobs;
- job metadata, observed model, evidence, git status, patch tail, stdout/stderr, and debug logs;
- CC visible conversation and tool use/tool result events parsed from Claude transcript JSONL when available;
- AGY evidence, CLI logs, stdout/stderr, and visible transcript events when available.

The dashboard only displays visible transcript content and logs that exist on disk. It does not claim to expose hidden chain-of-thought. If a provider writes visible thinking text into a transcript, it may appear as ordinary visible assistant text.

