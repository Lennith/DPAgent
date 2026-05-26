# Plan Mode Backend Lifecycle

## Purpose
Plan Mode gives the backend a durable state machine for planning, approval, and
Todo-constrained execution.

## State Machine
```text
normal
  -> plan_drafting
  -> plan_executing
  -> normal
```

`normal -> plan_drafting` happens only when a chat message is sent with
`planningAction: "enter_drafting"`.

`plan_drafting -> plan_executing` happens only when the user approves a
`finalize_plan` approval request.

`plan_executing -> normal` happens when the Todo-governed execution completes,
is explicitly canceled, or exits through the maintained Plan exit path.

## Composer Intent Boundary
The frontend Plan Mode button is not backend state. It is local composer intent
until send time. The backend must not receive an exit-draft request merely
because the user toggled the button off before sending.

## Drafting Tool Gate
Drafting runs expose read-only exploration plus:

- `request_user_input`
- `finalize_plan`

The drafting prompt must direct the model to clarify unclear product
requirements before finalization. This includes unclear acceptance criteria,
conflicting goals, missing ownership boundaries, missing verification
requirements, or scope that is too broad to execute safely.

## `request_user_input`
The tool asks one to three short questions. A request creates pending Plan input
state that is bound to the session and request id.

When the user answers, the response is routed back into the same draft turn if
the request is still active. If important requirements remain unclear, the
model should ask again instead of finalizing.

## `finalize_plan`
The tool submits a concrete plan for approval. The model must not continue into
implementation after calling it. Approval creates the execution turn; rejection
or revision keeps the session in drafting semantics.

## Execution
Execution activates Todo state from the approved plan. The loop continues under
Todo governance until all Todo items are completed or blocked with evidence.

Existing Todo-driven continuation has priority over Ralph continuation. Plan
execution must not silently switch to Ralph while unfinished plan Todo items
remain.

## Cancellation
Canceling a draft or execution run stops the active run and preserves recoverable
context where possible. Exiting draft is valid only when the backend state is
actually `plan_drafting`.

## Invariants
- Backend planning state changes only through chat send, approval, cancel, exit, or completion paths.
- Drafting is read-only except for planning tools.
- `finalize_plan` is approval, not execution.
- Approved execution is constrained by plan plus Todo until complete.
