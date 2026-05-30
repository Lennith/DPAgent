# DPAgent Architecture Baseline

## Overall Architecture
DPAgent is organized as a layered runtime. The public facade constructs
shared services, Agent executes turns, Context persists and projects event
history, LLM adapters translate canonical payloads, tools perform local or MCP
work, and the Web server/client expose the workflow to users.

Dependency direction flows from orchestration to domain services, and from
provider adapters to shared protocol helpers. Provider-specific code must not
reinterpret context reduction policy. UI code consumes shared server DTOs where
available instead of inventing parallel shapes.

## Detailed Protocol Specifications
- [Web session ownership protocol](protocols/web-session-ownership-protocol.md)
- [WebSocket runtime event protocol](protocols/websocket-runtime-event-protocol.md)
- [Plan Mode backend lifecycle](protocols/plan-mode-backend-lifecycle.md)
- [Pending Plan input lifecycle](protocols/pending-plan-input-lifecycle.md)
- [Auto-loop and continuation protocol](protocols/auto-loop-todo-continuation-protocol.md)
- [Interrupted run recovery protocol](protocols/interrupted-turn-recovery-protocol.md)

## Agent Runtime
Agent receives replay messages and a user prompt. It prepares provider input,
checks context budget, optionally precompresses older replay, calls the LLM,
streams callbacks, executes tools, and repeats until the model ends the turn or
a recovery path is required.

The Agent class is the turn-loop coordinator. Message/session/checkpoint state is
owned by MessageStore, LLM input and context precompression are prepared by
LlmInputPreparator, context budget estimation is owned by ContextBudgetService,
context overflow and max-token recovery compression reuse ContextOverflowHandler
and MaxTokensRecoveryService, tool-result payload shaping is owned by
ToolResultMaterializer, and tool-call/progress-only recovery side effects are
owned by TurnRecoveryOrchestrator. Provider adapters still receive only prepared
canonical messages and do not own reduction or recovery policy.

The business logic is step based. A step can create assistant content, thinking,
tool calls, tool results, usage observations, and recovery events. The runtime
must not claim completion until the model reaches a terminal state and required
completion policies are satisfied.

## Context Runtime
Context uses event sourcing. A turn begins with pending events, records user,
assistant, tool, patch, checkpoint, and compaction events, then commits them
atomically. Projections rebuild structured state and replay messages.

Replay assembly chooses recent rounds, compressed history, and interrupted-turn
artifacts. Compression can summarize older replay segments, but it does not
rewrite the current user prompt or fabricate tool results.

## LLM Provider Runtime
The LLM layer accepts canonical prepared payloads. Anthropic-compatible and
OpenAI-compatible adapters convert payloads into provider syntax, normalize
streaming events, normalize finish reasons, and return usage when available.

Provider adapters consume a vendor dialect policy resolved from the runtime
profile, API base, and model. The protocol adapter owns wire-shape conversion;
the dialect policy owns supplier-specific quirks such as endpoint normalization,
reasoning request parameters, historical thinking replay carriers, and whether
unsigned Anthropic thinking blocks are replayable. New supplier quirks should be
added as dialect policies, not as ad hoc checks inside protocol adapters.

OpenAI-compatible tool arguments must parse to a JSON object before they can
become canonical tool calls. Malformed or non-object arguments are provider
protocol errors, not executable fallback payloads.

## Tool System
The tool system registers local and MCP tools into a per-turn registry. Toolset
policy filters capabilities before the model sees tools. Explicit toolset names
must resolve to a known toolset; unknown explicit names fail instead of falling
back to broader defaults.

Large tool results are stored as artifacts and referenced in the transcript so
replay preserves identity without forcing every large payload back into context.

## Web Server
The Web server owns process lifecycle, route registration, session runtime pool,
WebSocket upgrade and dispatch, auth gates, REST APIs, automation routes, static
client serving, and callback-to-event bridging. Context, metadata, workspace,
basic planning-state resolution, and session LLM-selection resolution are owned
by ContextResolutionService. Completion marker enforcement and repair
statistics are owned by CompletionMarkerService so callback completion can emit
the same WebSocket payloads without embedding marker state mutation directly in
WebServer.

Pending plan input request state, reconnect grace, response resolution, reject
paths, and persisted pending-input metadata lifecycle are owned by
PendingPlanInputCoordinator. WebServer remains responsible for transport
emission, observe-only run checks, plan approval activation, todo-loop refresh,
and context cancellation side effects.

Active run context maps, run-state snapshots, step progress refresh, canceling
run markers, and reserve/activate/finalize state cleanup rules are owned by
RunStateTracker. WebServer keeps request preparation, callback execution,
WebSocket payload emission, session runtime cleanup, and catalog refresh side
effects around those state transitions.

Prepared run execution is owned by RunExecutionOrchestrator. It resolves the
prepared run input, applies LLM-selection metadata updates, calls the context
agent, persists runtime error cards, emits terminal or error callbacks, stops
auto-loop controllers for non-recoverable failures, and delegates final cleanup
back to WebServer. WebServer still owns chat preparation, prompt resolution,
cancel handling, session runtime lifecycle, and continuation policy decisions.

WebSocket connection metadata identifies CLI versus Web ownership. CLI and
automation active runs keep Web in observe-only mode. External MCP attachments
are accepted only from CLI-origin connections.

## Web Client
The React client owns presentation state, drafts, session selection, transcript
projection, settings drafts, automation panels, and WebSocket event consumption.
Committed transcript state comes from hydration or terminal events; live deltas
remain transient until the run commits.

The session sidebar groups Web and CLI sessions, lets each group collapse
independently, and stores local pinned-session ids so a session can appear in
the pinned group while remaining in its original Web or CLI group.

The composer separates real planning state from local Plan Mode intent. Web-owned
active runs allow next-turn draft/model/Ralph editing, while observe-only,
canceling, and hydrating states remain locked.

Session fork is a stable committed-snapshot operation. It creates a new session
namespace from an existing session's committed events and tool-result artifacts,
names the child session with a `-fork` suffix by default, and rejects sources
with active runs, pending plan input, or interrupted-turn recovery state. Forked
sessions inherit the same workspace and can therefore conflict on files if they
are later run concurrently.

Arena is a locked multi-branch session workflow. Creating an Arena records a
source-session lock, hides unpromoted branch sessions from the normal session
list, and gives each contestant branch a forked session namespace. Answer Arena
branches run with a read-heavy toolset, while implementation branches receive
isolated `.dpagent-arena/` workspaces copied from the same source state and a
branch-confined file-edit toolset without shell or delegation. Branches must
submit through `arena_submit_result`; normal sessions never receive that tool.
The judge runs in a hidden judge session and persists a ranking/rationale into
Arena state, but cannot auto-select a winner. Applying an implementation winner
requires a proposal with source and branch workspace hashes; stale source or
changed branch workspaces are rejected before files are copied back.

## Subagent Runtime
The subagent module queues child work under a parent context. It creates or
resumes records, assigns provider/profile/tool constraints, starts a runner,
monitors heartbeat, applies advisory timeout diagnostics, persists status, and
wakes waiters when results arrive.

Task timeout does not cancel the child task. It records that the task exceeded
the expected duration and keeps the task running until it finishes or an
explicit cancel is requested. Queued/running subagents are canceled when the
owning parent run ends, when the parent agent is canceled, or when the user
stops that context from the Web frontend.

Failed subagents are not automatically retried. Historical retry registry fields
are retained for compatibility, while explicit resume/retry actions are treated
as new requested work.

Lifecycle transitions remain centralized to avoid lost wakeups, duplicate
retries, and stale status persistence.

## MCP Runtime
The MCP connector manages external MCP server connections, reconnects, health,
tool discovery, and tool invocation. The shared runtime pool reference-counts
connectors so sessions can reuse servers without duplicating process ownership.

## Memory Runtime
MemoryStore persists approved durable facts by workspace or user scope.
MemoryPromotionCoordinator observes committed turns, batches candidate facts,
classifies them through the LLM memory classifier, and applies approved
mutations with audit information. If the classifier is unavailable or returns
invalid data, promotion fails without heuristic fallback and the committed
session turns remain the raw retry source.

Memory holds stable reusable facts, not raw logs, one-off outputs, or data
already available in the current context or transcript.

## Automation Runtime
Automation stores jobs, schedules, runs, templates, and reports. The scheduler
decides when jobs should run; the execution service runs prompt paths and
records observable work.

Prompt automation jobs may run with the default agent or a selected external
agent. The default agent path honors the automation job's preferred skill list.
When an external agent is selected, the job ignores that preferred skill list and
uses the selected agent's profile, tool, model, and skill rules. If the selected
external agent no longer exists at execution time, the run falls back to the
default agent and persists a fallback diagnostic. Automation runs are
backend-owned and do not require a browser connection.

## Skill Runtime
Skills are markdown-based domain extensions. SkillLoader discovers and catalogs
skills from package-native, global, pack, selected-agent, and workspace sources.
Package-native skills live under `skills/` and are read-only baselines visible to
all sessions by default. SkillWriteStore manages applied write records,
generated-suggestion state, and version history, and SkillPackStore handles pack
publication.

Model-requested skill create/update writes are applied immediately as approved
skills. DPAgent no longer exposes a pending skill approval queue.
Approved Skill Manager generated workspace skills can be manually governed from
Settings. That governance is scoped to the selected workspace and does not scan
global skills, handwritten workspace skills, pack skills, or other workspaces.

## Web Access
The built-in Web tool surface provides `web_fetch` for known URL retrieval when
`tools.enableWeb` is true. DPAgent does not register a default `web_search`
tool, does not use DuckDuckGo fallback search, and does not inject a default Web
MCP server. Search-like MCP tools may still be explicitly configured and mapped
to the `web_search` capability family for custom toolsets. The package-native
`web-access` skill is the default strategy entrypoint for web information tasks:
search pages are discovery only, and conclusions should prefer first-party
sources.

## Todo And Governance
Todo state describes planned work and completion evidence. It supports
auto-loop execution by keeping a verifiable list of pending, active, blocked,
and completed items.

Governance stores audit events and toolset presets for permission-sensitive and
workflow-sensitive changes.

## Config And Storage
ConfigManager loads YAML, environment overrides, provider profiles, context
budget, auth, toolsets, and runtime directories. Runtime stores use atomic JSON
or JSONL primitives for durable local state.

Configuration defaults should have one runtime source. UI defaults, CLI
templates, and server public views derive from the same resolved configuration.
The package baseline is setup-first for LLMs: it ships with no executable
provider profile, no default provider endpoint, and no default model. Runtime
execution resolves an explicit provider profile before creating an LLM client;
Web can boot in setup mode without a profile, but chat, automation, and
subagent execution remain blocked until the user creates one.
