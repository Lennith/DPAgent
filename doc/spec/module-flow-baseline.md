# Module Flow Baseline

## Agent Runtime
Flow: A turn starts with a user prompt and replay messages. The runtime prepares
input, checks context budget, calls the LLM, streams output, executes tools,
records usage, and decides whether the turn is complete or needs recovery.

Business logic: the agent must not report success unless the model reaches a
valid terminal state and completion policy is satisfied.

## Context Runtime
Flow: Context begins a turn, buffers events, records messages and tool activity,
creates checkpoints, commits events atomically, and projects durable state back
into replay messages and structured context.

Business logic: durable history is the source of truth. Compressed history can
reduce older context, but it cannot change current user intent or invent missing
tool outcomes.

## LLM Provider Runtime
Flow: The runtime receives canonical prepared payloads, constructs provider wire
messages, calls the selected provider, normalizes output, and returns finish
reason, tool calls, thinking, text, and usage.

Business logic: provider differences must not leak into Agent recovery rules.
Malformed tool-call arguments are rejected before tool execution.

## Tool System
Flow: A turn builds a scoped registry, filters tools by toolset capability,
exposes schemas to the model, executes requested tools, checks permissions, and
returns normalized results or artifacts.

Business logic: permission failures are normal results, explicit toolset typos
are configuration errors, and large outputs become artifacts.

## Web Server
Flow: The server boots services, registers HTTP routes, serves the client,
accepts WebSocket connections, dispatches chat messages, streams runtime
callbacks, and exposes settings, Plan, Todo, automation, and governance APIs.

Business logic: HTTP and WebSocket access share auth rules. Connection metadata,
not chat payload, classifies CLI versus Web ownership. Observe-only sessions
block Web mutations.

Detailed contracts:

- [Web session ownership protocol](protocols/web-session-ownership-protocol.md)
- [WebSocket runtime event protocol](protocols/websocket-runtime-event-protocol.md)
- [Plan Mode backend lifecycle](protocols/plan-mode-backend-lifecycle.md)
- [Pending Plan input lifecycle](protocols/pending-plan-input-lifecycle.md)

## Web Client
Flow: The client hydrates settings and sessions, opens WebSocket communication,
projects committed transcript state, renders live deltas, sends chat prompts,
and allows settings, model, Plan, Todo/Ralph, automation, and governance
operations.

Business logic: committed history and live state are different. Web-owned active
runs allow next-turn editing; observe-only, canceling, and hydrating states are
read-only.

## Plan Mode
Flow: The composer stores local planning intent. Sending with intent enters
`plan_drafting`; planning tools request clarification or finalize a plan;
approval enters `plan_executing`; Todo completion exits execution.

Business logic: draft is read-only except for planning tools. Product
requirements that are unclear must be clarified before finalization.

Detailed contracts:

- [Plan Mode backend lifecycle](protocols/plan-mode-backend-lifecycle.md)
- [Pending Plan input lifecycle](protocols/pending-plan-input-lifecycle.md)

## Auto-loop, Todo, And Ralph
Flow: Todo/Ralph state decides whether to schedule continuation after a run.
Todo and Plan execution have priority. Ralph uses latest saved settings when a
new continuation starts.

Business logic: backend-owned continuations survive WebSocket disconnect.
Recoverable checkpoint errors schedule continuation; fatal errors stop the loop.

Detailed contract: [Auto-loop and continuation protocol](protocols/auto-loop-todo-continuation-protocol.md).

## Interrupted Recovery
Flow: The runtime writes draft checkpoints and side-effect ledgers. An
interrupted artifact can be replayed by the next turn and cleared after
successful recovery.

Business logic: recovery is based on durable checkpoints, not UI state. Stale
artifacts and canceled cards must not override a later active run.

Detailed contract: [Interrupted run recovery protocol](protocols/interrupted-turn-recovery-protocol.md).

## Subagent Runtime
Flow: A parent turn requests a subagent, the manager validates input, creates or
resumes a record, queues work, starts the runner when capacity allows, monitors
heartbeat, records advisory timeout diagnostics without canceling the runner,
and notifies waiters.

Business logic: subagents are delegated work, not independent session owners.
Parent context, selected profile, allowed tools, provider selection, and result
artifacts remain traceable. Queued/running subagents are canceled at the parent
run boundary, parent-agent cancellation boundary, explicit user stop boundary,
or direct `subagent_manage cancel` boundary for that context.

Failed subagents are not automatically retried. Historical retry queue fields
may exist in persisted state, but they do not enqueue work unless an explicit
user/API resume or retry action creates a new task.

## MCP Runtime
Flow: MCP connectors start configured servers, discover tools, handle calls,
monitor health, reconnect when needed, and expose status snapshots.

Business logic: MCP tools obey the active toolset and connection failures remain
visible without corrupting local session state.

## Memory Runtime
Flow: Committed turns are observed, candidate memories are batched, classified,
approved, and injected into future prompts.

Business logic: memory stores durable reusable facts, not temporary logs or raw
command output.

## Automation Runtime
Flow: Automation jobs are scheduled, checked for due execution, run through
prompt or system-task paths, record output, and expose history through routes.

Business logic: automation is auditable and should not overlap runs unless the
job policy allows it.

## Skill Runtime
Flow: Skills are discovered, loaded into prompt catalog segments, written by
model-requested create/update actions, packed, archived, governed, or rolled
back.

Business logic: runtime skill writes are applied as approved skills immediately;
history, rollback, pack publication, and workspace generated-skill governance
provide the review and recovery boundary.

## Config And Storage
Flow: Configuration loads YAML and environment values, resolves provider
profiles, context budget, paths, auth, toolsets, and Web settings, then exposes
public views for the UI.

Business logic: defaults have one runtime source and local runtime artifacts
stay out of source control.
