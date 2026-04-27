import * as assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { WebServer } from '../../src/web/server/WebServer.js';

type RouteHandler = (req: any, res: any) => Promise<void> | void;

function createFakeApp(): {
  getHandlers: Map<string, RouteHandler>;
  postHandlers: Map<string, RouteHandler>;
  use: (...args: unknown[]) => void;
  get: (route: string, handler: RouteHandler) => void;
  post: (route: string, handler: RouteHandler) => void;
  put: (route: string, handler: RouteHandler) => void;
  patch: (route: string, handler: RouteHandler) => void;
  delete: (route: string, handler: RouteHandler) => void;
} {
  const getHandlers = new Map<string, RouteHandler>();
  const postHandlers = new Map<string, RouteHandler>();
  return {
    getHandlers,
    postHandlers,
    use: () => undefined,
    get: (route, handler) => {
      getHandlers.set(route, handler);
    },
    post: (route, handler) => {
      postHandlers.set(route, handler);
    },
    put: () => undefined,
    patch: () => undefined,
    delete: () => undefined,
  };
}

function createResponseRecorder(): {
  statusCode: number;
  payload: unknown;
  status: (code: number) => any;
  json: (payload: unknown) => any;
} {
  return {
    statusCode: 200,
    payload: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
}

function createHarness(): {
  server: any;
  app: ReturnType<typeof createFakeApp>;
  workspaceDir: string;
  organizeCalls: Array<{ sessionId: string; workspaceDir?: string }>;
  sessionMeta: Record<string, unknown>;
} {
  const app = createFakeApp();
  const organizeCalls: Array<{ sessionId: string; workspaceDir?: string }> = [];
  const workspaceDir = 'D:\\repo\\workspace';
  const memoryPromotionState = {
    lastProcessedContextVersion: 2,
    lastQueuedContextVersion: 3,
    pendingTurnCount: 1,
    lastActivityAt: '2026-04-12T00:00:00.000Z',
    status: 'queued',
  };
  const sessionMessages = [{ role: 'user', content: 'plain display prompt' }];
  const replayMessages = [
    {
      role: 'user',
      content: '[AGENT_PROFILE_REF source=workspace name=workspace path=D:/repo/workspace/AGENTS.md]\n\nplain display prompt',
    },
  ];
  const sessionMeta = {
    workspaceDir,
    memoryPromotionState,
    pendingPlanInput: {
      runId: 'run-pending',
      requestId: 'req-pending',
      requestedAt: '2026-04-12T00:05:00.000Z',
      questions: [
        {
          header: 'Mode',
          id: 'mode',
          question: 'Pick a mode',
          options: [{ label: 'Fast', description: 'Speed first' }],
        },
      ],
    },
    latestContextUtilization: {
      observedAt: '2026-04-12T00:06:00.000Z',
      ratio: 0.42,
      usedChars: 42000,
      limitChars: 100000,
      isWarning: false,
    },
  };
  const server = Object.create(WebServer.prototype) as any;
  server.app = app;
  server.activeRunStatesByContext = new Map([
    [
      'session:sess-runtime',
      {
        runId: 'run-active',
        runFamilyId: 'family-active',
        draftId: 'draft-active',
        context: { scope: 'session', namespace: 'sess-runtime' },
        startedAt: '2026-04-12T00:10:00.000Z',
        llmRuntime: {
          profileId: 'legacy-default',
          provider: 'anthropic',
          model: 'MiniMax-M2.5',
          reasoningPreset: 'off',
        },
      },
    ],
  ]);
  server.pendingPlanInputByRunId = new Map<string, unknown>();
  server.agent = {
    getContextNamespaceMeta: (ref: { scope: string; namespace: string }) =>
      ref.namespace === 'sess-1'
        ? sessionMeta
        : undefined,
    getContextMessages: (_ref: { scope: string; namespace: string }, options?: { preserveAgentProfileRefs?: boolean }) =>
      options?.preserveAgentProfileRefs ? replayMessages : sessionMessages,
    getMemoryPromotionState: (sessionId: string) => (sessionId === 'sess-1' ? memoryPromotionState : null),
    resolveToolsetName: () => 'full-access',
    organizeSessionMemory: async (input: { sessionId: string; workspaceDir?: string }) => {
      organizeCalls.push(input);
      return {
        sessionId: input.sessionId,
        workspaceDir: input.workspaceDir,
        processedTurns: 2,
        appliedCount: 1,
        skippedCount: 1,
        pendingTurnCount: 0,
        processedContextVersion: 3,
        reason: 'manual',
        status: 'ok',
      };
    },
    getConfig: () => ({
      agent: {
        workspaceDir,
      },
    }),
    getInterruptedArtifact: (ref: { scope: string; namespace: string }) =>
      ref.namespace === 'sess-runtime'
        ? {
            artifactId: 'artifact-runtime',
            context: { scope: 'session', namespace: 'sess-runtime' },
            draftId: 'draft-active',
            turnId: 'turn-runtime',
            runId: 'run-active',
            runFamilyId: 'family-active',
            terminalCode: 'error',
            replayCutoffKind: 'checkpoint',
            resumable: true,
            resumeToken: 'secret-resume-token',
            lastSafeStep: 55,
            maxSteps: 100,
            errorSummary: 'read ECONNRESET',
            createdAt: '2026-04-12T00:11:00.000Z',
            updatedAt: '2026-04-12T00:11:00.000Z',
            previewMessages: [],
            sideEffectLedger: [
              {
                id: 'ledger-1',
                observedAt: '2026-04-12T00:11:30.000Z',
                toolName: 'shell_command',
                toolCallId: 'tool-1',
                args: { command: 'type secret.txt' },
                resultSuccess: true,
                resultSummary: 'Patched file',
              },
            ],
          }
        : null,
  };
  server.resolveWorkspaceDirForContext = () => workspaceDir;
  server.automationRoutes = {
    register: () => undefined,
  };
  server.setupRoutes();
  return { server, app, workspaceDir, organizeCalls, sessionMeta };
}

async function testPendingRouteReturnsPromotionState(): Promise<void> {
  const harness = createHarness();
  const handler = harness.app.getHandlers.get('/api/memory/pending');
  assert.ok(handler);
  const res = createResponseRecorder();
  await handler?.({ query: { sessionId: 'sess-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    items: [],
    state: {
      lastProcessedContextVersion: 2,
      lastQueuedContextVersion: 3,
      pendingTurnCount: 1,
      lastActivityAt: '2026-04-12T00:00:00.000Z',
      status: 'queued',
    },
  });
}

async function testOrganizeRouteInvokesAgentCoordinator(): Promise<void> {
  const harness = createHarness();
  const handler = harness.app.postHandlers.get('/api/memory/organize');
  assert.ok(handler);
  const res = createResponseRecorder();
  await handler?.({ body: { sessionId: 'sess-1' }, query: {} }, res);

  assert.deepEqual(harness.organizeCalls, [{ sessionId: 'sess-1', workspaceDir: harness.workspaceDir }]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    success: true,
    sessionId: 'sess-1',
    workspaceDir: harness.workspaceDir,
    processedTurns: 2,
    appliedCount: 1,
    skippedCount: 1,
    pendingTurnCount: 0,
    processedContextVersion: 3,
    reason: 'manual',
    status: 'ok',
  });
}

async function testOrganizeRouteRejectsMissingOrUnknownSession(): Promise<void> {
  const harness = createHarness();
  const handler = harness.app.postHandlers.get('/api/memory/organize');
  assert.ok(handler);

  const missingRes = createResponseRecorder();
  await handler?.({ body: {}, query: {} }, missingRes);
  assert.equal(missingRes.statusCode, 400);
  assert.deepEqual(missingRes.payload, { error: 'sessionId is required' });

  const unknownRes = createResponseRecorder();
  await handler?.({ body: { sessionId: 'missing' }, query: {} }, unknownRes);
  assert.equal(unknownRes.statusCode, 404);
  assert.deepEqual(unknownRes.payload, { error: 'Session not found' });
}

async function testSessionRouteHonorsPreserveAgentProfileRefsQuery(): Promise<void> {
  const harness = createHarness();
  const handler = harness.app.getHandlers.get('/api/sessions/:id');
  assert.ok(handler);

  const defaultRes = createResponseRecorder();
  await handler?.({ params: { id: 'sess-1' }, query: {} }, defaultRes);
  assert.equal(defaultRes.statusCode, 200);
  assert.deepEqual(defaultRes.payload, {
    id: 'sess-1',
    name: 'sess-1',
    workspaceDir: harness.workspaceDir,
    toolsetName: 'full-access',
    createdAt: undefined,
    updatedAt: undefined,
    automationRun: null,
    completionMarkerStats: null,
    llmSelection: {
      profileId: 'legacy-default',
      model: 'MiniMax-M2.5',
      reasoningPreset: 'off',
      providerOptions: undefined,
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
    activeRun: null,
    pendingResume: false,
    interruptedArtifact: null,
    pendingPlanInput: null,
    contextUtilization: {
      observedAt: '2026-04-12T00:06:00.000Z',
      ratio: 0.42,
      usedChars: 42000,
      limitChars: 100000,
      isWarning: false,
    },
    memoryPromotionState: {
      lastProcessedContextVersion: 2,
      lastQueuedContextVersion: 3,
      pendingTurnCount: 1,
      lastActivityAt: '2026-04-12T00:00:00.000Z',
      status: 'queued',
    },
    messages: [{ role: 'user', content: 'plain display prompt' }],
  });

  const replayRes = createResponseRecorder();
  await handler?.({ params: { id: 'sess-1' }, query: { preserveAgentProfileRefs: 'true' } }, replayRes);
  assert.equal(replayRes.statusCode, 200);
  assert.match(
    String((replayRes.payload as { messages: Array<{ content: string }> }).messages[0]?.content ?? ''),
    /^\[AGENT_PROFILE_REF source=workspace name=workspace path=D:\/repo\/workspace\/AGENTS\.md\]/
  );
}

async function testSessionRouteOnlyReturnsLivePendingPlanInput(): Promise<void> {
  const harness = createHarness();
  const handler = harness.app.getHandlers.get('/api/sessions/:id');
  assert.ok(handler);

  const noLivePendingRes = createResponseRecorder();
  await handler?.({ params: { id: 'sess-1' }, query: {} }, noLivePendingRes);
  assert.equal(noLivePendingRes.statusCode, 200);
  assert.equal((noLivePendingRes.payload as { pendingPlanInput: unknown }).pendingPlanInput, null);

  harness.server.pendingPlanInputByRunId.set('run-pending', {
    runId: 'run-pending',
    context: { scope: 'session', namespace: 'sess-1' },
    ws: { readyState: WebSocket.OPEN },
    request: { requestId: 'req-pending' },
  });

  const livePendingRes = createResponseRecorder();
  await handler?.({ params: { id: 'sess-1' }, query: {} }, livePendingRes);
  assert.deepEqual(
    (livePendingRes.payload as { pendingPlanInput: unknown }).pendingPlanInput,
    harness.sessionMeta.pendingPlanInput
  );

  harness.server.pendingPlanInputByRunId.set('run-pending', {
    runId: 'run-pending',
    context: { scope: 'session', namespace: 'sess-1' },
    ws: { readyState: WebSocket.CLOSED },
    request: { requestId: 'req-pending' },
  });

  const detachedPendingRes = createResponseRecorder();
  await handler?.({ params: { id: 'sess-1' }, query: {} }, detachedPendingRes);
  assert.deepEqual(
    (detachedPendingRes.payload as { pendingPlanInput: unknown }).pendingPlanInput,
    harness.sessionMeta.pendingPlanInput
  );
}

async function testSessionRouteFallsBackToRuntimeStateAndSanitizesArtifact(): Promise<void> {
  const harness = createHarness();
  const handler = harness.app.getHandlers.get('/api/sessions/:id');
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler?.({ params: { id: 'sess-runtime' }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    id: 'sess-runtime',
    name: 'sess-runtime',
    workspaceDir: harness.workspaceDir,
    toolsetName: 'full-access',
    createdAt: '2026-04-12T00:10:00.000Z',
    updatedAt: '2026-04-12T00:11:00.000Z',
    automationRun: null,
    completionMarkerStats: null,
    llmSelection: {
      profileId: 'legacy-default',
      model: 'MiniMax-M2.5',
      reasoningPreset: 'off',
      providerOptions: undefined,
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
    activeRun: {
      runId: 'run-active',
      runFamilyId: 'family-active',
      draftId: 'draft-active',
      context: { scope: 'session', namespace: 'sess-runtime' },
      startedAt: '2026-04-12T00:10:00.000Z',
      llmRuntime: {
        profileId: 'legacy-default',
        provider: 'anthropic',
        model: 'MiniMax-M2.5',
        reasoningPreset: 'off',
      },
    },
    pendingResume: false,
    interruptedArtifact: {
      artifactId: 'artifact-runtime',
      context: { scope: 'session', namespace: 'sess-runtime' },
      draftId: 'draft-active',
      turnId: 'turn-runtime',
      runId: 'run-active',
      runFamilyId: 'family-active',
      terminalCode: 'error',
      replayCutoffKind: 'checkpoint',
      resumable: true,
      lastSafeStep: 55,
      maxSteps: 100,
      errorSummary: 'read ECONNRESET',
      createdAt: '2026-04-12T00:11:00.000Z',
      updatedAt: '2026-04-12T00:11:00.000Z',
      previewMessages: [],
      sideEffectLedger: [
        {
          id: 'ledger-1',
          observedAt: '2026-04-12T00:11:30.000Z',
          toolName: 'shell_command',
          toolCallId: 'tool-1',
          resultSuccess: true,
          resultSummary: 'Patched file',
        },
      ],
    },
    pendingPlanInput: null,
    contextUtilization: null,
    memoryPromotionState: null,
    messages: [{ role: 'user', content: 'plain display prompt' }],
  });
}

async function runAll(): Promise<void> {
  await testPendingRouteReturnsPromotionState();
  await testOrganizeRouteInvokesAgentCoordinator();
  await testOrganizeRouteRejectsMissingOrUnknownSession();
  await testSessionRouteHonorsPreserveAgentProfileRefsQuery();
  await testSessionRouteOnlyReturnsLivePendingPlanInput();
  await testSessionRouteFallsBackToRuntimeStateAndSanitizesArtifact();
  console.log('web-memory-organize-route tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
