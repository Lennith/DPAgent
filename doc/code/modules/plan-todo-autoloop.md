# Plan, Todo, And Auto-loop

## Responsibility
This area connects Plan Mode, Todo governance, Ralph auto-loop, and continuation
scheduling.

## Source Paths
- `src/tools/PlanModeTools.ts`
- `src/todo/`
- `src/auto-loop/`
- `src/web/server/pending-plan-input-coordinator.ts`
- `src/web/server/web-server-callback-continuation.ts`
- `src/web/server/web-server-autoloop-routes.ts`
- `src/web/client/components/auto-loop/`
- `src/web/client/components/chat/*Plan*`
- `src/web/client/components/chat/TodoPanel.tsx`

## Key Files
- `src/tools/PlanModeTools.ts`: `request_user_input` and `finalize_plan`.
- `src/todo/TodoStore.ts`: durable Todo state and prompt segment.
- `src/auto-loop/AutoLoopController.ts`: Ralph/Todo loop controller.
- `src/web/server/web-server-callback-continuation.ts`: post-run continuation decision.
- `src/web/server/pending-plan-input-coordinator.ts`: Plan clarification lifecycle.

## Runtime Contracts
Normal Plan button state is composer intent until send. Drafting exposes
planning tools and read-only exploration. Approval creates Todo-constrained
execution. Todo and Plan execution have priority over Ralph continuation.

Todo statuses split active work from terminal history. `pending`,
`in_progress`, and `blocked` are unfinished and can drive continuation.
`completed` and `dismissed` are terminal. `dismissed` is audit-only: it keeps
the original work and plan binding, but it is not included in active Todo
prompting, open counts, or Plan execution exit blocking.

`plan_set` is a full replacement of the current unfinished Todo contract. A new
Plan execution Todo list overwrites prior unfinished items, whether they were
unbound or belonged to an older plan. Terminal `completed` and `dismissed`
history stays archived. Single-item `add` remains append-only and keeps the
mixed plan/unbound guard.

`blocked` is recoverable rather than terminal. Web users can resume a blocked
Todo back to `pending` or dismiss it out of the current contract. These actions
are Web-only controls; the LLM-facing Todo tool must not expose `dismiss`,
`resume`, or `status=dismissed`.

## Edit Guidance
- Keep Plan tool semantics in `PlanModeTools.ts`.
- Keep Todo persistence in `TodoStore`.
- Keep continuation scheduling in Web server continuation helpers and auto-loop controller.
- Keep user-only Todo lifecycle actions in Web routes and client controls.
- Keep LLM Todo tool schemas limited to model-authored progress reporting.
- Update both design and protocol docs for Plan/Todo/Ralph behavior changes.

## Closest Tests
- `tests/unit/plan-mode-tools.test.ts`
- `tests/unit/plan-mode-agent-case.test.ts`
- `tests/unit/todo-store.test.ts`
- `tests/unit/auto-loop-exit-tool.test.ts`
- `tests/e2e/release-plan-mode-lifecycle.e2e.ts`
