import * as assert from 'node:assert/strict';
import { autoLoopManager } from '../../src/auto-loop/index.js';
import type { ContextRef } from '../../src/types.js';
import {
  attachEmitCapture,
  createOpenSocket,
  createWebServerDouble,
  type CapturedWebMessage,
} from './helpers/web-server-harness.js';

interface CancelHarness {
  server: any;
  openSocket: { readyState: number; socket: string };
  emitted: CapturedWebMessage[];
  lifecycle: string[];
}

function makeCancelSummary(mainRunCount: number, subagentCount = 0): {
  mainRunCount: number;
  subagentCount: number;
  totalCount: number;
} {
  return {
    mainRunCount,
    subagentCount,
    totalCount: mainRunCount + subagentCount,
  };
}

function contextLabel(context: ContextRef): string {
  return `${context.scope}:${context.namespace}`;
}

function stubAutoLoopStopped(
  harness: CancelHarness,
  methodName: 'stopAutoLoopForContext' | 'pausePlanExecutionAutoLoopForContext',
  totalRounds: number,
  reason = 'User stopped auto loop'
): void {
  harness.server[methodName] = (nextContext: ContextRef, ws: object) => {
    harness.lifecycle.push(`${methodName}:${contextLabel(nextContext)}`);
    harness.server.emitToClient(ws, {
      type: 'auto_loop_stopped',
      data: {
        context: nextContext,
        reason,
        totalRounds,
      },
    });
  };
}

function createHarness(
  activeEntries?: ReadonlyArray<readonly [string, ContextRef]>
): CancelHarness {
  const server = createWebServerDouble();
  const lifecycle: string[] = [];
  const { emitted } = attachEmitCapture(server, { lifecycle });

  server.activeRunContexts = new Map(activeEntries ?? []);
  server.activeRunStatesByContext = new Map(
    (activeEntries ?? []).map(([runId, context]) => [
      contextLabel(context),
      {
        runId,
        context,
        startedAt: '2026-05-03T00:00:00.000Z',
        owner: 'web',
        origin: 'web',
        interactionState: { mode: 'normal', owner: 'web' },
      },
    ])
  );
  server.refreshGlobalAgentCatalog = () => {
    lifecycle.push('refresh');
  };

  return {
    server,
    openSocket: createOpenSocket('open'),
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
      harness.lifecycle.push(`agent.cancelContext:${contextLabel(nextContext)}`);
      return 2;
    },
  };
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${contextLabel(nextContext)}:${reason}`);
  };
  stubAutoLoopStopped(harness, 'stopAutoLoopForContext', 4);

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
        cancelSummary: makeCancelSummary(2),
      },
    },
  ]);
}

async function testHandleCancelMessageRejectsCliOwnedRunAsObserveOnly(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-cli' };
  const harness = createHarness([['run-cli', context]]);
  harness.server.activeRunStatesByContext.set(contextLabel(context), {
    runId: 'run-cli',
    context,
    startedAt: '2026-05-03T00:00:00.000Z',
    owner: 'cli',
    origin: 'cli',
    interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
  });
  harness.server.agent = {
    cancelContext: () => {
      throw new Error('CLI-owned run must not be canceled from Web');
    },
  };

  harness.server.handleCancelMessage(harness.openSocket, {
    runId: 'run-cli',
    context,
  });

  assert.deepEqual(harness.lifecycle, ['emit:cancel_ack']);
  assert.equal(harness.emitted[0]?.type, 'cancel_ack');
  const payload = harness.emitted[0]?.data as Record<string, unknown>;
  assert.equal(payload.error, 'observe_only');
  assert.deepEqual(payload.interactionState, { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' });
  assert.equal((payload.activeRun as Record<string, unknown>).owner, 'cli');
}

async function testHandleCancelMessagePausesPlanExecutionWithoutDisablingTodoLoop(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-plan-exec' };
  const harness = createHarness([['run-plan', context]]);

  harness.server.agent = {
    cancelContext: (nextContext: ContextRef) => {
      harness.lifecycle.push(`agent.cancelContext:${contextLabel(nextContext)}`);
      return 1;
    },
  };
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
    items: [{ id: 'todo-1', status: 'in_progress' }],
    unfinishedItems: [{ id: 'todo-1', status: 'in_progress' }],
    activeItem: { id: 'todo-1', status: 'in_progress' },
    blockedItem: null,
    pendingItems: [],
    completedItems: [],
    hasUnfinished: true,
    allCompleted: false,
  });
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${contextLabel(nextContext)}:${reason}`);
  };
  stubAutoLoopStopped(harness, 'pausePlanExecutionAutoLoopForContext', 2, 'Plan execution paused for user input');
  harness.server.stopAutoLoopForContext = () => {
    throw new Error('plan execution cancel must not persist pausedByUser through stopAutoLoopForContext');
  };

  harness.server.handleCancelMessage(harness.openSocket, {
    runId: 'run-plan',
    context,
  });

  assert.deepEqual(harness.lifecycle, [
    'agent.cancelContext:session:sess-plan-exec',
    'rejectByContext:session:sess-plan-exec:run_canceled',
    'pausePlanExecutionAutoLoopForContext:session:sess-plan-exec',
    'emit:auto_loop_stopped',
    'emit:cancel_ack',
    'refresh',
  ]);
  assert.equal((harness.emitted[0]?.data as { reason?: string }).reason, 'Plan execution paused for user input');
  assert.deepEqual(harness.emitted[1], {
    ws: harness.openSocket,
    type: 'cancel_ack',
    data: {
      runId: 'run-plan',
      context,
      canceledCount: 1,
      cancelSummary: makeCancelSummary(1),
    },
  });
}

async function testHandleCancelMessagePrefersExplicitContextOverRunIdLookup(): Promise<void> {
  const explicitContext: ContextRef = { scope: 'session', namespace: 'sess-explicit' };
  const runContext: ContextRef = { scope: 'workspace', namespace: 'repo-a' };
  const harness = createHarness([['run-1', runContext]]);

  harness.server.agent = {
    cancelContext: (nextContext: ContextRef) => {
      harness.lifecycle.push(`agent.cancelContext:${contextLabel(nextContext)}`);
      return 3;
    },
  };
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${contextLabel(nextContext)}:${reason}`);
  };
  stubAutoLoopStopped(harness, 'stopAutoLoopForContext', 5);

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
        cancelSummary: makeCancelSummary(3),
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
      harness.lifecycle.push(`agent.cancelContext:${contextLabel(nextContext)}`);
      return 1;
    },
  };
  harness.server.rejectPendingPlanInputByRunId = (runId: string, reason: string) => {
    harness.lifecycle.push(`rejectByRunId:${runId}:${reason}`);
  };
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${contextLabel(nextContext)}:${reason}`);
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
    cancelContextWithSummary: (nextContext: ContextRef) => {
      harness.lifecycle.push(`agent.cancelContextWithSummary:${contextLabel(nextContext)}`);
      return makeCancelSummary(6, 2);
    },
  };
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${contextLabel(nextContext)}:${reason}`);
  };
  stubAutoLoopStopped(harness, 'stopAutoLoopForContext', 6);

  harness.server.handleCancelMessage(harness.openSocket, {
    runId: 'run-1',
    context,
  });

  assert.deepEqual(harness.lifecycle, [
    'agent.cancelContextWithSummary:session:sess-shared',
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
        cancelSummary: makeCancelSummary(6, 2),
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
        harness.lifecycle.push(`agent.cancelContext:${contextLabel(nextContext)}`);
        return 4;
      },
    };
    harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
      harness.lifecycle.push(`rejectByContext:${contextLabel(nextContext)}:${reason}`);
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
          cancelSummary: makeCancelSummary(4),
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
      harness.lifecycle.push(`agent.cancelContext:${contextLabel(nextContext)}`);
      return 1;
    },
  };
  harness.server.rejectPendingPlanInputByContext = (nextContext: ContextRef, reason: string) => {
    harness.lifecycle.push(`rejectByContext:${contextLabel(nextContext)}:${reason}`);
  };
  stubAutoLoopStopped(harness, 'stopAutoLoopForContext', 2);

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
        cancelSummary: makeCancelSummary(1),
      },
    },
  ]);
}

async function runAll(): Promise<void> {
  await testHandleWSMessageCancelDelegatesToDedicatedHelper();
  await testHandleCancelMessageCancelsAllWhenNoContextResolves();
  await testHandleCancelMessageCancelsScopedSessionAndStopsAutoLoopBeforeAck();
  await testHandleCancelMessageRejectsCliOwnedRunAsObserveOnly();
  await testHandleCancelMessagePausesPlanExecutionWithoutDisablingTodoLoop();
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
