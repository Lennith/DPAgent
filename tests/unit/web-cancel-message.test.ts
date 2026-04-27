import * as assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { WebServer } from '../../src/web/server/WebServer.js';
import { autoLoopManager } from '../../src/auto-loop/index.js';
import type { ContextRef } from '../../src/types.js';

interface EmittedMessage {
  ws: object;
  type: string;
  data: unknown;
}

interface CancelHarness {
  server: any;
  openSocket: { readyState: number; socket: string };
  emitted: EmittedMessage[];
  lifecycle: string[];
}

function createHarness(
  activeEntries?: ReadonlyArray<readonly [string, ContextRef]>
): CancelHarness {
  const server = Object.create(WebServer.prototype) as any;
  const emitted: EmittedMessage[] = [];
  const lifecycle: string[] = [];

  server.activeRunContexts = new Map(activeEntries ?? []);
  server.emitToClient = (ws: object, message: Omit<EmittedMessage, 'ws'>) => {
    lifecycle.push(`emit:${message.type}`);
    emitted.push({ ws, ...message });
  };
  server.refreshGlobalAgentCatalog = () => {
    lifecycle.push('refresh');
  };

  return {
    server,
    openSocket: { readyState: WebSocket.OPEN, socket: 'open' },
    emitted,
    lifecycle,
  };
}

async function testHandleWSMessageCancelDelegatesToDedicatedHelper(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleCancelMessage = (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleCancelMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'cancel',
    data: {
      runId: 'run-1',
    },
  });

  assert.deepEqual(harness.lifecycle, ['handleCancelMessage']);
  assert.deepEqual(captured, [
    harness.openSocket,
    {
      runId: 'run-1',
    },
  ]);
}

async function testHandleCancelMessageCancelsAllWhenNoContextResolves(): Promise<void> {
  const harness = createHarness();

  harness.server.agent = {
    cancel: () => {
      harness.lifecycle.push('agent.cancel');
    },
  };
  harness.server.rejectPendingPlanInputByRunId = (runId: string, reason: string) => {
    harness.lifecycle.push(`rejectByRunId:${runId}:${reason}`);
  };

  harness.server.handleCancelMessage(harness.openSocket, {
    runId: ' run-orphan ',
  });

  assert.deepEqual(harness.lifecycle, [
    'rejectByRunId:run-orphan:run_canceled',
    'agent.cancel',
    'emit:cancel_ack',
    'refresh',
  ]);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'cancel_ack',
      data: {
        runId: ' run-orphan ',
        canceled: 'all',
      },
    },
  ]);
}

async function testHandleCancelMessageCancelsScopedSessionAndStopsAutoLoopBeforeAck(): Promise<void> {
  const harness = createHarness();
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };

  harness.server.agent = {
    cancelContext: (nextContext: ContextRef) => {
      harness.lifecycle.push(`agent.cancelContext:${nextContext.scope}:${nextContext.namespace}`);
      return 2;
    },
  };
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${nextContext.scope}:${nextContext.namespace}:${reason}`);
  };
  harness.server.stopAutoLoopForContext = (nextContext: ContextRef, ws: object) => {
    harness.lifecycle.push(`stopAutoLoopForContext:${nextContext.scope}:${nextContext.namespace}`);
    harness.server.emitToClient(ws, {
      type: 'auto_loop_stopped',
      data: {
        context: nextContext,
        reason: 'User stopped auto loop',
        totalRounds: 4,
      },
    });
  };

  harness.server.handleCancelMessage(harness.openSocket, {
    sessionId: 'sess-1',
  });

  assert.deepEqual(harness.lifecycle, [
    'agent.cancelContext:session:sess-1',
    'rejectByContext:session:sess-1:run_canceled',
    'stopAutoLoopForContext:session:sess-1',
    'emit:auto_loop_stopped',
    'emit:cancel_ack',
    'refresh',
  ]);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'auto_loop_stopped',
      data: {
        context,
        reason: 'User stopped auto loop',
        totalRounds: 4,
      },
    },
    {
      ws: harness.openSocket,
      type: 'cancel_ack',
      data: {
        runId: null,
        context,
        canceledCount: 2,
      },
    },
  ]);
}

async function testHandleCancelMessagePrefersExplicitContextOverRunIdLookup(): Promise<void> {
  const explicitContext: ContextRef = { scope: 'session', namespace: 'sess-explicit' };
  const runContext: ContextRef = { scope: 'workspace', namespace: 'repo-a' };
  const harness = createHarness([['run-1', runContext]]);

  harness.server.agent = {
    cancelContext: (nextContext: ContextRef) => {
      harness.lifecycle.push(`agent.cancelContext:${nextContext.scope}:${nextContext.namespace}`);
      return 3;
    },
  };
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${nextContext.scope}:${nextContext.namespace}:${reason}`);
  };
  harness.server.stopAutoLoopForContext = (nextContext: ContextRef, ws: object) => {
    harness.lifecycle.push(`stopAutoLoopForContext:${nextContext.scope}:${nextContext.namespace}`);
    harness.server.emitToClient(ws, {
      type: 'auto_loop_stopped',
      data: {
        context: nextContext,
        reason: 'User stopped auto loop',
        totalRounds: 5,
      },
    });
  };

  harness.server.handleCancelMessage(harness.openSocket, {
    runId: 'run-1',
    context: explicitContext,
  });

  assert.deepEqual(harness.lifecycle, [
    'agent.cancelContext:session:sess-explicit',
    'rejectByContext:session:sess-explicit:run_canceled',
    'stopAutoLoopForContext:session:sess-explicit',
    'emit:auto_loop_stopped',
    'emit:cancel_ack',
    'refresh',
  ]);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'auto_loop_stopped',
      data: {
        context: explicitContext,
        reason: 'User stopped auto loop',
        totalRounds: 5,
      },
    },
    {
      ws: harness.openSocket,
      type: 'cancel_ack',
      data: {
        runId: null,
        context: explicitContext,
        canceledCount: 3,
      },
    },
  ]);
}

async function testHandleCancelMessageTreatsMalformedExplicitContextAsAuthoritativeNoOp(): Promise<void> {
  const runContext: ContextRef = { scope: 'workspace', namespace: 'repo-a' };
  const harness = createHarness([['run-1', runContext]]);

  harness.server.agent = {
    cancel: () => {
      harness.lifecycle.push('agent.cancel');
    },
    cancelContext: (nextContext: ContextRef) => {
      harness.lifecycle.push(`agent.cancelContext:${nextContext.scope}:${nextContext.namespace}`);
      return 1;
    },
  };
  harness.server.rejectPendingPlanInputByRunId = (runId: string, reason: string) => {
    harness.lifecycle.push(`rejectByRunId:${runId}:${reason}`);
  };
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${nextContext.scope}:${nextContext.namespace}:${reason}`);
  };

  harness.server.handleCancelMessage(harness.openSocket, {
    runId: 'run-1',
    sessionId: 'sess-fallback',
    context: { scope: 'session', namespace: '   ' } as unknown as ContextRef,
  });

  assert.deepEqual(harness.lifecycle, []);
  assert.deepEqual(harness.emitted, []);
}

async function testHandleCancelMessageKeepsRunIdWhenExplicitContextMatchesRunTarget(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-shared' };
  const harness = createHarness([['run-1', context]]);

  harness.server.agent = {
    cancelContext: (nextContext: ContextRef) => {
      harness.lifecycle.push(`agent.cancelContext:${nextContext.scope}:${nextContext.namespace}`);
      return 6;
    },
  };
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${nextContext.scope}:${nextContext.namespace}:${reason}`);
  };
  harness.server.stopAutoLoopForContext = (nextContext: ContextRef, ws: object) => {
    harness.lifecycle.push(`stopAutoLoopForContext:${nextContext.scope}:${nextContext.namespace}`);
    harness.server.emitToClient(ws, {
      type: 'auto_loop_stopped',
      data: {
        context: nextContext,
        reason: 'User stopped auto loop',
        totalRounds: 6,
      },
    });
  };

  harness.server.handleCancelMessage(harness.openSocket, {
    runId: 'run-1',
    context,
  });

  assert.deepEqual(harness.lifecycle, [
    'agent.cancelContext:session:sess-shared',
    'rejectByContext:session:sess-shared:run_canceled',
    'stopAutoLoopForContext:session:sess-shared',
    'emit:auto_loop_stopped',
    'emit:cancel_ack',
    'refresh',
  ]);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'auto_loop_stopped',
      data: {
        context,
        reason: 'User stopped auto loop',
        totalRounds: 6,
      },
    },
    {
      ws: harness.openSocket,
      type: 'cancel_ack',
      data: {
        runId: 'run-1',
        context,
        canceledCount: 6,
      },
    },
  ]);
}

async function testHandleCancelMessageScopedWithoutControllerStillEmitsOnlyCancelAck(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-noloop' };
  const harness = createHarness();
  const originalGet = autoLoopManager.get;

  try {
    harness.server.agent = {
      cancelContext: (nextContext: ContextRef) => {
        harness.lifecycle.push(`agent.cancelContext:${nextContext.scope}:${nextContext.namespace}`);
        return 4;
      },
    };
    harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
      harness.lifecycle.push(`rejectByContext:${nextContext.scope}:${nextContext.namespace}:${reason}`);
    };
    (autoLoopManager as any).get = (key: string) => {
      harness.lifecycle.push(`autoLoopManager.get:${key}`);
      return undefined;
    };

    harness.server.handleCancelMessage(harness.openSocket, {
      sessionId: 'sess-noloop',
    });

    assert.deepEqual(harness.lifecycle, [
      'agent.cancelContext:session:sess-noloop',
      'rejectByContext:session:sess-noloop:run_canceled',
      'autoLoopManager.get:sess-noloop',
      'emit:cancel_ack',
      'refresh',
    ]);
    assert.deepEqual(harness.emitted, [
      {
        ws: harness.openSocket,
        type: 'cancel_ack',
        data: {
          runId: null,
          context,
          canceledCount: 4,
        },
      },
    ]);
  } finally {
    (autoLoopManager as any).get = originalGet;
  }
}

async function testHandleWSMessageCancelRunsFullAllChainWithoutResolvedContext(): Promise<void> {
  const harness = createHarness();

  harness.server.agent = {
    cancel: () => {
      harness.lifecycle.push('agent.cancel');
    },
  };
  harness.server.rejectPendingPlanInputByRunId = (runId: string, reason: string) => {
    harness.lifecycle.push(`rejectByRunId:${runId}:${reason}`);
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'cancel',
    data: {
      runId: ' run-orphan ',
    },
  });

  assert.deepEqual(harness.lifecycle, [
    'rejectByRunId:run-orphan:run_canceled',
    'agent.cancel',
    'emit:cancel_ack',
    'refresh',
  ]);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'cancel_ack',
      data: {
        runId: ' run-orphan ',
        canceled: 'all',
      },
    },
  ]);
}

async function testHandleWSMessageCancelRunsFullScopedChainFromRunId(): Promise<void> {
  const context: ContextRef = { scope: 'workspace', namespace: 'repo-a' };
  const harness = createHarness([['run-1', context]]);

  harness.server.agent = {
    cancelContext: (nextContext: ContextRef) => {
      harness.lifecycle.push(`agent.cancelContext:${nextContext.scope}:${nextContext.namespace}`);
      return 1;
    },
  };
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${nextContext.scope}:${nextContext.namespace}:${reason}`);
  };
  harness.server.stopAutoLoopForContext = (nextContext: ContextRef, ws: object) => {
    harness.lifecycle.push(`stopAutoLoopForContext:${nextContext.scope}:${nextContext.namespace}`);
    harness.server.emitToClient(ws, {
      type: 'auto_loop_stopped',
      data: {
        context: nextContext,
        reason: 'User stopped auto loop',
        totalRounds: 2,
      },
    });
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'cancel',
    data: {
      runId: 'run-1',
    },
  });

  assert.deepEqual(harness.lifecycle, [
    'agent.cancelContext:workspace:repo-a',
    'rejectByContext:workspace:repo-a:run_canceled',
    'stopAutoLoopForContext:workspace:repo-a',
    'emit:auto_loop_stopped',
    'emit:cancel_ack',
    'refresh',
  ]);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'auto_loop_stopped',
      data: {
        context,
        reason: 'User stopped auto loop',
        totalRounds: 2,
      },
    },
    {
      ws: harness.openSocket,
      type: 'cancel_ack',
      data: {
        runId: 'run-1',
        context,
        canceledCount: 1,
      },
    },
  ]);
}

async function runAll(): Promise<void> {
  await testHandleWSMessageCancelDelegatesToDedicatedHelper();
  await testHandleCancelMessageCancelsAllWhenNoContextResolves();
  await testHandleCancelMessageCancelsScopedSessionAndStopsAutoLoopBeforeAck();
  await testHandleCancelMessagePrefersExplicitContextOverRunIdLookup();
  await testHandleCancelMessageTreatsMalformedExplicitContextAsAuthoritativeNoOp();
  await testHandleCancelMessageKeepsRunIdWhenExplicitContextMatchesRunTarget();
  await testHandleCancelMessageScopedWithoutControllerStillEmitsOnlyCancelAck();
  await testHandleWSMessageCancelRunsFullAllChainWithoutResolvedContext();
  await testHandleWSMessageCancelRunsFullScopedChainFromRunId();
  console.log('web-cancel-message tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
