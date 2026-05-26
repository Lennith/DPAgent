import * as assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { autoLoopManager } from '../../src/auto-loop/index.js';
import type { ContextRef } from '../../src/types.js';
import { createWebServerDouble } from './helpers/web-server-harness.js';

interface EmittedMessage {
  ws: object;
  type: string;
  data: unknown;
}

interface StopAutoLoopHarness {
  server: any;
  openSocket: { readyState: number; socket: string };
  emitted: EmittedMessage[];
  lifecycle: string[];
  setController(getImpl: (key: string) => unknown): void;
  restore(): void;
}

function createHarness(): StopAutoLoopHarness {
  const server = createWebServerDouble();
  const emitted: EmittedMessage[] = [];
  const lifecycle: string[] = [];
  const originalGet = autoLoopManager.get;

  server.activeRunStatesByContext = new Map();
  server.emitToClient = (ws: object, message: Omit<EmittedMessage, 'ws'>) => {
    lifecycle.push(`emit:${message.type}`);
    emitted.push({ ws, ...message });
  };

  return {
    server,
    openSocket: { readyState: WebSocket.OPEN, socket: 'open' },
    emitted,
    lifecycle,
    setController(getImpl: (key: string) => unknown) {
      (autoLoopManager as any).get = getImpl;
    },
    restore() {
      (autoLoopManager as any).get = originalGet;
    },
  };
}

async function testHandleWSMessageStopAutoLoopDelegatesToDedicatedHelper(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  try {
    harness.server.handleStopAutoLoopMessage = (ws: unknown, request: unknown) => {
      harness.lifecycle.push('handleStopAutoLoopMessage');
      captured = [ws, request];
    };

    await harness.server.handleWSMessage(harness.openSocket, {
      type: 'stop_auto_loop',
      data: {
        sessionId: 'sess-1',
      },
    });

    assert.deepEqual(harness.lifecycle, ['handleStopAutoLoopMessage']);
    assert.deepEqual(captured, [
      harness.openSocket,
      {
        sessionId: 'sess-1',
      },
    ]);
  } finally {
    harness.restore();
  }
}

function testResolveStopAutoLoopContextPrefersExplicitContextOverSessionId(): void {
  const harness = createHarness();

  try {
    const explicitContext: ContextRef = { scope: 'workspace', namespace: 'repo-a' };
    const resolved = harness.server.resolveStopAutoLoopContext({
      context: explicitContext,
      sessionId: 'sess-1',
    });

    assert.deepEqual(resolved, explicitContext);
  } finally {
    harness.restore();
  }
}

function testResolveStopAutoLoopContextFallsBackToTrimmedSessionIdOrNull(): void {
  const harness = createHarness();

  try {
    assert.deepEqual(harness.server.resolveStopAutoLoopContext({ sessionId: ' sess-1 ' }), {
      scope: 'session',
      namespace: 'sess-1',
    });
    assert.equal(harness.server.resolveStopAutoLoopContext({ sessionId: '   ' }), null);
    assert.equal(harness.server.resolveStopAutoLoopContext({}), null);
  } finally {
    harness.restore();
  }
}

function testResolveStopAutoLoopContextTreatsMalformedExplicitContextAsAuthoritativeNoOp(): void {
  const harness = createHarness();

  try {
    assert.equal(
      harness.server.resolveStopAutoLoopContext({
        context: { scope: 'session', namespace: '   ' },
        sessionId: 'sess-fallback',
      }),
      null
    );
  } finally {
    harness.restore();
  }
}

function testStopAutoLoopForContextWithoutControllerIsANoOp(): void {
  const harness = createHarness();

  try {
    let requestedKey = '';
    harness.setController((key: string) => {
      requestedKey = key;
      return undefined;
    });

    harness.server.stopAutoLoopForContext({ scope: 'session', namespace: 'sess-1' }, harness.openSocket);

    assert.equal(requestedKey, 'sess-1');
    assert.deepEqual(harness.lifecycle, []);
    assert.deepEqual(harness.emitted, []);
  } finally {
    harness.restore();
  }
}

function testStopAutoLoopForContextStopsControllerAndEmitsPayload(): void {
  const harness = createHarness();
  const context: ContextRef = { scope: 'workspace', namespace: 'repo-a' };

  try {
    let requestedKey = '';
    harness.setController((key: string) => {
      requestedKey = key;
      return {
        stop: (reason: string) => {
          harness.lifecycle.push(`stop:${reason}`);
        },
        getState: () => ({
          currentRound: 7,
        }),
      };
    });

    harness.server.stopAutoLoopForContext(context, harness.openSocket);

    assert.equal(requestedKey, 'workspace:repo-a');
    assert.deepEqual(harness.lifecycle, ['stop:user_stop', 'emit:auto_loop_stopped']);
    assert.deepEqual(harness.emitted, [
      {
        ws: harness.openSocket,
        type: 'auto_loop_stopped',
        data: {
          context,
          reason: 'User stopped auto loop',
          totalRounds: 7,
        },
      },
    ]);
  } finally {
    harness.restore();
  }
}

function testStopAutoLoopForContextPausesPlanExecutionWithoutPersistingUserPause(): void {
  const harness = createHarness();
  const context: ContextRef = { scope: 'session', namespace: 'sess-plan-exec' };
  const metaUpdates: unknown[] = [];

  try {
    let requestedKey = '';
    harness.server.getContextNamespaceMetaSafe = () => ({
      planningState: {
        state: 'plan_executing',
        activeExecutionPlanId: 'plan-1',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
      autoLoopConfig: {
        enabled: true,
        mode: 'todo',
        ralphEnabled: false,
        pendingPlanConfirmation: false,
        pausedByUser: false,
      },
    });
    harness.server.getSessionTodoProtocolState = () => ({
      items: [{ id: 'todo-1', status: 'pending' }],
      unfinishedItems: [{ id: 'todo-1', status: 'pending' }],
      activeItem: null,
      blockedItem: null,
      pendingItems: [{ id: 'todo-1', status: 'pending' }],
      completedItems: [],
      hasUnfinished: true,
      allCompleted: false,
    });
    harness.server.updateContextNamespaceMetaSafe = (_context: ContextRef, patch: unknown) => {
      metaUpdates.push(patch);
    };
    harness.setController((key: string) => {
      requestedKey = key;
      return {
        stop: (reason: string) => {
          harness.lifecycle.push(`stop:${reason}`);
        },
        getState: () => ({
          currentRound: 5,
        }),
      };
    });

    harness.server.stopAutoLoopForContext(context, harness.openSocket);

    assert.equal(requestedKey, 'sess-plan-exec');
    assert.deepEqual(metaUpdates, []);
    assert.deepEqual(harness.lifecycle, ['stop:user_stop', 'emit:auto_loop_stopped']);
    assert.deepEqual(harness.emitted, [
      {
        ws: harness.openSocket,
        type: 'auto_loop_stopped',
        data: {
          context,
          reason: 'Plan execution paused for user input',
          totalRounds: 5,
        },
      },
    ]);
  } finally {
    harness.restore();
  }
}

function testHandleStopAutoLoopMessageRunsFullChainFromSessionId(): void {
  const harness = createHarness();
  const context: ContextRef = { scope: 'session', namespace: 'sess-2' };

  try {
    let requestedKey = '';
    harness.setController((key: string) => {
      requestedKey = key;
      return {
        stop: (reason: string) => {
          harness.lifecycle.push(`stop:${reason}`);
        },
        getState: () => ({
          currentRound: 3,
        }),
      };
    });

    harness.server.handleStopAutoLoopMessage(harness.openSocket, {
      sessionId: ' sess-2 ',
    });

    assert.equal(requestedKey, 'sess-2');
    assert.deepEqual(harness.lifecycle, ['stop:user_stop', 'emit:auto_loop_stopped']);
    assert.deepEqual(harness.emitted, [
      {
        ws: harness.openSocket,
        type: 'auto_loop_stopped',
        data: {
          context,
          reason: 'User stopped auto loop',
          totalRounds: 3,
        },
      },
    ]);
  } finally {
    harness.restore();
  }
}

function testHandleStopAutoLoopMessageIgnoresBlankRequest(): void {
  const harness = createHarness();

  try {
    let controllerLookups = 0;
    harness.setController(() => {
      controllerLookups += 1;
      return undefined;
    });

    harness.server.handleStopAutoLoopMessage(harness.openSocket, {});

    assert.equal(controllerLookups, 0);
    assert.deepEqual(harness.lifecycle, []);
    assert.deepEqual(harness.emitted, []);
  } finally {
    harness.restore();
  }
}

async function runAll(): Promise<void> {
  await testHandleWSMessageStopAutoLoopDelegatesToDedicatedHelper();
  testResolveStopAutoLoopContextPrefersExplicitContextOverSessionId();
  testResolveStopAutoLoopContextFallsBackToTrimmedSessionIdOrNull();
  testResolveStopAutoLoopContextTreatsMalformedExplicitContextAsAuthoritativeNoOp();
  testStopAutoLoopForContextWithoutControllerIsANoOp();
  testStopAutoLoopForContextStopsControllerAndEmitsPayload();
  testStopAutoLoopForContextPausesPlanExecutionWithoutPersistingUserPause();
  testHandleStopAutoLoopMessageRunsFullChainFromSessionId();
  testHandleStopAutoLoopMessageIgnoresBlankRequest();
  console.log('web-stop-auto-loop-message tests passed');
}

void runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
