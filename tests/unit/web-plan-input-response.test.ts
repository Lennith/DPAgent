import * as assert from 'node:assert/strict';
import type { ContextRef, PlanInputAnswer, PlanInputRequest } from '../../src/types.js';
import { WebSocket } from 'ws';
import {
  attachEmitCapture,
  createOpenSocket,
  createWebServerDouble,
  getPendingPlanInputs,
  RecordingMap,
  replacePendingPlanInputs,
  type CapturedWebMessage,
} from './helpers/web-server-harness.js';

const DEFAULT_RUN_ID = 'run-1';
const DEFAULT_REQUEST_ID = 'req-1';

interface PlanInputHarness {
  server: any;
  ownerSocket: object;
  otherSocket: object;
  emitted: CapturedWebMessage[];
  lifecycle: string[];
  metaUpdates: Array<{ context: ContextRef; patch: Record<string, unknown> }>;
  resolvedAnswers: PlanInputAnswer[] | null;
  rejectedError: Error | null;
  request: PlanInputRequest;
  context: ContextRef;
}

function createHarness(): PlanInputHarness {
  const ownerSocket = createOpenSocket('owner');
  const otherSocket = createOpenSocket('other');
  const request: PlanInputRequest = {
    requestId: DEFAULT_REQUEST_ID,
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
      runId: DEFAULT_RUN_ID,
      requestId: request.requestId,
      requestedAt: '2026-04-22T00:00:00.000Z',
      questions: request.questions,
    },
  };

  const server = createWebServerDouble();
  replacePendingPlanInputs(server, new RecordingMap<string, any>(lifecycle, [
    [
      DEFAULT_RUN_ID,
      {
        runId: DEFAULT_RUN_ID,
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
  ]));
  const { emitted } = attachEmitCapture(server, {
    lifecycle,
    labelForSocket: (ws) => (ws === ownerSocket ? 'owner' : 'other'),
  });
  server.getContextNamespaceMetaSafe = () => metaState;
  server.updateContextNamespaceMetaSafe = (nextContext: ContextRef, patch: Record<string, unknown>) => {
    lifecycle.push('meta:update');
    metaUpdates.push({ context: nextContext, patch });
    metaState = {
      ...metaState,
      ...patch,
    };
  };
  server.isObserveOnlyActiveRun = () => false;

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

function getDefaultPendingPlanInput<T>(harness: PlanInputHarness): T {
  return getPendingPlanInputs(harness.server).get(DEFAULT_RUN_ID) as T;
}

function hasDefaultPendingPlanInput(harness: PlanInputHarness): boolean {
  return getPendingPlanInputs(harness.server).has(DEFAULT_RUN_ID);
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
  assert.equal(getPendingPlanInputs(harness.server).size, 1);
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
  assert.equal(getPendingPlanInputs(harness.server).size, 1);
}

function testResponseFromNewSocketRebindsAndResolvesPendingRequest(): void {
  const harness = createHarness();
  const pending = getDefaultPendingPlanInput<{
    detachedAt?: number;
    detachTimer?: ReturnType<typeof setTimeout>;
  }>(harness);
  const detachTimer = setTimeout(() => undefined, 60000);
  detachTimer.unref?.();
  pending.detachedAt = Date.now();
  pending.detachTimer = detachTimer;

  harness.server.handlePlanInputResponse(harness.otherSocket, {
    runId: DEFAULT_RUN_ID,
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
  assert.equal(hasDefaultPendingPlanInput(harness), false);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.otherSocket,
      type: 'plan_input_resolved',
      data: {
        runId: DEFAULT_RUN_ID,
        context: harness.context,
        requestId: DEFAULT_REQUEST_ID,
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, [`delete:${DEFAULT_RUN_ID}`, 'meta:update', 'resolve', 'emit:plan_input_resolved:other']);
}

function testResponseFromSecondLiveSocketIsRejectedWithoutRebinding(): void {
  const harness = createHarness();
  const pending = getDefaultPendingPlanInput<{
    ws: object;
  }>(harness);

  harness.server.handlePlanInputResponse(harness.otherSocket, {
    runId: DEFAULT_RUN_ID,
    requestId: harness.request.requestId,
    answers: [
      { id: 'notes', freeText: 'Wrong socket' },
      { id: 'mode', selectedLabel: 'Safe' },
    ],
  });

  assert.equal(pending.ws, harness.ownerSocket);
  assert.equal(hasDefaultPendingPlanInput(harness), true);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError, null);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.otherSocket,
      type: 'plan_input_error',
      data: {
        runId: DEFAULT_RUN_ID,
        requestId: DEFAULT_REQUEST_ID,
        error: 'plan_input_response must come from the pending request owner socket',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:other']);
}

function testResponseFromSecondSocketIsRejectedWhenOwnerClosedButNotDetached(): void {
  const harness = createHarness();
  const pending = getDefaultPendingPlanInput<{
    ws: { readyState: number };
    detachedAt?: number;
    detachTimer?: ReturnType<typeof setTimeout>;
  }>(harness);
  pending.ws.readyState = WebSocket.CLOSED;

  harness.server.handlePlanInputResponse(harness.otherSocket, {
    runId: DEFAULT_RUN_ID,
    requestId: harness.request.requestId,
    answers: [
      { id: 'notes', freeText: 'Racy socket' },
      { id: 'mode', selectedLabel: 'Safe' },
    ],
  });

  assert.equal(pending.ws, harness.ownerSocket);
  assert.equal(pending.detachedAt, undefined);
  assert.equal(pending.detachTimer, undefined);
  assert.equal(hasDefaultPendingPlanInput(harness), true);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError, null);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.otherSocket,
      type: 'plan_input_error',
      data: {
        runId: DEFAULT_RUN_ID,
        requestId: DEFAULT_REQUEST_ID,
        error: 'plan_input_response must come from the pending request owner socket',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:other']);
}

function testInvalidResponseFromNewSocketDoesNotRebindPendingSocket(): void {
  const harness = createHarness();
  const pending = getDefaultPendingPlanInput<{
    ws: object;
    detachedAt?: number;
    detachTimer?: ReturnType<typeof setTimeout>;
  }>(harness);
  const detachTimer = setTimeout(() => undefined, 60000);
  detachTimer.unref?.();
  pending.detachedAt = Date.now();
  pending.detachTimer = detachTimer;

  harness.server.handlePlanInputResponse(harness.otherSocket, {
    runId: DEFAULT_RUN_ID,
    requestId: harness.request.requestId,
    answers: [{ id: 'mode', selectedIndex: 9 }],
  });

  assert.equal(pending.ws, harness.ownerSocket);
  assert.equal(pending.detachTimer, detachTimer);
  assert.equal(hasDefaultPendingPlanInput(harness), true);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError, null);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.otherSocket,
      type: 'plan_input_error',
      data: {
        runId: DEFAULT_RUN_ID,
        context: harness.context,
        requestId: DEFAULT_REQUEST_ID,
        error: 'answers[0] must select an option or provide freeText',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:other', 'meta:update']);
  assert.equal(
    (harness.metaUpdates[0]?.patch.pendingPlanInput as { lastError?: string }).lastError,
    'answers[0] must select an option or provide freeText'
  );
}

function testObserveOnlyPlanInputResponseIsRejected(): void {
  const harness = createHarness();
  harness.server.isObserveOnlyActiveRun = () => true;

  harness.server.handlePlanInputResponse(harness.ownerSocket, {
    runId: DEFAULT_RUN_ID,
    requestId: harness.request.requestId,
    answers: [
      { id: 'notes', freeText: 'CLI plan can be approved from Web' },
      { id: 'mode', selectedLabel: 'Safe' },
    ],
  });

  assert.equal(hasDefaultPendingPlanInput(harness), true);
  assert.equal(harness.rejectedError, null);
  assert.equal(harness.resolvedAnswers, null);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: {
        runId: DEFAULT_RUN_ID,
        context: harness.context,
        requestId: DEFAULT_REQUEST_ID,
        error: 'observe_only',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:owner']);
  assert.deepEqual(harness.metaUpdates, []);
}

function testRequestIdMismatchDoesNotResolvePendingRequest(): void {
  const harness = createHarness();
  harness.server.handlePlanInputResponse(harness.ownerSocket, {
    runId: DEFAULT_RUN_ID,
    requestId: 'wrong-request',
    answers: [],
  });

  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: { runId: DEFAULT_RUN_ID, error: 'requestId mismatch for plan_input_response' },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:owner']);
  assert.equal(hasDefaultPendingPlanInput(harness), true);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError, null);
}

function testResolvePlanInputResponseTargetReturnsTrimmedTransportContext(): void {
  const harness = createHarness();
  const target = harness.server.resolvePlanInputResponseTarget(harness.ownerSocket, {
    runId: `  ${DEFAULT_RUN_ID}  `,
    requestId: `  ${DEFAULT_REQUEST_ID}  `,
  });

  assert.ok(target);
  assert.equal(target.runId, DEFAULT_RUN_ID);
  assert.equal(target.requestId, DEFAULT_REQUEST_ID);
  assert.equal(target.pending.ws, harness.ownerSocket);
  assert.deepEqual(target.pending.context, harness.context);
  assert.deepEqual(harness.emitted, []);
  assert.deepEqual(harness.lifecycle, []);
}

function testNormalizationFailureIncludesRequestIdAndKeepsPending(): void {
  const harness = createHarness();
  harness.server.handlePlanInputResponse(harness.ownerSocket, {
    runId: DEFAULT_RUN_ID,
    requestId: harness.request.requestId,
  });

  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: {
        runId: DEFAULT_RUN_ID,
        context: harness.context,
        requestId: harness.request.requestId,
        error: 'answers must be an array',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, ['emit:plan_input_error:owner', 'meta:update']);
  assert.equal(hasDefaultPendingPlanInput(harness), true);
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
    runId: DEFAULT_RUN_ID,
    requestId: harness.request.requestId,
  });

  assert.ok(target);
  const answers = harness.server.resolvePlanInputResponseAnswers(
    harness.ownerSocket,
    {
      runId: DEFAULT_RUN_ID,
      requestId: harness.request.requestId,
    },
    target
  );

  assert.equal(answers, null);
  assert.equal(hasDefaultPendingPlanInput(harness), true);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError, null);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: {
        runId: DEFAULT_RUN_ID,
        context: harness.context,
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
    runId: DEFAULT_RUN_ID,
    requestId: harness.request.requestId,
  });

  assert.ok(target);
  const answers = harness.server.resolvePlanInputResponseAnswers(
    harness.ownerSocket,
    {
      runId: DEFAULT_RUN_ID,
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
  assert.equal(hasDefaultPendingPlanInput(harness), true);
  assert.deepEqual(harness.emitted, []);
  assert.deepEqual(harness.lifecycle, []);
}

function testCompletePlanInputResponseDeletesResolvesAndEmitsResolved(): void {
  const harness = createHarness();
  const target = harness.server.resolvePlanInputResponseTarget(harness.ownerSocket, {
    runId: DEFAULT_RUN_ID,
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

  assert.equal(hasDefaultPendingPlanInput(harness), false);
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
        runId: DEFAULT_RUN_ID,
        context: harness.context,
        requestId: DEFAULT_REQUEST_ID,
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, [`delete:${DEFAULT_RUN_ID}`, 'meta:update', 'resolve', 'emit:plan_input_resolved:owner']);
  assert.equal(harness.metaUpdates.length, 1);
  assert.equal(harness.metaUpdates[0]?.patch.pendingPlanInput, undefined);
}

async function testRequestUserInputAndPlanInputResponseSharePendingLifecycle(): Promise<void> {
  const lifecycle: string[] = [];
  const metaUpdates: Array<{ context: ContextRef; patch: Record<string, unknown> }> = [];
  let metaState: Record<string, unknown> = {};
  const ownerSocket = createOpenSocket('owner');
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

  const server = createWebServerDouble();
  replacePendingPlanInputs(server, new RecordingMap<string, any>(lifecycle));
  const { emitted } = attachEmitCapture(server, {
    lifecycle,
    labelForSocket: (ws) => (ws === ownerSocket ? 'owner' : 'other'),
  });
  server.getContextNamespaceMetaSafe = () => metaState;
  server.updateContextNamespaceMetaSafe = (nextContext: ContextRef, patch: Record<string, unknown>) => {
    lifecycle.push('meta:update');
    metaUpdates.push({ context: nextContext, patch });
    metaState = {
      ...metaState,
      ...patch,
    };
  };
  server.isObserveOnlyActiveRun = () => false;

  const answerPromise = server
    .requestUserInputFromSocket(ownerSocket, context, 'run-flow', request, (nextRequest: PlanInputRequest) => {
      lifecycle.push(`requested:${nextRequest.requestId}`);
    })
    .then((answers: PlanInputAnswer[]) => {
      lifecycle.push('promise_resolved');
      return answers;
    });

  assert.equal(getPendingPlanInputs(server).has('run-flow'), true);

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
  assert.equal(getPendingPlanInputs(server).has('run-flow'), false);
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
    runId: `  ${DEFAULT_RUN_ID}  `,
    requestId: `  ${DEFAULT_REQUEST_ID}  `,
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
  assert.equal(hasDefaultPendingPlanInput(harness), false);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_resolved',
      data: {
        runId: DEFAULT_RUN_ID,
        context: harness.context,
        requestId: DEFAULT_REQUEST_ID,
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, [`delete:${DEFAULT_RUN_ID}`, 'meta:update', 'resolve', 'emit:plan_input_resolved:owner']);
  assert.equal(harness.metaUpdates.length, 1);
  assert.equal(harness.metaUpdates[0]?.patch.pendingPlanInput, undefined);
}

function testRejectPendingPlanInputDeletesRejectsAndEmitsError(): void {
  const harness = createHarness();
  harness.server.rejectPendingPlanInputByRunId(DEFAULT_RUN_ID, 'run_canceled');

  assert.equal(hasDefaultPendingPlanInput(harness), false);
  assert.equal(harness.resolvedAnswers, null);
  assert.equal(harness.rejectedError?.message, 'run_canceled');
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.ownerSocket,
      type: 'plan_input_error',
      data: {
        runId: DEFAULT_RUN_ID,
        context: harness.context,
        requestId: harness.request.requestId,
        error: 'run_canceled',
      },
    },
  ]);
  assert.deepEqual(harness.lifecycle, [`delete:${DEFAULT_RUN_ID}`, 'meta:update', 'reject', 'emit:plan_input_error:owner']);
  assert.equal(harness.metaUpdates.length, 1);
  assert.equal(harness.metaUpdates[0]?.patch.pendingPlanInput, undefined);
}

async function runAll(): Promise<void> {
  testMissingRunIdEmitsTransportError();
  testUnknownRunIdEmitsTransportError();
  testResponseFromNewSocketRebindsAndResolvesPendingRequest();
  testResponseFromSecondLiveSocketIsRejectedWithoutRebinding();
  testResponseFromSecondSocketIsRejectedWhenOwnerClosedButNotDetached();
  testInvalidResponseFromNewSocketDoesNotRebindPendingSocket();
  testObserveOnlyPlanInputResponseIsRejected();
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
