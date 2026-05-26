# Auto-loop And Continuation Protocol

## Scope
This protocol covers Todo loop, Ralph loop, workspace continuation, automation
continuation, and recoverable checkpoint continuation.

## Modes
- Todo loop: continues while Todo items remain unfinished or plan execution is active.
- Ralph loop: optional user-configured auto-loop for additional autonomous continuation.
- Workspace continuation: backend-owned continuation that does not require a WebSocket.
- Automation continuation: scheduled automation work owned by automation.

Todo and Plan execution take priority over Ralph. Ralph configuration changes
made during a Web-owned active run apply when the current run completes and the
next eligible continuation is selected.

Todo unfinished work is limited to `pending`, `in_progress`, and `blocked`.
`completed` and `dismissed` are terminal. A blocked item stops Todo continuation
until the blocker is resolved or the user dismisses it. Resuming a blocked item
returns it to `pending` and can restart Todo continuation. Dismissing a blocked
item removes it from continuation decisions while preserving the durable Todo
record for audit.

Todo `plan_set` replaces the active unfinished Todo contract. New Plan execution
todos can overwrite earlier pending, active, or blocked items from ordinary
Todo use or from an older Plan execution. Completed and dismissed rows remain
terminal history and are not rewritten by this replacement.

## Loop State
```text
stopped
  -> running
  -> schedule_next
  -> running
  -> stopped
```

Stop reasons include user stop, cancel, max rounds, similarity stop, timeout,
tool exit, fatal error, and completion.

## Headless Continuation
Backend-owned workspace runs and automation runs must continue without an open
browser. WebSocket disconnect is not a stop signal for these continuations.

Web clients may observe current state after reconnect by hydrating sessions and
active-run views.

## Recoverable Checkpoint Errors
A terminal `error` can be recoverable when it is saved through a replay-safe
checkpoint and has a durable interrupted artifact. Recoverable checkpoint errors
schedule continuation instead of stopping Todo/Ralph/workspace loops.

Errors without a checkpoint artifact, or errors that cannot preserve replay
safety, are fatal for the active loop.

Synthetic recoverable checkpoint continuations skip completion-marker repair so
the Todo loop can continue from the saved state rather than fabricating
completion.

## Model And Config Timing
Session LLM selection and Ralph settings are read when a new run or continuation
starts. They do not alter a provider request already in flight.

## Plan Interaction
If Plan Mode is waiting for approval or pending user input, continuation does
not proceed as normal execution. The loop waits for the required Plan decision
or expires/cancels according to the Plan input lifecycle.

## Invariants
- WebSocket lifetime does not own backend continuation lifetime.
- Todo/Plan unfinished work has priority over Ralph.
- Dismissed Todo items are not unfinished work and are not exposed as an LLM
  status transition.
- Recoverable checkpoint errors continue; non-recoverable errors stop.
- Next-run configuration is sampled at continuation start.
