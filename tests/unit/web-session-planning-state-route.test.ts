import * as assert from 'node:assert/strict';
import { resolveShareUrlForRequest } from '../../src/web/server/session-share-url-resolver.js';
import { registerSessionRoutes } from '../../src/web/server/web-server-session-routes.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function createProtocolState(hasUnfinished: boolean) {
  return hasUnfinished
    ? {
        items: [{ id: 'todo-1', status: 'pending' }],
        unfinishedItems: [{ id: 'todo-1', status: 'pending' }],
        activeItem: null,
        blockedItem: null,
        pendingItems: [{ id: 'todo-1', status: 'pending' }],
        completedItems: [],
        hasUnfinished: true,
        allCompleted: false,
      }
    : {
        items: [{ id: 'todo-1', status: 'completed' }],
        unfinishedItems: [],
        activeItem: null,
        blockedItem: null,
        pendingItems: [],
        completedItems: [{ id: 'todo-1', status: 'completed' }],
        hasUnfinished: false,
        allCompleted: true,
      };
}

function createDeps(options: { fullAccess?: boolean; canAccessSession?: boolean } = {}) {
  const routeHarness = createRouteAppHarness();
  let meta: Record<string, any> = {
    name: 'Planning session',
    workspaceDir: 'D:\\repo',
    planningState: {
      state: 'plan_drafting',
      pendingPlanId: 'plan-1',
      updatedAt: '2026-05-01T00:00:00.000Z',
    },
    projection: { version: 1 },
  };
  let todoState: Record<string, any> = createProtocolState(false);
  let activeRuns: Record<string, any>[] = [];
  const cancelContexts: unknown[] = [];
  const validShare = {
    sessionId: 'sess-shared',
    tokenHash: 'token-hash',
    createdAt: '2026-05-01T00:00:00.000Z',
    expiresAt: '2026-05-02T00:00:00.000Z',
    version: 1,
  };

  const deps = {
    app: {
      get: routeHarness.app.get,
      post: routeHarness.app.post,
      put: routeHarness.app.put,
      patch: routeHarness.app.patch,
      delete: routeHarness.app.delete,
    },
    agent: {
      getConfig: () => ({
        llmProfiles: {
          defaultProfileId: 'default',
          profiles: [],
        },
      }),
      getContextManager: () => ({
        listNamespaces: () => [
          {
            namespace: 'sess-plan',
            ...meta,
          },
        ],
      }),
      getContextNamespaceMeta: () => meta,
      resolveToolsetName: () => 'default',
      getContextMessages: () => [],
      getContextWebMessages: () => [
        {
          role: 'user',
          content: 'created at event time',
          createdAt: '2026-05-10T02:00:00.000Z',
        },
      ],
    },
    contextServices: {
      getContextNamespaceMetaSafe: () => meta,
      getPendingPlanInputView: () => null,
      getActiveRunState: (context: { scope: string; namespace: string }) =>
        activeRuns.find((run) => run.context.scope === context.scope && run.context.namespace === context.namespace) ?? null,
      listActiveSessionRunStates: () => activeRuns,
      getInteractionStateForContext: (context: { scope: string; namespace: string }) =>
        activeRuns.find((run) => run.context.scope === context.scope && run.context.namespace === context.namespace)
          ?.interactionState ?? { mode: 'normal' },
      getInterruptedArtifact: () => null,
      resolveWorkspaceDirForContext: () => 'D:\\repo',
      updateContextNamespaceMetaSafe: (_context: unknown, patch: Record<string, unknown>) => {
        meta = {
          ...meta,
          ...patch,
        };
      },
      resolveAgentForContext: () => ({
        cancelContext: (context: unknown) => {
          cancelContexts.push(context);
          return 1;
        },
      }),
      cleanupSessionRuntime: async () => undefined,
    },
    todoServices: {
      getSessionTodoProtocolState: () => todoState,
      ensureTodoDrivenAutoLoop: () => undefined,
    },
    automationRoutes: {
      register: () => undefined,
    },
    shareServices: {
      resolveShareToken: (token: string) => (token === 'valid-token' ? validShare : null),
    },
    accessServices: {
      getSharedAccessSessionId: () => null,
      canAccessSession: () => options.canAccessSession !== false,
      hasFullAccess: () => options.fullAccess !== false,
    },
  };
  registerSessionRoutes(deps as any);
  return {
    routes: routeHarness.getRouteList,
    postRoutes: routeHarness.postRouteList,
    putRoutes: routeHarness.putRouteList,
    patchRoutes: routeHarness.patchRouteList,
    deleteRoutes: routeHarness.deleteRouteList,
    cancelContexts,
    setPlanningState(state: Record<string, unknown>) {
      meta = {
        ...meta,
        planningState: state,
      };
    },
    setAutoLoopConfig(config: Record<string, unknown>) {
      meta = {
        ...meta,
        autoLoopConfig: config,
      };
    },
    setTodoState(next: Record<string, unknown>) {
      todoState = next;
    },
    setActiveRuns(next: Record<string, any>[]) {
      activeRuns = next;
    },
    get meta() {
      return meta;
    },
  };
}

function testShareRoutesRejectInvalidTokenConsistently(): void {
  const { routes } = createDeps();
  for (const path of [
    '/api/share/:token',
    '/api/share/:token/settings',
    '/api/share/:token/text-history',
  ]) {
    const route = routes.find((item) => item.path === path);
    assert.ok(route, `missing route ${path}`);
    const res = createResponseRecorder();
    route.handler({ params: { token: 'expired-token' }, query: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      error: 'Share link is invalid or expired',
      code: 'SHARE_TOKEN_INVALID',
    });
  }
}

function testShareRoutesResolveValidTokenForShareAndTextHistory(): void {
  const { routes } = createDeps();
  const shareRoute = routes.find((item) => item.path === '/api/share/:token');
  const textHistoryRoute = routes.find((item) => item.path === '/api/share/:token/text-history');
  assert.ok(shareRoute);
  assert.ok(textHistoryRoute);

  const shareRes = createResponseRecorder();
  shareRoute.handler({ params: { token: 'valid-token' }, query: {} }, shareRes);
  assert.equal(shareRes.statusCode, 200);
  assert.deepEqual(shareRes.body, {
    mode: 'shared_ls',
    sessionId: 'sess-shared',
    expiresAt: '2026-05-02T00:00:00.000Z',
  });

  const textHistoryRes = createResponseRecorder();
  textHistoryRoute.handler({ params: { token: 'valid-token' }, query: { turns: '2' } }, textHistoryRes);
  assert.equal(textHistoryRes.statusCode, 200);
  assert.equal((textHistoryRes.body as { sessionId: string }).sessionId, 'sess-shared');
  assert.equal((textHistoryRes.body as { turns: number }).turns, 2);
}

function assertShareScopeForbidden(res: ReturnType<typeof createResponseRecorder>, error: string): void {
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error, code: 'SHARE_SCOPE_FORBIDDEN' });
}

function testFullAccessRoutesRejectShareOnlyAccess(): void {
  const harness = createDeps({ fullAccess: false });

  const renameRoute = harness.putRoutes.find((item) => item.path === '/api/sessions/:id');
  assert.ok(renameRoute);
  const renameRes = createResponseRecorder();
  renameRoute.handler({ params: { id: 'sess-plan' }, body: { name: 'Renamed' } }, renameRes);
  assertShareScopeForbidden(renameRes, 'Share link cannot rename sessions');

  const draftExitRoute = harness.postRoutes.find((item) => item.path === '/api/sessions/:id/plan-draft/exit');
  assert.ok(draftExitRoute);
  const draftExitRes = createResponseRecorder();
  draftExitRoute.handler({ params: { id: 'sess-plan' }, body: { reason: 'blocked' } }, draftExitRes);
  assertShareScopeForbidden(draftExitRes, 'Share link cannot change plan state');
  assert.equal(harness.meta.planningState.state, 'plan_drafting');

  harness.setPlanningState({
    state: 'plan_executing',
    activeExecutionPlanId: 'plan-active',
    updatedAt: '2026-05-01T00:00:00.000Z',
  });
  const executionExitRoute = harness.postRoutes.find((item) => item.path === '/api/sessions/:id/plan-execution/exit');
  assert.ok(executionExitRoute);
  const executionExitRes = createResponseRecorder();
  executionExitRoute.handler({ params: { id: 'sess-plan' }, body: { mode: 'force' } }, executionExitRes);
  assertShareScopeForbidden(executionExitRes, 'Share link cannot change plan state');
  assert.equal(harness.meta.planningState.state, 'plan_executing');

  for (const [routes, method] of [
    [harness.routes, 'GET'],
    [harness.postRoutes, 'POST'],
    [harness.deleteRoutes, 'DELETE'],
  ] as const) {
    const route = routes.find((item) => item.path === '/api/sessions/:id/share');
    assert.ok(route, `missing ${method} /api/sessions/:id/share`);
    const res = createResponseRecorder();
    route.handler({ params: { id: 'sess-plan' }, body: {}, query: {} }, res);
    assertShareScopeForbidden(res, 'Share link cannot manage shares');
  }
}

function testSessionScopedRoutesRejectShareScopeAccess(): void {
  const harness = createDeps({ canAccessSession: false });
  const error = 'Share link cannot access this session';

  const detailRoute = harness.routes.find((item) => item.path === '/api/sessions/:id');
  assert.ok(detailRoute);
  const detailRes = createResponseRecorder();
  detailRoute.handler({ params: { id: 'sess-plan' }, query: {} }, detailRes);
  assertShareScopeForbidden(detailRes, error);

  const getLlmSelectionRoute = harness.routes.find((item) => item.path === '/api/sessions/:id/llm-selection');
  assert.ok(getLlmSelectionRoute);
  const getLlmSelectionRes = createResponseRecorder();
  getLlmSelectionRoute.handler({ params: { id: 'sess-plan' }, query: {} }, getLlmSelectionRes);
  assertShareScopeForbidden(getLlmSelectionRes, error);

  const patchLlmSelectionRoute = harness.patchRoutes.find((item) => item.path === '/api/sessions/:id/llm-selection');
  assert.ok(patchLlmSelectionRoute);
  const beforeSelection = harness.meta.llmSelection;
  const patchLlmSelectionRes = createResponseRecorder();
  patchLlmSelectionRoute.handler(
    { params: { id: 'sess-plan' }, body: { profileId: 'other-profile' } },
    patchLlmSelectionRes
  );
  assertShareScopeForbidden(patchLlmSelectionRes, error);
  assert.equal(harness.meta.llmSelection, beforeSelection);
}

function testSessionListReturnsPlanningState(): void {
  const { routes } = createDeps();
  const route = routes.find((item) => item.path === '/api/sessions');
  assert.ok(route);
  const res = createResponseRecorder();
  route.handler({ query: {} }, res);
  const body = res.body as { sessions: Array<{ planningState?: { state: string; pendingPlanId?: string } }> };
  assert.equal(body.sessions[0].planningState?.state, 'plan_drafting');
  assert.equal(body.sessions[0].planningState?.pendingPlanId, 'plan-1');
}

function testSessionDetailReturnsPlanningState(): void {
  const { routes } = createDeps();
  const route = routes.find((item) => item.path === '/api/sessions/:id');
  assert.ok(route);
  const res = createResponseRecorder();
  route.handler({ params: { id: 'sess-plan' }, query: {} }, res);
  const body = res.body as { planningState?: { state: string; pendingPlanId?: string } };
  assert.equal(body.planningState?.state, 'plan_drafting');
  assert.equal(body.planningState?.pendingPlanId, 'plan-1');
}

function testSessionDetailReturnsMessageCreatedAt(): void {
  const { routes } = createDeps();
  const route = routes.find((item) => item.path === '/api/sessions/:id');
  assert.ok(route);
  const res = createResponseRecorder();
  route.handler({ params: { id: 'sess-plan' }, query: {} }, res);
  const body = res.body as { messages?: Array<{ createdAt?: string }> };
  assert.equal(body.messages?.[0]?.createdAt, '2026-05-10T02:00:00.000Z');
}

function testShareUrlUsesConfiguredPublicBaseUrlFirst(): void {
  const result = resolveShareUrlForRequest({
    configuredPublicBaseUrl: 'https://dpagent.example.test/base/',
    requestHost: '127.0.0.1:53721',
    protocol: 'http',
    url: '/dpagent-share/token-1',
    localIpv4Addresses: ['192.168.1.33'],
  });

  assert.equal(result.url, 'https://dpagent.example.test/base/dpagent-share/token-1');
  assert.equal(result.diagnostics.reason, 'config');
}

function testShareUrlReplacesLoopbackWithLanAddress(): void {
  const result = resolveShareUrlForRequest({
    requestHost: 'localhost:53721',
    protocol: 'http',
    url: '/dpagent-share/token-1',
    localIpv4Addresses: ['192.168.1.33'],
  });

  assert.equal(result.url, 'http://192.168.1.33:53721/dpagent-share/token-1');
  assert.equal(result.diagnostics.reason, 'lan_fallback');
}

function testShareUrlKeepsTrustedLanHost(): void {
  const result = resolveShareUrlForRequest({
    requestHost: '192.168.1.33:53721',
    protocol: 'http',
    url: '/dpagent-share/token-1',
    localIpv4Addresses: ['192.168.1.33'],
  });

  assert.equal(result.url, 'http://192.168.1.33:53721/dpagent-share/token-1');
  assert.equal(result.diagnostics.reason, 'trusted_host');
}

function testShareUrlRejectsProxyHostAndFallsBackToLan(): void {
  const result = resolveShareUrlForRequest({
    requestHost: '8.8.8.8:53721',
    protocol: 'http',
    url: 'http://8.8.8.8:53721/dpagent-share/token-1',
    localIpv4Addresses: ['192.168.1.33'],
  });

  assert.equal(result.url, 'http://192.168.1.33:53721/dpagent-share/token-1');
  assert.equal(result.diagnostics.reason, 'lan_fallback');
}

function testShareUrlWithoutLanDoesNotTrustProxyHost(): void {
  const result = resolveShareUrlForRequest({
    requestHost: '8.8.8.8:53721',
    protocol: 'http',
    url: 'http://8.8.8.8:53721/dpagent-share/token-1',
    localIpv4Addresses: [],
  });

  assert.equal(result.url, '/dpagent-share/token-1');
  assert.equal(result.diagnostics.chosenHost, '');
  assert.equal(result.diagnostics.reason, 'loopback_fallback');
}

function testSessionListIncludesActiveOnlyCliSession(): void {
  const harness = createDeps();
  harness.setActiveRuns([
    {
      runId: 'run-cli',
      context: { scope: 'session', namespace: 'sess-cli' },
      startedAt: '2026-05-03T00:00:00.000Z',
      owner: 'cli',
      origin: 'cli',
      interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
      llmRuntime: {
        profileId: 'kimi',
        provider: 'anthropic',
        model: 'kimi-coding',
        reasoningPreset: 'high',
      },
    },
  ]);
  const route = harness.routes.find((item) => item.path === '/api/sessions');
  assert.ok(route);

  const res = createResponseRecorder();
  route.handler({ query: {} }, res);
  const body = res.body as { sessions: Array<Record<string, any>> };
  const cliSession = body.sessions.find((session) => session.id === 'sess-cli');

  assert.equal(cliSession?.origin, 'cli');
  assert.equal(cliSession?.activeRun?.owner, 'cli');
  assert.equal(cliSession?.interactionState?.mode, 'observe_only');
  assert.equal(cliSession?.activeRun?.llmRuntime?.model, 'kimi-coding');
}

function testPlanDraftExitClearsDraftStateAndPendingConfirmation(): void {
  const harness = createDeps();
  harness.setPlanningState({
    state: 'plan_drafting',
    pendingPlanId: 'plan-draft',
    updatedAt: '2026-05-01T00:00:00.000Z',
  });
  harness.setAutoLoopConfig({
    enabled: false,
    mode: 'todo',
    ralphEnabled: true,
    pendingPlanConfirmation: true,
    pausedByUser: false,
    prompt: 'Continue',
    maxRounds: 4,
    maxDurationMinutes: 120,
    similarityThreshold: 0.85,
    compareRounds: 3,
  });
  const route = harness.postRoutes.find((item) => item.path === '/api/sessions/:id/plan-draft/exit');
  assert.ok(route);

  const res = createResponseRecorder();
  route.handler({ params: { id: 'sess-plan' }, body: { reason: 'user left draft' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal((res.body as any).success, true);
  assert.equal(harness.meta.planningState.state, 'normal');
  assert.equal(harness.meta.planningState.pendingPlanId, undefined);
  assert.equal(harness.meta.autoLoopConfig.mode, 'ralph');
  assert.equal(harness.meta.autoLoopConfig.enabled, true);
  assert.equal(harness.meta.autoLoopConfig.pendingPlanConfirmation, false);
}

function testPlanDraftExitRejectsCliObserveOnlySession(): void {
  const harness = createDeps();
  harness.setPlanningState({
    state: 'plan_drafting',
    pendingPlanId: 'plan-draft',
    updatedAt: '2026-05-01T00:00:00.000Z',
  });
  harness.setActiveRuns([
    {
      runId: 'run-cli',
      context: { scope: 'session', namespace: 'sess-plan' },
      startedAt: '2026-05-03T00:00:00.000Z',
      owner: 'cli',
      origin: 'cli',
      interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
    },
  ]);
  const route = harness.postRoutes.find((item) => item.path === '/api/sessions/:id/plan-draft/exit');
  assert.ok(route);

  const res = createResponseRecorder();
  route.handler({ params: { id: 'sess-plan' }, body: { reason: 'blocked' } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal((res.body as any).error, 'observe_only');
  assert.equal(harness.meta.planningState.state, 'plan_drafting');
}

function testNormalPlanExecutionExitRequiresCompletedTodosAndClearsPlanningState(): void {
  const harness = createDeps();
  harness.setPlanningState({
    state: 'plan_executing',
    activeExecutionPlanId: 'plan-active',
    updatedAt: '2026-05-01T00:00:00.000Z',
  });
  harness.setAutoLoopConfig({
    enabled: true,
    mode: 'todo',
    ralphEnabled: true,
    pendingPlanConfirmation: false,
    pausedByUser: false,
    prompt: 'Continue',
    maxRounds: 4,
    maxDurationMinutes: 120,
    similarityThreshold: 0.85,
    compareRounds: 3,
  });
  harness.setTodoState(createProtocolState(false));
  const route = harness.postRoutes.find((item) => item.path === '/api/sessions/:id/plan-execution/exit');
  assert.ok(route);

  const res = createResponseRecorder();
  route.handler({ params: { id: 'sess-plan' }, body: { mode: 'normal', reason: 'done' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal((res.body as any).success, true);
  assert.equal(harness.meta.planningState.state, 'normal');
  assert.equal(harness.meta.planningState.activeExecutionPlanId, undefined);
  assert.equal(harness.meta.autoLoopConfig.mode, 'ralph');
  assert.equal(harness.meta.autoLoopConfig.enabled, true);
  assert.equal(harness.meta.lastPlanExecutionExit.mode, 'normal');
  assert.equal(harness.cancelContexts.length, 0);
}

function testNormalPlanExecutionExitAllowsDismissedPlanTodos(): void {
  const harness = createDeps();
  harness.setPlanningState({
    state: 'plan_executing',
    activeExecutionPlanId: 'plan-active',
    updatedAt: '2026-05-01T00:00:00.000Z',
  });
  harness.setTodoState({
    items: [
      {
        id: 'todo-dismissed',
        status: 'dismissed',
        planId: 'plan-active',
        planStepId: 'step-1',
      },
    ],
    unfinishedItems: [],
    activeItem: null,
    blockedItem: null,
    pendingItems: [],
    completedItems: [],
    dismissedItems: [{ id: 'todo-dismissed', status: 'dismissed' }],
    hasUnfinished: false,
    allCompleted: false,
  });
  const route = harness.postRoutes.find((item) => item.path === '/api/sessions/:id/plan-execution/exit');
  assert.ok(route);

  const res = createResponseRecorder();
  route.handler({ params: { id: 'sess-plan' }, body: { mode: 'normal', reason: 'dismissed' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal((res.body as any).success, true);
  assert.equal(harness.meta.planningState.state, 'normal');
  assert.equal(harness.meta.lastPlanExecutionExit.unfinishedTodoCount, 0);
}

function testNormalPlanExecutionExitRejectsUnfinishedTodos(): void {
  const harness = createDeps();
  harness.setPlanningState({
    state: 'plan_executing',
    activeExecutionPlanId: 'plan-active',
    updatedAt: '2026-05-01T00:00:00.000Z',
  });
  harness.setTodoState(createProtocolState(true));
  const route = harness.postRoutes.find((item) => item.path === '/api/sessions/:id/plan-execution/exit');
  assert.ok(route);

  const res = createResponseRecorder();
  route.handler({ params: { id: 'sess-plan' }, body: { mode: 'normal' } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal((res.body as any).success, false);
  assert.equal(harness.meta.planningState.state, 'plan_executing');
}

function testForcePlanExecutionExitKeepsTodosButDisablesDrivingLoop(): void {
  const harness = createDeps();
  harness.setPlanningState({
    state: 'plan_executing',
    activeExecutionPlanId: 'plan-active',
    updatedAt: '2026-05-01T00:00:00.000Z',
  });
  harness.setAutoLoopConfig({
    enabled: true,
    mode: 'todo',
    ralphEnabled: false,
    pendingPlanConfirmation: false,
    pausedByUser: false,
    prompt: 'Continue',
    maxRounds: 4,
    maxDurationMinutes: 120,
    similarityThreshold: 0.85,
    compareRounds: 3,
  });
  harness.setTodoState(createProtocolState(true));
  const route = harness.postRoutes.find((item) => item.path === '/api/sessions/:id/plan-execution/exit');
  assert.ok(route);

  const res = createResponseRecorder();
  route.handler({ params: { id: 'sess-plan' }, body: { mode: 'force', reason: 'user stopped plan' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal((res.body as any).success, true);
  assert.equal(harness.meta.planningState.state, 'normal');
  assert.equal(harness.meta.autoLoopConfig.enabled, false);
  assert.equal(harness.meta.autoLoopConfig.mode, 'todo');
  assert.equal(harness.meta.autoLoopConfig.pausedByUser, true);
  assert.equal(harness.meta.lastPlanExecutionExit.mode, 'force');
  assert.equal(harness.meta.lastPlanExecutionExit.reason, 'user stopped plan');
  assert.deepEqual(harness.cancelContexts, [{ scope: 'session', namespace: 'sess-plan' }]);
}

function runAll(): void {
  testShareRoutesRejectInvalidTokenConsistently();
  testShareRoutesResolveValidTokenForShareAndTextHistory();
  testFullAccessRoutesRejectShareOnlyAccess();
  testSessionScopedRoutesRejectShareScopeAccess();
  testSessionListReturnsPlanningState();
  testSessionDetailReturnsPlanningState();
  testSessionDetailReturnsMessageCreatedAt();
  testShareUrlUsesConfiguredPublicBaseUrlFirst();
  testShareUrlReplacesLoopbackWithLanAddress();
  testShareUrlKeepsTrustedLanHost();
  testShareUrlRejectsProxyHostAndFallsBackToLan();
  testShareUrlWithoutLanDoesNotTrustProxyHost();
  testSessionListIncludesActiveOnlyCliSession();
  testPlanDraftExitClearsDraftStateAndPendingConfirmation();
  testPlanDraftExitRejectsCliObserveOnlySession();
  testNormalPlanExecutionExitRequiresCompletedTodosAndClearsPlanningState();
  testNormalPlanExecutionExitAllowsDismissedPlanTodos();
  testNormalPlanExecutionExitRejectsUnfinishedTodos();
  testForcePlanExecutionExitKeepsTodosButDisablesDrivingLoop();
  console.log('web-session-planning-state-route tests passed');
}

runAll();
