---
name: dpagent-hook-build
description: Build and configure DPAgent hooks to intercept agent execution events. Use when the user wants to add hooks, intercept tool calls, log LLM activity, audit agent behavior, or set up custom processing pipelines in DPAgent.
---

# DPAgent Hook Builder

DPAgent hooks let users intercept key nodes in the agent execution pipeline.
Each hook is a CommonJS module registered in `hook.config.yaml`. Hooks can
inspect events, log data, or block specific actions (like tool calls).

All example scripts are in this skill directory; bundled examples live under `./examples/`.

## Step 1: Identify the Scenario

Ask the user what they want to achieve. Map their intent to hook events:

| User Intent | Recommended Events |
|-------------|-------------------|
| Log all LLM activity | `onInputToLLM`, `onLLMResponse`, `onTurnEnd` |
| Block dangerous shell commands | `onBeforeToolCall` |
| Audit tool usage | `onBeforeToolCall`, `onAfterToolCall` |
| Track every turn | `onTurnStart`, `onTurnEnd` |
| Review LLM input before sending | `onInputToLLM` (can block) |
| Full visibility | All 6 events |

### Available Hook Events

| Event | When | Can Block? |
|-------|------|-----------|
| `onTurnStart` | Before each agent turn | Yes → turn aborted |
| `onInputToLLM` | Input ready, about to send to LLM | Yes → error as response |
| `onLLMResponse` | LLM responded, before processing | No |
| `onBeforeToolCall` | Before tool execution | Yes → `tool_error` |
| `onAfterToolCall` | After tool result | No |
| `onTurnEnd` | After turn completes | No |

### Block Semantics

- `onBeforeToolCall` blocked → a JSON `tool_error` is injected: `{"type":"tool_error","tool_call_id":"...","tool_name":"...","error":"..."}`. The agent continues the conversation.
- `onInputToLLM` blocked → the error message becomes the assistant response. The turn ends with `hook_blocked`. The agent can continue in the next turn.
- `onTurnStart` blocked → the turn is aborted with the error message.

## Step 2: Create the Hook Config

Create `hook.config.yaml` in the DPAgent **workspace root** (where `config.yaml` lives):

```yaml
hooks:
  - id: "my-hook"
    events: ["onInputToLLM", "onLLMResponse"]
    module: "./hooks/my-hook.cjs"
    priority: 100
    enabled: true
```

**Fields:**
- `id` — unique name for this hook
- `events` — which events to subscribe to (see table above)
- `module` — path to the hook script, relative to workspace root
- `priority` — lower runs first (default 100)
- `enabled` — toggle on/off without deleting

You can register multiple hooks. They run in priority order (user hooks first → system hooks after).

## Step 3: Write the Hook Module

Create a CommonJS file (`.cjs`) that exports handler functions. Each handler
receives a context object and returns `{ action: 'continue' }` or
`{ action: 'block', error: 'reason' }`.

### Minimal Hook (Log LLM Activity)

```js
// hooks/my-hook.cjs  ← relative to workspace root
const fs = require('fs');

module.exports = {
  async onInputToLLM(ctx) {
    // ctx: { sessionId, step, systemPrompt, contentMessages, precompressApplied }
    fs.appendFileSync('hook.log', `[input] step=${ctx.step} messages=${ctx.contentMessages.length}\n`);
    return { action: 'continue' };
  },

  async onLLMResponse(ctx) {
    // ctx: { sessionId, step, response: { content, thinking, toolCalls, finishReason, usage } }
    const tc = ctx.response.toolCalls?.length ?? 0;
    fs.appendFileSync('hook.log', `[response] finish=${ctx.response.finishReason} tools=${tc}\n`);
    return { action: 'continue' };
  },
};
```

### Tool Blocker (Audit Shell Commands)

```js
// hooks/tool-guard.cjs
module.exports = {
  async onBeforeToolCall(ctx) {
    // ctx: { sessionId, step, toolCall, toolName, toolArgs }
    if (ctx.toolName === 'shell_execute') {
      const cmd = String(ctx.toolArgs.command ?? '').toLowerCase();
      if (cmd.includes('rm -rf') || cmd.includes('del /f')) {
        return { action: 'block', error: 'Destructive command blocked by hook' };
      }
    }
    return { action: 'continue' };
  },
};
```

### Full Logger (All 6 Events)

See `./examples/full-hook-demo.cjs` — a complete
example that logs all events to a JSON-lines file.

### Error Isolation

User hooks that throw are caught and logged. They never break the agent
pipeline. Other hooks continue to run normally.

## Step 4: Verify

After creating the config and module, restart DPAgent. Verify:

1. **Check hook loading in logs:**
   Look for `[HookRegistry] Loaded N user hook(s)` in the startup log.

2. **Test the hook:**
   Run a short conversation. The hook should fire on the subscribed events.

3. **Check for errors:**
   If hooks don't fire, check:
   - `hook.config.yaml` is in the workspace root
   - Module path is correct relative to workspace root
   - `enabled: true` is set
   - Event names match exactly (case-sensitive)
   - Hook log warnings: search for `[HookRegistry]` and `[HookRunner]`

4. **Run the built-in E2E test:**
   ```powershell
   node ./hook-e2e-test.js
   ```
   This tests all 6 events with the demo plugin. Requires a running DPAgent
   with API access configured.

## Hook Context Reference

Each handler receives a typed context. See the table below or check
`./hook-developer-guide.md` for detailed docs.

| Event | Context Fields |
|-------|---------------|
| `onTurnStart` | `sessionId`, `step`, `messages[]`, `systemPrompt?` |
| `onInputToLLM` | `sessionId`, `step`, `systemPrompt?`, `contentMessages[]`, `precompressApplied` |
| `onLLMResponse` | `sessionId`, `step`, `response: { content, thinking, toolCalls, finishReason, usage }` |
| `onBeforeToolCall` | `sessionId`, `step`, `toolCall`, `toolName`, `toolArgs` |
| `onAfterToolCall` | `sessionId`, `step`, `toolCall`, `toolName`, `result: { success, content, error? }` |
| `onTurnEnd` | `sessionId`, `step`, `finishReason`, `content`, `usage?` |

## Reference

- Source: `src/hooks/` (types, registry, runner)
- Design: `doc/design/features/hook-system.md`
- Code: `doc/code/modules/hook-runtime.md`
- Full guide: `./hook-developer-guide.md`
- Demo plugin: `./examples/full-hook-demo.cjs`
- Crash test: `./examples/crash-test-plugin.cjs`
