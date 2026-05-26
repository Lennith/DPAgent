# Pending Plan Input Lifecycle

## Purpose
`request_user_input` lets a Plan Mode draft pause for user clarification without
losing the active run or accepting stale answers.

## State Machine
```text
none
  -> pending_attached
  -> pending_detached
  -> resolved | rejected | expired
```

`pending_attached` means the owner connection that created the request is still
available. `pending_detached` means the owner disconnected and the reconnect
grace timer is running.

## Request Model
A pending request includes:

- session/context id
- request id
- question list
- allowed options when present
- owner connection metadata
- created and expiration timestamps

The request is reflected in session metadata and held in the runtime
coordinator so reconnect and response validation use the same identity.

## Detach And Reconnect
When the owner socket closes while a Plan input request is pending, the request
enters detached grace immediately. A reconnect by the same valid owner may
reattach before the grace expires. Expiration cancels or rejects the pending
request so the run cannot wait forever.

Workspace, Todo, and automation continuations do not depend on a browser staying
open, but a user clarification request still requires a valid response before
that draft can proceed.

## Response Validation
A `plan_input_response` must match the pending request id and session. Stale,
duplicate, mismatched, expired, or observe-only responses are rejected.

For CLI-owned active runs, Web remains observe-only and cannot answer Plan input
on behalf of the CLI owner. The response authority belongs to the active run
owner.

## UI Rules
The client renders pending Plan input only when it belongs to the current
session and is not stale. Hydration must not resurrect a completed or expired
request.

## Invariants
- A Plan input answer is request-bound, not session-global.
- Detached grace is explicit and finite.
- Observe-only blocks responses.
- Stale answers cannot resume a different draft.
