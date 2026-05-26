import * as assert from 'node:assert/strict';
import { LLMClient } from '../../src/llm/index.js';
import type { LLMResponse, Message, ResolvedLlmRuntimeConfig } from '../../src/types.js';

type FakeStreamEvent = Record<string, unknown>;

function createFakeStream(events: FakeStreamEvent[], finalMessage: Record<string, unknown>) {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<FakeStreamEvent> {
      for (const event of events) {
        yield event;
      }
    },
    async finalMessage(): Promise<Record<string, unknown>> {
      return finalMessage;
    },
  };
}

function createClient(
  requests: Array<Record<string, unknown>>,
  events: FakeStreamEvent[],
  finalMessage: Record<string, unknown>,
  llmRuntime?: ResolvedLlmRuntimeConfig
): LLMClient {
  const client = new LLMClient({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7',
    maxTokens: 4096,
    provider: 'anthropic',
    llmRuntime,
  });

  (client as any).adapter.client = {
    messages: {
      stream(requestParams: Record<string, unknown>) {
        requests.push(requestParams);
        return createFakeStream(events, finalMessage);
      },
    },
  };

  return client;
}

async function testCapturesThinkingSignatureFromStreamDelta(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = createClient(
    requests,
    [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 12,
          },
        },
      },
      {
        type: 'content_block_delta',
        delta: {
          type: 'thinking_delta',
          thinking: 'plan step',
        },
      },
      {
        type: 'content_block_delta',
        delta: {
          type: 'signature_delta',
          signature: 'sig-123',
        },
      },
      {
        type: 'content_block_delta',
        delta: {
          type: 'text_delta',
          text: 'done',
        },
      },
      {
        type: 'message_delta',
        usage: {
          output_tokens: 8,
        },
      },
    ],
    {
      content: [
        {
          type: 'thinking',
          thinking: 'plan step',
        },
        {
          type: 'text',
          text: 'done',
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 8,
      },
      stop_reason: 'end_turn',
    }
  );

  const streamedThinking: string[] = [];
  const response = await client.generateWithCallbacks([{ role: 'user', content: 'hello' }], {
    onThinking: (thinking) => streamedThinking.push(thinking),
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(streamedThinking, ['plan step']);
  assert.equal(response.content, 'done');
  assert.equal(response.thinking, 'plan step');
  assert.equal(response.thinkingSignature, 'sig-123');
}

async function testReplaysThinkingWithSignature(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = createClient(
    requests,
    [],
    {
      content: [
        {
          type: 'text',
          text: 'ok',
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 3,
      },
      stop_reason: 'end_turn',
    }
  );

  const messages: Message[] = [
    { role: 'user', content: 'question' },
    {
      role: 'assistant',
      content: 'tool request',
      thinking: 'inspect files first',
      thinkingSignature: 'sig-456',
    },
  ];

  await client.generateWithCallbacks(messages, {});

  const requestMessages = requests[0]?.messages as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(requestMessages), true);
  const assistantContent = requestMessages[1]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(assistantContent[0], {
    type: 'thinking',
    thinking: 'inspect files first',
    signature: 'sig-456',
  });
  assert.deepEqual(assistantContent[1], {
    type: 'text',
    text: 'tool request',
  });
}

async function testDropsUnsignedThinkingFromReplayPayload(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = createClient(
    requests,
    [],
    {
      content: [
        {
          type: 'text',
          text: 'ok',
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 3,
      },
      stop_reason: 'end_turn',
    }
  );

  const messages: Message[] = [
    { role: 'user', content: 'question' },
    {
      role: 'assistant',
      content: 'tool request',
      thinking: 'inspect files first',
    },
  ];

  await client.generateWithCallbacks(messages, {});

  const requestMessages = requests[0]?.messages as Array<Record<string, unknown>>;
  assert.equal(requestMessages[1]?.role, 'user');
  assert.equal(
    String(requestMessages[1]?.content ?? '').includes('replay_action=dropped_non_replayable_thinking_message'),
    true
  );
  assert.equal(String(requestMessages[1]?.content ?? '').includes('tool request'), true);
}

async function testDropsSignatureOnlyThinkingFromReplayPayload(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = createClient(
    requests,
    [],
    {
      content: [
        {
          type: 'text',
          text: 'ok',
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 3,
      },
      stop_reason: 'end_turn',
    }
  );

  const messages: Message[] = [
    { role: 'user', content: 'question' },
    {
      role: 'assistant',
      content: 'final answer with signature only',
      thinkingSignature: 'sig-without-thinking',
    },
  ];

  await client.generateWithCallbacks(messages, {});

  const requestMessages = requests[0]?.messages as Array<Record<string, unknown>>;
  assert.equal(requestMessages[1]?.role, 'user');
  assert.equal(
    String(requestMessages[1]?.content ?? '').includes('replay_action=dropped_non_replayable_thinking_message'),
    true
  );
  assert.equal(String(requestMessages[1]?.content ?? '').includes('final answer with signature only'), true);
}

async function testEmitsToolUseOnToolStartBeforeComplete(): Promise<void> {
  const client = new LLMClient({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7',
    maxTokens: 4096,
    provider: 'anthropic',
  });

  const finalResponse: LLMResponse = {
    content: '',
    finishReason: 'tool_use',
    toolCalls: [
      {
        id: 'tool-1',
        type: 'function',
        function: {
          name: 'shell_execute',
          arguments: {
            command: 'Get-ChildItem',
            timeoutMs: 1000,
          },
        },
      },
    ],
  };

  (client as any).adapter.generateStream = async function* (): AsyncGenerator<any, LLMResponse, unknown> {
    yield {
      type: 'tool_start',
      data: {
        id: 'tool-1',
        name: 'shell_execute',
      },
    };
    yield {
      type: 'tool_input',
      data: { id: 'tool-1', chunk: '{"command":"Get-ChildItem","timeoutMs":1000}' },
    };
    yield {
      type: 'complete',
      data: finalResponse,
    };
    return finalResponse;
  };

  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const callbackOrder: string[] = [];
  const response = await client.generateWithCallbacks(
    [{ role: 'user', content: 'list files' }],
    {
      onToolUse: (id, name, input) => {
        toolUses.push({ id, name, input });
        callbackOrder.push('tool_use');
      },
      onComplete: () => {
        callbackOrder.push('complete');
      },
    }
  );

  assert.equal(response.finishReason, 'tool_use');
  assert.deepEqual(toolUses, [
    {
      id: 'tool-1',
      name: 'shell_execute',
      input: {},
    },
    {
      id: 'tool-1',
      name: 'shell_execute',
      input: {
        command: 'Get-ChildItem',
        timeoutMs: 1000,
      },
    },
  ]);
  assert.deepEqual(callbackOrder, ['tool_use', 'tool_use', 'complete']);
}

async function testMapsReasoningPresetToThinkingBudget(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = createClient(
    requests,
    [],
    {
      content: [
        {
          type: 'text',
          text: 'ok',
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 3,
      },
      stop_reason: 'end_turn',
    },
    {
      profileId: 'anthropic-default',
      provider: 'anthropic',
      apiKey: 'test-api-key',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7',
      maxOutputTokens: 4096,
      reasoningPreset: 'medium',
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: true,
      },
      providerOptions: {
        anthropic: {
          thinkingBudgetTokens: 6144,
        },
      },
    }
  );

  await client.generateWithCallbacks([{ role: 'user', content: 'question' }], {});
  assert.deepEqual(requests[0]?.thinking, {
    type: 'enabled',
    budget_tokens: 6144,
  });
}

async function testMapsMaxReasoningPresetToHighestThinkingBudget(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = createClient(
    requests,
    [],
    {
      content: [
        {
          type: 'text',
          text: 'ok',
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 3,
      },
      stop_reason: 'end_turn',
    },
    {
      profileId: 'anthropic-default',
      provider: 'anthropic',
      apiKey: 'test-api-key',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7',
      maxOutputTokens: 4096,
      reasoningPreset: 'max',
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: true,
      },
    }
  );

  await client.generateWithCallbacks([{ role: 'user', content: 'question' }], {});
  assert.deepEqual(requests[0]?.thinking, {
    type: 'enabled',
    budget_tokens: 32768,
  });
}

async function testMapsOfficialClaudeMaxPresetToOutputConfigEffort(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = createClient(
    requests,
    [],
    {
      content: [
        {
          type: 'text',
          text: 'ok',
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 3,
      },
      stop_reason: 'end_turn',
    },
    {
      profileId: 'anthropic-default',
      provider: 'anthropic',
      apiKey: 'test-api-key',
      apiBase: 'https://api.anthropic.com',
      model: 'claude-opus-4-7',
      maxOutputTokens: 4096,
      reasoningPreset: 'max',
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: true,
      },
    }
  );

  await client.generateWithCallbacks([{ role: 'user', content: 'question' }], {});
  assert.deepEqual(requests[0]?.output_config, {
    effort: 'max',
  });
  assert.equal('thinking' in (requests[0] ?? {}), false);
}

async function testOmitsThinkingBudgetWhenCapabilityIsDisabled(): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const client = createClient(
    requests,
    [],
    {
      content: [
        {
          type: 'text',
          text: 'ok',
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 3,
      },
      stop_reason: 'end_turn',
    },
    {
      profileId: 'anthropic-default',
      provider: 'anthropic',
      apiKey: 'test-api-key',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7',
      maxOutputTokens: 4096,
      reasoningPreset: 'high',
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: false,
      },
    }
  );

  await client.generateWithCallbacks([{ role: 'user', content: 'question' }], {});
  assert.equal('thinking' in (requests[0] ?? {}), false);
}

async function runAll(): Promise<void> {
  await testCapturesThinkingSignatureFromStreamDelta();
  await testReplaysThinkingWithSignature();
  await testDropsUnsignedThinkingFromReplayPayload();
  await testDropsSignatureOnlyThinkingFromReplayPayload();
  await testEmitsToolUseOnToolStartBeforeComplete();
  await testMapsReasoningPresetToThinkingBudget();
  await testMapsMaxReasoningPresetToHighestThinkingBudget();
  await testMapsOfficialClaudeMaxPresetToOutputConfigEffort();
  await testOmitsThinkingBudgetWhenCapabilityIsDisabled();
  console.log('llm-thinking-signature tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
