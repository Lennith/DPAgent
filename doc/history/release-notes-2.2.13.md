# DPAgent Release Notes: 2.2.13

## Highlights

- Treat context event version conflicts as recoverable Web session errors instead of red transcript errors.
- Refresh the affected Web session after a recoverable conflict so the UI can show the committed transcript.
- Filter historical conflict runtime errors during transcript projection so older sessions do not keep showing stale error cards.
- Buffer subagent parent-context writeback into the active parent turn while that turn is pending.
- Skip parent-context checkpoints from subagents while the parent turn is still pending, preserving existing checkpoint behavior after the parent turn commits.

## Verification Scope

- Added coverage for context version conflict parsing, Web runtime recovery, runtime error projection, orchestrator persistence behavior, and subagent parent-turn buffering.
- Release verification should include the standard source gate and official npm publish preflight.
