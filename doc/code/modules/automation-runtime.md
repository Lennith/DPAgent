# Automation Runtime

## Responsibility
Automation runtime schedules, coordinates, and executes recurring agent runs
defined by user-authored jobs. It manages job definitions, run lifecycle,
execution service integration, and result reporting.

## Source Paths
- `src/automation/`

## Key Files
- `src/automation/AutomationScheduler.ts`: evaluates due runs and triggers
  execution based on cron-like schedules and run policies.
- `src/automation/AutomationExecutionService.ts`: executes automation runs by
  creating agent sessions and managing the run lifecycle.
- `src/automation/AutomationRunCoordinator.ts`: coordinates active automation
  runs, handles concurrency limits, and manages run state transitions.
- `src/automation/AutomationStore.ts`: persists job definitions, run records,
  and execution reports.
- `src/automation/AutomationRoutes.ts`: Web API routes for automation CRUD
  and run management.
- `src/automation/schedule.ts`: schedule parsing and next-run calculation.
- `src/automation/types.ts`: TypeScript types for jobs, runs, schedules, and
  execution states.

## Runtime Contracts
Automation is auditable and backend-owned. Runs normally execute in generated
automation sessions, while jobs with `sessionId` execute against that specified
session. The `schedule_task` tool creates session-scoped jobs for the current
session; one-shot session-scoped jobs are disabled after a successful run.

Due runs are claimed by `AutomationStore.claimRun`, which writes the running or
overlap-skipped run record and advances `nextRunAt` in the same store operation.
Jobs define their own schedule (interval or cron) and prompt template. Failed
runs are recorded with error details and do not block subsequent scheduled
runs.

## Edit Guidance
- Avoid overlapping automation runs for the same job unless policy explicitly
  allows it.
- Keep schedule parsing in `schedule.ts`; do not inline cron logic in the
  scheduler or coordinator.
- Add audit or status signals when run state changes.
- Update routes and UI when adding new automation job fields.

## Closest Tests
- `tests/unit/automation-store.test.ts`
- `tests/unit/automation-run-coordinator.test.ts`
- `tests/unit/automation-schedule.test.ts`
- `tests/unit/web-automation-routes.test.ts`
- `tests/unit/web-automation-execution.test.ts`
- `tests/unit/web-automation-scheduler.test.ts`
