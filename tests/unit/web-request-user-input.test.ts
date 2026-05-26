import * as assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { ContextRef, PlanInputAnswer, PlanInputRequest } from '../../src/types.js';
import { createWebServerTestConfig } from './web-server-test-config.js';
import {
  createWebServerDouble,
  getPendingPlanInputs,
  replacePendingPlanInputs,
} from './helpers/web-server-harness.js';

interface PendingPlanInputRecord {
  runId: string;
  context: ContextRef;
  ws: object;
  request: PlanInputRequest;
  resolve: (answers: PlanInputAnswer[]) => void;
  reject: (error: Error) => void;
  detachedAt?: number;
  detachTimer?: ReturnType<typeof setTimeout>;
}

interface EmittedMessage {
  ws: object;
  type: string;
  data: unknown;
}

interface RequestUserInputHarness {
  server: any;
  openSocket: { readyState: number; socket: string };
  closedSocket: { readyState: number; socket: string };
  context: ContextRef;
  request: PlanInputRequest;
  lifecycle: string[];
  emittedRequests: PlanInputRequest[];
  emittedMessages: EmittedMessage[];
  metaUpdates: Array<{ context: ContextRef; patch: Record<string, unknown> }>;
  emitRequested: (request: PlanInputRequest) => void;
}

class RecordingPendingPlanInputMap extends Map<string, unknown> {
  constructor(
    private readonly lifecycle: string[],
    entries?: ReadonlyArray<readonly [string, unknown]>
  ) {
    super();
    if (entries) {
      for (const [key, value] of entries) {
        super.set(key, value);
      }
    }
  }

  override set(key: string, value: unknown): this {
    this.lifecycle.push(`set:${key}`);
    return super.set(key, value);
  }
}

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

function createHarness(withExistingPending = false): RequestUserInputHarness {
  const lifecycle: string[] = [];
  const emittedRequests: PlanInputRequest[] = [];
  const emittedMessages: EmittedMessage[] = [];
  const metaUpdates: Array<{ context: ContextRef; patch: Record<string, unknown> }> = [];
  const context: ContextRef = {
    scope: 'session',
    namespace: 'sess-1',
  };
  const request = createRequest();
  const server = createWebServerDouble();

  server.wss = { clients: [] };
  server.cancelingRunIds = new Set<string>();
  replacePendingPlanInputs(server, new RecordingPendingPlanInputMap(
    lifecycle,
    withExistingPending ? [['run-1', { existing: true }]] : undefined
  ) as any);
  server.emitToClient = (ws: object, message: Omit<EmittedMessage, 'ws'>) => {
    lifecycle.push(`emit:${message.type}`);
    emittedMessages.push({ ws, ...message });
  };
  server.updateContextNamespaceMetaSafe = (nextContext: ContextRef, patch: Record<string, unknown>) => {
    lifecycle.push('meta:update');
    metaUpdates.push({ context: nextContext, patch });
  };
  server.getContextNamespaceMetaSafe = () => ({
    pendingPlanInput: {
      runId: 'run-1',
      requestId: request.requestId,
      questions: request.questions,
      requestedAt: '2026-04-25T00:00:00.000Z',
    },
  });
  server.resolveAgentForContext = () => ({
    cancelContext: (nextContext: ContextRef) => {
      lifecycle.push(`cancelContext:${nextContext.scope}:${nextContext.namespace}`);
      return 1;
    },
  });

  return {
    server,
    openSocket: { readyState: WebSocket.OPEN, socket: 'open' },
    closedSocket: { readyState: WebSocket.CLOSED, socket: 'closed' },
    context,
    request,
    lifecycle,
    emittedRequests,
    emittedMessages,
    metaUpdates,
    emitRequested: (nextRequest: PlanInputRequest) => {
      lifecycle.push('emit:plan_input_requested');
      emittedRequests.push(nextRequest);
    },
  };
}

async function testClosedSocketStoresDetachedPendingForReconnectGrace(): Promise<void> {
  const harness = createHarness();

  const pendingPromise = harness.server.requestUserInputFromSocket(
    harness.closedSocket,
    harness.context,
    'run-1',
    harness.request,
    harness.emitRequested
  );

  assert.deepEqual(harness.lifecycle, ['meta:update', 'emit:plan_input_requested', 'set:run-1']);
  assert.deepEqual(harness.emittedRequests, [harness.request]);
  assert.equal(getPendingPlanInputs(harness.server).size, 1);

  const answers: PlanInputAnswer[] = [{ id: 'mode', selectedLabel: 'Fast', selectedIndex: 0 }];
  const pending = getPendingPlanInputs(harness.server).get('run-1') as PendingPlanInputRecord;
  assert.equal(pending.ws, harness.closedSocket);
  assert.equal(typeof pending.detachedAt, 'number');
  assert.ok(pending.detachTimer);
  clearTimeout(pending.detachTimer);
  pending.resolve(answers);
  assert.deepEqual(await pendingPromise, answers);
}

async function testDuplicatePendingRejectsWithoutEmitOrSet(): Promise<void> {
  const harness = createHarness(true);

  await assert.rejects(
    harness.server.requestUserInputFromSocket(
      harness.openSocket,
      harness.context,
      'run-1',
      harness.request,
      harness.emitRequested
    ),
    { message: 'request_user_input already pending for this run' }
  );

  assert.deepEqual(harness.lifecycle, []);
  assert.deepEqual(harness.emittedRequests, []);
  assert.deepEqual(harness.metaUpdates, []);
  assert.equal(getPendingPlanInputs(harness.server).size, 1);
}

async function testSuccessfulRequestEmitsAndStoresPendingRecord(): Promise<void> {
  const harness = createHarness();
  const answers: PlanInputAnswer[] = [
    {
      id: 'mode',
      selectedLabel: 'Safe',
      selectedIndex: 1,
      freeText: undefined,
    },
  ];

  const pendingPromise = harness.server.requestUserInputFromSocket(
    harness.openSocket,
    harness.context,
    'run-1',
    harness.request,
    harness.emitRequested
  );

  assert.deepEqual(harness.lifecycle, ['meta:update', 'emit:plan_input_requested', 'set:run-1']);
  assert.deepEqual(harness.emittedRequests, [harness.request]);
  assert.equal(harness.metaUpdates.length, 1);
  assert.deepEqual(harness.metaUpdates[0]?.context, harness.context);
  assert.equal(
    (harness.metaUpdates[0]?.patch.pendingPlanInput as { runId?: string; requestId?: string }).runId,
    'run-1'
  );
  assert.equal(
    (harness.metaUpdates[0]?.patch.pendingPlanInput as { runId?: string; requestId?: string }).requestId,
    harness.request.requestId
  );
  assert.deepEqual(
    (harness.metaUpdates[0]?.patch.pendingPlanInput as { questions?: unknown }).questions,
    harness.request.questions
  );
  assert.match(
    String((harness.metaUpdates[0]?.patch.pendingPlanInput as { requestedAt?: string }).requestedAt ?? ''),
    /^\d{4}-\d{2}-\d{2}T/
  );

  const pending = getPendingPlanInputs(harness.server).get('run-1') as PendingPlanInputRecord;
  assert.equal(pending.runId, 'run-1');
  assert.equal(pending.context, harness.context);
  assert.equal(pending.ws, harness.openSocket);
  assert.equal(pending.request, harness.request);

  pending.resolve(answers);
  assert.deepEqual(await pendingPromise, answers);
}

async function testPendingRejectWiresReturnedPromise(): Promise<void> {
  const harness = createHarness();

  const pendingPromise = harness.server.requestUserInputFromSocket(
    harness.openSocket,
    harness.context,
    'run-1',
    harness.request,
    harness.emitRequested
  );

  const pending = getPendingPlanInputs(harness.server).get('run-1') as PendingPlanInputRecord;
  pending.reject(new Error('run_canceled'));

  await assert.rejects(pendingPromise, { message: 'run_canceled' });
  assert.deepEqual(harness.lifecycle, ['meta:update', 'emit:plan_input_requested', 'set:run-1']);
}

async function testDetachedPendingRequestCancelsAfterGraceCleanup(): Promise<void> {
  const harness = createHarness();

  const pendingPromise = harness.server.requestUserInputFromSocket(
    harness.openSocket,
    harness.context,
    'run-1',
    harness.request,
    harness.emitRequested
  );

  harness.server.detachPendingPlanInputSocket(harness.openSocket);
  const pending = getPendingPlanInputs(harness.server).get('run-1') as PendingPlanInputRecord;
  assert.equal(typeof pending.detachedAt, 'number');
  assert.ok(pending.detachTimer);

  harness.server.cancelDetachedPendingPlanInput('run-1', harness.context);

  await assert.rejects(pendingPromise, { message: 'websocket_closed' });
  assert.equal(getPendingPlanInputs(harness.server).has('run-1'), false);
  assert.equal(harness.server.cancelingRunIds.has('run-1'), true);
  assert.deepEqual(harness.lifecycle, [
    'meta:update',
    'emit:plan_input_requested',
    'set:run-1',
    'meta:update',
    'emit:plan_input_error',
    'cancelContext:session:sess-1',
  ]);
}

async function testCreateCallbackOnRequestUserInputPreservesWireBehavior(): Promise<void> {
  const harness = createHarness();
  const answers: PlanInputAnswer[] = [
    {
      id: 'mode',
      selectedLabel: 'Safe',
      selectedIndex: 1,
      freeText: undefined,
    },
  ];

  harness.server.agent = {
    getConfig: () => createWebServerTestConfig({
      agent: {
        tokenLimit: 1000,
      },
    }),
  };

  const callback = harness.server.createCallback(harness.openSocket, harness.context, 'run-1');
  const pendingPromise = callback.onRequestUserInput(harness.request);

  assert.deepEqual(harness.lifecycle, ['meta:update', 'emit:plan_input_requested', 'set:run-1']);
  assert.deepEqual(harness.emittedMessages, [
    {
      ws: harness.openSocket,
      type: 'plan_input_requested',
      data: {
        runId: 'run-1',
        context: harness.context,
        requestId: harness.request.requestId,
        questions: harness.request.questions,
      },
    },
  ]);

  const pending = getPendingPlanInputs(harness.server).get('run-1') as PendingPlanInputRecord;
  pending.resolve(answers);

  assert.deepEqual(await pendingPromise, answers);
}

async function runAll(): Promise<void> {
  await testClosedSocketStoresDetachedPendingForReconnectGrace();
  await testDuplicatePendingRejectsWithoutEmitOrSet();
  await testSuccessfulRequestEmitsAndStoresPendingRecord();
  await testPendingRejectWiresReturnedPromise();
  await testDetachedPendingRequestCancelsAfterGraceCleanup();
  await testCreateCallbackOnRequestUserInputPreservesWireBehavior();
  console.log('web-request-user-input tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
