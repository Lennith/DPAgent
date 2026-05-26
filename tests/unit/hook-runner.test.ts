import * as assert from 'node:assert/strict';
import { HookRunner } from '../../src/hooks/HookRunner.js';
import type {
  LoadedHook, HookHandler,
  BeforeToolCallHookContext, InputToLLMHookContext, TurnStartHookContext,
} from '../../src/hooks/types.js';

function makeUserHook(
  id: string, events: string[], handler: HookHandler, priority = 100
): LoadedHook {
  return {
    entry: { id, events, module: `./hooks/${id}.cjs`, priority, enabled: true },
    handler,
    loadedAt: Date.now(),
  };
}

async function testUserBeforeSystem(): Promise<void> {
  const runner = new HookRunner();
  const order: string[] = [];

  const userHook = makeUserHook('u1', ['onTurnStart'], {
    onTurnStart: async () => { order.push('user'); return { action: 'continue' }; },
  });
  const sysHook = makeUserHook('s1', ['onTurnStart'], {
    onTurnStart: async () => { order.push('system'); return { action: 'continue' }; },
  });

  const ctx: TurnStartHookContext = { event: 'onTurnStart', sessionId: 't', step: 1, messages: [] };
  await runner.executeHook('onTurnStart', ctx, [userHook], [sysHook]);
  assert.deepEqual(order, ['user', 'system']);
}

async function testBlockStopsPipeline(): Promise<void> {
  const runner = new HookRunner();
  const after: string[] = [];
  const system: string[] = [];

  const blocker = makeUserHook('b', ['onInputToLLM'], {
    onInputToLLM: async () => ({ action: 'block', error: 'Blocked!' }),
  });
  const second = makeUserHook('s', ['onInputToLLM'], {
    onInputToLLM: async () => { after.push('second'); return { action: 'continue' }; },
  });
  const sysHook = makeUserHook('sys', ['onInputToLLM'], {
    onInputToLLM: async () => { system.push('system'); return { action: 'continue' }; },
  });

  const ctx: InputToLLMHookContext = {
    event: 'onInputToLLM', sessionId: 't', step: 1,
    systemPrompt: '', contentMessages: [], precompressApplied: false,
  };
  const result = await runner.executeHook('onInputToLLM', ctx, [blocker, second], [sysHook]);
  assert.equal(result.blocked, true);
  assert.equal(result.blockHookId, 'b');
  assert.equal(result.blockError, 'Blocked!');
  assert.deepEqual(after, []);
  assert.deepEqual(system, ['system']);
}

async function testThrowingHookDoesNotBreakPipeline(): Promise<void> {
  const runner = new HookRunner();
  const after: string[] = [];

  const bad = makeUserHook('bad', ['onTurnStart'], {
    onTurnStart: async () => { throw new Error('Boom!'); },
  });
  const good = makeUserHook('good', ['onTurnStart'], {
    onTurnStart: async () => { after.push('good'); return { action: 'continue' }; },
  });

  const ctx: TurnStartHookContext = { event: 'onTurnStart', sessionId: 't', step: 1, messages: [] };
  const result = await runner.executeHook('onTurnStart', ctx, [bad, good], []);
  assert.equal(result.blocked, false);
  assert.deepEqual(after, ['good']);
}

async function testBuildToolError(): Promise<void> {
  const runner = new HookRunner();
  const r = { blocked: true, blockError: 'Shell blocked by policy' };
  const ctx: BeforeToolCallHookContext = {
    event: 'onBeforeToolCall', sessionId: 't', step: 1,
    toolCall: { id: 'tc_1', type: 'function', function: { name: 'shell', arguments: {} } },
    toolName: 'shell', toolArgs: {},
  };
  const error = runner.buildToolError(r, ctx);
  const parsed = JSON.parse(error);
  assert.equal(parsed.type, 'tool_error');
  assert.equal(parsed.tool_call_id, 'tc_1');
  assert.equal(parsed.tool_name, 'shell');
  assert.ok(parsed.error.includes('Shell blocked'));
}

async function testBuildBlockedResponse(): Promise<void> {
  const runner = new HookRunner();
  assert.equal(runner.buildBlockedResponse({ blocked: true, blockError: 'Blocked' }, 'onInputToLLM'), 'Blocked');
}

void (async () => {
  await testUserBeforeSystem();
  await testBlockStopsPipeline();
  await testThrowingHookDoesNotBreakPipeline();
  await testBuildToolError();
  await testBuildBlockedResponse();
  console.log('hook-runner tests passed');
})();
