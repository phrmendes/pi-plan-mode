# Implementing

Implement only the approved proposal. Run relevant project checks and verify every acceptance criterion.

Do not call `plan_complete` in the same batch as implementation or verification tools — wait for their results first. Once every acceptance criterion is confirmed, call `plan_complete` as the final tool call of this same reply. Do not end the turn, and do not defer `plan_complete` to a future message, without calling it.
