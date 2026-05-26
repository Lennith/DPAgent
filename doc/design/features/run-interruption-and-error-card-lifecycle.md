# Run Interruption And Error Card Lifecycle

## Purpose
The UI must distinguish cancellation, recoverable interruption, fatal runtime
errors, and stale artifacts. Users should understand what happened without
being trapped by obsolete error cards.

## Concepts
- Cancellation: user or owner requested stop.
- Recoverable checkpoint interruption: progress was saved through a replay-safe checkpoint.
- Fatal runtime error: no safe checkpoint or continuation path exists.
- Stale artifact: recovery metadata from an earlier run that no longer applies.

## Display Rules
An interrupted artifact may show when the session is idle and the artifact is
the current recovery state. It should explain saved progress and whether the
next turn can continue.

When a new run starts, a pending Plan input becomes active, or recovery
completes successfully, old interrupted artifacts and canceled error cards must
be suppressed.

Runtime errors without recovery artifacts can appear as normal transcript
runtime messages when they are durable user information. They must not become a
separate permanent bottom error slot that survives later runs.

Canceled runtime errors are live feedback, not persistent transcript error
cards after the next run starts.

## Hydration Rules
Hydration may rebuild transcript and runtime state from the backend, but it must
not resurrect stale interrupted cards when:

- `activeRun` exists
- a next run is pending
- pending Plan input is active
- a later success cleared the artifact
- the terminal event belongs to an older run id

## Acceptance Checks
- Cancel shows immediate feedback but does not remain pinned after the next run.
- Recoverable checkpoint artifacts are visible only while current.
- Fatal errors are represented as transcript runtime errors.
- Stale terminal events cannot overwrite the new active run state.
