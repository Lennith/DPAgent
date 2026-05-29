# Web Server

## Responsibility
The Web server exposes HTTP routes, WebSocket chat, runtime event bridging,
session ownership, Plan approval, settings mutation, automation routes, static
client serving, download links, and auth.

## Source Paths
- `src/web/server/`

## Key Files
- `src/web/server/WebServer.ts`: lifecycle facade and active-run coordination.
- `src/web/server/web-server-websocket.ts`: inbound WebSocket message dispatch.
- `src/web/server/callback-event-messages.ts`: outbound event shaping.
- `src/web/server/callback-event-dispatcher.ts`: callback-to-WebSocket dispatch.
- `src/web/server/web-server-route-contracts.ts`: route interaction-state helpers.
- `src/web/server/web-server-runtime-contracts.ts`: active-run/runtime DTOs.
- `src/web/server/web-server-session-routes.ts`: session list/detail and Plan routes.
- `src/web/server/download-link-service.ts`: opaque local-file download link store.
- `src/web/server/web-server-download-routes.ts`: authenticated `/download/:id` route.
- `src/web/server/pending-plan-input-coordinator.ts`: pending Plan input lifecycle.
- `src/web/server/web-server-callback-continuation.ts`: continuation scheduling.
- `src/web/server/config-mutation-service.ts`: transactional settings mutation.

## Runtime Contracts
Connection metadata classifies Web versus CLI ownership. Observe-only state is
enforced server-side. Active-run DTOs and WebSocket events are the shared
contract with the client.

`send_file_to_user` links are opaque IDs under `/download`; the Web server maps
the ID back to a readable local file and serves it as an attachment. The public
URL uses `web.publicBaseUrl` when configured. Without that setting, the href is
a same-origin `/download/...` path so remote browsers do not receive unusable
`localhost` links.

`POST /api/sessions/:id/fork` is a full-access-only mutation. It creates a new
session from a stable committed snapshot, returns the new session info, and
returns `409` when the source session is active, waiting for plan input, or has
interrupted recovery state.

## Edit Guidance
- Add domain routes in route modules instead of growing `WebServer.ts` when possible.
- Keep ownership checks close to route/WebSocket mutation entrypoints.
- Update protocol docs for any DTO, event, or lifecycle change.
- Keep WebSocket disconnect independent from backend-owned continuation.

## Closest Tests
- `tests/unit/web-ws-message-dispatch.test.ts`
- `tests/unit/web-chat-message.test.ts`
- `tests/unit/web-cancel-message.test.ts`
- `tests/unit/web-callback-event-messages.test.ts`
- `tests/unit/web-request-user-input.test.ts`
- `tests/unit/web-plan-input-response.test.ts`
- `tests/unit/session-fork.test.ts`
