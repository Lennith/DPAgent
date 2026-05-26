---
name: dpagent-debug-info
description: Collect DPAgent runtime diagnostics for unresolved or intermittent issues such as WebSocket close/no reconnect, frontend cannot open while the port is still occupied, stale active-run/input-lock state, Plan Mode approval not executing, share-link slowness or wrong host, subagent timeout confusion, automation interval behavior, and recent debug log analysis. Use when Codex needs to gather support-ready DPAgent logs, health snapshots, session state, process/port details, and a concise diagnosis bundle from a local or remote DPAgent runtime.
---

# DPAgent Debug Info

Use this skill to collect a read-only diagnostic bundle for DPAgent issues that are still under observation. The goal is evidence collection, not automatic repair.

## Quick Start

Run the bundled collector from this skill directory. Do not assume the target DPAgent is installed at the same path as the agent that is running this skill.

```powershell
node scripts/collect-debug-info.js --base-url http://127.0.0.1:53721 --session-id <optional-session-id>
```

Remote LAN target:

```powershell
node scripts/collect-debug-info.js --base-url http://<dpagent-host>:<port> --session-id <session-id>
```

If the user knows the DPAgent install/log directory on the machine where the collector is running, add `--workspace <path>` or `--log-dir <path>`. For a remote LAN server, local filesystem logs are only collectable when the collector runs on that same machine or the path is mounted locally.

If the server requires full-access login and HTTP calls return 401/403, ask the user to run the command on the same machine as DPAgent, or provide an authenticated cookie/header. Share links are intentionally limited and usually cannot expose full diagnostics.

## What To Collect

Always collect these categories when available:

- `health`: `/api/health`, runtime heartbeat, active runs, event-loop and HTTP diagnostics.
- `runtime`: `/api/system/runtime-info`, package version, cwd, config path, port, install mode.
- `settings`: `/api/settings` with secrets redacted.
- `sessions`: `/api/sessions`, and `/api/sessions/:id` when a session id is known.
- `session controls`: share status, autoloop state, subagent list for the target session.
- `process/port`: process ids listening on the target port plus command-line details where the OS allows it.
- `logs`: recent sanitized tails from explicit `--log-dir`, `--workspace/logs`, current working directory logs, and locally accessible paths discovered from `/api/system/runtime-info`.
- `focused findings`: extracts for `[WebServer]`, `[PlanMode]`, `WS closed`, `Reject chat`, `active run`, `Chat input locked`, `Share URL resolved`, `event loop`, `heartbeat`, `subagent`, `waitTimedOut`, and lock timeout messages.

## Issue-Focused Notes

For frontend cannot open but port is occupied:

- Compare `/api/health` result with process/port evidence.
- Look for event-loop delay, HTTP connection counts, runtime heartbeat age, and recent fatal errors.
- Include the last WebSocket close line before the hang if present.

For stale active-run or input locked:

- Include `/api/sessions` activeRun fields and target `/api/sessions/:id`.
- Look for `Reject chat because session has active run`, `Chat input locked`, run start/finish/finalized lines, and controller websocket ids.

For Plan Mode approval not executing:

- Include target session detail and logs around `[PlanMode] activating approved plan`, `approved plan did not activate`, `ensureTodoDrivenAutoLoop`, `plan_input_response`, and pending plan input expiration.

For share-link slowness or wrong host:

- Include `/api/sessions/:id/share` status and recent `Share URL resolved requestHost=... chosenHost=... reason=...` logs.
- Note whether the user had Clash/proxy enabled when creating the link.

For subagent timeout confusion:

- Include `/api/sessions/:id/subagents`.
- Look for `waitTimedOut`, stale heartbeat diagnostics, lifecycle state, and last result fields.

## Output

The collector creates:

- `summary.json`: normalized inputs, HTTP result status, key warnings, and artifact paths.
- `http/*.json`: raw response bodies when available, with secrets redacted.
- `logs/*.tail.log`: sanitized log tails.
- `logs/focused-findings.log`: selected diagnostic lines.
- `process/*.txt`: port/process command output.
- `dpagent-debug-info-*.zip`: best-effort zip archive when the platform has `Compress-Archive` or `zip`.

When reporting back to the user, include the bundle path, zip path if created, whether the target was local or remote, and a short list of concrete missing evidence or failed HTTP probes. Do not paste secrets, tokens, cookies, or full large logs into chat.
