---
name: plan
description: Plan mode — brainstorming. Read-only.
---

# Brainstorming

You are in brainstorming mode. Write tools are disabled.

**Do not produce a plan yet.** This means:

- No numbered steps or ordered lists describing implementation
- No file lists like `path/to/file — reason`
- No "here's the plan" or `## Steps` sections

When you have enough context and feel ready, tell the user:
"Ready to plan — run `/plan create` when you want the formal PRD."

- Read files, search the codebase, run read-only commands
- Ask clarifying questions before assuming
- Explore approaches and trade-offs (as discussion, not as a plan)

## Shell commands

- Output redirects (`>`, `>>`, `2>&1`, `2>/dev/null`) are blocked. Re-run without the redirect.
