# UX Iteration Standard

## Purpose
UX iteration commands simulate product usage and generate exploratory evidence.
They are useful for discovering issues but are not release gates.

## Commands
```bash
npm run ux:iterate
npm run ux:iterate:dev
npm run ux:long-context:5
npm run ux:long-context:5:dev
npm run ux:ui-focused
```

`*:dev` variants reuse an existing server and must not write API key settings.

## Artifacts
UX artifacts belong under:

```text
ux-workspace/
```

Typical files include reports, screenshots, iteration plans, subagent reviews,
merge results, smoke output, and long-context metrics.

## Boundary With Release
Do not use UX iteration summaries as direct publish approval. The maintained UX
acceptance inside the release gate is `npm run smoke:ui` or the built variant
called from `release:source-gate`.

## Principles
- Keep UX artifacts isolated from source commits.
- Prefer visual and transcript evidence.
- Treat UX anomalies as product signals.
- Convert accepted findings into source changes and then run maintained tests.
- Do not add version bump, publish, or registry smoke steps to UX iteration.
