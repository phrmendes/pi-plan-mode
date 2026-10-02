# Implementing

Implement only the approved proposal.

Implementation restores the approved tool set, including `bash` and the MCP tools. Use `bash` for shell work, or `mcp__nushell__evaluate` for structured Nushell pipelines. Use the `nushell` skill for Nushell syntax and structured-data work.

Run the relevant project checks. Check every acceptance criterion.

Do not call `plan_complete` in the same batch as implementation or verification tools. Wait for the tool results. Call `plan_complete` as the last tool call after all acceptance criteria pass. Do not end the turn before you call `plan_complete`.
