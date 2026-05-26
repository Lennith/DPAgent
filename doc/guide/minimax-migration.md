# MiniMax Agent To DPAgent Migration

This guide is for users upgrading from the old MiniMax Agent package to
DPAgent 2.x.

The rename is a breaking package and CLI rename. Existing installations of
`@dpvr/minimax-agent` do not upgrade in place with `npm update`; install the new
package and update local commands, scripts, and imports.

MiniMax model provider settings are not renamed. Keep provider credentials and
model names such as `MINIMAX_API_KEY`, `MINIMAX_API_BASE`,
`https://api.minimaxi.com`, `https://api.minimax.io`, `MiniMax-M2.7`, and
`MiniMax-M2.7-highspeed` unchanged.

## What Changed

| Old | New |
| --- | --- |
| `@dpvr/minimax-agent` | `@dpvr/dpagent` |
| `npx minimax-agent` | `npx dpagent` |
| `dist/cli/minimax-agent.js` | `dist/cli/dpagent.js` |
| `Run-MiniMax.bat` | `Run-DPAgent.bat` |
| `MiniMaxAgent` | `DPAgent` |
| `MiniMaxRunOptions` | `DPAgentRunOptions` |
| `MiniMaxRunResult` | `DPAgentRunResult` |
| `minimaxRun` | `dpagentRun` |
| `X-MiniMax-Client-Kind` | `X-DPAgent-Client-Kind` |

## Upgrade An Installed Package

Remove the old package and install the new package explicitly:

```bash
npm remove @dpvr/minimax-agent
npm install @dpvr/dpagent --registry http://10.100.1.10:4873
npx dpagent
```

For global installs:

```bash
npm uninstall -g @dpvr/minimax-agent
npm install -g @dpvr/dpagent --registry http://10.100.1.10:4873
dpagent
```

If your project uses `package-lock.json`, commit the lockfile update after the
new dependency is installed.

## Update Local Scripts

Replace old commands in `package.json`, `.bat` files, CI jobs, and operator
notes:

```diff
- npx minimax-agent --no-open
+ npx dpagent --no-open

- node dist/cli/minimax-agent.js
+ node dist/cli/dpagent.js

- Run-MiniMax.bat
+ Run-DPAgent.bat
```

CLI subcommands keep the same behavior under the new executable:

```bash
npx dpagent init
npx dpagent exec --session-id my-session "Summarize the workspace"
```

## Update SDK Imports

Replace old public facade names:

```diff
- import { MiniMaxAgent, minimaxRun } from '@dpvr/minimax-agent';
- import type { MiniMaxRunOptions, MiniMaxRunResult } from '@dpvr/minimax-agent';
+ import { DPAgent, dpagentRun } from '@dpvr/dpagent';
+ import type { DPAgentRunOptions, DPAgentRunResult } from '@dpvr/dpagent';
```

`createAgent`, `getSession`, `listSessions`, and session helper exports keep
their public names, but they now return or operate on `DPAgent`.

## Update Product Environment Variables

Only product/runtime environment variables were renamed:

| Old | New |
| --- | --- |
| `MINIMAX_PORT` | `DPAGENT_PORT` |
| `MINIMAX_ALLOW_MISSING_API_KEY_AT_BOOT` | `DPAGENT_ALLOW_MISSING_API_KEY_AT_BOOT` |
| `MINIMAX_AGENT_SERVER_URL` | `DPAGENT_SERVER_URL` |
| `MINIMAX_WINDOWS_NODE_RUNTIME_DIR` | `DPAGENT_WINDOWS_NODE_RUNTIME_DIR` |

Do not rename provider variables:

```text
MINIMAX_API_KEY
MINIMAX_API_BASE
MINIMAX_API_HOST
MINIMAX_MODEL
MINIMAX_PROVIDER
MINIMAX_MAX_OUTPUT_TOKENS
```

These still describe the MiniMax-compatible model provider, not the DPAgent
product name.

## Preserve Existing Config And Sessions

Existing `config.yaml` files remain valid when they use explicit paths such as:

```yaml
agent:
  contextDir: ./contexts
  runtimeDataDir: ./runtime
```

If your old config omitted `agent.contextDir` or `agent.runtimeDataDir`, the old
runtime may have used `workspace/.minimax/...` defaults. DPAgent uses
`workspace/.dpagent/...` defaults. To keep old sessions, choose one of these
approaches:

1. Keep the old paths explicitly in `config.yaml`:

   ```yaml
   agent:
     contextDir: ./workspace/.minimax/contexts
     runtimeDataDir: ./workspace/.minimax/runtime
   ```

2. Or copy the old data into the new default directories before first DPAgent
   run:

   ```powershell
   New-Item -ItemType Directory -Force .\workspace\.dpagent | Out-Null
   Copy-Item -Recurse .\workspace\.minimax\contexts .\workspace\.dpagent\contexts
   Copy-Item -Recurse .\workspace\.minimax\runtime .\workspace\.dpagent\runtime
   ```

Do not copy `logs/`, `dist/`, or temporary workspace outputs as migration data.

## Web And CLI Session Behavior

Web sessions, CLI observe-only sessions, Plan Mode, Ralph/Todo continuation,
and release gates keep their behavior. The visible product label changes to
DPAgent.

Custom CLI or WebSocket integrations must send the new client-kind header:

```http
X-DPAgent-Client-Kind: cli
```

Remote-access browser cookies use the new DPAgent product name, so users may
need to log in again after the upgrade.

## Verify The Migration

Run these checks after updating commands and imports:

```bash
npx dpagent --no-open
npm run build
npm test
```

For package consumers, verify the installed package resolves the new version:

```bash
npm ls @dpvr/dpagent
npm view @dpvr/dpagent@2.0.0 version --registry http://10.100.1.10:4873
```

If `npx minimax-agent` still appears in logs, scripts, or documentation after
the migration, update that caller to `npx dpagent`.
