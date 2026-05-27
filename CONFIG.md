# DPAgent Configuration

DPAgent reads runtime settings from `config.yaml`. The repository commits only `config.example.yaml`; copy it locally and keep the real `config.yaml` out of git.

```bash
cp config.example.yaml config.yaml
```

PowerShell:

```powershell
Copy-Item config.example.yaml config.yaml
```

## Safe Default

The example and runtime defaults use a conservative posture:

```yaml
agent:
  workspaceDir: ./workspace
  contextDir: ./contexts
  runtimeDataDir: ./runtime
  globalAgentsDir: ./agents
  defaultToolset: windows-safe

tools:
  enableFileTools: true
  enableWeb: false
  enableShell: false

mcp:
  enabled: false
  servers: []

remoteAccessAuth:
  enabled: false
```

`windows-safe` is read-heavy. It allows file read/glob/grep, tool result read, context, memory, session search, Todo, skill catalog, and plan input/finalization. It does not expose shell, write/edit, web, MCP unknown tools, file download, skill writes, automation scheduling, or subagent delegation.

## Opt-In Toolsets

Use explicit toolsets when the workspace and prompt are trusted:

- `windows-safe`: default read-heavy mode.
- `windows-dev`: adds file write/edit, shell, skill writes, subagents, automation, and file download.
- `research`: adds web search/fetch to the development toolset.
- `full-access`: hidden escape hatch for trusted maintainers; disables workspace sandbox checks and allows unknown MCP tools.

To opt in for local development:

```yaml
agent:
  defaultToolset: windows-dev

tools:
  enableShell: true
```

Do not enable `full-access` in shared examples or default project configs.

## LLM Profiles

Configure at least one profile:

```yaml
llmProfiles:
  defaultProfileId: default
  profiles:
    - id: default
      name: Default Profile
      provider: anthropic
      apiKey: YOUR_API_KEY
      apiBase: https://api.minimaxi.com
      defaultModel: MiniMax-M2.7-highspeed
      maxOutputTokens: 32768
```

Do not commit real API keys. Prefer environment-specific local config files or secret managers for shared machines.

## MCP

MCP is disabled unless both `mcp.enabled: true` and at least one server are configured. MCP servers run as local child processes and can inherit environment variables depending on their command and env block.

```yaml
mcp:
  enabled: true
  servers:
    - name: example-mcp
      type: stdio
      command: npx
      args: ["example-mcp-server"]
```

## Remote Access

Remote access auth is disabled in the example. If enabled, use a strong password, keep `trustProxy` false unless a trusted reverse proxy sets headers correctly, and read [SECURITY.md](SECURITY.md) first.

## Validation

After config-sensitive changes, run the closest relevant checks:

```bash
npm run build
npm run test:toolset-registry
npm run test:execution-tool-registry-gating
```

Release candidates follow [release gate overview](doc/playbook/release-gate-overview.md).
