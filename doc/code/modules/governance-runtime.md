# Governance Runtime

## Responsibility
Governance runtime records auditable events, manages toolset presets for
permission-sensitive operations, exposes Settings-based memory and workspace
skill editing, and enforces workflow governance policies.

## Source Paths
- `src/governance/`

## Key Files
- `src/governance/AuditStore.ts`: persists auditable events for
  permission-sensitive and workflow-sensitive changes with timestamps,
  actor identification, and event categorization.
- `src/governance/ToolsetPresetStore.ts`: manages named toolset presets that
  constrain which tools are available to agent sessions, supporting preset CRUD
  and activation tracking.

## Runtime Contracts
Audit records are append-only and immutable once written. Toolset presets are
server-managed; model-callable tools respect active toolset policy. Governance
events are recorded for the corresponding state change. Settings memory and
workspace skill edits are explicit user actions; they do not grant model-callable
approval or direct write privileges.

## Edit Guidance
- Add audit or status signals for permission-sensitive changes.
- Keep toolset preset validation near `ToolsetPresetStore`.
- Append new audit event types to the event categorization schema without
  breaking existing event readers.
- Governance data should not be model-callable; it is operator-facing.

## Closest Tests
- `tests/unit/governance-audit-store.test.ts`
- `tests/unit/governance-tool-audit.test.ts`
- `tests/integration/p2-governance-lifecycle.test.ts`
