import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { registerWebServerRoutes } from '../../src/web/server/web-server-route-registration.js';
import { Tool, ToolRegistry, createToolsetRegistry } from '../../src/tools/index.js';
import type { AgentConfig, ToolResult } from '../../src/types.js';
import { createResponseRecorder, createRouteAppHarness, type CapturedRoute } from './helpers/web-route-harness.js';

class FakeTool extends Tool {
  constructor(readonly name: string) {
    super();
  }

  get description(): string {
    return `${this.name} fake tool`;
  }

  get parameters(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }

  async execute(): Promise<ToolResult> {
    return { success: true, content: 'ok' };
  }
}

function createRoutes(input: {
  rootDir: string;
  fullAccess?: boolean;
  sharedSessionId?: string | null;
  refreshShouldFail?: boolean;
}) {
  const routeHarness = createRouteAppHarness();

  let persistedConfig: AgentConfig | null = null;
  let shutdownRequested: unknown = null;
  const configManager = new ConfigManager({
    llmProfiles: {
      defaultProfileId: 'default',
      profiles: [
        {
          id: 'default',
          name: 'Default',
          provider: 'anthropic',
          apiKey: 'secret-api-key-1234567890',
          apiBase: 'https://api.example.test',
          defaultModel: 'model-a',
          availableModels: ['model-a'],
          maxOutputTokens: 4096,
          enabled: true,
        },
      ],
    },
    agent: {
      maxSteps: 100,
      tokenLimit: 80000,
      workspaceDir: path.join(input.rootDir, 'workspace'),
      runtimeDataDir: path.join(input.rootDir, 'runtime'),
      globalAgentsDir: path.join(input.rootDir, 'agents'),
      defaultToolset: 'windows-dev',
      subAgentMaxParallelPerParent: 4,
      subAgentGlobalMaxParallel: 10,
    },
    mcp: {
      enabled: false,
      servers: [],
      connectTimeout: 10,
      executeTimeout: 60,
    },
  } as Partial<AgentConfig>);
  let config = configManager.get();
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new FakeTool('read_file'));
  toolRegistry.register(new FakeTool('web_search'));
  toolRegistry.register(new FakeTool('custom_unknown_tool'));

  const agent = {
    getConfig: () => config,
    updateConfig: (updates: Partial<AgentConfig>) => {
      config = new ConfigManager({
        ...config,
        ...updates,
        agent: updates.agent ? { ...config.agent, ...updates.agent } : config.agent,
        llmProfiles: updates.llmProfiles ?? config.llmProfiles,
        mcp: updates.mcp ? { ...config.mcp, ...updates.mcp } : config.mcp,
        toolsets: updates.toolsets ?? config.toolsets,
      } as Partial<AgentConfig>).get();
    },
    getToolsetRegistry: () => createToolsetRegistry(config.agent.defaultToolset, config.toolsets?.custom ?? []),
    listToolsets: () => createToolsetRegistry(config.agent.defaultToolset, config.toolsets?.custom ?? []).list(),
    getToolRegistry: () => toolRegistry,
    getContextManager: () => ({ listNamespaces: () => [] }),
    getContextNamespaceMeta: () => ({}),
    resolveToolsetName: () => config.agent.defaultToolset ?? 'windows-dev',
    getContextMessages: () => [],
    getToolsetPresetStore: () => ({ list: () => ({}), getWorkspacePreset: () => undefined, getTeamPreset: () => undefined }),
    getTodoStore: () => ({
      createTodo: () => ({}),
      updateTodo: () => ({}),
      deleteTodo: () => true,
      listTodos: () => [],
      getProtocolState: () => ({}),
      clearCompletedTodos: () => [],
    }),
    setToolsetPreset: () => ({}),
    clearToolsetPreset: () => true,
    getMemoryStore: () => ({ listEntries: () => [] }),
    getMemoryPromotionState: () => null,
    organizeSessionMemory: async () => ({}),
    listGovernanceAudit: () => [],
    getGovernanceAuditStore: () => ({ append: () => undefined }),
    getMcpStatus: () => ({ enabled: config.mcp.enabled, servers: [] }),
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
      persistConfigFile: (nextConfig) => {
        persistedConfig = nextConfig;
      },
      setBootMissingApiKey: () => undefined,
      refreshConfigDependentRuntimes: async () => {
        if (input.refreshShouldFail) {
          throw new Error('refresh failed');
        }
      },
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
      resolveWorkspaceDirForContext: () => config.agent.workspaceDir,
      resolveAgentForContext: () => agent as any,
      cleanupSessionRuntime: async () => undefined,
    },
    todoServices: {
      ensureTodoDrivenAutoLoop: () => undefined,
      getSessionTodoProtocolState: () => ({} as any),
    },
    authServices: {
      isLoopback: () => input.fullAccess !== false,
      isAuthenticatedForRemoteAccess: () => input.fullAccess !== false,
      handleLogin: () => ({ success: true }),
      handleLogout: () => '',
      getStatus: () => ({ required: false, authenticated: true, local: true, configured: true }),
    },
    accessServices: {
      getSharedAccessSessionId: () => input.sharedSessionId ?? null,
      canAccessSession: () => true,
      hasFullAccess: () => input.fullAccess !== false,
    },
    systemServices: {
      getRuntimeInfo: () => ({
        version: '0.0.0-test',
        pid: 1234,
        cwd: input.rootDir,
        configPath: path.join(input.rootDir, 'config.yaml'),
        port: 53721,
        packageRoot: input.rootDir,
        installMode: 'npm-local',
        packageManager: 'npm',
      }),
      getRuntimeDiagnostics: () => ({
        pid: 1234,
        httpConnections: 2,
        websocketClients: 1,
        activeRunCount: 0,
        eventLoopDelayMs: { mean: 1.5, max: 3 },
      }),
      requestShutdown: (request) => {
        shutdownRequested = request;
      },
    },
  } as any);

  return {
    routes: {
      use: routeHarness.useRoutes,
      get: routeHarness.getRouteList,
      post: routeHarness.postRouteList,
      put: routeHarness.putRouteList,
      patch: routeHarness.patchRouteList,
      delete: routeHarness.deleteRouteList,
    },
    getConfig: () => config,
    getPersistedConfig: () => persistedConfig,
    getShutdownRequested: () => shutdownRequested,
  };
}

function route(routes: CapturedRoute[], target: string): CapturedRoute['handler'] {
  const matched = routes.find((item) => item.path === target);
  assert.ok(matched, `missing route ${target}`);
  return matched.handler;
}

async function testCapabilitiesAndRuntimeInfoDenyShareOnly(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-authoring-share-'));
  try {
    const harness = createRoutes({ rootDir, fullAccess: false, sharedSessionId: 'shared-1' });

    const runtimeRes = createResponseRecorder();
    await route(harness.routes.get, '/api/system/runtime-info')({ method: 'GET', path: '/api/system/runtime-info', query: {} }, runtimeRes);
    assert.equal(runtimeRes.statusCode, 403);
    assert.equal((runtimeRes.body as any).code, 'SHARE_SCOPE_FORBIDDEN');

    const authoringRes = createResponseRecorder();
    await route(harness.routes.get, '/api/agent-authoring/capabilities')(
      { method: 'GET', path: '/api/agent-authoring/capabilities', query: {} },
      authoringRes
    );
    assert.equal(authoringRes.statusCode, 403);
    assert.equal((authoringRes.body as any).code, 'SHARE_SCOPE_FORBIDDEN');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testCapabilitiesRedactSecretsAndExposeSchema(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-authoring-cap-'));
  try {
    const harness = createRoutes({ rootDir });
    const res = createResponseRecorder();
    await route(harness.routes.get, '/api/agent-authoring/capabilities')(
      { method: 'GET', path: '/api/agent-authoring/capabilities', query: {} },
      res
    );
    assert.equal(res.statusCode, 200);
    const body = res.body as any;
    assert.equal(body.globalAgentsDir, path.join(rootDir, 'agents'));
    assert.equal(body.agentYamlSchema.properties.toolsetName.type, 'string');
    assert.equal(body.agentYamlSchema.properties.allowedTools.type, 'array');
    assert.equal(body.llmProfiles.profiles[0].hasApiKey, true);
    assert.equal(body.llmProfiles.profiles[0].apiKey, undefined);
    assert.equal(body.tools.some((tool: { name: string }) => tool.name === 'read_file'), true);
    assert.equal(body.toolsets.some((toolset: { name: string }) => toolset.name === 'windows-dev'), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testAgentAuthoringDryRunAndApply(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-authoring-apply-'));
  try {
    const harness = createRoutes({ rootDir });
    const handler = route(harness.routes.post, '/api/agent-authoring/apply');
    const payload = {
      dryRun: true,
      agent: {
        name: 'Novelist',
        content: '# Novelist\nWrite vivid fiction.',
        config: {
          version: 1,
          description: 'Fiction agent',
          llmProfileId: 'novel-profile',
          llmModel: 'novel-model',
          reasoningPreset: 'medium',
          toolsetName: 'novelist-tools',
          allowedTools: ['read_file', 'web_search'],
          maxSteps: 12,
          timeoutMs: 180000,
          exposeAsSubagent: true,
        },
      },
      llmProfiles: {
        upsert: [
          {
            id: 'novel-profile',
            name: 'Novel Profile',
            provider: 'openai',
            apiKey: 'novel-secret-key-1234567890',
            apiBase: 'https://novel.example/v1',
            defaultModel: 'novel-model',
            availableModels: ['novel-model'],
            maxOutputTokens: 4096,
            enabled: true,
          },
        ],
        defaultProfileId: 'default',
      },
      mcp: {
        enabled: true,
        upsert: [
          {
            name: 'draft-mcp',
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            disabled: true,
          },
        ],
      },
      toolsets: {
        upsert: [
          {
            name: 'novelist-tools',
            description: 'Fiction authoring toolset',
            capabilities: ['file_read', 'web_search'],
          },
        ],
      },
    };

    const dryRunRes = createResponseRecorder();
    await handler({ method: 'POST', path: '/api/agent-authoring/apply', body: payload }, dryRunRes);
    assert.equal(dryRunRes.statusCode, 200);
    assert.equal((dryRunRes.body as any).dryRun, true);
    assert.equal(fs.existsSync(path.join(rootDir, 'agents', 'Novelist', 'AGENTS.md')), false);
    assert.equal(harness.getConfig().llmProfiles.profiles.some((profile) => profile.id === 'novel-profile'), false);

    const applyRes = createResponseRecorder();
    await handler(
      {
        method: 'POST',
        path: '/api/agent-authoring/apply',
        body: { ...payload, dryRun: false, confirm: 'yes' },
      },
      applyRes
    );
    assert.equal(applyRes.statusCode, 200);
    assert.equal((applyRes.body as any).success, true);
    assert.match(fs.readFileSync(path.join(rootDir, 'agents', 'Novelist', 'AGENTS.md'), 'utf8'), /Write vivid fiction/);
    const yamlText = fs.readFileSync(path.join(rootDir, 'agents', 'Novelist', 'agent.yaml'), 'utf8');
    assert.match(yamlText, /toolsetName: novelist-tools/);
    assert.match(yamlText, /allowedTools:/);
    assert.equal(harness.getConfig().llmProfiles.profiles.some((profile) => profile.id === 'novel-profile'), true);
    assert.equal(harness.getConfig().mcp.enabled, true);
    assert.equal(harness.getConfig().mcp.servers.some((server) => server.name === 'draft-mcp'), true);
    assert.equal(harness.getConfig().toolsets?.custom?.some((toolset) => toolset.name === 'novelist-tools'), true);
    assert.ok(harness.getPersistedConfig());
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testAgentAuthoringApplyRollsBackOnRefreshFailure(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-authoring-rollback-'));
  try {
    const harness = createRoutes({ rootDir, refreshShouldFail: true });
    const res = createResponseRecorder();
    await route(harness.routes.post, '/api/agent-authoring/apply')(
      {
        method: 'POST',
        path: '/api/agent-authoring/apply',
        body: {
          confirm: 'yes',
          toolsets: {
            upsert: [
              {
                name: 'novelist-tools',
                description: 'Fiction authoring toolset',
                capabilities: ['file_read'],
              },
            ],
          },
          agent: {
            name: 'Broken',
            content: '# Broken',
            config: { version: 1, toolsetName: 'novelist-tools' },
          },
        },
      },
      res
    );
    assert.equal(res.statusCode, 500);
    assert.equal(fs.existsSync(path.join(rootDir, 'agents', 'Broken', 'AGENTS.md')), false);
    assert.equal(harness.getConfig().toolsets?.custom?.some((toolset) => toolset.name === 'novelist-tools'), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testRuntimeInfoAndShutdown(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-runtime-info-'));
  try {
    const harness = createRoutes({ rootDir });
    const infoRes = createResponseRecorder();
    await route(harness.routes.get, '/api/system/runtime-info')(
      { method: 'GET', path: '/api/system/runtime-info', query: {} },
      infoRes
    );
    assert.equal(infoRes.statusCode, 200);
    assert.equal((infoRes.body as any).version, '0.0.0-test');
    assert.equal((infoRes.body as any).installMode, 'npm-local');

    const healthRes = createResponseRecorder();
    await route(harness.routes.get, '/api/health')(
      { method: 'GET', path: '/api/health', query: {} },
      healthRes
    );
    assert.equal(healthRes.statusCode, 200);
    assert.equal((healthRes.body as any).diagnostics.pid, 1234);
    assert.equal((healthRes.body as any).diagnostics.httpConnections, 2);
    assert.equal((healthRes.body as any).diagnostics.websocketClients, 1);

    const shutdownRes = createResponseRecorder();
    await route(harness.routes.post, '/api/system/shutdown')(
      {
        method: 'POST',
        path: '/api/system/shutdown',
        headers: { 'x-dpagent-shutdown-confirm': 'yes' },
        body: { delayMs: 25, reason: 'unit-test' },
      },
      shutdownRes
    );
    assert.equal(shutdownRes.statusCode, 202);
    assert.deepEqual(harness.getShutdownRequested(), { delayMs: 25, reason: 'unit-test' });

    const deniedRes = createResponseRecorder();
    await route(harness.routes.post, '/api/system/shutdown')(
      { method: 'POST', path: '/api/system/shutdown', headers: {}, body: { delayMs: 25, reason: 'csrf' } },
      deniedRes
    );
    assert.equal(deniedRes.statusCode, 403);
    assert.equal((deniedRes.body as any).code, 'SHUTDOWN_CONFIRMATION_REQUIRED');
    assert.deepEqual(harness.getShutdownRequested(), { delayMs: 25, reason: 'unit-test' });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function runAll(): Promise<void> {
  await testCapabilitiesAndRuntimeInfoDenyShareOnly();
  await testCapabilitiesRedactSecretsAndExposeSchema();
  await testAgentAuthoringDryRunAndApply();
  await testAgentAuthoringApplyRollsBackOnRefreshFailure();
  await testRuntimeInfoAndShutdown();
  console.log('web-agent-authoring-routes tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
