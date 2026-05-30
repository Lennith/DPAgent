# Hook Runtime

## Responsibility
Hook runtime loads, validates, and executes user-defined hooks that intercept
key DPAgent execution nodes. It manages hook lifecycle, error isolation,
pipeline ordering, mutation contracts, and block semantics.

## Source Paths
- `src/hooks/`

## Key Files
- `src/hooks/types.ts`: Hook event types, context interfaces, HookHandler,
  HookConfig, HookResult, and runtime types.
- `src/hooks/HookRegistry.ts`: Loads and validates `hook.config.yaml`,
  lazy-loads hook modules, separates user/system hooks, caches resolved modules.
- `src/hooks/HookRunner.ts`: Executes the hook pipeline (user -> system),
  error isolation per hook, block handling per hook point type.
- `src/hooks/index.ts`: Public facade - exports types, HookRegistry, HookRunner.
- `hook.config.yaml`: Local hook configuration file in the workspace root.

## Runtime Contracts
Hooks are loaded from `hook.config.yaml` in the workspace root directory.
The file is validated against a strict schema. Invalid configs are rejected
with clear error messages and the hook system degrades to no-op.

Hook modules are resolved relative to the workspace root and loaded via
`require()`. Modules are cached after first load and never reloaded within
a session.

The execution pipeline is: user hooks (sorted by priority) -> system hooks.
System hooks are registered via `HookRegistry.registerSystemHook()` and always
execute. Blocking is only supported on `onBeforeToolCall`, `onInputToLLM`, and
`onTurnStart`.

When a user hook returns `action: "block"`, the runner stops executing later
user hooks for that event and marks the target action as blocked. System hooks
still run after the block for auditing and invariant maintenance, but their
return value must not unblock the target action. For `onBeforeToolCall`, the
caller records a tool error instead of executing the tool. For `onInputToLLM`
and `onTurnStart`, the caller completes the turn with `hook_blocked`.

`modified` is applied only for hook points that define an explicit mutation
contract. `onInputToLLM` may replace `systemPrompt`, `contentMessages`, or the
last user input via `input`/`prompt`. `onBeforeToolCall` may replace `toolName`
and `toolArgs` before tool callbacks and execution. Other hook points may
return `modified` for logging or future compatibility, but callers ignore it.

## Edit Guidance
- Hook types in `types.ts` must stay in sync with the 6 defined hook events.
- Block semantics are per-event: do not add generic block without defining
  the specific error injection path.
- Hook loading uses `createRequire()` from `node:module`; keep this
  mechanism scoped to `HookRegistry.ts`.
- Add new hook events by extending `HookEvent`, `HookContext`, and the
  handler interface in one pass.

## Closest Tests
- `tests/unit/hook-registry.test.ts`
- `tests/unit/hook-runner.test.ts`
