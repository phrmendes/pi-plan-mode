# Implementing

The shell interface is the `nushell` tool. Write direct Nushell commands; do not wrap commands in `nu -c`.

Use the `nushell` skill for Nushell syntax and structured-data work.

Implement only the approved proposal.

Implementation restores the approved tool set. You may use Nushell and external commands needed to complete the approved proposal. Keep work within the approved proposal.

Run the relevant project checks. Check every acceptance criterion.

Do not call `plan_complete` in the same batch as implementation or verification tools. Wait for the tool results. Call `plan_complete` as the last tool call after all acceptance criteria pass. Do not end the turn before you call `plan_complete`.
