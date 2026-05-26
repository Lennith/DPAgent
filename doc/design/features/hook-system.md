# Hook System

## Summary
The hook system allows developers to intercept key nodes in the DPAgent
execution pipeline. Hooks are registered via `hook.config.yaml` in the
workspace root and auto-loaded by the runtime. User hooks execute before
system hooks, can block certain actions, and are isolated from the core
pipeline (errors in user hooks never break the system).

## Hook Points (v1)
| Hook Event | When Fires | Can Block? | Block Result |
|---|---|---|---|
| `onTurnStart` | At the start of each agent turn, before any processing | Yes | Turn aborted with message |
| `onInputToLLM` | After input is prepared, before LLM call | Yes | Assistant response with error |
| `onLLMResponse` | After LLM responds, before tool/content extraction | No | — |
| `onBeforeToolCall` | Before each tool execution | Yes | `tool_error` injected into stream |
| `onAfterToolCall` | After tool result is materialized | No | — |
| `onTurnEnd` | After turn completes (any finish reason) | No | — |

## Pipeline Model
1. **User hooks** run first, sorted by priority (ascending, then registration order)
2. User hooks can return `{ action: 'block' }` to stop further processing
3. **System hooks** run after user hooks — they represent default processing and never block
4. If a user hook throws, the error is logged and the next hook runs normally

## Configuration
Hooks are defined in `hook.config.yaml` (workspace root). Each entry specifies:
- `id`: unique identifier
- `events`: array of hook event names
- `module`: path to a CommonJS module (relative to workspace root)
- `priority`: execution order (lower = earlier, default 100)
- `enabled`: whether active (default true)

## Hook Module Contract
Each hook module must export an object (CommonJS `exports.default = { ... }`) with
one or more handler methods matching the hook event names. Each handler receives
a typed context object and returns `{ action: 'continue' | 'block', error?: string }`.

## Fault Tolerance
- Missing hook modules: warning logged, hook skipped
- Module load failure: warning logged, hook skipped
- Handler throws: error logged, pipeline continues
- System hooks failing: error logged, pipeline continues

## References
- Source: `src/hooks/`
- Config: `hook.config.yaml`
- Code module: [hook-runtime](../code/modules/hook-runtime.md)
