import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent/index.js';
import { chunkMessagesForCompression } from '../../src/agent/LlmInputPreparator.js';
import { ToolRegistry } from '../../src/tools/index.js';
import type { LLMClient, LLMRequestOptions } from '../../src/llm/index.js';
import { tokensToCharHint } from '../../src/shared/context-token-estimation.js';
import type {
  ContextOverflowEvent,
  ContextPrecompressEvent,
  LLMResponse,
  Message,
  ResolvedContextBudget,
} from '../../src/types.js';

type ScriptStep =
  | { kind: 'overflow'; message?: string }
  | { kind: 'success'; content: string; finishReason?: string };

class ScriptedLLMClient {
  private readonly steps: ScriptStep[];
  private index = 0;
  public readonly calls: Array<{
    snapshotStage?: string;
    trimMaxTotalChars?: number;
    messageCount: number;
    text: string;
  }> = [];

  constructor(steps: ScriptStep[]) {
    this.steps = steps;
  }

  async generateWithCallbacks(
    messages: Message[],
    callbacks: {
      onThinking?: (thinking: string) => void;
      onText?: (text: string) => void;
      onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
      onComplete?: (result: unknown) => void;
    },
    _tools?: unknown,
    _systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<{
    content: string;
    finishReason: string;
    thinking?: string;
    toolCalls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  }> {
    this.calls.push({
      snapshotStage: options?.snapshotStage,
      trimMaxTotalChars: options?.trimOptions?.maxTotalChars,
      messageCount: messages.length,
      text: messages.map((message) => messageText(message.content)).join('\n'),
    });
    const step = this.steps[this.index];
    if (!step) {
      throw new Error(`No scripted step for call index=${this.index}`);
    }
    this.index += 1;

    if (step.kind === 'overflow') {
      throw new Error(step.message ?? '(2013) context window exceeds limit');
    }

    callbacks.onText?.(step.content);
    callbacks.onComplete?.({
      content: step.content,
      finishReason: step.finishReason ?? 'end_turn',
    });
    return {
      content: step.content,
      finishReason: step.finishReason ?? 'end_turn',
    };
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<ScriptedLLMClient['generateWithCallbacks']>
  ): ReturnType<ScriptedLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }
}

class SlowCompressionLLMClient {
  public compressionCalls = 0;

  async generate(_messages: Message[]): Promise<LLMResponse> {
    this.compressionCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      content: `compressed-${this.compressionCalls}`,
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
    const response = {
      content: 'unused',
      finishReason: 'end_turn',
    };
    callbacks.onText?.(response.content);
    callbacks.onComplete?.(response);
    return response;
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<SlowCompressionLLMClient['generateWithCallbacks']>
  ): ReturnType<SlowCompressionLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }
}

class PromptTooLongCompressionLLMClient {
  public compressionCalls = 0;

  async generate(_messages: Message[]): Promise<LLMResponse> {
    this.compressionCalls += 1;
    if (this.compressionCalls <= 2) {
      throw new Error('prompt too long');
    }
    return {
      content: `compressed-after-truncation-${this.compressionCalls}`,
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
    const response = {
      content: 'after-compression-retry',
      finishReason: 'end_turn',
    };
    callbacks.onText?.(response.content);
    callbacks.onComplete?.(response);
    return response;
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<PromptTooLongCompressionLLMClient['generateWithCallbacks']>
  ): ReturnType<PromptTooLongCompressionLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }
}

class LargeSummaryCompressionLLMClient {
  public compressionCalls = 0;

  async generate(_messages: Message[]): Promise<LLMResponse> {
    this.compressionCalls += 1;
    return {
      content: 'large-compressed-summary '.repeat(900),
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
    const response = {
      content: 'after-large-summary',
      finishReason: 'end_turn',
    };
    callbacks.onText?.(response.content);
    callbacks.onComplete?.(response);
    return response;
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<LargeSummaryCompressionLLMClient['generateWithCallbacks']>
  ): ReturnType<LargeSummaryCompressionLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }
}

function messageText(content: Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === 'text') {
        return block.text ?? '';
      }
      if (block.type === 'tool_result') {
        return block.content ?? '';
      }
      return '';
    })
    .join('\n');
}

function createHarness(prefix: string): { tempDir: string; workspaceDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `context-overflow-${prefix}-`));
  const workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { tempDir, workspaceDir };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function createTestContextBudget(input: {
  contextWindowChars: number;
  triggerRatio: number;
  forcedTrimChars?: number;
  precompressKeepLlmRounds?: number;
  precompressChunkChars?: number;
  precompressRetry?: number;
}): ResolvedContextBudget {
  const forcedTrimChars = input.forcedTrimChars ?? Math.floor(input.contextWindowChars * 0.35);
  return {
    provider: 'test',
    model: 'test',
    contextWindowTokens: input.contextWindowChars,
    estimatedContextWindowChars: input.contextWindowChars,
    compressionTriggerRatio: input.triggerRatio,
    postCompressionTargetRatio: forcedTrimChars / input.contextWindowChars,
    minTokensAddedAfterCompression: 16000,
    compressionMaxChars: 6000,
    precompressKeepLlmRounds: input.precompressKeepLlmRounds ?? 5,
    precompressChunkChars: input.precompressChunkChars ?? 20000,
    precompressRetry: input.precompressRetry ?? 1,
    reservedOutputTokens: 0,
    reservedReasoningTokens: 0,
    reservedProtocolTokens: 0,
    safeInputTokens: input.contextWindowChars,
    compressionTriggerTokens: Math.floor(input.contextWindowChars * input.triggerRatio),
    postCompressionTargetTokens: forcedTrimChars,
    source: 'config_default',
  };
}

function createAgentWithScript(
  steps: ScriptStep[],
  workspaceDir: string,
  overflowEvents: ContextOverflowEvent[]
): { agent: Agent; llm: ScriptedLLMClient } {
  const llm = new ScriptedLLMClient(steps);
  const registry = new ToolRegistry();
  const agent = new Agent({
    llmClient: llm as unknown as LLMClient,
    toolRegistry: registry,
    systemPrompt: 'You are a test agent.',
    maxSteps: 8,
    tokenLimit: 210000,
    contextBudget: createTestContextBudget({
      contextWindowChars: 230000,
      triggerRatio: 0.85,
      forcedTrimChars: 160000,
      precompressKeepLlmRounds: 5,
      precompressChunkChars: 20000,
      precompressRetry: 1,
    }),
    contextOverflowMaxErrorsBeforeTrim: 2,
    workspaceDir,
    callback: {
      onContextOverflow: (event) => {
        overflowEvents.push({ ...event });
      },
    },
  });
  return { agent, llm };
}

function expectedNormalTrimChars(): number {
  return Math.max(40000, 230000 - 10000);
}

function expectedForcedTrimChars(): number {
  return tokensToCharHint(160000);
}

async function testOverflowOnceThenForcedCompressRecover(): Promise<void> {
  const harness = createHarness('once');
  try {
    const overflowEvents: ContextOverflowEvent[] = [];
    const { agent, llm } = createAgentWithScript(
      [
        { kind: 'overflow' },
        { kind: 'success', content: 'recovered-after-compress' },
      ],
      harness.workspaceDir,
      overflowEvents
    );

    const result = await agent.runWithResult('run task');
    assert.equal(result.content, 'recovered-after-compress');
    assert.equal(llm.calls.length, 2);
    assert.equal(llm.calls[0]?.snapshotStage, 'initial');
    assert.equal(llm.calls[1]?.snapshotStage, 'overflow_retry_after_compress');
    assert.equal(llm.calls[0]?.trimMaxTotalChars, expectedNormalTrimChars());
    assert.equal(llm.calls[1]?.trimMaxTotalChars, expectedNormalTrimChars());
    assert.equal(llm.calls.some((call) => call.trimMaxTotalChars === expectedForcedTrimChars()), false);
    assert.equal(
      overflowEvents.some((event) => event.stage === 'overflow_detected' && event.decision === 'retry_with_forced_compress'),
      true
    );
    assert.equal(
      overflowEvents.some((event) => event.stage === 'forced_compress' && event.decision === 'retry_with_forced_compress'),
      true
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testOverflowTwiceThenForcedTrimRecover(): Promise<void> {
  const harness = createHarness('twice');
  try {
    const overflowEvents: ContextOverflowEvent[] = [];
    const { agent, llm } = createAgentWithScript(
      [
        { kind: 'overflow' },
        { kind: 'overflow' },
        { kind: 'success', content: 'recovered-after-trim' },
      ],
      harness.workspaceDir,
      overflowEvents
    );

    const result = await agent.runWithResult('run task');
    assert.equal(result.content, 'recovered-after-trim');
    assert.equal(llm.calls.length, 3);
    assert.equal(llm.calls[0]?.snapshotStage, 'initial');
    assert.equal(llm.calls[1]?.snapshotStage, 'overflow_retry_after_compress');
    assert.equal(llm.calls[2]?.snapshotStage, 'overflow_retry_after_forced_trim');
    assert.equal(llm.calls[2]?.trimMaxTotalChars, expectedForcedTrimChars());
    assert.equal(llm.calls[0]?.trimMaxTotalChars, expectedNormalTrimChars());
    assert.equal(llm.calls[1]?.trimMaxTotalChars, expectedNormalTrimChars());
    assert.equal(
      overflowEvents.some((event) => event.stage === 'forced_trim' && event.decision === 'retry_with_forced_trim'),
      true
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testOverflowAfterForcedTrimFails(): Promise<void> {
  const harness = createHarness('fail');
  try {
    const overflowEvents: ContextOverflowEvent[] = [];
    const { agent } = createAgentWithScript(
      [
        { kind: 'overflow' },
        { kind: 'overflow' },
        { kind: 'overflow', message: '(2013) context window exceeds limit after forced trim' },
      ],
      harness.workspaceDir,
      overflowEvents
    );

    await assert.rejects(
      async () => {
        await agent.runWithResult('run task');
      },
      /context window/i
    );
    assert.equal(
      overflowEvents.some((event) => event.stage === 'forced_trim_failed' && event.decision === 'abort'),
      true
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testOverflowStageOrdering(): Promise<void> {
  const harness = createHarness('ordering');
  try {
    const overflowEvents: ContextOverflowEvent[] = [];
    const { agent } = createAgentWithScript(
      [
        { kind: 'overflow' },
        { kind: 'overflow' },
        { kind: 'success', content: 'ordered-recovery' },
      ],
      harness.workspaceDir,
      overflowEvents
    );

    const result = await agent.runWithResult('run task');
    assert.equal(result.content, 'ordered-recovery');

    const forcedCompressIndex = overflowEvents.findIndex((event) => event.stage === 'forced_compress');
    const forcedTrimIndex = overflowEvents.findIndex((event) => event.stage === 'forced_trim');
    assert.equal(forcedCompressIndex >= 0, true);
    assert.equal(forcedTrimIndex >= 0, true);
    assert.equal(forcedCompressIndex < forcedTrimIndex, true);

    const forcedTrimDetectedBeforeCompress = overflowEvents.some((event, index) => {
      if (event.stage !== 'overflow_detected' || event.decision !== 'retry_with_forced_trim') {
        return false;
      }
      return forcedCompressIndex < 0 || index < forcedCompressIndex;
    });
    assert.equal(forcedTrimDetectedBeforeCompress, false);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testPrecompressEmitsStartedAndCompleted(): Promise<void> {
  const harness = createHarness('precompress-events');
  try {
    const precompressEvents: ContextPrecompressEvent[] = [];
    const llm = new SlowCompressionLLMClient();
    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'You are a test agent.',
      maxSteps: 8,
      tokenLimit: 210000,
      contextBudget: createTestContextBudget({
        contextWindowChars: 100000,
        triggerRatio: 0.1,
        precompressKeepLlmRounds: 1,
        precompressChunkChars: 4000,
        precompressRetry: 0,
      }),
      workspaceDir: harness.workspaceDir,
      callback: {
        onContextPrecompress: (event) => {
          precompressEvents.push({ ...event });
        },
      },
    });
    const largeText = 'context-precompress '.repeat(900);
    agent.setMessages([
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
      { role: 'user', content: 'tail user' },
      { role: 'assistant', content: 'tail assistant' },
    ]);

    const result = await agent.runWithResult('tail prompt');

    assert.equal(result.content, 'unused');
    assert.equal(precompressEvents.some((event) => event.phase === 'started'), true);
    assert.equal(precompressEvents.some((event) => event.phase === 'completed'), true);
    assert.equal(precompressEvents.some((event) => event.phase === 'running'), true);
    const running = precompressEvents.find((event) => event.phase === 'running');
    assert.equal(running?.source, 'in_turn_precompress');
    assert.equal(typeof running?.progressPercent, 'number');
    const completed = precompressEvents.find((event) => event.phase === 'completed');
    assert.equal(typeof completed?.durationMs, 'number');
    assert.equal(completed?.willRetriggerImmediately, false);
    assert.equal(completed?.willRetriggerNextTurn, false);
    assert.equal(completed?.postCompactValidation, 'provider_payload');
    assert.equal(typeof completed?.providerPayloadCharsAfter, 'number');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testHardRiskPrecompressReportsTriggered(): Promise<void> {
  const harness = createHarness('precompress-hard-risk');
  try {
    const precompressEvents: ContextPrecompressEvent[] = [];
    const llm = new SlowCompressionLLMClient();
    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'You are a test agent.',
      maxSteps: 8,
      tokenLimit: 210000,
      contextBudget: createTestContextBudget({
        contextWindowChars: 238000,
        triggerRatio: 0.99,
        precompressKeepLlmRounds: 1,
        precompressChunkChars: 60000,
        precompressRetry: 0,
      }),
      workspaceDir: harness.workspaceDir,
      callback: {
        onContextPrecompress: (event) => {
          precompressEvents.push({ ...event });
        },
      },
    });
    const largeText = '压'.repeat(25000);
    agent.setMessages(Array.from({ length: 19 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${largeText}${index}`,
    })) as Message[]);

    const result = await agent.runWithResult('tail prompt');

    assert.equal(result.content, 'unused');
    assert.equal(precompressEvents.some((event) => event.phase === 'started'), false);
    assert.equal(precompressEvents.some((event) => event.phase === 'completed'), false);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testHardRiskPrecompressDoesNotReportTriggeredBeforeStart(): Promise<void> {
  const harness = createHarness('precompress-hard-risk-no-start');
  try {
    const precompressEvents: ContextPrecompressEvent[] = [];
    const llm = new SlowCompressionLLMClient();
    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'You are a test agent.',
      maxSteps: 8,
      tokenLimit: 210000,
      contextBudget: createTestContextBudget({
        contextWindowChars: 42000,
        triggerRatio: 0.99,
        precompressKeepLlmRounds: 5,
        precompressChunkChars: 60000,
        precompressRetry: 0,
      }),
      workspaceDir: harness.workspaceDir,
      callback: {
        onContextPrecompress: (event) => {
          precompressEvents.push({ ...event });
        },
      },
    });
    const largeText = 'x'.repeat(10000);
    agent.setMessages([
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
    ]);

    const event = await (agent as unknown as {
      applyPrecompressIfNeeded(systemPrompt: string, profileNormalizedCount: number): Promise<ContextPrecompressEvent>;
    }).applyPrecompressIfNeeded('You are a test agent.', 0);

    assert.equal(event.triggered, false);
    assert.equal(event.forced, false);
    assert.equal(event.applied, false);
    assert.equal(event.failureReason, undefined);
    assert.equal((event.totalCharsBefore ?? 0) >= Math.floor(42000 * 0.95), true);
    assert.equal((event.totalCharsBefore ?? 0) < (event.triggerThresholdChars ?? 0), true);
    assert.equal(precompressEvents.length, 0);
    assert.equal(llm.compressionCalls, 0);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testForcedPrecompressDoesNotReportTriggeredBeforeStart(): Promise<void> {
  const harness = createHarness('precompress-forced-no-start');
  try {
    const precompressEvents: ContextPrecompressEvent[] = [];
    const llm = new SlowCompressionLLMClient();
    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'You are a test agent.',
      maxSteps: 8,
      tokenLimit: 210000,
      contextBudget: createTestContextBudget({
        contextWindowChars: 42000,
        triggerRatio: 0.99,
        precompressKeepLlmRounds: 5,
        precompressChunkChars: 60000,
        precompressRetry: 0,
      }),
      workspaceDir: harness.workspaceDir,
      callback: {
        onContextPrecompress: (event) => {
          precompressEvents.push({ ...event });
        },
      },
    });
    agent.setMessages([
      { role: 'user', content: 'forced skip user' },
      { role: 'assistant', content: 'forced skip assistant' },
    ]);

    const prepared = await (agent as unknown as {
      prepareLlmInput(options: { forcePrecompress: boolean }): Promise<{ precompressEvent: ContextPrecompressEvent }>;
    }).prepareLlmInput({ forcePrecompress: true });

    assert.equal(prepared.precompressEvent.forced, true);
    assert.equal(prepared.precompressEvent.triggered, false);
    assert.equal(prepared.precompressEvent.applied, false);
    assert.equal(prepared.precompressEvent.phase, undefined);
    assert.equal(prepared.precompressEvent.failureReason, 'precompress_skipped_not_enough_older_messages');
    assert.equal(precompressEvents.length, 0);
    assert.equal(llm.compressionCalls, 0);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testProviderBoundaryProjectsToolResultArtifacts(): Promise<void> {
  const harness = createHarness('provider-projection');
  try {
    const { agent, llm } = createAgentWithScript(
      [{ kind: 'success', content: 'projected' }],
      harness.workspaceDir,
      []
    );
    const rawToolContent = `${'raw-secret-tool-output '.repeat(1200)}RAW_SECRET_TAIL_DO_NOT_SEND`;
    agent.setMessages([
      { role: 'user', content: 'previous task' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'tool-1',
            type: 'function',
            function: { name: 'large_tool', arguments: {} },
          },
        ],
      },
      {
        role: 'tool',
        name: 'large_tool',
        toolCallId: 'tool-1',
        content: rawToolContent,
        metadata: {
          toolResultArtifact: {
            artifactId: 'artifact-1',
            toolCallId: 'tool-1',
            toolName: 'large_tool',
            relativePath: 'tool-results/artifact-1.txt',
            originalChars: rawToolContent.length,
            previewChars: 3000,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    ]);

    const result = await agent.runWithResult('continue');

    assert.equal(result.content, 'projected');
    assert.match(llm.calls[0]?.text ?? '', /TOOL_RESULT_STORED/);
    assert.match(llm.calls[0]?.text ?? '', /artifact_id=artifact-1/);
    assert.doesNotMatch(llm.calls[0]?.text ?? '', /RAW_SECRET_TAIL_DO_NOT_SEND/);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testPromptTooLongRetryAttemptsTruncatedCandidate(): Promise<void> {
  const harness = createHarness('prompt-too-long-retry');
  try {
    const precompressEvents: ContextPrecompressEvent[] = [];
    const llm = new PromptTooLongCompressionLLMClient();
    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'You are a test agent.',
      maxSteps: 8,
      tokenLimit: 210000,
      contextBudget: createTestContextBudget({
        contextWindowChars: 100000,
        triggerRatio: 0.1,
        precompressKeepLlmRounds: 1,
        precompressChunkChars: 300000,
        precompressRetry: 0,
      }),
      workspaceDir: harness.workspaceDir,
      callback: {
        onContextPrecompress: (event) => {
          precompressEvents.push({ ...event });
        },
      },
    });
    const largeText = 'prompt-too-long-source '.repeat(900);
    agent.setMessages([
      { role: 'user', content: `${largeText}u1` },
      { role: 'assistant', content: `${largeText}a1` },
      { role: 'user', content: `${largeText}u2` },
      { role: 'assistant', content: `${largeText}a2` },
      { role: 'user', content: `${largeText}u3` },
      { role: 'assistant', content: `${largeText}a3` },
      { role: 'user', content: `${largeText}u4` },
      { role: 'assistant', content: `${largeText}a4` },
      { role: 'user', content: `${largeText}u5` },
      { role: 'assistant', content: `${largeText}a5` },
      { role: 'user', content: `${largeText}u6` },
      { role: 'assistant', content: `${largeText}a6` },
      { role: 'user', content: `${largeText}u7` },
      { role: 'assistant', content: `${largeText}a7` },
      { role: 'user', content: `${largeText}u8` },
      { role: 'assistant', content: `${largeText}a8` },
      { role: 'user', content: `${largeText}u9` },
      { role: 'assistant', content: `${largeText}a9` },
    ]);

    const result = await agent.runWithResult('tail prompt');

    assert.equal(result.content, 'after-compression-retry');
    assert.equal(llm.compressionCalls >= 3, true);
    const completed = precompressEvents.find((event) => event.phase === 'completed');
    assert.equal((completed?.retryCount ?? 0) >= 2, true);
    assert.equal((completed?.sourceDroppedMessageCount ?? 0) > 0, true);
    assert.match(completed?.failureReason ?? '', /^$/);
    const summary = agent.getMessages().find((message) =>
      String(message.content).startsWith('[CONTEXT_PRECOMPRESSED')
    );
    assert.match(String(summary?.content ?? ''), /source_dropped=[1-9]/);
    assert.match(String(summary?.content ?? ''), /COMPRESSION_SOURCE_TRUNCATED/);
    assert.equal(summary?.metadata?.contextCompaction?.sourceCoverage?.status, 'truncated');
    assert.equal(
      (summary?.metadata?.contextCompaction?.sourceCoverage?.droppedMessageCount ?? 0) > 0,
      true
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testCompressionChunkingUsesWholePromptSize(): Promise<void> {
  const harness = createHarness('chunk-sizing');
  try {
    const messages = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `small message ${index}`,
    })) as Message[];
    const chunks = chunkMessagesForCompression.call(
      {
        contextPrecompressChunkChars: 20000,
        buildCompressionChunk: (chunkMessages: Message[]) => ({
          messages: chunkMessages,
          preparedMessages: chunkMessages.map((message) => ({
            ...message,
            timestamp: '2026-01-01T00:00:00.000Z',
          })),
          chars: chunkMessages.reduce((sum, message) => sum + String(message.content ?? '').length, 0),
        }),
      },
      messages
    );

    assert.equal(chunks.length <= 3, true);
    assert.equal(chunks.every((chunk) => chunk.chars > 0), true);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testPostCompactValidationReportsRetriggerWithoutThresholdTrim(): Promise<void> {
  const harness = createHarness('post-compact-retrigger');
  try {
    const precompressEvents: ContextPrecompressEvent[] = [];
    const llm = new LargeSummaryCompressionLLMClient();
    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'You are a test agent.',
      maxSteps: 8,
      tokenLimit: 210000,
      contextBudget: createTestContextBudget({
        contextWindowChars: 100000,
        triggerRatio: 0.1,
        precompressKeepLlmRounds: 1,
        precompressChunkChars: 100000,
        precompressRetry: 0,
      }),
      workspaceDir: harness.workspaceDir,
      callback: {
        onContextPrecompress: (event) => {
          precompressEvents.push({ ...event });
        },
      },
    });
    const largeText = 'post-compact-source '.repeat(350);
    agent.setMessages([
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
      { role: 'user', content: 'tail user' },
      { role: 'assistant', content: 'tail assistant' },
    ]);

    const result = await agent.runWithResult('tail prompt');

    assert.equal(result.content, 'after-large-summary');
    assert.equal(precompressEvents.some((event) => event.applied === true), true);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runAll(): Promise<void> {
  await testOverflowOnceThenForcedCompressRecover();
  await testOverflowTwiceThenForcedTrimRecover();
  await testOverflowAfterForcedTrimFails();
  await testOverflowStageOrdering();
  await testPrecompressEmitsStartedAndCompleted();
  await testHardRiskPrecompressReportsTriggered();
  await testHardRiskPrecompressDoesNotReportTriggeredBeforeStart();
  await testForcedPrecompressDoesNotReportTriggeredBeforeStart();
  await testProviderBoundaryProjectsToolResultArtifacts();
  await testPromptTooLongRetryAttemptsTruncatedCandidate();
  await testCompressionChunkingUsesWholePromptSize();
  console.log('context-overflow-recovery tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
