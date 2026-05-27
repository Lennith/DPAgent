# DPAgent Project Guide

This repository is the DPAgent Node.js runtime. It contains the local agent runtime, context/event storage, LLM provider adapters, tool system, MCP integration, subagents, memory, automation, skills, todo governance, Express/WebSocket server, and React web client.

## Documentation Baseline
`doc/` is the single current documentation baseline:

- `doc/prd/product-baseline.md`: product goals, users, scenarios, non-goals, release constraints.
- `doc/spec/architecture-baseline.md`: overall architecture and natural-language module specifications.
- `doc/playbook/development-playbook.md`: development, refactor, test, GitHub release, and publish playbooks.

Product intent lives under `doc/prd/`; user-facing usage lives under `doc/guide/`; feature behavior lives under `doc/design/`; technical specs and protocols live under `doc/spec/`; source ownership lives under `doc/code/`; release and operations docs live under `doc/playbook/`; internal-only mirror or registry procedures live under `doc/internal/`. Historical notes, if retained, live under `doc/history/`. Do not add or reference a legacy `docs/` documentation tree.

## Engineering Rules
- Keep behavior-preserving refactors behavior-preserving. User-visible semantic changes must be recorded in `doc/history/findings-ledger.md` with trigger, impact, and fix boundary.
- Split by responsibility, not by line count alone. A large file may remain if it is a clear aggregate and the round report explains why.
- Do not introduce compatibility branches, fallback protocols, or test-only production logic as review fixes.
- Preserve provider protocol and API wire shapes unless the task explicitly authorizes a breaking change.
- Keep runtime artifacts out of commits: `dist/`, `logs/`, `runtime/`, `contexts/`, `workspace/`, `workspace-smoke-default/`, `ux-workspace/`.
- Any npm release must include a release note update for the version being published.

## Common Commands
- Install: `npm install`
- TypeScript build: `npm run build`
- Web build: `npm run build:web`
- Unit tests: `npm test`
- UI smoke: `npm run smoke:ui`
- Release toolcall context gate: `npm run test:release-toolcall-context-session`
- Dev web: `npm run dev:web`

## Git And Review
- Work from latest `main` on a focused branch unless the user requests otherwise.
- Use path-specific staging.
- Use GitHub pull requests for public review. Do not require Gerrit `Change-Id` footers for public contributions.
- Commit sign-off is welcome when required by the contributor or organization.
- Use subagent review after key commits when requested. P0/P1 findings block the next node. P2 findings are fixed by default or documented in the active round report.

## Architecture Pointers
- Public facade: `src/index.ts`
- Agent runtime: `src/agent/`
- Context/event runtime: `src/context/` and `src/runtime/context-replay-assembly.ts`
- LLM adapters and protocol preparation: `src/llm/`
- Tools and permissions: `src/tools/`
- Web server: `src/web/server/`
- Web client: `src/web/client/`
- Subagents: `src/subagent/`
- MCP: `src/mcp/`
- Memory: `src/memory/`
- Automation: `src/automation/`
- Skills: `src/skills/`
- Todo and governance: `src/todo/`, `src/governance/`

Refer to `doc/spec/architecture-baseline.md` for natural-language flow and business logic before changing module ownership.
