import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent/index.js';
import { HookRegistry, HookRunner } from '../../src/hooks/index.js';
import { Tool, ToolRegistry } from '../../src/tools/index.js';
import type { LLMRequestOptions } from '../../src/llm/index.js';
import type { Message, ToolCall, ToolResult } from '../../src/types.js';
import { createResolvedTestContextBudget } from './test-context-budget.js';

class CaptureLLMClient {
  public readonly calls: Array<{ messages: Message[]; systemPrompt?: string }> = [];
  private readonly responses: Array<{ content: string; finishReason: string; toolCalls?: ToolCall[] }>;

  constructor(responses: Array<{ content: string; finishReason: string; toolCalls?: ToolCall[] }>) {
    this.responses = responses;
  }

  async generatePreparedWithCallbacks(
    messages: Message[],
    callbacks: {
      onText?: (text: string) => void;
      onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
      onComplete?: (result: unknown) => void;
    },
    _tools?: unknown,
    systemPrompt?: string,
    _options?: LLMRequestOptions
  ): Promise<{ content: string; finishReason: string; toolCalls?: ToolCall[] }> {
    this.calls.push({ messages, systemPrompt });
    const response = this.responses.shift() ?? { content: 'done', finishReason: 'end_turn' };
    for (const toolCall of response.toolCalls ?? []) {
      callbacks.onToolUse?.(toolCall.id, toolCall.function.name, toolCall.function.arguments);
    }
    if (response.content) {
      callbacks.onText?.(response.content);
    }
    callbacks.onComplete?.(response);
    return response;
  }

  async generateWithCallbacks(
    ...args: Parameters<CaptureLLMClient['generatePreparedWithCallbacks']>
  ): ReturnType<CaptureLLMClient['generatePreparedWithCallbacks']> {
    return this.generatePreparedWithCallbacks(...args);
  }

  async generate(): Promise<{ content: string; finishReason: string }> {
    return { content: 'compressed', finishReason: 'end_turn' };
  }
}

class RecordingTool extends Tool {
  public calls: Record<string, unknown>[] = [];

  constructor(private readonly toolName: string) {
    super();
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return `${this.toolName} test tool`;
  }

  get parameters(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push(args);
    return { success: true, content: `${this.toolName} ok` };
  }
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

async function testInputHookModifiedRewritesPreparedLlmInput(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hook-input-modified-'));
  try {
    const llm = new CaptureLLMClient([{ content: 'ok', finishReason: 'end_turn' }]);
    const agent = createAgent(llm, new ToolRegistry(), tempDir);
    const registry = new HookRegistry();
    registry.registerSystemHook(
      { id: 'input-rewriter', events: ['onInputToLLM'], module: 'system' },
      {
        onInputToLLM: () => ({
          action: 'continue',
          modified: {
            systemPrompt: 'rewritten system',
            input: 'rewritten user input',
          },
        }),
      }
    );
    agent.setHooks(new HookRunner(), registry);

    const result = await agent.runWithResult('original user input');
    assert.equal(result.content, 'ok');
    assert.equal(llm.calls[0]?.systemPrompt, 'rewritten system');
    const lastUser = llm.calls[0]?.messages.filter((message) => message.role === 'user').at(-1);
    assert.equal(lastUser?.content, 'rewritten user input');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testBeforeToolHookModifiedRewritesExecutedToolCall(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hook-tool-modified-'));
  try {
    const alpha = new RecordingTool('alpha_tool');
    const beta = new RecordingTool('beta_tool');
    const tools = new ToolRegistry();
    tools.register(alpha);
    tools.register(beta);
    const toolCall: ToolCall = {
      id: 'tool-1',
      type: 'function',
      function: { name: 'alpha_tool', arguments: { old: true } },
    };
    const llm = new CaptureLLMClient([
      { content: '', finishReason: 'tool_use', toolCalls: [toolCall] },
      { content: 'done', finishReason: 'end_turn' },
    ]);
    const agent = createAgent(llm, tools, tempDir);
    const registry = new HookRegistry();
    registry.registerSystemHook(
      { id: 'tool-rewriter', events: ['onBeforeToolCall'], module: 'system' },
      {
        onBeforeToolCall: () => ({
          action: 'continue',
          modified: {
            toolName: 'beta_tool',
            toolArgs: { rewritten: true },
          },
        }),
      }
    );
    agent.setHooks(new HookRunner(), registry);

    const result = await agent.runWithResult('use a tool');
    assert.equal(result.content, 'done');
    assert.deepEqual(alpha.calls, []);
    assert.deepEqual(beta.calls, [{ rewritten: true }]);
    const replayedAssistant = llm.calls[1]?.messages.find((message) => message.role === 'assistant' && message.toolCalls);
    assert.equal(replayedAssistant?.toolCalls?.[0]?.function.name, 'beta_tool');
    assert.deepEqual(replayedAssistant?.toolCalls?.[0]?.function.arguments, { rewritten: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

void (async () => {
  await testInputHookModifiedRewritesPreparedLlmInput();
  await testBeforeToolHookModifiedRewritesExecutedToolCall();
  console.log('agent hook modified tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
