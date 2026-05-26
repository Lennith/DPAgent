import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent/index.js';
import type { LLMRequestOptions } from '../../src/llm/index.js';
import { Tool, ToolRegistry, type ToolExecuteOptions } from '../../src/tools/index.js';
import type { Message, ToolCall, ToolResult } from '../../src/types.js';
import { createResolvedTestContextBudget } from './test-context-budget.js';

class RecordingTool extends Tool {
  public lastSignal: AbortSignal | undefined;

  get name(): string {
    return 'shell_execute';
  }

  get description(): string {
    return 'records tool execution options';
  }

  get parameters(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }

  async execute(_args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult> {
    this.lastSignal = options?.signal;
    return { success: true, content: 'tool ok' };
  }
}

class RecordingLLMClient {
  public readonly options: Array<LLMRequestOptions | undefined> = [];
  private callCount = 0;

  async generatePreparedWithCallbacks(
    _messages: Message[],
    callbacks: {
      onText?: (text: string) => void;
      onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
      onComplete?: (result: unknown) => void;
    },
    _tools?: unknown,
    _systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<{ content: string; finishReason: string; toolCalls?: ToolCall[] }> {
    this.options.push(options);
    this.callCount += 1;
    if (this.callCount === 1) {
      const toolCall: ToolCall = {
        id: 'tool-1',
        type: 'function',
        function: { name: 'shell_execute', arguments: {} },
      };
      callbacks.onToolUse?.(toolCall.id, toolCall.function.name, toolCall.function.arguments);
      const response = { content: '', finishReason: 'tool_use', toolCalls: [toolCall] };
      callbacks.onComplete?.(response);
      return response;
    }
    callbacks.onText?.('done');
    const response = { content: 'done', finishReason: 'end_turn' };
    callbacks.onComplete?.(response);
    return response;
  }

  async generateWithCallbacks(
    ...args: Parameters<RecordingLLMClient['generatePreparedWithCallbacks']>
  ): ReturnType<RecordingLLMClient['generatePreparedWithCallbacks']> {
    return this.generatePreparedWithCallbacks(...args);
  }

  async generate(): Promise<{ content: string; finishReason: string }> {
    return { content: 'compressed', finishReason: 'end_turn' };
  }
}

class AbortAwareLLMClient {
  public signal: AbortSignal | undefined;
  public started = false;

  async generatePreparedWithCallbacks(
    _messages: Message[],
    _callbacks: Record<string, unknown>,
    _tools?: unknown,
    _systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<{ content: string; finishReason: string }> {
    this.started = true;
    this.signal = options?.signal;
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => reject(new Error('llm aborted')),
        { once: true }
      );
    });
  }

  async generateWithCallbacks(
    ...args: Parameters<AbortAwareLLMClient['generatePreparedWithCallbacks']>
  ): ReturnType<AbortAwareLLMClient['generatePreparedWithCallbacks']> {
    return this.generatePreparedWithCallbacks(...args);
  }

  async generate(): Promise<{ content: string; finishReason: string }> {
    return { content: 'compressed', finishReason: 'end_turn' };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for predicate.');
}

function createAgent(llm: unknown, tools: ToolRegistry, workspaceDir: string): Agent {
  return new Agent({
    llmClient: llm as never,
    toolRegistry: tools,
    systemPrompt: 'system',
    maxSteps: 3,
    contextBudget: createResolvedTestContextBudget(),
    workspaceDir,
  });
}

async function run(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cancel-signal-'));
  try {
    const llm = new RecordingLLMClient();
    const tools = new ToolRegistry();
    const tool = new RecordingTool();
    tools.register(tool);
    const agent = createAgent(llm, tools, tempDir);

    const result = await agent.runWithResult('use the tool');
    assert.equal(result.content, 'done');
    assert.equal(llm.options.length, 2);
    assert.ok(llm.options.every((item) => item?.signal instanceof AbortSignal));
    assert.ok(tool.lastSignal instanceof AbortSignal);

    const abortingLlm = new AbortAwareLLMClient();
    const abortingAgent = createAgent(abortingLlm, new ToolRegistry(), tempDir);
    const abortingRun = abortingAgent.runWithResult('cancel during llm');
    await waitFor(() => abortingLlm.started);
    abortingAgent.cancel();
    const abortedResult = await abortingRun;
    assert.equal(abortedResult.finishReason, 'cancelled');
    assert.equal(abortingLlm.signal?.aborted, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run()
  .then(() => {
    console.log('agent cancel signal tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
