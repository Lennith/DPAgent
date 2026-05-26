import * as assert from 'node:assert/strict';
import { createCallbackEventDispatcher } from '../../src/web/server/callback-event-dispatcher.js';
import type { ContextRef, PlanInputRequest } from '../../src/types.js';

function createRequest(): PlanInputRequest {
  return {
    requestId: 'req-1',
    questions: [
      {
        header: 'Mode',
        id: 'mode',
        question: 'Pick a mode',
        options: [
          { label: 'Fast', description: 'Speed first' },
          { label: 'Safe', description: 'Risk first' },
        ],
      },
    ],
  };
}

function stripCreatedAt(messages: Array<{ type: string; data: unknown }>): Array<{ type: string; data: unknown }> {
  return messages.map((message) => {
    if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)) {
      return message;
    }
    const data = { ...(message.data as Record<string, unknown>) };
    delete data.createdAt;
    return {
      ...message,
      data,
    };
  });
}

function testDispatcherForwardsMessagesToSinkInOrder(): void {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const captured: Array<{ type: string; data: unknown }> = [];
  const dispatcher = createCallbackEventDispatcher(
    (message) => {
      captured.push(message);
    },
    { runId: 'run-1', context }
  );

  dispatcher.thinking('plan first');
  dispatcher.memoryTrigger({
    title: 'Workspace preference',
    content: 'Use PowerShell.',
    scope: 'workspace',
  });
  dispatcher.toolResult('request_user_input', { success: true, content: 'done' });
  dispatcher.error('run_error');

  assert.equal(typeof (captured[0]?.data as { createdAt?: string }).createdAt, 'string');
  assert.equal(typeof (captured[2]?.data as { createdAt?: string }).createdAt, 'string');
  assert.deepEqual(stripCreatedAt(captured), [
    {
      type: 'thinking',
      data: {
        runId: 'run-1',
        context,
        thinking: 'plan first',
      },
    },
    {
      type: 'memory_trigger',
      data: {
        runId: 'run-1',
        context,
        title: 'Workspace preference',
        content: 'Use PowerShell.',
        scope: 'workspace',
      },
    },
    {
      type: 'tool_result',
      data: {
        runId: 'run-1',
        context,
        name: 'request_user_input',
        result: { success: true, content: 'done' },
      },
    },
    {
      type: 'error',
      data: {
        runId: 'run-1',
        context,
        error: 'run_error',
      },
    },
  ]);
}

function testDispatcherHandlesStructuredMessages(): void {
  const context: ContextRef = { scope: 'session', namespace: 'sess-9' };
  const captured: Array<{ type: string; data: unknown }> = [];
  const dispatcher = createCallbackEventDispatcher(
    (message) => {
      captured.push(message);
    },
    { runId: 'run-9', context }
  );

  dispatcher.contextPrecompress({
    observedAt: '2026-04-05T00:00:30.000Z',
    ratio: 0.82,
    usedChars: 3280,
    limitChars: 4000,
    usedTokens: 1640,
    limitTokens: 2000,
    checkpointId: null,
    failureReason: 'compress_timeout',
  });
  dispatcher.contextUtilization({
    observedAt: '2026-04-05T00:00:31.000Z',
    ratio: 0.9,
    usedChars: 3600,
    limitChars: 4000,
    usedTokens: 1800,
    limitTokens: 2000,
    triggerRatio: 0.8,
    isWarning: true,
    message: 'Context approaching capacity - compression triggered',
  });
  dispatcher.skillTrigger({
    name: 'release-workflow',
    action: 'create',
    target: 'workspace',
    version: '1',
  });
  dispatcher.planInputRequested(createRequest());
  dispatcher.complete('done');
  dispatcher.autoLoopStopped('done', 3);
  dispatcher.autoLoopRound(4, 'Continue');
  dispatcher.chatStarted('2026-04-05T00:02:00.000Z', {
    profileId: 'profile-kimi',
    provider: 'anthropic',
    apiKey: 'sk-test',
    apiBase: 'https://api.kimi.com/coding/',
    model: 'kimi-for-coding',
    maxOutputTokens: 32768,
    reasoningPreset: 'off',
    capabilities: {
      reasoningEffort: false,
      thinkingBudget: true,
    },
  });

  assert.equal(typeof (captured[4]?.data as { createdAt?: string }).createdAt, 'string');
  assert.deepEqual(stripCreatedAt(captured), [
    {
      type: 'context_precompress',
      data: {
        runId: 'run-9',
        context,
        observedAt: '2026-04-05T00:00:30.000Z',
        ratio: 0.82,
        usedChars: 3280,
        limitChars: 4000,
        usedTokens: 1640,
        limitTokens: 2000,
        checkpointId: null,
        failureReason: 'compress_timeout',
      },
    },
    {
      type: 'context_utilization',
      data: {
        runId: 'run-9',
        context,
        observedAt: '2026-04-05T00:00:31.000Z',
        ratio: 0.9,
        utilizationRatio: 0.9,
        usedChars: 3600,
        limitChars: 4000,
        usedTokens: 1800,
        limitTokens: 2000,
        triggerRatio: 0.8,
        isWarning: true,
        message: 'Context approaching capacity - compression triggered',
      },
    },
    {
      type: 'skill_trigger',
      data: {
        runId: 'run-9',
        context,
        name: 'release-workflow',
        action: 'create',
        target: 'workspace',
        version: '1',
      },
    },
    {
      type: 'plan_input_requested',
      data: {
        runId: 'run-9',
        context,
        requestId: 'req-1',
        questions: createRequest().questions,
      },
    },
    {
      type: 'complete',
      data: {
        runId: 'run-9',
        context,
        content: 'done',
        completionMarkerStats: null,
        sessionId: 'sess-9',
      },
    },
    {
      type: 'auto_loop_stopped',
      data: {
        runId: 'run-9',
        context,
        reason: 'done',
        totalRounds: 3,
      },
    },
    {
      type: 'auto_loop_round',
      data: {
        runId: 'run-9',
        context,
        round: 4,
        prompt: 'Continue',
      },
    },
    {
      type: 'chat_started',
      data: {
        runId: 'run-9',
        context,
        startedAt: '2026-04-05T00:02:00.000Z',
        llmRuntime: {
          profileId: 'profile-kimi',
          provider: 'anthropic',
          model: 'kimi-for-coding',
          reasoningPreset: 'off',
        },
      },
    },
  ]);
}

function runAll(): void {
  testDispatcherForwardsMessagesToSinkInOrder();
  testDispatcherHandlesStructuredMessages();
  console.log('web-callback-event-dispatcher tests passed');
}

runAll();
