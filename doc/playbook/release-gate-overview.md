# Release Gate Overview

## Purpose
The release gate verifies a source commit before a GitHub Release or npm publication. It is not an exploratory UX loop and must not include product-iteration prompts.

## Maintained Commands
```bash
npm run release:source-gate
npm run publish:npm-official:preflight
```

`release:source-gate` verifies source state. `publish:npm-official:preflight` verifies public package readiness without publishing.

## Source Gate Contents
`npm run release:source-gate` runs:

1. `npm test`
2. `npm run build:web`
3. `npm run smoke:ui:built`
4. `npm run test:release-e2e`
5. `npm run test:release-toolcall-context-session`

The source gate emits evidence under:

```text
logs/release-gate-e2e/
logs/release-gate-toolcall-context-session/
```

The evidence source commit must match the commit being released unless the manual review explicitly approves a release-process-only reuse exception.

## Publish Preflight Contents
`npm run publish:npm-official:preflight` validates:

- clean worktree
- npm auth
- version availability
- fresh `build:web`
- sanitized package metadata
- one real `npm pack --json`
- package contents and forbidden runtime paths
- local tarball install smoke

It must not rerun source-state tests, browser smoke, long-context gates, or exploratory UX workflows.

## Non-gates
The `ux:iterate*`, `ux:long-context*`, and `ux:ui-focused*` commands are exploratory product loops. Their evidence can inform fixes, but it is not release sign-off.

## Failure Policy
Any failed maintained gate blocks release. Fix the root cause and rerun the affected gate. If source code, UI, package contents, LLM protocol, automation, runtime behavior, or test expectations change after a passing source gate, rerun `npm run release:source-gate`.

The source gate includes low-cost source-contract unit tests for hook loading, ASR/share controls, automation claim behavior, subagent cancellation/timeout contracts, and npm package allowlists. These tests keep release documentation and package scripts aligned with the maintained gates.

## Handoff Evidence
A release handoff records:

- commit SHA
- package version and GitHub tag
- CI workflow URL
- source-gate command and result
- E2E evidence files
- toolcall gate evidence and manual review when used
- publish or preflight command and result
- confirmation that local config and profiles were not committed
