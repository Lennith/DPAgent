import * as assert from 'node:assert/strict';
import { registerWebServerRoutes } from '../../src/web/server/web-server-route-registration.js';
import type { Message } from '../../src/types.js';
import { createResponseRecorder, createRouteAppHarness, type CapturedRoute } from './helpers/web-route-harness.js';

function createDeps(messages: Message[]) {
  const routes = createRouteAppHarness();

  registerWebServerRoutes({
    app: routes.app as any,
    wss: { clients: new Set() } as any,
    agent: {
      getConfig: () => ({
        agent: { workspaceDir: 'D:\\repo', globalAgentsDir: 'D:\\agents' },
        llmProfiles: { defaultProfileId: 'default', profiles: [] },
      }),
      getContextManager: () => ({ listNamespaces: () => [] }),
      getContextNamespaceMeta: () => ({}),
      resolveToolsetName: () => 'default',
      getContextMessages: () => messages,
    } as any,
    automationRoutes: { register: () => undefined } as any,
    configServices: {
      hasUsableApiKey: () => true,
      persistConfigFile: () => undefined,
      setBootMissingApiKey: () => undefined,
      refreshConfigDependentRuntimes: async () => undefined,
    },
    agentCatalogServices: {
      refreshGlobalAgentCatalog: () => undefined,
      getGlobalAgentProfiles: () => [],
    },
    llmServices: {
      discoverProfileModels: async () => ({}) as any,
    },
    governanceServices: {
      runWorkspaceSkillGovernance: async () => ({}) as any,
      getLatestWorkspaceSkillGovernanceReport: () => null,
    },
    contextServices: {
      getContextNamespaceMetaSafe: () => ({}),
      getPendingPlanInputView: () => null,
      getActiveRunState: () => null,
      listActiveSessionRunStates: () => [],
      getInteractionStateForContext: () => ({ mode: 'normal' }),
      getInterruptedArtifact: () => null,
      updateContextNamespaceMetaSafe: () => undefined,
      resolveWorkspaceDirForContext: () => 'D:\\repo',
      resolveAgentForContext: () => ({ getSubAgentManager: () => ({ list: () => [] }) }),
      cleanupSessionRuntime: async () => undefined,
    } as any,
    todoServices: {
      ensureTodoDrivenAutoLoop: () => undefined,
      getSessionTodoProtocolState: () => ({
        hasUnfinished: false,
        allCompleted: true,
        items: [],
        unfinishedItems: [],
        pendingItems: [],
        completedItems: [],
        activeItem: null,
        blockedItem: null,
      }),
    },
    authServices: {
      isLoopback: () => false,
      isAuthenticatedForRemoteAccess: () => false,
      handleLogin: () => ({ success: true }),
      handleLogout: () => '',
      getStatus: () => ({ required: false, authenticated: true, local: true, configured: false }),
    },
    shareServices: {
      resolveShareToken: (token: string | null | undefined) =>
        token === 'valid-token' ? { sessionId: 'sess-shared', expiresAt: '2099-05-07T00:00:00.000Z' } : null,
      createSessionShare: () => {
        throw new Error('not used');
      },
      getSessionShareStatus: () => ({ active: false }),
      revokeSessionShare: () => ({ active: false }),
      buildShareUrl: () => '/dpagent-share/valid-token',
    },
    accessServices: {
      getSharedAccessSessionId: () => 'sess-shared',
      canAccessSession: (_req: any, sessionId: string) => sessionId === 'sess-shared',
      hasFullAccess: () => false,
    },
  } as any);

  return routes;
}

async function callRoute(route: CapturedRoute, req: any) {
  const res = createResponseRecorder();
  await route.handler(req, res);
  return res;
}

async function testTextHistoryDefaultsToThreeBodyOnlyTurns(): Promise<void> {
  const routes = createDeps([
    { role: 'system', content: 'system secret' },
    { role: 'user', content: 'old user' },
    { role: 'assistant', content: 'old assistant', thinking: 'hidden thinking' },
    { role: 'tool', content: 'hidden tool result', name: 'shell' },
    { role: 'user', content: 'first user' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first assistant' },
        { type: 'tool_use', input: { command: 'hidden' } },
      ],
      toolCalls: [{ id: 'tool-1', type: 'function', function: { name: 'shell', arguments: {} } }],
      thinking: 'hidden',
    },
    { role: 'user', content: 'second user' },
    { role: 'assistant', content: 'second assistant' },
    { role: 'user', content: 'third user' },
    { role: 'assistant', content: 'third assistant' },
  ]);
  const route = routes.getRouteList.find((item) => item.path === '/api/share/:token/text-history');
  assert.ok(route);

  const res = await callRoute(route, { params: { token: 'valid-token' }, query: {}, headers: {} });

  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.body as any).messages, [
    { role: 'user', content: 'first user' },
    { role: 'assistant', content: 'first assistant' },
    { role: 'user', content: 'second user' },
    { role: 'assistant', content: 'second assistant' },
    { role: 'user', content: 'third user' },
    { role: 'assistant', content: 'third assistant' },
  ]);
  assert.equal(JSON.stringify(res.body).includes('hidden'), false);
  assert.equal((res.body as any).turns, 3);
  assert.equal((res.body as any).sessionId, 'sess-shared');
}

async function testTextHistoryHonorsTurnsAndRejectsBadToken(): Promise<void> {
  const routes = createDeps([
    { role: 'user', content: 'first user' },
    { role: 'assistant', content: 'first assistant' },
    { role: 'user', content: 'second user' },
    { role: 'assistant', content: 'second assistant' },
  ]);
  const route = routes.getRouteList.find((item) => item.path === '/api/share/:token/text-history');
  assert.ok(route);

  const oneTurn = await callRoute(route, {
    params: { token: 'valid-token' },
    query: { turns: '1' },
    headers: {},
  });
  assert.deepEqual((oneTurn.body as any).messages, [
    { role: 'user', content: 'second user' },
    { role: 'assistant', content: 'second assistant' },
  ]);

  const invalid = await callRoute(route, { params: { token: 'bad-token' }, query: {}, headers: {} });
  assert.equal(invalid.statusCode, 401);
  assert.equal((invalid.body as any).code, 'SHARE_TOKEN_INVALID');
}

async function runAll(): Promise<void> {
  await testTextHistoryDefaultsToThreeBodyOnlyTurns();
  await testTextHistoryHonorsTurnsAndRejectsBadToken();
  console.log('web-share-text-routes tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
