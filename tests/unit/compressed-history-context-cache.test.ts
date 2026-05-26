import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DPAgent } from '../../src/index.js';
import { ToolRegistry } from '../../src/tools/index.js';
import type { LLMClient } from '../../src/llm/index.js';
import type {
  ContextNamespaceMeta,
  ContextRef,
  LLMResponse,
  Message,
  ResolvedLlmRuntimeConfig,
} from '../../src/types.js';

class CompressionAwareLLMClient {
  public compressionCalls = 0;
  public runCalls = 0;
  public readonly compressionPrompts: string[] = [];

  constructor(private readonly runtimeConfig?: ResolvedLlmRuntimeConfig) {}

  getRuntimeConfig(): ResolvedLlmRuntimeConfig | undefined {
    return this.runtimeConfig;
  }

  async generate(messages: Message[]): Promise<LLMResponse> {
    this.compressionCalls += 1;
    this.compressionPrompts.push(String(messages[0]?.content ?? ''));
    return {
      content: `compressed-history-${this.compressionCalls}`,
      finishReason: 'end_turn',
    };
  }

  async generateWithCallbacks(
    _messages: Message[],
    callbacks: {
      onText?: (text: string) => void;
      onComplete?: (result: LLMResponse) => void;
    }
  ): Promise<LLMResponse> {
    this.runCalls += 1;
    const content = `runtime-answer-${this.runCalls}`;
    callbacks.onText?.(content);
    const response: LLMResponse = {
      content,
      finishReason: 'end_turn',
    };
    callbacks.onComplete?.(response);
    return response;
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<CompressionAwareLLMClient['generateWithCallbacks']>
  ): ReturnType<CompressionAwareLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }
}

function createHarness(prefix: string): {
  tempDir: string;
  workspaceDir: string;
  runtimeDir: string;
  contextDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `compressed-history-context-${prefix}-`));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  return { tempDir, workspaceDir, runtimeDir, contextDir };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function createAgent(
  harness: {
    workspaceDir: string;
    runtimeDir: string;
    contextDir: string;
  },
  llm: CompressionAwareLLMClient
): DPAgent {
  const agent = new DPAgent({
    allowMissingApiKeyAtBoot: true,
    configPath: path.join(process.cwd(), 'config.yaml'),
    workspaceDir: harness.workspaceDir,
    runtimeDataDir: harness.runtimeDir,
    contextDir: harness.contextDir,
  });
  const asAny = agent as unknown as {
    llmClient: LLMClient;
    toolRegistry: ToolRegistry;
    fullSystemPrompt: string;
    memoryPromotionCoordinator: {
      noteCommittedTurn: (...args: unknown[]) => Promise<void>;
    };
  };
  asAny.llmClient = llm as unknown as LLMClient;
  asAny.toolRegistry = new ToolRegistry();
  asAny.fullSystemPrompt = 'You are a unit-test assistant.';
  asAny.memoryPromotionCoordinator.noteCommittedTurn = async () => undefined;
  agent.updateConfig({
    agent: {
      contextReplayMinRounds: 1,
      contextReplayMaxRounds: 1,
      contextReplayBudgetRatio: 0.9,
    },
    contextBudget: {
      defaultContextWindowTokens: 25000,
      compressionTriggerRatio: 0.1,
      compressionMaxChars: 4000,
    },
  });
  return agent;
}

function appendTurn(agent: DPAgent, context: ContextRef, prompt: string, answer: string): void {
  const manager = agent.getContextManager();
  const turn = manager.beginTurn(context, prompt);
  manager.commitTurn(turn.turnId, {
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: answer },
    ],
    finishReason: 'end_turn',
  });
}

function makeText(seed: string): string {
  return `${seed} `.repeat(220).trim();
}

function makeBudgetBoundaryText(seed: string): string {
  return `${seed} `.repeat(1000).trim();
}

function makeThinkingBoundaryText(seed: string): string {
  return `${seed} `.repeat(350).trim();
}

type ReplayAssemblyAccessor = {
  contextReplayAssembler: {
    build: (
      context: ContextRef,
      conversationMessages: Message[],
      meta?: ContextNamespaceMeta
    ) => Promise<{
      replayMessages: Message[];
      compressedHistorySegment?: string;
      compressedHistoryContextUpdate?: ContextNamespaceMeta['compressedHistoryContext'] | null;
      compressedHistoryGenerated: boolean;
      compressedHistoryUsed: boolean;
      compressionCache: 'bypass' | 'hit' | 'miss';
      sealedRoundCount: number;
      replayRoundCount: number;
      compressedPrefixChars: number;
    }>;
  };
};

async function runCase(): Promise<void> {
  const harness = createHarness('cache');
  const llm = new CompressionAwareLLMClient();
  const context: ContextRef = {
    scope: 'session',
    namespace: 'compressed-history-context-cache',
  };

  try {
    const agent = createAgent(harness, llm);
    appendTurn(agent, context, makeText('user-1'), makeText('assistant-1'));
    appendTurn(agent, context, makeText('user-2'), makeText('assistant-2'));
    appendTurn(agent, context, makeText('user-3'), makeText('assistant-3'));

    const agentAny = agent as unknown as ReplayAssemblyAccessor;
    const conversation1 = agent.getContextMessages(context);
    const loaded1 = agent.getContextManager().loadForTurn(context);
    const replay1 = await agentAny.contextReplayAssembler.build(context, conversation1, loaded1.meta);
    assert.equal(llm.compressionCalls, 1);
    assert.equal(replay1.compressedHistoryGenerated, true);
    assert.equal(replay1.compressedHistoryUsed, true);
    assert.equal(replay1.compressionCache, 'miss');
    assert.equal(replay1.sealedRoundCount, 2);
    assert.equal(replay1.replayRoundCount, 1);
    assert.match(replay1.compressedHistorySegment ?? '', /## Compressed Earlier Session Context/);
    assert.equal(replay1.compressedPrefixChars > 0, true);

    agent.updateContextNamespaceMeta(context, {
      compressedHistoryContext: replay1.compressedHistoryContextUpdate ?? undefined,
    });

    const reopenedAgent = createAgent(harness, llm);
    const reopenedAny = reopenedAgent as unknown as ReplayAssemblyAccessor;
    const conversation2 = reopenedAgent.getContextMessages(context);
    const loaded2 = reopenedAgent.getContextManager().loadForTurn(context);
    const replay2 = await reopenedAny.contextReplayAssembler.build(context, conversation2, loaded2.meta);
    assert.equal(llm.compressionCalls, 1);
    assert.equal(replay2.compressionCache, 'hit');
    assert.equal(replay2.compressedHistoryGenerated, false);
    assert.equal(replay2.sealedRoundCount, 2);

    await reopenedAgent.runWithResult({
      prompt: 'continue',
      context,
      workspaceDir: harness.workspaceDir,
    });
    const metaAfterRun = reopenedAgent.getContextNamespaceMeta(context);
    assert.equal(metaAfterRun?.compressedHistoryContext?.sealedRoundCount !== undefined, true);
    assert.equal(
      typeof metaAfterRun?.compressedHistoryContext?.configFingerprint === 'string' &&
        metaAfterRun.compressedHistoryContext.configFingerprint.length > 0,
      true
    );

    const checkpoint = reopenedAgent.getContextManager().createCheckpoint(context, 'compressed-history-rollback').checkpoint;
    appendTurn(reopenedAgent, context, makeText('user-4'), makeText('assistant-4'));
    const rollbackResult = reopenedAgent.getContextManager().validateCheckpoint(context, checkpoint, true);
    assert.equal(rollbackResult.rollbackPerformed, true);

    const metaAfterRollback = reopenedAgent.getContextNamespaceMeta(context);
    assert.equal(metaAfterRollback?.compressedHistoryContext, undefined);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testReplayCompressionUsesRuntimeMaxOutputTokens(): Promise<void> {
  const harness = createHarness('runtime-budget');
  const llm = new CompressionAwareLLMClient({
    profileId: 'runtime-budget',
    provider: 'anthropic',
    apiKey: 'test-key',
    apiBase: 'https://anthropic.local',
    model: 'runtime-budget-model',
    maxOutputTokens: 180000,
    reasoningPreset: 'off',
    capabilities: {
      reasoningEffort: false,
      thinkingBudget: false,
    },
  });
  const context: ContextRef = {
    scope: 'session',
    namespace: 'compressed-history-runtime-budget',
  };

  try {
    const agent = createAgent(harness, llm);
    agent.updateConfig({
      agent: {
        contextReplayMinRounds: 1,
        contextReplayMaxRounds: 1,
        contextReplayBudgetRatio: 0.9,
      },
      contextBudget: {
        defaultContextWindowTokens: 200000,
        compressionTriggerRatio: 0.1,
        compressionMaxChars: 4000,
      },
    });
    appendTurn(agent, context, makeBudgetBoundaryText('user-1'), makeBudgetBoundaryText('assistant-1'));
    appendTurn(agent, context, makeBudgetBoundaryText('user-2'), makeBudgetBoundaryText('assistant-2'));
    appendTurn(agent, context, makeBudgetBoundaryText('user-3'), makeBudgetBoundaryText('assistant-3'));

    const agentAny = agent as unknown as ReplayAssemblyAccessor;
    const conversation = agent.getContextMessages(context);
    const loaded = agent.getContextManager().loadForTurn(context);
    const replay = await agentAny.contextReplayAssembler.build(context, conversation, loaded.meta);

    assert.equal(llm.compressionCalls, 1);
    assert.equal(replay.compressedHistoryGenerated, true);
    assert.equal(replay.sealedRoundCount, 2);
    assert.equal(replay.replayRoundCount, 1);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testReplayCompressionReservesAnthropicPresetThinkingBudget(): Promise<void> {
  const harness = createHarness('runtime-thinking-budget');
  const llm = new CompressionAwareLLMClient({
    profileId: 'runtime-thinking-budget',
    provider: 'anthropic',
    apiKey: 'test-key',
    apiBase: 'https://anthropic.local',
    model: 'runtime-thinking-budget-model',
    maxOutputTokens: 1000,
    reasoningPreset: 'high',
    capabilities: {
      reasoningEffort: false,
      thinkingBudget: true,
    },
  });
  const context: ContextRef = {
    scope: 'session',
    namespace: 'compressed-history-runtime-thinking-budget',
  };

  try {
    const agent = createAgent(harness, llm);
    agent.updateConfig({
      agent: {
        contextReplayMinRounds: 1,
        contextReplayMaxRounds: 1,
        contextReplayBudgetRatio: 0.9,
      },
      contextBudget: {
        defaultContextWindowTokens: 20000,
        compressionTriggerRatio: 0.9,
        compressionMaxChars: 4000,
      },
    });
    appendTurn(agent, context, makeThinkingBoundaryText('user-1'), makeThinkingBoundaryText('assistant-1'));
    appendTurn(agent, context, makeThinkingBoundaryText('user-2'), makeThinkingBoundaryText('assistant-2'));
    appendTurn(agent, context, makeThinkingBoundaryText('user-3'), makeThinkingBoundaryText('assistant-3'));

    const agentAny = agent as unknown as ReplayAssemblyAccessor;
    const conversation = agent.getContextMessages(context);
    const loaded = agent.getContextManager().loadForTurn(context);
    const replay = await agentAny.contextReplayAssembler.build(context, conversation, loaded.meta);

    assert.equal(llm.compressionCalls, 1);
    assert.equal(replay.compressedHistoryGenerated, true);
    assert.equal(replay.sealedRoundCount, 2);
    assert.equal(replay.replayRoundCount, 1);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testReplayCacheFingerprintIncludesReplayWindowConfig(): Promise<void> {
  const harness = createHarness('fingerprint-window');
  const llm = new CompressionAwareLLMClient();
  const context: ContextRef = {
    scope: 'session',
    namespace: 'compressed-history-fingerprint-window',
  };

  try {
    const agent = createAgent(harness, llm);
    appendTurn(agent, context, makeText('user-1'), makeText('assistant-1'));
    appendTurn(agent, context, makeText('user-2'), makeText('assistant-2'));
    appendTurn(agent, context, makeText('user-3'), makeText('assistant-3'));

    const agentAny = agent as unknown as ReplayAssemblyAccessor;
    const conversation1 = agent.getContextMessages(context);
    const loaded1 = agent.getContextManager().loadForTurn(context);
    const replay1 = await agentAny.contextReplayAssembler.build(context, conversation1, loaded1.meta);
    assert.equal(llm.compressionCalls, 1);
    agent.updateContextNamespaceMeta(context, {
      compressedHistoryContext: replay1.compressedHistoryContextUpdate ?? undefined,
    });

    const reopenedAgent = createAgent(harness, llm);
    reopenedAgent.updateConfig({
      agent: {
        contextReplayMinRounds: 2,
        contextReplayMaxRounds: 2,
        contextReplayBudgetRatio: 0.8,
      },
    });
    const reopenedAny = reopenedAgent as unknown as ReplayAssemblyAccessor;
    const conversation2 = reopenedAgent.getContextMessages(context);
    const loaded2 = reopenedAgent.getContextManager().loadForTurn(context);
    const replay2 = await reopenedAny.contextReplayAssembler.build(context, conversation2, loaded2.meta);

    assert.equal(replay2.compressionCache, 'miss');
    assert.equal(replay2.compressedHistoryGenerated, true);
    assert.equal(llm.compressionCalls, 2);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testContextCompactionCommitInvalidatesReplayCache(): void {
  const harness = createHarness('compaction-invalidate');
  const llm = new CompressionAwareLLMClient();
  const context: ContextRef = {
    scope: 'session',
    namespace: 'compressed-history-compaction-invalidate',
  };

  try {
    const agent = createAgent(harness, llm);
    agent.updateContextNamespaceMeta(context, {
      compressedHistoryContext: {
        sealedRoundCount: 1,
        sealedPrefixHash: 'stale-prefix',
        summary: 'stale summary',
        updatedAt: new Date().toISOString(),
        formatVersion: 1,
        configFingerprint: 'stale-fingerprint',
      },
    });
    const turn = agent.getContextManager().beginTurn(context, 'compact now');
    agent.getContextManager().commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: 'compact now' },
        {
          role: 'assistant',
          content: '[CONTEXT_PRECOMPRESSED mode=light]\nsummary',
          metadata: {
            contextCompaction: {
              sourceRange: { startIndex: 0, endIndex: 0, messageCount: 1, sourceHash: 'hash' },
              sourceCoverage: { status: 'complete', droppedMessageCount: 0 },
              sealedBoundary: { keptLlmRounds: 1, tailMessageCount: 1 },
              payloadMetrics: {},
              configFingerprint: 'new-fingerprint',
            },
          },
        },
      ],
      finishReason: 'end_turn',
    });

    assert.equal(agent.getContextNamespaceMeta(context)?.compressedHistoryContext, undefined);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testRunWithCompactionDoesNotReapplyReplayCache(): Promise<void> {
  const harness = createHarness('compaction-run');
  const llm = new CompressionAwareLLMClient();
  const context: ContextRef = {
    scope: 'session',
    namespace: 'compressed-history-compaction-run',
  };

  try {
    const agent = createAgent(harness, llm);
    agent.updateConfig({
      agent: {
        contextReplayMinRounds: 1,
        contextReplayMaxRounds: 3,
        contextReplayBudgetRatio: 0.9,
      },
      contextBudget: {
        defaultContextWindowTokens: 25000,
        compressionTriggerRatio: 0.05,
        minTokensAddedAfterCompression: 0,
        compressionMaxChars: 4000,
        precompressKeepLlmRounds: 1,
        precompressChunkChars: 8000,
      },
    });
    for (let i = 1; i <= 6; i += 1) {
      appendTurn(agent, context, makeText(`user-${i}`), makeText(`assistant-${i}`));
    }

    await agent.runWithResult({
      prompt: 'continue after replay compression',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const events = agent.getContextManager().getEventStore().readEvents(context.scope, context.namespace);
    assert.equal(events.some((event) => event.type === 'context_compaction'), true);
    assert.equal(agent.getContextNamespaceMeta(context)?.compressedHistoryContext, undefined);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

runCase()
  .then(() => testReplayCompressionUsesRuntimeMaxOutputTokens())
  .then(() => testReplayCompressionReservesAnthropicPresetThinkingBudget())
  .then(() => testReplayCacheFingerprintIncludesReplayWindowConfig())
  .then(() => testContextCompactionCommitInvalidatesReplayCache())
  .then(() => testRunWithCompactionDoesNotReapplyReplayCache())
  .then(() => {
    console.log('compressed-history-context-cache test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
