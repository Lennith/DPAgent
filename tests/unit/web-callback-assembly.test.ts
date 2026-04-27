import * as assert from 'node:assert/strict';
import { WebServer } from '../../src/web/server/WebServer.js';
import { autoLoopManager } from '../../src/auto-loop/index.js';
import type { ContextRef } from '../../src/types.js';

interface EmittedMessage {
  ws: object;
  type: string;
  data: unknown;
}

function createHarness(context: ContextRef = { scope: 'session', namespace: 'sess-1' }) {
  const lifecycle: string[] = [];
  const emitted: EmittedMessage[] = [];
  const server = Object.create(WebServer.prototype) as any;

  server.agent = {
    getConfig: () => ({
      agent: {
        tokenLimit: 1000,
        contextWindowChars: 50000,
      },
    }),
  };
  server.emitToClient = (ws: object, message: Omit<EmittedMessage, 'ws'>) => {
    lifecycle.push(`emit:${message.type}`);
    emitted.push({ ws, ...message });
  };
  server.rejectPendingPlanInputByRunId = (runId: string, reason: string) => {
    lifecycle.push(`reject:${runId}:${reason}`);
  };
  server.refreshGlobalAgentCatalog = () => {
    lifecycle.push('refresh');
  };
  server.requestUserInputFromSocket = async (
    ws: object,
    nextContext: ContextRef,
    runId: string,
    request: unknown,
    emitRequested: (request: unknown) => void
  ) => {
    lifecycle.push(`request:${runId}`);
    emitRequested(request);
    return [{ id: 'mode', selectedLabel: 'Safe', selectedIndex: 1, freeText: undefined }];
  };
  server.handleCallbackCompletion = async (
    ws: object,
    nextContext: ContextRef,
    runId: string,
    loopKey: string,
    result: string,
    dispatcher: { complete: (content: string) => void }
  ) => {
    lifecycle.push(`complete:${loopKey}:${runId}:${result}`);
    dispatcher.complete(result);
  };
  server.requestAutoLoopExitFromCallback = (
    loopKey: string,
    nextContext: ContextRef,
    runId: string,
    reason?: string
  ) => {
    lifecycle.push(`exit:${loopKey}:${runId}:${reason ?? ''}`);
    return {
      accepted: true,
      message: 'queued',
    };
  };

  const originalGet = autoLoopManager.get;

  return {
    server,
    context,
    socket: { readyState: 1, socket: 'open' },
    lifecycle,
    emitted,
    setAutoLoopGet(getImpl: (key: string) => unknown) {
      (autoLoopManager as any).get = getImpl;
    },
    restore() {
      (autoLoopManager as any).get = originalGet;
    },
  };
}

function testCreateObservationCallbacksExposeOnlyObservationHooks(): void {
  const harness = createHarness();
  try {
    const callbacks = harness.server.createObservationCallbacks({
      thinking: () => {},
      toolCall: () => {},
      toolResult: () => {},
      step: () => {},
      message: () => {},
      contextUtilization: () => {},
      contextPrecompress: () => {},
      contextOverflow: () => {},
    });

    assert.equal(typeof callbacks.onThinking, 'function');
    assert.equal(typeof callbacks.onToolCall, 'function');
    assert.equal(typeof callbacks.onToolResult, 'function');
    assert.equal(typeof callbacks.onStep, 'function');
    assert.equal(typeof callbacks.onMessage, 'function');
    assert.equal(typeof callbacks.onContextPrecompress, 'function');
    assert.equal(typeof callbacks.onContextOverflow, 'function');
    assert.equal('onError' in callbacks, false);
    assert.equal('onComplete' in callbacks, false);
  } finally {
    harness.restore();
  }
}

function testCreateControlCallbacksExposeOnlyControlHooks(): void {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-a' });
  try {
    const callbacks = harness.server.createControlCallbacks(
      harness.socket,
      harness.context,
      'run-1',
      'workspace:repo-a',
      {
        error: () => {},
        planInputRequested: () => {},
        complete: () => {},
      }
    );

    assert.equal(typeof callbacks.onError, 'function');
    assert.equal(typeof callbacks.onRequestUserInput, 'function');
    assert.equal(typeof callbacks.onComplete, 'function');
    assert.equal(typeof callbacks.isInAutoLoop, 'function');
    assert.equal(typeof callbacks.requestAutoLoopExit, 'function');
    assert.equal('onThinking' in callbacks, false);
    assert.equal('onToolCall' in callbacks, false);
  } finally {
    harness.restore();
  }
}

function testCreateCallbackObservationEventsPreserveWireBehavior(): void {
  const harness = createHarness();
  try {
    const callback = harness.server.createCallback(harness.socket, harness.context, 'run-1');

    callback.onThinking?.('plan first');
    callback.onToolCall?.('request_user_input', { fast: false });
    callback.onToolResult?.('request_user_input', { success: true, content: 'done' });
    callback.onStep?.(2, 10);
    callback.onMessage?.('assistant', 'done');

    assert.deepEqual(harness.emitted, [
      {
        ws: harness.socket,
        type: 'thinking',
        data: {
          runId: 'run-1',
          context: harness.context,
          thinking: 'plan first',
        },
      },
      {
        ws: harness.socket,
        type: 'tool_call',
        data: {
          runId: 'run-1',
          context: harness.context,
          name: 'request_user_input',
          args: { fast: false },
        },
      },
      {
        ws: harness.socket,
        type: 'tool_result',
        data: {
          runId: 'run-1',
          context: harness.context,
          name: 'request_user_input',
          result: { success: true, content: 'done' },
        },
      },
      {
        ws: harness.socket,
        type: 'step',
        data: {
          runId: 'run-1',
          context: harness.context,
          step: 2,
          maxSteps: 10,
        },
      },
      {
        ws: harness.socket,
        type: 'message',
        data: {
          runId: 'run-1',
          context: harness.context,
          role: 'assistant',
          content: 'done',
        },
      },
    ]);
  } finally {
    harness.restore();
  }
}

function testCreateCallbackContextSignalsPreserveThresholdBehavior(): void {
  const harness = createHarness();
  try {
    const callback = harness.server.createCallback(harness.socket, harness.context, 'run-1');

    callback.onContextPrecompress?.({
      phase: 'running',
      triggered: true,
      observedAt: '2026-04-06T00:00:00.000Z',
      totalCharsAfter: 3200,
      profileRuntimePath: null,
    } as any);
    callback.onContextPrecompress?.({
      phase: 'failed',
      triggered: true,
      observedAt: '2026-04-06T00:00:01.000Z',
      totalCharsAfter: 3250,
      profileRuntimePath: 'profile-a',
      failureReason: 'compress_timeout',
    } as any);
    callback.onContextOverflow?.({
      observedAt: '2026-04-06T00:00:02.000Z',
      beforeChars: 3900,
      afterChars: 4050,
      stage: 'apply',
      errorRaw: 'overflow',
      contextOverflowSnapshotPath: 'snapshot-a',
    } as any);

    assert.deepEqual(harness.emitted.map((message) => message.type), [
      'context_precompress',
      'context_precompress',
      'context_utilization',
      'context_overflow',
    ]);
    assert.deepEqual(harness.emitted[0]?.data, {
      runId: 'run-1',
      context: harness.context,
      observedAt: '2026-04-06T00:00:00.000Z',
      phase: 'running',
      ratio: 0.064,
      usedChars: 3200,
      limitChars: 50000,
      checkpointId: null,
    });
    assert.deepEqual(harness.emitted[1]?.data, {
      runId: 'run-1',
      context: harness.context,
      observedAt: '2026-04-06T00:00:01.000Z',
      phase: 'failed',
      ratio: 0.065,
      usedChars: 3250,
      limitChars: 50000,
      checkpointId: 'profile-a',
      failureReason: 'compress_timeout',
    });
    assert.equal((harness.emitted[2]?.data as any).runId, 'run-1');
    assert.equal((harness.emitted[2]?.data as any).ratio, 0.081);
    assert.equal((harness.emitted[2]?.data as any).utilizationRatio, 0.081);
    assert.equal((harness.emitted[2]?.data as any).usedChars, 4050);
    assert.equal((harness.emitted[2]?.data as any).isWarning, true);
    assert.equal(
      (harness.emitted[2]?.data as any).message,
      'Context overflow: apply. Consider saving important work.'
    );
    assert.deepEqual(harness.emitted[3]?.data, {
      runId: 'run-1',
      context: harness.context,
      observedAt: '2026-04-06T00:00:02.000Z',
      error: 'overflow',
      stage: 'apply',
      checkpointId: 'snapshot-a',
    });
  } finally {
    harness.restore();
  }
}

function testCreateCallbackForwardsForcedPrecompressEvents(): void {
  const harness = createHarness();
  try {
    const callback = harness.server.createCallback(harness.socket, harness.context, 'run-forced');

    callback.onContextPrecompress?.({
      phase: 'running',
      triggered: false,
      forced: true,
      observedAt: '2026-04-06T00:00:03.000Z',
      totalCharsAfter: 1200,
      profileRuntimePath: null,
    } as any);

    assert.deepEqual(harness.emitted.map((message) => message.type), ['context_precompress']);
    assert.deepEqual(harness.emitted[0]?.data, {
      runId: 'run-forced',
      context: harness.context,
      observedAt: '2026-04-06T00:00:03.000Z',
      phase: 'running',
      ratio: 0.024,
      usedChars: 1200,
      limitChars: 50000,
      checkpointId: null,
    });
  } finally {
    harness.restore();
  }
}

async function testCreateCallbackControlHooksPreserveWiring(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-a' });
  try {
    harness.setAutoLoopGet((key: string) => ({
      isInLoop: () => {
        harness.lifecycle.push(`in-loop:${key}`);
        return true;
      },
    }));

    const callback = harness.server.createCallback(harness.socket, harness.context, 'run-1');

    callback.onError?.(new Error('run_error'));
    const answers = await callback.onRequestUserInput?.({
      requestId: 'req-1',
      questions: [],
    });
    await callback.onComplete?.('done');
    const inAutoLoop = callback.isInAutoLoop?.();
    const exitResponse = callback.requestAutoLoopExit?.('ship it');

    assert.deepEqual(answers, [{ id: 'mode', selectedLabel: 'Safe', selectedIndex: 1, freeText: undefined }]);
    assert.equal(inAutoLoop, true);
    assert.deepEqual(exitResponse, { accepted: true, message: 'queued' });
    assert.deepEqual(harness.lifecycle, [
      'reject:run-1:run_error',
      'refresh',
      'request:run-1',
      'emit:plan_input_requested',
      'complete:workspace:repo-a:run-1:done',
      'emit:complete',
      'in-loop:workspace:repo-a',
      'exit:workspace:repo-a:run-1:ship it',
    ]);
  } finally {
    harness.restore();
  }
}

async function runAll(): Promise<void> {
  testCreateObservationCallbacksExposeOnlyObservationHooks();
  testCreateControlCallbacksExposeOnlyControlHooks();
  testCreateCallbackObservationEventsPreserveWireBehavior();
  testCreateCallbackContextSignalsPreserveThresholdBehavior();
  testCreateCallbackForwardsForcedPrecompressEvents();
  await testCreateCallbackControlHooksPreserveWiring();
  console.log('web-callback-assembly tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
