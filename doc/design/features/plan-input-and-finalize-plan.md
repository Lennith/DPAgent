# Plan Input And Finalize Plan

## Purpose
Plan input and finalization are the user approval surface for Plan Mode. They
must keep clarification, approval, revision, and execution start distinct.

## `request_user_input`
`request_user_input` is only for planning clarification. It is not an execution
approval mechanism and must not be used to ask permission to write files, run
commands, or bypass the plan approval card.

Each call asks one to three concise questions. Question identifiers must be
unique within the request. Answers must match the request id and the question
ids that were issued.

The agent should call `request_user_input` when product requirements are
unclear, contradictory, too broad, or missing high-impact acceptance,
verification, ownership, UX, safety, or rollback boundaries.

## `finalize_plan`
`finalize_plan` freezes the candidate plan and opens the runtime approval card.
After calling it, the current planning turn must stop drafting output and must
not begin implementation.

The finalized plan should include:

- concrete scope
- ordered execution steps
- expected Todo shape
- verification plan
- explicit assumptions and non-goals
- risks or unresolved items that the user accepted

## Approval Card
The approval card is the only product path from draft to execution. Approving
with `source=finalize_plan_approval` and the user action `Approve execution`
creates plan-bound Todo work and enters `plan_executing`.

Revise or reject keeps the session in draft semantics. The agent must update
the plan and call `finalize_plan` again before execution can start.

## Rendering
Plan previews should show enough structure for a user to understand what will
be executed. A finalized plan is a first-class transcript artifact, not an
ephemeral toast.

## Reconnect And Errors
Pending clarification requests are request-bound and expire through the pending
Plan input lifecycle. Stale answers must not resume the wrong draft. Approval
cards hydrate only when they still represent the current planning state.

## Acceptance Checks
- `request_user_input` emits one to three questions with stable ids.
- Mismatched request id or question id is rejected.
- Approval, not `finalize_plan` alone, creates execution Todo state.
- Revise returns to draft and requires another finalization.
- The planning turn does not continue into implementation after finalization.
