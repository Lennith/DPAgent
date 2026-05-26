# Logging Guide

## Log Directory
All maintained runtime logs are written under:

```text
logs/
```

## Log Files
- `logs/all.log`: combined runtime log
- `logs/webserver.log`: Web server component
- `logs/agent.log`: agent component
- `logs/llm.log`: LLM component
- `logs/tool.log`: tools component
- `logs/mcp.log`: MCP component
- `logs/skill.log`: skill loader component
- `logs/session.log`: session and context component

## Process Stdout And Stderr
```bash
npm run dev:web:logs
npm run start:web:logs
```

Outputs:

- `logs/dev-web.out.log`
- `logs/dev-web.err.log`
- `logs/start-web.out.log`
- `logs/start-web.err.log`

## Diagnostic Scripts
```bash
node scripts/diagnose.js
node scripts/collect-evidence.js <sessionId>
```

Diagnostics write JSON reports under `logs/`.

## Data Directories
Context events, shell logs, runtime state, memory, skills, and Todo files are
runtime data, not log files. They still remain out of source commits.
