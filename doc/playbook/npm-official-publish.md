# NPM Official Publish

This playbook publishes the public npm package to the official registry:

```text
https://registry.npmjs.org
```

Package:

```text
@dpvr/dpagent
```

NPM official publish repacks the built runtime with sanitized package metadata and publishes the public package name. Internal mirror procedures, if needed, live under `doc/internal/`.

## Login

Do not put npm tokens in repository files, scripts, logs, or chat. Use the npm CLI login flow or a user-level npm config.

```bash
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
```

The logged-in account must own the `dpvr` npm organization or have publish rights for `@dpvr/dpagent`.

## Preflight

```bash
npm run publish:npm-official:preflight
```

Preflight checks the clean worktree, official npm auth, version availability, fresh web build, sanitized package metadata, real pack output, and package contents. It does not publish.

The npm script passes `--skip-release-gate` because official npm publish is a registry publication step after the source gate has passed. To force a fresh release evidence check for the current commit, run `node scripts/npm-official-publish.js --mode preflight` directly.

## Publish

```bash
npm run publish:npm-official
```

The publish command runs the same checks, installs the generated tarball in a temporary workspace, verifies the startup smoke, publishes with:

```bash
npm publish <tarball> --registry https://registry.npmjs.org --access public
```

Then it installs `@dpvr/dpagent@<version>` from the official registry and runs the same registry smoke.

## Beta Publish

```bash
npm run publish:npm-official:beta:preflight
npm run publish:npm-official:beta
```

Prerelease versions must use an explicit non-`latest` dist-tag such as `beta`.

## Sanitized Package Metadata

The official npm tarball rewrites package metadata:

- `name` becomes `@dpvr/dpagent`.
- `publishConfig` points to `https://registry.npmjs.org` with `access: public`.
- `internalPublish`, private publish scripts, development scripts, and `devDependencies` are omitted from the public package metadata.

The file allowlist and forbidden runtime paths stay aligned with the public package allowlist.
