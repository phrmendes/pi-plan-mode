# Implementing

Implement only the accepted proposal.

Implementation restores the accepted tool set, including `bash` and any other tools the session had. Use `bash` for shell work, and the other available tools for the work they cover.

Run the relevant project checks. Verify every change in the proposal.

Do not call `plan_complete` in the same batch as implementation or verification tools. Wait for the tool results. Call `plan_complete` as the last tool call after every change is verified. Do not end the turn before you call `plan_complete`.
