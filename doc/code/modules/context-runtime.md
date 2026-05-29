# Context Runtime

## Responsibility
Context stores durable event history, projects structured state, assembles replay
messages, manages compaction, and persists interrupted-turn checkpoints.

## Source Paths
- `src/context/`
- `src/runtime/context-replay-assembly.ts`
- `src/runtime/context-replay-utils.ts`
- `src/runtime/context-reduction-policy.ts`
- `src/runtime/compression-chunks.ts`
- `src/compression/`

## Key Files
- `src/context/ContextManager.ts`: transaction owner for begin, record, commit, rollback, and interrupted artifacts.
- `src/context/ContextEventStore.ts`: event and metadata persistence.
- `src/context/ContextProjector.ts`: event-to-state projection.
- `src/runtime/context-replay-assembly.ts`: replay and compressed-history assembly.
- `src/runtime/context-replay-utils.ts`: replay helper functions.
- `src/runtime/context-reduction-policy.ts`: context reduction and compaction policy helpers.
- `src/runtime/compression-chunks.ts`: compression chunk planning.
- `src/compression/`: compression helpers and budget behavior.

## Runtime Contracts
Event history is the source of truth. Replay assembly may compress older
history, but it cannot rewrite current user intent or fabricate tool outcomes.
Interrupted artifacts are durable recovery metadata.

Session fork copies only stable committed session state: event JSONL and
tool-result artifacts. It does not copy active runs, pending plan input,
share/runtime attachments, automation state, runtime errors, auto-loop state, or
interrupted-turn files.

## Edit Guidance
- Keep transaction boundaries in `ContextManager`.
- Keep projection logic deterministic from events.
- Treat corrupt or partial state as a safe-failure path.
- Update [interrupted run recovery protocol](../../spec/protocols/interrupted-turn-recovery-protocol.md) for checkpoint semantics.

## Closest Tests
- `tests/unit/context-history-replay.test.ts`
- `tests/unit/session-fork.test.ts`
- `tests/unit/context-payload-projector.test.ts`
- `tests/unit/compressed-history-context-cache.test.ts`
- `tests/integration/persistence.test.ts`
- `tests/integration/compression.test.ts`
