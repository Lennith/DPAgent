import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MiniMaxAgent } from '../../src/index.js';
import type { LLMRequestOptions, LLMStreamEvent } from '../../src/llm/index.js';
import { OpenAICompatibleAdapter } from '../../src/llm/providers/OpenAICompatibleAdapter.js';
import type { ContextRef, LLMResponse, Message, ToolSchema } from '../../src/types.js';

function appendPersistedToolOnlyAssistantTurn(agent: MiniMaxAgent, context: ContextRef): void {
  const manager = agent.getContextManager();
  const turn = manager.beginTurn(context, 'Inspect package metadata');
  manager.commitTurn(turn.turnId, {
    messages: [
      { role: 'user', content: 'Inspect package metadata' },
      {
        role: 'assistant',
        content: '',
        thinking: 'Need to inspect package.json before answering.',
        toolCalls: [
          {
            id: 'call-openai-replay',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: { path: 'package.json' },
            },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call-openai-replay',
        name: 'read_file',
        content: '{"name":"minimax-agent"}',
      },
      { role: 'assistant', content: 'The package name is minimax-agent.' },
    ],
    finalOutputText: 'The package name is minimax-agent.',
    finishReason: 'end_turn',
  });
}

async function runOpenAiProviderTurnCase(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-openai-provider-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDataDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDataDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });

  const originalGenerateStream = OpenAICompatibleAdapter.prototype.generateStream;
  let capturedMessages: Message[] | null = null;
  let capturedTools: ToolSchema[] | undefined;
  let capturedSystemPrompt: string | undefined;
  let capturedOptions: LLMRequestOptions | undefined;
  let agent: MiniMaxAgent | null = null;

  try {
    OpenAICompatibleAdapter.prototype.generateStream = async function* (
      messages: Message[],
      tools?: ToolSchema[],
      systemPrompt?: string,
      options?: LLMRequestOptions
    ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
      capturedMessages = messages;
      capturedTools = tools;
      capturedSystemPrompt = systemPrompt;
      capturedOptions = options;

      const response: LLMResponse = {
        content: 'openai provider path ok',
        finishReason: 'end_turn',
        usage: {
          promptTokens: 8,
          completionTokens: 4,
          totalTokens: 12,
        },
      };

      yield { type: 'text', data: response.content };
      yield { type: 'complete', data: response };
      return response;
    };

    agent = new MiniMaxAgent({
      config: {
        api: {
          apiKey: 'test-api-key-0123456789012345',
          apiBase: 'https://openai-compatible.local/v1',
          model: 'gpt-4o-mini',
          provider: 'openai',
          maxOutputTokens: 4096,
        },
        agent: {
          workspaceDir,
        },
        tools: {
          enableFileTools: false,
          enableWeb: false,
          enableShell: false,
        },
        mcp: {
          enabled: false,
          servers: [],
        },
      },
      workspaceDir,
      runtimeDataDir,
      contextDir,
    });

    const context: ContextRef = {
      scope: 'session',
      namespace: 'provider-openai-smoke',
    };

    const result = await agent.runWithResult({
      prompt: 'Reply with a short confirmation.',
      context,
      workspaceDir,
    });

    assert.equal(((agent as any).llmClient as { provider?: string } | null)?.provider, 'openai');
    assert.equal(
      (((agent as any).llmClient as { adapter?: { constructor?: { name?: string } } } | null)?.adapter?.constructor?.name),
      'OpenAICompatibleAdapter'
    );
    assert.equal(result.content, 'openai provider path ok');
    assert.equal(result.finishReason, 'end_turn');
    assert.deepEqual(result.usage, {
      promptTokens: 8,
      completionTokens: 4,
      totalTokens: 12,
    });
    assert.equal(Array.isArray(capturedMessages), true);
    assert.equal(capturedMessages?.some((message) => message.role === 'user'), true);
    assert.equal(Array.isArray(capturedTools), true);
    assert.match(String(capturedSystemPrompt ?? ''), /\[MANDATORY_EXECUTION_RULES\]/);
    assert.equal(capturedOptions?.snapshotStage, 'initial');
  } finally {
    OpenAICompatibleAdapter.prototype.generateStream = originalGenerateStream;
    if (agent) {
      await agent.cleanup();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runOpenAiProviderReplayCase(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-openai-provider-replay-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDataDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDataDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });

  const originalGenerateStream = OpenAICompatibleAdapter.prototype.generateStream;
  const capturedCalls: Message[][] = [];
  let agent: MiniMaxAgent | null = null;

  try {
    OpenAICompatibleAdapter.prototype.generateStream = async function* (
      messages: Message[],
      _tools?: ToolSchema[],
      _systemPrompt?: string,
      _options?: LLMRequestOptions
    ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
      capturedCalls.push(messages.map((message) => ({ ...message })));
      const response: LLMResponse = {
        content: 'openai replay ok',
        finishReason: 'end_turn',
      };
      yield { type: 'text', data: response.content };
      yield { type: 'complete', data: response };
      return response;
    };

    agent = new MiniMaxAgent({
      config: {
        api: {
          apiKey: 'test-api-key-0123456789012345',
          apiBase: 'https://openai-compatible.local/v1',
          model: 'gpt-4o-mini',
          provider: 'openai',
          maxOutputTokens: 4096,
        },
        agent: {
          workspaceDir,
        },
        tools: {
          enableFileTools: false,
          enableWeb: false,
          enableShell: false,
        },
        mcp: {
          enabled: false,
          servers: [],
        },
      },
      workspaceDir,
      runtimeDataDir,
      contextDir,
    });

    const context: ContextRef = {
      scope: 'session',
      namespace: 'provider-openai-replay',
    };

    appendPersistedToolOnlyAssistantTurn(agent, context);

    await agent.runWithResult({
      prompt: 'What tool did you just use?',
      context,
      workspaceDir,
    });

    const replayMessages = capturedCalls[0] ?? [];
    const assistantWithThinkingAndTool = replayMessages.find(
      (message) =>
        message.role === 'assistant' &&
        message.thinking === 'Need to inspect package.json before answering.' &&
        message.toolCalls?.some(
          (toolCall) => toolCall.id === 'call-openai-replay' && toolCall.function.name === 'read_file'
        )
    );
    const toolMessage = replayMessages.find(
      (message) =>
        message.role === 'tool' &&
        message.toolCallId === 'call-openai-replay' &&
        String(message.content).includes('minimax-agent')
    );

    assert.ok(assistantWithThinkingAndTool);
    assert.ok(toolMessage);
  } finally {
    OpenAICompatibleAdapter.prototype.generateStream = originalGenerateStream;
    if (agent) {
      await agent.cleanup();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runOpenAiProviderTurnCase()
  .then(runOpenAiProviderReplayCase)
  .then(() => {
    console.log('minimax-openai-provider-run tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
