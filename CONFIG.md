# DPAgent Configuration

The runtime configuration source is `config.yaml`. First package run creates a
minimal template in the current working directory. Source-tree development can
edit the repository-local `config.yaml`, but local config must not be committed.

## Minimal Configuration
```yaml
llmProfiles:
  defaultProfileId: default
  profiles:
    - id: default
      name: "Default Profile"
      provider: "anthropic"
      apiKey: "YOUR_API_KEY"
      apiBase: "https://api.minimaxi.com"
      defaultModel: "MiniMax-M2.7-highspeed"
      maxOutputTokens: 32768

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

Removed legacy settings such as `session_note`, `enableNote`,
`memoryWriteMode`, `skillWriteMode`, old `dpagent.yaml`, and old `history_message_*.jsonl`
semantics are not current configuration contracts.

## MCP Configuration
```yaml
mcp:
  enabled: true
  connectTimeout: 10
  executeTimeout: 60
  servers:
    - name: "MiniMax-Coding-Plan"
      type: "stdio"
      command: "uvx"
      args: ["minimax-coding-plan-mcp", "-y"]
      env:
        MINIMAX_API_KEY: "YOUR_API_KEY"
        MINIMAX_API_HOST: "https://api.minimaxi.com"
```

When `enabled: false` or `servers: []`, MCP tools are not registered.

## Validation
After config-sensitive changes, run the closest relevant checks:

```bash
npm run build:web
npm test
```

Release candidates follow [release gate overview](doc/playbook/release-gate-overview.md).
Local config and release profiles follow [local config and profile hygiene](doc/playbook/local-config-profile-hygiene.md).
