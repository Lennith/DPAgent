import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent/index.js';
import { ToolRegistry } from '../../src/tools/index.js';
import { Tool } from '../../src/tools/Tool.js';
import type { LLMClient } from '../../src/llm/index.js';
import type { AgentCompletionMeta, Message, ToolCall, ToolResult } from '../../src/types.js';

type ScriptedResponse = {
  content: string;
  finishReason: string;
  toolCalls?: ToolCall[];
};

class FailIfExecutedTool extends Tool {
  public executed = false;

  get name(): string {
    return 'todo';
  }

  get description(): string {
    return 'Test todo tool';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {},
    };
  }

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    this.executed = true;
    return { success: true, content: 'unexpected execution' };
  }
}

class EchoTool extends Tool {
  public executed = false;

  get name(): string {
    return 'write_file';
  }

  get description(): string {
    return 'Test write tool';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    this.executed = true;
    return {
      success: true,
      content: `wrote ${String(args.path ?? 'unknown')}`,
    };
  }
}

class LargeResultTool extends Tool {
  get name(): string {
    return 'shell_execute';
  }

  get description(): string {
    return 'Test large result tool';
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
      content: 'x'.repeat(10_000),
    };
  }
}

class ScriptedLLMClient {
  public callCount = 0;

  constructor(private readonly responses: ScriptedResponse[]) {}

  async generateWithCallbacks(
    _messages: Message[],
    callbacks: {
      onText?: (text: string) => void;
      onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
      onComplete?: (result: unknown) => void;
    }
  ): Promise<{
    content: string;
    finishReason: string;
  }> {
    const response = this.responses[this.callCount];
    if (!response) {
      throw new Error(`Missing scripted response at call ${this.callCount}`);
    }

    this.callCount += 1;
    callbacks.onText?.(response.content);
    for (const toolCall of response.toolCalls ?? []) {
      callbacks.onToolUse?.(toolCall.id, toolCall.function.name, toolCall.function.arguments);
    }
    callbacks.onComplete?.(response);
    return response;
  }
}

async function runCase(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-finish-reason-'));
  try {
    const llm = new ScriptedLLMClient([
      { content: 'still working', finishReason: 'pause_turn' },
      { content: 'done', finishReason: 'end_turn' },
    ]);

    const completionEvents: Array<{
      result: string;
      finishReason?: string;
      meta?: AgentCompletionMeta;
    }> = [];

    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'You are a test agent.',
      workspaceDir: tempDir,
      maxSteps: 4,
      callback: {
        onComplete: (result, finishReason, meta) => {
          completionEvents.push({ result, finishReason, meta });
        },
      },
    });

    const result = await agent.runWithResult('run task');

    assert.equal(llm.callCount, 2);
    assert.equal(result.content, 'done');
    assert.equal(result.finishReason, 'end_turn');
    assert.equal(completionEvents.length, 1);
    assert.equal(completionEvents[0]?.finishReason, 'end_turn');
    assert.equal(completionEvents[0]?.meta?.step, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runProgressOnlyRecoveryCase(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-progress-only-recovery-'));
  try {
    const llm = new ScriptedLLMClient([
      { content: 'Let me inspect the logs first.', finishReason: 'end_turn' },
      { content: 'done', finishReason: 'end_turn' },
    ]);

    const completionEvents: Array<{
      result: string;
      finishReason?: string;
      meta?: AgentCompletionMeta;
    }> = [];

    const systemMessages: string[] = [];

    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'You are a test agent.',
      workspaceDir: tempDir,
      maxSteps: 4,
      callback: {
        onMessage: (role, content) => {
          if (role === 'system') {
            systemMessages.push(content);
          }
        },
        onComplete: (result, finishReason, meta) => {
          completionEvents.push({ result, finishReason, meta });
        },
      },
    });

    const result = await agent.runWithResult('run task');

    assert.equal(llm.callCount, 2);
    assert.equal(result.content, 'done');
    assert.equal(result.finishReason, 'end_turn');
    assert.equal(systemMessages.some((content) => content.includes('[EXECUTION_CONTINUE_REQUIRED')), true);
    assert.equal(completionEvents.length, 1);
    assert.equal(completionEvents[0]?.finishReason, 'end_turn');
    assert.equal(completionEvents[0]?.meta?.step, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runProgressOnlyRecoveryDisabledCase(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-progress-only-disabled-'));
  try {
    const llm = new ScriptedLLMClient([
      { content: 'Let me inspect the logs first.', finishReason: 'end_turn' },
    ]);

    const systemMessages: string[] = [];

    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'You are a test agent.',
      workspaceDir: tempDir,
      maxSteps: 4,
      progressOnlyRecoveryEnabled: false,
      callback: {
        onMessage: (role, content) => {
          if (role === 'system') {
            systemMessages.push(content);
          }
        },
      },
    });

    const result = await agent.runWithResult('run task');

    assert.equal(llm.callCount, 1);
    assert.equal(result.content, 'Let me inspect the logs first.');
    assert.equal(result.finishReason, 'end_turn');
    assert.equal(systemMessages.some((content) => content.includes('[EXECUTION_CONTINUE_REQUIRED')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runCancelAfterToolUseEmitsCompletionCase(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cancel-tool-use-'));
  try {
    const toolCall: ToolCall = {
      id: 'tool-1',
      type: 'function',
      function: {
        name: 'todo',
        arguments: { action: 'plan_set', items: [] },
      },
    };
    const llm = new ScriptedLLMClient([
      {
        content: 'I will create the plan first.',
        finishReason: 'tool_use',
        toolCalls: [toolCall],
      },
    ]);
    const tool = new FailIfExecutedTool();
    const registry = new ToolRegistry();
    registry.register(tool);

    const completionEvents: Array<{
      result: string;
      finishReason?: string;
      meta?: AgentCompletionMeta;
    }> = [];

    let agent: Agent | null = null;
    agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: registry,
      systemPrompt: 'You are a test agent.',
      workspaceDir: tempDir,
      maxSteps: 4,
      callback: {
        onToolCall: () => {
          agent?.cancel();
        },
        onComplete: (result, finishReason, meta) => {
          completionEvents.push({ result, finishReason, meta });
        },
      },
    });

    const result = await agent.runWithResult('run task');

    assert.equal(llm.callCount, 1);
    assert.equal(tool.executed, false);
    assert.equal(result.content, 'Task cancelled by user.');
    assert.equal(result.finishReason, 'cancelled');
    assert.equal(completionEvents.length, 1);
    assert.equal(completionEvents[0]?.result, 'Task cancelled by user.');
    assert.equal(completionEvents[0]?.finishReason, 'cancelled');
    assert.equal(completionEvents[0]?.meta?.finishReason, 'cancelled');
    assert.equal(completionEvents[0]?.meta?.step, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runToolResultMessagePersistsBeforeCancelCase(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tool-result-persist-'));
  try {
    const toolCall: ToolCall = {
      id: 'tool-keep-1',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: { path: 'src/app.ts' },
      },
    };
    const llm = new ScriptedLLMClient([
      {
        content: 'Applying the patch now.',
        finishReason: 'tool_use',
        toolCalls: [toolCall],
      },
    ]);
    const tool = new EchoTool();
    const registry = new ToolRegistry();
    registry.register(tool);

    let agent: Agent | null = null;
    agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: registry,
      systemPrompt: 'You are a test agent.',
      workspaceDir: tempDir,
      maxSteps: 4,
      callback: {
        onToolResult: () => {
          agent?.cancel();
        },
      },
    });

    const result = await agent.runWithResult('run task');

    const persistedToolMessages = agent.getMessages().filter((message) => message.role === 'tool');
    assert.equal(tool.executed, true);
    assert.equal(result.finishReason, 'cancelled');
    assert.equal(persistedToolMessages.length, 1);
    assert.equal(persistedToolMessages[0]?.toolCallId, 'tool-keep-1');
    assert.match(String(persistedToolMessages[0]?.content ?? ''), /wrote src\/app\.ts/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runLargeToolResultUsesAgentInlineBudgetForArtifactsCase(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tool-result-artifact-budget-'));
  try {
    const toolCall: ToolCall = {
      id: 'tool-large-1',
      type: 'function',
      function: {
        name: 'shell_execute',
        arguments: {},
      },
    };
    const llm = new ScriptedLLMClient([
      {
        content: 'Inspecting command output.',
        finishReason: 'tool_use',
        toolCalls: [toolCall],
      },
      {
        content: 'done',
        finishReason: 'end_turn',
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(new LargeResultTool());
    const materializeCalls: Array<{ thresholdChars?: number; previewChars?: number; content: string }> = [];

    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: registry,
      systemPrompt: 'You are a test agent.',
      workspaceDir: tempDir,
      maxSteps: 4,
      materializeToolResultArtifact: (input) => {
        materializeCalls.push({
          thresholdChars: input.thresholdChars,
          previewChars: input.previewChars,
          content: input.content,
        });
        assert.equal(input.thresholdChars, 4000);
        return {
          content:
            '[TOOL_RESULT_STORED tool=shell_execute tool_call_id=tool-large-1 artifact_id=artifact-1 original_chars=10000 preview_chars=3000]\n' +
            'Use read_tool_result with artifact_id, offset, and limit when the full output is needed.\n\n' +
            `Preview:\n${input.content.slice(0, 3000)}`,
          artifact: {
            artifactId: 'artifact-1',
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            relativePath: 'tool-results/artifact-1.txt',
            originalChars: input.content.length,
            previewChars: 3000,
            createdAt: '2026-04-27T00:00:00.000Z',
          },
        };
      },
    });

    await agent.runWithResult('run task');

    const persistedToolMessages = agent.getMessages().filter((message) => message.role === 'tool');
    assert.equal(materializeCalls.length, 1);
    assert.equal(materializeCalls[0]?.content.length, 10_000);
    assert.equal(persistedToolMessages.length, 1);
    const toolMessage = persistedToolMessages[0];
    assert.match(String(toolMessage?.content ?? ''), /TOOL_RESULT_STORED/);
    assert.doesNotMatch(String(toolMessage?.content ?? ''), /TOOL_RESULT_TRUNCATED/);
    assert.equal(toolMessage?.metadata?.toolResultArtifact?.artifactId, 'artifact-1');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

Promise.all([
  runCase(),
  runProgressOnlyRecoveryCase(),
  runProgressOnlyRecoveryDisabledCase(),
  runCancelAfterToolUseEmitsCompletionCase(),
  runToolResultMessagePersistsBeforeCancelCase(),
  runLargeToolResultUsesAgentInlineBudgetForArtifactsCase(),
])
  .then(() => {
    console.log('agent-finish-reason-gating test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
