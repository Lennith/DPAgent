# Ralph, Todo, And Plan Execution

## Purpose
DPAgent has multiple continuation mechanisms. Product behavior must make
their priority and user controls predictable.

## Concepts
- Todo-driven loop: continuation required by unfinished Todo work.
- Plan execution: Todo-driven work created from an approved Plan Mode plan.
- Ralph loop: optional autonomous continuation selected by user settings.
- Recoverable checkpoint continuation: continuation after a replay-safe interrupted error.
- Blocked Todo: unfinished work that cannot progress until the blocker is resolved.
- Dismissed Todo: user-dismissed terminal work kept for audit but removed from the active execution contract.

## Priority
Plan execution and unfinished Todo items have priority over Ralph. Ralph cannot
take over while approved plan work remains unfinished.

Draft Plan Mode is not execution. It must not start an execution auto-loop until
the user approves the finalized plan.

## Plan Execution
Approved plans create plan-bound Todo state. The agent loop continues until
Todo items are completed, explicitly blocked with evidence, dismissed by the
user, canceled, or forced out by the user.

Blocked Todo is recoverable. When the user resolves the blocker, the Web
`Resume` action returns the item to `pending` and the Todo loop may continue.
When the user decides the blocked work should no longer be part of the current
contract, the Web `Dismiss` action marks it `dismissed`. Dismissed items do not
count as unfinished work, do not drive Todo continuation, and do not prevent
normal Plan execution exit.

Dismiss is never an LLM tool action. The model can report a blocker with Todo
`set_status`, but only the user can dismiss a blocked item.

After the user stops or cancels an active run, Web may expose a current-session
cleanup action when unfinished Todo items remain. Cleanup is user-confirmed and
marks all current session `pending`, `in_progress`, and `blocked` items as
`dismissed`. It does not delete Todo history and does not affect completed or
already dismissed items.

## Ralph
Ralph settings are editable during Web-owned active runs for future use. The
current in-flight run is unchanged. When the run completes, the continuation
policy reads the latest Ralph settings if no Todo or Plan execution work has
higher priority.

Observe-only sessions cannot mutate Ralph from Web.

## Recoverable Checkpoint Errors
Checkpoint interrupted errors can continue the active loop. Non-checkpoint
errors are fatal unless another explicit recovery contract exists.

## Acceptance Checks
- Draft mode does not start execution continuation.
- Approving a plan creates Todo-constrained execution.
- Unfinished Todo prevents Ralph from taking priority.
- Blocked Todo can be resumed or dismissed by the user.
- After a user stop or cancel, current-session cleanup can dismiss unfinished Todo work.
- Dismissed Todo does not drive continuation or block Plan execution exit.
- Recoverable checkpoint errors schedule continuation.
- Observe-only sessions cannot change Ralph.
