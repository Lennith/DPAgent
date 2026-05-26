import * as assert from 'node:assert/strict';
import { createWebServerDouble } from './helpers/web-server-harness.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function createConfig() {
  return {
    api: {
      apiKey: 'anthropic-key',
      apiBase: 'https://anthropic.local',
      model: 'claude-3-7-sonnet-20250219',
      provider: 'anthropic' as const,
      maxOutputTokens: 4096,
    },
    llmProfiles: {
      defaultProfileId: 'anthropic-default',
      profiles: [
        {
          id: 'anthropic-default',
          name: 'Anthropic Default',
          provider: 'anthropic' as const,
          apiKey: 'anthropic-key',
          apiBase: 'https://anthropic.local',
          defaultModel: 'claude-3-7-sonnet-20250219',
          availableModels: ['claude-3-7-sonnet-20250219'],
          maxOutputTokens: 4096,
          enabled: true,
        },
        {
          id: 'openai-alt',
          name: 'OpenAI Alt',
          provider: 'openai' as const,
          apiKey: 'openai-key',
          apiBase: 'https://openai.local/v1',
          defaultModel: 'gpt-4.1-mini',
          availableModels: ['gpt-4.1-mini', 'gpt-4.1'],
          maxOutputTokens: 2048,
          enabled: true,
        },
      ],
    },
    agent: {
      maxSteps: 100,
      tokenLimit: 80000,
      workspaceDir: 'D:/workspace',
      runtimeDataDir: 'D:/workspace/runtime',
      globalAgentsDir: 'D:/workspace/agents',
      defaultToolset: 'windows-dev',
      subAgentMaxParallelPerParent: 4,
      subAgentGlobalMaxParallel: 10,
    },
  };
}

function createSessionMeta() {
  return {
    scope: 'session' as const,
    namespace: 'sess-1',
    name: 'Session 1',
    createdAt: '2026-04-24T00:00:00.000Z',
    updatedAt: '2026-04-24T00:00:00.000Z',
    workspaceDir: 'D:/workspace',
    llmSelection: {
      profileId: 'anthropic-default',
      model: 'claude-3-7-sonnet-20250219',
      reasoningPreset: 'high' as const,
      providerOptions: {
        anthropic: {
          thinkingBudgetTokens: 4096,
        },
      },
      updatedAt: '2026-04-24T00:00:00.000Z',
    },
  };
}

function createServerHarness() {
  const server = createWebServerDouble();
  server.activeRunContexts = new Map();
  server.activeRunStatesByContext = new Map();
  server.cancelingRunIds = new Set();
  const { app, getRoutes, postRoutes, putRoutes, patchRoutes } = createRouteAppHarness();
  const config = createConfig();
  let sessionMeta = createSessionMeta();
  let persistedConfig: unknown = null;
  let discoveredProfileId: string | null = null;
  let discoveredProfileSnapshot: any = null;
  let refreshConfigDependentRuntimeCount = 0;

  server.app = app;
  server.wss = { clients: new Set() };
  server.profileIntrospectionService = {
    discoverModels: async (profile: { id: string; provider: 'anthropic' | 'openai' }) => {
      discoveredProfileId = profile.id;
      discoveredProfileSnapshot = { ...profile };
      return {
        profileId: profile.id,
        source: 'live',
        fetchedAt: '2026-04-24T00:00:00.000Z',
        models: [
          {
            id: profile.provider === 'openai' ? 'gpt-4.1-mini' : 'claude-3-7-sonnet-20250219',
            provider: profile.provider,
          },
        ],
        manualModelEntryAllowed: true,
        capabilities: {
          modelDiscovery: true,
          reasoningEffort: profile.provider === 'openai',
          thinkingBudget: profile.provider === 'anthropic',
        },
      };
    },
  };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      if (updates.llmProfiles) {
        config.llmProfiles = updates.llmProfiles;
        const defaultProfile =
          config.llmProfiles.profiles.find((profile: { id: string }) => profile.id === config.llmProfiles.defaultProfileId) ??
          config.llmProfiles.profiles[0];
        config.api = {
          ...config.api,
          apiKey: defaultProfile.apiKey,
          apiBase: defaultProfile.apiBase,
          model: defaultProfile.defaultModel,
          provider: defaultProfile.provider,
          maxOutputTokens: defaultProfile.maxOutputTokens,
        };
      }
      if (updates.api) {
        config.api = {
          ...config.api,
          ...updates.api,
        };
      }
    },
    cleanup: async () => undefined,
    reloadSkills: () => undefined,
    getToolsetRegistry: () => ({
      get: (name: string) => ({ name }),
    }),
    getContextManager: () => ({
      listNamespaces: () => [],
    }),
    getContextNamespaceMeta: () => sessionMeta,
    getContextMessages: () => [],
    resolveToolsetName: () => 'windows-dev',
    updateContextNamespaceMeta: (_ref: unknown, patch: Record<string, unknown>) => {
      sessionMeta = {
        ...sessionMeta,
        ...patch,
      };
      return sessionMeta;
    },
    deleteSessionContext: () => true,
    getMcpStatus: () => ({
      enabled: false,
      summary: {
        state: 'disabled',
        connectedCount: 0,
        totalEnabled: 0,
      },
      servers: [],
    }),
  };
  server.refreshConfigDependentRuntimes = async () => {
    refreshConfigDependentRuntimeCount += 1;
  };
  server.persistConfigFile = (nextConfig: unknown) => {
    persistedConfig = nextConfig;
  };
  server.refreshGlobalAgentCatalog = () => undefined;
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();

  return {
    server,
    config,
    getRoutes,
    postRoutes,
    putRoutes,
    patchRoutes,
    getSessionMeta: () => sessionMeta,
    getPersistedConfig: () => persistedConfig,
    getDiscoveredProfileId: () => discoveredProfileId,
    getDiscoveredProfileSnapshot: () => discoveredProfileSnapshot,
    getRefreshConfigDependentRuntimeCount: () => refreshConfigDependentRuntimeCount,
  };
}

function testGetLlmProfilesRouteExposesProfilesOnly(): void {
  const harness = createServerHarness();
  assert.equal(harness.getRoutes.has('/api/llm-profiles'), false);
  const handler = harness.getRoutes.get('/api/settings');
  assert.ok(handler, 'expected GET /api/settings route');

  const res = createResponseRecorder();
  handler?.({}, res);

  assert.equal((res.payload as any).llmProfiles.defaultProfileId, 'anthropic-default');
  assert.equal((res.payload as any).llmProfiles.profiles.length, 2);
  assert.equal((res.payload as any).llmProfiles.profiles[0].hasApiKey, true);
  assert.deepEqual((res.payload as any).llmProfiles.profiles[1].availableModels, [
    'gpt-4.1-mini',
    'gpt-4.1',
  ]);
}

async function testPutLlmProfilesRejectsDuplicateIdsAndUnknownDefault(): Promise<void> {
  const harness = createServerHarness();
  assert.equal(harness.putRoutes.has('/api/llm-profiles'), false);
  const handler = harness.putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const duplicateRes = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'anthropic-default',
        profiles: [
          {
            id: 'dup',
            name: 'dup-1',
            provider: 'anthropic',
            apiBase: 'https://anthropic.local',
            defaultModel: 'claude',
          },
          {
            id: 'dup',
            name: 'dup-2',
            provider: 'openai',
            apiBase: 'https://openai.local/v1',
            defaultModel: 'gpt',
          },
        ],
      },
    },
    duplicateRes
  );
  assert.equal(duplicateRes.statusCode, 400);
  assert.match(String((duplicateRes.payload as any).error ?? ''), /Duplicate profile id/i);

  const missingDefaultRes = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'missing-profile',
        profiles: [
          {
            id: 'anthropic-default',
            name: 'Anthropic Default',
            provider: 'anthropic',
            apiBase: 'https://anthropic.local',
            defaultModel: 'claude-3-7-sonnet-20250219',
          },
        ],
      },
    },
    missingDefaultRes
  );
  assert.equal(missingDefaultRes.statusCode, 400);
  assert.match(String((missingDefaultRes.payload as any).error ?? ''), /defaultProfileId/i);
}

async function testPatchSessionLlmSelectionClearsStaleProviderOptionsOnProfileChange(): Promise<void> {
  const harness = createServerHarness();
  const handler = harness.patchRoutes.get('/api/sessions/:id/llm-selection');
  assert.ok(handler, 'expected PATCH /api/sessions/:id/llm-selection route');

  const res = createResponseRecorder();
  await handler?.(
    {
      params: {
        id: 'sess-1',
      },
      body: {
        profileId: 'openai-alt',
        model: 'gpt-4.1-mini',
        reasoningPreset: 'medium',
        updatedAt: '2026-04-24T00:00:01.000Z',
      },
    },
    res
  );

  assert.equal((res.payload as any).success, true);
  assert.equal((res.payload as any).llmSelection.profileId, 'openai-alt');
  assert.equal((res.payload as any).llmSelection.model, 'gpt-4.1-mini');
  assert.equal((res.payload as any).llmSelection.providerOptions, undefined);
  assert.equal((res.payload as any).llmSelection.updatedAt, '2026-04-24T00:00:01.000Z');
  assert.equal(harness.getSessionMeta().llmSelection?.providerOptions, undefined);
}

async function testPatchSessionLlmSelectionRejectsStaleUpdatedAt(): Promise<void> {
  const harness = createServerHarness();
  const handler = harness.patchRoutes.get('/api/sessions/:id/llm-selection');
  assert.ok(handler, 'expected PATCH /api/sessions/:id/llm-selection route');

  const res = createResponseRecorder();
  await handler?.(
    {
      params: {
        id: 'sess-1',
      },
      body: {
        profileId: 'openai-alt',
        model: 'gpt-4.1-mini',
        reasoningPreset: 'medium',
        updatedAt: '2026-04-23T23:59:59.000Z',
      },
    },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.equal((res.payload as any).llmSelection.profileId, 'anthropic-default');
  assert.equal(harness.getSessionMeta().llmSelection?.profileId, 'anthropic-default');
}

async function testPatchSessionLlmSelectionRequiresValidUpdatedAt(): Promise<void> {
  const harness = createServerHarness();
  const handler = harness.patchRoutes.get('/api/sessions/:id/llm-selection');
  assert.ok(handler, 'expected PATCH /api/sessions/:id/llm-selection route');

  const missingRes = createResponseRecorder();
  await handler?.(
    {
      params: {
        id: 'sess-1',
      },
      body: {
        profileId: 'openai-alt',
        model: 'gpt-4.1-mini',
        reasoningPreset: 'medium',
      },
    },
    missingRes
  );
  assert.equal(missingRes.statusCode, 400);
  assert.match(String((missingRes.payload as any).error ?? ''), /updatedAt/i);

  const invalidRes = createResponseRecorder();
  await handler?.(
    {
      params: {
        id: 'sess-1',
      },
      body: {
        profileId: 'openai-alt',
        model: 'gpt-4.1-mini',
        reasoningPreset: 'medium',
        updatedAt: 'zzz',
      },
    },
    invalidRes
  );
  assert.equal(invalidRes.statusCode, 400);
  assert.match(String((invalidRes.payload as any).error ?? ''), /updatedAt/i);
}

async function testPutLlmProfilesPersistsUpdatedDefaultProfile(): Promise<void> {
  const harness = createServerHarness();
  const handler = harness.putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'openai-alt',
        profiles: harness.config.llmProfiles.profiles.map((profile) => ({
          ...profile,
          apiKey: undefined,
        })),
      },
    },
    res
  );

  assert.equal((res.payload as any).success, true);
  assert.equal(harness.config.api.provider, 'openai');
  assert.equal(harness.config.api.model, 'gpt-4.1-mini');
  assert.deepEqual(harness.config.llmProfiles.profiles[1].availableModels, [
    'gpt-4.1-mini',
    'gpt-4.1',
  ]);
  assert.equal((harness.getPersistedConfig as () => unknown)(), harness.config);
  assert.equal(harness.getRefreshConfigDependentRuntimeCount(), 1);
}

async function testPutLlmProfilesRollsBackWhenRefreshFails(): Promise<void> {
  const harness = createServerHarness();
  const handler = harness.putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');
  harness.server.refreshConfigDependentRuntimes = async () => {
    throw new Error('refresh failed');
  };

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'openai-alt',
        profiles: harness.config.llmProfiles.profiles.map((profile) => ({
          ...profile,
          apiKey: undefined,
        })),
      },
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.match(String((res.payload as any).error ?? ''), /refresh failed/i);
  assert.equal(harness.config.llmProfiles.defaultProfileId, 'anthropic-default');
  assert.equal(harness.config.api.provider, 'anthropic');
  assert.equal(harness.config.api.model, 'claude-3-7-sonnet-20250219');
  assert.equal((harness.getPersistedConfig as () => any)()?.llmProfiles.defaultProfileId, 'anthropic-default');
}

async function testDiscoverModelsRouteUsesIntrospectionService(): Promise<void> {
  const harness = createServerHarness();
  const handler = harness.postRoutes.get('/api/llm-profiles/:id/discover-models');
  assert.ok(handler, 'expected POST /api/llm-profiles/:id/discover-models route');

  const res = createResponseRecorder();
  await handler?.(
    {
      params: {
        id: 'openai-alt',
      },
    },
    res
  );

  assert.equal((res.payload as any).profileId, 'openai-alt');
  assert.equal((res.payload as any).source, 'live');
  assert.equal((res.payload as any).models[0].id, 'gpt-4.1-mini');
  assert.equal(harness.getDiscoveredProfileId(), 'openai-alt');
}

async function testDiscoverModelsRouteAcceptsDraftWithoutPersisting(): Promise<void> {
  const harness = createServerHarness();
  const handler = harness.postRoutes.get('/api/llm-profiles/:id/discover-models');
  assert.ok(handler, 'expected POST /api/llm-profiles/:id/discover-models route');

  const res = createResponseRecorder();
  await handler?.(
    {
      params: {
        id: 'openai-alt',
      },
      body: {
        profile: {
          id: 'openai-alt',
          provider: 'anthropic',
          apiBase: 'https://draft.local/anthropic',
          defaultModel: 'draft-model',
          apiKey: 'draft-key',
          maxOutputTokens: 32768,
        },
      },
    },
    res
  );

  const snapshot = harness.getDiscoveredProfileSnapshot();
  assert.equal((res.payload as any).profileId, 'openai-alt');
  assert.equal(snapshot.provider, 'anthropic');
  assert.equal(snapshot.apiBase, 'https://draft.local/anthropic');
  assert.equal(snapshot.apiKey, 'draft-key');
  assert.equal(harness.config.llmProfiles.profiles[1].provider, 'openai');
  assert.equal((harness.getPersistedConfig as () => unknown)(), null);
}

async function runAll(): Promise<void> {
  testGetLlmProfilesRouteExposesProfilesOnly();
  await testPutLlmProfilesRejectsDuplicateIdsAndUnknownDefault();
  await testPatchSessionLlmSelectionClearsStaleProviderOptionsOnProfileChange();
  await testPatchSessionLlmSelectionRejectsStaleUpdatedAt();
  await testPatchSessionLlmSelectionRequiresValidUpdatedAt();
  await testPutLlmProfilesPersistsUpdatedDefaultProfile();
  await testPutLlmProfilesRollsBackWhenRefreshFails();
  await testDiscoverModelsRouteUsesIntrospectionService();
  await testDiscoverModelsRouteAcceptsDraftWithoutPersisting();
  console.log('web-llm-profile-routes tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
