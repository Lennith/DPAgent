# DPAgent Configuration

The runtime configuration source is `config.yaml`. First package run creates a
minimal template in the current working directory. Source-tree development can
edit the repository-local `config.yaml`, but local config must not be committed.

## Minimal Configuration
```yaml
llmProfiles:
  defaultProfileId: ""
  profiles: []

agent:
  workspaceDir: "./workspace"
  contextDir: "./contexts"
  runtimeDataDir: "./runtime"
  skillsDir: "C:\\Users\\...\\.codex\\skills"
  globalAgentsDir: "./agents"
```

## Common Agent Fields
```yaml
agent:
  maxSteps: 100
  tokenLimit: 210000
  workspaceDir: "./workspace"
  contextDir: "./contexts"
  runtimeDataDir: "./runtime"
  defaultToolset: "full-access"
  skillsDir: "C:\\Users\\...\\.codex\\skills"
  globalAgentsDir: "./agents"
```

- `workspaceDir`: default workspace for file tools, shell, workspace memory, and skills.
- `contextDir`: event-sourced session context directory.
- `runtimeDataDir`: memory, skills, audit, session search, Todo, and other runtime data.
- `defaultToolset`: default capability whitelist.
- `skillsDir`: global skill directory. Each child skill directory contains `SKILL.md`.
- `globalAgentsDir`: native or custom agent profile directory. Each profile lives under
  `globalAgentsDir/<agentName>/AGENTS.md`; optional profile settings live in
  `globalAgentsDir/<agentName>/agent.yaml`; optional agent-specific skills live under
  `globalAgentsDir/<agentName>/skill/`. Set `loadGlobalSkills: false` in
  `agent.yaml` when that external agent should ignore the Settings global skills
  directory; the default is `true`. Workspace skills under `workspaceDir/skills/`
  are runtime-generated or approved workspace sources and are not controlled by
  `loadGlobalSkills`.

## Tool Configuration
```yaml
tools:
  enableFileTools: true
  enableWeb: true
  enableShell: true
  shellType: powershell
  shellTimeout: 30000
```

Create a provider profile from Web Settings before running chat, automation, or subagents.

`enableWeb` registers the built-in `web_fetch` tool for known URL retrieval. It
does not register a default search tool.

Removed legacy settings such as `session_note`, `enableNote`,
`memoryWriteMode`, `skillWriteMode`, old `dpagent.yaml`, and old `history_message_*.jsonl`
semantics are not current configuration contracts.

## MCP Configuration
```yaml
mcp:
  enabled: false
  connectTimeout: 10
  executeTimeout: 60
  servers: []
```

When `enabled: false` or `servers: []`, MCP tools are not registered. DPAgent
does not inject a default Web MCP server; any MCP server must be explicitly
configured.

## Experimental Workspace Timeline

Workspace Timeline is an experimental test feature. It is off by default and is
enabled from Web Settings -> Other with the "Workspace Timeline (test)" checkbox.
When enabled, DPAgent records retained turn deltas under `runtimeDataDir` and
exposes API-only rollback for retained revisions. There is no rollback UI yet.

## Validation
After config-sensitive changes, run the closest relevant checks:

```bash
npm run build:web
npm test
```

Release candidates follow [release gate overview](doc/playbook/release-gate-overview.md).
Local config and release profiles follow [local config and profile hygiene](doc/playbook/local-config-profile-hygiene.md).
