import * as assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '../../src/llm/providers/OpenAICompatibleAdapter.js';
import { prepareMessagesForModel } from '../../src/llm/index.js';
import type { Message, ResolvedLlmRuntimeConfig } from '../../src/types.js';
import type { PreparedProviderPayload } from '../../src/llm/runtime-types.js';

function createAdapter(llmRuntime?: ResolvedLlmRuntimeConfig): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    apiKey: 'test-api-key',
    apiBase: 'https://openai-compatible.local/v1',
    model: 'gpt-4o-mini',
    maxTokens: 4096,
    provider: 'openai',
    llmRuntime,
  });
}

function createAsyncIterable(items: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
      for (const item of items) {
        yield item;
      }
    },
  };
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

async function testGenerateNormalizesToolCalls(): Promise<void> {
  const adapter = createAdapter();
  let capturedRequest: Record<string, unknown> | undefined;

  (adapter as any).client = {
    chat: {
      completions: {
        create: async (requestParams: Record<string, unknown>) => {
          capturedRequest = requestParams;
          return {
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"README.md"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
            },
          };
        },
      },
    },
  };

  const response = await adapter.generate(
    buildPreparedPayload([{ role: 'user', content: 'inspect repo' }], 'You are a test system prompt.'),
    [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
    ]
  );

  assert.equal(Array.isArray(capturedRequest?.messages), true);
  assert.equal((capturedRequest?.messages as Array<Record<string, unknown>>)[0]?.role, 'system');
  assert.equal(response.finishReason, 'tool_use');
  assert.equal(response.toolCalls?.[0]?.function.name, 'read_file');
  assert.deepEqual(response.toolCalls?.[0]?.function.arguments, { path: 'README.md' });
  assert.deepEqual(response.usage, {
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
  });
}

async function testGenerateRejectsMalformedToolArguments(): Promise<void> {
  const adapter = createAdapter();

  (adapter as any).client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: '',
                tool_calls: [
                  {
                    id: 'call_bad_json',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":',
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
    },
  };

  await assert.rejects(
    () => adapter.generate(buildPreparedPayload([{ role: 'user', content: 'inspect repo' }])),
    /tool arguments must be a JSON object/
  );
}

async function testGenerateRejectsNonObjectToolArguments(): Promise<void> {
  const adapter = createAdapter();

  (adapter as any).client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: '',
                tool_calls: [
                  {
                    id: 'call_string_args',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '"README.md"',
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
    },
  };

  await assert.rejects(
    () => adapter.generate(buildPreparedPayload([{ role: 'user', content: 'inspect repo' }])),
    /tool arguments must be a JSON object/
  );
}

async function testGenerateStripsLeadingThinkBlocksFromContent(): Promise<void> {
  const adapter = createAdapter();

  (adapter as any).client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: '<think>\nplan first\n</think>\nfinal answer【完成！】',
              },
            },
          ],
        }),
      },
    },
  };

  const response = await adapter.generate(buildPreparedPayload([{ role: 'user', content: 'answer' }]));
  assert.equal(response.content, 'final answer【完成！】');
  assert.equal(response.thinking, 'plan first');
  assert.equal(response.finishReason, 'end_turn');
}

async function testGenerateStreamAccumulatesTextAndToolDeltas(): Promise<void> {
  const adapter = createAdapter();
  (adapter as any).client = {
    chat: {
      completions: {
        create: async () =>
          createAsyncIterable([
            {
              choices: [
                {
                  delta: { content: 'Hello ' },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: { content: 'world' },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_2',
                        function: {
                          name: 'read_file',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          arguments: '{"path":"package.json"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 6,
                total_tokens: 18,
              },
            },
          ]),
      },
    },
  };

  const events: string[] = [];
  const generator = adapter.generateStream(buildPreparedPayload([{ role: 'user', content: 'inspect repo' }]));
  let finalResponse: Awaited<ReturnType<typeof adapter.generate>> | undefined;

  while (true) {
    const next = await generator.next();
    if (next.done) {
      finalResponse = next.value;
      break;
    }
    if (next.value.type === 'text') {
      events.push(`text:${next.value.data}`);
    } else if (next.value.type === 'tool_start') {
      events.push(`tool_start:${next.value.data.index}:${next.value.data.name}`);
    } else if (next.value.type === 'tool_input') {
      events.push(`tool_input:${next.value.data.index}:${next.value.data.chunk}`);
    } else if (next.value.type === 'complete') {
      events.push(`complete:${next.value.data.finishReason}`);
    }
  }

  assert.deepEqual(events, [
    'text:Hello ',
    'text:world',
    'tool_start:0:read_file',
    'tool_input:0:{"path":"package.json"}',
    'complete:tool_use',
  ]);
  assert.equal(finalResponse?.content, 'Hello world');
  assert.equal(finalResponse?.thinkingSignature, undefined);
  assert.deepEqual(finalResponse?.toolCalls?.[0]?.function.arguments, { path: 'package.json' });
  assert.deepEqual(finalResponse?.usage, {
    promptTokens: 12,
    completionTokens: 6,
    totalTokens: 18,
  });
}

async function testGenerateStreamBuffersArgumentsUntilToolMetadata(): Promise<void> {
  const adapter = createAdapter();
  (adapter as any).client = {
    chat: {
      completions: {
        create: async () =>
          createAsyncIterable([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          arguments: '{"path":"pack',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_2',
                        function: {
                          name: 'read_file',
                          arguments: 'age.json"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ]),
      },
    },
  };

  const events: string[] = [];
  const generator = adapter.generateStream(buildPreparedPayload([{ role: 'user', content: 'inspect repo' }]));
  let finalResponse: Awaited<ReturnType<typeof adapter.generate>> | undefined;

  while (true) {
    const next = await generator.next();
    if (next.done) {
      finalResponse = next.value;
      break;
    }
    if (next.value.type === 'tool_start') {
      events.push(`tool_start:${next.value.data.index}:${next.value.data.name}`);
    } else if (next.value.type === 'tool_input') {
      events.push(`tool_input:${next.value.data.index}:${next.value.data.chunk}`);
    } else if (next.value.type === 'complete') {
      events.push(`complete:${next.value.data.finishReason}`);
    }
  }

  assert.deepEqual(events, [
    'tool_start:0:read_file',
    'tool_input:0:{"path":"package.json"}',
    'complete:tool_use',
  ]);
  assert.deepEqual(finalResponse?.toolCalls?.[0]?.function.arguments, { path: 'package.json' });
}

async function testGenerateStreamRejectsMissingToolCallIndex(): Promise<void> {
  const adapter = createAdapter();
  (adapter as any).client = {
    chat: {
      completions: {
        create: async () =>
          createAsyncIterable([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        id: 'call_2',
                        function: {
                          name: 'read_file',
                          arguments: '{"path":"package.json"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ]),
      },
    },
  };

  await assert.rejects(
    async () => {
      for await (const _event of adapter.generateStream(buildPreparedPayload([{ role: 'user', content: 'inspect repo' }]))) {
        // Exhaust the stream to surface protocol errors.
      }
    },
    /missing numeric index/
  );
}

async function testGenerateStreamMovesLeadingThinkBlocksToThinking(): Promise<void> {
  const adapter = createAdapter();
  (adapter as any).client = {
    chat: {
      completions: {
        create: async () =>
          createAsyncIterable([
            {
              choices: [
                {
                  delta: { content: '<thi' },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: { content: 'nk>\nplan first\n</think>\nfinal ' },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: { content: 'answer【完成！】' },
                  finish_reason: 'stop',
                },
              ],
            },
          ]),
      },
    },
  };

  const events: string[] = [];
  const generator = adapter.generateStream(buildPreparedPayload([{ role: 'user', content: 'inspect repo' }]));
  let finalResponse: Awaited<ReturnType<typeof adapter.generate>> | undefined;

  while (true) {
    const next = await generator.next();
    if (next.done) {
      finalResponse = next.value;
      break;
    }
    if (next.value.type === 'thinking') {
      events.push(`thinking:${next.value.data}`);
    } else if (next.value.type === 'text') {
      events.push(`text:${next.value.data}`);
    } else if (next.value.type === 'complete') {
      events.push(`complete:${next.value.data.finishReason}`);
    }
  }

  assert.deepEqual(events, [
    'thinking:plan first',
    'text:final ',
    'text:answer【完成！】',
    'complete:end_turn',
  ]);
  assert.equal(finalResponse?.thinking, 'plan first');
  assert.equal(finalResponse?.content, 'final answer【完成！】');
}

async function testGenerateReplaysAssistantThinkingForToolOnlyTurns(): Promise<void> {
  const adapter = createAdapter();
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
                  content: 'done',
                },
              },
            ],
          };
        },
      },
    },
  };

  await adapter.generate(
    buildPreparedPayload([
      { role: 'user', content: 'Inspect package metadata' },
      {
        role: 'assistant',
        content: '',
        thinking: 'Need to inspect package.json before answering.',
        toolCalls: [
          {
            id: 'call_3',
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
        toolCallId: 'call_3',
        content: '{"name":"dpagent"}',
      },
    ])
  );

  const assistantMessage = (capturedRequest?.messages as Array<Record<string, unknown>>).find(
    (message) => message.role === 'assistant'
  );
  assert.ok(assistantMessage);
  assert.match(String(assistantMessage?.content ?? ''), /Need to inspect package\.json before answering\./);
  assert.match(String(assistantMessage?.content ?? ''), /<think>/);
  assert.equal(Array.isArray(assistantMessage?.tool_calls), true);
}

async function testGenerateReplaysDeepSeekThinkingAsReasoningContent(): Promise<void> {
  const adapter = createAdapter({
    profileId: 'deepseek-v4-pro',
    provider: 'openai',
    apiKey: 'test-api-key',
    apiBase: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    maxOutputTokens: 4096,
    reasoningPreset: 'off',
    capabilities: {
      reasoningEffort: false,
      thinkingBudget: false,
    },
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
                  content: 'done',
                },
              },
            ],
          };
        },
      },
    },
  };

  await adapter.generate(
    buildPreparedPayload([
      { role: 'user', content: 'Plan this task' },
      {
        role: 'assistant',
        content: '',
        thinking: '  Need to finalize before executing.\n',
        metadata: {
          llmProviderProfileId: 'deepseek-v4-pro',
          llmProvider: 'openai',
          llmModel: 'deepseek-v4-pro',
          thinkingComplete: true,
        },
        toolCalls: [
          {
            id: 'call_4',
            type: 'function',
            function: {
              name: 'finalize_plan',
              arguments: { title: 'Plan' },
            },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_4',
        content: '{"decision":"approved","executionContinuation":"approved_new_turn"}',
      },
      { role: 'assistant', content: 'Plan approved. Execution will continue in a new turn.' },
      { role: 'user', content: '[TODO_LOOP]\nContinue execution.' },
    ])
  );

  const requestMessages = capturedRequest?.messages as Array<Record<string, unknown>>;
  const assistantMessage = requestMessages.find(
    (message) => message.role === 'assistant' && Array.isArray(message.tool_calls)
  );
  assert.ok(assistantMessage);
  assert.equal(assistantMessage.reasoning_content, '  Need to finalize before executing.\n');
  assert.equal(assistantMessage.content, '');
  assert.doesNotMatch(String(assistantMessage.content ?? ''), /<think>/);
  assert.equal(Array.isArray(assistantMessage.tool_calls), true);

  const syntheticAssistant = requestMessages.find(
    (message) =>
      message.role === 'assistant' &&
      message.content === 'Plan approved. Execution will continue in a new turn.'
  );
  assert.ok(syntheticAssistant);
  assert.equal(syntheticAssistant.reasoning_content, '');
}

async function testGenerateRejectsMalformedPreparedToolUseReplay(): Promise<void> {
  const adapter = createAdapter();

  await assert.rejects(
    () =>
      adapter.generate(
        buildUnsafePreparedPayload([
          { role: 'user', content: 'inspect project status' },
          {
            role: 'assistant',
            content: 'Calling read_file for multiple paths',
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: { path: 'README.md' },
                },
              },
            ],
          },
          { role: 'assistant', content: 'I will continue after tools.' },
        ])
      ),
    /unbundled assistant tool calls/
  );
}

async function testGenerateRejectsOrphanPreparedToolResultReplay(): Promise<void> {
  const adapter = createAdapter();

  await assert.rejects(
    () =>
      adapter.generate(
        buildUnsafePreparedPayload([
          { role: 'user', content: 'inspect project status' },
          { role: 'tool', name: 'read_file', content: 'orphan tool content' },
        ])
      ),
    /unbundled tool_result messages/
  );
}

async function testGenerateAddsReasoningEffortWhenRuntimeSupportsIt(): Promise<void> {
  const adapter = createAdapter({
    profileId: 'openai-alt',
    provider: 'openai',
    apiKey: 'test-api-key',
    apiBase: 'https://openai-compatible.local/v1',
    model: 'gpt-4.1-mini',
    maxOutputTokens: 4096,
    reasoningPreset: 'medium',
    capabilities: {
      reasoningEffort: true,
      thinkingBudget: false,
    },
    providerOptions: {
      openai: {
        reasoningEffort: 'high',
      },
    },
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
                  content: 'done',
                },
              },
            ],
          };
        },
      },
    },
  };

  await adapter.generate(buildPreparedPayload([{ role: 'user', content: 'answer' }]));
  assert.equal(capturedRequest?.reasoning_effort, 'high');
}

async function testGenerateAddsXHighReasoningEffortWhenRuntimeSupportsIt(): Promise<void> {
  const adapter = createAdapter({
    profileId: 'openai-alt',
    provider: 'openai',
    apiKey: 'test-api-key',
    apiBase: 'https://openai-compatible.local/v1',
    model: 'gpt-5.4',
    maxOutputTokens: 4096,
    reasoningPreset: 'xhigh',
    capabilities: {
      reasoningEffort: true,
      thinkingBudget: false,
    },
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
                  content: 'done',
                },
              },
            ],
          };
        },
      },
    },
  };

  await adapter.generate(buildPreparedPayload([{ role: 'user', content: 'answer' }]));
  assert.equal(capturedRequest?.reasoning_effort, 'xhigh');
}

async function testGenerateClampsMaxReasoningPresetToOpenAiXHigh(): Promise<void> {
  const adapter = createAdapter({
    profileId: 'openai-alt',
    provider: 'openai',
    apiKey: 'test-api-key',
    apiBase: 'https://openai-compatible.local/v1',
    model: 'gpt-5.4',
    maxOutputTokens: 4096,
    reasoningPreset: 'max',
    capabilities: {
      reasoningEffort: true,
      thinkingBudget: false,
    },
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
                  content: 'done',
                },
              },
            ],
          };
        },
      },
    },
  };

  await adapter.generate(buildPreparedPayload([{ role: 'user', content: 'answer' }]));
  assert.equal(capturedRequest?.reasoning_effort, 'xhigh');
}

async function testGenerateOmitsReasoningEffortWhenCapabilityIsDisabled(): Promise<void> {
  const adapter = createAdapter({
    profileId: 'openai-alt',
    provider: 'openai',
    apiKey: 'test-api-key',
    apiBase: 'https://openai-compatible.local/v1',
    model: 'gpt-4.1-mini',
    maxOutputTokens: 4096,
    reasoningPreset: 'high',
    capabilities: {
      reasoningEffort: false,
      thinkingBudget: false,
    },
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
                  content: 'done',
                },
              },
            ],
          };
        },
      },
    },
  };

  await adapter.generate(buildPreparedPayload([{ role: 'user', content: 'answer' }]));
  assert.equal('reasoning_effort' in (capturedRequest ?? {}), false);
}

async function runAll(): Promise<void> {
  await testGenerateNormalizesToolCalls();
  await testGenerateRejectsMalformedToolArguments();
  await testGenerateRejectsNonObjectToolArguments();
  await testGenerateStripsLeadingThinkBlocksFromContent();
  await testGenerateStreamAccumulatesTextAndToolDeltas();
  await testGenerateStreamBuffersArgumentsUntilToolMetadata();
  await testGenerateStreamRejectsMissingToolCallIndex();
  await testGenerateStreamMovesLeadingThinkBlocksToThinking();
  await testGenerateReplaysAssistantThinkingForToolOnlyTurns();
  await testGenerateReplaysDeepSeekThinkingAsReasoningContent();
  await testGenerateRejectsMalformedPreparedToolUseReplay();
  await testGenerateRejectsOrphanPreparedToolResultReplay();
  await testGenerateAddsReasoningEffortWhenRuntimeSupportsIt();
  await testGenerateAddsXHighReasoningEffortWhenRuntimeSupportsIt();
  await testGenerateClampsMaxReasoningPresetToOpenAiXHigh();
  await testGenerateOmitsReasoningEffortWhenCapabilityIsDisabled();
  console.log('llm-openai-compatible tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
