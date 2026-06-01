# Findings Ledger

This file records behavior-affecting bug fixes discovered during slim-refactor work. Pure code movement, dead-code deletion, test restructuring, and documentation-only changes are not recorded here.

This ledger is historical. It is not the current product or architecture
specification source. When a historical record conflicts with a current
`doc/prd/`, `doc/spec/`, or `doc/playbook/` document, the current document
governs.

## Required Fields

Each record must include:

- Title
- Trigger
- Observed behavior
- Impact
- Fix boundary
- Commit

## Round 50 Records

### Workspace Timeline is a Settings-gated test feature

- Trigger: Large workspaces and Arena branches need a shared, incremental way to capture per-turn file changes without copying whole repositories or creating user-visible checkpoint commits.
- Observed behavior: Workspace state was tied to the live directory, Arena worktree/copy fallback, or manual Git state; DPAgent had no runtime-owned turn delta ledger or retention window.
- Impact: Workspace Timeline is now an explicit test feature exposed in Web Settings -> Other. It remains off by default. When enabled, DPAgent captures begin/end workspace manifests, stores file blobs in runtime CAS, attaches committed delta metadata to context events, exposes timeline/delta APIs, and retains the latest 5 stage deltas per session by default. The capture path does not create Git commits, private refs, stashes, or index changes. The rollback API restores retained blob-backed session revisions, appends rollback audit records, and writes context patch metadata so later turns can see the active workspace revision and latest rollback.
- Fix boundary: Workspace Timeline store/coordinator, config normalization, Settings UI/API toggle, runtime turn commit wrapping, Web timeline/delta/rollback APIs, rollback context metadata, tests, and current docs only. User-facing rollback UI, optimized touched-path capture, Arena replacement of worktree/copy fallback, stale external-dirty conflict UI, and physical CAS blob GC remain out of scope.
- Commit: pending Round 50.

## Round 49 Records

### Arena locks source sessions and converges one selected branch

- Trigger: Users needed a Share/Fork-level workflow to run the same context through multiple contestant models while keeping the source session stable and comparable.
- Observed behavior: DPAgent could fork a session manually, but there was no source lock, branch isolation, contestant configuration, submission tool, judge boundary, or winner apply path to converge multiple branches back to one outcome.
- Impact: Full-access Web users can create an Arena with up to four contestants. The source session is locked and renders an Arena panel until closed or applied; unpromoted branch and judge sessions are hidden from normal session access; Arena branches get the gated `arena_submit_result` tool; implementation branches use branch-confined file-edit tools without shell/delegation; judge output is persisted as Arena ranking/rationale; implementation winners produce a changed-file proposal with source and branch hash safety checks before apply.
- Fix boundary: Arena store/domain, Web routes, source lock guards, branch workspace/session creation, submit tool registration, proposal/apply safety, Web Arena panel, source-history and branch-detail read-only transcript surfaces, tests, and current docs only. Judge auto-selection, automatic conflict resolution, branch workspace cleanup, and multi-round source sync remain out of scope.
- Commit: pending Round 49.

### Arena no-git workspace copy skips symlinks

- Trigger: A no-git workspace used for Arena branch isolation contained symlinked tool/skill directories.
- Observed behavior: Directory-copy fallback attempted to recreate symlinks and could fail on Windows with `EPERM` before branches were prepared.
- Impact: Arena directory-copy fallback now skips symlink entries, matching the existing diff/hash behavior that ignores symlinks. Normal files and directories still copy, and excluded runtime roots such as `node_modules`, `dist`, `logs`, and `runtime` remain excluded.
- Fix boundary: Arena workspace copy fallback only; git worktree handling, proposal/apply file semantics, and source workspace contents are otherwise unchanged.
- Commit: pending Round 49.

### Stopped sessions can clean up unfinished Todo work

- Trigger: Stopping or canceling a run could leave current-session Todo items in `pending`, `in_progress`, or `blocked` state with no explicit user control to terminate that Todo contract.
- Observed behavior: The Todo loop could still see unfinished work after a user-initiated stop, and Web confirmation flows used a mix of browser-native dialogs and app UI.
- Impact: After a user stop or cancel, the Todo panel can expose a cleanup action for the current session. Confirming it marks unfinished session Todo items as `dismissed`, refreshes the Todo loop state, and uses the shared app confirmation dialog. Existing delete and Plan Mode exit confirmations now use the same dialog style instead of `window.confirm`.
- Fix boundary: Todo store mutation, Web governance route, Web Todo panel, confirmation UI, affected client flows, tests, and current docs only. Todo history is not deleted, observe-only sessions still cannot mutate, and non-confirmation alerts remain out of scope.
- Commit: pending Round 49.

### Default LLM configuration is setup-first

- Trigger: The packaged runtime still created a MiniMax-shaped default provider profile and model even when the user had not configured any LLM provider.
- Observed behavior: First-run config, CLI/setup templates, profile normalization, and runtime fallback paths could synthesize an executable-looking MiniMax profile.
- Impact: DPAgent now ships with empty `llmProfiles`; Web can boot in setup mode, but chat, automation, and subagent execution require an explicit user-created provider profile. Legacy YAML with explicit root `api` credentials can still migrate into a profile.
- Fix boundary: Config normalization, startup validation, Web setup handling, templates, tests, and current docs only. Explicit user-created MiniMax profiles and provider dialect support remain available.
- Commit: pending Round 49.

### Sessions can fork stable committed context snapshots

- Trigger: Agent runtime and context storage are decoupled enough to let users branch one committed session into another session for later independent continuation.
- Observed behavior: Sessions had no route or UI control for copying committed context into a new session; users had to continue in-place or manually recreate context.
- Impact: Full-access Web users can fork a stable session from the composer. The child session defaults to `<source>-fork`, copies committed events and tool-result artifacts, inherits stable workspace/tool/model context, and rejects active, pending-input, or interrupted sources.
- Fix boundary: Context event storage, session routes, Web composer controls, tests, and current docs only. Forked sessions still share the same workspace; concurrent file conflict avoidance is not implemented in this round.
- Commit: pending Round 49.

### Default web search is no longer registered

- Trigger: Live stability testing showed the default Web search path coupled the runtime to a Web MCP server and an unreliable DuckDuckGo fallback.
- Observed behavior: Empty Web MCP configuration could be replaced with the MiniMax Coding Plan MCP at WebServer startup, and the core `web_search` fallback path could fail slowly before a turn had any useful source evidence.
- Impact: Default Web access now registers only `web_fetch` for known URL retrieval. DPAgent no longer injects a default Web MCP server, no longer includes the core DuckDuckGo/service `web_search` implementation, and ships a read-only native `web-access` skill as the strategy entrypoint for web information tasks. Explicit custom MCP search tools remain supported through the `web_search` capability family.
- Fix boundary: Web tool registration, WebServer MCP defaulting, native skill loading, package manifests, tests, and current docs only. Explicit user-configured MCP servers and `web_fetch` behavior remain unchanged.
- Commit: pending Round 49.

## Round 48 Records

### Skill writes no longer use internal pending records

- Trigger: After the user-visible pending skill approval queue was removed, the skill write store still persisted `pending` records and required a separate commit step for writes that should already apply immediately.
- Observed behavior: Model-requested and auto-observed skill writes used draft/pending/approved state names internally, and governance backfill queried approved draft records for generated-skill provenance.
- Impact: Skill writes now create applied write records directly, runtime storage uses a `writes` bucket, and governance backfill reads applied write records. `skill_manage` remains create/update only and still applies approved skills immediately.
- Fix boundary: Skill write storage contracts, runtime/tool write plumbing, auto-generated governance backfill, tests, and current docs only. Skill metadata `reviewStatus: approved`, revision history, rollback, pack publication, and governance fallback diagnostics remain unchanged.
- Commit: pending Round 48.

## Round 47 Records

### Legacy compatibility inputs are hard cut

- Trigger: Slim refactor identified remaining special handling for old Todo bucket aliases, removed agent config fields, and deprecated `subagent_manage` create/resume arguments after the product moved to canonical contracts.
- Observed behavior: Todo loading still mapped old `title/details` fields into current todos, config loading silently deleted `memoryWriteMode`, `skillListPath`, and `skillWriteMode`, and `subagent_manage` returned bespoke deprecated-argument messages for `preset` and `system_prompt`.
- Impact: Todo persistence now reads only canonical `work/detectionStandard`, removed agent config fields fail fast with the same removed-field boundary as old context settings, and subagent create/resume no longer carries dedicated compatibility handling for removed arguments.
- Fix boundary: Todo persistence normalization, config input validation, subagent tool argument handling, tests, and documentation only. Legacy root `api` migration, context replay markers, SkillWriteStore write records, SubAgent `local-default`, and automation fallback diagnostics remain unchanged.
- Commit: `2de4644e5d51490c2e59650c263cadbc648f413f`.

## Round 23 Records

### Runtime skill writes no longer use pending approval

- Trigger: The model-callable `skill_manage` tool and Web governance surface still exposed pending skill draft review actions after the product removed the user approval step.
- Observed behavior: Runtime skill creation could look like it was waiting for an approve/reject decision, while the current workflow expects model-requested create/update writes to apply directly as approved skills.
- Impact: `skill_manage` now supports only create/update and commits the resulting skill immediately. Web pending-skill routes, governance payload fields, settings UI cards, and the obsolete `agent.skillWriteMode` config surface were removed.
- Fix boundary: Skill write lifecycle, Web skill-governance surface, settings contract, tests, and documentation only. Skill history, rollback, pack publication, generated-skill governance, and provider/tool wire shapes remain unchanged.
- Commit: pending Round 23.

## Round 11 Records

### Subagent task timeout is advisory

- Trigger: Long-running subagents could exceed their configured task timeout while still making useful progress.
- Observed behavior: The runner treated the task timeout as a hard deadline and called `agent.cancel()`, turning an expected-duration miss into a terminal timeout.
- Impact: Task timeout now emits a deadline diagnostic and heartbeat while leaving the subagent running. Explicit cancellation remains available through parent run shutdown, parent-agent cancellation, Web manual stop, or direct `subagent_manage cancel`.
- Fix boundary: Subagent runner deadline handling, manager heartbeat/diagnostic handling, parent-context cancellation, model-facing tool hints, and subagent documentation only. Historical `timeout` records remain readable.
- Commit: pending Round 11.

### Android client can open shared DPAgent links

- Trigger: Mobile users receive DPAgent share links outside the web app and need to open them through the native Android client without manually creating a host/port entry.
- Observed behavior: The Android client only managed direct computer endpoint entries, so shared `/dpagent-share/<token>` URLs had to be copied into another browser or manually routed through an existing endpoint.
- Impact: The Android client now keeps shared links separate from direct client entries, can add valid share links from the clipboard or add menu, accepts Android `SEND text/plain` and `VIEW http(s)` intents for valid DPAgent share URLs, removes expired or unauthorized shared links after main-frame 401/403/404/410 WebView responses, and enables WebView cookies for shared web sessions.
- Fix boundary: Android client manifest, native list UI, local shared-link persistence, link parsing, intent handling, and README behavior notes only. Web share token semantics and server-side permissions are unchanged.
- Commit: pending Round 11.

### Release toolcall gate skips unavailable Kimi profile

- Trigger: The maintained release gate required the Kimi profile, but the current release environment has no active Kimi key.
- Observed behavior: `npm run release:source-gate` could pass unit, integration, UI, and E2E gates but fail the final toolcall context profile because Kimi authentication was unavailable, and `publish:standard` still required matching three-profile evidence.
- Impact: The standard release toolcall context gate now runs the active DeepSeek and MiniMax release profiles, and the publish evidence contract expects those two profiles until Kimi release credentials are restored.
- Fix boundary: Package release gate configuration, standard publish evidence tests, and release gate playbook only. Runtime provider support, Kimi profile parsing, and non-release evaluation defaults are unchanged.
- Commit: pending Round 11.

### Reasoning presets include provider maximum tiers

- Trigger: Official provider docs expose higher reasoning controls than the Web/CLI/session preset model accepted: OpenAI supports `xhigh`, and Anthropic's official Claude effort controls include `max`.
- Observed behavior: DPAgent only accepted `off`, `low`, `medium`, and `high`. Selecting or submitting `xhigh` or `max` would be rejected or normalized back to `high`, so the highest provider reasoning tier could not be configured through the shared runtime controls.
- Impact: Reasoning presets now include `xhigh` and `max`. OpenAI-compatible requests send `xhigh` for both the `xhigh` preset and a provider-incompatible `max` preset clamp. Official Claude/Anthropic requests send `output_config.effort=max` for `max`, while Anthropic-compatible runtimes that still use manual thinking budgets keep the existing `thinking.budget_tokens` path and map `max` to the highest local budget.
- Fix boundary: Reasoning preset types, normalization, Web/CLI/agent profile validation, Web UI selectors, OpenAI-compatible reasoning effort mapping, Anthropic effort/budget mapping, and related tests only. Model defaults, profile capability flags, and provider authentication are unchanged.
- Commit: pending Round 11.

### Shared sessions use scoped links and per-connection control

- Trigger: Multiple Web frontends could view and control the same session through shared Web ownership, and external AI clients had no narrow text-only way to join a shared DPAgent session.
- Observed behavior: Web session events and active-run controls were effectively common to every WebSocket with session access. External clients needed the full runtime WebSocket protocol, which could expose thinking, tool calls, and tool results.
- Impact: Session shares now use `/dpagent-share/:token` links backed by one active token per session. Shared WebSockets are scoped to the bound session, active Web runs assign control to the triggering WSS, non-controller clients observe only, and text-only share clients receive only history, text deltas, done, busy/observe-only/error, share invalidation, pong, and file-link events.
- Fix boundary: Web share routes, share token metadata, WebSocket access/control gating, text-only share protocol, Web shared shell behavior, DPAgent share client skill, and related tests only. Tool-level permissions and non-shared full-login Web behavior are unchanged.
- Commit: pending Round 11.

### Assistant messages can expose generated files as downloads

- Trigger: Remote Web users could ask the assistant to send a generated or local file, but the runtime had no first-class tool for turning a readable local path into a chat download.
- Observed behavior: The assistant could mention a local path or expose tool output, but remote users had to inspect tool records or have direct filesystem access to retrieve the file.
- Impact: The `send_file_to_user` tool now creates an opaque, authenticated `/download/:id` link for readable files. Successful tool results render as a lightweight download attachment at the end of the assistant message, with display text based on the original path plus filename.
- Fix boundary: Core tool registration, Web download-link service/routes, Web session issuer wiring, toolset capability gating, attachment rendering, and tests only. Existing file read/write permissions, provider payload shapes, and non-Web execution paths are unchanged.
- Commit: pending Round 11.

## Round 10 Records

### Running input uses a queue instead of concurrent chat

- Trigger: Users could edit the composer while a Web-owned run was active, but sending had no protocol boundary other than starting a normal `chat` run, which same-session active-run gating correctly rejects.
- Observed behavior: The UI could preserve a next draft, but could not send it to the current running model at a checkpoint or queue it for the next turn without waiting for completion.
- Impact: Active Web runs now accept memory-only `running_input_enqueue` messages. Non-empty active-run drafts enqueue FIFO next turns; empty drafts still show Stop. A queued item can request current-turn insertion, but the Agent consumes it only after tool results are appended and before the next LLM request.
- Fix boundary: WebSocket protocol, Web composer, WebServer in-memory queue coordination, and Agent safe-checkpoint insertion only. Provider streaming, `chat` concurrency gating, persisted context meta, and Todo/Plan continuation priority are unchanged.
- Commit: pending Round 10.

### Historical subagent list can read without initialized tool registry

- Trigger: After service restart, an old session can have persisted subagent records but no in-memory session runtime. The subagent list route may resolve through the root agent, whose tool registry is not initialized.
- Observed behavior: `GET /api/sessions/:id/subagents` recomputed `effectiveAllowedTools` during status projection and could throw `Tool registry not initialized`, turning a historical status read into a 500.
- Impact: `SubAgentManager.list()` now degrades status projection to persisted `allowedTools` when dynamic effective-tool resolution is unavailable, so historical subagent records remain readable after cold start.
- Fix boundary: Status/list projection only. Create, resume, retry, and execute paths still resolve effective tools strictly and do not relax execution permissions.
- Commit: pending Round 10.

### Auto-generated skill governance is workspace scoped

- Trigger: Auto-generated skill governance was implemented as a single system automation job, while generated skills are workspace files and users can run multiple sessions across different workspaces.
- Observed behavior: A central automation seed workspace could discover other workspaces through approved draft history and could include global skills, so governance did not reliably match the user's active workspace.
- Impact: Auto-generated skill governance is now a manual Settings -> Governance/Memory action scoped to the selected workspace. It only scans Skill Manager generated workspace skills under that workspace's `skills/` directory and ignores global skills, handwritten workspace skills, pack skills, and other workspaces.
- Fix boundary: Skill governance service, Settings governance routes/UI, automation listing/scheduling guard, audit events, and documentation only; skill draft approval and normal automation prompt jobs remain separate.
- Commit: pending Round 10.

### Automation agent selection scopes skill preferences

- Trigger: Automation jobs could store a skill checklist, but they had no explicit default-vs-external agent boundary.
- Observed behavior: Automation skill preferences were always injected as preferred skills, even for jobs that should execute through an external agent profile.
- Impact: Automation jobs now default to the default agent. They may select an external agent from the Settings agent list; external-agent runs use that agent's runtime and skill rules, while the automation skill checklist only applies when the effective agent is default. Deleted external agents fall back to default and record a diagnostic.
- Fix boundary: Automation job storage, routes, execution metadata, settings UI, and documentation only; scheduler timing and system automation task semantics are unchanged.
- Commit: pending Round 10.

### External agent skills are scoped per agent

- Trigger: Skill loading had one global settings directory and a legacy `skillListPath`, while external agents needed their own reusable procedures.
- Observed behavior: Selecting an external agent could not add skills from that agent directory, and the runtime still initialized the unused `skill-list.yaml` path.
- Impact: The default agent uses global and workspace runtime skills. An external agent loads skills from its own `skill/` directory, workspace runtime skills, and by default the Settings global skills directory. `agent.yaml` can set `loadGlobalSkills: false` to hide Settings global skills for that external agent.
- Fix boundary: Skill discovery, agent profile config, settings UI, startup template, and documentation only; provider protocols and existing tool permission contracts are unchanged.
- Commit: pending Round 10.

### Plan Mode button is a composer intent until send

- Trigger: In a normal session, the Web composer Plan Mode button immediately mutated session planning state before the message was sent.
- Observed behavior: Clicking the button a second time attempted to exit a draft that the backend did not consider active, producing a "session is not in plan drafting" style error.
- Impact: Plan Mode selection is now local composer intent while the session is normal. The backend enters `plan_drafting` only when a message is sent with the planning action.
- Fix boundary: Web composer state and send payload selection only; existing `plan_drafting`, `finalize_plan`, approval, and execution semantics are unchanged.
- Commit: pending Round 10.

### Web-owned active sessions allow next-turn edits

- Trigger: A Web-owned active run locked the composer, LLM selector, and Ralph controls even though those changes only affect later turns.
- Observed behavior: Users could not prepare the next message, update the session LLM choice, or enable Ralph until the current run completed.
- Impact: During Web-owned active runs, the composer draft, session LLM selection, and Ralph settings remain editable; the send button stays as Stop and Enter does not start a concurrent run. Observe-only CLI sessions, canceling, and hydrating states remain read-only.
- Fix boundary: Web client interactivity and scheduled continuation runtime preparation only; active LLM calls are not switched mid-request, and same-session concurrent runs remain blocked.
- Commit: pending Round 10.

### Session Todo loop survives recoverable checkpoint errors

- Trigger: A long session Todo loop hit a transport reset after replay-safe checkpoint progress had already been committed.
- Observed behavior: Manual input could continue from the checkpoint, but the backend auto-loop controller treated the terminal error as fatal and stopped, so Todo execution did not continue automatically. Session and workspace continuations were also tied to the initiating browser WebSocket staying open.
- Impact: Session-owned Todo/Ralph continuations and workspace continuations are no longer stopped solely because the owner WebSocket closed. A terminal `error` with a checkpoint interrupted artifact keeps the active auto-loop alive and schedules the next continuation, while non-checkpoint errors still stop as fatal errors. If a detached continuation later asks for `request_user_input`, the pending request immediately enters the existing reconnect-grace lifecycle instead of hanging on an already closed owner socket.
- Fix boundary: WebServer auto-loop continuation and pending Plan input lifecycle only; provider transport behavior, checkpoint persistence, replay assembly, and manual continuation semantics are unchanged.
- Commit: pending Round 10.

### Plan Mode clarifies unclear product requirements

- Trigger: Plan Mode could have enough implementation context to draft a technical plan while the product requirement itself was still unclear, contradictory, or overly broad.
- Observed behavior: The planning prompt required clarification for unclear requirements generally, but did not explicitly call out product requirement ambiguity.
- Impact: Plan Mode now tells the model to clarify unclear, contradictory, or too-broad product requirements before finalizing, even when the implementation path looks straightforward.
- Fix boundary: Plan Mode prompt guidance only; Plan Mode tool schemas, approval flow, and execution transition are unchanged.
- Commit: pending Round 10.

### Interrupted cancel/error cards clear for the next run

- Trigger: A cancelled or interrupted run left an interrupted-artifact error card at the bottom of the chat, then the user sent the next message in the same session.
- Observed behavior: The composer locally cleared the card when the next message was sent, but a later session-detail hydrate could reapply the stale artifact from backend recovery metadata while the next run was already active. Legacy cancelled runtime errors could also be projected as transcript error cards.
- Impact: Session hydrate now suppresses interrupted artifacts whenever the current runtime or server detail indicates a next run or pending Plan input is active. Active-run session-list refreshes also clear stale interrupted-artifact UI state, and cancelled runtime errors are not projected as transcript error cards.
- Fix boundary: Web UI hydration/projection only; backend interrupted-artifact persistence and replay recovery context remain available to the next run.
- Commit: pending Round 10.

## Round 3 Records

### Compression source could skip the first content message

- Trigger: In-turn precompress received `olderMessages` after the system message had already been removed, while the chunk builder still treated index 0 as a system message.
- Observed behavior: The earliest user or assistant content message could be excluded from the compression prompt.
- Impact: Long-context summaries could miss the first older fact and reduce replay fidelity.
- Fix boundary: Corrected compression source selection only; compression target, prompt semantics, and replay-round policy were not changed.
- Commit: R3-N1 `fix: tighten context compression boundaries`.

### precompressChunkChars did not control chunk boundaries

- Trigger: In-turn precompress called `buildCompressionChunks({ maxChunks: 3 })` without passing the configured chunk-size target.
- Observed behavior: The UI/configured precompress chunk size mainly affected telemetry and did not determine chunk boundaries.
- Impact: Users changing compression chunk size could see unexpected compression cost and chunk size.
- Fix boundary: The configured chunk target now participates in boundary selection; `maxChunks` remains only a safety cap.
- Commit: R3-N1 `fix: tighten context compression boundaries`.

### Compressed-history cache fingerprint was incomplete

- Trigger: Replay min/max, replay budget ratio, context window, or trigger-related config changed while the old compressed-history sidecar could still match.
- Observed behavior: A cached summary could be reused under a different replay/budget policy.
- Impact: Long-context replay could restore a summary inconsistent with the current configuration.
- Fix boundary: Expanded fingerprint and invalidation inputs only; summary content format was not changed.
- Commit: R3-N1 `fix: tighten context compression boundaries`.

### context_compaction could leave replay sidecar stale

- Trigger: A committed turn contained event-sourced `context_compaction` while namespace metadata still held a compressed-history sidecar.
- Observed behavior: Sidecar cleanup waited for later hash mismatch instead of invalidating immediately after compaction commit.
- Impact: Recovery paths had two possible compressed-history sources, making replay state harder to reason about.
- Fix boundary: Clear replay sidecar after compaction commit only; event-sourced compaction body and replay semantics were not changed.
- Commit: R3-N1 `fix: tighten context compression boundaries`.

### Context telemetry mixed token and char units

- Trigger: Context precompress, overflow, or utilization events placed token values in fields named `*Chars`.
- Observed behavior: UI, logs, and watchdog diagnostics showed inconsistent units.
- Impact: Debugging compression trigger points and context utilization could be misleading.
- Fix boundary: Added explicit token fields and kept `*Chars` fields as char estimates; actual compression thresholds were not changed.
- Commit: R3-N1 `fix: tighten context compression boundaries`.

### Provider protocol canonical boundary was tightened

- Trigger: Code called provider adapters directly with malformed replay messages instead of going through the shared pre-provider sanitizer.
- Observed behavior: Adapter-local fallback behavior could silently repair malformed payloads.
- Impact: Internal adapter tests/calls had to use canonical prepared payloads; the normal Agent path kept external semantics.
- Fix boundary: Moved malformed replay repair to the shared sanitizer and did not loosen provider protocol rules.
- Commit: R3-N2 `refactor: centralize provider payload preparation`.

### System role provider channel was consolidated

- Trigger: LLM runtime calls could include `role: "system"` in messages while also passing `systemPrompt`.
- Observed behavior: Some paths let system messages travel through provider messages while adapters handled them separately.
- Impact: Provider adapters no longer receive system-role messages; system content flows through the single `systemPrompt` channel.
- Fix boundary: Internal provider payload ownership only; provider-specific system prompt content and external format were not changed.
- Commit: R3-N2 review fix `fix: preserve raw prepare semantics before system hoist`.

### OpenAI streaming tool input delta scoping was tightened

- Trigger: An OpenAI-compatible provider streamed interleaved argument deltas for multiple tool calls.
- Observed behavior: The old `tool_input` delta was appended to the most recently started tool id and could be misapplied in interleaved streams.
- Impact: Exported `LLMStreamEvent` data for `tool_input` now uses `{ chunk, id?, index? }`; direct consumers of `generateStream()` must read `data.chunk`. Callback-level assembly and final response semantics were not changed.
- Fix boundary: Stream event wire shape and buffering only; final tool call payload was not changed and no legacy string compatibility branch was kept.
- Commit: R3-N3 `refactor: normalize provider runtime contracts`.

### Thinking budget participates in runtime context budget

- Trigger: An Anthropic-compatible profile enabled thinking budget while main runtime `resolveContextBudget()` did not pass reasoning reservation.
- Observed behavior: Safe input tokens could be overestimated, delaying precompress or overflow protection.
- Impact: Thinking-enabled long-context sessions may trigger budget protection earlier.
- Fix boundary: Budget input normalization only; provider thinking parameters and output content were not changed.
- Commit: R3-N3 `refactor: normalize provider runtime contracts`.

### Partial provider usage samples are ignored for budget anchors

- Trigger: A streaming provider emitted partial usage with only prompt/input tokens before final completion/total usage.
- Observed behavior: The old path could treat prompt-only partial usage as complete `TokenUsage` for calibration or usage anchor.
- Impact: Budget anchors now use complete usage only, avoiding in-turn anchors based on incomplete samples.
- Fix boundary: Usage normalization and partial filtering only; final usage parsed from provider responses was not changed.
- Commit: R3-N3 `refactor: normalize provider runtime contracts`.

### Settings save became a single transaction

- Trigger: The settings page changed provider profiles and agent/context/auth settings in one save action, and one save step failed.
- Observed behavior: The old path could leave profiles saved while config save failed.
- Impact: Settings save now succeeds or rolls back as a server-side single transaction.
- Fix boundary: Save atomicity and failure rollback only; individual field meanings were not changed.
- Commit: R3-N5 `refactor: converge settings contracts and saves`.

### Chat transcript commit boundary was tightened

- Trigger: A chat run completed, canceled, errored, or entered interrupted recovery while live messages and persisted messages were both updating.
- Observed behavior: The old path could show duplicate messages, flicker, or stale error cards.
- Impact: The frontend transcript updates through a clear commit boundary, improving visible message ordering.
- Fix boundary: Client state commit logic only; server message event protocol was not changed.
- Commit: R3-N6 `refactor: converge chat runtime state`.

### Dead websocket backup/polling exports were removed

- Trigger: Third-party or future internal code tried to use websocket backup/polling helpers that were not connected to active recovery.
- Observed behavior: The old helpers only exposed or recorded state and did not perform real recovery.
- Impact: The dead exports were removed to prevent misuse; active reconnect and heartbeat behavior remained intact.
- Fix boundary: Dead helper export removal only; active reconnect/heartbeat behavior was not changed.
- Commit: R3-N6 `refactor: converge chat runtime state`.

## Round 7 Records

### Plan execution approval moved into finalize_plan

- Trigger: The model had to call `request_user_input` after `finalize_plan` to request execution approval, and the same tool result could tempt the planning turn to continue into implementation before execution tools were available.
- Observed behavior: Execution approval was coupled to an LLM-authored `request_user_input` question, so approval could be missed, delayed, or represented as a generic plan input unrelated to the frozen final plan.
- Impact: `finalize_plan` now freezes the plan, opens the approval card, waits for approve/revise/reject, and returns the decision to the LLM. Only `finalize_plan_approval` requests can activate plan-bound Todo creation and `plan_executing`.
- Fix boundary: Plan-mode approval flow and prompt contract only; `request_user_input` remains available for planning clarification questions.

### Finalized plans render as first-class chat UI

- Trigger: The model produced a structured `finalize_plan` payload, but the web client only exposed the plan through raw tool-call arguments or stored tool-result text.
- Observed behavior: Users had to expand `finalize_plan` internals to read the plan, and approval cards did not show the frozen plan as normal rendered content.
- Impact: `finalize_plan` approval requests now carry a `planPreview`, and the web client renders finalized plans as a readable plan card during live runs, pending approval, and hydrated transcript views.
- Fix boundary: Plan preview DTOs and web presentation only; the LLM-facing `finalize_plan` tool schema and execution approval semantics were not changed.

### Runtime run errors are transcript messages

- Trigger: A previous run could emit a late checkpoint or connection error after a newer run had already started.
- Observed behavior: The frontend accepted ignored-run terminal events while another run was active, then rendered the error through the chat container's global error slot at the bottom of the transcript.
- Impact: Stale terminal errors no longer attach to a newer active run. Active run failures without an interrupted artifact are stored as runtime error transcript records and render inline with normal chat history.
- Fix boundary: Web runtime event gating, runtime error metadata, and chat presentation only; provider, checkpoint, and interrupted-artifact semantics were not changed.

### Release config templates are sanitized

- Trigger: The release packaging script copied the repository root `config.yaml` into standard and easy-run release folders.
- Observed behavior: A developer machine config, including local LLM profiles and real API keys, could become the default config in a release directory.
- Impact: Release packages now generate a sanitized `llmProfiles` config template with an empty API key, and packaging fails if the release config contains secret-looking keys.
- Fix boundary: Release packaging and first-run template safety only; existing user configs are preserved, and legacy `api` configs are migrated into the default LLM profile on load.

### First npm run creates a setup-mode config

- Trigger: A new npm-package user starts `npx dpagent` in an empty directory with no `config.yaml`.
- Observed behavior: The intended CLI path already generated a config, but release templates and legacy docs still made the first-run boundary easy to regress.
- Impact: The first-run init path is now covered by a smoke test: it creates `config.yaml` and `skill-list.yaml`, leaves `apiKey` empty, and relies on web setup mode until the user configures a key.
- Superseded: Round 10 retires `skill-list.yaml`; current first-run init creates `config.yaml` only.
- Fix boundary: CLI template and test coverage only; the supported command remains `npx dpagent`, with no `npx minimax` alias added.

## Release Gate Strengthening Records

### CLI-owned Plan Mode input is observe-only from Web

- Trigger: A CLI-owned active run could surface a pending Plan Mode input in the Web UI while the session interaction state was observe-only.
- Observed behavior: The Web client visually showed the plan input card, and the backend accepted `plan_input_response` for an active CLI session.
- Impact: Web could approve, revise, or otherwise resolve a CLI-owned pending plan input, weakening source isolation and allowing two frontends to influence the same active run.
- Fix boundary: WebSocket `plan_input_response` now rejects observe-only active runs with `observe_only`, leaves the pending request unresolved, and records the error in pending input metadata. The Web Plan Input card renders disabled with a read-only reason while CLI owns the active run. CLI command flags and JSONL event shapes are unchanged.
- Commit: release gate strengthening change.

### Stored provider keys require explicit replacement

- Trigger: A user opened web settings, changed an unrelated setting such as remote access password, and saved while browser password autofill could populate provider API key inputs.
- Observed behavior: Any non-empty provider password input was treated as an intentional new API key, so a stored key from another profile could be submitted and overwrite the selected/default profile key.
- Impact: Profiles that already have an API key no longer render an API key password input until the user clicks the explicit replace action; unrelated settings saves preserve stored profile keys.
- Fix boundary: Web settings form submission and UI guard only; `/api/settings` key update semantics remain unchanged for explicit `apiKey` submissions and clear-key actions.

### Global agents support structured agent.yaml config

- Trigger: Users needed external/global agents to carry execution preferences such as LLM profile, model, reasoning, global-skill loading, and supplemental prompt without editing the main `AGENTS.md` role prompt.
- Observed behavior: Global agents were only `Name/AGENTS.md`; chat `@agent` activation and `subagent_manage(agent_name=...)` could not apply per-agent runtime settings.
- Impact: Global agents can now include `Name/agent.yaml`. Its valid fields are shown and editable in web settings, included in `/api/agents`, applied as temporary active-agent overrides for chat, and frozen into subagent tasks when selected by `agent_name`. Toolset, allowed tools, max steps, and timeout remain global/session controls rather than agent-profile controls.
- Fix boundary: Local global-agent profile configuration only; remote external subagent providers and the `subagent_manage` tool argument schema were not changed.

### Agent profile runtime controls inherit global defaults

- Trigger: Agent settings exposed toolset, allowed tools, max steps, and timeout fields, but these controls should be global/session runtime settings rather than external-agent profile settings.
- Observed behavior: An external agent could save stale per-agent tool/runtime limits in `agent.yaml`, and the settings UI showed four override inputs that made the effective runtime rule unclear.
- Impact: The Agent Config UI now edits only description, LLM profile, model, reasoning, global skill loading, and prompt append. Existing stale `toolsetName`, `allowedTools`, `maxSteps`, and `timeoutMs` keys are ignored by profile loading, so external agents inherit global/session tool and step settings. Default reasoning selection is now `high`; explicit `off` remains valid.
- Fix boundary: External-agent profile settings and LLM reasoning default only; task-level subagent allowed tools/timeouts and governance toolset presets remain available through their existing channels.

### Chat quick actions were removed

- Trigger: The quick action/template prompt row in the composer duplicated normal prompt entry and did not carry enough value for the main workflow.
- Observed behavior: The composer always rendered a row of quick/template buttons above the primary controls, and onboarding hinted at quick actions.
- Impact: The quick action row and related hints are removed. Plan mode, LLM selection, Agent selection, file references, and Ralph controls remain in the composer.
- Fix boundary: Web composer presentation only; chat sending, `@agent`, file reference, plan mode, and session LLM APIs were not changed.

### CLI sessions are observe-only while running

- Trigger: A CLI `dpagent-exec` run and the web client could reference the same session, but the web runtime treated all active sessions as web-owned.
- Observed behavior: Web could not reliably see the CLI run's model/plan state, and web controls such as cancel, delete, rename, LLM selection, plan exit, or Ralph stop could target a run still owned by CLI.
- Impact: Sessions now carry origin and active-run owner metadata. The sidebar groups Web and CLI sessions separately; running CLI sessions show a read-only observation state with model/reasoning/plan pills, and mutating web routes return `409 observe_only` until the CLI run finishes.
- Fix boundary: Session metadata, web route locks, CLI payload serialization, and web presentation only; web-owned session behavior remains unchanged, and a finished CLI session can still be continued from Web.

## Round 9 Records

### Memory promotion no longer writes heuristic fallback summaries

- Trigger: Automatic memory promotion could fall back to checklist/command heuristics when the classifier was unavailable or returned invalid JSON.
- Observed behavior: Generic assistant output could be promoted as durable memory, and source truncation markers could be persisted into memory content.
- Impact: Automatic promotion now fails without heuristic fallback when classification is unavailable or invalid, keeps the committed session turns as the retry source, and skips classifier candidates that still contain `...(truncated)`.
- Fix boundary: Automatic memory promotion and memory tool guidance only; committed session event storage, manual memory list/read/remove behavior, and ordinary classifier-approved memory writes remain unchanged.
- Commit: pending 2.0.8.

### CLI origin is connection-owned

- Trigger: WebSocket chat payloads still carried `clientKind`, so a Web client could claim CLI ownership from the request body.
- Observed behavior: Backend origin, observe-only state, and external MCP attachment policy could be influenced by payload data instead of connection provenance.
- Impact: The CLI runner now marks its WebSocket upgrade with an internal client-kind header. WebServer records connection kind at upgrade time, ignores spoofed `clientKind` for ownership, and accepts new external MCP attachments only from CLI-origin connections.
- Fix boundary: CLI/Web ownership classification and external MCP attachment boundary only; CLI command-line arguments, chat payload shape, and JSONL output remain compatible.
- Commit: pending Round 9.

### Plan input responses are request-bound before websocket adoption

- Trigger: A reconnecting or unrelated WebSocket could answer a pending Plan input request with invalid data and still mutate the pending owner socket before answer validation.
- Observed behavior: Failed `plan_input_response` attempts could rebind the pending Plan input socket or clear the detach timer, and some target-bound errors lacked context for the client to route them.
- Impact: Pending Plan input lookup no longer mutates websocket ownership. The server validates runId/requestId and answer payload first, then adopts the response socket only for a valid request-bound answer. Target-bound `plan_input_error` now includes context, and Web can submit the pending answer for an observe-only CLI-owned Plan input request.
- Fix boundary: WebSocket Plan input lifecycle only; Plan Mode approval still requires `finalize_plan_approval`, and non-targeted observe-only mutations remain blocked.
- Commit: pending Round 9.

### Explicit toolset names are strict

- Trigger: Runtime, context, or agent-profile `toolsetName` values were resolved through `ToolsetRegistry.get()`, which silently falls back to the default toolset for unknown names.
- Observed behavior: A typo in an explicit toolset override could widen a restricted agent to the default/full-access toolset, while prompts and actual tool registration could disagree.
- Impact: Explicit toolset names from runtime overrides, context metadata, presets, defaults, and subagent profiles must now resolve to a known toolset or fail. Each turn resolves one canonical toolset and passes it to both prompt construction and tool registration.
- Fix boundary: Toolset resolution and turn registry/prompt consistency only; known toolset definitions and allowed capabilities are unchanged.
- Commit: pending Round 9.

### OpenAI-compatible tool arguments reject malformed payloads

- Trigger: OpenAI-compatible provider responses could return malformed JSON or non-object tool arguments.
- Observed behavior: The adapter wrapped bad arguments as `{ "_raw": ... }` or `{ "value": ... }`, allowing them to continue into tool execution as ordinary objects.
- Impact: Malformed or non-object OpenAI-compatible tool arguments are now provider protocol errors. Tools execute only after arguments parse to a JSON object.
- Fix boundary: Provider output validation only; provider request format, valid JSON-object tool calls, and Anthropic behavior are unchanged.
- Commit: pending Round 9.

### Runtime skill drafts require review workflow approval

- Trigger: The default `skillWriteMode` was `auto`, and the model-callable `skill_manage` tool exposed `approve` and `reject` actions.
- Observed behavior: A runtime model turn could create and approve skills without a separate review boundary, contradicting the baseline rule that generated skills are proposals until approved.
- Impact: The default write mode is now `confirm`. Runtime `skill_manage` can create/update/list pending drafts, but approval and rejection must happen through the review workflow or direct governance services.
- Fix boundary: Runtime skill tool and default config only; explicit governance APIs, existing approved skills, and explicit auto-governance paths remain available.
- Commit: pending Round 9.

### Subagent profile config is preserved across lifecycle state

- Trigger: Subagent tasks could freeze agent-profile config for immediate execution, but the surrounding record/status/retry state did not consistently retain that config.
- Observed behavior: Agent profile settings such as LLM profile, reasoning, and prompt append could become hard to audit in status and risk being lost during retry reconstruction.
- Impact: Subagent records, status payloads, queued tasks, and retry entries now preserve selected agent profile config, including LLM profile, model, reasoning, global-skill loading, and prompt append data.
- Fix boundary: Subagent lifecycle metadata preservation only; scheduling, provider selection, and runner execution semantics are unchanged.
- Commit: pending Round 9.

### Plan Mode asks until requirements are clear

- Trigger: Plan Mode used a short prompt prefix that explained `finalize_plan` approval but did not strongly steer the model to keep asking high-value clarification questions before finalizing.
- Observed behavior: The agent could stop after one `request_user_input` round or finalize while important requirements remained unclear or contradictory.
- Impact: Plan Mode now uses a conversational planning prompt that requires read-only exploration first, repeated clarification until the plan is decision-complete, and `finalize_plan` for runtime approval. `request_user_input` results also carry a system hint to keep asking when requirements are still unclear or user answers contradict prior input or verified project context.
- Fix boundary: Plan Mode prompt/tool-result guidance only; `request_user_input` still accepts 1-3 questions per call, and execution approval still belongs to `finalize_plan`.
- Commit: pending Round 9.

### `schedule_task` is a base agent automation tool

- Trigger: Version 2.2.2 could still start turns where the agent did not see the scheduled-task tool.
- Observed behavior: `schedule_task` was injected only when a WebServer-provided automation store existed, and default non-hidden toolsets treated it as an unknown capability that could be filtered out.
- Impact: DPAgent now owns a single automation store under the runtime data directory, WebServer reuses that store, and session turns register `schedule_task` as a core/base tool. The full-access, windows-dev, and research toolsets explicitly include the new `automation_manage` capability; the read-heavy `windows-safe` toolset does not expose future-work scheduling.
- Fix boundary: Tool registration, toolset capability mapping, and prompt clarity only; automation route shapes and persisted job/run formats are unchanged.
- Commit: pending.

### Skill prompt source boundaries are explicit

- Trigger: Agent turns could conflate workspace skills, selected-agent bundled skills, and shared global skills when deciding whether to inspect or create skill drafts.
- Observed behavior: Skill runtime prompts listed visible skills without explaining source ownership, while `skill_manage` did not clearly state that agent-bundled skills are not a writable target.
- Impact: Skill catalog and management prompts now state that workspace skills are project-local, agent skills belong to the selected agent profile, and global skills are shared runtime skills. `skill_manage` remains a draft-submission tool only.
- Fix boundary: Prompt/schema descriptions only; skill discovery precedence, draft storage, and approval workflow semantics are unchanged.
- Commit: pending.

### Shared-link agent mentions use the shared access token

- Trigger: The same shared session link could show different `@agent` candidates on different clients.
- Observed behavior: The shared Web client fetched `/api/agents` without the share token. A browser with an existing remote-auth cookie received the full agent list, while a share-only browser was rejected by the HTTP auth boundary.
- Impact: Agent mention lookup now appends the current share token, and shared HTTP access allows read-only `GET /api/agents` with only the minimal mention fields (`name`, `description`) while still rejecting agent config and subagent catalog modes. Share-only and authenticated clients now resolve the same global mention names for a shared link.
- Fix boundary: Shared-link agent mention discovery only; agent config edits, subagent management, workspace agent pools, and prompt resolution remain behind their existing access rules.
- Commit: pending.

## Round 4 Records

### Legacy settings endpoints were removed

- Trigger: External scripts or callers continued to access `/api/config`, `/api/llm-profiles` GET/PUT, or `/api/settings/apikey`.
- Observed behavior: These routes were no longer registered; settings read/write must use `/api/settings`, while profile model discovery remains on `/api/llm-profiles/:id/discover-models`.
- Impact: Old step-by-step settings saves and API-key-only write scripts fail until they submit the canonical settings payload.
- Fix boundary: Settings API boundary only; field semantics, profile discovery route, and frontend settings behavior were not changed.
- Commit: R4-N1 `refactor: remove legacy settings endpoints`.

### Legacy agent context config fields are rejected

- Trigger: A config file or constructor still passed `agent.contextWindowChars`, `agent.contextPrecompress*`, `agent.contextOverflowForcedTrimChars`, or `agent.contextCompressionMaxChars`.
- Observed behavior: Config loading fails with an error directing the caller to root `contextBudget`.
- Impact: Old config cannot be silently migrated or cleaned; callers must submit canonical `contextBudget`.
- Fix boundary: Config input boundary only; runtime budget parsing, char/token telemetry, and root `contextBudget` semantics were not changed.
- Commit: R4-N2 `refactor: reject legacy context config fields`.

### Streaming tool input deltas must be scoped

- Trigger: A provider adapter or test double emitted a `tool_input` stream event without `id` or `index`, or with an index that did not match an active `tool_start`.
- Observed behavior: Old logic guessed the most recent tool call and appended the delta there, which could contaminate arguments when tool calls interleaved.
- Impact: Direct internal `LLMStreamEvent` producers must emit scoped deltas; normal Anthropic/OpenAI adapter paths already include index/id.
- Fix boundary: Internal stream event contract only; external provider request/response format and final tool call payload were not changed.
- Commit: R4-N4 `refactor: require scoped tool input deltas`.
