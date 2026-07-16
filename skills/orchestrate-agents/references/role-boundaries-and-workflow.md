# Role boundaries and workflow

## Codex host

The current Codex task owns planning, routing supervision, evidence inspection, acceptance, and user communication. It persists its contract through `stage-plan` and accepts through `stage-accept`.

Codex does not edit the delegated project patch directly while Agent Orch is active. Codex Worker is a separate CLI provider operating in an isolated worktree.

## Workers

CC, AGY write, and Codex Worker implement one approved subtask within declared writable paths. They do not commit, push, deploy, publish, or change remote systems.

## Reviewer

AGY reviewer is read-only and produces patch-bound evidence for the configured review task. Provider availability or OAuth failure is not a review result.

## Accepter

The accepter verifies the contract, patch, tests, reviewer gate, repository/workspace identity, and immutable Plan execution identity. Only the formal acceptance artifact can authorize `apply`.
