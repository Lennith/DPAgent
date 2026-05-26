# Hook Developer Guide

## Overview

DPAgent's hook system lets you intercept key nodes in the agent execution
pipeline. You write a CommonJS module, register it in `hook.config.yaml`,
and the runtime loads it automatically. Hooks can inspect, modify, or block
the pipeline at specific points.

## Quick Start

1. Create `hook.config.yaml` in your workspace root
2. Write a hook module (e.g. `hooks/my-hook.cjs`)
3. Start DPAgent — hooks load automatically

### Minimal `hook.config.yaml`

```yaml
hooks:
  - id: "my-hook"
    events: ["onInputToLLM", "onLLMResponse"]
    module: "./hooks/my-hook.cjs"
    priority: 100
    enabled: true
```

### Minimal Hook Module

```js
// hooks/my-hook.cjs
module.exports = {
  async onInputToLLM(ctx) {
    console.log(`[my-hook] Sending ${ctx.contentMessages.length} messages to LLM`);
    return { action: 'continue' };
  },
};
```

## Hook Events

| Event | When Fires | Can Block | Block Effect |
|---|---|---|---|
| `onTurnStart` | Before each agent turn | Yes | Turn aborted with message |
| `onInputToLLM` | Input prepared, about to send to LLM | Yes | Assistant response with error |
| `onLLMResponse` | LLM responded, before processing | No | — |
| `onBeforeToolCall` | Before `tool.execute()` | Yes | `tool_error` injected into stream |
| `onAfterToolCall` | After tool result materialized | No | — |
| `onTurnEnd` | After turn completes | No | — |

## Hook Context Reference

### onTurnStart

```js
async onTurnStart(ctx) {
  // ctx: {
  //   event: 'onTurnStart',
  //   sessionId: string,        // Current session id
  //   step: number,              // Turn step number (starts at 1)
  //   messages: Message[],       // All messages in the session store
  //   systemPrompt?: string,     // Active system prompt (if any)
  // }
  return { action: 'continue' };
}
```

### onInputToLLM

```js
async onInputToLLM(ctx) {
  // ctx: {
  //   event: 'onInputToLLM',
  //   sessionId: string,
  //   step: number,
  //   systemPrompt?: string,           // System prompt going to LLM
  //   contentMessages: Message[],      // Prepared messages going to LLM
  //   precompressApplied: boolean,     // Whether context was compressed
  // }

  // Example: count total characters
  const totalChars = ctx.contentMessages.reduce(
    (sum, m) => sum + JSON.stringify(m.content).length, 0
  );
  console.log(`Sending ${totalChars} chars to LLM`);

  return { action: 'continue' };
}
```

### onLLMResponse

```js
async onLLMResponse(ctx) {
  // ctx: {
  //   event: 'onLLMResponse',
  //   sessionId: string,
  //   step: number,
  //   response: {
  //     content: string,         // Assistant text content
  //     thinking?: string,       // Reasoning/thinking content
  //     toolCalls?: ToolCall[],  // Tool calls requested by LLM
  //     finishReason: string,    // Why LLM stopped
  //     usage?: { promptTokens, completionTokens, totalTokens },
  //   },
  // }

  // Example: log token usage
  if (ctx.response.usage) {
    console.log(`Turn ${ctx.step}: ${ctx.response.usage.totalTokens} tokens`);
  }

  return { action: 'continue' };
}
```

### onBeforeToolCall

```js
async onBeforeToolCall(ctx) {
  // ctx: {
  //   event: 'onBeforeToolCall',
  //   sessionId: string,
  //   step: number,
  //   toolCall: ToolCall,         // Full tool call object
  //   toolName: string,           // Tool name (e.g. 'shell_execute')
  //   toolArgs: Record<string, unknown>,  // Tool arguments
  // }

  // Example: block shell execution
  if (ctx.toolName === 'shell_execute') {
    return { action: 'block', error: 'Shell execution is disabled by policy' };
  }

  return { action: 'continue' };
}
```

### onAfterToolCall

```js
async onAfterToolCall(ctx) {
  // ctx: {
  //   event: 'onAfterToolCall',
  //   sessionId: string,
  //   step: number,
  //   toolCall: ToolCall,
  //   toolName: string,
  //   result: { success: boolean, content: string, error?: string },
  // }

  // Example: log tool results
  if (!ctx.result.success) {
    console.warn(`Tool ${ctx.toolName} failed: ${ctx.result.error}`);
  }

  return { action: 'continue' };
}
```

### onTurnEnd

```js
async onTurnEnd(ctx) {
  // ctx: {
  //   event: 'onTurnEnd',
  //   sessionId: string,
  //   step: number,
  //   finishReason: string,    // 'end_turn' | 'max_tokens' | 'cancelled' | ...
  //   content: string,         // Final assistant content
  //   usage?: TokenUsage,
  // }

  console.log(`Turn ${ctx.step} ended: ${ctx.finishReason}`);
  return { action: 'continue' };
}
```

## Block Semantics

When a hook returns `{ action: 'block', error: '...' }`:

| Hook Event | What Happens |
|---|---|
| `onTurnStart` | Turn is aborted. The agent returns the error as the turn result. |
| `onInputToLLM` | LLM is not called. The error becomes the assistant response. |
| `onBeforeToolCall` | Tool is not executed. A `tool_error` JSON object is injected into the message stream: `{"type":"tool_error","tool_call_id":"...","tool_name":"...","error":"..."}` |
| Others | Block is logged but the pipeline continues (block not supported on these events). |

## Data Modification (`modified` field)

Hooks can return a `modified` field alongside `action`. The runner shallow-merges
`modified` objects across hooks (last-write-wins per key). The merged result is
available as `HookExecutionResult.modified`.

```js
// Example: enrich tool results with metadata
async onAfterToolCall(ctx) {
  return {
    action: 'continue',
    modified: {
      result: {
        ...ctx.result,
        auditedAt: new Date().toISOString(),
        auditedBy: 'my-audit-hook',
      },
    },
  };
}
```

> **v1 Note:** In the current version, `modified` is collected and merged by the
> hook runner, but the default agent pipeline does not automatically apply the
> modifications. Hook authors can use `modified` to pass data between their own
> hooks or prepare for future integration. Full modification propagation is
> planned for v2.3.

## Pipeline Order

1. **User hooks** execute first, sorted by `priority` (ascending, lower = earlier)
2. The **first user hook that blocks** stops the pipeline (remaining user hooks are skipped)
3. **System hooks** always execute after user hooks, regardless of blocks
4. System hooks represent default processing and never block

## Error Isolation

User hook exceptions are **caught and logged**. They never break the agent pipeline:

```js
module.exports = {
  async onInputToLLM(ctx) {
    throw new Error('Boom!');  // Caught, logged, next hook still runs
  },
};
```

## Complete Plugin Example

See `./examples/full-hook-demo.cjs` for a plugin that handles all 6 events
and writes a structured log to a file.

## Debugging Tips

- Check `logs/` directory for hook-related log messages (search "HookRunner")
- Use `console.error()` in your hook for quick debug output — it appears in stderr
- If your hook isn't firing, check:
  - `hook.config.yaml` syntax (valid YAML, correct event names)
  - Module path is relative to workspace root and file exists
  - `enabled: true` is set
- Hook load errors appear in the agent log as `[HookRegistry]` warnings
- Use `priority` to control execution order between multiple hooks

## TypeScript Types (for reference)

```ts
interface HookResult {
  action: 'continue' | 'block';
  modified?: unknown;
  error?: string;
}

type HookEvent =
  | 'onTurnStart'
  | 'onInputToLLM'
  | 'onLLMResponse'
  | 'onBeforeToolCall'
  | 'onAfterToolCall'
  | 'onTurnEnd';
```

Full type definitions are in `src/hooks/types.ts`.
