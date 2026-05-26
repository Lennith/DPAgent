import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerWebServerRoutes } from '../../src/web/server/web-server-route-registration.js';
import type { ContextRef } from '../../src/types.js';
import { createResponseRecorder, createRouteAppHarness, type CapturedRoute } from './helpers/web-route-harness.js';

function createDeps(
  authOverrides: {
    isLoopback?: () => boolean;
    isAuthenticatedForRemoteAccess?: () => boolean;
    sharedAccessSessionId?: () => string | null;
  } = {},
  agentProfiles: Array<Record<string, unknown>> = [],
  agentDirs: { workspaceDir?: string; globalAgentsDir?: string } = {}
) {
  const routeHarness = createRouteAppHarness();
  const contextServices = {
    getContextNamespaceMetaSafe: () => ({}),
    getPendingPlanInputView: () => null,
    getActiveRunState: (context: ContextRef) => ({
      runId: 'run-cli',
      context,
      startedAt: '2026-05-03T00:00:00.000Z',
      owner: 'cli',
      origin: 'cli',
      interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
    }),
    listActiveSessionRunStates: () => [],
    getInteractionStateForContext: () => ({
      mode: 'observe_only',
      reason: 'cli_active_run',
      owner: 'cli',
    }),
    getInterruptedArtifact: () => null,
    updateContextNamespaceMetaSafe: () => {
      throw new Error('observe-only route must not mutate context meta');
    },
    resolveWorkspaceDirForContext: () => agentDirs.workspaceDir ?? 'D:\\repo',
    resolveAgentForContext: () => ({
      getSubAgentManager: () => ({
        cancel: () => {
          throw new Error('observe-only route must not cancel subagents');
        },
      }),
    }),
    cleanupSessionRuntime: async () => undefined,
  };
  const agent = {
    getConfig: () => ({
      agent: {
        workspaceDir: agentDirs.workspaceDir ?? 'D:\\repo',
        globalAgentsDir: agentDirs.globalAgentsDir ?? 'D:\\agents',
      },
      llmProfiles: {
        defaultProfileId: 'default',
        profiles: [],
      },
    }),
    getContextManager: () => ({ listNamespaces: () => [] }),
    getContextNamespaceMeta: () => ({}),
    resolveToolsetName: () => 'default',
    getContextMessages: () => [],
    getToolsetRegistry: () => ({
      list: () => [],
      get: () => {
        throw new Error('observe-only route must not resolve toolset writes');
      },
    }),
    getTodoStore: () => ({
      createTodo: () => {
        throw new Error('observe-only route must not mutate todos');
      },
      updateTodo: () => {
        throw new Error('observe-only route must not mutate todos');
      },
      deleteTodo: () => {
        throw new Error('observe-only route must not mutate todos');
      },
      listTodos: () => [],
      getProtocolState: () => ({}),
      clearCompletedTodos: () => [],
    }),
    setToolsetPreset: () => {
      throw new Error('observe-only route must not set toolset presets');
    },
    clearToolsetPreset: () => {
      throw new Error('observe-only route must not clear toolset presets');
    },
    getToolsetPresetStore: () => ({
      listTeamPresets: () => [],
      getWorkspacePreset: () => undefined,
    }),
    getMemoryStore: () => ({ listEntries: () => [] }),
    getMemoryPromotionState: () => null,
    organizeSessionMemory: () => {
      throw new Error('observe-only route must not organize session memory');
    },
    listGovernanceAudit: () => [],
    getGovernanceAuditStore: () => ({ append: () => undefined }),
    getMcpStatus: () => ({}),
    reloadSkills: () => undefined,
    getSkillLoader: () => ({ getSkillCatalog: () => [] }),
    listSkillHistory: () => [],
    rollbackSkill: () => ({}),
    getSkillPackStore: () => ({ listPacks: () => [] }),
    publishSkillPack: () => ({}),
    activateSkillPack: () => ({}),
    rollbackSkillPack: () => ({}),
  };

  registerWebServerRoutes({
    app: routeHarness.app as any,
    wss: { clients: new Set() } as any,
    agent: agent as any,
    automationRoutes: { register: () => undefined } as any,
    configServices: {
      hasUsableApiKey: () => true,
      persistConfigFile: () => undefined,
      setBootMissingApiKey: () => undefined,
      refreshConfigDependentRuntimes: async () => undefined,
    },
    agentCatalogServices: {
      refreshGlobalAgentCatalog: () => undefined,
      getGlobalAgentProfiles: () => agentProfiles,
    },
    llmServices: {
      discoverProfileModels: async () => ({}) as any,
    },
    contextServices: contextServices as any,
    todoServices: {
      ensureTodoDrivenAutoLoop: () => {
        throw new Error('observe-only route must not change autoloop');
      },
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
      isLoopback: authOverrides.isLoopback ?? (() => true),
      isAuthenticatedForRemoteAccess: authOverrides.isAuthenticatedForRemoteAccess ?? (() => true),
      handleLogin: () => ({ success: true }),
      handleLogout: () => '',
      getStatus: () => ({ required: false, authenticated: true, local: true, configured: false }),
    },
    shareServices: {
      resolveShareToken: () => ({
        sessionId: 'sess-shared',
        tokenHash: 'hash-shared',
        createdAt: '2026-05-07T00:00:00.000Z',
        expiresAt: '2099-05-07T00:00:00.000Z',
        version: 1,
      }),
      createSessionShare: () => {
        throw new Error('route test must not create share');
      },
      getSessionShareStatus: () => ({ active: false }),
      revokeSessionShare: () => ({ active: false }),
      buildShareUrl: () => '/dpagent-share/token',
    },
    accessServices: {
      getSharedAccessSessionId: authOverrides.sharedAccessSessionId ?? (() => null),
      getSharedAccessToken: () => 'token-shared',
      canAccessSession: (_req: any, sessionId: string) =>
        !authOverrides.sharedAccessSessionId || authOverrides.sharedAccessSessionId() === sessionId,
      hasFullAccess: () => false,
    },
  } as any);

  return {
    use: routeHarness.useRoutes,
    get: routeHarness.getRouteList,
    post: routeHarness.postRouteList,
    put: routeHarness.putRouteList,
    patch: routeHarness.patchRouteList,
    delete: routeHarness.deleteRouteList,
  };
}

function writeFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
}

function testAgentsRouteSubagentModeFiltersExternalOptIn(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-agents-route-'));
  try {
    const globalAgentsDir = path.join(tempDir, 'agents');
    const workspaceDir = path.join(tempDir, 'workspace');
    writeFile(path.join(globalAgentsDir, 'Hidden', 'AGENTS.md'), '# Hidden\nNot exposed.');
    writeFile(path.join(globalAgentsDir, 'Visible', 'AGENTS.md'), '# Visible\nExposed.');
    writeFile(path.join(globalAgentsDir, 'Visible', 'agent.yaml'), 'version: 1\nexposeAsSubagent: true\n');
    writeFile(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\nWorkspace agent.');

    const routes = createDeps(
      {},
      [
        {
          name: 'Hidden',
          source: 'global',
          description: 'External hidden',
          path: path.join(globalAgentsDir, 'Hidden', 'AGENTS.md'),
          mtime: '2026-05-11T00:00:00.000Z',
          normalizedName: 'hidden',
        },
        {
          name: 'Visible',
          source: 'global',
          description: 'External visible',
          path: path.join(globalAgentsDir, 'Visible', 'AGENTS.md'),
          mtime: '2026-05-11T00:00:00.000Z',
          normalizedName: 'visible',
          config: { exposeAsSubagent: true },
        },
      ],
      { globalAgentsDir, workspaceDir }
    );
    const route = routes.get.find((item) => item.path === '/api/agents');
    assert.ok(route);

    const mentionRes = createResponseRecorder();
    route.handler({ path: '/api/agents', method: 'GET', headers: {}, query: {}, params: {} }, mentionRes);
    assert.equal(mentionRes.statusCode, 200);
    assert.equal((mentionRes.body as any).agents.some((item: { name: string }) => item.name === 'Hidden'), true);
    assert.equal((mentionRes.body as any).agents.some((item: { name: string }) => item.name === 'Visible'), true);

    const subagentRes = createResponseRecorder();
    route.handler(
      { path: '/api/agents', method: 'GET', headers: {}, query: { mode: 'subagent' }, params: {} },
      subagentRes
    );
    assert.equal(subagentRes.statusCode, 200);
    assert.equal((subagentRes.body as any).agents.some((item: { name: string }) => item.name === 'Hidden'), false);
    assert.equal((subagentRes.body as any).agents.some((item: { name: string }) => item.name === 'Visible'), true);
    assert.equal((subagentRes.body as any).agents.some((item: { name: string }) => item.name === 'workspace'), true);
    assert.equal((subagentRes.body as any).agents.some((item: { source: string }) => item.source === 'bundled'), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertObserveOnly(route: CapturedRoute, req: any): void {
  const res = createResponseRecorder();
  route.handler(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal((res.body as any).error, 'observe_only');
  assert.equal((res.body as any).interactionState.owner, 'cli');
}

function runAll(): void {
  testAgentsRouteSubagentModeFiltersExternalOptIn();
  const routes = createDeps();
  const remoteUnauthedRoutes = createDeps({
    isLoopback: () => false,
    isAuthenticatedForRemoteAccess: () => false,
  });
  const remoteAuthMiddleware = remoteUnauthedRoutes.use[1];
  assert.ok(remoteAuthMiddleware);
  {
    const res = createResponseRecorder();
    let nextCalled = false;
    remoteAuthMiddleware(
      { path: '/download/abcdefabcdefabcdefabcdefabcdefabcdef/report.md' },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, false);
    assert.deepEqual(res.body, { redirect: '/login' });
  }
  {
    const res = createResponseRecorder();
    let nextCalled = false;
    remoteAuthMiddleware(
      { path: '/guide/user-guide', method: 'GET', headers: {}, query: {}, params: {} },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  }
  {
    const sharedRoutes = createDeps({
      isLoopback: () => false,
      isAuthenticatedForRemoteAccess: () => false,
      sharedAccessSessionId: () => 'sess-shared',
    });
    const sharedMiddleware = sharedRoutes.use[1];
    const res = createResponseRecorder();
    let nextCalled = false;
    sharedMiddleware(
      { path: '/api/settings', method: 'GET', headers: {}, query: {}, params: {} },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal((res.body as any).code, 'SHARE_SCOPE_FORBIDDEN');
  }
  {
    const sharedRoutes = createDeps({
      isLoopback: () => false,
      isAuthenticatedForRemoteAccess: () => false,
      sharedAccessSessionId: () => 'sess-shared',
    });
    const sharedMiddleware = sharedRoutes.use[1];
    const res = createResponseRecorder();
    let nextCalled = false;
    sharedMiddleware(
      {
        path: '/download/abcdefabcdefabcdefabcdefabcdefabcdef/report.md',
        method: 'GET',
        headers: {},
        query: { shareToken: 'token-shared' },
        params: {},
      },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, true);
  }
  {
    const sharedRoutes = createDeps(
      {
        isLoopback: () => false,
        isAuthenticatedForRemoteAccess: () => false,
        sharedAccessSessionId: () => 'sess-shared',
      },
      [
        {
          name: 'Reviewer',
          source: 'global',
          description: 'Review specialist',
          path: 'D:\\agents\\Reviewer\\AGENTS.md',
          mtime: '2026-05-11T00:00:00.000Z',
          normalizedName: 'reviewer',
        },
      ]
    );
    const sharedMiddleware = sharedRoutes.use[1];
    const res = createResponseRecorder();
    let nextCalled = false;
    sharedMiddleware(
      { path: '/api/agents', method: 'GET', headers: {}, query: { shareToken: 'token-shared' }, params: {} },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, true);
    const route = sharedRoutes.get.find((item) => item.path === '/api/agents');
    assert.ok(route);
    const agentsRes = createResponseRecorder();
    route.handler(
      { path: '/api/agents', method: 'GET', headers: {}, query: { shareToken: 'token-shared' }, params: {} },
      agentsRes
    );
    assert.equal(agentsRes.statusCode, 200);
    assert.deepEqual((agentsRes.body as any).agents.map((item: { name: string }) => item.name), ['Reviewer']);
    assert.deepEqual((agentsRes.body as any).agents[0], {
      name: 'Reviewer',
      description: 'Review specialist',
    });
    const subagentModeRes = createResponseRecorder();
    route.handler(
      { path: '/api/agents', method: 'GET', headers: {}, query: { shareToken: 'token-shared', mode: 'subagent' }, params: {} },
      subagentModeRes
    );
    assert.equal(subagentModeRes.statusCode, 403);
    assert.equal((subagentModeRes.body as any).code, 'SHARE_SCOPE_FORBIDDEN');
  }
  {
    const sharedRoutes = createDeps({
      isLoopback: () => false,
      isAuthenticatedForRemoteAccess: () => false,
      sharedAccessSessionId: () => 'sess-shared',
    });
    const sharedMiddleware = sharedRoutes.use[1];
    const res = createResponseRecorder();
    let nextCalled = false;
    sharedMiddleware(
      {
        path: '/api/sessions/sess-shared/dropped-files',
        method: 'POST',
        headers: {},
        query: { shareToken: 'token-shared' },
        params: {},
      },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal((res.body as any).code, 'SHARE_SCOPE_FORBIDDEN');
  }
  {
    const sharedRoutes = createDeps({
      isLoopback: () => false,
      isAuthenticatedForRemoteAccess: () => false,
      sharedAccessSessionId: () => 'sess-shared',
    });
    const sharedMiddleware = sharedRoutes.use[1];
    const res = createResponseRecorder();
    let nextCalled = false;
    sharedMiddleware(
      { path: '/guide/user-guide', method: 'GET', headers: {}, query: { shareToken: 'token-shared' }, params: {} },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  }
  {
    const sharedRoutes = createDeps({
      isLoopback: () => false,
      isAuthenticatedForRemoteAccess: () => false,
      sharedAccessSessionId: () => 'sess-shared',
    });
    const sharedMiddleware = sharedRoutes.use[1];
    const res = createResponseRecorder();
    let nextCalled = false;
    sharedMiddleware(
      { path: '/api/agents/Reviewer/config', method: 'GET', headers: {}, query: { shareToken: 'token-shared' }, params: {} },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  }
  {
    const sharedRoutes = createDeps({
      isLoopback: () => false,
      isAuthenticatedForRemoteAccess: () => false,
      sharedAccessSessionId: () => 'sess-shared',
    });
    const sharedMiddleware = sharedRoutes.use[1];
    const res = createResponseRecorder();
    let nextCalled = false;
    sharedMiddleware(
      { path: '/tools', method: 'GET', headers: {}, query: { shareToken: 'token-shared' }, params: {} },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, false);
    assert.deepEqual(res.body, { redirect: '/dpagent-share/token-shared' });
  }
  assertObserveOnly(
    routes.post.find((route) => route.path === '/api/sessions/:id/subagents/:subagentId/cancel')!,
    { params: { id: 'sess-cli', subagentId: 'sub-1' }, body: {} }
  );
  assertObserveOnly(
    routes.post.find((route) => route.path === '/api/sessions/:id/toolset')!,
    { params: { id: 'sess-cli' }, body: { toolsetName: 'full-access' } }
  );
  assertObserveOnly(
    routes.post.find((route) => route.path === '/api/sessions/:id/autoloop')!,
    { params: { id: 'sess-cli' }, body: { enabled: false } }
  );
  assertObserveOnly(
    routes.post.find((route) => route.path === '/api/todos')!,
    { params: {}, body: { action: 'add', sessionId: 'sess-cli', work: 'blocked' } }
  );
  assertObserveOnly(
    routes.post.find((route) => route.path === '/api/todos/:id')!,
    { params: { id: 'todo-blocked' }, body: { action: 'dismiss', sessionId: 'sess-cli' } }
  );
  assertObserveOnly(
    routes.post.find((route) => route.path === '/api/todos/:id')!,
    { params: { id: 'todo-blocked' }, body: { action: 'resume', sessionId: 'sess-cli' } }
  );
  assertObserveOnly(
    routes.post.find((route) => route.path === '/api/memory/organize')!,
    { params: {}, query: {}, body: { sessionId: 'sess-cli' } }
  );
  console.log('web-observe-only-routes tests passed');
}

runAll();
