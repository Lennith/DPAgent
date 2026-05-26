import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DPAgent } from '../../src/index.js';
import type { LLMRequestOptions, LLMStreamEvent } from '../../src/llm/index.js';
import { OpenAICompatibleAdapter } from '../../src/llm/providers/OpenAICompatibleAdapter.js';
import type { PreparedProviderPayload } from '../../src/llm/runtime-types.js';
import type { ContextRef, LLMResponse, Message, ToolSchema } from '../../src/types.js';

function appendPersistedToolOnlyAssistantTurn(agent: DPAgent, context: ContextRef): void {
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
        content: '{"name":"dpagent"}',
      },
      { role: 'assistant', content: 'The package name is dpagent.' },
    ],
    finalOutputText: 'The package name is dpagent.',
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
  let capturedPayload: PreparedProviderPayload | null = null;
  let capturedTools: ToolSchema[] | undefined;
  let capturedOptions: LLMRequestOptions | undefined;
  let agent: DPAgent | null = null;

  try {
    OpenAICompatibleAdapter.prototype.generateStream = async function* (
      payload: PreparedProviderPayload,
      tools?: ToolSchema[],
      options?: LLMRequestOptions
    ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
      capturedPayload = payload;
      capturedTools = tools;
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

    agent = new DPAgent({
      config: {
        api: {
          apiKey: 'test-api-key-0123456789012345',
          apiBase: 'https://openai-compatible.local/v1',
          model: 'gpt-4o-mini',
          provider: 'openai',
          maxOutputTokens: 4096,
        },
        llmProfiles: {
          defaultProfileId: 'openai-default',
          profiles: [
            {
              id: 'openai-default',
              name: 'OpenAI Default',
              provider: 'openai',
              apiKey: 'test-api-key-0123456789012345',
              apiBase: 'https://openai-compatible.local/v1',
              defaultModel: 'gpt-4o-mini',
              maxOutputTokens: 4096,
            },
          ],
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
    assert.equal(Array.isArray(capturedPayload?.messages), true);
    assert.equal(capturedPayload?.messages.some((message) => message.role === 'user'), true);
    assert.equal(Array.isArray(capturedTools), true);
    assert.match(String(capturedPayload?.systemPrompt ?? ''), /\[MANDATORY_EXECUTION_RULES\]/);
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
  let agent: DPAgent | null = null;

  try {
    OpenAICompatibleAdapter.prototype.generateStream = async function* (
      payload: PreparedProviderPayload,
      _tools?: ToolSchema[],
      _options?: LLMRequestOptions
    ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
      capturedCalls.push(payload.messages.map((message) => ({ ...message })));
      const response: LLMResponse = {
        content: 'openai replay ok',
        finishReason: 'end_turn',
      };
      yield { type: 'text', data: response.content };
      yield { type: 'complete', data: response };
      return response;
    };

    agent = new DPAgent({
      config: {
        api: {
          apiKey: 'test-api-key-0123456789012345',
          apiBase: 'https://openai-compatible.local/v1',
          model: 'gpt-4o-mini',
          provider: 'openai',
          maxOutputTokens: 4096,
        },
        llmProfiles: {
          defaultProfileId: 'openai-default',
          profiles: [
            {
              id: 'openai-default',
              name: 'OpenAI Default',
              provider: 'openai',
              apiKey: 'test-api-key-0123456789012345',
              apiBase: 'https://openai-compatible.local/v1',
              defaultModel: 'gpt-4o-mini',
              maxOutputTokens: 4096,
            },
          ],
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
        String(message.content).includes('dpagent')
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

async function runSystemPromptLayeringCase(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-openai-system-layers-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDataDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  const agentDir = path.join(tempDir, 'agents', 'Coder');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDataDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Repo Rules\nRun the repo tests.', 'utf-8');
  fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), '# Coder Role\nSpeak as the coding specialist.', 'utf-8');

  const originalGenerateStream = OpenAICompatibleAdapter.prototype.generateStream;
  let capturedPayload: PreparedProviderPayload | null = null;
  let agent: DPAgent | null = null;

  try {
    OpenAICompatibleAdapter.prototype.generateStream = async function* (
      payload: PreparedProviderPayload
    ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
      capturedPayload = payload;
      const response: LLMResponse = {
        content: 'layering ok',
        finishReason: 'end_turn',
      };
      yield { type: 'text', data: response.content };
      yield { type: 'complete', data: response };
      return response;
    };

    agent = new DPAgent({
      config: {
        api: {
          apiKey: 'test-api-key-0123456789012345',
          apiBase: 'https://openai-compatible.local/v1',
          model: 'gpt-4o-mini',
          provider: 'openai',
          maxOutputTokens: 4096,
        },
        llmProfiles: {
          defaultProfileId: 'openai-default',
          profiles: [
            {
              id: 'openai-default',
              name: 'OpenAI Default',
              provider: 'openai',
              apiKey: 'test-api-key-0123456789012345',
              apiBase: 'https://openai-compatible.local/v1',
              defaultModel: 'gpt-4o-mini',
              maxOutputTokens: 4096,
            },
          ],
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

    await agent.runWithResult({
      prompt: 'Fix the bug.',
      context: {
        scope: 'session',
        namespace: 'system-layering',
      },
      workspaceDir,
      agentRuntimeOverrides: {
        agentProfile: {
          source: 'global',
          name: 'Coder',
          path: path.join(agentDir, 'AGENTS.md'),
        },
      },
    });

    const systemPrompt = String(capturedPayload?.systemPrompt ?? '');
    assert.doesNotMatch(systemPrompt, /^You are a helpful AI assistant\./);
    assert.match(systemPrompt, /^You are running inside the DPAgent runtime\./);
    assert.match(systemPrompt, /## Active Agent Role/);
    assert.match(systemPrompt, /Speak as the coding specialist\./);
    assert.match(systemPrompt, /## Workspace Instructions/);
    assert.match(systemPrompt, /Run the repo tests\./);
    assert.equal(capturedPayload?.messages.some((message) => message.role === 'system'), false);
    assert.equal(
      capturedPayload?.messages.some((message) => message.role === 'user' && String(message.content).includes('[AGENT_PROFILE_BODY_BEGIN]')),
      false
    );
  } finally {
    OpenAICompatibleAdapter.prototype.generateStream = originalGenerateStream;
    if (agent) {
      await agent.cleanup();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function activeAgentSection(systemPrompt: string): string {
  const start = systemPrompt.indexOf('## Active Agent Role');
  if (start < 0) {
    return '';
  }
  const next = systemPrompt.indexOf('## Workspace Instructions', start);
  return next > start ? systemPrompt.slice(start, next) : systemPrompt.slice(start);
}

async function runLongMultiAgentSwitchingCase(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-openai-long-agent-switch-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDataDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  const coderDir = path.join(tempDir, 'agents', 'Coder');
  const reviewerDir = path.join(tempDir, 'agents', 'Reviewer');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDataDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(coderDir, { recursive: true });
  fs.mkdirSync(reviewerDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Repo Rules\nKeep repository-specific rules active.', 'utf-8');
  fs.writeFileSync(path.join(coderDir, 'AGENTS.md'), '# Coder Role\nCoder-only instruction.', 'utf-8');
  fs.writeFileSync(path.join(reviewerDir, 'AGENTS.md'), '# Reviewer Role\nReviewer-only instruction.', 'utf-8');

  const originalGenerateStream = OpenAICompatibleAdapter.prototype.generateStream;
  const capturedPayloads: PreparedProviderPayload[] = [];
  let agent: DPAgent | null = null;

  try {
    OpenAICompatibleAdapter.prototype.generateStream = async function* (
      payload: PreparedProviderPayload
    ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
      capturedPayloads.push({
        ...payload,
        messages: payload.messages.map((message) => ({ ...message })),
      });
      const response: LLMResponse = {
        content: `turn ${capturedPayloads.length} ok`,
        finishReason: 'end_turn',
      };
      yield { type: 'text', data: response.content };
      yield { type: 'complete', data: response };
      return response;
    };

    agent = new DPAgent({
      config: {
        api: {
          apiKey: 'test-api-key-0123456789012345',
          apiBase: 'https://openai-compatible.local/v1',
          model: 'gpt-4o-mini',
          provider: 'openai',
          maxOutputTokens: 4096,
        },
        llmProfiles: {
          defaultProfileId: 'openai-default',
          profiles: [
            {
              id: 'openai-default',
              name: 'OpenAI Default',
              provider: 'openai',
              apiKey: 'test-api-key-0123456789012345',
              apiBase: 'https://openai-compatible.local/v1',
              defaultModel: 'gpt-4o-mini',
              maxOutputTokens: 4096,
            },
          ],
        },
        agent: {
          workspaceDir,
          contextReplayMinRounds: 8,
          contextReplayMaxRounds: 8,
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
      namespace: 'long-agent-switching',
    };
    const coderProfile = {
      source: 'global' as const,
      name: 'Coder',
      path: path.join(coderDir, 'AGENTS.md'),
    };
    const reviewerProfile = {
      source: 'global' as const,
      name: 'Reviewer',
      path: path.join(reviewerDir, 'AGENTS.md'),
    };

    await agent.runWithResult({ prompt: 'Default turn 1.', context, workspaceDir });
    await agent.runWithResult({ prompt: 'Coder turn 2.', context, workspaceDir, agentRuntimeOverrides: { agentProfile: coderProfile } });
    await agent.runWithResult({ prompt: 'Coder turn 3.', context, workspaceDir, agentRuntimeOverrides: { agentProfile: coderProfile } });
    await agent.runWithResult({ prompt: 'Reviewer turn 4.', context, workspaceDir, agentRuntimeOverrides: { agentProfile: reviewerProfile } });
    await agent.runWithResult({ prompt: 'Default turn 5.', context, workspaceDir });
    await agent.runWithResult({ prompt: 'Default turn 6.', context, workspaceDir });
    await agent.runWithResult({ prompt: 'Coder turn 7.', context, workspaceDir, agentRuntimeOverrides: { agentProfile: coderProfile } });
    await agent.runWithResult({ prompt: 'Reviewer turn 8.', context, workspaceDir, agentRuntimeOverrides: { agentProfile: reviewerProfile } });

    assert.equal(capturedPayloads.length, 8);
    const prompts = capturedPayloads.map((payload) => String(payload.systemPrompt ?? ''));
    assert.match(prompts[0], /^You are a helpful AI assistant\./);
    assert.doesNotMatch(prompts[0], /## Active Agent Role/);
    assert.match(prompts[0], /## Workspace Instructions/);

    assert.match(prompts[1], /^You are running inside the DPAgent runtime\./);
    assert.match(activeAgentSection(prompts[1]), /Coder-only instruction\./);
    assert.doesNotMatch(activeAgentSection(prompts[1]), /Reviewer-only instruction\./);
    assert.match(activeAgentSection(prompts[2]), /Coder-only instruction\./);

    assert.match(activeAgentSection(prompts[3]), /Reviewer-only instruction\./);
    assert.doesNotMatch(activeAgentSection(prompts[3]), /Coder-only instruction\./);

    assert.match(prompts[4], /^You are a helpful AI assistant\./);
    assert.doesNotMatch(prompts[4], /## Active Agent Role/);
    assert.match(prompts[5], /^You are a helpful AI assistant\./);
    assert.doesNotMatch(prompts[5], /## Active Agent Role/);

    assert.match(activeAgentSection(prompts[6]), /Coder-only instruction\./);
    assert.match(activeAgentSection(prompts[7]), /Reviewer-only instruction\./);

    for (const payload of capturedPayloads) {
      assert.equal(payload.messages.some((message) => message.role === 'system'), false);
      assert.equal(
        payload.messages.some((message) => String(message.content).includes('[AGENT_PROFILE_BODY_BEGIN]')),
        false
      );
    }
  } finally {
    OpenAICompatibleAdapter.prototype.generateStream = originalGenerateStream;
    if (agent) {
      await agent.cleanup();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runOpenAiProviderTurnCase()
  .then(runSystemPromptLayeringCase)
  .then(runLongMultiAgentSwitchingCase)
  .then(runOpenAiProviderReplayCase)
  .then(() => {
    console.log('minimax-openai-provider-run tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
