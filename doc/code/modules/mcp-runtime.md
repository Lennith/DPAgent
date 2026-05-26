# MCP Runtime

## Responsibility
MCP runtime starts configured external MCP servers, discovers tools, registers
them into the tool system, invokes them, monitors health, and reconnects.

## Source Paths
- `src/mcp/`
- `src/tools/tool-registration.ts`
- `src/web/client/mcp-status.ts`

## Key Files
- `src/mcp/MCPConnector.ts`: one server lifecycle and tool calls.
- `src/mcp/SharedMcpRuntimePool.ts`: connector reuse and reference counting.
- `src/tools/tool-registration.ts`: MCP tool registration into the active registry.
- `src/web/client/mcp-status.ts`: client-side MCP status normalization.

## Runtime Contracts
MCP tools obey active toolset policy. CLI-origin external MCP attachments are
accepted only from CLI-origin connections. Connection failures are visible and
recoverable without corrupting session state.

## Edit Guidance
- Put process lifecycle and reconnect behavior in MCP connector/pool modules.
- Keep tool exposure routed through the same capability path as local tools.
- Update Web status routes and UI tests when status shape changes.

## Closest Tests
- `tests/integration/mcp.test.ts`
- `tests/unit/mcp-runtime-config.test.ts`
- `tests/unit/mcp-shared-runtime.test.ts`
- `tests/unit/mcp-connector-reconnect.test.ts`
- `tests/unit/mcp-status-ui.test.ts`
