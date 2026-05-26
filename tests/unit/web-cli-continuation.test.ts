import * as assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { ContextRef, MCPServerConfig, ResolvedLlmRuntimeConfig } from '../../src/types.js';
import { createWebServerDouble } from './helpers/web-server-harness.js';
import { createWebServerTestConfig } from './web-server-test-config.js';

const context: ContextRef = { scope: 'session', namespace: 'sess-cli' };

function createRuntime(): ResolvedLlmRuntimeConfig {
  return {
    profileId: 'kimi',
    provider: 'anthropic',
    apiKey: 'sk-test',
    apiBase: 'https://api.kimi.com/coding/',
    model: 'kimi-coding',
    maxOutputTokens: 32768,
    reasoningPreset: 'high',
    capabilities: {
      reasoningEffort: false,
      thinkingBudget: true,
    },
  };
}

function testScheduledContinuationKeepsCliOwnership(): void {
  const server = createWebServerDouble();
  const emitted: Record<string, unknown>[] = [];
  const runtime = createRuntime();
  server.activeRunContexts = new Map();
  server.activeRunStatesByContext = new Map();
  server.getContextNamespaceMetaSafe = () => ({
    lastRunOrigin: 'cli',
  });
  server.getSessionRuntime = () => ({ llmRuntime: runtime });
  server.emitRunEvent = (_ws: unknown, _context: ContextRef, message: Record<string, unknown>) => {
    emitted.push(message);
  };

  const runOrigin = server.resolveContinuationRunOrigin(context);
  const scaffold = server.startScheduledCallbackContinuation(
    { readyState: WebSocket.OPEN },
    context,
    { stop: () => undefined },
    runtime,
    runOrigin
  );

  assert.notEqual(scaffold, null);
  const activeRun = server.getActiveRunState(context);
  assert.equal(activeRun.owner, 'cli');
  assert.equal(activeRun.origin, 'cli');
  assert.equal(activeRun.interactionState.mode, 'observe_only');
  assert.equal((emitted[0]?.data as Record<string, unknown>).owner, 'cli');
  assert.deepEqual((emitted[0]?.data as Record<string, unknown>).interactionState, {
    mode: 'observe_only',
    reason: 'cli_active_run',
    owner: 'cli',
  });
}

async function testScheduledContinuationRestoresCliExternalMcpAttachment(): Promise<void> {
  const server = createWebServerDouble();
  const runtime = createRuntime();
  const externalMcpServers: MCPServerConfig[] = [
    {
      name: 'teamtool',
      type: 'stdio',
      command: 'node',
      args: ['teamtool.js'],
    },
  ];
  let capturedExternalMcpServers: MCPServerConfig[] | undefined;
  server.agent = {
    getConfig: () => createWebServerTestConfig(),
  };
  server.getContextNamespaceMetaSafe = () => ({
    runtimeAttachment: {
      externalMcpServers,
      externalMcpServerNames: ['teamtool'],
      externalMcpFingerprint: 'fp',
      updatedAt: '2026-05-03T00:00:00.000Z',
    },
  });
  server.resolveWorkspaceDirForContext = () => 'D:\\repo';
  server.ensureSessionRuntime = async (
    _sessionId: string,
    _workspaceDir: string,
    _llmRuntime?: ResolvedLlmRuntimeConfig,
    _llmSelection?: unknown,
    nextExternalMcpServers?: MCPServerConfig[]
  ) => {
    capturedExternalMcpServers = nextExternalMcpServers;
  };
  server.getSessionRuntime = () => ({ llmRuntime: runtime });

  const preparedRuntime = await server.prepareScheduledCallbackContinuationRuntime(context);

  assert.equal(preparedRuntime, runtime);
  assert.deepEqual(capturedExternalMcpServers, [
    {
      ...externalMcpServers[0],
      env: undefined,
    },
  ]);
  assert.notEqual(capturedExternalMcpServers, externalMcpServers);
}

async function testScheduledContinuationPreparesRuntimeFromLatestSessionSelection(): Promise<void> {
  const server = createWebServerDouble();
  const config = createWebServerTestConfig({
    llmProfiles: {
      defaultProfileId: 'anthropic-default',
      profiles: [
        {
          id: 'anthropic-default',
          name: 'Anthropic Default',
          provider: 'anthropic',
          apiKey: 'sk-test',
          apiBase: 'https://api.example.test',
          defaultModel: 'MiniMax-M2.7',
          maxOutputTokens: 4096,
        },
        {
          id: 'openai-alt',
          name: 'OpenAI Alt',
          provider: 'openai',
          apiKey: 'sk-test',
          apiBase: 'https://api.openai.example.test',
          defaultModel: 'gpt-5-mini',
          availableModels: ['gpt-5-mini', 'gpt-5.1-codex'],
          maxOutputTokens: 8192,
          capabilities: {
            reasoningEffort: true,
          },
        },
      ],
    },
  });
  let capturedRuntime: ResolvedLlmRuntimeConfig | undefined;
  let capturedSelection: unknown;
  server.agent = {
    getConfig: () => config,
  };
  server.sessionRuntimes = new Map();
  server.getContextNamespaceMetaSafe = () => ({
    llmSelection: {
      profileId: 'openai-alt',
      model: 'gpt-5.1-codex',
      reasoningPreset: 'high',
      updatedAt: '2026-05-03T12:00:00.000Z',
    },
  });
  server.resolveWorkspaceDirForContext = () => 'D:\\repo';
  server.resolveContinuationExternalMcpServers = () => [];
  server.cloneExternalMcpServers = (servers: MCPServerConfig[]) => servers;
  server.ensureSessionRuntime = async (
    sessionId: string,
    workspaceDir: string,
    llmRuntime?: ResolvedLlmRuntimeConfig,
    llmSelection?: unknown
  ) => {
    capturedRuntime = llmRuntime;
    capturedSelection = llmSelection;
    server.sessionRuntimes.set(sessionId, {
      llmRuntime,
      workspaceDir,
    });
  };
  server.getSessionRuntime = (sessionId: string) => server.sessionRuntimes.get(sessionId);

  const preparedRuntime = await server.prepareScheduledCallbackContinuationRuntime(context);

  assert.equal((capturedSelection as { model?: string } | undefined)?.model, 'gpt-5.1-codex');
  assert.equal(capturedRuntime?.model, 'gpt-5.1-codex');
  assert.equal(preparedRuntime?.model, 'gpt-5.1-codex');
}

testScheduledContinuationKeepsCliOwnership();
testScheduledContinuationRestoresCliExternalMcpAttachment()
  .then(() => testScheduledContinuationPreparesRuntimeFromLatestSessionSelection())
  .then(() => {
    console.log('web-cli-continuation tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
