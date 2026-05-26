import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { autoLoopManager } from '../../src/auto-loop/index.js';
import { scanGlobalAgentProfiles } from '../../src/agents/AgentProfiles.js';
import type { ContextRef, ResolvedLlmRuntimeConfig, SessionLlmSelection } from '../../src/types.js';
import {
  createWebServerDouble,
  getPendingPlanInputs,
  replacePendingPlanInputs,
} from './helpers/web-server-harness.js';

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
    profileId: 'default',
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
    profileId: 'default',
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
      defaultProfileId: 'default',
      profiles: [
        {
          id: 'default',
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
  const server = createWebServerDouble();
  const emitted: EmittedMessage[] = [];
  const lifecycle: string[] = [];
  const originalGetOrCreate = autoLoopManager.getOrCreate;

  server.currentSessionId = null;
  server.sessionRuntimes = new Map();
  server.activeRunContexts = new TrackingRunContextMap(lifecycle, activeEntries);
  server.activeRunStatesByContext = new Map();
  server.cancelingRunIds = new Set();
  server.runningInputNextTurnAfterFinalize = new Map();
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
        origin: 'web',
        owner: 'web',
        interactionState: { mode: 'normal', owner: 'web' },
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
    lastActivityAt: (harness.server.getActiveRunState(context) as { lastActivityAt: string }).lastActivityAt,
    currentStep: 0,
    maxSteps: undefined,
    owner: 'web',
    origin: 'web',
    interactionState: { mode: 'normal', owner: 'web' },
    llmRuntime: undefined,
    runningInputQueue: [],
  });
}

async function testWebSocketCloseKeepsNormalActiveRunState(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-disconnect' };
  const harness = createHarness();
  const dispatcher = harness.server.createRunScopedDispatcher(harness.openSocket, context, 'run-disconnect');
  let detachedSocket: unknown = null;
  harness.server.detachPendingPlanInputSocket = (ws: unknown) => {
    harness.lifecycle.push('detachPendingPlanInputSocket');
    detachedSocket = ws;
  };

  harness.server.activateTrackedRun('run-disconnect', context, dispatcher);
  const lifecycle = {
    onClose: (ws: unknown) => {
      harness.server.detachPendingPlanInputSocket(ws);
    },
  };
  lifecycle.onClose(harness.openSocket);

  assert.equal(harness.server.activeRunContexts.get('run-disconnect'), context);
  assert.equal(harness.server.getActiveRunState(context)?.runId, 'run-disconnect');
  assert.equal(detachedSocket, harness.openSocket);
  assert.deepEqual(harness.lifecycle, ['active:set:run-disconnect', 'emit:chat_started', 'detachPendingPlanInputSocket']);
}

async function testRunEventsRefreshActiveRunHydrationSnapshot(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-progress' };
  const harness = createHarness();
  const dispatcher = harness.server.createRunScopedDispatcher(harness.openSocket, context, 'run-progress');

  harness.server.activateTrackedRun('run-progress', context, dispatcher);
  const initialState = harness.server.getActiveRunState(context);
  const startedAt = initialState?.startedAt;
  const initialLastActivityAt = initialState?.lastActivityAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  dispatcher.step(4, 20);
  const activeState = harness.server.getActiveRunState(context);

  assert.notEqual(activeState?.lastActivityAt, initialLastActivityAt);
  assert.deepEqual(activeState, {
    runId: 'run-progress',
    runFamilyId: undefined,
    draftId: undefined,
    context,
    startedAt,
    lastActivityAt: activeState?.lastActivityAt,
    currentStep: 4,
    maxSteps: 20,
    owner: 'web',
    origin: 'web',
    interactionState: { mode: 'normal', owner: 'web' },
    llmRuntime: undefined,
    runningInputQueue: [],
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

async function testExecuteTrackedRunRecoverableCheckpointContinuesTodoLoop(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-recoverable' };
  const harness = createHarness([['run-recoverable', context]]);
  let terminalState: Record<string, unknown> | null = null;
  let scheduled: unknown[] | null = null;
  const controller = {
    getConfig: () => ({
      enabled: true,
      pausedByUser: false,
    }),
    getState: () => ({
      isRunning: true,
      currentRound: 7,
    }),
    shouldContinue: (result: string, options?: { ignoreSimilarity?: boolean }) => {
      assert.match(result, /\[RECOVERABLE_INTERRUPTED_CHECKPOINT\]/);
      assert.equal(options?.ignoreSimilarity, true);
      return { shouldContinue: true };
    },
    stop: (reason: string) => {
      harness.lifecycle.push(`stopController:${reason}`);
    },
  };

  harness.server.agent = {
    getConfig: () => {
      const config = createTestConfig('D:\\repo');
      (config.agent as Record<string, unknown>).completionMarkerEnforcementEnabled = true;
      return config;
    },
    runWithResult: async () => {
      harness.lifecycle.push('runWithResult');
      const error = new Error('read ECONNRESET') as Error & {
        terminalState?: Record<string, unknown>;
      };
      error.terminalState = {
        runId: 'run-recoverable',
        runFamilyId: 'family-recoverable',
        draftId: 'draft-recoverable',
        terminalCode: 'error',
        lastSafeStep: 9,
        maxSteps: 1000,
        replayCutoffKind: 'checkpoint',
        errorSummary: 'read ECONNRESET',
        createdAt: '2026-05-03T15:55:56.000Z',
        artifact: {
          artifactId: 'artifact-recoverable',
          context,
          draftId: 'draft-recoverable',
          turnId: 'turn-recoverable',
          runId: 'run-recoverable',
          runFamilyId: 'family-recoverable',
          terminalCode: 'error',
          replayCutoffKind: 'checkpoint',
          lastSafeStep: 9,
          maxSteps: 1000,
          errorSummary: 'read ECONNRESET',
          createdAt: '2026-05-03T15:55:56.000Z',
          updatedAt: '2026-05-03T15:55:56.000Z',
          previewMessages: [],
          sideEffectLedger: [],
        },
      };
      throw error;
    },
  };
  harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';
  harness.server.resolveWorkspaceDirForContext = () => 'D:\\repo';
  harness.server.ensureTodoDrivenAutoLoop = () => {
    harness.lifecycle.push('ensureTodoLoop');
  };
  harness.server.getApprovedExecutionPlanMarkdown = () => null;
  harness.server.getSessionTodoProtocolState = () => ({
    items: [{ id: 'todo-1', work: 'Continue scaffold', detectionStandard: 'Scaffold is complete.' }],
    unfinishedItems: [
      { id: 'todo-1', work: 'Continue scaffold', detectionStandard: 'Scaffold is complete.' },
    ],
    activeItem: {
      id: 'todo-1',
      work: 'Continue scaffold',
      detectionStandard: 'Scaffold is complete.',
      status: 'in_progress',
    },
    blockedItem: null,
    pendingItems: [],
    completedItems: [],
    hasUnfinished: true,
    allCompleted: false,
  });
  harness.setControllerFactory(() => controller);
  harness.server.scheduleCallbackContinuation = (
    ws: unknown,
    nextContext: unknown,
    nextController: unknown,
    prompt: unknown
  ) => {
    scheduled = [ws, nextContext, nextController, prompt];
  };

  await harness.server.executeTrackedRun({
    runId: 'run-recoverable',
    ownerWs: harness.openSocket,
    context,
    dispatcher: {
      error: (error: string) => {
        harness.lifecycle.push(`error:${error}`);
      },
      runTerminal: (state: Record<string, unknown>) => {
        harness.lifecycle.push('runTerminal');
        terminalState = state;
      },
      autoLoopRound: (round: number, prompt: string) => {
        harness.lifecycle.push(`autoLoopRound:${round}:${prompt.includes('[TODO_LOOP]')}`);
      },
      autoLoopStopped: (reason: string | undefined) => {
        harness.lifecycle.push(`autoLoopStopped:${reason}`);
      },
    },
    stopControllerOnError: controller,
    resolveRunInput: () => ({
      prompt: 'continue',
      workspaceDir: 'D:\\repo',
      callback: { kind: 'callback' },
    }),
  });

  assert.equal(terminalState?.terminalCode, 'error');
  assert.equal(terminalState?.replayCutoffKind, 'checkpoint');
  assert.equal(scheduled?.[0], harness.openSocket);
  assert.equal(scheduled?.[1], context);
  assert.equal(scheduled?.[2], controller);
  assert.match(String(scheduled?.[3] ?? ''), /\[TODO_LOOP\]/);
  assert.deepEqual(harness.lifecycle, [
    'runWithResult',
    'active:delete:run-recoverable',
    'runTerminal',
    'ensureTodoLoop',
    'autoLoopRound:7:true',
  ]);
}

async function testExecuteTrackedRunRecoverableWorkspaceCheckpointContinuesAutoLoop(): Promise<void> {
  const context: ContextRef = { scope: 'workspace', namespace: 'repo-recoverable' };
  const harness = createHarness([['run-workspace-recoverable', context]]);
  let terminalState: Record<string, unknown> | null = null;
  let scheduled: unknown[] | null = null;
  const controller = {
    getConfig: () => ({
      enabled: true,
      pausedByUser: false,
      prompt: 'Keep going.',
    }),
    getState: () => ({
      isRunning: true,
      currentRound: 5,
    }),
    shouldContinue: (result: string, options?: { ignoreSimilarity?: boolean }) => {
      assert.match(result, /\[RECOVERABLE_INTERRUPTED_CHECKPOINT\]/);
      assert.equal(options, undefined);
      return { shouldContinue: true };
    },
    stop: (reason: string) => {
      harness.lifecycle.push(`stopController:${reason}`);
    },
  };

  harness.server.agent = {
    getConfig: () => createTestConfig('D:\\repo'),
    runWithResult: async () => {
      harness.lifecycle.push('runWithResult');
      const error = new Error('read ECONNRESET') as Error & {
        terminalState?: Record<string, unknown>;
      };
      error.terminalState = {
        runId: 'run-workspace-recoverable',
        runFamilyId: 'family-workspace-recoverable',
        draftId: 'draft-workspace-recoverable',
        terminalCode: 'error',
        lastSafeStep: 2,
        maxSteps: 20,
        replayCutoffKind: 'checkpoint',
        errorSummary: 'read ECONNRESET',
        createdAt: '2026-05-03T16:00:00.000Z',
        artifact: {
          artifactId: 'artifact-workspace-recoverable',
          context,
          draftId: 'draft-workspace-recoverable',
          turnId: 'turn-workspace-recoverable',
          runId: 'run-workspace-recoverable',
          runFamilyId: 'family-workspace-recoverable',
          terminalCode: 'error',
          replayCutoffKind: 'checkpoint',
          lastSafeStep: 2,
          maxSteps: 20,
          errorSummary: 'read ECONNRESET',
          createdAt: '2026-05-03T16:00:00.000Z',
          updatedAt: '2026-05-03T16:00:00.000Z',
          previewMessages: [],
          sideEffectLedger: [],
        },
      };
      throw error;
    },
  };
  harness.server.resolveAdditionalSystemPrompt = () => 'AUTO_LOOP_SYSTEM_PROMPT';
  harness.server.resolveWorkspaceDirForContext = () => 'D:\\repo';
  harness.setControllerFactory(() => controller);
  harness.server.scheduleCallbackContinuation = (
    ws: unknown,
    nextContext: unknown,
    nextController: unknown,
    prompt: unknown
  ) => {
    scheduled = [ws, nextContext, nextController, prompt];
  };

  await harness.server.executeTrackedRun({
    runId: 'run-workspace-recoverable',
    ownerWs: harness.openSocket,
    context,
    dispatcher: {
      error: (error: string) => {
        harness.lifecycle.push(`error:${error}`);
      },
      runTerminal: (state: Record<string, unknown>) => {
        harness.lifecycle.push('runTerminal');
        terminalState = state;
      },
      autoLoopRound: (round: number, prompt: string) => {
        harness.lifecycle.push(`autoLoopRound:${round}:${prompt.includes('[AUTO_LOOP_CONTINUE]')}`);
      },
      autoLoopStopped: (reason: string | undefined) => {
        harness.lifecycle.push(`autoLoopStopped:${reason}`);
      },
    },
    stopControllerOnError: controller,
    resolveRunInput: () => ({
      prompt: 'continue',
      workspaceDir: 'D:\\repo',
      callback: { kind: 'callback' },
    }),
  });

  assert.equal(terminalState?.terminalCode, 'error');
  assert.equal(terminalState?.replayCutoffKind, 'checkpoint');
  assert.equal(scheduled?.[0], harness.openSocket);
  assert.equal(scheduled?.[1], context);
  assert.equal(scheduled?.[2], controller);
  assert.match(String(scheduled?.[3] ?? ''), /\[AUTO_LOOP_CONTINUE\]/);
  assert.deepEqual(harness.lifecycle, [
    'runWithResult',
    'active:delete:run-workspace-recoverable',
    'runTerminal',
    'autoLoopRound:5:true',
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
        defaultProfileId: 'default',
        profiles: [
          {
            id: 'default',
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

function testCloneRuntimeConfigPinsSelectedProfileAsCanonicalDefault(): void {
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
      profileId: 'default',
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

async function testPrepareChatExecutionIgnoresSpoofedCliKindFromWebPayload(): Promise<void> {
  const harness = createHarness();
  const externalMcpServers = [
    {
      name: 'teamtool',
      type: 'stdio' as const,
      command: 'node',
      args: ['teamtool.js'],
    },
  ];
  let capturedExternalMcpServers: unknown = 'not-called';

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => undefined,
    updateContextNamespaceMeta: () => undefined,
    initialize: async () => undefined,
  };
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
    _llmRuntime: ResolvedLlmRuntimeConfig,
    _llmSelection: SessionLlmSelection,
    nextExternalMcpServers?: unknown
  ) => {
    capturedExternalMcpServers = nextExternalMcpServers;
    harness.server.sessionRuntimes.set(sessionId, createSessionRuntimeRecord(harness.server.agent, workspaceDir));
    return {
      agent: harness.server.agent,
      reused: false,
    };
  };
  harness.setControllerFactory(() => ({
    getConfig: () => ({ enabled: false }),
    getState: () => ({ isRunning: false }),
  }));

  try {
    const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Hello',
      sessionId: 'sess-web-spoof',
      workspaceDir: 'D:\\repo',
      clientKind: 'cli',
      externalMcpServers,
    });

    assert.notEqual(prepared, null);
    assert.equal(prepared?.runOrigin, 'web');
    assert.deepEqual(prepared?.externalMcpServers, []);
    assert.deepEqual(capturedExternalMcpServers, []);
    assert.deepEqual((harness.emitted[0].data as Record<string, unknown>).interactionState, {
      mode: 'normal',
      owner: 'web',
    });
  } finally {
    harness.restore();
  }
}

async function testPrepareChatExecutionUsesCliConnectionKindForOriginAndExternalMcp(): Promise<void> {
  const harness = createHarness();
  const externalMcpServers = [
    {
      name: 'teamtool',
      type: 'stdio' as const,
      command: 'node',
      args: ['teamtool.js'],
    },
  ];
  let capturedExternalMcpServers: unknown = null;
  const persistedPatches: Array<Record<string, unknown>> = [];

  harness.server.websocketClientKinds = new WeakMap([[harness.openSocket, 'cli']]);
  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => undefined,
    updateContextNamespaceMeta: (_context: ContextRef, patch: Record<string, unknown>) => {
      persistedPatches.push(patch);
    },
    initialize: async () => undefined,
  };
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
    _llmRuntime: ResolvedLlmRuntimeConfig,
    _llmSelection: SessionLlmSelection,
    nextExternalMcpServers?: unknown
  ) => {
    capturedExternalMcpServers = nextExternalMcpServers;
    harness.server.sessionRuntimes.set(sessionId, createSessionRuntimeRecord(harness.server.agent, workspaceDir));
    return {
      agent: harness.server.agent,
      reused: false,
    };
  };
  harness.setControllerFactory(() => ({
    getConfig: () => ({ enabled: false }),
    getState: () => ({ isRunning: false }),
  }));

  try {
    const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Hello',
      sessionId: 'sess-cli-origin',
      workspaceDir: 'D:\\repo',
      externalMcpServers,
    });

    assert.notEqual(prepared, null);
    assert.equal(prepared?.runOrigin, 'cli');
    assert.deepEqual(prepared?.externalMcpServers, [
      {
        ...externalMcpServers[0],
        env: undefined,
      },
    ]);
    assert.deepEqual(capturedExternalMcpServers, [
      {
        ...externalMcpServers[0],
        env: undefined,
      },
    ]);
    assert.deepEqual((harness.emitted[0].data as Record<string, unknown>).interactionState, {
      mode: 'observe_only',
      reason: 'cli_active_run',
      owner: 'cli',
    });
    assert.deepEqual(persistedPatches[0], {
      origin: 'cli',
      lastRunOrigin: 'cli',
      lastRunAt: (persistedPatches[0].lastRunAt as string),
      workspaceDir: 'D:\\repo',
    });
    assert.deepEqual((persistedPatches[1].runtimeAttachment as Record<string, unknown>).externalMcpServerNames, [
      'teamtool',
    ]);
  } finally {
    harness.restore();
  }
}

async function testPrepareChatExecutionResolvesExternalNovelistAgent(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-chat-external-novelist-'));
  try {
    const workspaceDir = path.join(tempDir, 'workspace');
    const agentsDir = path.join(tempDir, 'external-agents');
    const novelistDir = path.join(agentsDir, 'Novelist');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(novelistDir, { recursive: true });
    fs.writeFileSync(path.join(novelistDir, 'AGENTS.md'), '# Novelist\nWrite with a literary narrative voice.', 'utf-8');

    const harness = createHarness();
    const catalog = scanGlobalAgentProfiles(agentsDir).profiles;
    harness.server.globalAgentProfiles = catalog;
    harness.server.globalAgentProfileByName = new Map(catalog.map((profile) => [profile.normalizedName, profile]));
    harness.server.agent = {
      getConfig: () => ({
        ...createTestConfig(workspaceDir),
        agent: {
          workspaceDir,
          globalAgentsDir: agentsDir,
        },
      }),
      getContextNamespaceMeta: () => undefined,
      initialize: async () => undefined,
    };
    harness.server.createCallback = (_ws: object, context: ContextRef, runId: string) => ({
      session: context.namespace,
      runId,
    });
    harness.server.ensureSessionRuntime = async (sessionId: string, nextWorkspaceDir: string) => {
      harness.lifecycle.push(`ensure:${sessionId}:${nextWorkspaceDir}`);
      harness.server.sessionRuntimes.set(sessionId, createSessionRuntimeRecord(harness.server.agent, nextWorkspaceDir));
      return {
        agent: harness.server.agent,
        reused: false,
      };
    };
    harness.setControllerFactory(() => ({
      getConfig: () => ({ enabled: false }),
      getState: () => ({ isRunning: false }),
    }));

    try {
      const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
        prompt: '@Novelist draft chapter one',
        sessionId: 'sess-novelist',
        workspaceDir,
      });

      assert.notEqual(prepared, null);
      assert.equal(prepared?.displayPrompt, 'draft chapter one');
      assert.equal(prepared?.effectivePrompt, 'draft chapter one');
      assert.doesNotMatch(String(prepared?.effectivePrompt ?? ''), /\[AGENT_PROFILE_BODY_BEGIN\]/);
      assert.deepEqual(prepared?.agentRuntimeOverrides?.agentProfile, {
        source: 'global',
        name: 'Novelist',
        path: path.join(novelistDir, 'AGENTS.md'),
      });
      assert.match(String(prepared?.historyUserPrompt ?? ''), /^\[AGENT_PROFILE_REF source=global name=Novelist /);
      assert.match(String(prepared?.promptRef ?? ''), /reason=mentioned_agent/);
      assert.equal(prepared?.hasSystemPromptInjection, true);
    } finally {
      harness.restore();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
      `active:set:${runId}`,
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
        origin: 'web',
        owner: 'web',
        interactionState: { mode: 'normal', owner: 'web' },
        llmRuntime: {
          profileId: 'default',
          provider: 'anthropic',
          model: 'MiniMax-M2.5',
          reasoningPreset: 'high',
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

async function testHandleWSMessageAutoLoopFatalErrorStopsPreparedController(): Promise<void> {
  const harness = createHarness();
  const autoLoopConfig = { enabled: true, maxRounds: 4 };

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => ({
      autoLoopConfig,
    }),
    updateContextNamespaceMeta: () => {
      harness.lifecycle.push('meta:update');
    },
    initialize: async () => {
      harness.lifecycle.push('initialize');
    },
    runWithResult: async () => {
      harness.lifecycle.push('runWithResult');
      throw new Error('run_failed');
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
    stop: (reason: string) => {
      harness.lifecycle.push(`autoLoop:stop:${reason}`);
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

    const runId = (harness.emitted[0].data as { runId: string }).runId;
    assert.equal(harness.lifecycle.includes(`active:set:${runId}`), true);
    assert.equal(harness.lifecycle.includes(`active:delete:${runId}`), true);
    assert.equal(harness.lifecycle.includes('autoLoop:start'), true);
    assert.equal(harness.lifecycle.includes('runWithResult'), true);
    const errorIndex = harness.lifecycle.indexOf('emit:error');
    const stopIndex = harness.lifecycle.indexOf('autoLoop:stop:error');
    assert.notEqual(errorIndex, -1);
    assert.notEqual(stopIndex, -1);
    assert.equal(stopIndex > errorIndex, true);
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
      `active:set:${runId}`,
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
        origin: 'web',
        owner: 'web',
        interactionState: { mode: 'normal', owner: 'web' },
        llmRuntime: {
          profileId: 'default',
          provider: 'anthropic',
          model: 'MiniMax-M2.5',
          reasoningPreset: 'high',
        },
      },
    });
  } finally {
    harness.restore();
  }
}

async function testPrepareChatExecutionPassesFileReferencesToPromptResolution(): Promise<void> {
  const harness = createHarness();
  let capturedInput: Record<string, unknown> | null = null;

  harness.server.agent = {
    getConfig: () => createTestConfig(),
    getContextNamespaceMeta: () => undefined,
    initialize: async () => undefined,
  };
  harness.server.resolveUserPrompt = (input: Record<string, unknown>) => {
    capturedInput = input;
    return {
      ok: true,
      effectivePrompt: '<refs_file_for_this_turn>\n  <file path="D:\\repo\\README.md" />\n</refs_file_for_this_turn>\n\nRead files',
      displayPrompt: 'Read files',
      historyUserPrompt: 'Read files',
      hasSystemPromptInjection: true,
    };
  };
  harness.server.createCallback = () => ({ kind: 'callback' });
  harness.setControllerFactory(() => ({
    getConfig: () => ({ enabled: false }),
    getState: () => ({ isRunning: false }),
    start: () => undefined,
  }));

  try {
    const prepared = await harness.server.prepareChatExecution(harness.openSocket, {
      prompt: 'Read files',
      sessionId: 'sess-files',
      workspaceDir: 'D:\\repo',
      fileReferences: ['D:\\repo\\README.md'],
    });

    assert.notEqual(prepared, null);
    assert.deepEqual(capturedInput?.fileReferences, ['D:\\repo\\README.md']);
    assert.equal(prepared?.displayPrompt, 'Read files');
    assert.equal(prepared?.historyUserPrompt, 'Read files');
    assert.match(prepared?.effectivePrompt ?? '', /^<refs_file_for_this_turn>/);
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
  let resolvedPlanningState: unknown = undefined;
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
  harness.server.resolveUserPrompt = (input: { planningState?: string }) => {
    resolvedPlanningState = input.planningState;
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
      planningAction: 'enter_drafting',
    });

    assert.notEqual(prepared, null);
    assert.equal(resolvedPlanningState, 'plan_drafting');
    assert.equal(((meta.planningState ?? {}) as Record<string, unknown>).state, 'plan_drafting');
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
    replacePendingPlanInputs(harness.server, new Map<any, any>([
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
    ]));
    harness.server.completePlanInputResponse(
      {
        runId: 'run-plan',
        requestId: 'req-plan',
        pending: getPendingPlanInputs(harness.server).get('run-plan'),
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
      planningAction: 'enter_drafting',
    });

    assert.notEqual(prepared, null);
    const runId = prepared?.runId ?? '';
    assert.ok(runId);
    assert.equal(((meta.autoLoopConfig ?? {}) as Record<string, unknown>).pendingPlanConfirmation, true);
    replacePendingPlanInputs(harness.server, new Map<any, any>());
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

async function testRunningInputNextTurnSchedulesOnlyAfterRunFinalize(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-queue' };
  const harness = createHarness();
  harness.server.resolveWorkspaceDirForContext = () => 'D:\\repo';
  harness.server.resolveCallbackContinuationPlan = () => ({
    kind: 'none',
    emitComplete: true,
  });
  harness.server.getCompletionMarkerService = () => ({
    resolveStatsForCompletion: () => null,
  });
  harness.server.finalizeCompletedRun = () => {
    harness.lifecycle.push('finalizeCompletedRun');
  };
  harness.server.applyCallbackContinuationPlan = () => {
    harness.lifecycle.push('applyCallbackContinuationPlan');
  };
  harness.server.scheduleRunningInputNextTurn = (nextContext: ContextRef) => {
    harness.lifecycle.push(`schedule:${nextContext.namespace}`);
  };
  harness.server.runningInputQueue = {
    releaseInsertRequestsForRun: () => {
      harness.lifecycle.push('releaseInsertRequestsForRun');
      return false;
    },
  };

  await harness.server.handleCallbackCompletion(
    harness.openSocket,
    context,
    'run-queue',
    'sess-queue',
    'done',
    {
      complete: () => undefined,
      autoLoopStopped: () => undefined,
      autoLoopRound: () => undefined,
    },
    'end_turn'
  );

  assert.deepEqual(harness.lifecycle, ['finalizeCompletedRun', 'applyCallbackContinuationPlan']);
  assert.equal(harness.server.runningInputNextTurnAfterFinalize.has('run-queue'), true);

  const orchestrator = harness.server.createRunExecutionOrchestrator();
  await (orchestrator as any).options.afterFinalizeTrackedRun({ runId: 'run-queue', context });

  assert.deepEqual(harness.lifecycle, [
    'finalizeCompletedRun',
    'applyCallbackContinuationPlan',
    'releaseInsertRequestsForRun',
    'schedule:sess-queue',
  ]);
  assert.equal(harness.server.runningInputNextTurnAfterFinalize.has('run-queue'), false);
}

function testRunningInputCancelRemovesQueuedItemAndBroadcasts(): void {
  const context: ContextRef = { scope: 'session', namespace: 'sess-cancel-queue' };
  const harness = createHarness();
  let removed: { context: ContextRef; itemId: string } | null = null;

  harness.server.resolveRunningInputContext = () => context;
  harness.server.runningInputQueue = {
    remove: (nextContext: ContextRef, itemId: string) => {
      removed = { context: nextContext, itemId };
      return { id: itemId, prompt: 'queued text' };
    },
  };
  harness.server.broadcastRunningInputQueue = (nextContext: ContextRef) => {
    harness.lifecycle.push(`broadcast:${nextContext.namespace}`);
  };

  harness.server.handleRunningInputCancelMessage(harness.openSocket, {
    itemId: 'rin-1',
    context,
  });

  assert.deepEqual(removed, { context, itemId: 'rin-1' });
  assert.deepEqual(harness.lifecycle, ['broadcast:sess-cancel-queue']);
}

function testRunningInputEnqueueStoresSelectedAgentName(): void {
  const context: ContextRef = { scope: 'session', namespace: 'sess-agent-queue' };
  const harness = createHarness();
  let capturedEnqueue: Record<string, unknown> | null = null;

  harness.server.resolveRunningInputContext = () => context;
  harness.server.canWebSocketAccessContext = () => true;
  harness.server.getActiveRunState = () => ({
    runId: 'run-active',
    owner: 'web',
    interactionState: { mode: 'normal' },
  });
  harness.server.canControlWebActiveRun = () => true;
  harness.server.runningInputQueue = {
    enqueue: (input: Record<string, unknown>) => {
      capturedEnqueue = input;
      return {
        id: 'rin-agent',
        runId: 'run-active',
        context,
        prompt: 'write chapter',
        selectedAgentName: input.selectedAgentName,
        createdAt: '2026-05-12T00:00:00.000Z',
        updatedAt: '2026-05-12T00:00:00.000Z',
        status: 'queued_next',
      };
    },
  };
  harness.server.broadcastRunningInputQueue = (nextContext: ContextRef) => {
    harness.lifecycle.push(`broadcast:${nextContext.namespace}`);
  };

  harness.server.handleRunningInputEnqueueMessage(harness.openSocket, {
    prompt: 'write chapter',
    selectedAgentName: 'Novelist',
    context,
  });

  assert.equal(capturedEnqueue?.selectedAgentName, 'Novelist');
  assert.deepEqual(harness.lifecycle, ['broadcast:sess-agent-queue', 'emit:running_input_queued']);
  assert.equal(((harness.emitted[0].data as { item: { selectedAgentName?: string } }).item).selectedAgentName, 'Novelist');
}

function testRunningInputOwnerSocketFallsBackToOpenWebClient(): void {
  const harness = createHarness();
  const closedSocket = { readyState: WebSocket.CLOSED, socket: 'closed' };
  const openWebSocket = { readyState: WebSocket.OPEN, socket: 'open-web' };
  const openCliSocket = { readyState: WebSocket.OPEN, socket: 'open-cli' };
  harness.server.wss = {
    clients: new Set([openCliSocket, openWebSocket]),
  };
  harness.server.websocketClientKinds = new WeakMap([
    [openCliSocket as unknown as WebSocket, 'cli'],
    [openWebSocket as unknown as WebSocket, 'web'],
  ]);

  assert.equal(harness.server.resolveRunningInputOwnerSocket(closedSocket), openWebSocket);
}

async function testRunningInputNextTurnPassesSelectedAgentName(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-agent-next' };
  const harness = createHarness();
  const item = {
    id: 'rin-agent-next',
    runId: 'run-1',
    context,
    prompt: 'write chapter',
    selectedAgentName: 'Novelist',
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    status: 'queued_next',
  };
  let capturedRequest: Record<string, unknown> | null = null;
  harness.server.runningInputQueue = {
    dequeueNext: () => item,
  };
  harness.server.broadcastRunningInputQueue = (nextContext: ContextRef) => {
    harness.lifecycle.push(`broadcast:${nextContext.namespace}`);
  };
  harness.server.prepareChatExecution = async (_ws: unknown, request: Record<string, unknown>) => {
    capturedRequest = request;
    return { request };
  };
  harness.server.executePreparedChatRun = async () => {
    harness.lifecycle.push('executePreparedChatRun');
  };

  await harness.server.executeRunningInputNextTurn(context, harness.openSocket);

  assert.equal(capturedRequest?.selectedAgentName, 'Novelist');
  assert.deepEqual(harness.lifecycle, ['broadcast:sess-agent-next', 'executePreparedChatRun']);
}

async function testRunningInputNextTurnRequeuesWhenPrepareThrows(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-requeue-throw' };
  const harness = createHarness();
  const item = {
    id: 'rin-throw',
    runId: 'run-1',
    context,
    prompt: 'queued prompt',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    status: 'queued_next',
  };
  harness.server.runningInputQueue = {
    dequeueNext: () => item,
    requeueFront: (nextContext: ContextRef, nextItem: typeof item) => {
      harness.lifecycle.push(`requeue:${nextContext.namespace}:${nextItem.id}`);
      return nextItem;
    },
  };
  harness.server.broadcastRunningInputQueue = (nextContext: ContextRef) => {
    harness.lifecycle.push(`broadcast:${nextContext.namespace}`);
  };
  harness.server.prepareChatExecution = async () => {
    throw new Error('prepare_failed');
  };

  await harness.server.executeRunningInputNextTurn(context, harness.openSocket);

  assert.deepEqual(harness.lifecycle, [
    'broadcast:sess-requeue-throw',
    'requeue:sess-requeue-throw:rin-throw',
    'broadcast:sess-requeue-throw',
  ]);
}

async function testPlanInputApprovalActivatesPendingPlanExactly(): Promise<void> {
  const harness = createHarness();
  const context: ContextRef = { scope: 'session', namespace: 'sess-approval' };
  let meta: Record<string, unknown> = {
    workspaceDir: 'D:\\repo',
    planningState: {
      state: 'plan_drafting',
      updatedAt: '2026-04-30T00:00:00.000Z',
    },
    autoLoopConfig: {
      enabled: false,
      mode: 'todo',
      ralphEnabled: true,
      pendingPlanConfirmation: true,
      maxRounds: 4,
    },
    pendingPlanInput: {
      runId: 'run-approval',
      requestId: 'req-approval',
      requestedAt: '2026-04-30T00:00:00.000Z',
      questions: [],
    },
  };
  let controllerConfig: Record<string, unknown> = {
    enabled: false,
    mode: 'todo',
    ralphEnabled: true,
    pendingPlanConfirmation: true,
      maxRounds: 4,
  };
  const setTodoPlanCalls: Array<Record<string, unknown>> = [];
  const fakeContextManager = {
    inspectKey: (_context: ContextRef, key: string, options: { turnId?: string }) => ({
      found: key === 'plan_mode.pending_plan_id' || key === 'plan_mode.final_plan_steps',
      value:
        options.turnId === 'turn-finalize'
          ? key === 'plan_mode.pending_plan_id'
            ? 'plan-approved'
            : JSON.stringify([
                {
                  planStepId: 'step-001',
                  work: 'Implement approved plan step',
                  detectionStandard: 'Approved plan step is verifiably complete.',
                  priority: 'high',
                  tags: ['approval'],
                },
              ])
          : options.turnId === 'turn-missing-steps'
            ? key === 'plan_mode.pending_plan_id'
              ? 'plan-missing-steps'
              : ''
          : key === 'plan_mode.pending_plan_id'
            ? 'stale-committed-plan'
            : '',
      sourceStatus:
        options.turnId === 'turn-finalize' || options.turnId === 'turn-missing-steps'
          ? 'pending_override'
          : 'committed',
    }),
    getProjection: () => ({
      keyValues: {
        'plan_mode.pending_plan_id': 'stale-committed-plan',
        'plan_mode.final_plan_steps': '',
      },
    }),
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
    getContextManager: () => fakeContextManager,
    getTodoStore: () => ({
      setTodoPlan: (input: Record<string, unknown>) => {
        setTodoPlanCalls.push(input);
        return [];
      },
      getProtocolState: () => ({
        items: setTodoPlanCalls.length > 0 ? [{ id: 'todo-1' }] : [],
        unfinishedItems: setTodoPlanCalls.length > 0 ? [{ id: 'todo-1' }] : [],
        activeItem: null,
        blockedItem: null,
        pendingItems: setTodoPlanCalls.length > 0 ? [{ id: 'todo-1' }] : [],
        completedItems: [],
        hasUnfinished: setTodoPlanCalls.length > 0,
        allCompleted: false,
      }),
    }),
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
    start: () => undefined,
    stop: () => undefined,
  }));
  try {
    const answerPlanInput = (
      runId: string,
      selectedLabel: string,
      turnId = 'turn-finalize',
      source: 'request_user_input' | 'finalize_plan_approval' = 'finalize_plan_approval'
    ): void => {
      meta = {
        ...meta,
        pendingPlanInput: {
          runId,
          requestId: 'req-approval',
          source,
          requestedAt: '2026-04-30T00:00:00.000Z',
          questions: [],
        },
      };
      const pending = {
        runId,
        context,
        ws: harness.openSocket,
        request: {
          requestId: 'req-approval',
          source,
          turnId,
          questions: [],
        },
        resolve: () => undefined,
        reject: () => undefined,
      };
      replacePendingPlanInputs(harness.server, new Map<any, any>([[runId, pending]]));
      harness.server.completePlanInputResponse(
        {
          runId,
          requestId: 'req-approval',
          pending,
        },
        [
          {
            id: 'plan_execution_approval',
            selectedLabel,
            selectedIndex: 0,
          },
        ]
      );
    };

    answerPlanInput('run-approval-reject', 'Do not execute');
    assert.equal(((meta.planningState ?? {}) as Record<string, unknown>).state, 'plan_drafting');

    answerPlanInput('run-approval-request-user-input', 'Approve execution', 'turn-finalize', 'request_user_input');
    assert.equal(((meta.planningState ?? {}) as Record<string, unknown>).state, 'plan_drafting');
    assert.equal(setTodoPlanCalls.length, 0);

    answerPlanInput('run-approval-lowercase', 'approve execution');
    assert.equal(((meta.planningState ?? {}) as Record<string, unknown>).state, 'plan_drafting');

    answerPlanInput('run-approval-stale', 'Approve execution', 'turn-without-plan');
    assert.equal(((meta.planningState ?? {}) as Record<string, unknown>).state, 'plan_drafting');

    answerPlanInput('run-approval-missing-steps', 'Approve execution', 'turn-missing-steps');
    assert.equal(((meta.planningState ?? {}) as Record<string, unknown>).state, 'plan_drafting');
    assert.equal(setTodoPlanCalls.length, 0);

    answerPlanInput('run-approval-approve', 'Approve execution');
    assert.equal(((meta.planningState ?? {}) as Record<string, unknown>).state, 'plan_executing');
    assert.equal(((meta.planningState ?? {}) as Record<string, unknown>).activeExecutionPlanId, 'plan-approved');
    assert.equal(setTodoPlanCalls.length, 1);
    assert.deepEqual(setTodoPlanCalls[0], {
      sessionId: 'sess-approval',
      workspaceDir: 'D:\\repo',
      sourceSessionId: 'sess-approval',
      planId: 'plan-approved',
      items: [
        {
          work: 'Implement approved plan step',
          detectionStandard: 'Approved plan step is verifiably complete.',
          priority: 'high',
          tags: ['approval'],
          planStepId: 'step-001',
          status: 'pending',
        },
      ],
    });
    assert.equal(controllerConfig.pendingPlanConfirmation, false);
    assert.equal(controllerConfig.enabled, true);
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
  const persistedPatches: Array<Record<string, unknown>> = [];

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
    persistedPatches.push(patch);
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
  assert.deepEqual(persistedPatches[0], {
    llmSelection: createTestLlmSelection({
      profileId: 'openai-alt',
      model: 'gpt-4.1-mini',
      updatedAt: '2026-04-24T02:00:00.000Z',
    }),
  });
  assert.deepEqual(persistedPatches[1], {
    runtimeErrors: [
      {
        id: 'run-error-run-1',
        runId: 'run-1',
        message: 'run_failed',
        createdAt: (persistedPatches[1].runtimeErrors as Array<{ createdAt: string }>)[0].createdAt,
      },
    ],
  });
}

async function testExecutePreparedChatRunContextVersionConflictSkipsRuntimeErrorPersistence(): Promise<void> {
  const context: ContextRef = { scope: 'session', namespace: 'sess-conflict' };
  const harness = createHarness([['run-conflict', context]]);
  const persistedPatches: Array<Record<string, unknown>> = [];
  const conflictMessage =
    'Context event version conflict for session:sess-conflict: expected 71, found 115';

  harness.server.agent = {
    runWithResult: async () => {
      harness.lifecycle.push('runWithResult');
      throw new Error(conflictMessage);
    },
  };
  harness.server.updateContextNamespaceMetaSafe = (_context: ContextRef, patch: Record<string, unknown>) => {
    persistedPatches.push(patch);
  };

  await harness.server.executePreparedChatRun({
    request: {
      prompt: 'Hello',
    },
    context,
    runId: 'run-conflict',
    effectivePrompt: 'resolved prompt',
    callback: { kind: 'callback' },
    dispatcher: {
      error: (error: string) => {
        assert.equal(harness.server.activeRunContexts.size, 0);
        harness.lifecycle.push(`error:${error}`);
      },
    },
  });

  assert.deepEqual(harness.lifecycle, [
    'runWithResult',
    'active:delete:run-conflict',
    'refresh',
    `error:${conflictMessage}`,
  ]);
  assert.equal(harness.server.activeRunContexts.size, 0);
  assert.deepEqual(persistedPatches, []);
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
  await testWebSocketCloseKeepsNormalActiveRunState();
  await testRunEventsRefreshActiveRunHydrationSnapshot();
  await testExecuteTrackedRunSuccessRunsAgentAndCleansUp();
  await testExecuteTrackedRunCarriesResumeMetadataAndEmitsRunTerminal();
  await testExecuteTrackedRunFailurePrefersStructuredRunTerminal();
  await testExecuteTrackedRunRecoverableCheckpointContinuesTodoLoop();
  await testExecuteTrackedRunRecoverableWorkspaceCheckpointContinuesAutoLoop();
  await testPrepareChatExecutionPromptFailureEmitsErrorAndRefreshes();
  await testPrepareChatExecutionMissingApiKeyEmitsErrorAndRefreshes();
  await testPrepareChatExecutionRejectsDirtyRootRuntimeWhileRootRunActive();
  await testPrepareChatExecutionRejectsConcurrentRunInSameSession();
  await testPrepareChatExecutionReusesSessionRuntimeWithoutReinitializing();
  await testPrepareChatExecutionAllowsMultipleSessionsInSameWorkspace();
  await testPrepareChatExecutionUsesRequestedLlmSelectionForRuntime();
  await testPrepareChatExecutionUsesPersistedSessionLlmSelectionWhenRequestOmitsOverride();
  testCloneRuntimeConfigPinsSelectedProfileAsCanonicalDefault();
  testBuildSessionRuntimeKeyIncludesLlmRuntimeShape();
  await testPrepareChatExecutionIgnoresSpoofedCliKindFromWebPayload();
  await testPrepareChatExecutionUsesCliConnectionKindForOriginAndExternalMcp();
  await testPrepareChatExecutionResolvesExternalNovelistAgent();
  await testHandleChatMessageShortCircuitsWhenPreparationFails();
  await testHandleChatMessageBubblesPreparationExceptions();
  await testHandleChatMessagePassesPreparedExecutionThroughIntact();
  await testHandleWSMessageChatRunsFullExtractedChain();
  await testHandleWSMessageAutoLoopFatalErrorStopsPreparedController();
  await testPrepareChatExecutionSuccessInitializesRunAndStartsAutoLoop();
  await testPrepareChatExecutionPassesFileReferencesToPromptResolution();
  await testPrepareChatExecutionPlanModeKeepsTodoLoopPending();
  await testPlanModeCompletionWithoutInputKeepsPendingConfirmation();
  await testRunningInputNextTurnSchedulesOnlyAfterRunFinalize();
  testRunningInputCancelRemovesQueuedItemAndBroadcasts();
  testRunningInputEnqueueStoresSelectedAgentName();
  testRunningInputOwnerSocketFallsBackToOpenWebClient();
  await testRunningInputNextTurnPassesSelectedAgentName();
  await testRunningInputNextTurnRequeuesWhenPrepareThrows();
  await testPlanInputApprovalActivatesPendingPlanExactly();
  await testExecutePreparedChatRunSuccessRunsAgentAndCleansUp();
  await testExecutePreparedChatRunFailureEmitsErrorAndCleansUp();
  await testExecutePreparedChatRunContextVersionConflictSkipsRuntimeErrorPersistence();
  await testExecutePreparedChatRunPersistsLlmSelectionAfterSuccess();
  console.log('web-chat-message tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
