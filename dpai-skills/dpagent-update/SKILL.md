---
name: dpagent-update
description: Upgrade the currently running DPAgent npm installation through the local/full-access runtime API. Use when a DPAgent runtime agent should discover its own server path, shut the server down, npm install the latest package, restart DPAgent, and verify the web frontend loads.
---

# DPAgent Update

Use this skill only from a DPAgent runtime that can access the full server API. Share links cannot use the update API.

## Workflow

1. Diagnose the running server:
```bash
node scripts/run.js diagnose --base-url http://127.0.0.1:53721 --output json
```
2. Review the generated plan:
```bash
node scripts/run.js plan --target-version latest --output json
```
3. Run a dry-run first:
```bash
node scripts/run.js start --target-version latest --dry-run true --output json
```
4. Apply only after the user wants the upgrade:
```bash
node scripts/run.js start --target-version latest --confirm yes --output json
```
5. Poll the returned status file:
```bash
node scripts/run.js status --status-file <status-file-from-start-command> --output json
```

## Rules

- The skill supports npm-installed DPAgent. Source checkouts are refused unless `--allow-source true` is explicitly supplied.
- The worker process is detached before `/api/system/shutdown`; this is intentional so the updater survives server shutdown.
- Non-dry-run writes require `--confirm yes`.
- Use `--registry` to override npm registry; default is the official npm registry (`https://registry.npmjs.org`) unless `DPAGENT_NPM_REGISTRY` is set by the operator.
- Output defaults to JSON and errors use `{ success:false, error:{ code,message,details } }`.
