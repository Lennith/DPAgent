# Memory Runtime

## Responsibility
Memory runtime provides durable, scoped key-value persistence for stable
reusable facts across sessions. It includes observation-based promotion from
session transcripts and a raw transcript search index.

## Source Paths
- `src/memory/`
- `src/tools/MemoryTool.ts`
- `src/tools/SessionSearchTool.ts`

## Key Files
- `src/memory/MemoryStore.ts`: persistent CRUD for `MemoryEntry` records scoped
  to `workspace` or `user`, with versioning, deduplication, search, and
  prompt-segment generation.
- `src/memory/MemoryPromotionCoordinator.ts`: observes agent turns and promotes
  reusable facts from session context into durable memory.
- `src/memory/SessionSearchIndex.ts`: raw transcript search index for retrieval
  across prior session transcripts.
- `src/memory/memory-store-contracts.ts`: TypeScript types and interfaces for
  memory entries, scopes, and search results.
- `src/memory/memory-store-utils.ts`: utility functions for memory entry
  normalization, deduplication, and prompt formatting.
- `src/memory/memory-promotion-contracts.ts`: contracts for memory promotion
  rules and triggers.
- `src/memory/memory-promotion-utils.ts`: utilities for candidate extraction
  from conversation turns.
- `src/tools/MemoryTool.ts`: model-callable tool for reading and writing
  durable memory.
- `src/tools/SessionSearchTool.ts`: model-callable tool for searching prior
  session transcripts.

## Runtime Contracts
Memory stores stable reusable facts, not raw logs or transient session state.
Entries are scoped (`workspace` or `user`) and versioned. Promotion from
session transcripts follows configurable rules; promoted entries remain drafts
until explicitly confirmed. Session search operates on indexed transcript data
and is read-only.

## Edit Guidance
- Keep memory classification (promotion rules) separate from memory storage
  (CRUD operations).
- Add new memory scope types only when clear lifetime and isolation rules exist.
- Update prompt-segment generation when memory entry schema changes.
- Session search index rebuilds should not block active sessions.

## Closest Tests
- `tests/unit/memory-store.test.ts`
- `tests/integration/p0-session-transcript-search.test.ts`
- `tests/unit/web-memory-organize-route.test.ts`
- `tests/unit/web-memory-organize-ui.test.ts`
