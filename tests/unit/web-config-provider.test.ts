import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { createWebServerDouble } from './helpers/web-server-harness.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function createBaseConfig() {
  return new ConfigManager({
    api: {
      apiKey: 'test-api-key',
      apiBase: 'https://openai-compatible.local/v1',
      model: 'gpt-4o-mini',
      provider: 'openai' as const,
      maxOutputTokens: 4096,
    },
    llmProfiles: {
      defaultProfileId: 'openai-main',
      profiles: [
        {
          id: 'openai-main',
          name: 'OpenAI Main',
          provider: 'openai',
          apiKey: 'test-api-key',
          apiBase: 'https://openai-compatible.local/v1',
          defaultModel: 'gpt-4o-mini',
          maxOutputTokens: 4096,
          contextWindowTokens: 65536,
          enabled: true,
        },
      ],
    },
    contextBudget: {
      defaultContextWindowTokens: 57500,
      compressionTriggerRatio: 0.9,
      postCompressionTargetRatio: 0.35,
      minTokensAddedAfterCompression: 16000,
      compressionMaxChars: 6000,
      precompressKeepLlmRounds: 5,
      precompressChunkChars: 60000,
      precompressRetry: 1,
      reservedOutputTokens: 16000,
      reservedReasoningTokens: 0,
      reservedProtocolTokens: 8000,
      modelOverrides: {},
    },
    agent: {
      maxSteps: 100,
      tokenLimit: 80000,
      workspaceDir: 'D:/workspace',
      runtimeDataDir: 'D:/workspace/runtime',
      completionMarkerEnforcementEnabled: false,
      globalAgentsDir: 'D:/workspace/agents',
      defaultToolset: 'windows-dev',
      subAgentMaxParallelPerParent: 4,
      subAgentGlobalMaxParallel: 10,
    },
  }).get();
}

function testConfigRoutesExposeCanonicalProfiles(): void {
  const server = createWebServerDouble();
  const { app, getRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();

  assert.equal(getRoutes.has('/api/config'), false);

  const settingsHandler = getRoutes.get('/api/settings');
  assert.ok(settingsHandler, 'expected /api/settings route');
  const settingsRes = createResponseRecorder();
  settingsHandler?.({}, settingsRes);
  assert.equal((settingsRes.payload as any).llmProfiles.defaultProfileId, 'openai-main');
  assert.equal((settingsRes.payload as any).llmProfiles.profiles[0].contextWindowTokens, 65536);
  assert.equal((settingsRes.payload as any).contextBudget.defaultContextWindowTokens, 57500);
  assert.equal((settingsRes.payload as any).web.sessionShareTtlHours, 24);
  assert.equal((settingsRes.payload as any).agent.maxSteps, 100);
  assert.equal((settingsRes.payload as any).agent.completionMarkerEnforcementEnabled, false);
  assert.equal((settingsRes.payload as any).workspaceTimeline.enabled, false);
}

async function testWorkspaceTimelineSettingsRoundTrip(): Promise<void> {
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  let refreshRuntimeCalls = 0;
  let persistedConfig: unknown;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      if (updates.workspaceTimeline) {
        (config as any).workspaceTimeline = updates.workspaceTimeline;
      }
    },
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
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        workspaceTimeline: { enabled: true },
      },
    },
    res
  );

  assert.equal(refreshRuntimeCalls, 1);
  assert.equal((config as any).workspaceTimeline.enabled, true);
  assert.equal((persistedConfig as any).workspaceTimeline.enabled, true);
  assert.equal((res.payload as any).workspaceTimeline.enabled, true);
}

function testLegacyApiConfigMigratesIntoDefaultLlmProfileOnSave(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-legacy-config-'));
  const configPath = path.join(rootDir, 'config.yaml');
  fs.writeFileSync(
    configPath,
    [
      'api:',
      '  apiKey: legacy-api-key-123456789012345',
      '  apiBase: https://legacy.example/v1',
      '  model: legacy-model',
      '  provider: openai',
      '  maxOutputTokens: 12345',
      'agent:',
      '  workspaceDir: ./workspace',
      '',
    ].join('\n'),
    'utf8'
  );

  const manager = new ConfigManager();
  manager.loadFromYaml(configPath);
  const loaded = manager.get();

  assert.equal(loaded.llmProfiles.defaultProfileId, 'default');
  assert.equal(loaded.llmProfiles.profiles[0].apiKey, 'legacy-api-key-123456789012345');
  assert.equal(loaded.llmProfiles.profiles[0].apiBase, 'https://legacy.example/v1');
  assert.equal(loaded.llmProfiles.profiles[0].defaultModel, 'legacy-model');
  assert.equal(loaded.llmProfiles.profiles[0].provider, 'openai');
  assert.equal(loaded.llmProfiles.profiles[0].maxOutputTokens, 12345);

  manager.saveToYaml(configPath);
  const saved = fs.readFileSync(configPath, 'utf8');
  assert.doesNotMatch(saved, /^api:/m);
  assert.match(saved, /apiKey: legacy-api-key-123456789012345/);
  assert.match(saved, /defaultModel: legacy-model/);
}

function testSystemRoutesRegisterOnce(): void {
  const server = createWebServerDouble();
  const { app, getRouteCounts } = createRouteAppHarness();
  const config = createBaseConfig();
  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();

  assert.equal(getRouteCounts.get('/api/health'), 1);
  assert.equal(getRouteCounts.has('/api/config'), false);
  assert.equal(getRouteCounts.get('/api/settings'), 1);
}

async function testLlmProfilesPutPersistsProfileContextWindowOverride(): Promise<void> {
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  let refreshRuntimeCalls = 0;
  let persistedConfig: unknown;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      if (updates.llmProfiles) {
        (config as any).llmProfiles = updates.llmProfiles;
      }
    },
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
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'openai-main',
        profiles: [
          {
            id: 'openai-main',
            name: 'OpenAI Main',
            provider: 'openai',
            apiBase: 'https://openai-compatible.local/v1',
            defaultModel: 'gpt-4o-mini',
            maxOutputTokens: 4096,
            contextWindowTokens: null,
            enabled: true,
          },
        ],
      },
    },
    res
  );

  assert.equal(refreshRuntimeCalls, 1);
  assert.equal(config.llmProfiles.profiles[0].contextWindowTokens, undefined);
  assert.equal((persistedConfig as any).llmProfiles.profiles[0].contextWindowTokens, undefined);
  assert.equal((res.payload as any).llmProfiles.profiles[0].contextWindowTokens, undefined);
}

async function testRemoteAccessSettingsDoNotRewriteProfileApiKeys(): Promise<void> {
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  let persistedConfig: unknown;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      if (updates.llmProfiles) {
        (config as any).llmProfiles = updates.llmProfiles;
      }
      if (updates.remoteAccessAuth) {
        (config as any).remoteAccessAuth = updates.remoteAccessAuth;
      }
      if (updates.web) {
        (config as any).web = updates.web;
      }
    },
    getToolsetRegistry: () => ({
      get: (name: string) => ({ name }),
    }),
  };
  server.refreshConfigDependentRuntimes = async () => undefined;
  server.persistConfigFile = (nextConfig: unknown) => {
    persistedConfig = nextConfig;
  };
  server.refreshGlobalAgentCatalog = () => undefined;
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'openai-main',
        profiles: [
          {
            id: 'openai-main',
            name: 'OpenAI Main',
            provider: 'openai',
            apiBase: 'https://openai-compatible.local/v1',
            defaultModel: 'gpt-4o-mini',
            maxOutputTokens: 4096,
            contextWindowTokens: null,
            enabled: true,
          },
        ],
        remoteAccessAuth: {
          enabled: true,
          password: 'temporary-remote-password',
          sessionTtlMs: 1234,
          trustProxy: true,
        },
      },
    },
    res
  );

  assert.equal((res.payload as any).success, true);
  assert.equal(config.llmProfiles.profiles[0].apiKey, 'test-api-key');
  assert.equal((persistedConfig as any).llmProfiles.profiles[0].apiKey, 'test-api-key');
  assert.equal(typeof (persistedConfig as any).remoteAccessAuth.passwordHash, 'string');
}

async function testLlmProfilesPutRollsBackContextWindowOverrideWhenRefreshFails(): Promise<void> {
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  let persistedConfig: unknown;
  let updateCalls = 0;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      updateCalls += 1;
      if (updates.llmProfiles) {
        (config as any).llmProfiles = updates.llmProfiles;
      }
    },
  };
  server.refreshConfigDependentRuntimes = async () => {
    throw new Error('refresh failed');
  };
  server.persistConfigFile = (nextConfig: unknown) => {
    persistedConfig = nextConfig;
  };
  server.refreshGlobalAgentCatalog = () => undefined;
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'openai-main',
        profiles: [
          {
            id: 'openai-main',
            name: 'OpenAI Main',
            provider: 'openai',
            apiBase: 'https://openai-compatible.local/v1',
            defaultModel: 'gpt-4o-mini',
            maxOutputTokens: 4096,
            contextWindowTokens: 90000,
            enabled: true,
          },
        ],
      },
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.match(String((res.payload as any).error ?? ''), /refresh failed/i);
  assert.equal(updateCalls, 2);
  assert.equal(config.llmProfiles.profiles[0].contextWindowTokens, 65536);
  assert.equal((persistedConfig as any).llmProfiles.profiles[0].contextWindowTokens, 65536);
}

async function testConfigPostPersistsCanonicalContextBudget(): Promise<void> {
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
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
        agent: {
          ...((updatePayload as { agent?: Record<string, unknown> } | undefined)?.agent ?? {}),
          ...(updates.agent ?? {}),
        },
      };
      config.agent = {
        ...config.agent,
        ...updates.agent,
      };
      if (updates.contextBudget) {
        (config as any).contextBudget = updates.contextBudget;
      }
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
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        completionMarkerEnforcementEnabled: true,
        maxSteps: 42,
        contextBudget: {
          defaultContextWindowTokens: 80000,
          compressionTriggerRatio: 0.5,
          precompressKeepLlmRounds: 8,
          precompressChunkChars: 70000,
          compressionMaxChars: 9000,
        },
      },
    },
    res
  );

  assert.equal((updatePayload as any).agent.completionMarkerEnforcementEnabled, true);
  assert.equal((updatePayload as any).agent.maxSteps, 42);
  assert.equal((updatePayload as any).contextBudget.defaultContextWindowTokens, 80000);
  assert.equal((updatePayload as any).contextBudget.compressionTriggerRatio, 0.5);
  assert.equal((updatePayload as any).contextBudget.precompressKeepLlmRounds, 8);
  assert.equal((updatePayload as any).contextBudget.precompressChunkChars, 70000);
  assert.equal((updatePayload as any).contextBudget.compressionMaxChars, 9000);
  assert.equal(config.agent.completionMarkerEnforcementEnabled, true);
  assert.equal(config.agent.maxSteps, 42);
  assert.equal((config as any).contextBudget.defaultContextWindowTokens, 80000);
  assert.equal(cleanupCalls, 0);
  assert.equal(refreshRuntimeCalls, 1);
  assert.equal((persistedConfig as any).agent.completionMarkerEnforcementEnabled, true);
  assert.equal((persistedConfig as any).agent.maxSteps, 42);
  assert.equal((persistedConfig as any).contextBudget.compressionTriggerRatio, 0.5);
  assert.equal((res.payload as any).success, true);
}

async function testSettingsPutPersistsProfilesAndAgentSettingsAtomically(): Promise<void> {
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  let updatePayload: unknown;
  let refreshRuntimeCalls = 0;
  let persistedConfig: unknown;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      updatePayload = updates;
      if (updates.agent) {
        config.agent = {
          ...config.agent,
          ...updates.agent,
        };
      }
      if (updates.contextBudget) {
        (config as any).contextBudget = updates.contextBudget;
      }
      if (updates.remoteAccessAuth) {
        (config as any).remoteAccessAuth = updates.remoteAccessAuth;
      }
      if (updates.web) {
        (config as any).web = updates.web;
      }
      if (updates.llmProfiles) {
        (config as any).llmProfiles = updates.llmProfiles;
      }
    },
    getToolsetRegistry: () => ({
      get: (name: string) => ({ name }),
    }),
    reloadSkills: () => undefined,
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
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'openai-main',
        profiles: [
          {
            id: 'openai-main',
            name: 'OpenAI Main',
            provider: 'openai',
            apiBase: 'https://openai-compatible.local/v1',
            defaultModel: 'gpt-4o-mini',
            maxOutputTokens: 8192,
            contextWindowTokens: 90000,
            enabled: true,
          },
        ],
        maxSteps: 55,
        contextBudget: {
          defaultContextWindowTokens: 88000,
          compressionTriggerRatio: 0.8,
        },
        remoteAccessAuth: {
          enabled: true,
          password: 'new-secret',
          sessionTtlMs: 60000,
          trustProxy: true,
        },
        web: {
          sessionShareTtlHours: 72,
        },
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal((res.payload as any).success, true);
  assert.equal(refreshRuntimeCalls, 1);
  assert.equal((updatePayload as any).agent.maxSteps, 55);
  assert.equal((updatePayload as any).contextBudget.defaultContextWindowTokens, 88000);
  assert.equal((updatePayload as any).llmProfiles.profiles[0].contextWindowTokens, 90000);
  assert.equal((updatePayload as any).remoteAccessAuth.enabled, true);
  assert.equal(typeof (updatePayload as any).remoteAccessAuth.passwordHash, 'string');
  assert.equal((updatePayload as any).web.sessionShareTtlHours, 72);
  assert.equal((persistedConfig as any).agent.maxSteps, 55);
  assert.equal((persistedConfig as any).web.sessionShareTtlHours, 72);
  assert.equal((persistedConfig as any).llmProfiles.profiles[0].contextWindowTokens, 90000);
  assert.equal((res.payload as any).llmProfiles.profiles[0].contextWindowTokens, 90000);
  assert.equal((res.payload as any).web.sessionShareTtlHours, 72);
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
    assert.doesNotMatch(fs.readFileSync(configPath, 'utf8'), /^api:/m);

    const reader = new ConfigManager();
    reader.loadFromYaml(configPath);
    assert.equal(reader.get().agent.completionMarkerEnforcementEnabled, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testConfigPostRejectsInvalidProvider(): Promise<void> {
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
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
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'openai-main',
        profiles: [
          {
            id: 'openai-main',
            provider: 'custom-provider',
          },
        ],
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
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
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
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

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
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  (config as any).remoteAccessAuth = {
    enabled: true,
    passwordHash: 'hash',
    passwordSalt: 'salt',
    sessionTtlMs: 1234,
    trustProxy: true,
  };
  (config as any).web = {
    downloadLinkTtlMs: 1000,
    sessionShareTtlHours: 36,
  };
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
      if (Object.prototype.hasOwnProperty.call(updates, 'contextBudget')) {
        (config as any).contextBudget = updates.contextBudget;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'remoteAccessAuth')) {
        (config as any).remoteAccessAuth = updates.remoteAccessAuth;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'web')) {
        (config as any).web = updates.web;
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
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        maxSteps: 77,
        skillsDir: 'D:/mutated-skills',
        globalAgentsDir: 'D:/mutated-agents',
        contextBudget: {
          defaultContextWindowTokens: 120000,
          compressionTriggerRatio: 0.6,
          precompressKeepLlmRounds: 9,
          precompressChunkChars: 70000,
          compressionMaxChars: 9000,
        },
        remoteAccessAuth: {
          enabled: false,
          sessionTtlMs: 5678,
          trustProxy: false,
        },
        web: {
          sessionShareTtlHours: 6,
        },
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
  assert.equal(config.agent.maxSteps, 100);
  assert.equal(config.agent.skillsDir, undefined);
  assert.equal((config as any).contextBudget.defaultContextWindowTokens, 57500);
  assert.equal((config as any).remoteAccessAuth.enabled, true);
  assert.equal((config as any).remoteAccessAuth.sessionTtlMs, 1234);
  assert.equal((config as any).remoteAccessAuth.trustProxy, true);
  assert.equal((config as any).web.sessionShareTtlHours, 36);
  assert.equal((persistedConfig as any).agent.maxSteps, 100);
  assert.equal((persistedConfig as any).agent.skillsDir, undefined);
  assert.equal((persistedConfig as any).contextBudget.defaultContextWindowTokens, 57500);
  assert.equal((persistedConfig as any).remoteAccessAuth.enabled, true);
  assert.equal((persistedConfig as any).web.sessionShareTtlHours, 36);
}

async function testSettingsPutRejectsMalformedProfileEntries(): Promise<void> {
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  let updateCalls = 0;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: () => {
      updateCalls += 1;
    },
    getToolsetRegistry: () => ({
      get: (name: string) => ({ name }),
    }),
  };
  server.refreshConfigDependentRuntimes = async () => undefined;
  server.persistConfigFile = () => undefined;
  server.refreshGlobalAgentCatalog = () => undefined;
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        profiles: [null],
      },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(String((res.payload as any).error ?? ''), /Profile at index 0 must be an object/i);
  assert.equal(updateCalls, 0);
}

async function testApiKeyPostRefreshesConfigRuntimesWithoutAgentCleanup(): Promise<void> {
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  let cleanupCalls = 0;
  let refreshRuntimeCalls = 0;
  let persistedConfig: unknown;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
      if (updates.llmProfiles) {
        (config as any).llmProfiles = updates.llmProfiles;
      }
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
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'openai-main',
        profiles: [
          {
            id: 'openai-main',
            apiKey: 'sk-test-api-key-1234567890',
          },
        ],
      },
    },
    res
  );

  assert.equal(config.llmProfiles.profiles[0].apiKey, 'sk-test-api-key-1234567890');
  assert.equal(cleanupCalls, 0);
  assert.equal(refreshRuntimeCalls, 1);
  assert.equal((persistedConfig as any).llmProfiles.profiles[0].apiKey, 'sk-test-api-key-1234567890');
  assert.equal((res.payload as any).success, true);
}

async function testApiKeyPostRollsBackWhenRefreshFails(): Promise<void> {
  const server = createWebServerDouble();
  const { app, putRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  let refreshRuntimeCalls = 0;
  let persistedConfig: unknown;
  (server as any).bootMissingApiKey = true;

  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => config,
    updateConfig: (updates: any) => {
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
  server.refreshGlobalAgentCatalog = () => undefined;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = putRoutes.get('/api/settings');
  assert.ok(handler, 'expected PUT /api/settings route');

  const res = createResponseRecorder();
  await handler?.(
    {
      body: {
        defaultProfileId: 'openai-main',
        profiles: [
          {
            id: 'openai-main',
            apiKey: 'sk-mutated-api-key-1234567890',
          },
        ],
      },
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.match(String((res.payload as any).error ?? ''), /refresh failed/i);
  assert.equal(refreshRuntimeCalls, 1);
  assert.equal(config.llmProfiles.profiles[0].apiKey, 'test-api-key');
  assert.equal((persistedConfig as any).llmProfiles.profiles[0].apiKey, 'test-api-key');
  assert.equal((server as any).bootMissingApiKey, true);
}

async function testConfigRuntimeRefreshDoesNotCancelActiveSessionRuntime(): Promise<void> {
  const server = createWebServerDouble();
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
    getConfig: () => createBaseConfig(),
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

async function testConfigRuntimeRefreshDoesNotFailWhenAsrRefreshFails(): Promise<void> {
  const server = createWebServerDouble();
  let rootCleanupCalls = 0;
  let asrRefreshCalls = 0;
  server.activeRunContexts = new Map();
  server.activeRunStatesByContext = new Map();
  server.cancelingRunIds = new Set();
  server.sessionRuntimes = new Map();
  server.agent = {
    cleanup: async () => {
      rootCleanupCalls += 1;
    },
    getConfig: () => createBaseConfig(),
  };
  server.asrRuntime = {
    refresh: async () => {
      asrRefreshCalls += 1;
      throw new Error('asr refresh failed');
    },
  };

  await server.refreshConfigDependentRuntimes();

  assert.equal(rootCleanupCalls, 1);
  assert.equal(asrRefreshCalls, 1);
}

async function testAutoLoopToggleCannotBypassPendingPlanConfirmation(): Promise<void> {
  const server = createWebServerDouble();
  server.activeRunContexts = new Map();
  server.activeRunStatesByContext = new Map();
  server.cancelingRunIds = new Set();
  const { app, postRoutes } = createRouteAppHarness();
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
  const server = createWebServerDouble();
  server.activeRunContexts = new Map();
  server.activeRunStatesByContext = new Map();
  server.cancelingRunIds = new Set();
  const { app, postRoutes } = createRouteAppHarness();
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
  server.ensureTodoDrivenAutoLoop = server.ensureTodoDrivenAutoLoop.bind(server);
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
  const server = createWebServerDouble();
  server.activeRunContexts = new Map();
  server.activeRunStatesByContext = new Map();
  server.cancelingRunIds = new Set();
  const { app, postRoutes } = createRouteAppHarness();
  const config = createBaseConfig();
  const createCalls: Array<Record<string, unknown>> = [];
  const planSetCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<{ id: string; input: Record<string, unknown> }> = [];
  const clearCompletedCalls: Array<Record<string, unknown>> = [];
  const deleteCalls: Array<{ id: string; input: Record<string, unknown> }> = [];
  const dismissCalls: Array<{ id: string; input: Record<string, unknown> }> = [];
  const resumeCalls: Array<{ id: string; input: Record<string, unknown> }> = [];
  const ensureTodoLoopCalls: Array<{ sessionId: string; workspaceDir?: string }> = [];

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
      dismissTodo: (id: string, input: Record<string, unknown>) => {
        dismissCalls.push({ id, input });
        return { id, status: 'dismissed', ...input };
      },
      resumeTodo: (id: string, input: Record<string, unknown>) => {
        resumeCalls.push({ id, input });
        return { id, status: 'pending', ...input };
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
  server.ensureTodoDrivenAutoLoop = (sessionId: string, workspaceDir?: string) => {
    ensureTodoLoopCalls.push({ sessionId, workspaceDir });
  };
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
  return {
    postRoutes,
    createCalls,
    planSetCalls,
    updateCalls,
    clearCompletedCalls,
    deleteCalls,
    dismissCalls,
    resumeCalls,
    ensureTodoLoopCalls,
  };
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

async function testTodoPostSupportsUserDismissAndResumeActions(): Promise<void> {
  const { postRoutes, dismissCalls, resumeCalls, ensureTodoLoopCalls } = createTodoRouteServerHarness();
  const updateHandler = postRoutes.get('/api/todos/:id');
  assert.ok(updateHandler, 'expected POST /api/todos/:id route');

  const dismissRes = createResponseRecorder();
  await updateHandler?.(
    {
      params: { id: 'todo-dismiss' },
      body: {
        action: 'dismiss',
        sessionId: 'sess-1',
      },
    },
    dismissRes
  );
  assert.equal(dismissRes.statusCode, 200);
  assert.equal(dismissCalls.length, 1);
  assert.equal(dismissCalls[0]?.id, 'todo-dismiss');
  assert.equal(ensureTodoLoopCalls.length, 1);
  assert.equal(ensureTodoLoopCalls[0]?.sessionId, 'sess-1');

  const resumeRes = createResponseRecorder();
  await updateHandler?.(
    {
      params: { id: 'todo-resume' },
      body: {
        action: 'resume',
        sessionId: 'sess-1',
      },
    },
    resumeRes
  );
  assert.equal(resumeRes.statusCode, 200);
  assert.equal(resumeCalls.length, 1);
  assert.equal(resumeCalls[0]?.id, 'todo-resume');
  assert.equal(ensureTodoLoopCalls.length, 2);
  assert.equal(ensureTodoLoopCalls[1]?.sessionId, 'sess-1');
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
  testConfigRoutesExposeCanonicalProfiles();
  testLegacyApiConfigMigratesIntoDefaultLlmProfileOnSave();
  testSystemRoutesRegisterOnce();
  await testWorkspaceTimelineSettingsRoundTrip();
  await testLlmProfilesPutPersistsProfileContextWindowOverride();
  await testRemoteAccessSettingsDoNotRewriteProfileApiKeys();
  await testLlmProfilesPutRollsBackContextWindowOverrideWhenRefreshFails();
  await testConfigPostPersistsCanonicalContextBudget();
  await testSettingsPutPersistsProfilesAndAgentSettingsAtomically();
  await testConfigPostValidationIsAtomic();
  await testConfigPostRollsBackWhenRefreshFails();
  await testSettingsPutRejectsMalformedProfileEntries();
  await testApiKeyPostRefreshesConfigRuntimesWithoutAgentCleanup();
  await testApiKeyPostRollsBackWhenRefreshFails();
  await testConfigRuntimeRefreshDoesNotCancelActiveSessionRuntime();
  await testConfigRuntimeRefreshDoesNotFailWhenAsrRefreshFails();
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
  await testTodoPostSupportsUserDismissAndResumeActions();
  await testTodoPostRejectsCamelCaseTodoAliases();
  await testTodoPostRejectsCrossActionFields();
  testConfigManagerPersistsCompletionMarkerSetting();
  console.log('web-config-provider tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
