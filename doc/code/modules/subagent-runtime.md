# Subagent Runtime

## Responsibility
Subagent runtime lets a parent run delegate bounded work to child tasks while
preserving parent traceability, status, advisory diagnostics, and result
waiting.

## Source Paths
- `src/subagent/`
- `src/tools/SubAgentManageTool.ts`
- `src/web/client/components/subagent/`

## Key Files
- `src/subagent/SubAgentManager.ts`: queue, lifecycle, persistence, and waiters.
- `src/subagent/SubAgentTurnRunner.ts`: executes one child task.
- `src/subagent/SubAgentLifecycleReducer.ts`: lifecycle transition reducer.
- `src/subagent/subagent-manager-contracts.ts`: shared subagent types.
- `src/tools/SubAgentManageTool.ts`: model-facing tool interface.
- `src/web/client/components/subagent/SubAgentPanel.tsx`: Web display.

## Runtime Contracts
Subagents are delegated work, not independent product sessions. Parent context,
selected profile, allowed tools, provider selection, and result artifacts must
remain traceable.

Task timeout is an advisory deadline, not an automatic cancellation boundary.
When the deadline is reached, the runner emits a timeout warning and the manager
stores `task_deadline_exceeded:<timeoutMs>` while keeping the task running. The
task is interrupted only by explicit cancellation.

Pending subagents are scoped to the parent run. When the parent run finishes,
the parent agent is canceled, or the Web frontend sends a manual stop for that
context, queued and running subagents for the same parent context are canceled.
Late runner output after cancellation must not overwrite the terminal canceled
record.

Heartbeat state is exposed in `SubAgentStatus.lastHeartbeatAt` and in
`subagent_manage` payloads under `heartbeat`. Stale heartbeat diagnostics are
diagnostic-only and do not cancel the task.

Current runtime does not automatically retry failed subagents. `retryQueue` and
`retryCount` remain registry fields for historical compatibility and future
explicit retry work, but loading a registry with retry entries must not create
or enqueue new child tasks. Manual resume/retry routes create explicit new work
only after user or API action.

## Edit Guidance
- Keep lifecycle mutation centralized.
- Avoid parallel queue mutation paths.
- Preserve frozen profile/tool/provider config across explicit resume/retry and status records.
- Add tests for any lifecycle transition or timeout change.

## Closest Tests
- `tests/unit/subagent-manager.test.ts`
- `tests/unit/subagent-manage-tool.test.ts`
- `tests/unit/subagent-runner-agent-profile.test.ts`
