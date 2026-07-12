# Security Policy

## Reporting a Vulnerability

Agent Orch is an MCP-driven multi-agent orchestration runtime for local development workflows.
If you discover a security vulnerability, please do not open a public GitHub issue.
Instead, use GitHub's private security-advisory reporting for this repository, or contact
the maintainer directly through the contact details on their GitHub profile.

We will acknowledge receipt within 48 hours and provide an initial assessment within
5 business days.

## Scope

The following are considered in-scope for security reports:

- Unauthorized code execution or file access through MCP tools
- Injection vulnerabilities in dashboard views (XSS, HTML injection)
- Exposure of secrets or credentials in logs or state files
- Path traversal or sandbox escape in worktree isolation

The following are out of scope:

- Dependency CVEs with no demonstrated exploit path in Agent Orch
- Local workstation compromise where the attacker already has shell access
- Social engineering of project maintainers
- Resource exhaustion from legitimate usage patterns

## Security Considerations

- Agent Orch runs worker agents (Claude Code and Antigravity) in isolated Git worktrees
  by default.
- The MCP server validates tool calls against a project trust policy before dispatching.
- Dashboard data is read-only and served from `.agent-orchestrator/runs/` state files.
- HTML output is sanitized via DOMPurify before rendering in the dashboard.
- State directories (`.agent-orchestrator/state/`, `.agent-orchestrator/runs/`) contain
  local-only operational data and should not be committed.
