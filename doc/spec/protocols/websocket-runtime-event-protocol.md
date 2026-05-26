# WebSocket Runtime Event Protocol

## Scope
This document defines the WebSocket message contract used by the Web client,
CLI bridge, and Web server runtime callbacks.

## Inbound Messages
- `chat`: start a run for the selected session. May include `planningAction: "enter_drafting"` when the composer Plan Mode intent is active.
- `running_input_enqueue`: enqueue a user prompt while a Web-owned run is active. This is not a concurrent `chat` run and is memory-only server state. Optional `fileReferences` are bound to the queued item.
- `running_input_insert`: request that an already queued running input be inserted into the current run at the next safe checkpoint.
- `running_input_cancel`: remove a queued running input item. The Web client uses this for both discard and edit-then-requeue flows.
- `cancel`: request cancellation of a Web-owned active run.
- `plan_input_response`: answer a pending Plan Mode `request_user_input` request.
- `stop_auto_loop`: stop Todo/Ralph continuation for a mutable Web session.
- `ping`: keepalive and connectivity check.

Inbound messages are validated against the server's connection class and current
session interaction state. CLI ownership is resolved from connection metadata,
not from payload fields.

Share-link text clients connect with `mode=text` and a valid `shareToken`. They
use a reduced message set: `ask_text` to send one text prompt,
`history_request` to fetch recent user/assistant body text, and `ping`.
Full Web runtime messages are rejected on text-only sockets.

## Outbound Events
Common outbound event families:

- `chat_started`: active run was accepted and assigned run metadata.
- `thinking`: model thinking or reasoning delta.
- `tool_call`: tool call started or updated.
- `tool_result`: tool result or artifact reference.
- `step`: step-level runtime progress.
- `message`: assistant content delta or committed message.
- `context_*`: context budget, compression, checkpoint, or replay events.
- `plan_input_*`: pending Plan input request, resolved response, or expiration.
- `running_input_queue_updated`: current memory queue for the session active run.
- `running_input_inserted`: queued input was appended to the pending turn after a tool-result checkpoint.
- `running_input_error`: running-input enqueue, insert, or cancel request was rejected.
- `auto_loop_*`: Todo/Ralph continuation scheduling and stop events.
- `cancel_ack`: cancellation request accepted or rejected.
- `run_terminal`: terminal status for a run.
- `complete`: committed successful turn result.
- `pong`: keepalive response.

Text-only share sockets receive only `history`, `text_delta`, `file_link`, `done`, `busy`,
`observe_only`, `error`, `share_invalidated`, and `pong`. Runtime-only events
such as `thinking`, `tool_call`, `tool_result`, `step`, and context events are
filtered by the server before delivery, except successful `send_file_to_user`
tool results are converted to `file_link` with the download URL and display
metadata.

## Binding Rules
Every runtime event that belongs to an active run must carry enough identity for
the client to bind it to the intended session and run. Events for stale run ids
must not overwrite the currently active runtime state.

Plan input responses are request-bound. A response must match the pending
request id and session; stale or mismatched answers are rejected.

Running input is held in a session queue after enqueue. Insert requests are
accepted only for the current Web-owned mutable run, bind the selected queued
item to that run, and are consumed only after all tool results for an assistant
tool-call batch have been appended and before the next LLM request is prepared.
The server must not inject input into an active provider stream. Direct
`end_turn`, cancellation, fatal error, pending Plan input, and forced
`finalize_plan` completion do not consume insert requests.

## Broadcast Rules
The server may broadcast committed transcript updates and active-run state to
observers. Mutating responses and cancellation acknowledgements are scoped to
the requesting connection where possible.

CLI-origin runs can be observed from Web, but Web observers receive
`observe_only` interaction state and cannot cancel or mutate the run.

## Terminal Events
Successful terminal events commit transcript state. Runtime errors are surfaced
as terminal events or transcript cards only when they represent durable user
information.

Canceled terminal errors are not projected as persistent transcript error cards
after the next run begins. Recoverable checkpoint errors may schedule
continuation instead of ending the loop.

## Invariants
- The same session cannot accept two concurrent `chat` runs.
- Running input never bypasses the same-session active-run gate; queued prompts
  start later as ordinary FIFO turns.
- Todo/Plan automatic continuation has priority over queued running input.
- `complete` is the committed boundary for successful live deltas.
- A stale event cannot clear a newer active run.
- Observe-only state is enforced server-side before client rendering choices matter.
