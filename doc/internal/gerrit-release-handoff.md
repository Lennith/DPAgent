# Gerrit Release Handoff

## Branch
Start from latest `master` unless the user requests another base:

```bash
git fetch origin
git checkout master
git pull --ff-only
git checkout -b codex/<short-topic>
```

## Staging
Use path-specific staging:

```bash
git add doc package.json package-lock.json
```

Do not stage local config, runtime data, logs, workspaces, or generated evidence
unless the playbook explicitly says the file is source.

## Commit
Every key-node commit uses signoff and a unique Gerrit Change-Id:

```bash
git commit -s
```

The commit message must describe the product or maintenance boundary. For
follow-up amendments, preserve or intentionally replace the Change-Id according
to the Gerrit review target.

## Review Gate
Use subagent review when requested. P0 and P1 findings block the next node. P2
findings are fixed by default or recorded in the handoff with an explicit risk
decision.

## Push
Push only to Gerrit review:

```bash
git push origin HEAD:refs/for/master
```

Do not push directly to `master`.

## Release Handoff Template
```text
Commit:
Version:
Gerrit change:
Source gate:
E2E evidence:
Toolcall gate evidence:
Manual review:
Publish command:
Registry smoke:
Local config/profile excluded:
Residual risks:
```
