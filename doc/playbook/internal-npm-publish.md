# Internal NPM Publish

## Registry
```text
http://10.100.1.10:4873
```

Package:

```text
@dpvr/dpagent
```

## Login
```bash
npm login --registry http://10.100.1.10:4873
```

## Standard Publish
```bash
npm run publish:standard
```

`publish:standard` checks the clean worktree, release evidence, npm auth,
package entrypoint, README first-run command, fresh build, real pack output,
package contents, local tarball install smoke, publish, and post-publish
registry install smoke.

The command publishes to the internal registry with the default dist-tag.

## Beta Publish
```bash
npm run publish:standard:beta
```

Beta uses the same checks and publishes with the `beta` dist-tag. Optional local
rehearsal:

```bash
npm run publish:standard:beta:preflight
```

## Optional Rehearsal
```bash
npm run publish:standard:preflight
```

Preflight is optional. It is not required when the source gate evidence is
already valid and the user asked to publish.

## Forbidden Package Paths
The npm package is intentionally allowlisted. It includes built output, ASR
setup scripts, the `dpagent-assistant` bundled agent, the user guide, README,
and license files. Other bundled development agents stay source-only unless the
package allowlist is explicitly changed.

The package must not include:

```text
runtime/
sessions/
contexts/
logs/
workspace/
release-toolcall-profiles.dev.json
release-toolcall-profiles.local.json
.env
```

## Version Already Exists
If npm reports that the version was already published:

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -s -m "chore: bump version"
npm run release:source-gate
npm run publish:standard
```

The new commit needs fresh or explicitly reusable source-gate evidence.

## Install Check
After publish, consumers install with:

```bash
npm i @dpvr/dpagent --registry http://10.100.1.10:4873
npx dpagent
```
