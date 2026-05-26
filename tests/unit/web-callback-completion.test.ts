import * as assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { autoLoopManager } from '../../src/auto-loop/index.js';
import type { ContextRef } from '../../src/types.js';
import { createWebServerDouble } from './helpers/web-server-harness.js';
import { createWebServerTestConfig } from './web-server-test-config.js';

interface EmittedMessage {
  ws: object;
  type: string;
  data: unknown;
}

function stripCreatedAt(message: EmittedMessage): EmittedMessage {
  if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)) {
    return message;
  }
  const data = { ...(message.data as Record<string, unknown>) };
  delete data.createdAt;
  return {
    ...message,
    data,
  };
}

const DONE_MARKER = '\u3010\u5b8c\u6210\uff01\u3011';
const REPORT_END_MARKER = '\u3010\u6c47\u62a5\u7ed3\u675f\uff01\u3011';

interface CompletionHarness {
  server: any;
  context: ContextRef;
  openSocket: { readyState: number; socket: string };
  closedSocket: { readyState: number; socket: string };
  emitted: EmittedMessage[];
  lifecycle: string[];
  metaState: Record<string, unknown>;
  setControllerFactory: (factory: (key: string) => unknown) => void;
  restore: () => void;
}

class TrackingRunContextMap extends Map<string, ContextRef> {
  constructor(private readonly lifecycle: string[]) {
    super();
  }

  override set(key: string, value: ContextRef): this {
    this.lifecycle.push(`active:set:${key}`);
    return super.set(key, value);
  }

  override delete(key: string): boolean {
    this.lifecycle.push(`active:delete:${key}`);
    return super.delete(key);
  }
}

function createHarness(context: ContextRef = { scope: 'session', namespace: 'sess-1' }): CompletionHarness {
  const server = createWebServerDouble();
  const emitted: EmittedMessage[] = [];
  const lifecycle: string[] = [];
  const metaState: Record<string, unknown> = {
    scope: context.scope,
    namespace: context.namespace,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const originalGetOrCreate = autoLoopManager.getOrCreate;

  server.agent = {
    getConfig: () => createWebServerTestConfig({
      agent: {
        tokenLimit: 1000,
        completionMarkerEnforcementEnabled: true,
      },
    }),
  };
  server.getContextNamespaceMetaSafe = () => metaState;
  server.updateContextNamespaceMetaSafe = (_context: ContextRef, patch: Record<string, unknown>) => {
    Object.assign(metaState, patch);
  };
  server.activeRunContexts = new TrackingRunContextMap(lifecycle);
  server.activeRunStatesByContext = new Map();
  server.cancelingRunIds = new Set();
  server.sessionRuntimes = new Map();
  server.wss = { clients: [] };
  server.resolveWorkspaceDirForContext = () => 'D:\\workspace';
  server.cleanupDirtySessionRuntimeIfIdle = async () => undefined;
  server.ensureSessionRuntime = async (sessionId: string, workspaceDir: string) => {
    server.sessionRuntimes.set(sessionId, {
      agent: server.agent,
      workspaceDir,
      runtimeKey: `runtime:${sessionId}:${workspaceDir}`,
      llmRuntime: {
        profileId: 'default',
        provider: 'anthropic',
        apiKey: 'sk-test',
        apiBase: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M2.5',
        maxOutputTokens: 4096,
        reasoningPreset: 'off',
        capabilities: {
          reasoningEffort: false,
          thinkingBudget: true,
        },
      },
      lastUsedAt: '2026-01-01T00:00:00.000Z',
    });
    return { agent: server.agent, reused: false };
  };
  server.rejectPendingPlanInputByRunId = (runId: string, reason: string) => {
    lifecycle.push(`reject:${runId}:${reason}`);
  };
  server.refreshGlobalAgentCatalog = () => {
    lifecycle.push('refresh');
  };
  server.emitToClient = (ws: object, message: Omit<EmittedMessage, 'ws'>) => {
    lifecycle.push(`emit:${message.type}`);
    emitted.push({ ws, ...message });
  };

  return {
    server,
    context,
    openSocket: { readyState: WebSocket.OPEN, socket: 'open' },
    closedSocket: { readyState: WebSocket.CLOSED, socket: 'closed' },
    emitted,
    lifecycle,
    metaState,
    setControllerFactory: (factory: (key: string) => unknown) => {
      (autoLoopManager as any).getOrCreate = factory;
    },
    restore: () => {
      (autoLoopManager as any).getOrCreate = originalGetOrCreate;
    },
  };
}

async function testOnCompleteClosedWorkspaceSocketKeepsAutoLoopContinuation(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-closed' });
  let captured: unknown[] | null = null;
  try {
    let requestedKey = '';
    harness.setControllerFactory((key: string) => {
      requestedKey = key;
      return {
        getConfig: () => ({
          enabled: true,
          pausedByUser: false,
        }),
        getState: () => ({
          isRunning: true,
          currentRound: 3,
        }),
        stop: (reason: string) => {
          harness.lifecycle.push(`stop:${reason}`);
        },
        shouldContinue: (result: string) => {
          assert.equal(result, 'done');
          return { shouldContinue: true };
        },
      };
    });
    harness.server.scheduleCallbackContinuation = (
      ws: unknown,
      context: unknown,
      controllerArg: unknown,
      nextPrompt: unknown
    ) => {
      captured = [ws, context, controllerArg, nextPrompt];
    };

    const callback = harness.server.createCallback(harness.closedSocket, harness.context, 'run-1');
    await callback.onComplete('done');

    assert.equal(requestedKey, 'workspace:repo-closed');
    assert.deepEqual(harness.lifecycle, [
      'reject:run-1:run_completed',
      'refresh',
      'emit:complete',
      'emit:auto_loop_round',
    ]);
    assert.equal(captured?.[0], harness.closedSocket);
    assert.equal(captured?.[1], harness.context);
    assert.match(String(captured?.[3] ?? ''), /\[AUTO_LOOP_CONTINUE\]/);
  } finally {
    harness.restore();
  }
}

async function testOnCompleteClosedSessionSocketKeepsTodoContinuation(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;
  try {
    harness.server.getSessionTodoProtocolState = () => ({
      items: [{ id: 'todo-1', work: 'Continue release task', detectionStandard: 'Task completes.' }],
      unfinishedItems: [
        { id: 'todo-1', work: 'Continue release task', detectionStandard: 'Task completes.' },
      ],
      activeItem: {
        id: 'todo-1',
        work: 'Continue release task',
        detectionStandard: 'Task completes.',
        status: 'in_progress',
      },
      blockedItem: null,
      pendingItems: [],
      completedItems: [],
      hasUnfinished: true,
      allCompleted: false,
    });
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: true,
        pausedByUser: false,
      }),
      getState: () => ({
        isRunning: true,
        currentRound: 4,
      }),
      shouldContinue: (result: string, options?: { ignoreSimilarity?: boolean }) => {
        assert.equal(result, `done${DONE_MARKER}`);
        assert.equal(options?.ignoreSimilarity, true);
        return { shouldContinue: true };
      },
      stop: (reason: string) => {
        harness.lifecycle.push(`stop:${reason}`);
      },
    }));
    harness.server.scheduleCallbackContinuation = (
      ws: unknown,
      context: unknown,
      controllerArg: unknown,
      nextPrompt: unknown
    ) => {
      captured = [ws, context, controllerArg, nextPrompt];
    };

    const callback = harness.server.createCallback(harness.closedSocket, harness.context, 'run-closed-session');
    await callback.onComplete(`done${DONE_MARKER}`);

    assert.deepEqual(harness.lifecycle, [
      'reject:run-closed-session:run_completed',
      'refresh',
      'emit:complete',
      'emit:auto_loop_round',
    ]);
    assert.equal(captured?.[0], harness.closedSocket);
    assert.equal(captured?.[1], harness.context);
    assert.match(String(captured?.[3] ?? ''), /\[TODO_LOOP\]/);
  } finally {
    harness.restore();
  }
}

async function testOnCompleteCancelledSuppressesCompletionAndContinuation(): Promise<void> {
  const harness = createHarness();
  try {
    let shouldContinueCalled = false;
    harness.setControllerFactory(() => ({
      shouldContinue: () => {
        shouldContinueCalled = true;
        return { shouldContinue: true };
      },
    }));

    const callback = harness.server.createCallback(harness.openSocket, harness.context, 'run-cancelled');
    await callback.onComplete('Task cancelled by user.', 'cancelled', { step: 4, finishReason: 'cancelled' });

    assert.deepEqual(harness.lifecycle, ['reject:run-cancelled:run_canceled', 'refresh']);
    assert.equal(harness.emitted.length, 0);
    assert.equal(shouldContinueCalled, false);
  } finally {
    harness.restore();
  }
}

async function testOnCompleteWithoutMarkerSchedulesMarkerContinuationWithoutCompletion(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;
  try {
    harness.setControllerFactory(() => ({}));
    harness.server.scheduleCallbackContinuation = (
      ws: unknown,
      context: unknown,
      controllerArg: unknown,
      nextPrompt: unknown
    ) => {
      captured = [ws, context, controllerArg, nextPrompt];
    };

    const callback = harness.server.createCallback(harness.openSocket, harness.context, 'run-1');
    await callback.onComplete('done');

    assert.deepEqual(harness.lifecycle, ['reject:run-1:run_completed', 'refresh']);
    assert.equal(harness.emitted.length, 0);
    assert.deepEqual(harness.metaState.completionMarkerStats, {
      repairCount: 1,
      lastTriggeredAt: (harness.metaState.completionMarkerStats as { lastTriggeredAt: string }).lastTriggeredAt,
      lastIssue: 'missing_tail_marker',
    });
    assert.deepEqual(captured?.slice(0, 2), [harness.openSocket, harness.context]);
    assert.match(String(captured?.[3] ?? ''), /\[COMPLETION_MARKER_REQUIRED\]/);
    assert.match(String(captured?.[3] ?? ''), new RegExp(DONE_MARKER));
    assert.match(String(captured?.[3] ?? ''), new RegExp(REPORT_END_MARKER));
  } finally {
    harness.restore();
  }
}

async function testOnCompleteWithoutMarkerUsesRepairOnlyPromptForBlockedTodo(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;
  try {
    harness.server.getSessionTodoProtocolState = () => ({
      items: [
        { id: 'todo-1', work: 'Wait for user credentials', detectionStandard: 'Credentials are present.' },
        { id: 'todo-2', work: 'Resume integration', detectionStandard: 'Integration succeeds.' },
      ],
      unfinishedItems: [
        { id: 'todo-1', work: 'Wait for user credentials', detectionStandard: 'Credentials are present.' },
        { id: 'todo-2', work: 'Resume integration', detectionStandard: 'Integration succeeds.' },
      ],
      activeItem: {
        id: 'todo-1',
        work: 'Wait for user credentials',
        detectionStandard: 'Credentials are present.',
        status: 'blocked',
      },
      blockedItem: {
        id: 'todo-1',
        work: 'Wait for user credentials',
        detectionStandard: 'Credentials are present.',
        blockedReason: 'Waiting for the user to provide credentials.',
        status: 'blocked',
      },
      pendingItems: [
        {
          id: 'todo-2',
          work: 'Resume integration',
          detectionStandard: 'Integration succeeds.',
          status: 'pending',
        },
      ],
      completedItems: [],
      hasUnfinished: true,
      allCompleted: false,
    });
    harness.setControllerFactory(() => ({}));
    harness.server.scheduleCallbackContinuation = (
      ws: unknown,
      context: unknown,
      controllerArg: unknown,
      nextPrompt: unknown
    ) => {
      captured = [ws, context, controllerArg, nextPrompt];
    };

    const callback = harness.server.createCallback(harness.openSocket, harness.context, 'run-1');
    await callback.onComplete('blocked without marker');

    assert.deepEqual(harness.lifecycle, ['reject:run-1:run_completed', 'refresh']);
    assert.equal(harness.emitted.length, 0);
    const nextPrompt = String(captured?.[3] ?? '');
    assert.match(nextPrompt, /repair turn is only for the missing final report/i);
    assert.match(nextPrompt, /resend that blocker report with one exact completion marker/i);
    assert.doesNotMatch(nextPrompt, /promote the next pending todo before stopping/i);
    assert.doesNotMatch(nextPrompt, /rewrite it with todo action=plan_set/i);
  } finally {
    harness.restore();
  }
}

async function testResolveSessionContinuationPlanRequiresMarkerBeforeTodoCompletionStop(): Promise<void> {
  const harness = createHarness();
  try {
    harness.server.getSessionTodoProtocolState = () => ({
      items: [{ id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' }],
      unfinishedItems: [],
      activeItem: null,
      blockedItem: null,
      pendingItems: [],
      completedItems: [{ id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' }],
      hasUnfinished: false,
      allCompleted: true,
    });
    harness.setControllerFactory(() => ({
      getConfig: () => ({ enabled: false }),
      getState: () => ({ currentRound: 0, isRunning: false }),
    }));

    const plan = harness.server.resolveCallbackContinuationPlan(
      harness.openSocket,
      harness.context,
      'sess-1',
      undefined,
      'done'
    );

    assert.equal(plan.kind, 'continue_marker_required');
    assert.equal(plan.emitComplete, false);
    assert.match(String((plan as { nextPrompt: string }).nextPrompt ?? ''), /All current session todos are already complete/i);
  } finally {
    harness.restore();
  }
}

async function testOnCompleteSchedulesNextQualifiedRoundWhenMarkerExists(): Promise<void> {
  const harness = createHarness();
  const originalSetTimeout = globalThis.setTimeout;
  let scheduledDelay: number | null = null;
  try {
    (globalThis as any).setTimeout = (_fn: unknown, delay?: number) => {
      scheduledDelay = delay ?? null;
      return 0;
    };
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: true,
      }),
      getState: () => ({
        isRunning: true,
        currentRound: 5,
      }),
      shouldContinue: (result: string) => {
        assert.equal(result, 'done' + DONE_MARKER);
        return { shouldContinue: true };
      },
    }));
    harness.metaState.completionMarkerStats = {
      repairCount: 2,
      lastTriggeredAt: '2026-01-01T00:00:00.000Z',
      lastIssue: 'missing_tail_marker',
    };

    const callback = harness.server.createCallback(harness.openSocket, harness.context, 'run-1');
    await callback.onComplete('done' + DONE_MARKER);

    assert.equal(scheduledDelay, 500);
    assert.deepEqual(harness.lifecycle, [
      'reject:run-1:run_completed',
      'refresh',
      'emit:complete',
      'emit:auto_loop_round',
    ]);
    assert.equal(typeof (harness.emitted[0]?.data as { createdAt?: string }).createdAt, 'string');
    assert.deepEqual(stripCreatedAt(harness.emitted[0]), {
      ws: harness.openSocket,
      type: 'complete',
      data: {
        runId: 'run-1',
        context: harness.context,
        content: 'done' + DONE_MARKER,
        completionMarkerStats: harness.metaState.completionMarkerStats,
        sessionId: 'sess-1',
      },
    });
    assert.deepEqual(harness.emitted[1], {
      ws: harness.openSocket,
      type: 'auto_loop_round',
      data: {
        runId: 'run-1',
        context: harness.context,
        round: 5,
        prompt: (harness.emitted[1]?.data as { prompt: string }).prompt,
      },
    });
    assert.deepEqual(harness.metaState.completionMarkerStats, {
      repairCount: 2,
      lastTriggeredAt: '2026-01-01T00:00:00.000Z',
      lastResolvedAt: (harness.metaState.completionMarkerStats as { lastResolvedAt: string }).lastResolvedAt,
      lastIssue: 'missing_tail_marker',
    });
    assert.match(String((harness.emitted[1]?.data as { prompt: string }).prompt ?? ''), /\[AUTO_LOOP_CONTINUE\]/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    harness.restore();
  }
}

async function testResolveSessionContinuationPlanAllowsOuterLoopAfterTodoCompletion(): Promise<void> {
  const harness = createHarness();
  try {
    harness.server.getSessionTodoProtocolState = () => ({
      items: [{ id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' }],
      unfinishedItems: [],
      activeItem: null,
      blockedItem: null,
      pendingItems: [],
      completedItems: [{ id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' }],
      hasUnfinished: false,
      allCompleted: true,
    });
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: true,
        pausedByUser: false,
      }),
      getState: () => ({
        isRunning: true,
        currentRound: 2,
      }),
      shouldContinue: (result: string) => {
        assert.equal(result, `done${DONE_MARKER}`);
        return { shouldContinue: true };
      },
    }));

    const plan = harness.server.resolveCallbackContinuationPlan(
      harness.openSocket,
      harness.context,
      'sess-1',
      undefined,
      `done${DONE_MARKER}`
    );

    assert.equal(plan.kind, 'continue');
    assert.equal(plan.emitComplete, true);
    assert.equal((plan as { round: number }).round, 2);
    assert.match(String((plan as { nextPrompt: string }).nextPrompt ?? ''), /\[AUTO_LOOP_CONTINUE\]/);
  } finally {
    harness.restore();
  }
}

async function testResolveSessionContinuationPlanUsesPlanSetTodoLoopPrompt(): Promise<void> {
  const harness = createHarness();
  try {
    harness.metaState.planningState = {
      state: 'plan_executing',
      activeExecutionPlanId: 'plan-approved',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    harness.server.getApprovedExecutionPlanMarkdown = () =>
      '### Approved Plan\n\n### Implementation Steps\n1. Ship the approved execution path.';
    harness.server.getSessionTodoProtocolState = () => ({
      items: [
        { id: 'todo-1', work: 'Deliver the feature end to end', detectionStandard: 'All milestones are shipped.' },
        { id: 'todo-2', work: 'Run verification', detectionStandard: 'Relevant tests pass.' },
      ],
      unfinishedItems: [
        { id: 'todo-1', work: 'Deliver the feature end to end', detectionStandard: 'All milestones are shipped.' },
        { id: 'todo-2', work: 'Run verification', detectionStandard: 'Relevant tests pass.' },
      ],
      activeItem: {
        id: 'todo-1',
        work: 'Deliver the feature end to end',
        detectionStandard: 'All milestones are shipped.',
        status: 'in_progress',
      },
      blockedItem: null,
      pendingItems: [
        {
          id: 'todo-2',
          work: 'Run verification',
          detectionStandard: 'Relevant tests pass.',
          status: 'pending',
        },
      ],
      completedItems: [],
      hasUnfinished: true,
      allCompleted: false,
    });
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: true,
        pausedByUser: false,
      }),
      getState: () => ({
        isRunning: true,
        currentRound: 4,
      }),
      shouldContinue: (result: string) => {
        assert.equal(result, `done${DONE_MARKER}`);
        return { shouldContinue: true };
      },
    }));

    const plan = harness.server.resolveCallbackContinuationPlan(
      harness.openSocket,
      harness.context,
      'sess-1',
      undefined,
      `done${DONE_MARKER}`
    );

    assert.equal(plan.kind, 'continue');
    assert.equal(plan.emitComplete, true);
    assert.equal((plan as { round: number }).round, 4);
    const nextPrompt = String((plan as { nextPrompt: string }).nextPrompt ?? '');
    assert.match(nextPrompt, /\[TODO_LOOP\]/);
    assert.match(nextPrompt, /todo action=plan_set/i);
    assert.match(nextPrompt, /Use set_status to promote the next pending todo to in_progress/i);
    assert.match(nextPrompt, /call set_status with status=completed plus task_id \(the todo item id\) and evidence/i);
    assert.match(nextPrompt, /call set_status with status=blocked plus blocked_reason/i);
    assert.match(nextPrompt, /Use add or update only for small manual corrections/i);
    assert.match(nextPrompt, /\[APPROVED_PLAN_ORIGINAL\]/);
    assert.match(nextPrompt, /### Approved Plan/);
    assert.match(nextPrompt, /Todo is the only execution ledger/i);
  } finally {
    harness.restore();
  }
}

async function testResolveSessionContinuationPlanBlocksTodoLoopWhilePlanNeedsConfirmation(): Promise<void> {
  const harness = createHarness();
  try {
    harness.server.getSessionTodoProtocolState = () => ({
      items: [
        { id: 'todo-1', work: 'Implement context projection', detectionStandard: 'Projection tests pass.' },
      ],
      unfinishedItems: [
        { id: 'todo-1', work: 'Implement context projection', detectionStandard: 'Projection tests pass.' },
      ],
      activeItem: {
        id: 'todo-1',
        work: 'Implement context projection',
        detectionStandard: 'Projection tests pass.',
        status: 'in_progress',
      },
      blockedItem: null,
      pendingItems: [],
      completedItems: [],
      hasUnfinished: true,
      allCompleted: false,
    });
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: true,
        mode: 'todo',
        pendingPlanConfirmation: true,
        pausedByUser: false,
      }),
      getState: () => ({
        isRunning: false,
        currentRound: 1,
      }),
      shouldContinue: () => {
        throw new Error('todo loop should not continue while plan confirmation is pending');
      },
    }));

    const plan = harness.server.resolveCallbackContinuationPlan(
      harness.openSocket,
      harness.context,
      'sess-1',
      undefined,
      `done${DONE_MARKER}`
    );

    assert.equal(plan.kind, 'none');
    assert.equal(plan.emitComplete, true);
  } finally {
    harness.restore();
  }
}

async function testResolveSessionContinuationPlanFallsThroughWhenTodoPromptSeesCompletedState(): Promise<void> {
  const harness = createHarness();
  let readCount = 0;
  try {
    harness.server.getSessionTodoProtocolState = () => {
      readCount += 1;
      if (readCount === 1) {
        return {
          items: [{ id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' }],
          unfinishedItems: [{ id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' }],
          activeItem: { id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' },
          blockedItem: null,
          pendingItems: [],
          completedItems: [],
          hasUnfinished: true,
          allCompleted: false,
        };
      }
      return {
        items: [{ id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' }],
        unfinishedItems: [],
        activeItem: null,
        blockedItem: null,
        pendingItems: [],
        completedItems: [{ id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' }],
        hasUnfinished: false,
        allCompleted: true,
      };
    };
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: true,
        pausedByUser: false,
      }),
      getState: () => ({
        isRunning: true,
        currentRound: 3,
      }),
      shouldContinue: (result: string) => {
        assert.equal(result, `done${DONE_MARKER}`);
        return { shouldContinue: true };
      },
    }));

    const plan = harness.server.resolveCallbackContinuationPlan(
      harness.openSocket,
      harness.context,
      'sess-1',
      undefined,
      `done${DONE_MARKER}`
    );

    assert.equal(plan.kind, 'continue');
    assert.equal(plan.emitComplete, true);
    assert.equal((plan as { round: number }).round, 3);
    assert.match(String((plan as { nextPrompt: string }).nextPrompt ?? ''), /\[AUTO_LOOP_CONTINUE\]/);
  } finally {
    harness.restore();
  }
}

async function testResolveSessionContinuationPlanRejectsDuplicateTailMarkers(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;
  try {
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: false,
      }),
      getState: () => ({
        isRunning: false,
        currentRound: 0,
      }),
    }));
    harness.server.scheduleCallbackContinuation = (
      ws: unknown,
      context: unknown,
      controllerArg: unknown,
      nextPrompt: unknown
    ) => {
      captured = [ws, context, controllerArg, nextPrompt];
    };

    const callback = harness.server.createCallback(harness.openSocket, harness.context, 'run-1');
    await callback.onComplete(`done${DONE_MARKER} ${REPORT_END_MARKER}`);

    assert.deepEqual(harness.lifecycle, ['reject:run-1:run_completed', 'refresh']);
    assert.deepEqual(harness.metaState.completionMarkerStats, {
      repairCount: 1,
      lastTriggeredAt: (harness.metaState.completionMarkerStats as { lastTriggeredAt: string }).lastTriggeredAt,
      lastIssue: 'duplicate_tail_marker',
    });
    assert.deepEqual(captured?.slice(0, 2), [harness.openSocket, harness.context]);
    assert.match(String(captured?.[3] ?? ''), /\[COMPLETION_MARKER_REQUIRED\]/);
  } finally {
    harness.restore();
  }
}

async function testMarkerDisabledSkipsContinuationAndStatsMutation(): Promise<void> {
  const harness = createHarness();
  try {
    harness.server.agent = {
      getConfig: () => createWebServerTestConfig({
        agent: {
          tokenLimit: 1000,
          completionMarkerEnforcementEnabled: false,
        },
      }),
    };
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: false,
      }),
      getState: () => ({
        isRunning: false,
        currentRound: 0,
      }),
    }));
    harness.metaState.completionMarkerStats = {
      repairCount: 3,
      lastIssue: 'missing_tail_marker',
      lastTriggeredAt: '2026-01-01T00:00:00.000Z',
    };

    const callback = harness.server.createCallback(harness.openSocket, harness.context, 'run-disabled');
    await callback.onComplete('done');

    assert.deepEqual(harness.lifecycle, ['reject:run-disabled:run_completed', 'refresh', 'emit:complete']);
    assert.equal(typeof (harness.emitted[0]?.data as { createdAt?: string }).createdAt, 'string');
    assert.deepEqual(harness.emitted.map(stripCreatedAt), [
      {
        ws: harness.openSocket,
        type: 'complete',
        data: {
          runId: 'run-disabled',
          context: harness.context,
          content: 'done',
          completionMarkerStats: null,
          sessionId: 'sess-1',
        },
      },
    ]);
    assert.deepEqual(harness.metaState.completionMarkerStats, {
      repairCount: 3,
      lastIssue: 'missing_tail_marker',
      lastTriggeredAt: '2026-01-01T00:00:00.000Z',
    });
  } finally {
    harness.restore();
  }
}

async function testMarkerDisabledSessionPlanDoesNotRequireMarkerBeforeTodoStop(): Promise<void> {
  const harness = createHarness();
  try {
    harness.server.agent = {
      getConfig: () => createWebServerTestConfig({
        agent: {
          tokenLimit: 1000,
          completionMarkerEnforcementEnabled: false,
        },
      }),
    };
    harness.server.getSessionTodoProtocolState = () => ({
      items: [{ id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' }],
      unfinishedItems: [],
      activeItem: null,
      blockedItem: null,
      pendingItems: [],
      completedItems: [{ id: 'todo-1', work: 'summarize', detectionStandard: 'marker report' }],
      hasUnfinished: false,
      allCompleted: true,
    });
    harness.setControllerFactory(() => ({
      getConfig: () => ({ enabled: false }),
      getState: () => ({ currentRound: 0, isRunning: false }),
    }));

    const plan = harness.server.resolveCallbackContinuationPlan(
      harness.openSocket,
      harness.context,
      'sess-1',
      undefined,
      'done'
    );

    assert.equal(plan.kind, 'none');
    assert.equal(plan.emitComplete, true);
  } finally {
    harness.restore();
  }
}

async function testFinalizeCompletedRunRejectsRefreshesAndCompletesInOrder(): Promise<void> {
  const harness = createHarness();
  try {
    harness.server.finalizeCompletedRun('run-1', {
      complete: (content: string, completionMarkerStats?: unknown) => {
        harness.lifecycle.push(`complete:${content}:${JSON.stringify(completionMarkerStats ?? null)}`);
      },
    }, 'done', true, { repairCount: 2, lastIssue: 'missing_tail_marker' });

    assert.deepEqual(harness.lifecycle, [
      'reject:run-1:run_completed',
      'refresh',
      'complete:done:{"repairCount":2,"lastIssue":"missing_tail_marker"}',
    ]);
  } finally {
    harness.restore();
  }
}

async function testResolveCallbackContinuationPlanReturnsStoppedPlan(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-stopped' });
  try {
    let requestedKey = '';
    harness.setControllerFactory((key: string) => {
      requestedKey = key;
      return {
        getConfig: () => ({
          enabled: true,
        }),
        shouldContinue: (result: string) => {
          harness.lifecycle.push(`shouldContinue:${result}`);
          return { shouldContinue: false, reason: 'done' };
        },
        getState: () => ({
          isRunning: true,
          currentRound: 3,
        }),
      };
    });

    const plan = harness.server.resolveCallbackContinuationPlan(harness.openSocket, harness.context, 'workspace:repo-stopped', undefined, 'done');

    assert.equal(requestedKey, 'workspace:repo-stopped');
    assert.deepEqual(harness.lifecycle, ['shouldContinue:done']);
    assert.deepEqual(plan, {
      kind: 'stopped',
      reason: 'done',
      totalRounds: 3,
      emitComplete: true,
    });
  } finally {
    harness.restore();
  }
}

async function testApplyCallbackContinuationPlanSchedulesContinuation(): Promise<void> {
  const harness = createHarness();
  const controller = { tag: 'controller' };
  let captured: unknown[] | null = null;
  try {
    harness.server.scheduleCallbackContinuation = (
      ws: unknown,
      context: unknown,
      controllerArg: unknown,
      nextPrompt: unknown
    ) => {
      captured = [ws, context, controllerArg, nextPrompt];
    };

    harness.server.applyCallbackContinuationPlan(
      harness.openSocket,
      harness.context,
      {
        autoLoopRound: (round: number, prompt: string) => {
          harness.lifecycle.push(`round:${round}:${prompt}`);
        },
      },
      {
        kind: 'continue',
        controller: controller as any,
        nextPrompt: 'Continue',
        round: 5,
        emitComplete: true,
      }
    );

    assert.deepEqual(harness.lifecycle, ['round:5:Continue']);
    assert.deepEqual(captured, [harness.openSocket, harness.context, controller, 'Continue']);
  } finally {
    harness.restore();
  }
}

async function testStartScheduledContinuationUsesClosedSocketAsDetachedOwner(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-closed-start' });
  const controller = {
    stop: (reason: string) => {
      harness.lifecycle.push(`stop:${reason}`);
    },
  };

  const scaffold = harness.server.startScheduledCallbackContinuation(
    harness.closedSocket,
    harness.context,
    controller
  );

  assert.notEqual(scaffold, null);
  assert.equal(scaffold?.ownerWs, harness.closedSocket);
  assert.match(scaffold?.runId ?? '', /^run-/);
  assert.deepEqual(harness.lifecycle, [
    `active:set:${scaffold?.runId}`,
    'emit:chat_started',
  ]);
  assert.equal(harness.server.activeRunContexts.size, 1);
}

async function testDismissedTodoDoesNotScheduleTodoContinuation(): Promise<void> {
  const harness = createHarness();
  try {
    harness.server.agent = {
      getConfig: () => createWebServerTestConfig({
        agent: {
          tokenLimit: 1000,
          completionMarkerEnforcementEnabled: false,
        },
      }),
    };
    harness.server.getSessionTodoProtocolState = () => ({
      items: [{ id: 'todo-dismissed', work: 'blocked', detectionStandard: 'external fix', status: 'dismissed' }],
      unfinishedItems: [],
      activeItem: null,
      blockedItem: null,
      pendingItems: [],
      completedItems: [],
      dismissedItems: [{ id: 'todo-dismissed', work: 'blocked', detectionStandard: 'external fix', status: 'dismissed' }],
      hasUnfinished: false,
      allCompleted: false,
    });
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: false,
        pausedByUser: false,
      }),
      getState: () => ({
        isRunning: false,
        currentRound: 2,
      }),
      shouldContinue: () => {
        throw new Error('dismissed todo must not drive continuation');
      },
    }));

    const plan = harness.server.resolveCallbackContinuationPlan(
      harness.openSocket,
      harness.context,
      'sess-1',
      undefined,
      'done'
    );

    assert.equal(plan.kind, 'none');
    assert.equal(plan.emitComplete, true);
  } finally {
    harness.restore();
  }
}

async function testStartScheduledContinuationActivatesRunAndEmitsChatStarted(): Promise<void> {
  const harness = createHarness();
  const scaffold = harness.server.startScheduledCallbackContinuation(
    harness.openSocket,
    harness.context,
    { stop: () => undefined }
  );

  assert.notEqual(scaffold, null);
  assert.match(scaffold?.runId ?? '', /^run-/);
  assert.deepEqual(harness.lifecycle, [
    `active:set:${scaffold?.runId}`,
    'emit:chat_started',
  ]);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'chat_started',
      data: {
        runId: scaffold?.runId,
        context: harness.context,
        startedAt: (harness.emitted[0].data as { startedAt: string }).startedAt,
        owner: 'web',
        origin: 'web',
        interactionState: {
          mode: 'normal',
          owner: 'web',
        },
      },
    },
  ]);
}

async function testResolveScheduledContinuationInputReturnsSuccess(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-success' });
  let callbackArgs: unknown[] | null = null;
  harness.server.resolveWorkspaceDirForContext = () => 'D:\\workspace';
  harness.server.resolveUserPrompt = (input: Record<string, unknown>) => {
    callbackArgs = [input.prompt, input.workspaceDir, input.context];
    return {
      ok: true,
      effectivePrompt: 'resolved prompt',
      displayPrompt: 'Continue',
      hasSystemPromptInjection: true,
    };
  };
  harness.server.createCallback = (ws: object, context: ContextRef, runId: string) => ({
    ws,
    context,
    runId,
  });

  const resolution = harness.server.resolveScheduledCallbackContinuationInput(
    harness.openSocket,
    harness.context,
    'Continue',
    'run-2'
  );

  assert.deepEqual(callbackArgs, ['Continue', 'D:\\workspace', harness.context]);
  assert.deepEqual(resolution, {
    ok: true,
    runInput: {
      prompt: 'resolved prompt',
      rawUserPrompt: 'Continue',
      effectivePrompt: 'resolved prompt',
      hasSystemPromptInjection: true,
      runOrigin: 'web',
      callback: {
        ws: harness.openSocket,
        context: harness.context,
        runId: 'run-2',
      },
    },
  });
}

async function testResolveScheduledContinuationInputReturnsFailureForPromptError(): Promise<void> {
  const harness = createHarness();
  harness.server.resolveWorkspaceDirForContext = () => 'D:\\workspace';
  harness.server.resolveUserPrompt = () => ({
    ok: false,
    error: 'prompt_resolution_failed',
  });
  harness.server.createCallback = () => {
    throw new Error('createCallback should not run on prompt failure');
  };

  const resolution = harness.server.resolveScheduledCallbackContinuationInput(
    harness.openSocket,
    harness.context,
    'Continue',
    'run-2'
  );

  assert.deepEqual(resolution, {
    ok: false,
    error: 'prompt_resolution_failed',
  });
}

async function testResolveScheduledContinuationInputReturnsFailureForPreparationThrow(): Promise<void> {
  const harness = createHarness();
  harness.server.resolveWorkspaceDirForContext = () => {
    throw new Error('workspace_failed');
  };

  const resolution = harness.server.resolveScheduledCallbackContinuationInput(
    harness.openSocket,
    harness.context,
    'Continue',
    'run-2'
  );

  assert.deepEqual(resolution, {
    ok: false,
    error: 'workspace_failed',
  });
}

async function testResolveScheduledContinuationInputReturnsFailureForCreateCallbackThrow(): Promise<void> {
  const harness = createHarness();
  harness.server.resolveWorkspaceDirForContext = () => 'D:\\workspace';
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved prompt',
    displayPrompt: 'Continue',
    hasSystemPromptInjection: true,
  });
  harness.server.createCallback = () => {
    throw new Error('callback_failed');
  };

  const resolution = harness.server.resolveScheduledCallbackContinuationInput(
    harness.openSocket,
    harness.context,
    'Continue',
    'run-2'
  );

  assert.deepEqual(resolution, {
    ok: false,
    error: 'callback_failed',
  });
}

async function testApplyScheduledContinuationFailureEmitsErrorStopsAndCleans(): Promise<void> {
  const harness = createHarness();
  harness.server.activeRunContexts.set('run-2', harness.context);
  harness.lifecycle.length = 0;

  await harness.server.applyScheduledCallbackContinuationResolution(
    harness.context,
    {
      stop: (reason: string) => {
        harness.lifecycle.push(`stop:${reason}`);
      },
    },
    {
      runId: 'run-2',
      ownerWs: harness.openSocket,
      dispatcher: {
        error: (error: string) => {
          assert.equal(harness.server.activeRunContexts.size, 0);
          harness.lifecycle.push(`error:${error}`);
        },
      },
    },
    {
      ok: false,
      error: 'prompt_resolution_failed',
    }
  );

  assert.deepEqual(harness.lifecycle, [
    'active:delete:run-2',
    'error:prompt_resolution_failed',
    'stop:error',
  ]);
  assert.equal(harness.server.activeRunContexts.size, 0);
}

async function testApplyScheduledContinuationFailureStillStopsAndCleansWhenDispatcherThrows(): Promise<void> {
  const harness = createHarness();
  harness.server.activeRunContexts.set('run-2', harness.context);
  harness.lifecycle.length = 0;

  await assert.rejects(
    harness.server.applyScheduledCallbackContinuationResolution(
      harness.context,
      {
        stop: (reason: string) => {
          harness.lifecycle.push(`stop:${reason}`);
        },
      },
      {
        runId: 'run-2',
        ownerWs: harness.openSocket,
        dispatcher: {
          error: (error: string) => {
            assert.equal(harness.server.activeRunContexts.size, 0);
            harness.lifecycle.push(`error:${error}`);
            throw new Error('emit_failed');
          },
        },
      },
      {
        ok: false,
        error: 'prompt_resolution_failed',
      }
    ),
    /emit_failed/
  );

  assert.deepEqual(harness.lifecycle, [
    'active:delete:run-2',
    'error:prompt_resolution_failed',
    'stop:error',
  ]);
  assert.equal(harness.server.activeRunContexts.size, 0);
}

async function testApplyScheduledContinuationFailureStillCleansWhenControllerStopThrows(): Promise<void> {
  const harness = createHarness();
  harness.server.activeRunContexts.set('run-2', harness.context);
  harness.lifecycle.length = 0;

  await assert.rejects(
    harness.server.applyScheduledCallbackContinuationResolution(
      harness.context,
      {
        stop: (reason: string) => {
          harness.lifecycle.push(`stop:${reason}`);
          throw new Error('stop_failed');
        },
      },
      {
        runId: 'run-2',
        ownerWs: harness.openSocket,
        dispatcher: {
          error: (error: string) => {
            assert.equal(harness.server.activeRunContexts.size, 0);
            harness.lifecycle.push(`error:${error}`);
          },
        },
      },
      {
        ok: false,
        error: 'prompt_resolution_failed',
      }
    ),
    /stop_failed/
  );

  assert.deepEqual(harness.lifecycle, [
    'active:delete:run-2',
    'error:prompt_resolution_failed',
    'stop:error',
  ]);
  assert.equal(harness.server.activeRunContexts.size, 0);
}

async function testApplyScheduledContinuationSuccessDelegatesToTrackedRun(): Promise<void> {
  const harness = createHarness();
  let captured: unknown = null;
  harness.server.executeTrackedRun = async (execution: unknown) => {
    captured = execution;
  };

  await harness.server.applyScheduledCallbackContinuationResolution(
    harness.context,
    { stop: () => undefined },
    {
      runId: 'run-2',
      ownerWs: harness.openSocket,
      dispatcher: { error: (_error: string) => undefined },
    },
    {
      ok: true,
      runInput: {
        prompt: 'resolved prompt',
        callback: { kind: 'callback' },
      },
    }
  );

  const execution = captured as {
    runId: string;
    ownerWs: object;
    context: ContextRef;
    dispatcher: { error: (error: string) => void };
    stopControllerOnError: { stop: () => void };
    resolveRunInput: () => unknown;
  };
  assert.equal(execution.runId, 'run-2');
  assert.equal(execution.ownerWs, harness.openSocket);
  assert.deepEqual(execution.context, harness.context);
  assert.equal(typeof execution.dispatcher.error, 'function');
  assert.equal(typeof execution.stopControllerOnError.stop, 'function');
  assert.deepEqual(execution.resolveRunInput(), {
    prompt: 'resolved prompt',
    callback: { kind: 'callback' },
  });
}

async function testScheduleHelperUses500msDelayAndDelegatesToExecution(): Promise<void> {
  const harness = createHarness();
  const originalSetTimeout = globalThis.setTimeout;
  let scheduledDelay: number | null = null;
  let scheduledFn: (() => void) | null = null;
  const controller = { tag: 'controller' };
  let captured: unknown[] | null = null;
  try {
    (globalThis as any).setTimeout = (fn: () => void, delay?: number) => {
      scheduledFn = fn;
      scheduledDelay = delay ?? null;
      return 0;
    };
    harness.server.executeScheduledCallbackContinuation = async (
      ws: unknown,
      context: unknown,
      controllerArg: unknown,
      nextPrompt: unknown
    ) => {
      captured = [ws, context, controllerArg, nextPrompt];
    };

    harness.server.scheduleCallbackContinuation(harness.openSocket, harness.context, controller, 'Continue');
    scheduledFn?.();

    assert.equal(scheduledDelay, 500);
    assert.deepEqual(captured, [harness.openSocket, harness.context, controller, 'Continue']);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    harness.restore();
  }
}

async function testScheduledCompletionContinuesIfSocketClosesBeforeNextRun(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-socket-close' });
  const originalSetTimeout = globalThis.setTimeout;
  let scheduledFn: (() => void) | null = null;
  let executionPromise: Promise<void> | null = null;
  const stopReasons: string[] = [];
  try {
    (globalThis as any).setTimeout = (fn: () => void) => {
      scheduledFn = fn;
      return 0;
    };
    const executeScheduled = harness.server.executeScheduledCallbackContinuation.bind(harness.server);
    harness.server.executeScheduledCallbackContinuation = (...args: unknown[]) => {
      executionPromise = executeScheduled(...args);
      return executionPromise;
    };
    harness.server.agent = {
      getConfig: () => createWebServerTestConfig({
        agent: {
          tokenLimit: 1000,
        },
      }),
      runWithResult: async () => {
        harness.lifecycle.push('runWithResult');
        return {
          content: 'continued',
          context: harness.context,
          turnId: 'turn-continuation',
          contextVersion: 2,
        };
      },
    };
    harness.server.resolveWorkspaceDirForContext = () => 'D:\\workspace';
    harness.server.resolveUserPrompt = () => ({
      ok: true,
      effectivePrompt: 'resolved prompt',
      displayPrompt: 'Continue',
      hasSystemPromptInjection: true,
    });
    harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: true,
      }),
      shouldContinue: () => ({ shouldContinue: true }),
      getState: () => ({
        isRunning: true,
        currentRound: 2,
      }),
      stop: (reason: string) => {
        harness.lifecycle.push(`stop:${reason}`);
        stopReasons.push(reason);
      },
    }));

    const callback = harness.server.createCallback(harness.openSocket, harness.context, 'run-1');
    await callback.onComplete('done');
    harness.server.createCallback = (_ws: object, _context: ContextRef, runId: string) => {
      harness.lifecycle.push(`createCallback:${runId}`);
      return { runId };
    };
    harness.openSocket.readyState = WebSocket.CLOSED;
    scheduledFn?.();
    await executionPromise;

    assert.deepEqual(stopReasons, []);
    assert.equal(harness.server.activeRunContexts.size, 0);
    assert.equal(
      harness.lifecycle.some((entry) => entry.startsWith('active:set:')),
      true
    );
    assert.equal(
      harness.lifecycle.some((entry) => entry.startsWith('active:delete:')),
      true
    );
    assert.equal(harness.lifecycle.includes('runWithResult'), true);
    assert.deepEqual(harness.lifecycle.slice(0, 4), [
      'reject:run-1:run_completed',
      'refresh',
      'emit:complete',
      'emit:auto_loop_round',
    ]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    harness.restore();
  }
}

async function testDirectContinuationExecutionRunsAgentAndCleansActiveContext(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-success' });
  const runCalls: Array<Record<string, unknown>> = [];
  const stopReasons: string[] = [];
  try {
    harness.server.agent = {
      getConfig: () => createWebServerTestConfig({
        agent: {
          tokenLimit: 1000,
        },
      }),
      runWithResult: async (args: Record<string, unknown>) => {
        harness.lifecycle.push('runWithResult');
        runCalls.push(args);
        return {
          content: 'done',
          context: harness.context,
          turnId: 'turn-continuation',
          contextVersion: 1,
        };
      },
    };
    harness.server.resolveWorkspaceDirForContext = () => 'D:\\workspace';
    harness.server.resolveUserPrompt = () => ({
      ok: true,
      effectivePrompt: 'resolved prompt',
      displayPrompt: 'Continue',
      hasSystemPromptInjection: true,
    });
    harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';
    harness.server.createCallback = (ws: object, context: ContextRef, runId: string) => {
      harness.lifecycle.push(`createCallback:${runId}`);
      return {
        ws,
        context,
        runId,
      };
    };

    await harness.server.executeScheduledCallbackContinuation(
      harness.openSocket,
      harness.context,
      {
        getState: () => ({
          isRunning: true,
          currentRound: 1,
        }),
        stop: (reason: string) => {
          stopReasons.push(reason);
        },
      },
      'Continue'
    );

    assert.equal(stopReasons.length, 0);
    assert.equal(harness.server.activeRunContexts.size, 0);
    assert.equal(
      harness.lifecycle.some((entry) => entry.startsWith('active:set:')),
      true
    );
    assert.equal(
      harness.lifecycle.some((entry) => entry.startsWith('active:delete:')),
      true
    );
    assert.equal(harness.emitted.at(-1)?.type, 'chat_started');
    assert.equal(runCalls.length, 1);
    const runCall = runCalls[0];
    const chatStarted = harness.emitted.at(-1) as EmittedMessage;
    const nextRunId = (chatStarted.data as { runId: string }).runId;
    assert.deepEqual(runCall, {
      prompt: 'resolved prompt',
      runId: nextRunId,
      rawUserPrompt: 'Continue',
      effectivePrompt: 'resolved prompt',
      hasSystemPromptInjection: true,
      context: harness.context,
      callback: {
        ws: harness.openSocket,
        context: harness.context,
        runId: nextRunId,
      },
      additionalSystemPrompt: 'AUTO_LOOP_SYSTEM_PROMPT',
    });
    assert.equal(harness.lifecycle.includes(`createCallback:${nextRunId}`), true);
    assert.equal(harness.lifecycle.includes('runWithResult'), true);
  } finally {
    harness.restore();
  }
}

async function testDirectContinuationExecutionStopsOnRunFailureAndCleansActiveContext(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-failure' });
  const stopReasons: string[] = [];
  try {
    harness.server.agent = {
      getConfig: () => createWebServerTestConfig({
        agent: {
          tokenLimit: 1000,
        },
      }),
      runWithResult: async () => {
        harness.lifecycle.push('runWithResult');
        throw new Error('run_failed');
      },
    };
    harness.server.resolveWorkspaceDirForContext = () => 'D:\\workspace';
    harness.server.resolveUserPrompt = () => ({
      ok: true,
      effectivePrompt: 'resolved prompt',
      displayPrompt: 'Continue',
      hasSystemPromptInjection: true,
    });
    harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';
    harness.server.createCallback = (_ws: object, _context: ContextRef, runId: string) => {
      harness.lifecycle.push(`createCallback:${runId}`);
      return { runId };
    };

    await harness.server.executeScheduledCallbackContinuation(
      harness.openSocket,
      harness.context,
      {
        getState: () => ({
          isRunning: true,
          currentRound: 1,
        }),
        stop: (reason: string) => {
          stopReasons.push(reason);
        },
      },
      'Continue'
    );

    assert.deepEqual(stopReasons, ['error']);
    assert.equal(harness.server.activeRunContexts.size, 0);
    assert.equal(
      harness.lifecycle.some((entry) => entry.startsWith('active:set:')),
      true
    );
    assert.equal(
      harness.lifecycle.some((entry) => entry.startsWith('active:delete:')),
      true
    );
    const lastTwo = harness.emitted.slice(-2);
    assert.deepEqual(lastTwo.map((message) => message.type), ['chat_started', 'error']);
    const chatStarted = lastTwo[0];
    assert.deepEqual(lastTwo[1].data, {
      runId: (chatStarted.data as { runId: string }).runId,
      context: harness.context,
      error: 'run_failed',
    });
  } finally {
    harness.restore();
  }
}

async function testScheduledCompletionEmitsChatStartedAndStopsOnPromptResolutionError(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-prompt-error' });
  const originalSetTimeout = globalThis.setTimeout;
  let scheduledFn: (() => Promise<void>) | null = null;
  try {
    (globalThis as any).setTimeout = (fn: () => Promise<void>) => {
      scheduledFn = fn;
      return 0;
    };
    harness.server.resolveWorkspaceDirForContext = () => 'D:\\workspace';
    harness.server.resolveUserPrompt = () => ({
      ok: false,
      error: 'prompt_resolution_failed',
    });
    harness.setControllerFactory(() => ({
      getConfig: () => ({
        enabled: true,
      }),
      shouldContinue: () => ({ shouldContinue: true }),
      getState: () => ({
        isRunning: true,
        currentRound: 7,
      }),
      stop: (reason: string) => {
        harness.lifecycle.push(`stop:${reason}`);
      },
    }));

    const callback = harness.server.createCallback(harness.openSocket, harness.context, 'run-1');
    await callback.onComplete('done');
    await scheduledFn?.();
    await Promise.resolve();

    assert.equal(harness.server.activeRunContexts.size, 0);
    assert.equal(
      harness.lifecycle.some((entry) => entry.startsWith('active:set:')),
      true
    );
    assert.equal(
      harness.lifecycle.some((entry) => entry.startsWith('active:delete:')),
      true
    );
    const lastTwo = harness.emitted.slice(-2);
    assert.deepEqual(lastTwo.map((message) => message.type), ['chat_started', 'error']);
    const chatStarted = lastTwo[0];
    const errorMessage = lastTwo[1];
    assert.equal(chatStarted.ws, harness.openSocket);
    assert.equal(errorMessage.ws, harness.openSocket);
    assert.deepEqual(chatStarted.data, {
      runId: (chatStarted.data as { runId: string }).runId,
      context: harness.context,
      startedAt: (chatStarted.data as { startedAt: string }).startedAt,
      owner: 'web',
      origin: 'web',
      interactionState: {
        mode: 'normal',
        owner: 'web',
      },
    });
    assert.deepEqual(errorMessage.data, {
      runId: (chatStarted.data as { runId: string }).runId,
      context: harness.context,
      error: 'prompt_resolution_failed',
    });
    assert.equal(harness.lifecycle.includes('stop:error'), true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    harness.restore();
  }
}

async function testScheduledContinuationRejectsDirtyRootRuntimeWhileRootRunActive(): Promise<void> {
  const context: ContextRef = { scope: 'workspace', namespace: 'repo-next' };
  const harness = createHarness(context);
  const stopReasons: string[] = [];
  try {
    harness.server.rootRuntimeConfigDirty = true;
    harness.server.activeRunContexts.set('run-active-root', {
      scope: 'workspace',
      namespace: 'repo-active',
    });
    harness.lifecycle.length = 0;

    await harness.server.executeScheduledCallbackContinuation(
      harness.openSocket,
      context,
      {
        getState: () => ({
          isRunning: true,
          currentRound: 1,
        }),
        stop: (reason: string) => {
          stopReasons.push(reason);
        },
      },
      'Continue'
    );

    assert.deepEqual(stopReasons, ['error']);
    assert.equal(harness.server.activeRunContexts.size, 1);
    assert.deepEqual(harness.emitted, []);
    assert.deepEqual(harness.lifecycle, []);
  } finally {
    harness.restore();
  }
}

async function testScheduledContinuationDoesNotPrepareRuntimeWhileSessionRunActive(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-active' };
  const harness = createHarness(context);
  const stopReasons: string[] = [];
  try {
    harness.server.activeRunContexts.set('run-active-session', context);
    harness.server.ensureSessionRuntime = async () => {
      throw new Error('ensureSessionRuntime should not run while continuation context is active');
    };
    harness.lifecycle.length = 0;

    await harness.server.executeScheduledCallbackContinuation(
      harness.openSocket,
      context,
      {
        getState: () => ({
          isRunning: true,
          currentRound: 1,
        }),
        stop: (reason: string) => {
          stopReasons.push(reason);
        },
      },
      'Continue'
    );

    assert.deepEqual(stopReasons, ['user_stop']);
    assert.equal(harness.server.activeRunContexts.size, 1);
    assert.deepEqual(harness.emitted, []);
    assert.deepEqual(harness.lifecycle, []);
  } finally {
    harness.restore();
  }
}

async function testScheduledContinuationDoesNotPrepareRuntimeWhenLoopStopped(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-stopped' };
  const harness = createHarness(context);
  try {
    harness.server.ensureSessionRuntime = async () => {
      throw new Error('ensureSessionRuntime should not run after auto-loop stopped');
    };
    harness.lifecycle.length = 0;

    await harness.server.executeScheduledCallbackContinuation(
      harness.openSocket,
      context,
      {
        getState: () => ({
          isRunning: false,
          currentRound: 1,
        }),
        stop: () => {
          throw new Error('stopped controller should not be stopped again');
        },
      },
      'Continue'
    );

    assert.equal(harness.server.activeRunContexts.size, 0);
    assert.deepEqual(harness.emitted, []);
    assert.deepEqual(harness.lifecycle, []);
  } finally {
    harness.restore();
  }
}

async function testDirectHelperUsesProvidedLoopKey(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-a' });
  try {
    let requestedKey = '';
    harness.setControllerFactory((key: string) => {
      requestedKey = key;
      return {
        getConfig: () => ({
          enabled: true,
        }),
        shouldContinue: () => ({ shouldContinue: false, reason: 'tool_exit' }),
        getState: () => ({
          isRunning: true,
          currentRound: 6,
        }),
      };
    });
    const dispatcher = {
      complete: (content: string) => {
        harness.lifecycle.push(`complete:${content}`);
      },
      autoLoopStopped: (reason?: string, totalRounds?: number) => {
        harness.lifecycle.push(`stopped:${reason}:${totalRounds}`);
      },
      autoLoopRound: () => {
        harness.lifecycle.push('auto_loop_round');
      },
    };

    await harness.server.handleCallbackCompletion(
      harness.openSocket,
      harness.context,
      'run-helper',
      'workspace:repo-a',
      'final',
      dispatcher
    );

    assert.equal(requestedKey, 'workspace:repo-a');
    assert.deepEqual(harness.lifecycle, [
      'reject:run-helper:run_completed',
      'refresh',
      'complete:final',
      'stopped:tool_exit:6',
    ]);
  } finally {
    harness.restore();
  }
}

async function testExecuteTrackedRunFailureStopsControllerAndCleansWithoutRefresh(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-b' });
  harness.server.activeRunContexts.set('run-helper', harness.context);
  harness.lifecycle.length = 0;
  try {
    harness.server.agent = {
      getConfig: () => createWebServerTestConfig({
        agent: {
          tokenLimit: 1000,
        },
      }),
      runWithResult: async () => {
        harness.lifecycle.push('runWithResult');
        throw new Error('run_failed');
      },
    };
    harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';

    await harness.server.executeTrackedRun({
      runId: 'run-helper',
      context: harness.context,
      dispatcher: {
        error: (error: string) => {
          harness.lifecycle.push(`error:${error}`);
        },
      },
      stopControllerOnError: {
        stop: (reason: string) => {
          harness.lifecycle.push(`stop:${reason}`);
        },
      },
      resolveRunInput: () => ({
        prompt: 'Continue',
        callback: { kind: 'callback' },
      }),
    });

    assert.deepEqual(harness.lifecycle, [
      'runWithResult',
      'active:delete:run-helper',
      'error:run_failed',
      'stop:error',
    ]);
    assert.equal(harness.server.activeRunContexts.size, 0);
  } finally {
    harness.restore();
  }
}

async function testExecuteTrackedRunResolveInputThrowStopsControllerAndCleansWithoutRefresh(): Promise<void> {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-c' });
  harness.server.activeRunContexts.set('run-helper', harness.context);
  harness.lifecycle.length = 0;
  try {
    harness.server.agent = {
      getConfig: () => createWebServerTestConfig({
        agent: {
          tokenLimit: 1000,
        },
      }),
      runWithResult: async () => {
        harness.lifecycle.push('runWithResult');
      },
    };

    await harness.server.executeTrackedRun({
      runId: 'run-helper',
      context: harness.context,
      dispatcher: {
        error: (error: string) => {
          assert.equal(harness.server.activeRunContexts.size, 0);
          harness.lifecycle.push(`error:${error}`);
        },
      },
      stopControllerOnError: {
        stop: (reason: string) => {
          harness.lifecycle.push(`stop:${reason}`);
        },
      },
      resolveRunInput: () => {
        throw new Error('resolve_failed');
      },
    });

    assert.deepEqual(harness.lifecycle, [
      'active:delete:run-helper',
      'error:resolve_failed',
      'stop:error',
    ]);
    assert.equal(harness.server.activeRunContexts.size, 0);
  } finally {
    harness.restore();
  }
}

async function runAll(): Promise<void> {
  await testOnCompleteClosedWorkspaceSocketKeepsAutoLoopContinuation();
  await testOnCompleteClosedSessionSocketKeepsTodoContinuation();
  await testOnCompleteCancelledSuppressesCompletionAndContinuation();
  await testOnCompleteWithoutMarkerSchedulesMarkerContinuationWithoutCompletion();
  await testOnCompleteWithoutMarkerUsesRepairOnlyPromptForBlockedTodo();
  await testResolveSessionContinuationPlanRequiresMarkerBeforeTodoCompletionStop();
  await testOnCompleteSchedulesNextQualifiedRoundWhenMarkerExists();
  await testResolveSessionContinuationPlanAllowsOuterLoopAfterTodoCompletion();
  await testResolveSessionContinuationPlanUsesPlanSetTodoLoopPrompt();
  await testResolveSessionContinuationPlanBlocksTodoLoopWhilePlanNeedsConfirmation();
  await testResolveSessionContinuationPlanFallsThroughWhenTodoPromptSeesCompletedState();
  await testResolveSessionContinuationPlanRejectsDuplicateTailMarkers();
  await testMarkerDisabledSkipsContinuationAndStatsMutation();
  await testMarkerDisabledSessionPlanDoesNotRequireMarkerBeforeTodoStop();
  await testDismissedTodoDoesNotScheduleTodoContinuation();
  await testFinalizeCompletedRunRejectsRefreshesAndCompletesInOrder();
  await testResolveCallbackContinuationPlanReturnsStoppedPlan();
  await testApplyCallbackContinuationPlanSchedulesContinuation();
  await testStartScheduledContinuationUsesClosedSocketAsDetachedOwner();
  await testStartScheduledContinuationActivatesRunAndEmitsChatStarted();
  await testResolveScheduledContinuationInputReturnsSuccess();
  await testResolveScheduledContinuationInputReturnsFailureForPromptError();
  await testResolveScheduledContinuationInputReturnsFailureForPreparationThrow();
  await testResolveScheduledContinuationInputReturnsFailureForCreateCallbackThrow();
  await testApplyScheduledContinuationFailureEmitsErrorStopsAndCleans();
  await testApplyScheduledContinuationFailureStillStopsAndCleansWhenDispatcherThrows();
  await testApplyScheduledContinuationFailureStillCleansWhenControllerStopThrows();
  await testApplyScheduledContinuationSuccessDelegatesToTrackedRun();
  await testScheduleHelperUses500msDelayAndDelegatesToExecution();
  await testScheduledCompletionContinuesIfSocketClosesBeforeNextRun();
  await testDirectContinuationExecutionRunsAgentAndCleansActiveContext();
  await testDirectContinuationExecutionStopsOnRunFailureAndCleansActiveContext();
  await testScheduledCompletionEmitsChatStartedAndStopsOnPromptResolutionError();
  await testScheduledContinuationRejectsDirtyRootRuntimeWhileRootRunActive();
  await testScheduledContinuationDoesNotPrepareRuntimeWhileSessionRunActive();
  await testScheduledContinuationDoesNotPrepareRuntimeWhenLoopStopped();
  await testDirectHelperUsesProvidedLoopKey();
  await testExecuteTrackedRunFailureStopsControllerAndCleansWithoutRefresh();
  await testExecuteTrackedRunResolveInputThrowStopsControllerAndCleansWithoutRefresh();
  console.log('web-callback-completion tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
