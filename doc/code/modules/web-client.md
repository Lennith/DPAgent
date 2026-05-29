# Web Client

## Responsibility
The Web client renders sessions, transcript, composer, Plan UI, Todo/Ralph
controls, settings, automation, governance, subagents, and runtime telemetry.

## Source Paths
- `src/web/client/`

## Key Files
- `src/web/client/App.tsx`: app shell composition.
- `src/web/client/app-shell-types.ts`: shared client DTOs and runtime state shapes.
- `src/web/client/hooks/useAppSessionController.ts`: session/runtime orchestration.
- `src/web/client/hooks/useWebSocket.ts`: WebSocket lifecycle.
- `src/web/client/components/chat/ChatInput.tsx`: composer UI.
- `src/web/client/components/chat/chat-input-interactivity.ts`: composer lock and Plan intent rules.
- `src/web/client/components/chat/ChatContainer.tsx`: transcript and live runtime view.
- `src/web/client/components/chat/PlanInputCard.tsx`, `FinalizedPlanCard.tsx`: Plan UI.
- `src/web/client/components/chat/SessionLlmBar.tsx`: session model control.
- `src/web/client/components/auto-loop/AutoLoopControl.tsx`: Ralph/Todo controls.

## Runtime Contracts
Committed transcript state comes from hydration or terminal events. Live deltas
are transient. Web-owned active runs can edit next-turn draft/model/Ralph
settings, while observe-only, canceling, and hydrating states are read-only.
The session fork button lives to the right of the share button. It is disabled
for shared/observe-only sessions, active runs, and pending plan input; success
refreshes the session list and opens the new `-fork` session.

## Edit Guidance
- Put state orchestration in hooks and rendering in components.
- Keep `app-shell-types.ts` aligned with server DTOs.
- Use `chat-input-interactivity.ts` for composer lock semantics.
- Update design docs for user-visible control behavior.

## Closest Tests
- `tests/unit/composer-input-state.test.ts`
- `tests/unit/web-memory-organize-ui.test.ts`
- `tests/unit/web-interrupted-artifact-ui.test.ts`
- `tests/e2e/release-plan-mode-ux.e2e.ts`
