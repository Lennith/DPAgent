import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent/index.js';
import { ToolRegistry } from '../../src/tools/index.js';
import type { LLMClient, LLMRequestOptions } from '../../src/llm/index.js';
import type { ContextOverflowEvent, ContextPrecompressEvent, LLMResponse, Message } from '../../src/types.js';

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
}

class PromptTooLongCompressionLLMClient {
  public compressionCalls = 0;

  async generate(_messages: Message[]): Promise<LLMResponse> {
    this.compressionCalls += 1;
    if (this.compressionCalls <= 3) {
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
    contextWindowChars: 230000,
    contextPrecompressTriggerRatio: 0.85,
    contextOverflowForcedTrimChars: 160000,
    contextOverflowMaxErrorsBeforeTrim: 2,
    contextPrecompressKeepLlmRounds: 5,
    contextPrecompressChunkChars: 20000,
    contextPrecompressRetry: 1,
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
    assert.equal(llm.calls.some((call) => call.trimMaxTotalChars === 160000), false);
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
    assert.equal(llm.calls[2]?.trimMaxTotalChars, 160000);
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
      contextWindowChars: 100000,
      contextPrecompressTriggerRatio: 0.1,
      contextPrecompressKeepLlmRounds: 1,
      contextPrecompressChunkChars: 4000,
      contextPrecompressRetry: 0,
      workspaceDir: harness.workspaceDir,
      callback: {
        onContextPrecompress: (event) => {
          precompressEvents.push({ ...event });
        },
      },
    });
    const largeText = 'context-precompress '.repeat(420);
    (agent as unknown as { messages: Message[] }).messages = [
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
      { role: 'user', content: 'tail user' },
      { role: 'assistant', content: 'tail assistant' },
    ];

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

async function testProviderBoundaryProjectsToolResultArtifacts(): Promise<void> {
  const harness = createHarness('provider-projection');
  try {
    const { agent, llm } = createAgentWithScript(
      [{ kind: 'success', content: 'projected' }],
      harness.workspaceDir,
      []
    );
    const rawToolContent = `${'raw-secret-tool-output '.repeat(1200)}RAW_SECRET_TAIL_DO_NOT_SEND`;
    (agent as unknown as { messages: Message[] }).messages = [
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
    ];

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
      contextWindowChars: 100000,
      contextPrecompressTriggerRatio: 0.1,
      contextPrecompressKeepLlmRounds: 1,
      contextPrecompressChunkChars: 300000,
      contextPrecompressRetry: 0,
      workspaceDir: harness.workspaceDir,
      callback: {
        onContextPrecompress: (event) => {
          precompressEvents.push({ ...event });
        },
      },
    });
    const largeText = 'prompt-too-long-source '.repeat(900);
    (agent as unknown as { messages: Message[] }).messages = [
      { role: 'user', content: `${largeText}u1` },
      { role: 'assistant', content: `${largeText}a1` },
      { role: 'user', content: `${largeText}u2` },
      { role: 'assistant', content: `${largeText}a2` },
      { role: 'user', content: `${largeText}u3` },
      { role: 'assistant', content: `${largeText}a3` },
      { role: 'user', content: `${largeText}u4` },
      { role: 'assistant', content: `${largeText}a4` },
    ];

    const result = await agent.runWithResult('tail prompt');

    assert.equal(result.content, 'after-compression-retry');
    assert.equal(llm.compressionCalls, 4);
    const completed = precompressEvents.find((event) => event.phase === 'completed');
    assert.equal(completed?.retryCount, 3);
    assert.equal((completed?.sourceDroppedMessageCount ?? 0) > 0, true);
    assert.match(completed?.failureReason ?? '', /^$/);
    const summary = (agent as unknown as { messages: Message[] }).messages.find((message) =>
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
    const { agent } = createAgentWithScript([{ kind: 'success', content: 'unused' }], harness.workspaceDir, []);
    const messages = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `small message ${index}`,
    })) as Message[];
    const chunks = (agent as unknown as {
      chunkMessagesForCompression(messages: Message[], maxChars: number): Array<{ chars: number }>;
    }).chunkMessagesForCompression(messages, 20000);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.chars < 20000, true);
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
      contextWindowChars: 100000,
      contextPrecompressTriggerRatio: 0.1,
      contextPrecompressKeepLlmRounds: 1,
      contextPrecompressChunkChars: 100000,
      contextPrecompressRetry: 0,
      workspaceDir: harness.workspaceDir,
      callback: {
        onContextPrecompress: (event) => {
          precompressEvents.push({ ...event });
        },
      },
    });
    const largeText = 'post-compact-source '.repeat(350);
    (agent as unknown as { messages: Message[] }).messages = [
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
      { role: 'user', content: largeText },
      { role: 'assistant', content: largeText },
      { role: 'user', content: 'tail user' },
      { role: 'assistant', content: 'tail assistant' },
    ];

    const result = await agent.runWithResult('tail prompt');

    assert.equal(result.content, 'after-large-summary');
    const completed = precompressEvents.find(
      (event) => event.phase === 'completed' && event.postCompactValidation === 'provider_payload'
    );
    assert.equal(completed?.willRetriggerNextTurn, true);
    assert.equal((completed?.providerPayloadCharsAfter ?? 0) >= (completed?.triggerThresholdChars ?? 0), true);
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
  await testProviderBoundaryProjectsToolResultArtifacts();
  await testPromptTooLongRetryAttemptsTruncatedCandidate();
  await testCompressionChunkingUsesWholePromptSize();
  await testPostCompactValidationReportsRetriggerWithoutThresholdTrim();
  console.log('context-overflow-recovery tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
