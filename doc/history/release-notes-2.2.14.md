# DPAgent Release Notes: 2.2.14

## Highlights

- Keep scheduled-task automation runs isolated from the visible session that created the task.
- Preserve `schedule_task` query/cancel ownership semantics while preventing automation run metadata from hiding the source session in the default Web session list.

## Verification Scope

- Added store-level coverage that session-owned automation jobs create isolated `auto-...` run sessions.
- Added execution coverage that session-owned scheduled tasks write `automationRun` metadata only to the isolated run session, not the visible source session.
- Verified automation store, execution, scheduler, route, and schedule-task lifecycle tests, plus TypeScript build and the default `npm test` suite.
