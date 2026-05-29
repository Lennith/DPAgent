# Plan Mode Lifecycle

## Purpose
Plan Mode separates requirement discovery from execution. It gives the user a
reviewable plan before the agent writes, runs, or changes project state, then
uses that approved plan as the execution contract.

## User Outcomes
- The user can mark the next message as a planning request without changing backend session state.
- The agent clarifies unclear product requirements before finalizing.
- The user can approve, reject, or revise a plan.
- Approved work executes under Todo governance until all required work is done.
- Cancel and exit paths leave the session in a predictable state.

## Entry Semantics
The Plan Mode button is local composer intent while the session is normal.
Clicking it does not call an exit or enter draft API and does not set the
session to `plan_drafting`.

When the user sends a message while that intent is active, the Web client sends
`planningAction: "enter_drafting"` with the chat message. The backend then
resolves the session into `plan_drafting` for that turn.

Clicking the Plan Mode button again before sending only clears the composer
intent. It must not produce a "no session in draft" error.

While already in `plan_drafting`, follow-up messages remain draft messages. They
do not require another composer intent. While in `plan_executing`, sending a
normal message does not re-enter draft; execution remains bound to the approved
plan and Todo state.

## Drafting Behavior
In `plan_drafting`, the agent is expected to inspect the repository and
requirements in a read-only manner. It may use planning tools:

- `request_user_input`: ask one to three short, concrete clarification questions.
- `finalize_plan`: submit the plan for user approval.

If product requirements are unclear, contradictory, too broad, missing critical
acceptance criteria, or missing risky boundaries, the agent must clarify before
calling `finalize_plan`.

Drafting must not make source changes, run destructive commands, or treat an
unapproved plan as executable work.

## Approval And Execution
`finalize_plan` creates an approval request. User approval transitions the
session from `plan_drafting` to `plan_executing`.

Plan execution creates or updates Todo state. The execution loop is constrained
by both the approved plan and unfinished Todo items. The agent should continue
until the Todo plan is complete, blocked with evidence, or explicitly canceled.

If the user rejects or revises the plan, the session remains in draft semantics
and the agent must update the plan instead of executing.

## Cancellation And Exit
- Canceling an active draft or execution run stops the active run.
- Exiting draft is valid only when the backend session is actually in draft.
- Clearing composer intent in a normal session is a local UI action, not a draft exit.
- Normal execution exit requires no unfinished plan Todo items.
- Forced execution exit must make the interruption explicit and stop or pause the execution loop.
- After a user stop or cancel, the Todo panel can offer confirmed cleanup for
  unfinished current-session Todo items, marking them `dismissed` without deleting history.
- A canceled runtime error should not remain pinned as the final transcript card after the next run starts.

## Acceptance Checks
- Toggle Plan Mode on and off in a normal session without calling `exitPlanDraft`.
- Send with Plan Mode active and verify the chat payload carries `planningAction`.
- Draft mode exposes planning tools and read-only exploration only.
- Unclear product requirements trigger `request_user_input`.
- Approval moves to execution and Todo loop governance.
- Stopping a run can expose Todo cleanup only when unfinished current-session Todo work remains.
- Cancel and next-run recovery do not leave stale error cards at the bottom of the transcript.
