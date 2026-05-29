---
name: dpagent-agent-create
description: Create or update DPAgent external agents through the local/full-access DPAgent authoring API. Use when a user wants an agent generated, configured, and written to the configured globalAgentsDir with agent.yaml, LLM profile, MCP, toolset, subagent exposure, and runtime limits.
---

# DPAgent Agent Create

Use this skill to create or update an external DPAgent agent. It writes only to the server's configured `agent.globalAgentsDir`; bundled agents are never edited.

## Workflow

1. Discover the live server contract before writing:
```bash
node scripts/run.js discover --base-url http://127.0.0.1:53721 --output json
```
2. Draft an apply payload with `agent.name`, `agent.content`, and optional `agent.config`.
3. Dry-run first:
```bash
node scripts/run.js validate --json @payload.json --dry-run true --output json
```
4. Apply only after the user wants the change:
```bash
node scripts/run.js apply --json @payload.json --confirm yes --output json
```

## Payload Shape

```json
{
  "agent": {
    "name": "Novelist",
    "content": "# Novelist\nWrite vivid fiction.",
    "config": {
      "version": 1,
      "description": "Fiction agent",
      "llmProfileId": "novel-profile",
      "llmModel": "novel-model",
      "reasoningPreset": "medium",
      "toolsetName": "novelist-tools",
      "allowedTools": ["read_file", "web_fetch"],
      "maxSteps": 12,
      "timeoutMs": 180000,
      "exposeAsSubagent": true
    }
  },
  "llmProfiles": {
    "upsert": []
  },
  "mcp": {
    "enabled": true,
    "upsert": []
  },
  "toolsets": {
    "upsert": []
  }
}
```

## Rules

- Share links cannot use this skill; the API must be loopback or full-access remote login.
- Prefer `schema` or `describe` before the first real command.
- Prefer `--json @file` for write commands.
- Use `--password` only when calling a remote server that requires login; loopback normally needs no auth.
- Non-dry-run writes require `--confirm yes`.
- Output defaults to JSON and errors use `{ success:false, error:{ code,message,details } }`.
