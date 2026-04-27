# Release Gate Standard

Registry: `http://10.100.1.10:4873`

This standard is mandatory for internal npm releases in this repository. It is the maintained release gate and must not be mixed with exploratory UX iteration.

## Gate Identity

- The standard release path is:
  - source-state regression: `npm test`, `npm run build:web`, `npm run smoke:ui`, `npm run test:release-toolcall-context-session`
  - publish proof: `npm run publish:standard`
- `publish:standard` performs the publish action only after proof exists: clean worktree check, release evidence check, npm auth check, one fresh `build:web`, one real `npm pack --json`, package file audit, publish, and post-publish registry install smoke.
- `publish:standard` must not rerun source-state tests, browser smoke, long-context gate, dry-run pack, or tarball install smoke.
- `publish:standard:preflight` is optional local rehearsal. It is not a required stage before `publish:standard`.
- Exploratory workflows such as `ux:iterate*`, `ux:long-context*`, and `ux:ui-focused*` are not release gates.
- `publish:private` or raw `npm publish` are troubleshooting paths only and do not satisfy this standard.

## Mandatory Rules

1. User usability must be evaluated before publish.
- Package must expose a real user entrypoint (`bin` or `start`), not only internal hooks.
- README-level first-run command is `npx minimax-agent`.
- Release smoke uses `npx minimax-agent --no-open`.

2. Source-state regression must pass before publish.
- Run `npm test`.
- Run `npm run build:web`.
- Run `npm run smoke:ui`.
- Run `npm run test:release-toolcall-context-session`.
- `npm run smoke:ui` is standalone-safe and always refreshes `dist` before browser validation. `npm run release:source-gate` may call the built-only variant internally after an explicit `build:web`.
- `npm run build:web` already cleans `dist`, builds the web client, and runs `tsc`; do not add separate `npm run build` or `npx tsc --noEmit` steps to the release gate.
- The 3 profile x 20 round long-context gate uses a 15 minute timeout per profile run.
- If the source commit changes after this gate, rerun `npm run release:source-gate` by default.
- A source-gate reuse exception is allowed only when a reviewer confirms the new diff is release-process-only and cannot affect runtime, UI, automation, LLM, package contents, or test logic. The manual review JSON must then set `reviewedCommitSha` to the current commit and add:
  - `sourceGateReuse.approved: true`
  - `sourceGateReuse.scope: "release-process-only"`
  - `sourceGateReuse.previousReviewedCommitSha` equal to the aggregate `sourceCommitSha`
  - `sourceGateReuse.currentCommitSha` equal to current `HEAD`
  - non-empty `diffScope`, `skippedCommands`, and `rationale`
- This exception must not be used for business logic, runtime behavior, browser UI, automation behavior, LLM protocol handling, or test expectation changes.

3. Publish target must be explicit.
- Must publish to internal registry: `http://10.100.1.10:4873`.
- `publishConfig.registry` and release script config must match.

4. Package must be sanitized.
- Runtime or sensitive files must not be included:
  - `runtime/`, `sessions/`, `contexts/`, `logs/`, `workspace/`, `release-toolcall-profiles.dev.json`, `release-toolcall-profiles.local.json`, `.env`
- `publish:standard` validates this from the single real `npm pack --json` result that is used for publish; do not add a separate mandatory `publish:dry-run`.

5. Publish-stage tests are not repeated.
- Local run verification belongs to `npm run release:source-gate`.
- If the current commit already has approved source gate evidence, `npm run publish:standard` must publish without repeating tarball smoke or browser smoke.
- `publish:standard` still performs one fresh `build:web` so the tarball matches the current clean source tree and does not rely on stale `dist/` output.

6. Post-publish install smoke is part of the standard publish command.
- `publish:standard` installs the just-published package from the internal registry and runs the maintained no-open startup smoke.
- This is the only install smoke in the standard flow; do not add a duplicate pre-publish tarball install smoke.

7. One maintained UX functional acceptance case is part of the gate.
- Use `npm run smoke:ui`.
- This case must validate the real browser chat path:
  - root page loads
  - send button is visible and usable
  - one chat prompt can be sent
  - assistant output renders non-empty content
  - UI returns to ready state after the run

8. One maintained long-context tool replay case is part of the gate.
- Use `npm run test:release-toolcall-context-session`.
- This case runs 3 provider/profile workflows: `kimi`, `deepseek`, and `minimax`.
- The committed dev profile file is `release-toolcall-profiles.dev.json`; local-only overrides may use `release-toolcall-profiles.local.json`.
- `kimi` may omit a concrete model in the profile file; the gate uses the release default `Kimi-k2.6`. `deepseek` must use `deepseek-v4-flash`.
- Each profile workflow runs 20 tool-heavy continuity rounds and saves a structured run report plus an aggregate gate report.
- Each profile workflow must complete within 15 minutes.
- The gate model field is `multi-profile`; the concrete model for each provider is recorded per run.
- Each profile run must reach at least 90% accuracy (`>=18/20` rounds correct). Any profile below threshold blocks release.
- The gate must emit:
  - `logs/release-gate-toolcall-context-session/release-toolcall-context-gate.json`
  - `logs/release-gate-toolcall-context-session/release-toolcall-context-gate.md`
  - `logs/release-gate-toolcall-context-session/release-toolcall-context-manual-review.json`
- The aggregate JSON must record the exact source commit SHA used for the multi-profile gate run.
- Release review must inspect run metrics, failure flags, field mismatches, tool-call continuity, cascade failures, completion-marker repairs, and material correctness.
- The manual review record must include reviewer, reviewedAt, reviewed commit SHA, reviewed session ids, required runs, rounds per run, model field, profile list, checklist approvals, and `conclusion: "approved"`.
- `seriousHallucinationFound` and `scriptFalsePositivePassFound` must both be `false`.
- Missing, incomplete, stale, or mismatched manual review evidence blocks `publish:standard`.

9. Smoke test must follow user workflow strictly.
- Do not bypass with dev hooks, local source path hacks, or hidden env overrides that users do not use.
- `npm run smoke:ui` is the maintained browser smoke. Do not add another browser smoke inside `publish:standard`.

10. Do not add feature-iteration items into the release gate.
- No fix-prompt loop.
- No requirement merge loop.
- No exploratory UX round outputs as release evidence.
- Release gate verifies a candidate version; it does not run product iteration.

11. Do not modify business code just to pass publish.
- Release scripts, docs, config, and gate wiring updates are allowed.
- Runtime behavior changes require normal product review, not release-only hot edits.

## Standard Commands

Source-state regression:

```bash
npm run release:source-gate
```

Optional local publish rehearsal:

```bash
npm run publish:standard:preflight
```

Full standard release:

```bash
npm run publish:standard
```

## Failure Policy

- Any failed gate blocks release.
- Fix root cause, then rerun the affected standard command.
- Never replace the gate with manual publish or exploratory UX evidence.
- When the current commit already has approved source gate evidence, do not rerun the same tests during publish. Publish-stage failures should be limited to evidence, auth, package audit, or registry publish errors.
