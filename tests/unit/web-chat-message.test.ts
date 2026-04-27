import * as assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { WebServer } from '../../src/web/server/WebServer.js';
import { autoLoopManager } from '../../src/auto-loop/index.js';
import type { ContextRef, ResolvedLlmRuntimeConfig, SessionLlmSelection } from '../../src/types.js';

interface EmittedMessage {
  ws: object;
  type: string;
  data: unknown;
}

class TrackingRunContextMap extends Map<string, ContextRef> {
  constructor(
    private readonly lifecycle: string[],
    entries?: ReadonlyArray<readonly [string, ContextRef]>
  ) {
    super();
    if (entries) {
      for (const [key, value] of entries) {
        super.set(key, value);
      }
    }
  }

  override set(key: string, value: ContextRef): this {
    this.lifecycle.push(`active:set:${key}`);
    return super.set(key, value);
  }

  override delete(key: string): boolean {
    this.lifecycle.push(`active:delete:${key}`);
    return super.delete(key);
  }
}

interface ChatHarness {
  server: any;
  openSocket: { readyState: number; socket: string };
  emitted: EmittedMessage[];
  lifecycle: string[];
  setControllerFactory: (factory: (key: string, config?: unknown) => unknown) => void;
  restore: () => void;
}

const TEST_API_KEY = 'sk-test-12345678901234567890';

function createTestLlmSelection(
  overrides: Partial<SessionLlmSelection> = {}
): SessionLlmSelection {
  return {
    profileId: 'legacy-default',
    model: 'MiniMax-M2.5',
    reasoningPreset: 'off',
    updatedAt: '2026-04-24T00:00:00.000Z',
    ...overrides,
  };
}

function createTestLlmRuntime(
  overrides: Partial<ResolvedLlmRuntimeConfig> = {}
): ResolvedLlmRuntimeConfig {
  return {
    profileId: 'legacy-default',
    provider: 'anthropic',
    apiKey: TEST_API_KEY,
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.5',
    maxOutputTokens: 4096,
    reasoningPreset: 'off',
    capabilities: {
      reasoningEffort: false,
      thinkingBudget: true,
    },
    ...overrides,
  };
}

function createTestConfig(workspaceDir = 'D:\\default'): Record<string, unknown> {
  return {
    api: {
      apiKey: TEST_API_KEY,
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.5',
      provider: 'anthropic',
      maxOutputTokens: 4096,
    },
    llmProfiles: {
      defaultProfileId: 'legacy-default',
      profiles: [
        {
          id: 'legacy-default',
          name: 'Default Profile',
          provider: 'anthropic',
          apiKey: TEST_API_KEY,
          apiBase: 'https://api.minimaxi.com',
          defaultModel: 'MiniMax-M2.5',
          maxOutputTokens: 4096,
          capabilities: {
            modelDiscovery: true,
            reasoningEffort: false,
            thinkingBudget: true,
          },
          updatedAt: '2026-04-24T00:00:00.000Z',
        },
      ],
    },
    agent: {
      workspaceDir,
    },
    tools: {},
    mcp: {
      enabled: false,
      servers: [],
    },
    retry: {},
  };
}

function createSessionRuntimeRecord(agent: object, workspaceDir: string): Record<string, unknown> {
  return {
    agent,
    workspaceDir,
    runtimeKey: `runtime:${workspaceDir}`,
    llmRuntime: createTestLlmRuntime(),
    lastUsedAt: new Date().toISOString(),
  };
}

function createHarness(
  activeEntries?: ReadonlyArray<readonly [string, ContextRef]>
): ChatHarness {
  const server = Object.create(WebServer.prototype) as any;
  const emitted: EmittedMessage[] = [];
  const lifecycle: string[] = [];
  const originalGetOrCreate = autoLoopManager.getOrCreate;

  server.currentSessionId = null;
  server.sessionRuntimes = new Map();
  server.activeRunContexts = new TrackingRunContextMap(lifecycle, activeEntries);
  server.activeRunStatesByContext = new Map();
  server.cancelingRunIds = new Set();
  server.emitToClient = (ws: object, message: Omit<EmittedMessage, 'ws'>) => {
    lifecycle.push(`emit:${message.type}`);
    emitted.push({ ws, ...message });
  };
  server.refreshGlobalAgentCatalog = () => {
    lifecycle.push('refresh');
  };
  server.cleanupDirtySessionRuntimeIfIdle = async () => undefined;
  server.ensureSessionRuntime = async (sessionId: string, workspaceDir: string) => {
    lifecycle.push(`ensure:${sessionId}:${workspaceDir}`);
    server.sessionRuntimes.set(sessionId, createSessionRuntimeRecord(server.agent, workspaceDir));
    return {
      agent: server.agent,
      reused: false,
    };
  };

  return {
    server,
    openSocket: { readyState: WebSocket.OPEN, socket: 'open' },
    emitted,
    lifecycle,
    setControllerFactory: (factory: (key: string, config?: unknown) => unknown) => {
      (autoLoopManager as any).getOrCreate = factory;
    },
    restore: () => {
      (autoLoopManager as any).getOrCreate = originalGetOrCreate;
    },
  };
}

async function testActivateTrackedRunRegistersContextAndEmitsChatStarted(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const harness = createHarness();
  const dispatcher = harness.server.createRunScopedDispatcher(harness.openSocket, context, 'run-1');

  harness.server.activateTrackedRun('run-1', context, dispatcher);

  assert.deepEqual(harness.lifecycle, ['active:set:run-1', 'emit:chat_started']);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'chat_started',
      data: {
        runId: 'run-1',
        context,
        startedAt: (harness.emitted[0].data as { startedAt: string }).startedAt,
      },
    },
  ]);
  assert.equal(harness.server.activeRunContexts.get('run-1'), context);
  assert.deepEqual(harness.server.getActiveRunState(context), {
    runId: 'run-1',
    runFamilyId: undefined,
    draftId: undefined,
    context,
    startedAt: (harness.server.getActiveRunState(context) as { startedAt: string }).startedAt,
    llmRuntime: undefined,
  });
}

async function testExecuteTrackedRunSuccessRunsAgentAndCleansUp(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const harness = createHarness([['run-1', context]]);
  let runArgs: Record<string, unknown> | null = null;
  let updatedState: { context: ContextRef; next: Record<string, unknown> } | null = null;

  harness.server.agent = {
    runWithResult: async (args: Record<string, unknown>) => {
      harness.lifecycle.push('runWithResult');
      runArgs = args;
      return {
        content: 'done',
        context,
        turnId: 'turn-1',
        contextVersion: 1,
      };
    },
  };
  harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';
  harness.server.updateAgentInjectionState = (nextContext: ContextRef, next: Record<string, unknown>) => {
    harness.lifecycle.push('updateAgentInjectionState');
    updatedState = { context: nextContext, next };
  };

  await harness.server.executeTrackedRun({
    runId: 'run-1',
    context,
    dispatcher: {
      error: (error: string) => {
        harness.lifecycle.push(`error:${error}`);
      },
    },
    refreshCatalogOnFinish: true,
    resolveRunInput: () => ({
      prompt: 'resolved prompt',
      workspaceDir: 'D:\\repo',
      agentInjectionStateUpdate: {
        lastProfileName: 'Reviewer',
      },
      callback: { kind: 'callback' },
    }),
  });

  assert.deepEqual(runArgs, {
    prompt: 'resolved prompt',
    runId: 'run-1',
    context,
    workspaceDir: 'D:\\repo',
    callback: { kind: 'callback' },
    additionalSystemPrompt: 'AUTO_LOOP_SYSTEM_PROMPT',
  });
  assert.deepEqual(updatedState, {
    context,
    next: {
      lastProfileName: 'Reviewer',
    },
  });
  assert.deepEqual(harness.lifecycle, ['runWithResult', 'updateAgentInjectionState', 'active:delete:run-1', 'refresh']);
  assert.equal(harness.server.activeRunContexts.size, 0);
}

async function testExecuteTrackedRunCarriesResumeMetadataAndEmitsRunTerminal(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const harness = createHarness([['run-2', context]]);
  let runArgs: Record<string, unknown> | null = null;
  let terminalState: Record<string, unknown> | null = null;

  harness.server.agent = {
    runWithResult: async (args: Record<string, unknown>) => {
      harness.lifecycle.push('runWithResult');
      runArgs = args;
      return {
        content: 'Recovered output',
        context,
        turnId: 'turn-2',
        contextVersion: 5,
        runId: 'run-2',
        runFamilyId: 'family-2',
        terminalState: {
          runId: 'run-2',
          runFamilyId: 'family-2',
          draftId: 'draft-2',
          terminalCode: 'cancelled',
          resumable: true,
          resumeToken: 'resume-2',
          lastSafeStep: 55,
          maxSteps: 100,
          replayCutoffKind: 'checkpoint',
          errorSummary: null,
          createdAt: '2026-04-26T10:00:00.000Z',
          artifact: null,
        },
      };
    },
  };
  harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';

  await harness.server.executeTrackedRun({
    runId: 'run-2',
    context,
    dispatcher: {
      error: (error: string) => {
        harness.lifecycle.push(`error:${error}`);
      },
      runTerminal: (state: Record<string, unknown>) => {
        assert.equal(harness.server.activeRunContexts.size, 0);
        assert.equal(harness.server.activeRunStatesByContext.size, 0);
        harness.lifecycle.push('runTerminal');
        terminalState = state;
      },
    },
    refreshCatalogOnFinish: true,
    resolveRunInput: () => ({
      prompt: 'resume prompt',
      workspaceDir: 'D:\\repo',
      callback: { kind: 'callback' },
      runFamilyId: 'family-2',
      resumeRequested: true,
      resumeToken: 'resume-2',
      rawUserPrompt: 'Resume interrupted run',
      historyUserPrompt: 'Original task',
      effectivePrompt: 'Original task',
      promptReference: '@resume',
      hasSystemPromptInjection: true,
    }),
  });

  assert.deepEqual(runArgs, {
    prompt: 'resume prompt',
    runId: 'run-2',
    runFamilyId: 'family-2',
    resumeRequested: true,
    resumeToken: 'resume-2',
    rawUserPrompt: 'Resume interrupted run',
    historyUserPrompt: 'Original task',
    effectivePrompt: 'Original task',
    promptReference: '@resume',
    hasSystemPromptInjection: true,
    context,
    workspaceDir: 'D:\\repo',
    callback: { kind: 'callback' },
    additionalSystemPrompt: 'AUTO_LOOP_SYSTEM_PROMPT',
  });
  assert.deepEqual(terminalState, {
    runId: 'run-2',
    runFamilyId: 'family-2',
    draftId: 'draft-2',
    terminalCode: 'cancelled',
    resumable: true,
    resumeToken: 'resume-2',
    lastSafeStep: 55,
    maxSteps: 100,
    replayCutoffKind: 'checkpoint',
    errorSummary: null,
    createdAt: '2026-04-26T10:00:00.000Z',
    artifact: null,
  });
  assert.deepEqual(harness.lifecycle, ['runWithResult', 'active:delete:run-2', 'refresh', 'runTerminal']);
}

async function testExecuteTrackedRunFailurePrefersStructuredRunTerminal(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const harness = createHarness([['run-3', context]]);
  let terminalState: Record<string, unknown> | null = null;

  harness.server.agent = {
    runWithResult: async () => {
      harness.lifecycle.push('runWithResult');
      const error = new Error('read ECONNRESET') as Error & {
        terminalState?: Record<string, unknown>;
      };
      error.terminalState = {
        runId: 'run-3',
        runFamilyId: 'family-3',
        draftId: 'draft-3',
        terminalCode: 'error',
        resumable: true,
        resumeToken: 'resume-3',
        lastSafeStep: 44,
        maxSteps: 100,
        replayCutoffKind: 'checkpoint',
        errorSummary: 'read ECONNRESET',
        createdAt: '2026-04-26T11:00:00.000Z',
        artifact: null,
      };
      throw error;
    },
  };
  harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';

  await harness.server.executeTrackedRun({
    runId: 'run-3',
    context,
    dispatcher: {
      error: (error: string) => {
        harness.lifecycle.push(`error:${error}`);
      },
      runTerminal: (state: Record<string, unknown>) => {
        assert.equal(harness.server.activeRunContexts.size, 0);
        assert.equal(harness.server.activeRunStatesByContext.size, 0);
        harness.lifecycle.push('runTerminal');
        terminalState = state;
      },
    },
    refreshCatalogOnFinish: true,
    stopControllerOnError: {
      stop: (reason: string) => {
        harness.lifecycle.push(`stopController:${reason}`);
      },
    },
    resolveRunInput: () => ({
      prompt: 'resume prompt',
      workspaceDir: 'D:\\repo',
      callback: { kind: 'callback' },
    }),
  });

  assert.deepEqual(terminalState, {
    runId: 'run-3',
    runFamilyId: 'family-3',
    draftId: 'draft-3',
    terminalCode: 'error',
    resumable: true,
    resumeToken: 'resume-3',
    lastSafeStep: 44,
    maxSteps: 100,
    replayCutoffKind: 'checkpoint',
    errorSummary: 'read ECONNRESET',
    createdAt: '2026-04-26T11:00:00.000Z',
    artifact: null,
  });
  assert.deepEqual(harness.lifecycle, [
    'runWithResult',
    'active:delete:run-3',
    'refresh',
    'runTerminal',
    'stopController:error',
  ]);
}

async function testPrepareChatExecutionPromptFailureEmitsErrorAndRefreshes(): Promise<void> {
  const harness = createHarness();

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => undefined,
  };
  harness.server.resolveUserPrompt = () => ({
    ok: false,
    error: 'prompt_invalid',
  });

  const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
    prompt: '',
    sessionId: 'sess-1',
  });

  assert.equal(prepared, null);
  assert.equal(harness.server.currentSessionId, 'sess-1');
  assert.deepEqual(harness.lifecycle, ['emit:error', 'refresh']);
  assert.equal(harness.server.activeRunContexts.size, 0);
  const firstMessage = harness.emitted[0];
  assert.equal(firstMessage.ws, harness.openSocket);
  assert.equal(firstMessage.type, 'error');
  assert.equal((firstMessage.data as { context: ContextRef }).context.namespace, 'sess-1');
  assert.equal((firstMessage.data as { error: string }).error, 'prompt_invalid');
  assert.match((firstMessage.data as { runId: string }).runId, /^run-/);
}

async function testPrepareChatExecutionMissingApiKeyEmitsErrorAndRefreshes(): Promise<void> {
  const harness = createHarness();

  harness.server.agent = {
    getConfig: () => ({
      ...createTestConfig(),
      api: {
        apiKey: '',
        apiBase: 'https://api.minimaxi.com',
        model: 'MiniMax-M2.5',
        provider: 'anthropic',
        maxOutputTokens: 4096,
      },
      llmProfiles: {
        defaultProfileId: 'legacy-default',
        profiles: [
          {
            id: 'legacy-default',
            name: 'Default Profile',
            provider: 'anthropic',
            apiKey: '',
            apiBase: 'https://api.minimaxi.com',
            defaultModel: 'MiniMax-M2.5',
            maxOutputTokens: 4096,
            capabilities: {
              modelDiscovery: true,
              reasoningEffort: false,
              thinkingBudget: true,
            },
            updatedAt: '2026-04-24T00:00:00.000Z',
          },
        ],
      },
    }),
    getContextNamespaceMeta: () => undefined,
  };
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved prompt',
    displayPrompt: 'Hello',
    hasSystemPromptInjection: true,
  });
  harness.server.createCallback = () => {
    throw new Error('createCallback should not be reached when API key is missing');
  };

  const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
    prompt: 'Hello',
    sessionId: 'sess-1',
  });

  assert.equal(prepared, null);
  assert.equal(harness.server.currentSessionId, 'sess-1');
  assert.deepEqual(harness.lifecycle, ['emit:error', 'refresh']);
  assert.equal(harness.server.activeRunContexts.size, 0);
  const firstMessage = harness.emitted[0];
  assert.equal(firstMessage.type, 'error');
  assert.equal(
    (firstMessage.data as { error: string }).error,
    'API Key is not configured. Please open Settings and save a valid API Key first.'
  );
}

async function testPrepareChatExecutionRejectsDirtyRootRuntimeWhileRootRunActive(): Promise<void> {
  const activeContext: ContextRef = { scope: 'workspace', namespace: 'repo-active' };
  const harness = createHarness([['run-active-root', activeContext]]);

  harness.server.rootRuntimeConfigDirty = true;
  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => undefined,
    initialize: async () => {
      throw new Error('initialize should not run while root runtime cleanup is blocked');
    },
  };
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved prompt',
    displayPrompt: 'Hello',
    hasSystemPromptInjection: true,
  });

  const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
    prompt: 'Hello',
    context: { scope: 'workspace', namespace: 'repo-next' },
  });

  assert.equal(prepared, null);
  assert.deepEqual(harness.lifecycle, ['emit:error']);
  assert.equal(harness.server.activeRunContexts.size, 1);
  assert.match(
    (harness.emitted[0].data as { error: string }).error,
    /Configuration update is waiting for the active workspace run/i
  );
}

async function testPrepareChatExecutionRejectsConcurrentRunInSameSession(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const harness = createHarness([['run-active', context]]);

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => undefined,
  };
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved prompt',
    displayPrompt: 'Hello',
    hasSystemPromptInjection: true,
  });
  harness.server.ensureSessionRuntime = async () => {
    throw new Error('ensureSessionRuntime should not run when the session already has an active run');
  };

  const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
    prompt: 'Hello',
    sessionId: 'sess-1',
  });

  assert.equal(prepared, null);
  assert.deepEqual(harness.lifecycle, ['emit:error']);
  assert.equal((harness.emitted[0].data as { error: string }).error, 'Session already has an active run. Wait for it to finish or cancel it first.');
}

async function testPrepareChatExecutionReusesSessionRuntimeWithoutReinitializing(): Promise<void> {
  const harness = createHarness();
  const sessionAgent = {
    initialized: false,
    getContextNamespaceMeta: () => undefined,
    initialize: async () => {
      if (sessionAgent.initialized) {
        return;
      }
      sessionAgent.initialized = true;
      harness.lifecycle.push('initialize:session');
    },
  };

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => undefined,
  };
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved prompt',
    displayPrompt: 'Hello',
    hasSystemPromptInjection: true,
  });
  harness.server.createCallback = (_ws: object, _context: ContextRef, runId: string) => {
    harness.lifecycle.push(`createCallback:${runId}`);
    return { kind: 'callback', runId };
  };
  harness.server.ensureSessionRuntime = async (sessionId: string, workspaceDir: string) => {
    const existing = harness.server.sessionRuntimes.get(sessionId);
    if (existing) {
      harness.lifecycle.push(`ensure:${sessionId}:${workspaceDir}:reuse`);
      return {
        agent: existing.agent,
        reused: true,
      };
    }
    harness.lifecycle.push(`ensure:${sessionId}:${workspaceDir}:new`);
    harness.server.sessionRuntimes.set(sessionId, createSessionRuntimeRecord(sessionAgent, workspaceDir));
    return {
      agent: sessionAgent,
      reused: false,
    };
  };
  harness.setControllerFactory(() => ({
    getConfig: () => ({
      enabled: false,
    }),
    getState: () => ({
      isRunning: false,
    }),
  }));

  try {
    const first = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Hello',
      sessionId: 'sess-1',
      workspaceDir: 'D:\\repo',
    });
    assert.notEqual(first, null);
    harness.server.finalizeTrackedRun(first?.runId ?? '');

    const second = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Again',
      sessionId: 'sess-1',
      workspaceDir: 'D:\\repo',
    });

    assert.notEqual(second, null);
    assert.equal(harness.server.sessionRuntimes.size, 1);
    assert.deepEqual(
      harness.lifecycle.filter((entry: string) => entry === 'initialize:session'),
      ['initialize:session']
    );
    assert.equal(
      harness.lifecycle.some((entry: string) => entry === 'ensure:sess-1:D:\\repo:reuse'),
      true
    );
  } finally {
    harness.restore();
  }
}

async function testPrepareChatExecutionAllowsMultipleSessionsInSameWorkspace(): Promise<void> {
  const harness = createHarness();
  const runtimeBySession = new Map<string, { agent: { getContextNamespaceMeta: () => undefined; initialize: () => Promise<void> } }>();

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => undefined,
  };
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved prompt',
    displayPrompt: 'Hello',
    hasSystemPromptInjection: true,
  });
  harness.server.createCallback = (_ws: object, context: ContextRef, runId: string) => ({
    session: context.namespace,
    runId,
  });
  harness.server.ensureSessionRuntime = async (sessionId: string, workspaceDir: string) => {
    let runtime = runtimeBySession.get(sessionId);
    if (!runtime) {
      const runtimeAgent = {
        getContextNamespaceMeta: () => undefined,
        initialize: async () => {
          harness.lifecycle.push(`initialize:${sessionId}`);
        },
      };
      runtime = { agent: runtimeAgent };
      runtimeBySession.set(sessionId, runtime);
      harness.server.sessionRuntimes.set(sessionId, createSessionRuntimeRecord(runtimeAgent, workspaceDir));
    }
    harness.lifecycle.push(`ensure:${sessionId}:${workspaceDir}`);
    return {
      agent: runtime.agent,
      reused: false,
    };
  };
  harness.setControllerFactory(() => ({
    getConfig: () => ({
      enabled: false,
    }),
    getState: () => ({
      isRunning: false,
    }),
  }));

  try {
    const preparedA = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Hello A',
      sessionId: 'sess-a',
      workspaceDir: 'D:\\repo',
    });
    const preparedB = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Hello B',
      sessionId: 'sess-b',
      workspaceDir: 'D:\\repo',
    });

    assert.notEqual(preparedA, null);
    assert.notEqual(preparedB, null);
    assert.equal(harness.server.sessionRuntimes.size, 2);
    assert.equal(harness.server.sessionRuntimes.get('sess-a')?.workspaceDir, 'D:\\repo');
    assert.equal(harness.server.sessionRuntimes.get('sess-b')?.workspaceDir, 'D:\\repo');
    assert.notEqual(
      harness.server.sessionRuntimes.get('sess-a')?.agent,
      harness.server.sessionRuntimes.get('sess-b')?.agent
    );
  } finally {
    harness.restore();
  }
}

async function testPrepareChatExecutionUsesRequestedLlmSelectionForRuntime(): Promise<void> {
  const harness = createHarness();
  const config = createTestConfig() as any;
  config.llmProfiles.profiles.push({
    id: 'openai-alt',
    name: 'OpenAI Alt',
    provider: 'openai',
    apiKey: 'sk-openai-12345678901234567890',
    apiBase: 'https://openai.local/v1',
    defaultModel: 'gpt-4.1-mini',
    maxOutputTokens: 2048,
    capabilities: {
      modelDiscovery: true,
      reasoningEffort: true,
      thinkingBudget: false,
    },
    updatedAt: '2026-04-24T01:00:00.000Z',
  });
  let capturedEnsureArgs: Record<string, unknown> | null = null;

  harness.server.agent = {
    getConfig: () => config,
    getContextNamespaceMeta: () => undefined,
    initialize: async () => {
      harness.lifecycle.push('initialize');
    },
  };
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved prompt',
    displayPrompt: 'Hello',
    hasSystemPromptInjection: true,
  });
  harness.server.createCallback = (_ws: object, _context: ContextRef, runId: string) => {
    harness.lifecycle.push(`createCallback:${runId}`);
    return { kind: 'callback', runId };
  };
  harness.server.ensureSessionRuntime = async (
    sessionId: string,
    workspaceDir: string,
    llmRuntime: ResolvedLlmRuntimeConfig,
    llmSelection: SessionLlmSelection
  ) => {
    capturedEnsureArgs = {
      sessionId,
      workspaceDir,
      llmRuntime,
      llmSelection,
    };
    harness.lifecycle.push(`ensure:${sessionId}:${workspaceDir}:${llmRuntime.profileId}:${llmRuntime.model}`);
    harness.server.sessionRuntimes.set(sessionId, {
      ...createSessionRuntimeRecord(harness.server.agent, workspaceDir),
      runtimeKey: `runtime:${llmRuntime.profileId}:${llmRuntime.model}`,
      llmRuntime,
    });
    return {
      agent: harness.server.agent,
      reused: false,
    };
  };
  harness.setControllerFactory(() => ({
    getConfig: () => ({
      enabled: false,
    }),
    getState: () => ({
      isRunning: false,
    }),
  }));

  try {
    const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Hello',
      sessionId: 'sess-llm',
      workspaceDir: 'D:\\repo',
      llmSelection: {
        profileId: 'openai-alt',
        reasoningPreset: 'high',
        providerOptions: {
          openai: {
            reasoningEffort: 'high',
          },
        },
      },
    });

    assert.notEqual(prepared, null);
    assert.equal(prepared?.llmSelection?.profileId, 'openai-alt');
    assert.equal(prepared?.llmSelection?.model, 'gpt-4.1-mini');
    assert.equal(prepared?.llmRuntime.profileId, 'openai-alt');
    assert.equal(prepared?.llmRuntime.provider, 'openai');
    assert.equal(prepared?.llmRuntime.reasoningPreset, 'high');
    assert.deepEqual(capturedEnsureArgs, {
      sessionId: 'sess-llm',
      workspaceDir: 'D:\\repo',
      llmRuntime: prepared?.llmRuntime,
      llmSelection: prepared?.llmSelection,
    });
  } finally {
    harness.restore();
  }
}

async function testPrepareChatExecutionUsesPersistedSessionLlmSelectionWhenRequestOmitsOverride(): Promise<void> {
  const harness = createHarness();
  const config = createTestConfig() as any;
  config.llmProfiles.profiles.push({
    id: 'openai-alt',
    name: 'OpenAI Alt',
    provider: 'openai',
    apiKey: 'sk-openai-12345678901234567890',
    apiBase: 'https://openai.local/v1',
    defaultModel: 'gpt-4.1-mini',
    maxOutputTokens: 2048,
    capabilities: {
      modelDiscovery: true,
      reasoningEffort: true,
      thinkingBudget: false,
    },
    updatedAt: '2026-04-24T01:00:00.000Z',
  });
  let capturedProfileId = '';

  harness.server.agent = {
    getConfig: () => config,
    getContextNamespaceMeta: () => undefined,
    initialize: async () => undefined,
  };
  harness.server.getContextNamespaceMetaSafe = () => ({
    llmSelection: createTestLlmSelection({
      profileId: 'openai-alt',
      model: 'gpt-4.1-mini',
      reasoningPreset: 'high',
      providerOptions: {
        openai: {
          reasoningEffort: 'high',
        },
      },
      updatedAt: '2026-04-24T01:00:00.000Z',
    }),
  });
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved prompt',
    displayPrompt: 'Hello',
    hasSystemPromptInjection: true,
  });
  harness.server.createCallback = () => ({ kind: 'callback' });
  harness.server.ensureSessionRuntime = async (
    sessionId: string,
    workspaceDir: string,
    llmRuntime: ResolvedLlmRuntimeConfig
  ) => {
    capturedProfileId = llmRuntime.profileId;
    harness.server.sessionRuntimes.set(sessionId, {
      ...createSessionRuntimeRecord(harness.server.agent, workspaceDir),
      llmRuntime,
    });
    return {
      agent: harness.server.agent,
      reused: false,
    };
  };
  harness.setControllerFactory(() => ({
    getConfig: () => ({
      enabled: false,
    }),
    getState: () => ({
      isRunning: false,
    }),
  }));

  try {
    const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Hello',
      sessionId: 'sess-persisted',
      workspaceDir: 'D:\\repo',
    });

    assert.notEqual(prepared, null);
    assert.equal(prepared?.llmSelection?.profileId, 'openai-alt');
    assert.equal(prepared?.llmRuntime.profileId, 'openai-alt');
    assert.equal(capturedProfileId, 'openai-alt');
  } finally {
    harness.restore();
  }
}

function testCloneRuntimeConfigPinsSelectedProfileAsLegacyMirrorSource(): void {
  const harness = createHarness();
  const config = createTestConfig() as any;
  config.llmProfiles.profiles.push({
    id: 'openai-alt',
    name: 'OpenAI Alt',
    provider: 'openai',
    apiKey: 'sk-openai-12345678901234567890',
    apiBase: 'https://openai.local/v1',
    defaultModel: 'gpt-4.1-mini',
    maxOutputTokens: 2048,
    capabilities: {
      modelDiscovery: true,
      reasoningEffort: true,
      thinkingBudget: false,
    },
    updatedAt: '2026-04-24T01:00:00.000Z',
  });
  harness.server.agent = {
    getConfig: () => config,
  };

  const cloned = harness.server.cloneRuntimeConfig(
    'D:\\repo',
    createTestLlmRuntime({
      profileId: 'openai-alt',
      provider: 'openai',
      apiKey: 'sk-openai-12345678901234567890',
      apiBase: 'https://openai.local/v1',
      model: 'gpt-4.1-mini',
      maxOutputTokens: 2048,
      capabilities: {
        reasoningEffort: true,
        thinkingBudget: false,
      },
    })
  );

  assert.equal(cloned.api.provider, 'openai');
  assert.equal(cloned.api.model, 'gpt-4.1-mini');
  assert.equal(cloned.llmProfiles.defaultProfileId, 'openai-alt');
  assert.equal(cloned.llmProfiles.profiles.find((profile: { id: string }) => profile.id === 'openai-alt')?.apiKey, 'sk-openai-12345678901234567890');
}

function testBuildSessionRuntimeKeyIncludesLlmRuntimeShape(): void {
  const harness = createHarness();
  harness.server.agent = {
    getConfig: () => createTestConfig(),
  };
  const keyA = harness.server.buildSessionRuntimeKey(
    'D:\\repo',
    createTestLlmSelection(),
    createTestLlmRuntime()
  );
  const keyB = harness.server.buildSessionRuntimeKey(
    'D:\\repo',
    createTestLlmSelection({
      profileId: 'legacy-default',
      model: 'MiniMax-M2.5-Reasoning',
      reasoningPreset: 'high',
    }),
    createTestLlmRuntime({
      model: 'MiniMax-M2.5-Reasoning',
      reasoningPreset: 'high',
    })
  );

  assert.notEqual(keyA, keyB);
  assert.equal(
    keyA,
    harness.server.buildSessionRuntimeKey(
      'D:\\repo',
      createTestLlmSelection(),
      createTestLlmRuntime()
    )
  );
}

async function testHandleChatMessageShortCircuitsWhenPreparationFails(): Promise<void> {
  const harness = createHarness();
  const request = {
    prompt: 'Hello',
    sessionId: 'sess-1',
  };

  harness.server.prepareChatExecution = async (ws: unknown, nextRequest: unknown) => {
    harness.lifecycle.push('prepareChatExecution');
    assert.equal(ws, harness.openSocket);
    assert.deepEqual(nextRequest, request);
    return null;
  };
  harness.server.executePreparedChatRun = async () => {
    harness.lifecycle.push('executePreparedChatRun');
  };

  await harness.server.handleChatMessage(harness.openSocket, request);

  assert.deepEqual(harness.lifecycle, ['prepareChatExecution']);
}

async function testHandleChatMessageBubblesPreparationExceptions(): Promise<void> {
  const harness = createHarness();
  const request = {
    prompt: 'Hello',
    sessionId: 'sess-1',
  };

  harness.server.prepareChatExecution = async (ws: unknown, nextRequest: unknown) => {
    harness.lifecycle.push('prepareChatExecution');
    assert.equal(ws, harness.openSocket);
    assert.deepEqual(nextRequest, request);
    throw new Error('prepare_failed');
  };
  harness.server.executePreparedChatRun = async () => {
    harness.lifecycle.push('executePreparedChatRun');
  };

  await assert.rejects(harness.server.handleChatMessage(harness.openSocket, request), /prepare_failed/);

  assert.deepEqual(harness.lifecycle, ['prepareChatExecution']);
}

async function testHandleChatMessagePassesPreparedExecutionThroughIntact(): Promise<void> {
  const harness = createHarness();
  const request = {
    prompt: 'Hello',
    sessionId: 'sess-1',
  };
  const prepared = {
    request,
    context: { scope: 'session', namespace: 'sess-1' } as ContextRef,
    runId: 'run-1',
    effectivePrompt: 'resolved prompt',
    callback: { kind: 'callback' },
    dispatcher: { error: (_error: string) => undefined },
  };
  let capturedPrepared: unknown = null;

  harness.server.prepareChatExecution = async (ws: unknown, nextRequest: unknown) => {
    harness.lifecycle.push('prepareChatExecution');
    assert.equal(ws, harness.openSocket);
    assert.deepEqual(nextRequest, request);
    return prepared;
  };
  harness.server.executePreparedChatRun = async (nextPrepared: unknown) => {
    harness.lifecycle.push('executePreparedChatRun');
    capturedPrepared = nextPrepared;
  };

  await harness.server.handleChatMessage(harness.openSocket, request);

  assert.deepEqual(harness.lifecycle, ['prepareChatExecution', 'executePreparedChatRun']);
  assert.equal(capturedPrepared, prepared);
}

async function testHandleWSMessageChatRunsFullExtractedChain(): Promise<void> {
  const harness = createHarness();
  const autoLoopConfig = { enabled: true, maxRounds: 4 };
  let runArgs: Record<string, unknown> | null = null;

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => ({
      autoLoopConfig,
    }),
    initialize: async () => {
      harness.lifecycle.push('initialize');
    },
    runWithResult: async (args: Record<string, unknown>) => {
      harness.lifecycle.push('runWithResult');
      runArgs = args;
      return {
        content: 'done',
        context: { scope: 'session', namespace: 'sess-1' },
        turnId: 'turn-1',
        contextVersion: 1,
      };
    },
  };
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved prompt',
    displayPrompt: 'Hello',
    hasSystemPromptInjection: true,
  });
  harness.server.createCallback = (ws: object, context: ContextRef, runId: string) => {
    harness.lifecycle.push(`createCallback:${runId}`);
    return { ws, context, runId };
  };
  harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';
  harness.setControllerFactory(() => ({
    getConfig: () => ({
      enabled: true,
    }),
    getState: () => ({
      isRunning: false,
    }),
    start: () => {
      harness.lifecycle.push('autoLoop:start');
    },
  }));

  try {
    await harness.server.handleWSMessage(harness.openSocket, {
      type: 'chat',
      data: {
        prompt: 'Hello',
        sessionId: 'sess-1',
      },
    });

    const chatStarted = harness.emitted[0];
    const runId = (chatStarted.data as { runId: string }).runId;
    assert.equal(harness.server.currentSessionId, 'sess-1');
    assert.deepEqual(harness.lifecycle, [
      'ensure:sess-1:D:\\default',
      `createCallback:${runId}`,
      'initialize',
      `active:set:${runId}`,
      'emit:chat_started',
      'autoLoop:start',
      'runWithResult',
      `active:delete:${runId}`,
      'refresh',
    ]);
    assert.deepEqual(chatStarted, {
      ws: harness.openSocket,
      type: 'chat_started',
      data: {
        runId,
        context: {
          scope: 'session',
          namespace: 'sess-1',
        },
        startedAt: (chatStarted.data as { startedAt: string }).startedAt,
        llmRuntime: {
          profileId: 'legacy-default',
          provider: 'anthropic',
          model: 'MiniMax-M2.5',
          reasoningPreset: 'off',
        },
      },
    });
  assert.deepEqual(runArgs, {
    prompt: 'resolved prompt',
    runId,
    rawUserPrompt: 'Hello',
    effectivePrompt: 'resolved prompt',
    hasSystemPromptInjection: true,
    context: {
      scope: 'session',
        namespace: 'sess-1',
      },
      workspaceDir: 'D:\\default',
      callback: {
        ws: harness.openSocket,
        context: {
          scope: 'session',
          namespace: 'sess-1',
        },
        runId,
      },
      additionalSystemPrompt: 'AUTO_LOOP_SYSTEM_PROMPT',
    });
  } finally {
    harness.restore();
  }
}

async function testPrepareChatExecutionSuccessInitializesRunAndStartsAutoLoop(): Promise<void> {
  const harness = createHarness();
  const autoLoopConfig = { enabled: true, maxRounds: 4 };
  let capturedAutoLoopKey = '';
  let capturedAutoLoopConfig: unknown = null;

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => ({
      autoLoopConfig,
    }),
    initialize: async () => {
      harness.lifecycle.push('initialize');
    },
  };
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved prompt',
    displayPrompt: 'Hello',
    hasSystemPromptInjection: true,
  });
  harness.server.createCallback = (_ws: object, _context: ContextRef, runId: string) => {
    harness.lifecycle.push(`createCallback:${runId}`);
    return { kind: 'callback', runId };
  };
  harness.setControllerFactory((key: string, config?: unknown) => {
    capturedAutoLoopKey = key;
    capturedAutoLoopConfig = config ?? null;
    return {
      getConfig: () => ({
        enabled: true,
      }),
      getState: () => ({
        isRunning: false,
      }),
      start: () => {
        harness.lifecycle.push('autoLoop:start');
      },
    };
  });

  try {
    const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Hello',
      sessionId: 'sess-1',
      workspaceDir: 'D:\\repo',
    });

    assert.notEqual(prepared, null);
    assert.equal(prepared?.effectivePrompt, 'resolved prompt');
    assert.equal(prepared?.context.namespace, 'sess-1');
    assert.equal(prepared?.request.workspaceDir, 'D:\\repo');
    assert.equal(harness.server.currentSessionId, 'sess-1');
    const runId = prepared?.runId ?? '';
    assert.match(runId, /^run-/);
    assert.deepEqual(harness.lifecycle, [
      'ensure:sess-1:D:\\repo',
      `createCallback:${runId}`,
      'initialize',
      `active:set:${runId}`,
      'emit:chat_started',
      'autoLoop:start',
    ]);
    assert.equal(capturedAutoLoopKey, 'sess-1');
    assert.equal(capturedAutoLoopConfig, autoLoopConfig);
    assert.deepEqual(harness.emitted[0], {
      ws: harness.openSocket,
      type: 'chat_started',
      data: {
        runId,
        context: {
          scope: 'session',
          namespace: 'sess-1',
        },
        startedAt: (harness.emitted[0].data as { startedAt: string }).startedAt,
        llmRuntime: {
          profileId: 'legacy-default',
          provider: 'anthropic',
          model: 'MiniMax-M2.5',
          reasoningPreset: 'off',
        },
      },
    });
  } finally {
    harness.restore();
  }
}

async function testPrepareChatExecutionPlanModeKeepsTodoLoopPending(): Promise<void> {
  const harness = createHarness();
  let meta: Record<string, unknown> = {
    autoLoopConfig: {
      enabled: true,
      mode: 'ralph',
      ralphEnabled: true,
      maxRounds: 4,
    },
  };
  let resolvedUsePlanMode: unknown = undefined;
  let hasUnfinishedTodos = false;
  let controllerConfig: Record<string, unknown> = {
    enabled: true,
    mode: 'ralph',
    ralphEnabled: true,
    maxRounds: 4,
  };

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => meta,
    updateContextNamespaceMeta: (_context: ContextRef, patch: Record<string, unknown>) => {
      meta = {
        ...meta,
        ...patch,
      };
    },
    getTodoStore: () => ({
      getProtocolState: () => ({
        items: hasUnfinishedTodos ? [{ id: 'todo-1', status: 'pending' }] : [],
        unfinishedItems: hasUnfinishedTodos ? [{ id: 'todo-1', status: 'pending' }] : [],
        activeItem: null,
        blockedItem: null,
        pendingItems: hasUnfinishedTodos ? [{ id: 'todo-1', status: 'pending' }] : [],
        completedItems: [],
        hasUnfinished: hasUnfinishedTodos,
        allCompleted: !hasUnfinishedTodos,
      }),
    }),
    initialize: async () => {
      harness.lifecycle.push('initialize');
    },
  };
  harness.server.resolveUserPrompt = (input: { usePlanMode?: boolean }) => {
    resolvedUsePlanMode = input.usePlanMode;
    return {
      ok: true,
      effectivePrompt: 'resolved plan prompt',
      displayPrompt: 'Plan',
      hasSystemPromptInjection: false,
    };
  };
  harness.server.createCallback = (_ws: object, _context: ContextRef, runId: string) => {
    harness.lifecycle.push(`createCallback:${runId}`);
    return { kind: 'callback', runId };
  };
  harness.setControllerFactory(() => ({
    getConfig: () => controllerConfig,
    updateConfig: (next: Record<string, unknown>) => {
      controllerConfig = {
        ...controllerConfig,
        ...next,
      };
    },
    getState: () => ({
      isRunning: false,
      currentRound: 0,
    }),
    start: () => {
      harness.lifecycle.push('autoLoop:start');
    },
    stop: () => {
      harness.lifecycle.push('autoLoop:stop');
    },
  }));

  try {
    const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Plan',
      sessionId: 'sess-plan',
      workspaceDir: 'D:\\repo',
      usePlanMode: true,
    });

    assert.notEqual(prepared, null);
    assert.equal(resolvedUsePlanMode, true);
    const persistedConfig = (meta.autoLoopConfig ?? {}) as Record<string, unknown>;
    assert.equal(persistedConfig.enabled, false);
    assert.equal(persistedConfig.mode, 'todo');
    assert.equal(persistedConfig.ralphEnabled, true);
    assert.equal(persistedConfig.pendingPlanConfirmation, true);
    assert.equal(controllerConfig.enabled, false);
    assert.equal(controllerConfig.mode, 'todo');
    assert.equal(controllerConfig.ralphEnabled, true);
    assert.equal(controllerConfig.pendingPlanConfirmation, true);

    hasUnfinishedTodos = true;
    harness.server.ensureTodoDrivenAutoLoop('sess-plan', 'D:\\repo');
    assert.equal(controllerConfig.enabled, false);
    assert.equal(controllerConfig.mode, 'todo');
    assert.equal(controllerConfig.ralphEnabled, true);
    assert.equal(controllerConfig.pendingPlanConfirmation, true);
    assert.equal(harness.lifecycle.includes('autoLoop:start'), false);

    meta = {
      ...meta,
      pendingPlanInput: {
        runId: 'run-plan',
        requestId: 'req-plan',
        requestedAt: '2026-04-27T00:00:00.000Z',
        questions: [],
      },
    };
    let answered = false;
    harness.server.pendingPlanInputByRunId = new Map([
      [
        'run-plan',
        {
          context: { scope: 'session', namespace: 'sess-plan' },
          request: { requestId: 'req-plan', questions: [] },
          ws: harness.openSocket,
          resolve: () => {
            answered = true;
          },
          reject: () => undefined,
        },
      ],
    ]);
    harness.server.completePlanInputResponse(
      {
        runId: 'run-plan',
        requestId: 'req-plan',
        pending: harness.server.pendingPlanInputByRunId.get('run-plan'),
      },
      []
    );
    assert.equal(answered, true);
    assert.equal((meta.pendingPlanInput as unknown) ?? null, null);
    assert.equal(((meta.autoLoopConfig ?? {}) as Record<string, unknown>).pendingPlanConfirmation, false);
    assert.equal(controllerConfig.pendingPlanConfirmation, false);
    assert.equal(controllerConfig.enabled, true);
    assert.equal(controllerConfig.mode, 'todo');
  } finally {
    harness.restore();
  }
}

async function testPlanModeCompletionWithoutInputKeepsPendingConfirmation(): Promise<void> {
  const harness = createHarness();
  let meta: Record<string, unknown> = {
    autoLoopConfig: {
      enabled: true,
      mode: 'ralph',
      ralphEnabled: true,
      maxRounds: 4,
    },
  };
  let controllerConfig: Record<string, unknown> = {
    enabled: true,
    mode: 'ralph',
    ralphEnabled: true,
    maxRounds: 4,
  };

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => meta,
    updateContextNamespaceMeta: (_context: ContextRef, patch: Record<string, unknown>) => {
      meta = {
        ...meta,
        ...patch,
      };
    },
    getTodoStore: () => ({
      getProtocolState: () => ({
        items: [],
        unfinishedItems: [],
        activeItem: null,
        blockedItem: null,
        pendingItems: [],
        completedItems: [],
        hasUnfinished: false,
        allCompleted: true,
      }),
    }),
    initialize: async () => undefined,
  };
  harness.server.resolveUserPrompt = () => ({
    ok: true,
    effectivePrompt: 'resolved plan prompt',
    displayPrompt: 'Plan',
    hasSystemPromptInjection: false,
  });
  harness.server.createCallback = () => ({ kind: 'callback' });
  harness.setControllerFactory(() => ({
    getConfig: () => controllerConfig,
    updateConfig: (next: Record<string, unknown>) => {
      controllerConfig = {
        ...controllerConfig,
        ...next,
      };
    },
    getState: () => ({
      isRunning: false,
      currentRound: 0,
    }),
    start: () => undefined,
    stop: () => undefined,
    shouldContinue: () => ({ shouldContinue: false }),
  }));

  try {
    const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Plan',
      sessionId: 'sess-plan-no-input',
      workspaceDir: 'D:\\repo',
      usePlanMode: true,
    });

    assert.notEqual(prepared, null);
    const runId = prepared?.runId ?? '';
    assert.ok(runId);
    assert.equal(((meta.autoLoopConfig ?? {}) as Record<string, unknown>).pendingPlanConfirmation, true);
    harness.server.pendingPlanInputByRunId = new Map();
    await harness.server.handleCallbackCompletion(
      harness.openSocket,
      { scope: 'session', namespace: 'sess-plan-no-input' },
      runId,
      'sess-plan-no-input',
      'done',
      {
        complete: () => undefined,
        autoLoopStopped: () => undefined,
        autoLoopRound: () => undefined,
      },
      'end_turn'
    );
    assert.equal(((meta.autoLoopConfig ?? {}) as Record<string, unknown>).pendingPlanConfirmation, true);
    assert.equal(controllerConfig.pendingPlanConfirmation, true);
  } finally {
    harness.restore();
  }
}

async function testExecutePreparedChatRunSuccessRunsAgentAndCleansUp(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const harness = createHarness([['run-1', context]]);
  let runArgs: Record<string, unknown> | null = null;

  harness.server.agent = {
    runWithResult: async (args: Record<string, unknown>) => {
      harness.lifecycle.push('runWithResult');
      runArgs = args;
      return {
        content: 'done',
        context,
        turnId: 'turn-1',
        contextVersion: 1,
      };
    },
  };
  harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';

  await harness.server.executePreparedChatRun({
    request: {
      prompt: 'Hello',
      workspaceDir: 'D:\\repo',
    },
    context,
    runId: 'run-1',
    workspaceDir: 'D:\\repo',
    effectivePrompt: 'resolved prompt',
    callback: { kind: 'callback' },
    dispatcher: {
      error: (error: string) => {
        harness.lifecycle.push(`error:${error}`);
      },
    },
  });

  assert.deepEqual(runArgs, {
    prompt: 'resolved prompt',
    runId: 'run-1',
    context,
    workspaceDir: 'D:\\repo',
    callback: { kind: 'callback' },
    additionalSystemPrompt: 'AUTO_LOOP_SYSTEM_PROMPT',
  });
  assert.deepEqual(harness.lifecycle, ['runWithResult', 'active:delete:run-1', 'refresh']);
  assert.equal(harness.server.activeRunContexts.size, 0);
}

async function testExecutePreparedChatRunFailureEmitsErrorAndCleansUp(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const harness = createHarness([['run-1', context]]);
  let updateCount = 0;
  let persistedPatch: Record<string, unknown> | null = null;

  harness.server.agent = {
    runWithResult: async () => {
      harness.lifecycle.push('runWithResult');
      throw new Error('run_failed');
    },
  };
  harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';
  harness.server.updateAgentInjectionState = () => {
    updateCount += 1;
    harness.lifecycle.push('updateAgentInjectionState');
  };
  harness.server.updateContextNamespaceMetaSafe = (_context: ContextRef, patch: Record<string, unknown>) => {
    persistedPatch = patch;
  };

  await harness.server.executePreparedChatRun({
    request: {
      prompt: 'Hello',
    },
    context,
    runId: 'run-1',
    llmSelection: createTestLlmSelection({
      profileId: 'openai-alt',
      model: 'gpt-4.1-mini',
      updatedAt: '2026-04-24T02:00:00.000Z',
    }),
    llmRuntime: createTestLlmRuntime({
      profileId: 'openai-alt',
      provider: 'openai',
      model: 'gpt-4.1-mini',
    }),
    effectivePrompt: 'resolved prompt',
    agentInjectionStateUpdate: {
      lastProfileName: 'Reviewer',
    },
    callback: { kind: 'callback' },
    dispatcher: {
      error: (error: string) => {
        assert.equal(harness.server.activeRunContexts.size, 0);
        assert.equal(harness.server.activeRunStatesByContext.size, 0);
        harness.lifecycle.push(`error:${error}`);
      },
    },
  });

  assert.deepEqual(harness.lifecycle, [
    'runWithResult',
    'active:delete:run-1',
    'refresh',
    'error:run_failed',
  ]);
  assert.equal(updateCount, 0);
  assert.equal(harness.server.activeRunContexts.size, 0);
  assert.deepEqual(persistedPatch, {
    llmSelection: createTestLlmSelection({
      profileId: 'openai-alt',
      model: 'gpt-4.1-mini',
      updatedAt: '2026-04-24T02:00:00.000Z',
    }),
  });
}

async function testExecutePreparedChatRunPersistsLlmSelectionAfterSuccess(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const harness = createHarness([['run-1', context]]);
  let persistedPatch: Record<string, unknown> | null = null;

  harness.server.agent = {
    runWithResult: async () => {
      harness.lifecycle.push('runWithResult');
      return {
        content: 'done',
        context,
        turnId: 'turn-1',
        contextVersion: 1,
      };
    },
  };
  harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';
  harness.server.updateContextNamespaceMetaSafe = (_context: ContextRef, patch: Record<string, unknown>) => {
    persistedPatch = patch;
  };

  await harness.server.executePreparedChatRun({
    request: {
      prompt: 'Hello',
      workspaceDir: 'D:\\repo',
    },
    context,
    runId: 'run-1',
    workspaceDir: 'D:\\repo',
    llmSelection: createTestLlmSelection({
      reasoningPreset: 'medium',
    }),
    llmRuntime: createTestLlmRuntime({
      reasoningPreset: 'medium',
    }),
    effectivePrompt: 'resolved prompt',
    callback: { kind: 'callback' },
    dispatcher: {
      error: (error: string) => {
        harness.lifecycle.push(`error:${error}`);
      },
    },
  });

  assert.deepEqual(persistedPatch, {
    llmSelection: createTestLlmSelection({
      reasoningPreset: 'medium',
    }),
  });
}

async function runAll(): Promise<void> {
  await testActivateTrackedRunRegistersContextAndEmitsChatStarted();
  await testExecuteTrackedRunSuccessRunsAgentAndCleansUp();
  await testExecuteTrackedRunCarriesResumeMetadataAndEmitsRunTerminal();
  await testExecuteTrackedRunFailurePrefersStructuredRunTerminal();
  await testPrepareChatExecutionPromptFailureEmitsErrorAndRefreshes();
  await testPrepareChatExecutionMissingApiKeyEmitsErrorAndRefreshes();
  await testPrepareChatExecutionRejectsDirtyRootRuntimeWhileRootRunActive();
  await testPrepareChatExecutionRejectsConcurrentRunInSameSession();
  await testPrepareChatExecutionReusesSessionRuntimeWithoutReinitializing();
  await testPrepareChatExecutionAllowsMultipleSessionsInSameWorkspace();
  await testPrepareChatExecutionUsesRequestedLlmSelectionForRuntime();
  await testPrepareChatExecutionUsesPersistedSessionLlmSelectionWhenRequestOmitsOverride();
  testCloneRuntimeConfigPinsSelectedProfileAsLegacyMirrorSource();
  testBuildSessionRuntimeKeyIncludesLlmRuntimeShape();
  await testHandleChatMessageShortCircuitsWhenPreparationFails();
  await testHandleChatMessageBubblesPreparationExceptions();
  await testHandleChatMessagePassesPreparedExecutionThroughIntact();
  await testHandleWSMessageChatRunsFullExtractedChain();
  await testPrepareChatExecutionSuccessInitializesRunAndStartsAutoLoop();
  await testPrepareChatExecutionPlanModeKeepsTodoLoopPending();
  await testPlanModeCompletionWithoutInputKeepsPendingConfirmation();
  await testExecutePreparedChatRunSuccessRunsAgentAndCleansUp();
  await testExecutePreparedChatRunFailureEmitsErrorAndCleansUp();
  await testExecutePreparedChatRunPersistsLlmSelectionAfterSuccess();
  console.log('web-chat-message tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
