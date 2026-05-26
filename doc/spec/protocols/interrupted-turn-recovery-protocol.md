# Interrupted Run Recovery Protocol

## Purpose
Interrupted recovery preserves truthful state after disconnects, provider
errors, process interruption, or cancellation. It must never claim work finished
unless committed events prove it.

## State Machine
```text
clean
  -> draft_started
  -> checkpointed
  -> interrupted_artifact
  -> next_turn_recovery
  -> cleared_on_success
```

## Durable Pieces
- Draft metadata: run id, turn id, workspace, baseline event count, timestamps, and checkpoint sequence.
- Checkpoint replay: replay-safe messages and tool results after the baseline.
- Side-effect ledger: side effects that must be acknowledged during recovery.
- Interrupted artifact: user-visible recovery object that explains saved progress and replay boundary.

## Recovery Rules
The next run may resume from a valid interrupted artifact. It must describe what
was saved and what remains uncertain. It must not fabricate tool results or
pretend uncommitted side effects completed.

Successful recovery clears the interrupted artifact and related ledger state.

## UI Hydration Rules
The Web client shows an interrupted artifact or runtime error only when it is
the current idle state for the session.

Hydration must suppress stale artifacts when:

- a new active run exists
- a pending Plan input is active
- the runtime has a pending next run
- a later terminal success cleared the artifact

Canceled terminal runtime errors are not durable transcript cards for the next
conversation. They can be visible as live feedback, but they must not remain
pinned after the next run starts.

## Continuation Rules
Recoverable checkpoint terminal errors can schedule Todo/Ralph/workspace
continuation. Fatal errors stop the active loop.

Prepared initial chat runs and continuation runs share the same recoverable
versus fatal policy; first-run errors are not exempt from checkpoint recovery.

## Invariants
- Recovery is based on durable checkpoints, not UI state.
- Stale interrupted artifacts cannot override an active run.
- Cancel cards do not persist as bottom transcript errors after the next run.
- Side effects remain explicit until committed or recovered.
