/**
 * Crash Test Hook Plugin — deliberately throws on various events
 * to verify hook error isolation (user hook crashes must NOT break the pipeline).
 *
 * INSTALL:
 *   Add to hook.config.yaml alongside the full-hook-demo:
 *     - id: "crash-test"
 *       events: ["onInputToLLM", "onBeforeToolCall", "onTurnStart"]
 *       module: "./examples/crash-test-plugin.cjs"
 *       priority: 10
 *       enabled: true
 *
 * EXPECTED BEHAVIOR:
 *   - onTurnStart: throws → logged, next hook still runs
 *   - onInputToLLM: throws → logged, LLM call proceeds normally
 *   - onBeforeToolCall: throws → logged, tool executes normally
 *   - onLLMResponse: throws → logged, response processed normally
 *   - onAfterToolCall: throws → logged, result recorded normally
 *   - onTurnEnd: throws → logged, turn ends normally
 *
 * VERIFY: full-hook-demo.cjs entries still appear in the log after each crash.
 */

// Random crash probability (set to 1.0 for guaranteed crash, <1 for intermittent)
const CRASH_PROBABILITY = 1.0;

function maybeCrash(eventName) {
  if (Math.random() < CRASH_PROBABILITY) {
    throw new Error(`[crash-test] Intentional crash on ${eventName} — testing error isolation`);
  }
}

async function onTurnStart(ctx) {
  maybeCrash('onTurnStart');
  return { action: 'continue' };
}

async function onInputToLLM(ctx) {
  throw new Error(`[crash-test] Sync throw on onInputToLLM — step=${ctx.step}, messages=${ctx.contentMessages.length}`);
}

async function onLLMResponse(ctx) {
  // Async throw tester
  await new Promise((_, reject) => {
    setImmediate(() => reject(new Error(`[crash-test] Async rejection on onLLMResponse — step=${ctx.step}`)));
  });
  return { action: 'continue' };
}

async function onBeforeToolCall(ctx) {
  // Throw a non-Error value to test type coercion
  throw `[crash-test] String throw on onBeforeToolCall — tool=${ctx.toolName}`;
}

async function onAfterToolCall(ctx) {
  // Throw after await to test async error path
  await new Promise(r => setImmediate(r));
  const obj = null;
  obj.crash = true; // TypeError: Cannot set properties of null
  return { action: 'continue' };
}

async function onTurnEnd(ctx) {
  // Delayed crash
  await new Promise((_, reject) => setTimeout(() => reject(new Error(`[crash-test] Timeout crash on onTurnEnd`)), 10));
  return { action: 'continue' };
}

module.exports = {
  onTurnStart,
  onInputToLLM,
  onLLMResponse,
  onBeforeToolCall,
  onAfterToolCall,
  onTurnEnd,
};
