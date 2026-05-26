# Tool System

## Responsibility
The tool system registers local and MCP tools, filters capabilities by toolset,
executes tool calls, enforces permissions, and materializes large results as
artifacts.

## Source Paths
- `src/tools/`
- `src/runtime/dpagent-execution-tools.ts`

## Key Files
- `src/tools/ToolRegistry.ts`: per-run tool registry.
- `src/tools/tool-registration.ts`: core tool registration and capability dedupe.
- `src/tools/ToolsetRegistry.ts`: built-in toolsets and capability mapping.
- `src/tools/ToolAccessBase.ts`: shared filesystem permission checks.
- `src/tools/FileTools.ts`, `src/tools/ShellTool.ts`, `src/tools/WebTools.ts`: local capabilities.
- `src/tools/SendFileToUserTool.ts`: creates Web download links for readable local files.
- `src/tools/PlanModeTools.ts`: Plan Mode planning tools.
- `src/tools/TodoTool.ts`, `ExitAutoLoopTool.ts`: Todo and loop control tools.
- `src/tools/ToolResultArtifactTool.ts`: large-result artifact access.

## Runtime Contracts
Explicit toolset names must resolve to known toolsets. Unknown explicit names
fail instead of broadening to defaults. Permission failures are normal tool
results. Tool exposure must match the current run mode, especially Plan Mode
drafting.

`send_file_to_user` belongs to the `file_download` capability. It is available
only when the Web server has installed a download link issuer, file tools are
enabled, and the active toolset allows `file_download`.

## Edit Guidance
- Put operation semantics in the individual tool.
- Put shared permission/path logic in `ToolAccessBase`.
- Put capability exposure changes in `CapabilityCatalog` and toolset tests.
- Keep Plan Mode tool exposure aligned with [Plan Mode backend lifecycle](../../spec/protocols/plan-mode-backend-lifecycle.md).

## Closest Tests
- `tests/unit/tool-registration-dedupe.test.ts`
- `tests/unit/capability-catalog.test.ts`
- `tests/unit/toolset-registry.test.ts`
- `tests/unit/tool-result-payload-policy.test.ts`
- `tests/unit/execution-tool-registry-gating.test.ts`
- `tests/unit/permission-manager.test.ts`
- `tests/unit/plan-mode-tools.test.ts`
