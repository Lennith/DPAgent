import * as assert from 'node:assert/strict';
import { LLMClient } from '../../src/llm/index.js';

function createConfig(provider?: 'anthropic' | 'openai') {
  return {
    apiKey: 'test-api-key',
    apiBase: provider === 'openai' ? 'https://example-openai.local/v1' : 'https://api.minimaxi.com',
    model: provider === 'openai' ? 'gpt-4o-mini' : 'MiniMax-M2.7',
    maxTokens: 4096,
    provider,
  };
}

function testDefaultsToAnthropicAdapter(): void {
  const client = new LLMClient(createConfig());
  assert.equal(client.provider, 'anthropic');
  assert.equal((client as any).adapter.constructor.name, 'AnthropicAdapter');
}

function testOpenAiProviderUsesOpenAiAdapter(): void {
  const client = new LLMClient(createConfig('openai'));
  assert.equal(client.provider, 'openai');
  assert.equal((client as any).adapter.constructor.name, 'OpenAICompatibleAdapter');
}

function runAll(): void {
  testDefaultsToAnthropicAdapter();
  testOpenAiProviderUsesOpenAiAdapter();
  console.log('llm-provider-routing tests passed');
}

runAll();
