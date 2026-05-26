# Local Config And Profile Hygiene

## Purpose
Local credentials and environment-specific release profiles must never become
source, package, or handoff artifacts.

## Local-only Files
Do not commit:

```text
config.yaml
.env
release-toolcall-profiles.dev.json
release-toolcall-profiles.local.json
logs/
runtime/
contexts/
workspace/
workspace-smoke-default/
ux-workspace/
dist/
```

`config.yaml` may be modified locally during development. It must be clean or
absent from the publish worktree before `publish:standard`.

## Profile Rule
Release toolcall profiles are local or environment-specific. They may contain
credentials, model routing, or provider-specific test settings. They are used to
run the gate locally, but they are not committed and are forbidden in npm pack
contents.

## Checks
Before staging or publishing:

```bash
git status --short --ignored
```

Confirm source changes are intentional and runtime/local files are not staged.

Before publish:

```bash
npm run release:source-gate
npm run publish:standard
```

`publish:standard` enforces a clean worktree. If local config changes are
needed for testing, use a separate clean publish worktree for the publish step.

## Handoff Wording
State that local config/profile files were used only as local environment
inputs and were not committed or packaged.
