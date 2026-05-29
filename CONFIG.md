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

The example and runtime defaults use a conservative setup-first posture:

```yaml
llmProfiles:
  defaultProfileId: ''
  profiles: []

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

## LLM Profiles

Create a provider profile from Web Settings before running chat, automation, or subagents. The package no longer ships a runnable default provider/model profile.

Do not commit real API keys. Prefer environment-specific local config files or secret managers for shared machines.

## Opt-In Toolsets

Use explicit toolsets when the workspace and prompt are trusted:

- `windows-safe`: default read-heavy mode.
- `windows-dev`: adds file write/edit, shell, skill writes, subagents, automation, and file download.
- `research`: adds web fetch to the development toolset.
- `full-access`: hidden escape hatch for trusted maintainers; disables workspace sandbox checks and allows unknown MCP tools.

To opt in for local development:

```yaml
agent:
  defaultToolset: windows-dev

tools:
  enableShell: true
```

Do not enable `full-access` in shared examples or default project configs.

## Web Access

`enableWeb` registers the built-in `web_fetch` tool for known URL retrieval. It does not register a default search tool.

The package includes the read-only native `web-access` skill as a strategy guide for search and webpage retrieval tasks.

## MCP

MCP is disabled unless both `mcp.enabled: true` and at least one server are configured. MCP servers run as local child processes and can inherit environment variables depending on their command and env block.

```yaml
mcp:
  enabled: false
  connectTimeout: 10
  executeTimeout: 60
  servers: []
```

When `enabled: false` or `servers: []`, MCP tools are not registered. DPAgent does not inject a default Web MCP server; any MCP server must be explicitly configured.

Removed legacy settings such as `session_note`, `enableNote`, `memoryWriteMode`, `skillWriteMode`, old `dpagent.yaml`, and old `history_message_*.jsonl` semantics are not current configuration contracts.

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
