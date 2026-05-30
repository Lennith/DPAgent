import * as assert from 'node:assert/strict';
import { DPAgent } from '../../src/index.js';
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

function testRunOverridesResolveTurnSpecificLlmRuntime(): void {
  const agent = new DPAgent({
    config: {
      llmProfiles: {
        defaultProfileId: 'profile-a',
        profiles: [
          {
            id: 'profile-a',
            name: 'Profile A',
            provider: 'openai',
            apiKey: 'profile-a-key-012345678901',
            apiBase: 'https://profile-a.local/v1',
            defaultModel: 'model-a',
          },
          {
            id: 'profile-b',
            name: 'Profile B',
            provider: 'openai',
            apiKey: 'profile-b-key-012345678901',
            apiBase: 'https://profile-b.local/v1',
            defaultModel: 'model-b',
            availableModels: ['model-b', 'model-b-alt'],
          },
        ],
      },
    },
  });

  const resolved = (
    agent as unknown as {
      resolveTurnLlmRuntime(overrides?: {
        llmProfileId?: string;
        llmModel?: string;
        reasoningPreset?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      }): {
        profileId: string;
        apiKey: string;
        apiBase: string;
        model: string;
        reasoningPreset: string;
      } | null;
    }
  ).resolveTurnLlmRuntime({
    llmProfileId: 'profile-b',
    llmModel: 'model-b-alt',
    reasoningPreset: 'high',
  });

  assert.equal(resolved?.profileId, 'profile-b');
  assert.equal(resolved?.apiKey, 'profile-b-key-012345678901');
  assert.equal(resolved?.apiBase, 'https://profile-b.local/v1');
  assert.equal(resolved?.model, 'model-b-alt');
  assert.equal(resolved?.reasoningPreset, 'high');
}

function runAll(): void {
  testDefaultsToAnthropicAdapter();
  testOpenAiProviderUsesOpenAiAdapter();
  testRunOverridesResolveTurnSpecificLlmRuntime();
  console.log('llm-provider-routing tests passed');
}

runAll();
