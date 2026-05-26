import * as assert from 'node:assert/strict';
import { LLMClient, prepareMessagesForModel } from '../../src/llm/index.js';
import { buildToolProtocolFrames } from '../../src/llm/tool-protocol.js';
import { AnthropicAdapter } from '../../src/llm/providers/AnthropicAdapter.js';
import { OpenAICompatibleAdapter } from '../../src/llm/providers/OpenAICompatibleAdapter.js';
import type { Message } from '../../src/types.js';
import type { PreparedProviderPayload } from '../../src/llm/runtime-types.js';

function buildMultiToolReplayMessages(): Message[] {
  return [
    { role: 'user', content: 'inspect project status' },
    {
      role: 'assistant',
      content: 'Calling read_file for multiple paths',
      toolCalls: [
        { id: 'call_01', type: 'function', function: { name: 'read_file', arguments: { path: 'a.md' } } },
        { id: 'call_02', type: 'function', function: { name: 'read_file', arguments: { path: 'b.md' } } },
        { id: 'call_03', type: 'function', function: { name: 'read_file', arguments: { path: 'c.md' } } },
        { id: 'call_04', type: 'function', function: { name: 'read_file', arguments: { path: 'd.md' } } },
      ],
    },
    { role: 'tool', toolCallId: 'call_01', name: 'read_file', content: 'A content' },
    { role: 'tool', toolCallId: 'call_02', name: 'read_file', content: 'B content' },
    { role: 'tool', toolCallId: 'call_03', name: 'read_file', content: 'C content' },
    { role: 'tool', toolCallId: 'call_04', name: 'read_file', content: 'D content' },
    { role: 'assistant', content: 'All files inspected.' },
  ];
}

function createAnthropicFakeStream(finalMessage: Record<string, unknown>) {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
      return;
    },
    async finalMessage(): Promise<Record<string, unknown>> {
      return finalMessage;
    },
  };
}

function findAnthropicAssistantToolUseIndex(messages: Array<Record<string, unknown>>): number {
  return messages.findIndex((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((block) => block?.type === 'tool_use');
  });
}

function findAssistantContentBlocks(
  messages: Array<Record<string, unknown>>,
  text: string
): Array<Record<string, unknown>> {
  const assistant = messages.find((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((block) => block?.type === 'text' && String(block?.text ?? '').includes(text));
  });
  return Array.isArray(assistant?.content) ? (assistant.content as Array<Record<string, unknown>>) : [];
}

function buildPreparedPayload(messages: Message[], systemPrompt?: string): PreparedProviderPayload {
  const preparation = prepareMessagesForModel(messages);
  return {
    messages: preparation.postTrimSanitized.messages,
    systemPrompt,
    preparation,
  };
}

function buildUnsafePreparedPayload(messages: Message[], systemPrompt?: string): PreparedProviderPayload {
  const preparation = prepareMessagesForModel([]);
  return {
    messages,
    systemPrompt,
    preparation,
  };
}

async function testBuildToolProtocolFramesBundlesAlignedResults(): Promise<void> {
  const replayMessages = buildMultiToolReplayMessages();
  const protocol = buildToolProtocolFrames(replayMessages);

  assert.equal(protocol.assistantToolBundleCount, 1);
  assert.equal(protocol.toolResultMessageCount, 4);
  assert.equal(protocol.maxToolResultsPerBundle, 4);
  assert.equal(protocol.frames.length, 3);
  assert.equal(protocol.frames[1]?.kind, 'assistant_tool_bundle');
  if (protocol.frames[1]?.kind !== 'assistant_tool_bundle') {
    throw new Error('expected assistant_tool_bundle frame');
  }
  assert.deepEqual(
    protocol.frames[1].toolResults.map((message) => message.toolCallId),
    ['call_01', 'call_02', 'call_03', 'call_04']
  );
}

async function testBuildToolProtocolFramesLeavesMismatchedChainUnbundled(): Promise<void> {
  const replayMessages: Message[] = [
    { role: 'user', content: 'inspect project status' },
    {
      role: 'assistant',
      content: 'Calling read_file for multiple paths',
      toolCalls: [
        { id: 'call_01', type: 'function', function: { name: 'read_file', arguments: { path: 'a.md' } } },
        { id: 'call_01', type: 'function', function: { name: 'read_file', arguments: { path: 'b.md' } } },
      ],
    },
    { role: 'tool', toolCallId: 'call_01', name: 'read_file', content: 'A content' },
  ];
  const protocol = buildToolProtocolFrames(replayMessages);

  assert.equal(protocol.assistantToolBundleCount, 0);
  assert.equal(protocol.toolResultMessageCount, 0);
  assert.equal(protocol.maxToolResultsPerBundle, 0);
  assert.deepEqual(
    protocol.frames.map((frame) => frame.kind),
    ['message', 'message', 'message']
  );
}

async function testAnthropicAdapterBatchesToolResultsInImmediateNextMessage(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = new LLMClient({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7',
    maxTokens: 4096,
    provider: 'anthropic',
  });

  (client as any).adapter.client = {
    messages: {
      stream(requestParams: Record<string, unknown>) {
        requests.push(requestParams);
        return createAnthropicFakeStream({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 3, output_tokens: 2 },
          stop_reason: 'end_turn',
        });
      },
    },
  };

  await client.generateWithCallbacks(buildMultiToolReplayMessages(), {});

  const outbound = requests[0]?.messages as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(outbound));
  const assistantIndex = findAnthropicAssistantToolUseIndex(outbound);
  assert.ok(assistantIndex >= 0);
  const next = outbound[assistantIndex + 1] as Record<string, unknown>;
  assert.equal(next.role, 'user');
  assert.equal(Array.isArray(next.content), true);
  const nextBlocks = next.content as Array<Record<string, unknown>>;
  const toolResults = nextBlocks.filter((block) => block.type === 'tool_result');
  assert.equal(toolResults.length, 4);
  assert.deepEqual(
    toolResults.map((block) => block.tool_use_id),
    ['call_01', 'call_02', 'call_03', 'call_04']
  );

  const batchedUserMessages = outbound.filter((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((block) => block?.type === 'tool_result');
  });
  assert.equal(batchedUserMessages.length, 1);
}

async function testAnthropicAdapterRejectsMalformedPreparedToolUseReplay(): Promise<void> {
  const adapter = new AnthropicAdapter({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7',
    maxTokens: 4096,
    provider: 'anthropic',
  });

  await assert.rejects(
    () =>
      adapter.generate(
        buildUnsafePreparedPayload([
          { role: 'user', content: 'inspect project status' },
          {
            role: 'assistant',
            content: 'Calling read_file for multiple paths',
            toolCalls: [
              { id: 'call_01', type: 'function', function: { name: 'read_file', arguments: { path: 'a.md' } } },
              { id: 'call_02', type: 'function', function: { name: 'read_file', arguments: { path: 'b.md' } } },
            ],
          },
          { role: 'assistant', content: 'I will continue after tools.' },
        ])
      ),
    /unbundled assistant tool calls/
  );
}

async function testAnthropicAdapterRejectsOrphanPreparedToolResultReplay(): Promise<void> {
  const adapter = new AnthropicAdapter({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7',
    maxTokens: 4096,
    provider: 'anthropic',
  });

  await assert.rejects(
    () =>
      adapter.generate(
        buildUnsafePreparedPayload([
          { role: 'user', content: 'inspect project status' },
          { role: 'tool', name: 'read_file', content: 'A content without tool_call_id' },
        ])
      ),
    /unbundled tool_result messages/
  );
}

async function testAnthropicAdapterDropsMalformedUnbundledToolUseReplay(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = new LLMClient({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7',
    maxTokens: 4096,
    provider: 'anthropic',
  });

  (client as any).adapter.client = {
    messages: {
      stream(requestParams: Record<string, unknown>) {
        requests.push(requestParams);
        return createAnthropicFakeStream({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 3, output_tokens: 2 },
          stop_reason: 'end_turn',
        });
      },
    },
  };

  await client.generateWithCallbacks(
    [
      { role: 'user', content: 'inspect project status' },
      {
        role: 'assistant',
        content: 'Calling read_file for multiple paths',
        toolCalls: [
          { id: 'call_01', type: 'function', function: { name: 'read_file', arguments: { path: 'a.md' } } },
          { id: 'call_02', type: 'function', function: { name: 'read_file', arguments: { path: 'b.md' } } },
        ],
      },
      { role: 'assistant', content: 'I will continue after tools.' },
    ],
    {}
  );

  const outbound = requests[0]?.messages as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(outbound));
  const droppedAssistant = outbound.find((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((block) => block?.type === 'text' && String(block?.text ?? '').includes('Calling read_file'));
  });
  assert.ok(droppedAssistant);
  assert.equal(
    Array.isArray(droppedAssistant?.content) &&
      (droppedAssistant?.content as Array<Record<string, unknown>>).some((block) => block.type === 'tool_use'),
    false
  );
  assert.equal(
    outbound.some(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        String(message.content).includes('replay_action=dropped_invalid_tool_protocol')
    ),
    true
  );
}

async function testAnthropicAdapterDropsCrossRuntimeThinkingReplay(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = new LLMClient({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'deepseek-v4-flash',
    maxTokens: 4096,
    provider: 'anthropic',
    llmRuntime: {
      profileId: 'deepseek',
      provider: 'anthropic',
      apiKey: 'test-api-key',
      apiBase: 'https://api.minimaxi.com',
      model: 'deepseek-v4-flash',
      maxOutputTokens: 4096,
      reasoningPreset: 'high',
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: true,
      },
    },
  });

  (client as any).adapter.client = {
    messages: {
      stream(requestParams: Record<string, unknown>) {
        requests.push(requestParams);
        return createAnthropicFakeStream({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 3, output_tokens: 2 },
          stop_reason: 'end_turn',
        });
      },
    },
  };

  await client.generateWithCallbacks(
    [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: 'kimi text',
        thinking: 'kimi thinking',
        thinkingSignature: 'kimi-signature',
        metadata: {
          llmProviderProfileId: 'kimi',
          llmProvider: 'anthropic',
          llmModel: 'kimi-for-coding',
          thinkingComplete: true,
        },
      },
      {
        role: 'assistant',
        content: 'deepseek text',
        thinking: 'deepseek thinking',
        thinkingSignature: 'deepseek-signature',
        metadata: {
          llmProviderProfileId: 'deepseek',
          llmProvider: 'anthropic',
          llmModel: 'deepseek-v4-flash',
          thinkingComplete: true,
        },
      },
    ],
    {}
  );

  const outbound = requests[0]?.messages as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(outbound));
  const kimiBlocks = findAssistantContentBlocks(outbound, 'kimi text');
  const deepseekBlocks = findAssistantContentBlocks(outbound, 'deepseek text');
  assert.equal(kimiBlocks.some((block) => block.type === 'thinking'), false);
  assert.equal(deepseekBlocks.some((block) => block.type === 'thinking'), true);
}

async function testAnthropicAdapterDropsNonReplayableThinkingToolBundle(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = new LLMClient({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'deepseek-v4-flash',
    maxTokens: 4096,
    provider: 'anthropic',
    llmRuntime: {
      profileId: 'deepseek',
      provider: 'anthropic',
      apiKey: 'test-api-key',
      apiBase: 'https://api.minimaxi.com',
      model: 'deepseek-v4-flash',
      maxOutputTokens: 4096,
      reasoningPreset: 'high',
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: true,
      },
    },
  });

  (client as any).adapter.client = {
    messages: {
      stream(requestParams: Record<string, unknown>) {
        requests.push(requestParams);
        return createAnthropicFakeStream({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 3, output_tokens: 2 },
          stop_reason: 'end_turn',
        });
      },
    },
  };

  await client.generateWithCallbacks(
    [
      { role: 'user', content: 'use a tool' },
      {
        role: 'assistant',
        content: '',
        thinking: 'partial thinking without reusable signature',
        toolCalls: [
          {
            id: 'call_01',
            type: 'function',
            function: { name: 'grep', arguments: { pattern: 'init_superuser', path: 'app' } },
          },
        ],
      },
      { role: 'tool', toolCallId: 'call_01', name: 'grep', content: 'crud.py:302:def init_superuser(db):' },
    ],
    {}
  );

  const outbound = requests[0]?.messages as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(outbound));
  const encoded = JSON.stringify(outbound);
  assert.equal(encoded.includes('"type":"tool_use"'), false);
  assert.equal(encoded.includes('"type":"thinking"'), false);
  assert.equal(encoded.includes('replay_action=dropped_non_replayable_thinking_tool_protocol'), true);
  assert.equal(encoded.includes('init_superuser'), true);
}

async function testAnthropicAdapterConvertsNonReplayableThinkingMessageToUserNotice(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = new LLMClient({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'deepseek-v4-flash',
    maxTokens: 4096,
    provider: 'anthropic',
    llmRuntime: {
      profileId: 'deepseek',
      provider: 'anthropic',
      apiKey: 'test-api-key',
      apiBase: 'https://api.minimaxi.com',
      model: 'deepseek-v4-flash',
      maxOutputTokens: 4096,
      reasoningPreset: 'high',
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: true,
      },
    },
  });

  (client as any).adapter.client = {
    messages: {
      stream(requestParams: Record<string, unknown>) {
        requests.push(requestParams);
        return createAnthropicFakeStream({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 3, output_tokens: 2 },
          stop_reason: 'end_turn',
        });
      },
    },
  };

  await client.generateWithCallbacks(
    [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: 'assistant text after unsigned thinking',
        thinking: 'thinking returned without reusable signature',
        metadata: {
          llmProviderProfileId: 'deepseek',
          llmProvider: 'anthropic',
          llmModel: 'deepseek-v4-flash',
          thinkingComplete: false,
        },
      },
      { role: 'user', content: 'next turn' },
    ],
    {}
  );

  const outbound = requests[0]?.messages as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(outbound));
  const encoded = JSON.stringify(outbound);
  assert.equal(encoded.includes('"type":"thinking"'), false);
  assert.equal(encoded.includes('"role":"assistant"'), false);
  assert.equal(encoded.includes('replay_action=dropped_non_replayable_thinking_message'), true);
  assert.equal(encoded.includes('assistant text after unsigned thinking'), true);
}

async function testAnthropicAdapterConvertsSignatureOnlyThinkingMessageToUserNotice(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = new LLMClient({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'deepseek-v4-flash',
    maxTokens: 4096,
    provider: 'anthropic',
  });

  (client as any).adapter.client = {
    messages: {
      stream(requestParams: Record<string, unknown>) {
        requests.push(requestParams);
        return createAnthropicFakeStream({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 3, output_tokens: 2 },
          stop_reason: 'end_turn',
        });
      },
    },
  };

  await client.generateWithCallbacks(
    [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: 'assistant text after signature-only thinking stream',
        thinkingSignature: 'signature-without-thinking',
      },
      { role: 'user', content: 'next turn' },
    ],
    {}
  );

  const outbound = requests[0]?.messages as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(outbound));
  const encoded = JSON.stringify(outbound);
  assert.equal(encoded.includes('"type":"thinking"'), false);
  assert.equal(encoded.includes('"role":"assistant"'), false);
  assert.equal(encoded.includes('replay_action=dropped_non_replayable_thinking_message'), true);
  assert.equal(encoded.includes('assistant text after signature-only thinking stream'), true);
}

async function testOpenAiAdapterKeepsToolResultsAsRoleToolMessages(): Promise<void> {
  const adapter = new OpenAICompatibleAdapter({
    apiKey: 'test-api-key',
    apiBase: 'https://openai-compatible.local/v1',
    model: 'gpt-4o-mini',
    maxTokens: 4096,
    provider: 'openai',
  });

  let capturedRequest: Record<string, unknown> | undefined;
  (adapter as any).client = {
    chat: {
      completions: {
        create: async (requestParams: Record<string, unknown>) => {
          capturedRequest = requestParams;
          return {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: 'ok',
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
          };
        },
      },
    },
  };

  await adapter.generate(buildPreparedPayload(buildMultiToolReplayMessages()));

  const outbound = (capturedRequest?.messages as Array<Record<string, unknown>>) ?? [];
  const assistantIndex = outbound.findIndex((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      return false;
    }
    return message.tool_calls.length === 4;
  });
  assert.ok(assistantIndex >= 0);
  const toolWindow = outbound.slice(assistantIndex + 1, assistantIndex + 5);
  assert.equal(toolWindow.length, 4);
  assert.deepEqual(
    toolWindow.map((message) => message.role),
    ['tool', 'tool', 'tool', 'tool']
  );
  assert.deepEqual(
    toolWindow.map((message) => message.tool_call_id),
    ['call_01', 'call_02', 'call_03', 'call_04']
  );
}

async function runAll(): Promise<void> {
  await testBuildToolProtocolFramesBundlesAlignedResults();
  await testBuildToolProtocolFramesLeavesMismatchedChainUnbundled();
  await testAnthropicAdapterBatchesToolResultsInImmediateNextMessage();
  await testAnthropicAdapterRejectsMalformedPreparedToolUseReplay();
  await testAnthropicAdapterRejectsOrphanPreparedToolResultReplay();
  await testAnthropicAdapterDropsMalformedUnbundledToolUseReplay();
  await testAnthropicAdapterDropsCrossRuntimeThinkingReplay();
  await testAnthropicAdapterDropsNonReplayableThinkingToolBundle();
  await testAnthropicAdapterConvertsNonReplayableThinkingMessageToUserNotice();
  await testAnthropicAdapterConvertsSignatureOnlyThinkingMessageToUserNotice();
  await testOpenAiAdapterKeepsToolResultsAsRoleToolMessages();
  console.log('llm-anthropic-tool-protocol tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
