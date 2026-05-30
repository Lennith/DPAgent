# DPAgent PRD Baseline

## Product Goal
DPAgent is a local-first AI agent runtime for developer and operations
workflows. It combines persistent event-sourced sessions, local tools, MCP,
subagents, memory, automation, skills, Todo governance, Plan Mode, a CLI
entrypoint, and a React Web client.

The product goal is to let a user start from a chat request and complete
multi-step work without losing context, tool results, ownership boundaries, or
recovery state.

## Users
- Developer: uses chat, local file tools, shell execution, provider profiles, Plan Mode, and Todo loops to implement and verify code changes.
- Operator or reviewer: uses the Web UI, session history, context inspection, observe-only sessions, and governance panels to understand what happened.
- CLI user: runs the public CLI path while Web can observe without taking ownership.
- Automation owner: configures scheduled or headless work that can continue without a browser.
- Agent builder: adds skills, agent profiles, MCP servers, toolsets, and provider profiles.

## Core Scenarios
- Interactive chat execution: the user submits a prompt, the runtime replays context, calls the model, executes tools, and commits a durable turn.
- Plan Mode: the user marks the next message as planning intent, reviews a finalized plan, approves execution, and then Todo governance constrains the execution loop.
- Long-context work: the runtime estimates input tokens, replays recent turns, compresses older history, and recovers from max-token or context overflow failures.
- Tool-heavy execution: tool calls and results are normalized into provider-compatible protocol frames, large results become artifacts, and replay remains deterministic.
- Session ownership: Web, CLI, and automation can all own runs; Web observes CLI/automation runs without mutating them.
- Running next-turn configuration: Web-owned active runs allow draft editing, model changes, and Ralph changes for the next turn or continuation.
- Session recovery: interrupted runs retain replay-safe checkpoints and side-effect ledgers so the next turn can continue without fabricating completed work.
- Subagent delegation: the parent run creates queued child work with scoped tools, heartbeat supervision, retry policy, and result waiting.
- Memory and skills: stable facts can be promoted to memory, and repeated workflows can become approved reusable skills with governed history.
- Web operation: users manage provider profiles, context budget, auth, automation jobs, sessions, model selection, Plan approvals, and runtime telemetry.

## Feature Designs
- [Plan Mode lifecycle](../design/features/plan-mode-lifecycle.md)
- [Plan input and finalization](../design/features/plan-input-and-finalize-plan.md)
- [Composer next-turn controls](../design/features/web-composer-next-turn-controls.md)
- [Session origin and observe-only](../design/features/session-origin-observe-only.md)
- [Run interruption and error cards](../design/features/run-interruption-and-error-card-lifecycle.md)
- [Ralph, Todo, and Plan execution](../design/features/ralph-todo-plan-execution.md)

## Product Capabilities
- Durable sessions: users can resume work with committed transcript, tool results, context state, and recovery artifacts.
- Local execution: users can read and edit workspace files, run shell commands, and inspect artifacts under workspace policy.
- Provider choice: users can configure provider profiles and per-session model selection.
- Plan Mode: users can ask for a plan first, clarify requirements, approve execution, and let Todo governance constrain the run.
- Web and CLI operation: users can work from Web or CLI while the backend preserves ownership boundaries.
- Observe-only review: users can watch CLI or automation sessions in Web without accidentally mutating them.
- Continuation: Todo, Ralph, workspace, and automation flows can continue when policy allows.
- Memory and skills: users can retain durable facts and governed reusable workflows.
- Subagents: users can delegate bounded child work while keeping parent traceability.
- Release confidence: maintainers can run source gates, E2E gates, toolcall gates, and official npm publish preflight checks.

## Non-goals
- The runtime is not a generic unrestricted remote execution service; filesystem and shell access are governed by workspace and toolset policy.
- The Web UI is not the source of truth for committed conversation state; event-sourced context remains durable truth.
- Provider adapters do not own trimming or recovery policy; they only adapt canonical payloads and return normalized output.
- Web chat payloads do not decide whether a run is CLI-owned or Web-owned; origin is server-side connection metadata.
- Compatibility branches for removed legacy protocols should not be reintroduced unless a future product requirement explicitly reopens them.
- UX iteration commands are not release gates.

## Release And Operations Constraints
- GitHub pull requests are the public upstream merge path.
- Releases must pass the maintained source gate before publish.
- Runtime artifacts, logs, workspaces, dist output, local context stores, and local release profiles are not source artifacts.
- User-visible behavior changes must be recorded in [findings ledger](../history/findings-ledger.md) with trigger, impact, and fix boundary.
