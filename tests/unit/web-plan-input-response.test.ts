import * as assert from 'node:assert/strict';
import { WebServer } from '../../src/web/server/WebServer.js';
import type { ContextRef, PlanInputAnswer, PlanInputRequest } from '../../src/types.js';
import { WebSocket } from 'ws';

interface EmittedMessage {
  ws: object;
  type: string;
  data: unknown;
}

interface PlanInputHarness {
  server: any;
  ownerSocket: object;
  otherSocket: object;
  emitted: EmittedMessage[];
  lifecycle: string[];
  metaUpdates: Array<{ context: ContextRef; patch: Record<string, unknown> }>;
  resolvedAnswers: PlanInputAnswer[] | null;
  rejectedError: Error | null;
  request: PlanInputRequest;
  context: ContextRef;
}

class RecordingPendingPlanInputMap extends Map<string, unknown> {
  constructor(
    private readonly lifecycle: string[],
    entries?: ReadonlyArray<readonly [string, unknown]>
  ) {
    super(entries);
  }

  override delete(key: string): boolean {
    this.lifecycle.push(`delete:${key}`);
    return super.delete(key);
  }
}

function createHarness(): PlanInputHarness {
  const emitted: EmittedMessage[] = [];
  const ownerSocket = { socket: 'owner', readyState: WebSocket.OPEN };
  const otherSocket = { socket: 'other', readyState: WebSocket.OPEN };
  const request: PlanInputRequest = {
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
      {
        header: 'Notes',
        id: 'notes',
        question: 'Add notes',
        options: [],
      },
    ],
  };
  const context: ContextRef = {
    scope: 'session',
    namespace: 'sess-1',
  };

  let resolvedAnswers: PlanInputAnswer[] | null = null;
  let rejectedError: Error | null = null;
  const lifecycle: string[] = [];
  const metaUpdates: Array<{ context: ContextRef; patch: Record<string, unknown> }> = [];
  let metaState: Record<string, unknown> = {
    pendingPlanInput: {
      runId: 'run-1',
      requestId: request.requestId,
      requestedAt: '2026-04-22T00:00:00.000Z',
      questions: request.questions,
    },
  };

  const server = Object.create(WebServer.prototype) as any;
  server.pendingPlanInputByRunId = new RecordingPendingPlanInputMap(lifecycle, [
    [
      'run-1',
      {
        runId: 'run-1',
        context,
        ws: ownerSocket,
        request,
        resolve: (answers: PlanInputAnswer[]) => {
          lifecycle.push('resolve');
          resolvedAnswers = answers;
        },
        reject: (error: Error) => {
          lifecycle.push('reject');
          rejectedError = error;
        },
      },
    ],
  ]);
  server.emitToClient = (ws: object, message: Omit<EmittedMessage, 'ws'>) => {
    lifecycle.push(`emit:${message.type}:${ws === ownerSocket ? 'owner' : 'other'}`);
    emitted.push({ ws, ...message });
  };
  server.getContextNamespaceMetaSafe = () => metaState;
  server.updateContextNamespaceMetaSafe = (nextContext: ContextRef, patch: Record<string, unknown>) => {
    lifecycle.push('meta:update');
    metaUpdates.push({ context: nextContext, patch });
    metaState = {
      ...metaState,
      ...patch,
    };
  };

  return {
    server,
    ownerSocket,
    otherSocket,
    emitted,
    lifecycle,
    metaUpdates,
    get resolvedAnswers() {
      return resolvedAnswers;
    },
    get rejectedError() {
      return rejectedError;
    },
    request,
    context,
  };
}

function testMissingRunIdEmitsTransportError(): void {
  const harness = createHarness();
  harness.server.handlePlanInputResponse(harness.ownerSocket, {
    requestId: harness.request.requestId,
    answers: [],
  });

  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: { error: 'runId is required for plan_input_response' },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:owner']);
  assert.equal(harness.server.pendingPlanInputByRunId.size, 1);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError, null);
}

function testUnknownRunIdEmitsTransportError(): void {
  const harness = createHarness();
  harness.server.handlePlanInputResponse(harness.ownerSocket, {
    runId: 'run-missing',
    requestId: harness.request.requestId,
    answers: [],
  });

  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: { runId: 'run-missing', error: 'no pending request_user_input for this run' },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:owner']);
  assert.equal(harness.server.pendingPlanInputByRunId.size, 1);
}

function testResponseFromNewSocketRebindsAndResolvesPendingRequest(): void {
  const harness = createHarness();
  const pending = harness.server.pendingPlanInputByRunId.get('run-1') as {
    detachedAt?: number;
    detachTimer?: ReturnType<typeof setTimeout>;
  };
  const detachTimer = setTimeout(() => undefined, 60000);
  detachTimer.unref?.();
  pending.detachedAt = Date.now();
  pending.detachTimer = detachTimer;

  harness.server.handlePlanInputResponse(harness.otherSocket, {
    runId: 'run-1',
    requestId: harness.request.requestId,
    answers: [
      { id: 'notes', freeText: 'Reconnected socket' },
      { id: 'mode', selectedLabel: 'Safe' },
    ],
  });

  assert.deepEqual(harness.resolvedAnswers, [
    {
      id: 'mode',
      selectedLabel: 'Safe',
      selectedIndex: 1,
      freeText: undefined,
    },
    {
      id: 'notes',
      selectedLabel: '',
      selectedIndex: -1,
      freeText: 'Reconnected socket',
    },
  ]);
  assert.equal(harness.rejectedError, null);
  assert.equal(harness.server.pendingPlanInputByRunId.has('run-1'), false);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.otherSocket,
      type: 'plan_input_resolved',
      data: {
        runId: 'run-1',
        context: harness.context,
        requestId: 'req-1',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['delete:run-1', 'meta:update', 'resolve', 'emit:plan_input_resolved:other']);
}

function testRequestIdMismatchDoesNotResolvePendingRequest(): void {
  const harness = createHarness();
  harness.server.handlePlanInputResponse(harness.ownerSocket, {
    runId: 'run-1',
    requestId: 'wrong-request',
    answers: [],
  });

  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: { runId: 'run-1', error: 'requestId mismatch for plan_input_response' },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:owner']);
  assert.equal(harness.server.pendingPlanInputByRunId.has('run-1'), true);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError, null);
}

function testResolvePlanInputResponseTargetReturnsTrimmedTransportContext(): void {
  const harness = createHarness();
  const target = harness.server.resolvePlanInputResponseTarget(harness.ownerSocket, {
    runId: '  run-1  ',
    requestId: '  req-1  ',
  });

  assert.ok(target);
  assert.equal(target.runId, 'run-1');
  assert.equal(target.requestId, 'req-1');
  assert.equal(target.pending.ws, harness.ownerSocket);
  assert.deepEqual(target.pending.context, harness.context);
  assert.deepEqual(harness.emitted, []);
  assert.deepEqual(harness.lifecycle, []);
}

function testNormalizationFailureIncludesRequestIdAndKeepsPending(): void {
  const harness = createHarness();
  harness.server.handlePlanInputResponse(harness.ownerSocket, {
    runId: 'run-1',
    requestId: harness.request.requestId,
  });

  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: {
        runId: 'run-1',
        requestId: harness.request.requestId,
        error: 'answers must be an array',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:owner', 'meta:update']);
  assert.equal(harness.server.pendingPlanInputByRunId.has('run-1'), true);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError, null);
  assert.equal(
    (harness.metaUpdates[0]?.patch.pendingPlanInput as { lastError?: string }).lastError,
    'answers must be an array'
  );
}

function testResolvePlanInputResponseAnswersEmitsRequestBoundErrorAndKeepsPending(): void {
  const harness = createHarness();
  const target = harness.server.resolvePlanInputResponseTarget(harness.ownerSocket, {
    runId: 'run-1',
    requestId: harness.request.requestId,
  });

  assert.ok(target);
  const answers = harness.server.resolvePlanInputResponseAnswers(
    harness.ownerSocket,
    {
      runId: 'run-1',
      requestId: harness.request.requestId,
    },
    target
  );

  assert.equal(answers, null);
  assert.equal(harness.server.pendingPlanInputByRunId.has('run-1'), true);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError, null);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: {
        runId: 'run-1',
        requestId: harness.request.requestId,
        error: 'answers must be an array',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:owner', 'meta:update']);
}

function testResolvePlanInputResponseAnswersReturnsCanonicalOrderedAnswers(): void {
  const harness = createHarness();
  const target = harness.server.resolvePlanInputResponseTarget(harness.ownerSocket, {
    runId: 'run-1',
    requestId: harness.request.requestId,
  });

  assert.ok(target);
  const answers = harness.server.resolvePlanInputResponseAnswers(
    harness.ownerSocket,
    {
      runId: 'run-1',
      requestId: harness.request.requestId,
      answers: [
        { id: 'notes', freeText: 'Ship after regression' },
        { id: 'mode', selectedLabel: 'Safe' },
      ],
    },
    target
  );

  assert.deepEqual(answers, [
    {
      id: 'mode',
      selectedLabel: 'Safe',
      selectedIndex: 1,
      freeText: undefined,
    },
    {
      id: 'notes',
      selectedLabel: '',
      selectedIndex: -1,
      freeText: 'Ship after regression',
    },
  ]);
  assert.equal(harness.server.pendingPlanInputByRunId.has('run-1'), true);
  assert.deepEqual(harness.emitted, []);
  assert.deepEqual(harness.lifecycle, []);
}

function testCompletePlanInputResponseDeletesResolvesAndEmitsResolved(): void {
  const harness = createHarness();
  const target = harness.server.resolvePlanInputResponseTarget(harness.ownerSocket, {
    runId: 'run-1',
    requestId: harness.request.requestId,
  });

  assert.ok(target);
  harness.server.completePlanInputResponse(target, [
    {
      id: 'mode',
      selectedLabel: 'Safe',
      selectedIndex: 1,
      freeText: undefined,
    },
    {
      id: 'notes',
      selectedLabel: '',
      selectedIndex: -1,
      freeText: 'Ship after regression',
    },
  ]);

  assert.equal(harness.server.pendingPlanInputByRunId.has('run-1'), false);
  assert.equal(harness.rejectedError, null);
  assert.deepEqual(harness.resolvedAnswers, [
    {
      id: 'mode',
      selectedLabel: 'Safe',
      selectedIndex: 1,
      freeText: undefined,
    },
    {
      id: 'notes',
      selectedLabel: '',
      selectedIndex: -1,
      freeText: 'Ship after regression',
    },
  ]);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_resolved',
      data: {
        runId: 'run-1',
        context: harness.context,
        requestId: 'req-1',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['delete:run-1', 'meta:update', 'resolve', 'emit:plan_input_resolved:owner']);
  assert.equal(harness.metaUpdates.length, 1);
  assert.equal(harness.metaUpdates[0]?.patch.pendingPlanInput, undefined);
}

async function testRequestUserInputAndPlanInputResponseSharePendingLifecycle(): Promise<void> {
  const emitted: EmittedMessage[] = [];
  const lifecycle: string[] = [];
  const metaUpdates: Array<{ context: ContextRef; patch: Record<string, unknown> }> = [];
  let metaState: Record<string, unknown> = {};
  const ownerSocket = { socket: 'owner', readyState: WebSocket.OPEN };
  const context: ContextRef = {
    scope: 'session',
    namespace: 'sess-flow',
  };
  const request: PlanInputRequest = {
    requestId: 'req-flow',
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
      {
        header: 'Notes',
        id: 'notes',
        question: 'Add notes',
        options: [],
      },
    ],
  };

  const server = Object.create(WebServer.prototype) as any;
  server.pendingPlanInputByRunId = new RecordingPendingPlanInputMap(lifecycle);
  server.emitToClient = (ws: object, message: Omit<EmittedMessage, 'ws'>) => {
    lifecycle.push(`emit:${message.type}:${ws === ownerSocket ? 'owner' : 'other'}`);
    emitted.push({ ws, ...message });
  };
  server.getContextNamespaceMetaSafe = () => metaState;
  server.updateContextNamespaceMetaSafe = (nextContext: ContextRef, patch: Record<string, unknown>) => {
    lifecycle.push('meta:update');
    metaUpdates.push({ context: nextContext, patch });
    metaState = {
      ...metaState,
      ...patch,
    };
  };

  const answerPromise = server
    .requestUserInputFromSocket(ownerSocket, context, 'run-flow', request, (nextRequest: PlanInputRequest) => {
      lifecycle.push(`requested:${nextRequest.requestId}`);
    })
    .then((answers: PlanInputAnswer[]) => {
      lifecycle.push('promise_resolved');
      return answers;
    });

  assert.equal(server.pendingPlanInputByRunId.has('run-flow'), true);

  server.handlePlanInputResponse(ownerSocket, {
    runId: 'run-flow',
    requestId: 'req-flow',
    answers: [
      { id: 'notes', freeText: 'Shared pending contract' },
      { id: 'mode', selectedLabel: 'Safe' },
    ],
  });

  const answers = await answerPromise;
  assert.deepEqual(answers, [
    {
      id: 'mode',
      selectedLabel: 'Safe',
      selectedIndex: 1,
      freeText: undefined,
    },
    {
      id: 'notes',
      selectedLabel: '',
      selectedIndex: -1,
      freeText: 'Shared pending contract',
    },
  ]);
  assert.equal(server.pendingPlanInputByRunId.has('run-flow'), false);
  assert.deepEqual(emitted, [
    {
      ws: ownerSocket,
      type: 'plan_input_resolved',
      data: {
        runId: 'run-flow',
        context,
        requestId: 'req-flow',
      },
    },
  ]);
  assert.deepEqual(lifecycle, [
    'meta:update',
    'requested:req-flow',
    'delete:run-flow',
    'meta:update',
    'emit:plan_input_resolved:owner',
    'promise_resolved',
  ]);
  assert.equal(
    (metaUpdates[0]?.patch.pendingPlanInput as { runId?: string; requestId?: string }).runId,
    'run-flow'
  );
  assert.equal(metaUpdates[1]?.patch.pendingPlanInput, undefined);
}

function testSuccessResolvesAnswersDeletesPendingAndEmitsResolved(): void {
  const harness = createHarness();
  harness.server.handlePlanInputResponse(harness.ownerSocket, {
    runId: '  run-1  ',
    requestId: '  req-1  ',
    answers: [
      { id: 'notes', freeText: 'Ship after regression' },
      { id: 'mode', selectedLabel: 'Safe' },
    ],
  });

  assert.deepEqual(harness.resolvedAnswers, [
    {
      id: 'mode',
      selectedLabel: 'Safe',
      selectedIndex: 1,
      freeText: undefined,
    },
    {
      id: 'notes',
      selectedLabel: '',
      selectedIndex: -1,
      freeText: 'Ship after regression',
    },
  ]);
  assert.equal(harness.rejectedError, null);
  assert.equal(harness.server.pendingPlanInputByRunId.has('run-1'), false);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_resolved',
      data: {
        runId: 'run-1',
        context: harness.context,
        requestId: 'req-1',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['delete:run-1', 'meta:update', 'resolve', 'emit:plan_input_resolved:owner']);
  assert.equal(harness.metaUpdates.length, 1);
  assert.equal(harness.metaUpdates[0]?.patch.pendingPlanInput, undefined);
}

function testRejectPendingPlanInputDeletesRejectsAndEmitsError(): void {
  const harness = createHarness();
  harness.server.rejectPendingPlanInputByRunId('run-1', 'run_canceled');

  assert.equal(harness.server.pendingPlanInputByRunId.has('run-1'), false);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError?.message, 'run_canceled');
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: {
        runId: 'run-1',
        context: harness.context,
        requestId: harness.request.requestId,
        error: 'run_canceled',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['delete:run-1', 'meta:update', 'reject', 'emit:plan_input_error:owner']);
  assert.equal(harness.metaUpdates.length, 1);
  assert.equal(harness.metaUpdates[0]?.patch.pendingPlanInput, undefined);
}

async function runAll(): Promise<void> {
  testMissingRunIdEmitsTransportError();
  testUnknownRunIdEmitsTransportError();
  testResponseFromNewSocketRebindsAndResolvesPendingRequest();
  testRequestIdMismatchDoesNotResolvePendingRequest();
  testResolvePlanInputResponseTargetReturnsTrimmedTransportContext();
  testNormalizationFailureIncludesRequestIdAndKeepsPending();
  testResolvePlanInputResponseAnswersEmitsRequestBoundErrorAndKeepsPending();
  testResolvePlanInputResponseAnswersReturnsCanonicalOrderedAnswers();
  testCompletePlanInputResponseDeletesResolvesAndEmitsResolved();
  await testRequestUserInputAndPlanInputResponseSharePendingLifecycle();
  testSuccessResolvesAnswersDeletesPendingAndEmitsResolved();
  testRejectPendingPlanInputDeletesRejectsAndEmitsError();
  console.log('web-plan-input-response tests passed');
}

void runAll().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
