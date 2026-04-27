# P1 Functional Test

- Date: 2026-04-12
- Validator: independent subagent `Cicero` (`019d8176-448a-76b2-8e9a-fda0adf7c416`)
- Decision: PASS

## Goal

Functionally validate the P1 surface:

1. `todo` CRUD and prompt safety
2. `memory` dedupe, expiry, versioning, and durable promotion behavior
3. repeated-success skill draft suggestion with failure suppression
4. per-session toolset override without mutating the global default
5. subagent inherited tool materialization
6. checkpoint validation without false rollback noise
7. stable queued `allowedTools` plus refreshed `effectiveAllowedTools`
8. adjacent regression safety for context, subagent, Windows shell, and Web settings surfaces

## Scope

- P1 core suites:
  - `npm run test:subagent`
  - `npm run test:subagent-runner`
  - `npm run test:memory-store`
  - `npm run test:todo-store`
  - `npm run test:skill-draft-store-auto`
  - `npm run test:toolset-registry`
  - `npm run test:p1-session-toolset-override`
- Regression suites:
  - `npm run test:context-history-replay`
- `npm run test:compressed-history-context-cache`
  - `npm run test:context-overflow`
  - `npm run test:shell-tool`
  - `npm run test:web-port-config`
  - `npm run test:web-prompt-resolution`
  - `npm run test:web-runtime-watchdog`
  - `npm run test:mcp-runtime-config`
  - `npm run test:web-mcp-status`
- Broad gate:
  - `npm test`
- Build gate:
  - `npm run build:web`

## Passing Evidence

- Todo prompt safety passed: prompt segment is metadata-only and does not leak raw titles or injected text.
- Memory P1 behavior passed: lineage-aware promotion, distinct workflow separation, versioning, expiry derivation, and durable storage behavior all behaved as expected.
- Skill draft auto-suggestion passed: repeated successful turns create a draft, while failures do not generate false drafts.
- Session toolset override passed: session-level override works without mutating the global `defaultToolset`.
- Subagent inheritance passed: task-scoped tool materialization reaches the child runtime through the task registry path.
- Checkpoint validation passed: semantic-state comparison and concurrency gating prevented the previous false rollback path.
- Issue 5 passed: queued or persisted `allowedTools` remain stable while `effectiveAllowedTools` refreshes; the regression test also proves the persisted registry snapshot stays unchanged while runtime execution uses the refreshed list.
- Regression surfaces passed: context replay, compressed history context cache, overflow recovery, shell tool, web port and prompt handling, runtime watchdog, MCP runtime config, and the repo-wide `npm test` gate all succeeded.
- `npm run build:web` succeeded.

## Failures

- None.

## Residual Risks

- Validation was automated and read-only; it did not include a manual browser walkthrough or live external MCP smoke outside the repo’s test harness.
- `npm run build:web` still emits known non-blocking CSS minify warnings and the Vite CJS deprecation warning.
