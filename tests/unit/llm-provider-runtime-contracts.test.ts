import * as assert from 'node:assert/strict';
import {
  LLMClient,
  buildAnthropicCompatibleOpenAiModelDiscoveryUrls,
  buildAnthropicModelDiscoveryUrls,
  buildOpenAiModelDiscoveryUrls,
  normalizeTokenUsage,
  resolveProviderRuntimeBaseUrl,
} from '../../src/llm/index.js';
import { resolveModelRuntimeBudgetOptions } from '../../src/llm/provider-profiles.js';
import type { LLMResponse } from '../../src/types.js';

function testNormalizeTokenUsage(): void {
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 10 }, 'openai'), undefined);
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 4 }, 'openai'), {
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
  });
  assert.deepEqual(normalizeTokenUsage({ input_tokens: 11, output_tokens: 5 }, 'anthropic'), {
    promptTokens: 11,
    completionTokens: 5,
    totalTokens: 16,
  });
}

function testProviderEndpoints(): void {
  assert.equal(
    resolveProviderRuntimeBaseUrl('anthropic', 'https://api.minimaxi.com/v1'),
    'https://api.minimaxi.com/anthropic'
  );
  assert.equal(
    resolveProviderRuntimeBaseUrl('openai', 'https://openai-compatible.local/v1/'),
    'https://openai-compatible.local/v1'
  );
  assert.deepEqual(buildOpenAiModelDiscoveryUrls('https://openai-compatible.local/v1'), [
    'https://openai-compatible.local/v1/models',
  ]);
  assert.deepEqual(buildAnthropicModelDiscoveryUrls('https://api.minimaxi.com'), [
    'https://api.minimaxi.com/v1/models',
    'https://api.minimaxi.com/anthropic/v1/models',
  ]);
  assert.deepEqual(buildAnthropicCompatibleOpenAiModelDiscoveryUrls('https://api.minimaxi.com/anthropic'), [
    'https://api.minimaxi.com/models',
    'https://api.minimaxi.com/v1/models',
  ]);
}

function testRuntimeBudgetOptions(): void {
  assert.deepEqual(
    resolveModelRuntimeBudgetOptions({
      profileId: 'anthropic-thinking',
      provider: 'anthropic',
      apiKey: 'test',
      apiBase: 'https://api.minimaxi.com',
      model: 'deepseek-v4-flash',
      maxOutputTokens: 4096,
      reasoningPreset: 'high',
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: true,
      },
    }),
    {
      maxOutputTokens: 4096,
      thinkingBudgetTokens: 8192,
    }
  );
  assert.deepEqual(
    resolveModelRuntimeBudgetOptions({
      profileId: 'openai',
      provider: 'openai',
      apiKey: 'test',
      apiBase: 'https://openai-compatible.local/v1',
      model: 'gpt-4.1-mini',
      maxOutputTokens: 2048,
      reasoningPreset: 'high',
      capabilities: {
        reasoningEffort: true,
        thinkingBudget: false,
      },
    }),
    {
      maxOutputTokens: 2048,
      thinkingBudgetTokens: undefined,
    }
  );
}

async function testLlmClientUsesScopedToolInputDeltas(): Promise<void> {
  const client = new LLMClient({
    apiKey: 'test',
    apiBase: 'https://openai-compatible.local/v1',
    model: 'gpt-4.1-mini',
    maxTokens: 1024,
    provider: 'openai',
  });
  const finalResponse: LLMResponse = {
    content: '',
    finishReason: 'tool_use',
    toolCalls: [
      { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: { path: 'a.md' } } },
      { id: 'call-b', type: 'function', function: { name: 'read_file', arguments: { path: 'b.md' } } },
    ],
  };
  (client as unknown as { adapter: { generateStream: LLMClient['generateStream'] } }).adapter = {
    async *generateStream() {
      yield { type: 'tool_start', data: { id: 'call-a', name: 'read_file', index: 0 } } as const;
      yield { type: 'tool_start', data: { id: 'call-b', name: 'read_file', index: 1 } } as const;
      yield { type: 'tool_input', data: { index: 1, chunk: '{"path":"b' } } as const;
      yield { type: 'tool_input', data: { index: 0, chunk: '{"path":"a.md"}' } } as const;
      yield { type: 'tool_input', data: { index: 1, chunk: '.md"}' } } as const;
      yield { type: 'complete', data: finalResponse } as const;
      return finalResponse;
    },
  };

  const observed: Array<{ id: string; path?: string }> = [];
  await client.generateWithCallbacks([{ role: 'user', content: 'inspect' }], {
    onToolUse: (id, _name, input) => observed.push({ id, path: typeof input.path === 'string' ? input.path : undefined }),
  });

  assert.deepEqual(observed, [
    { id: 'call-a', path: undefined },
    { id: 'call-b', path: undefined },
    { id: 'call-a', path: 'a.md' },
    { id: 'call-b', path: 'b.md' },
  ]);
}

async function testLlmClientRejectsUnscopedToolInputDeltas(): Promise<void> {
  const client = new LLMClient({
    apiKey: 'test',
    apiBase: 'https://openai-compatible.local/v1',
    model: 'gpt-4.1-mini',
    maxTokens: 1024,
    provider: 'openai',
  });
  const finalResponse: LLMResponse = {
    content: '',
    finishReason: 'tool_use',
    toolCalls: [
      { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: { path: 'a.md' } } },
    ],
  };
  (client as unknown as { adapter: { generateStream: LLMClient['generateStream'] } }).adapter = {
    async *generateStream() {
      yield { type: 'tool_start', data: { id: 'call-a', name: 'read_file' } } as const;
      yield { type: 'tool_input', data: { chunk: '{"path":"a.md"}' } } as never;
      yield { type: 'complete', data: finalResponse } as const;
      return finalResponse;
    },
  };

  await assert.rejects(
    () => client.generateWithCallbacks([{ role: 'user', content: 'inspect' }], {}),
    /INVALID_TOOL_STREAM_DELTA/
  );
}

async function testLlmClientRejectsUnknownToolInputIndex(): Promise<void> {
  const client = new LLMClient({
    apiKey: 'test',
    apiBase: 'https://openai-compatible.local/v1',
    model: 'gpt-4.1-mini',
    maxTokens: 1024,
    provider: 'openai',
  });
  const finalResponse: LLMResponse = {
    content: '',
    finishReason: 'tool_use',
    toolCalls: [
      { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: { path: 'a.md' } } },
    ],
  };
  (client as unknown as { adapter: { generateStream: LLMClient['generateStream'] } }).adapter = {
    async *generateStream() {
      yield { type: 'tool_start', data: { id: 'call-a', name: 'read_file', index: 0 } } as const;
      yield { type: 'tool_input', data: { index: 1, chunk: '{"path":"a.md"}' } } as const;
      yield { type: 'complete', data: finalResponse } as const;
      return finalResponse;
    },
  };

  await assert.rejects(
    () => client.generateWithCallbacks([{ role: 'user', content: 'inspect' }], {}),
    /tool_input index=1 has no matching tool_start/
  );
}

async function runAll(): Promise<void> {
  testNormalizeTokenUsage();
  testProviderEndpoints();
  testRuntimeBudgetOptions();
  await testLlmClientUsesScopedToolInputDeltas();
  await testLlmClientRejectsUnscopedToolInputDeltas();
  await testLlmClientRejectsUnknownToolInputIndex();
  console.log('llm-provider-runtime-contracts tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
