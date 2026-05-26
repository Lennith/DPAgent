# Web Session Ownership Protocol

## Scope
This protocol defines how the server and Web client represent session origin,
run ownership, active-run state, and interaction locks.

## Data Contracts
`SessionOrigin` and `RunOwner` use the same value set:

```text
web | cli | automation
```

Session list and detail DTOs may include:

```text
origin
activeRun
interactionState
```

`activeRun` identifies the running turn: run id, context/session id, owner,
origin, started time, model/provider selection when known, and any current
auto-loop metadata.

`interactionState.mode` is:

- `normal`: Web may mutate the session subject to normal run guards.
- `observe_only`: Web may observe but not mutate because another surface owns the active run.

## Origin Classification
Run ownership is classified by server-side connection metadata. The WebSocket
header `X-DPAgent-Client-Kind` identifies CLI connections. Chat request body
fields are not trusted to select CLI ownership.

Automation run ownership is assigned by the automation execution path. Web
clients cannot spoof automation or CLI ownership through payload fields.

## Mutation Matrix
| State | Send chat | Stop active run | Edit draft | Change model | Change Ralph | Plan input response |
| --- | --- | --- | --- | --- | --- | --- |
| Idle Web session | yes | no active run | yes | yes | yes | only if request exists |
| Web-owned active run | no new run; button is Stop | yes | yes | yes, next turn | yes, next continuation | if request-bound |
| CLI-owned active run | no | no | no | no | no | no |
| Automation-owned active run | no | no | no | no | no | no |
| Canceling or hydrating | no | current transition only | no | no | no | no |

## Server Responsibilities
- Track active run state by context/session.
- Surface `activeRun` through REST session list/detail and `chat_started`.
- Enforce observe-only checks on mutating HTTP routes and WebSocket messages.
- Accept external MCP attachments only from CLI-origin connections.
- Keep workspace and automation continuations independent from WebSocket lifetime.

## Client Responsibilities
- Derive disabled states from `interactionState`, canceling, hydrating, and active-run owner.
- Treat Web-owned active runs as editable for next-turn configuration, not as permission to start a concurrent run.
- Render CLI and automation sessions as observe-only while active.
- Never infer committed state only from live deltas; hydrate or terminal events remain the committed boundary.

## Invariants
- A request body cannot upgrade Web into CLI ownership.
- A session has at most one active run.
- Observe-only blocks mutation even when the UI has stale local state.
- Web-owned active-run setting changes are future-effective only.
