import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MiniMaxAgent } from '../../src/index.js';
import { ToolRegistry } from '../../src/tools/index.js';
import type { LLMClient } from '../../src/llm/index.js';
import type { ContextNamespaceMeta, ContextRef, LLMResponse, Message } from '../../src/types.js';

class CompressionAwareLLMClient {
  public compressionCalls = 0;
  public runCalls = 0;
  public readonly compressionPrompts: string[] = [];

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
): MiniMaxAgent {
  const agent = new MiniMaxAgent({
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
      contextWindowChars: 100000,
      contextPrecompressTriggerRatio: 0.1,
      contextCompressionMaxChars: 4000,
    },
  });
  return agent;
}

function appendTurn(agent: MiniMaxAgent, context: ContextRef, prompt: string, answer: string): void {
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

type ReplayAssemblyAccessor = {
  buildContextReplayAssembly: (
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
    const replay1 = await agentAny.buildContextReplayAssembly(context, conversation1, loaded1.meta);
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
    const replay2 = await reopenedAny.buildContextReplayAssembly(context, conversation2, loaded2.meta);
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

runCase()
  .then(() => {
    console.log('compressed-history-context-cache test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
