# Private NPM Publish Guide

This project publishes to the internal registry:

- Registry: `http://10.100.1.10:4873`
- Package name: `@dpvr/minimax-agent`

The maintained release gate is defined in [INTERNAL_NPM_PUBLISH_STANDARD.md](./INTERNAL_NPM_PUBLISH_STANDARD.md).

## 1. Login

```bash
npm login --registry http://10.100.1.10:4873
```

## 2. Source-State Regression

```bash
npm run release:source-gate
```

This runs the maintained source regression sequence:

- `npm test`
- `npm run build:web`
- `npm run smoke:ui`
- `npm run test:release-toolcall-context-session`

`npm run smoke:ui` is standalone-safe and refreshes `dist` before browser validation. `npm run release:source-gate` may use the built-only variant internally because it already ran `build:web` in the same command chain.

`npm run build:web` already performs the TypeScript build after the web build, so the release flow does not require separate `npm run build` or `npx tsc --noEmit` commands.

The long-context gate remains 3 profiles x 20 rounds with a 90% pass threshold. Each profile run has a 15 minute timeout.

Before publishing, the multi-profile 20-round gate must have produced approved evidence under `logs/release-gate-toolcall-context-session/`:

- `release-toolcall-context-gate.json`
- `release-toolcall-context-gate.md`
- `release-toolcall-context-manual-review.json`

The manual review JSON must record reviewer, reviewedAt, reviewed commit SHA, reviewed session ids, run counts, rounds per run, model field, profile list, checklist approvals, `conclusion: "approved"`, `seriousHallucinationFound: false`, and `scriptFalsePositivePassFound: false`.

The committed dev profile file is `release-toolcall-profiles.dev.json`. It is used by default for the multi-profile gate, is forbidden from npm package contents, and may contain dev-only test credentials. `release-toolcall-profiles.local.json` is still a local-only override and stays out of version control. Use [release-toolcall-profiles.local.example.json](./release-toolcall-profiles.local.example.json) as the local override template.

Profile model rules:

- `kimi` may omit `model`; the gate uses the release default `Kimi-k2.6`.
- `deepseek` must use `deepseek-v4-flash`.
- `minimax` uses `MiniMax-M2.7-highspeed`.

If only release-process files changed after a passing source-state regression, a reviewer may explicitly reuse the previous source gate instead of rerunning it. This is limited to changes that cannot affect runtime behavior, browser UI, automation behavior, LLM protocol handling, package contents, or test expectations. In that case the manual review JSON must set `reviewedCommitSha` to current `HEAD` and include:

```json
{
  "sourceGateReuse": {
    "approved": true,
    "scope": "release-process-only",
    "previousReviewedCommitSha": "<aggregate sourceCommitSha>",
    "currentCommitSha": "<current HEAD>",
    "diffScope": ["docs/private-npm-publish.md"],
    "skippedCommands": ["npm run release:source-gate"],
    "rationale": "Release process documentation only; previous source regression still applies."
  }
}
```

## 3. Publish

Standard release:

```bash
npm run publish:standard
```

`publish:standard` is the only required publish command. It validates a clean worktree, release evidence, npm auth, package entrypoint, README first-run command, and the file list from one real `npm pack --json`, then publishes that tarball and runs one post-publish registry install smoke.

`publish:standard` performs one fresh `build:web` before packing so the tarball always matches the current clean source tree. It does not rerun `smoke:ui`, the long-context gate, dry-run pack, or tarball install smoke. If the current commit already has approved source-state evidence, publish directly and do not repeat those tests in the publish step.

Optional local rehearsal:

```bash
npm run publish:standard:preflight
```

Do not require `publish:standard:preflight` before every release. Use it only when you want a local rehearsal without publishing.

Troubleshooting only:

```bash
npm run publish:private
```

`publish:private` and raw `npm publish` do not satisfy release sign-off.

## 4. Existing Version

If the target version already exists in the registry:

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -s -m "chore: bump version"
npm run release:source-gate
npm run publish:standard
```

If the source commit changes after the long-context evidence was generated, regenerate or re-approve the affected evidence so the reviewed commit SHA matches the aggregate source commit SHA.

If the only post-gate change is release-process-only and manual review approves `sourceGateReuse`, do not rerun the full source gate. Run `npm run publish:standard` directly for the current commit.

## 5. Install

```bash
npm i @dpvr/minimax-agent --registry http://10.100.1.10:4873
npx minimax-agent
```

`npx minimax-agent` is the required first-run initialization command. The maintained browser smoke remains `npm run smoke:ui` inside source-state regression.

## Notes

- Auth tokens stay in user-level npm config, not in this repo.
- The maintained UX functional acceptance in the release gate is `npm run smoke:ui`.
- Do not use `ux:iterate*`, `ux:long-context*`, or `ux:ui-focused*` as release proof.
