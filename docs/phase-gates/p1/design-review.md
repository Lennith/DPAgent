# P1 Design Review

- Date: 2026-04-12
- Validator: independent subagent `Turing` (`019d8176-2adc-7b01-91a9-3ad5957db9ac`)
- Decision: PASS

## Goal

Confirm the P1 implementation matches the approved scope without leaking into P2, preserves the Windows-first boundary, and fully fixes the five previously reported blockers:

1. subagent allow-listed tool materialization mismatch
2. coarse memory lineage collapsing unrelated workflows
3. raw todo title prompt injection
4. checkpoint false positives under concurrent subagents
5. queued or persisted `allowedTools` drift after later policy changes

## Scope

- Reviewed task-scoped subagent tool materialization in `src/subagent/SubAgentTurnRunner.ts` and `src/index.ts`.
- Reviewed memory lineage derivation and persistence in `src/memory/MemoryStore.ts`.
- Reviewed todo prompt shaping in `src/todo/TodoStore.ts`.
- Reviewed checkpoint validation and concurrency gating in `src/context/ContextManager.ts` and `src/subagent/SubAgentManager.ts`.
- Reviewed the stable `allowedTools` plus runtime `effectiveAllowedTools` split in `src/subagent/SubAgentManager.ts`, `src/types.ts`, and `tests/unit/subagent-manager.test.ts`.
- Reviewed defaults and compatibility boundaries in `config.yaml` and Web settings handling.

## Evidence

- Issue 1 fixed: `SubAgentTurnRunner` now accepts `getTaskToolRegistry`, and `MiniMaxAgent` supplies a per-turn execution registry before child execution. Child runtime filtering now operates on the executable task registry instead of assuming the main registry matches the task.
- Issue 2 fixed: memory auto-promotion now derives a lineage seed from prompt, final output, commands, and checklist signals, then persists `lineageKey` and `lineageId` without collapsing distinct workflows into a single bucket.
- Issue 3 fixed: todo prompt surface is metadata-only; raw todo titles no longer enter the system prompt segment.
- Issue 4 fixed: checkpoints compare semantic event streams and skip checkpoint noise, while concurrent subagent validation is gated to avoid sibling-write false positives.
- Issue 5 fixed: `SubAgentManager` now derives a separate `executionTask` at runtime instead of mutating the queued task object. Stable stored `allowedTools` remain on the record, while `effectiveAllowedTools` are computed separately for status and runtime enforcement.
- Windows-first boundary remains intact: defaults stay on `windows-dev`, `memoryWriteMode=confirm`, `skillWriteMode=confirm`; no WSL2-only, native SQLite, or cloud sandbox dependency was introduced.

## Validation Run

- `npm test`
- `npm run test:subagent`
- `npm run test:memory-store`
- `npm run test:todo-store`
- `npm run test:p1-session-toolset-override`
- `npm run build:web`

All commands passed in the reviewed state.

## Findings

- None.

## Residual Risks

- `npm run build:web` still emits existing CSS minify warnings and the Vite CJS deprecation warning. They are noisy but non-blocking.
- This review was read-only and test-driven; it did not add extra live browser or external MCP smoke beyond existing automated coverage.
