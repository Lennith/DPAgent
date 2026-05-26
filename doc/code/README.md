# Code Module Index

Code module documents explain how the source tree is organized. They are for
handoff and maintenance: where to edit, what each module owns, which files are
important, and what tests are closest.

Code docs do not redefine product behavior. When behavior is unclear, read PRD,
design, and spec/protocol docs first, then use code docs to find the
implementation.

## Modules
- [Agent profiles](modules/agent-profiles.md)
- [Agent runtime](modules/agent-runtime.md)
- [ASR runtime](modules/asr-runtime.md)
- [Automation runtime](modules/automation-runtime.md)
- [Config and storage](modules/config-and-storage.md)
- [Context runtime](modules/context-runtime.md)
- [Governance runtime](modules/governance-runtime.md)
- [Hook runtime](modules/hook-runtime.md)
- [LLM runtime](modules/llm-runtime.md)
- [MCP runtime](modules/mcp-runtime.md)
- [Memory runtime](modules/memory-runtime.md)
- [Plan, Todo, and auto-loop](modules/plan-todo-autoloop.md)
- [Runtime facade and CLI](modules/runtime-facade-and-cli.md)
- [Scripts](modules/scripts.md)
- [Skill runtime](modules/skill-runtime.md)
- [Subagent runtime](modules/subagent-runtime.md)
- [Tool system](modules/tool-system.md)
- [Utilities](modules/utilities.md)
- [Web client](modules/web-client.md)
- [Web server](modules/web-server.md)

## Module Doc Template
Each module doc uses the same shape:

- Responsibility
- Source paths
- Key files
- Runtime data or contracts
- Edit guidance
- Closest tests

## Editing Rule
If a code change moves responsibility between modules, update the affected code
module doc in the same change.
