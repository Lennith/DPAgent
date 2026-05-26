import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent/index.js';
import { ToolRegistry } from '../../src/tools/index.js';
import type { LLMClient } from '../../src/llm/index.js';
import type {
  LLMResponse,
  Message,
  ToolCall,
  ToolResult,
} from '../../src/types.js';
import {
  buildPreparedInputUsageSnapshot,
  type PreparedInputUsageSnapshot,
} from '../../src/runtime/context-window-budget.js';
import { ContextUsageCalibrationStore } from '../../src/runtime/context-usage-calibration-store.js';
import { Tool } from '../../src/tools/Tool.js';
import { createResolvedTestContextBudget } from './test-context-budget.js';

class NoopTool extends Tool {
  get name(): string {
    return 'noop_tool';
  }

  get description(): string {
    return 'Returns a short payload for testing.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {},
    };
  }

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return {
      success: true,
      content: 'noop-result',
    };
  }
}

type ScriptedResponse = {
  content: string;
  finishReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  toolCalls?: ToolCall[];
};

class ScriptedAnchorLLMClient {
  public readonly callTexts: string[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: ScriptedResponse[]) {}

  getRuntimeConfig() {
    return {
      profileId: 'default',
      provider: 'anthropic' as const,
      apiKey: 'test',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7-highspeed',
      maxOutputTokens: 4096,
      reasoningPreset: 'off' as const,
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: false,
      },
    };
  }

  capturePreparedInputUsageSnapshot(messages: Message[]): PreparedInputUsageSnapshot {
    const text = messages.map((message) => messageText(message.content)).join('\n');
    const payloadFor = (marker: string) =>
      buildPreparedInputUsageSnapshot({
        model: 'MiniMax-M2.7-highspeed',
        system: 'You are a test agent.',
        tools: [{ name: 'noop_tool' }],
        messages: [{ role: 'user', content: marker }],
      });
    if (text.includes('TINY-USAGE-RUN')) {
      const snapshot = payloadFor('TINY-USAGE-RUN');
      return { ...snapshot, rawChars: 143520, inputTokens: 35880 };
    }
    if (text.includes('[CONTEXT_PRECOMPRESSED')) {
      const snapshot = payloadFor('C');
      return { ...snapshot, rawChars: 40, inputTokens: 20 };
    }
    if (text.includes('noop-result')) {
      const snapshot = buildPreparedInputUsageSnapshot({
        model: 'MiniMax-M2.7-highspeed',
        system: 'You are a test agent.',
        tools: [{ name: 'noop_tool' }],
        messages: [
          { role: 'user', content: 'A' },
          {
            role: 'assistant',
            content: 'B',
            tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'noop_tool', arguments: {} } }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'noop-result' }] },
        ],
      });
      return { ...snapshot, rawChars: 120, inputTokens: 60 };
    }
    const snapshot = payloadFor('A');
    return { ...snapshot, rawChars: 100, inputTokens: 50 };
  }

  async generate(messages: Message[]): Promise<LLMResponse> {
    this.callTexts.push(messages.map((message) => messageText(message.content)).join('\n'));
    return {
      content: 'compressed-summary',
      finishReason: 'end_turn',
    };
  }

  async generateWithCallbacks(
    messages: Message[],
    callbacks: {
      onText?: (text: string) => void;
      onComplete?: (result: unknown) => void;
      onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
    }
  ): Promise<LLMResponse> {
    this.callTexts.push(messages.map((message) => messageText(message.content)).join('\n'));
    const response = this.responses[this.responseIndex];
    if (!response) {
      throw new Error(`Missing scripted response at index ${this.responseIndex}`);
    }
    this.responseIndex += 1;
    callbacks.onText?.(response.content);
    for (const toolCall of response.toolCalls ?? []) {
      callbacks.onToolUse?.(toolCall.id, toolCall.function.name, toolCall.function.arguments);
    }
    callbacks.onComplete?.(response);
    return response;
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<ScriptedLLMClient['generateWithCallbacks']>
  ): ReturnType<ScriptedLLMClient['generateWithCallbacks']> {
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

function seedAgentHistory(agent: Agent): void {
  agent.setMessages([
    { role: 'user', content: 'historical-user-1 ' + 'x'.repeat(2000) },
    { role: 'assistant', content: 'historical-assistant-1 ' + 'y'.repeat(2000) },
    { role: 'user', content: 'historical-user-2 ' + 'z'.repeat(2000) },
    { role: 'assistant', content: 'historical-assistant-2 ' + 'w'.repeat(2000) },
  ]);
}

async function testUsageAnchorTriggersSameTurnPrecompressAndClearsOnNewTurn(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-usage-anchor-'));
  try {
    const usageEvents: Array<{ source: string; stage: string; usedTokens: number; anchorPromptTokens?: number; deltaEstimatedTokens?: number }> = [];
    const llm = new ScriptedAnchorLLMClient([
      {
        content: 'Let me inspect the logs first.',
        finishReason: 'tool_use',
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
        },
        toolCalls: [
          {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'noop_tool',
              arguments: {},
            },
          },
        ],
      },
      {
        content: 'done-first-run',
        finishReason: 'end_turn',
      },
      {
        content: 'done-second-run',
        finishReason: 'end_turn',
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(new NoopTool());

    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: registry,
      systemPrompt: 'You are a test agent.',
      workspaceDir: tempDir,
      maxSteps: 4,
      callback: {
        onContextUsageEstimate: (event) => {
          usageEvents.push({
            source: event.source,
            stage: event.stage,
            usedTokens: event.usedTokens,
            anchorPromptTokens: event.anchorPromptTokens,
            deltaEstimatedTokens: event.deltaEstimatedTokens,
          });
        },
      },
      contextBudget: createResolvedTestContextBudget({
        contextWindowTokens: 100,
        reservedOutputTokens: 0,
        reservedReasoningTokens: 0,
        reservedProtocolTokens: 0,
        compressionTriggerRatio: 0.8,
        precompressKeepLlmRounds: 1,
        precompressChunkChars: 2000,
        minTokensAddedAfterCompression: 0,
      }),
    });

    seedAgentHistory(agent);
    const first = await agent.runWithResult('FIRST-RUN');
    assert.equal(first.content, 'done-first-run');
    assert.equal(
      usageEvents.some(
        (event) =>
          event.stage === 'provider_usage_anchor' &&
          event.source === 'provider_usage' &&
          event.usedTokens === 100 &&
          event.anchorPromptTokens === 100 &&
          event.deltaEstimatedTokens === 0
      ),
      true
    );
    assert.equal(
      llm.callTexts.some((text) => text.includes('[CONTEXT_PRECOMPRESSED')),
      true
    );

    llm.callTexts.length = 0;
    seedAgentHistory(agent);
    const second = await agent.runWithResult('SECOND-RUN');
    assert.equal(second.content, 'done-second-run');
    assert.equal(
      llm.callTexts.some((text) => text.includes('[CONTEXT_PRECOMPRESSED')),
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testImplausibleTinyUsageDoesNotPolluteCalibration(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-usage-calibration-'));
  try {
    const llm = new ScriptedAnchorLLMClient([
      {
        content: 'done-tiny-usage',
        finishReason: 'end_turn',
        usage: {
          promptTokens: 420,
          completionTokens: 20,
          totalTokens: 440,
        },
      },
    ]);
    const calibrationStore = new ContextUsageCalibrationStore(tempDir);
    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'You are a test agent.',
      workspaceDir: tempDir,
      maxSteps: 2,
      contextUsageCalibrationStore: calibrationStore,
      contextBudget: createResolvedTestContextBudget({
        contextWindowTokens: 230000,
        reservedOutputTokens: 0,
        reservedReasoningTokens: 0,
        reservedProtocolTokens: 0,
        compressionTriggerRatio: 0.9,
      }),
    });

    seedAgentHistory(agent);
    await agent.runWithResult('TINY-USAGE-RUN');

    assert.equal(
      calibrationStore.getMultiplier({
        adapterProvider: 'anthropic',
        apiBase: 'https://api.minimaxi.com',
        model: 'MiniMax-M2.7-highspeed',
      }),
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testUsageAnchorTriggersSameTurnPrecompressAndClearsOnNewTurn();
  await testImplausibleTinyUsageDoesNotPolluteCalibration();
  console.log('agent-context-usage-anchor tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
