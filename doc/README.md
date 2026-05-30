# DPAgent Documentation Index

`doc/` is the only current documentation tree for this repository. Do not add new current-state documentation under legacy `docs/` or slim-refactor round folders.

## Documentation Layers
- PRD: product intent. It explains why the product exists, who uses it, what outcomes matter, and which user-visible requirements are in scope. It avoids code ownership and wire contracts.
- Guide: user-facing usage documentation. It explains how to install, start, operate, and troubleshoot the product without owning product requirements or technical contracts.
- Design: feature behavior. It explains how a feature behaves for users and operators, including UX states, user flows, acceptance checks, and business rules. It can name state names, but it does not own source paths.
- Spec: technical design. It explains system architecture, module interactions, invariants, and implementation-level contracts.
- Protocol: exact runtime contracts under `spec/protocols/`. Protocol docs own wire/event/state-machine semantics and are the tie-breaker for DTO or lifecycle ambiguity.
- Code: source map and module guide. It explains where code lives, what each module owns, key files, edit boundaries, and tests. It does not redefine product behavior.
- Playbook: commands, release gates, operational procedures, and handoff steps.
- History: archived records. History is not current specification.

## PRD
- [PRD index](prd/README.md)
- [Product baseline](prd/product-baseline.md)

## Guide
- [Guide index](guide/README.md)
- [User guide](guide/user-guide.md)
- [MiniMax Agent to DPAgent migration](guide/minimax-migration.md)

## Design
- [Design index](design/README.md)
- [Plan Mode lifecycle](design/features/plan-mode-lifecycle.md)
- [Plan input and finalization](design/features/plan-input-and-finalize-plan.md)
- [Composer next-turn controls](design/features/web-composer-next-turn-controls.md)
- [Session origin and observe-only](design/features/session-origin-observe-only.md)
- [Run interruption and error cards](design/features/run-interruption-and-error-card-lifecycle.md)
- [Ralph, Todo, and Plan execution](design/features/ralph-todo-plan-execution.md)
- [GLM ASR module](design/features/glm-asr-module.md)
- [Hook system](design/features/hook-system.md)

## Specification
- [Spec index](spec/README.md)
- [Architecture baseline](spec/architecture-baseline.md)
- [Module flow baseline](spec/module-flow-baseline.md)
- [Agent profile baseline](spec/agent-profile-baseline.md)
- [Web session ownership protocol](spec/protocols/web-session-ownership-protocol.md)
- [WebSocket runtime event protocol](spec/protocols/websocket-runtime-event-protocol.md)
- [Plan Mode backend lifecycle](spec/protocols/plan-mode-backend-lifecycle.md)
- [Pending Plan input lifecycle](spec/protocols/pending-plan-input-lifecycle.md)
- [Auto-loop and continuation protocol](spec/protocols/auto-loop-todo-continuation-protocol.md)
- [Interrupted run recovery protocol](spec/protocols/interrupted-turn-recovery-protocol.md)

## Code
- [Code module index](code/README.md)
- [Agent profiles](code/modules/agent-profiles.md)
- [Agent runtime](code/modules/agent-runtime.md)
- [ASR runtime](code/modules/asr-runtime.md)
- [Automation runtime](code/modules/automation-runtime.md)
- [Config and storage](code/modules/config-and-storage.md)
- [Context runtime](code/modules/context-runtime.md)
- [Governance runtime](code/modules/governance-runtime.md)
- [LLM runtime](code/modules/llm-runtime.md)
- [MCP runtime](code/modules/mcp-runtime.md)
- [Memory runtime](code/modules/memory-runtime.md)
- [Plan, Todo, and auto-loop](code/modules/plan-todo-autoloop.md)
- [Runtime facade and CLI](code/modules/runtime-facade-and-cli.md)
- [Scripts](code/modules/scripts.md)
- [Skill runtime](code/modules/skill-runtime.md)
- [Subagent runtime](code/modules/subagent-runtime.md)
- [Tool system](code/modules/tool-system.md)
- [Utilities](code/modules/utilities.md)
- [Web client](code/modules/web-client.md)
- [Web server](code/modules/web-server.md)

## Playbook
- [Playbook index](playbook/README.md)
- [Development playbook](playbook/development-playbook.md)
- [Release gate overview](playbook/release-gate-overview.md)
- [Release E2E gate](playbook/release-e2e-gate.md)
- [Release toolcall context gate](playbook/release-toolcall-context-gate.md)
- [GitHub release](playbook/github-release.md)
- [NPM official publish](playbook/npm-official-publish.md)
- [Local config and profile hygiene](playbook/local-config-profile-hygiene.md)
- [Windows easy-run handoff](playbook/windows-easy-run-handoff.md)
- [Logging guide](playbook/logging-guide.md)
- [UX iteration standard](playbook/ux-iteration-standard.md)

## History
- [Findings ledger](history/findings-ledger.md)
- [Archived next-version development plan](history/next-version-development-plan.md)
- [Release notes 2.3.1](history/release-notes-2.3.1.md)
- [Release notes 2.3.0](history/release-notes-2.3.0.md)
- [Release notes 2.2.15](history/release-notes-2.2.15.md)
- [Release notes 2.2.14](history/release-notes-2.2.14.md)
- [Release notes 2.2.13](history/release-notes-2.2.13.md)
- [Release notes 2.2.12](history/release-notes-2.2.12.md)
- [Release notes 2.0.1-2.2.10](history/release-notes-2.0.1-2.2.10.md)
- [Release notes 1.0.20-1.0.38](history/release-notes-1.0.20-1.0.38.md)
