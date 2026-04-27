import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { WebServer } from '../../src/web/server/WebServer.js';

type RouteHandler = (req: unknown, res: unknown) => void | Promise<void>;

function createAppHarness() {
  const getRoutes = new Map<string, RouteHandler>();
  const postRoutes = new Map<string, RouteHandler>();
  const app = {
    use: () => undefined,
    get: (route: string, handler: RouteHandler) => {
      getRoutes.set(route, handler);
    },
    post: (route: string, handler: RouteHandler) => {
      postRoutes.set(route, handler);
    },
    put: () => undefined,
    patch: () => undefined,
    delete: () => undefined,
  };
  return { app, getRoutes, postRoutes };
}

function createResponseRecorder() {
  const recorder = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      recorder.statusCode = code;
      return recorder;
    },
    json(data: unknown) {
      recorder.payload = data;
      return recorder;
    },
  };
  return recorder;
}

function createBaseConfig() {
  return {
    api: {
      apiKey: 'test-api-key',
      apiBase: 'https://openai-compatible.local/v1',
      model: 'gpt-4o-mini',
      provider: 'openai' as const,
      maxOutputTokens: 4096,
    },
    agent: {
      maxSteps: 100,
      tokenLimit: 80000,
      workspaceDir: 'D:/workspace',
      runtimeDataDir: 'D:/workspace/runtime',
      completionMarkerEnforcementEnabled: false,
      globalAgentsDir: 'D:/workspace/agents',
      defaultToolset: 'windows-dev',
      skillWriteMode: 'confirm' as const,
      subAgentMaxParallelPerParent: 4,
      subAgentGlobalMaxParallel: 10,
    },
  };
}

function testConfigRoutesExposeProvider(): void {
  const server = Object.create(WebServer.prototype) as any;
  const { app, getRoutes } = createAppHarness();
  const config = createBaseConfig();
  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();

  const configHandler = getRoutes.get('/api/config');
  assert.ok(configHandler, 'expected /api/config route');
  const configRes = createResponseRecorder();
  configHandler?.({}, configRes);
  assert.equal((configRes.payload as any).provider, 'openai');
  assert.equal((configRes.payload as any).api.provider, 'openai');
  assert.equal((configRes.payload as any).agent.maxSteps, 100);
  assert.equal((configRes.payload as any).agent.completionMarkerEnforcementEnabled, false);

  const settingsHandler = getRoutes.get('/api/settings');
  assert.ok(settingsHandler, 'expected /api/settings route');
  const settingsRes = createResponseRecorder();
  settingsHandler?.({}, settingsRes);
  assert.equal((settingsRes.payload as any).api.provider, 'openai');
  assert.equal((settingsRes.payload as any).agent.maxSteps, 100);
  assert.equal((settingsRes.payload as any).agent.completionMarkerEnforcementEnabled, false);
}

async function testConfigPostPersistsProvider(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  const { app, postRoutes } = createAppHarness();
  const config = createBaseConfig();
  let updatePayload: unknown;
  let cleanupCalls = 0;
  let refreshRuntimeCalls = 0;
  let persistedConfig: unknown;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      updatePayload = {
        ...(updatePayload as Record<string, unknown> | undefined),
        ...updates,
        api: {
          ...((updatePayload as { api?: Record<string, unknown> } | undefined)?.api ?? {}),
          ...(updates.api ?? {}),
        },
        agent: {
          ...((updatePayload as { agent?: Record<string, unknown> } | undefined)?.agent ?? {}),
          ...(updates.agent ?? {}),
        },
      };
      config.api = {
        ...config.api,
        ...updates.api,
      };
      config.agent = {
        ...config.agent,
        ...updates.agent,
      };
    },
    cleanup: async () => {
      cleanupCalls += 1;
    },
    getToolsetRegistry: () => ({
      get: (name: string) => ({ name }),
    }),
  };
  server.refreshConfigDependentRuntimes = async () => {
    refreshRuntimeCalls += 1;
  };
  server.persistConfigFile = (nextConfig: unknown) => {
    persistedConfig = nextConfig;
  };
  server.refreshGlobalAgentCatalog = () => undefined;
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = postRoutes.get('/api/config');
  assert.ok(handler, 'expected POST /api/config route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        provider: 'openai',
        completionMarkerEnforcementEnabled: true,
        maxSteps: 42,
      },
    },
    res
  );

  assert.equal((updatePayload as any).api.provider, 'openai');
  assert.equal((updatePayload as any).agent.completionMarkerEnforcementEnabled, true);
  assert.equal((updatePayload as any).agent.maxSteps, 42);
  assert.equal(config.api.provider, 'openai');
  assert.equal(config.agent.completionMarkerEnforcementEnabled, true);
  assert.equal(config.agent.maxSteps, 42);
  assert.equal(cleanupCalls, 0);
  assert.equal(refreshRuntimeCalls, 1);
  assert.equal((persistedConfig as any).api.provider, 'openai');
  assert.equal((persistedConfig as any).agent.completionMarkerEnforcementEnabled, true);
  assert.equal((persistedConfig as any).agent.maxSteps, 42);
  assert.equal((res.payload as any).success, true);
}

function testConfigManagerPersistsCompletionMarkerSetting(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-marker-config-'));
  const configPath = path.join(tempDir, 'config.yaml');
  try {
    const writer = new ConfigManager({
      agent: {
        completionMarkerEnforcementEnabled: true,
      } as any,
    });
    writer.saveToYaml(configPath);

    const reader = new ConfigManager();
    reader.loadFromYaml(configPath);
    assert.equal(reader.get().agent.completionMarkerEnforcementEnabled, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testConfigPostRejectsInvalidProvider(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  const { app, postRoutes } = createAppHarness();
  const config = createBaseConfig();
  let updateCalls = 0;
  let cleanupCalls = 0;
  let refreshRuntimeCalls = 0;
  let persistCalls = 0;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: () => {
      updateCalls += 1;
    },
    cleanup: async () => {
      cleanupCalls += 1;
    },
    getToolsetRegistry: () => ({
      get: (name: string) => ({ name }),
    }),
  };
  server.refreshConfigDependentRuntimes = async () => {
    refreshRuntimeCalls += 1;
  };
  server.persistConfigFile = () => {
    persistCalls += 1;
  };
  server.refreshGlobalAgentCatalog = () => undefined;
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = postRoutes.get('/api/config');
  assert.ok(handler, 'expected POST /api/config route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        provider: 'custom-provider',
      },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.equal((res.payload as any).success, false);
  assert.match(String((res.payload as any).error ?? ''), /Invalid provider/i);
  assert.equal(updateCalls, 0);
  assert.equal(cleanupCalls, 0);
  assert.equal(refreshRuntimeCalls, 0);
  assert.equal(persistCalls, 0);
  assert.equal(config.api.provider, 'openai');
}

async function testConfigPostValidationIsAtomic(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  const { app, postRoutes } = createAppHarness();
  const config = createBaseConfig();
  let updateCalls = 0;
  let refreshRuntimeCalls = 0;
  let persistCalls = 0;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: () => {
      updateCalls += 1;
      throw new Error('updateConfig should not be called for invalid payload');
    },
    getToolsetRegistry: () => ({
      get: (name: string) => ({ name }),
    }),
  };
  server.refreshConfigDependentRuntimes = async () => {
    refreshRuntimeCalls += 1;
  };
  server.persistConfigFile = () => {
    persistCalls += 1;
  };
  server.refreshGlobalAgentCatalog = () => undefined;
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = postRoutes.get('/api/config');
  assert.ok(handler, 'expected POST /api/config route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        apiBase: 'https://mutated.example/v1',
        model: 'mutated-model',
        maxSteps: 'not-a-number',
      },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(String((res.payload as any).error ?? ''), /Invalid maxSteps/i);
  assert.equal(updateCalls, 0);
  assert.equal(refreshRuntimeCalls, 0);
  assert.equal(persistCalls, 0);
  assert.equal(config.api.apiBase, 'https://openai-compatible.local/v1');
  assert.equal(config.api.model, 'gpt-4o-mini');
}

async function testConfigPostRollsBackWhenRefreshFails(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  const { app, postRoutes } = createAppHarness();
  const config = createBaseConfig();
  let updateCalls = 0;
  let refreshRuntimeCalls = 0;
  let persistedConfig: unknown;
  let reloadSkillsCalls = 0;
  let refreshGlobalCatalogCalls = 0;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      updateCalls += 1;
      if (updates.api) {
        config.api = {
          ...config.api,
          ...updates.api,
        };
      }
      if (updates.agent) {
        config.agent = {
          ...config.agent,
          ...updates.agent,
        };
      }
      if (updates.llmProfiles) {
        (config as any).llmProfiles = updates.llmProfiles;
      }
    },
    getToolsetRegistry: () => ({
      get: (name: string) => ({ name }),
    }),
    reloadSkills: () => {
      reloadSkillsCalls += 1;
    },
  };
  server.refreshConfigDependentRuntimes = async () => {
    refreshRuntimeCalls += 1;
    throw new Error('refresh failed');
  };
  server.persistConfigFile = (nextConfig: unknown) => {
    persistedConfig = nextConfig;
  };
  server.refreshGlobalAgentCatalog = () => {
    refreshGlobalCatalogCalls += 1;
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = postRoutes.get('/api/config');
  assert.ok(handler, 'expected POST /api/config route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        apiBase: 'https://mutated.example/v1',
        model: 'mutated-model',
        maxSteps: 77,
        skillsDir: 'D:/mutated-skills',
        globalAgentsDir: 'D:/mutated-agents',
      },
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.match(String((res.payload as any).error ?? ''), /refresh failed/i);
  assert.equal(updateCalls, 2);
  assert.equal(refreshRuntimeCalls, 1);
  assert.equal(reloadSkillsCalls, 0);
  assert.equal(refreshGlobalCatalogCalls, 0);
  assert.equal(config.api.apiBase, 'https://openai-compatible.local/v1');
  assert.equal(config.api.model, 'gpt-4o-mini');
  assert.equal(config.agent.maxSteps, 100);
  assert.equal((persistedConfig as any).api.apiBase, 'https://openai-compatible.local/v1');
  assert.equal((persistedConfig as any).agent.maxSteps, 100);
}

async function testApiKeyPostRefreshesConfigRuntimesWithoutAgentCleanup(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  const { app, postRoutes } = createAppHarness();
  const config = createBaseConfig();
  let cleanupCalls = 0;
  let refreshRuntimeCalls = 0;
  let persistedConfig: unknown;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      config.api = {
        ...config.api,
        ...updates.api,
      };
    },
    cleanup: async () => {
      cleanupCalls += 1;
    },
  };
  server.refreshConfigDependentRuntimes = async () => {
    refreshRuntimeCalls += 1;
  };
  server.persistConfigFile = (nextConfig: unknown) => {
    persistedConfig = nextConfig;
  };
  server.hasUsableApiKey = () => true;
  server.setBootMissingApiKey = () => undefined;
  server.refreshGlobalAgentCatalog = () => undefined;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = postRoutes.get('/api/settings/apikey');
  assert.ok(handler, 'expected POST /api/settings/apikey route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        apiKey: 'sk-test-api-key-1234567890',
      },
    },
    res
  );

  assert.equal(config.api.apiKey, 'sk-test-api-key-1234567890');
  assert.equal(cleanupCalls, 0);
  assert.equal(refreshRuntimeCalls, 1);
  assert.equal((persistedConfig as any).api.apiKey, 'sk-test-api-key-1234567890');
  assert.equal((res.payload as any).success, true);
}

async function testApiKeyPostRollsBackWhenRefreshFails(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  const { app, postRoutes } = createAppHarness();
  const config = createBaseConfig();
  let refreshRuntimeCalls = 0;
  let persistedConfig: unknown;
  let bootMissingApiKeySet = false;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      config.api = {
        ...config.api,
        ...updates.api,
      };
      if (updates.llmProfiles) {
        (config as any).llmProfiles = updates.llmProfiles;
      }
      if (updates.agent) {
        config.agent = {
          ...config.agent,
          ...updates.agent,
        };
      }
    },
  };
  server.refreshConfigDependentRuntimes = async () => {
    refreshRuntimeCalls += 1;
    throw new Error('refresh failed');
  };
  server.persistConfigFile = (nextConfig: unknown) => {
    persistedConfig = nextConfig;
  };
  server.hasUsableApiKey = () => true;
  server.setBootMissingApiKey = (value: boolean) => {
    bootMissingApiKeySet = value === false;
  };
  server.refreshGlobalAgentCatalog = () => undefined;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = postRoutes.get('/api/settings/apikey');
  assert.ok(handler, 'expected POST /api/settings/apikey route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        apiKey: 'sk-mutated-api-key-1234567890',
      },
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.match(String((res.payload as any).error ?? ''), /refresh failed/i);
  assert.equal(refreshRuntimeCalls, 1);
  assert.equal(config.api.apiKey, 'test-api-key');
  assert.equal((persistedConfig as any).api.apiKey, 'test-api-key');
  assert.equal(bootMissingApiKeySet, false);
}

async function testConfigRuntimeRefreshDoesNotCancelActiveSessionRuntime(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  let sessionCancelCalls = 0;
  let sessionCleanupCalls = 0;
  let rootCleanupCalls = 0;
  server.activeRunContexts = new Map([
    [
      'run-active',
      {
        scope: 'session',
        namespace: 'sess-active',
      },
    ],
  ]);
  server.activeRunStatesByContext = new Map([
    [
      'session:sess-active',
      {
        runId: 'run-active',
        context: {
          scope: 'session',
          namespace: 'sess-active',
        },
        startedAt: '2026-04-26T00:00:00.000Z',
      },
    ],
  ]);
  server.cancelingRunIds = new Set();
  server.sessionRuntimes = new Map([
    [
      'sess-active',
      {
        agent: {
          cancelContext: () => {
            sessionCancelCalls += 1;
          },
          cleanup: async () => {
            sessionCleanupCalls += 1;
          },
        },
        workspaceDir: 'D:/workspace',
        runtimeKey: 'runtime-old',
        lastUsedAt: '2026-04-26T00:00:00.000Z',
      },
    ],
  ]);
  server.agent = {
    cleanup: async () => {
      rootCleanupCalls += 1;
    },
  };
  server.rejectPendingPlanInputByContext = () => undefined;
  server.stopAutoLoopForContext = () => undefined;

  await server.refreshConfigDependentRuntimes();

  assert.equal(sessionCancelCalls, 0);
  assert.equal(sessionCleanupCalls, 0);
  assert.equal(rootCleanupCalls, 1);
  assert.equal(server.sessionRuntimes.has('sess-active'), true);
  assert.equal(server.sessionRuntimes.get('sess-active')?.configDirty, true);

  await server.finalizeTrackedRun('run-active');

  assert.equal(sessionCancelCalls, 0);
  assert.equal(sessionCleanupCalls, 1);
  assert.equal(server.sessionRuntimes.has('sess-active'), false);
}

async function testAutoLoopToggleCannotBypassPendingPlanConfirmation(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  const { app, postRoutes } = createAppHarness();
  const config = createBaseConfig();
  const sessionId = `sess-pending-plan-${Date.now()}`;
  let ensureCalls = 0;
  let meta: Record<string, unknown> = {
    autoLoopConfig: {
      enabled: false,
      mode: 'todo',
      ralphEnabled: true,
      pendingPlanConfirmation: true,
      pausedByUser: false,
    },
  };

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    getContextNamespaceMeta: () => meta,
    getTodoStore: () => ({
      getProtocolState: () => ({
        items: [{ id: 'todo-1', status: 'pending' }],
        unfinishedItems: [{ id: 'todo-1', status: 'pending' }],
        activeItem: null,
        blockedItem: null,
        pendingItems: [{ id: 'todo-1', status: 'pending' }],
        completedItems: [],
        hasUnfinished: true,
        allCompleted: false,
      }),
    }),
    listGovernanceAudit: () => [],
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };
  server.persistConfigFile = () => undefined;
  server.refreshConfigDependentRuntimes = async () => undefined;
  server.refreshGlobalAgentCatalog = () => undefined;
  server.globalAgentProfiles = [];
  server.getContextNamespaceMetaSafe = () => meta;
  server.getLivePendingPlanInputView = () => null;
  server.updateContextNamespaceMetaSafe = (_context: unknown, patch: Record<string, unknown>) => {
    meta = {
      ...meta,
      ...patch,
    };
  };
  server.resolveWorkspaceDirForContext = () => config.agent.workspaceDir;
  server.resolveAgentForContext = () => server.agent;
  server.cleanupSessionRuntime = async () => undefined;
  server.ensureTodoDrivenAutoLoop = () => {
    ensureCalls += 1;
  };
  server.getSessionTodoProtocolState = () => ({
    items: [{ id: 'todo-1', status: 'pending' }],
    unfinishedItems: [{ id: 'todo-1', status: 'pending' }],
    activeItem: null,
    blockedItem: null,
    pendingItems: [{ id: 'todo-1', status: 'pending' }],
    completedItems: [],
    hasUnfinished: true,
    allCompleted: false,
  });

  server.setupRoutes();
  const handler = postRoutes.get('/api/sessions/:id/autoloop');
  assert.ok(handler, 'expected POST /api/sessions/:id/autoloop route');

  const res = createResponseRecorder();
  await handler?.(
    {
      params: { id: sessionId },
      body: { enabled: true },
    },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.equal((res.payload as any).success, false);
  assert.equal(((meta.autoLoopConfig ?? {}) as Record<string, unknown>).pendingPlanConfirmation, true);
  assert.equal(ensureCalls, 0);
}

async function testAutoLoopPostCannotClearPendingPlanConfirmationDirectly(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  const { app, postRoutes } = createAppHarness();
  const config = createBaseConfig();
  const sessionId = `sess-pending-plan-direct-${Date.now()}`;
  let meta: Record<string, unknown> = {
    autoLoopConfig: {
      enabled: false,
      mode: 'todo',
      ralphEnabled: true,
      pendingPlanConfirmation: true,
      pausedByUser: false,
    },
  };

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    getContextNamespaceMeta: () => meta,
    getTodoStore: () => ({
      getProtocolState: () => ({
        items: [{ id: 'todo-1', status: 'pending' }],
        unfinishedItems: [{ id: 'todo-1', status: 'pending' }],
        activeItem: null,
        blockedItem: null,
        pendingItems: [{ id: 'todo-1', status: 'pending' }],
        completedItems: [],
        hasUnfinished: true,
        allCompleted: false,
      }),
    }),
    listGovernanceAudit: () => [],
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };
  server.persistConfigFile = () => undefined;
  server.refreshConfigDependentRuntimes = async () => undefined;
  server.refreshGlobalAgentCatalog = () => undefined;
  server.globalAgentProfiles = [];
  server.getContextNamespaceMetaSafe = () => meta;
  server.getLivePendingPlanInputView = () => null;
  server.updateContextNamespaceMetaSafe = (_context: unknown, patch: Record<string, unknown>) => {
    meta = {
      ...meta,
      ...patch,
    };
  };
  server.resolveWorkspaceDirForContext = () => config.agent.workspaceDir;
  server.resolveAgentForContext = () => server.agent;
  server.cleanupSessionRuntime = async () => undefined;
  server.ensureTodoDrivenAutoLoop = WebServer.prototype.ensureTodoDrivenAutoLoop.bind(server);
  server.getSessionTodoProtocolState = () => ({
    items: [{ id: 'todo-1', status: 'pending' }],
    unfinishedItems: [{ id: 'todo-1', status: 'pending' }],
    activeItem: null,
    blockedItem: null,
    pendingItems: [{ id: 'todo-1', status: 'pending' }],
    completedItems: [],
    hasUnfinished: true,
    allCompleted: false,
  });

  server.setupRoutes();
  const handler = postRoutes.get('/api/sessions/:id/autoloop');
  assert.ok(handler, 'expected POST /api/sessions/:id/autoloop route');

  const res = createResponseRecorder();
  await handler?.(
    {
      params: { id: sessionId },
      body: { pendingPlanConfirmation: false },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal((res.payload as any).success, true);
  assert.equal(((meta.autoLoopConfig ?? {}) as Record<string, unknown>).pendingPlanConfirmation, true);
  assert.equal(((meta.autoLoopConfig ?? {}) as Record<string, unknown>).enabled, false);
}

function createTodoRouteServerHarness() {
  const server = Object.create(WebServer.prototype) as any;
  const { app, postRoutes } = createAppHarness();
  const config = createBaseConfig();
  const createCalls: Array<Record<string, unknown>> = [];
  const planSetCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<{ id: string; input: Record<string, unknown> }> = [];
  const clearCompletedCalls: Array<Record<string, unknown>> = [];
  const deleteCalls: Array<{ id: string; input: Record<string, unknown> }> = [];

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    getTodoStore: () => ({
      createTodo: (input: Record<string, unknown>) => {
        createCalls.push(input);
        return { id: 'todo-created', ...input };
      },
      setTodoPlan: (input: Record<string, unknown>) => {
        planSetCalls.push(input);
        return [{ id: 'todo-plan-1', work: 'plan', detectionStandard: 'done', status: 'pending' }];
      },
      updateTodo: (id: string, input: Record<string, unknown>) => {
        updateCalls.push({ id, input });
        return { id, ...input };
      },
      listTodos: () => [],
      clearCompletedTodos: (input: Record<string, unknown>) => {
        clearCompletedCalls.push(input);
        return 2;
      },
      deleteTodo: (id: string, input: Record<string, unknown>) => {
        deleteCalls.push({ id, input });
        return true;
      },
    }),
    listGovernanceAudit: () => [],
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };
  server.persistConfigFile = () => undefined;
  server.refreshConfigDependentRuntimes = async () => undefined;
  server.refreshGlobalAgentCatalog = () => undefined;
  server.globalAgentProfiles = [];
  server.getContextNamespaceMetaSafe = () => undefined;
  server.getLivePendingPlanInputView = () => null;
  server.updateContextNamespaceMetaSafe = () => undefined;
  server.resolveWorkspaceDirForContext = () => config.agent.workspaceDir;
  server.resolveAgentForContext = () => server.agent;
  server.cleanupSessionRuntime = async () => undefined;
  server.ensureTodoDrivenAutoLoop = () => undefined;
  server.getSessionTodoProtocolState = () => ({
    items: [],
    unfinishedItems: [],
    activeItem: null,
    blockedItem: null,
    pendingItems: [],
    completedItems: [],
    hasUnfinished: false,
    allCompleted: false,
  });

  server.setupRoutes();
  return { postRoutes, createCalls, planSetCalls, updateCalls, clearCompletedCalls, deleteCalls };
}

async function testTodoPostRejectsMixedPlanAndStatusFields(): Promise<void> {
  const { postRoutes, updateCalls } = createTodoRouteServerHarness();
  const handler = postRoutes.get('/api/todos/:id');
  assert.ok(handler, 'expected POST /api/todos/:id route');

  const res = createResponseRecorder();
  await handler?.(
    {
      params: { id: 'todo-1' },
      body: {
        action: 'set_status',
        sessionId: 'sess-1',
        work: 'rewrite work',
        status: 'blocked',
        blocked_reason: 'waiting for user',
      },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(
    String((res.payload as any).error ?? ''),
    /set_status does not accept: work/i
  );
  assert.equal(updateCalls.length, 0);
}

async function testTodoPostUsesStatusOnlyContract(): Promise<void> {
  const { postRoutes, updateCalls } = createTodoRouteServerHarness();
  const handler = postRoutes.get('/api/todos/:id');
  assert.ok(handler, 'expected POST /api/todos/:id route');

  const res = createResponseRecorder();
  await handler?.(
    {
      params: { id: 'todo-2' },
      body: {
        action: 'set_status',
        sessionId: 'sess-1',
        status: 'completed',
        evidence: ['artifact exists'],
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.id, 'todo-2');
  assert.equal(updateCalls[0]?.input.status, 'completed');
  assert.equal(updateCalls[0]?.input.completionTaskId, 'todo-2');
  assert.deepEqual(updateCalls[0]?.input.evidence, ['artifact exists']);
  assert.equal(updateCalls[0]?.input.work, undefined);
  assert.equal(updateCalls[0]?.input.detectionStandard, undefined);
  assert.equal(updateCalls[0]?.input.priority, undefined);
}

async function testTodoPostRejectsStatusMetadataWithoutExplicitStatus(): Promise<void> {
  const { postRoutes, updateCalls } = createTodoRouteServerHarness();
  const handler = postRoutes.get('/api/todos/:id');
  assert.ok(handler, 'expected POST /api/todos/:id route');

  const res = createResponseRecorder();
  await handler?.(
    {
      params: { id: 'todo-3' },
      body: {
        action: 'set_status',
        sessionId: 'sess-1',
        blocked_reason: 'waiting for user',
      },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(String((res.payload as any).error ?? ''), /must include an explicit status/i);
  assert.equal(updateCalls.length, 0);
}

async function testTodoPostRejectsInvalidExplicitStatus(): Promise<void> {
  const { postRoutes, updateCalls } = createTodoRouteServerHarness();
  const handler = postRoutes.get('/api/todos/:id');
  assert.ok(handler, 'expected POST /api/todos/:id route');

  const invalidRes = createResponseRecorder();
  await handler?.(
    {
      params: { id: 'todo-4' },
      body: {
        action: 'set_status',
        sessionId: 'sess-1',
        status: 'done',
      },
    },
    invalidRes
  );
  assert.equal(invalidRes.statusCode, 400);
  assert.match(String((invalidRes.payload as any).error ?? ''), /must use a valid status/i);

  const nullRes = createResponseRecorder();
  await handler?.(
    {
      params: { id: 'todo-5' },
      body: {
        action: 'set_status',
        sessionId: 'sess-1',
        status: null,
      },
    },
    nullRes
  );
  assert.equal(nullRes.statusCode, 400);
  assert.match(String((nullRes.payload as any).error ?? ''), /must use a valid status/i);
  assert.equal(updateCalls.length, 0);
}

async function testTodoPostSupportsExplicitPlanSet(): Promise<void> {
  const { postRoutes, planSetCalls, createCalls } = createTodoRouteServerHarness();
  const handler = postRoutes.get('/api/todos');
  assert.ok(handler, 'expected POST /api/todos route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        action: 'plan_set',
        sessionId: 'sess-1',
        items: [
          {
            work: 'Inspect implementation',
            detection_standard: 'Files are identified.',
            status: 'in_progress',
          },
        ],
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(planSetCalls.length, 1);
  assert.equal(createCalls.length, 0);
  assert.equal((planSetCalls[0]?.items as Array<Record<string, unknown>>)?.length, 1);
}

async function testTodoPostSupportsSnakeCaseToolPayloads(): Promise<void> {
  const { postRoutes, planSetCalls, updateCalls } = createTodoRouteServerHarness();
  const createHandler = postRoutes.get('/api/todos');
  const updateHandler = postRoutes.get('/api/todos/:id');
  assert.ok(createHandler, 'expected POST /api/todos route');
  assert.ok(updateHandler, 'expected POST /api/todos/:id route');

  const planSetRes = createResponseRecorder();
  await createHandler?.(
    {
      body: {
        action: 'plan_set',
        sessionId: 'sess-1',
        scope: 'session',
        items: [
          {
            work: 'Inspect implementation',
            detection_standard: 'Files are identified.',
            status: 'blocked',
            blocked_reason: 'waiting for user',
          },
        ],
      },
    },
    planSetRes
  );
  assert.equal(planSetRes.statusCode, 200);
  assert.equal(planSetCalls.length, 1);
  assert.deepEqual(planSetCalls[0]?.items, [
    {
      work: 'Inspect implementation',
      detectionStandard: 'Files are identified.',
      priority: undefined,
      status: 'blocked',
      blockedReason: 'waiting for user',
      tags: undefined,
    },
  ]);

  const setStatusRes = createResponseRecorder();
  await updateHandler?.(
    {
      params: { id: 'todo-7' },
      body: {
        action: 'set_status',
        sessionId: 'sess-1',
        status: 'completed',
        evidence: ['artifact exists'],
      },
    },
    setStatusRes
  );
  assert.equal(setStatusRes.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.input.completionTaskId, 'todo-7');
}

async function testTodoPostRejectsTaskIdBodyField(): Promise<void> {
  const { postRoutes, updateCalls } = createTodoRouteServerHarness();
  const updateHandler = postRoutes.get('/api/todos/:id');
  assert.ok(updateHandler, 'expected POST /api/todos/:id route');

  const res = createResponseRecorder();
  await updateHandler?.(
    {
      params: { id: 'todo-10' },
      body: {
        action: 'set_status',
        sessionId: 'sess-1',
        status: 'completed',
        task_id: 'todo-10',
        evidence: ['artifact exists'],
      },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(String((res.payload as any).error ?? ''), /set_status does not accept: task_id/i);
  assert.equal(updateCalls.length, 0);
}

async function testTodoPostSupportsClearCompletedAndDeleteActions(): Promise<void> {
  const { postRoutes, clearCompletedCalls, deleteCalls, updateCalls } = createTodoRouteServerHarness();
  const createHandler = postRoutes.get('/api/todos');
  const updateHandler = postRoutes.get('/api/todos/:id');
  assert.ok(createHandler, 'expected POST /api/todos route');
  assert.ok(updateHandler, 'expected POST /api/todos/:id route');

  const clearRes = createResponseRecorder();
  await createHandler?.(
    {
      body: {
        action: 'clear_completed',
        scope: 'user',
      },
    },
    clearRes
  );
  assert.equal(clearRes.statusCode, 200);
  assert.equal(clearCompletedCalls.length, 1);
  assert.equal(clearCompletedCalls[0]?.scope, 'user');

  const deleteRes = createResponseRecorder();
  await updateHandler?.(
    {
      params: { id: 'todo-8' },
      body: {
        action: 'delete',
        sessionId: 'sess-1',
      },
    },
    deleteRes
  );
  assert.equal(deleteRes.statusCode, 200);
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0]?.id, 'todo-8');
  assert.equal(updateCalls.length, 0);
}

async function testTodoPostRejectsCamelCaseTodoAliases(): Promise<void> {
  const { postRoutes, planSetCalls, updateCalls } = createTodoRouteServerHarness();
  const createHandler = postRoutes.get('/api/todos');
  const updateHandler = postRoutes.get('/api/todos/:id');
  assert.ok(createHandler, 'expected POST /api/todos route');
  assert.ok(updateHandler, 'expected POST /api/todos/:id route');

  const planSetRes = createResponseRecorder();
  await createHandler?.(
    {
      body: {
        action: 'plan_set',
        sessionId: 'sess-1',
        items: [
          {
            work: 'Inspect implementation',
            detectionStandard: 'Files are identified.',
          },
        ],
      },
    },
    planSetRes
  );
  assert.equal(planSetRes.statusCode, 400);
  assert.match(
    String((planSetRes.payload as any).error ?? ''),
    /items\[0\] do not accept: detectionStandard/i
  );
  assert.equal(planSetCalls.length, 0);

  const setStatusRes = createResponseRecorder();
  await updateHandler?.(
    {
      params: { id: 'todo-9' },
      body: {
        action: 'set_status',
        sessionId: 'sess-1',
        status: 'completed',
        completionTaskId: 'task-9',
        evidence: ['artifact exists'],
      },
    },
    setStatusRes
  );
  assert.equal(setStatusRes.statusCode, 400);
  assert.match(String((setStatusRes.payload as any).error ?? ''), /set_status does not accept: completionTaskId/i);
  assert.equal(updateCalls.length, 0);
}

async function testTodoPostRejectsCrossActionFields(): Promise<void> {
  const { postRoutes, planSetCalls, createCalls, updateCalls } = createTodoRouteServerHarness();
  const createHandler = postRoutes.get('/api/todos');
  const updateHandler = postRoutes.get('/api/todos/:id');
  assert.ok(createHandler, 'expected POST /api/todos route');
  assert.ok(updateHandler, 'expected POST /api/todos/:id route');

  const planSetRes = createResponseRecorder();
  await createHandler?.(
    {
      body: {
        action: 'plan_set',
        sessionId: 'sess-1',
        work: 'should fail',
        items: [],
      },
    },
    planSetRes
  );
  assert.equal(planSetRes.statusCode, 400);
  assert.match(String((planSetRes.payload as any).error ?? ''), /plan_set does not accept: work/i);

  const addRes = createResponseRecorder();
  await createHandler?.(
    {
      body: {
        action: 'add',
        sessionId: 'sess-1',
        work: 'Add one todo',
        detection_standard: 'Todo is created.',
        items: [],
      },
    },
    addRes
  );
  assert.equal(addRes.statusCode, 400);
  assert.match(String((addRes.payload as any).error ?? ''), /add does not accept: items/i);

  const setStatusRes = createResponseRecorder();
  await updateHandler?.(
    {
      params: { id: 'todo-6' },
      body: {
        action: 'set_status',
        sessionId: 'sess-1',
        status: 'blocked',
        blocked_reason: 'waiting for user',
        tags: ['should-fail'],
      },
    },
    setStatusRes
  );
  assert.equal(setStatusRes.statusCode, 400);
  assert.match(String((setStatusRes.payload as any).error ?? ''), /set_status does not accept: tags/i);
  assert.equal(planSetCalls.length, 0);
  assert.equal(createCalls.length, 0);
  assert.equal(updateCalls.length, 0);
}

async function runAll(): Promise<void> {
  testConfigRoutesExposeProvider();
  await testConfigPostPersistsProvider();
  await testConfigPostRejectsInvalidProvider();
  await testConfigPostValidationIsAtomic();
  await testConfigPostRollsBackWhenRefreshFails();
  await testApiKeyPostRefreshesConfigRuntimesWithoutAgentCleanup();
  await testApiKeyPostRollsBackWhenRefreshFails();
  await testConfigRuntimeRefreshDoesNotCancelActiveSessionRuntime();
  await testAutoLoopToggleCannotBypassPendingPlanConfirmation();
  await testAutoLoopPostCannotClearPendingPlanConfirmationDirectly();
  await testTodoPostRejectsMixedPlanAndStatusFields();
  await testTodoPostUsesStatusOnlyContract();
  await testTodoPostRejectsStatusMetadataWithoutExplicitStatus();
  await testTodoPostRejectsInvalidExplicitStatus();
  await testTodoPostSupportsExplicitPlanSet();
  await testTodoPostSupportsSnakeCaseToolPayloads();
  await testTodoPostRejectsTaskIdBodyField();
  await testTodoPostSupportsClearCompletedAndDeleteActions();
  await testTodoPostRejectsCamelCaseTodoAliases();
  await testTodoPostRejectsCrossActionFields();
  testConfigManagerPersistsCompletionMarkerSetting();
  console.log('web-config-provider tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
