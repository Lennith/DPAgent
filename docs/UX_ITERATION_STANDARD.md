# UX Iteration Standard (Exploratory, Non-Gating)

This workflow is for functional product iteration and user experience refinement.
It is not the release gate for this repository.

## Goals

- Use a dedicated UX workspace to simulate real user chat behavior.
- Observe and record anomalies instead of enforcing hard pass/fail gates.
- Keep a repeatable closed loop: UX run -> subagent review -> requirement merge -> fix -> smoke.
- Preserve evidence for operator review without turning the loop into a publish decision.

## Principles

1. Keep UX evidence and round artifacts isolated in `ux-workspace/`.
2. Prefer visual interaction evidence (screenshots, traces, UI observations).
3. Treat errors as UX signals first, not immediate hard gates.
4. Preserve context integrity boundary: attempt compression before any trim fallback.
5. Keep test sessions for manual review unless explicitly cleaned by operator.
6. Treat `ux:iterate*` as self-mutating by design: even though evidence lands in `ux-workspace/`, the workflow may still issue fix prompts, touch repo files, and rebuild `dist`.

## Boundary With Release Gate

- This workflow must not be mixed with `publish:standard:preflight` or `publish:standard`.
- Red UX summaries from this workflow are exploratory evidence, not direct release blockers by themselves.
- The maintained UX functional acceptance used in release gating is `npm run smoke:ui`; ownership for that case lives in the release gate standard, not here.
- Do not add version bump, publish, registry smoke, or release announcement steps into this workflow.

## Run Commands

```bash
# Standard iteration
npm run ux:iterate
npm run ux:iterate:dev

# Long-context baseline
npm run ux:long-context:5
npm run ux:long-context:5:dev
```

Use existing dev server directly:

```bash
npm run dev:web
npm run ux:long-context:5:dev
```

## Dev Config Protection

- In `*:dev` mode (reuse existing server), iterate pipeline must not write API key settings.
- If server-side API key is missing, pipeline records anomalies and smoke failures without mutating `config.yaml`.
- Smoke in protected mode validates UI/chat path only and skips settings write.

## Artifacts

Each round writes:

- `ux-workspace/iterations*/round-XX/ux-report.json|md`
- `ux-workspace/iterations*/round-XX/subagent-review.json|md`
- `ux-workspace/iterations*/round-XX/merge-result.json`
- `ux-workspace/iterations*/round-XX/iteration-plan.md`
- `ux-workspace/iterations*/round-XX/fix-execution.json`
- `ux-workspace/iterations*/round-XX/smoke.json`
- `ux-workspace/iterations-long-context/round-XX/long-context-metrics.json` (long-context mode)

Final aggregate:

- `ux-workspace/iterations*/requirements-ledger.json`
- `ux-workspace/iterations*/iteration-summary.md`

## Long-Context Baseline

For long-context validation in this project, use:

- rounds: `5`
- prompts per round: `20`
- assistant total chars per round target: `>= 40000`

Observed signals (not hard gate by default):

- context overflow/truncation events
- pre-compress evidence presence
- tool usage coverage (`web_search`, `web_fetch`, `write_file`, `edit_file`)

## Not In Scope

- No npm packaging quality gate in this UX playbook.
- No publish decision or release sign-off.
- No maintained release evidence beyond exploratory artifacts.
- No architecture migration in UX loop execution.
