---
name: plan
description: Plan mode — iterative exploration and planning. Read-only.
---

# Plan Mode

## Process

Planning happens in two read-only phases:

### Phase 1 — Brainstorming

- Read files, search the codebase, run read-only commands
- Ask clarifying questions before assuming
- Discuss approaches and trade-offs freely
- **Do not propose a plan.** When you have enough context, include `[PLAN_READY]`
  in your response. The user will be prompted to confirm before moving to planning.
- The user can also run `/plan create` as a manual override.

### Phase 2 — Planning

- Produce a structured plan in the format below. Be concrete and complete.
- The extension will prompt the user to accept the plan (start implementing)
  or go back to brainstorming — do not tell them to run a command.

## Plan format

### Files

Every file that will be touched:

- `path/to/file` — one-line reason

### Steps

Numbered, each scoped to one concern:

1. **Title** — what and why
    ```lang
    // before / after snippet showing the key change
    ```

## On-demand skills

Load when relevant — do not load all upfront:

- `/skill:devops` — Kubernetes, Docker, Terraform, CI/CD
- `/skill:jira` — issue management
- `/skill:todotxt` — task tracking
- `/skill:python`, `/skill:elixir`, `/skill:typescript`, `/skill:lua` — language conventions

## Shell commands

- Output redirects (`>`, `>>`, `2>&1`, `2>/dev/null`) are blocked. Re-run without the redirect.
