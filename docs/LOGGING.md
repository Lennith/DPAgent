# Logging Guide

All logs are written under `logs/`.

## Log files

- `logs/all.log` - combined runtime log
- `logs/webserver.log` - web server component
- `logs/agent.log` - agent component
- `logs/llm.log` - llm component
- `logs/tool.log` - tools component
- `logs/mcp.log` - mcp component
- `logs/skill.log` - skill loader component
- `logs/session.log` - session/context component

## Process stdout/stderr

- `npm run dev:web:logs`
  - stdout: `logs/dev-web.out.log`
  - stderr: `logs/dev-web.err.log`
- `npm run start:web:logs`
  - stdout: `logs/start-web.out.log`
  - stderr: `logs/start-web.err.log`

## Diagnostic scripts

- `node scripts/diagnose.js`
  - writes report to `logs/diagnostic-report.json`
- `node scripts/collect-evidence.js <sessionId>`
  - writes report to `logs/evidence-<sessionId>.json`

## Data directories (not log files)

- context events: `agent.contextDir` (default `./contexts`)
- shell execution records: `agent.runtimeDataDir/shell-logs` (default `./runtime/shell-logs`)
