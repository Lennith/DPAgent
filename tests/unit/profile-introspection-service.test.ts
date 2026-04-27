import * as assert from 'node:assert/strict';
import { ProfileIntrospectionService } from '../../src/llm/ProfileIntrospectionService.js';
import type { LlmProviderProfileConfig } from '../../src/types.js';

function createProfile(
  overrides: Partial<LlmProviderProfileConfig> = {}
): LlmProviderProfileConfig {
  return {
    id: 'openai-alt',
    name: 'OpenAI Alt',
    provider: 'openai',
    apiKey: 'sk-openai-12345678901234567890',
    apiBase: 'https://openai.local/v1',
    defaultModel: 'gpt-4.1-mini',
    maxOutputTokens: 2048,
    enabled: true,
    capabilities: {
      modelDiscovery: true,
      reasoningEffort: true,
      thinkingBudget: false,
    },
    updatedAt: '2026-04-24T00:00:00.000Z',
    ...overrides,
  };
}

async function testDiscoverModelsReturnsLivePayload(): Promise<void> {
  const service = new ProfileIntrospectionService();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'gpt-4.1-mini',
            display_name: 'GPT-4.1 Mini',
            owned_by: 'OpenAI',
          },
        ],
      }),
    }) as Response) as typeof fetch;

  try {
    const result = await service.discoverModels(createProfile());
    assert.equal(result.source, 'live');
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].id, 'gpt-4.1-mini');
    assert.equal(result.models[0].displayName, 'GPT-4.1 Mini');
    assert.equal(result.models[0].supportsReasoningEffort, true);
    assert.equal(result.manualModelEntryAllowed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testDiscoverModelsFallsBackToCacheWhenSignatureMatches(): Promise<void> {
  const service = new ProfileIntrospectionService();
  const originalFetch = globalThis.fetch;
  const profile = createProfile();
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'gpt-4.1-mini',
            },
          ],
        }),
      } as Response;
    }
    throw new Error('network_down');
  }) as typeof fetch;

  try {
    const first = await service.discoverModels(profile);
    const second = await service.discoverModels(profile);

    assert.equal(first.source, 'live');
    assert.equal(second.source, 'cache');
    assert.equal(second.models[0].id, 'gpt-4.1-mini');
    assert.match(String(second.error ?? ''), /network_down/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testDiscoverModelsFallsBackToManualWhenNoCacheExists(): Promise<void> {
  const service = new ProfileIntrospectionService();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    throw new Error('auth_failed');
  }) as typeof fetch;

  try {
    const result = await service.discoverModels(
      createProfile({
        id: 'manual-only',
        defaultModel: 'gpt-4.1',
      })
    );

    assert.equal(result.source, 'manual');
    assert.equal(result.models[0].id, 'gpt-4.1');
    assert.match(String(result.error ?? ''), /auth_failed/);
    assert.equal(result.manualModelEntryAllowed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAnthropicDiscoveryHandlesApiBaseEndingInV1(): Promise<void> {
  const service = new ProfileIntrospectionService();
  const originalFetch = globalThis.fetch;
  const attemptedUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    attemptedUrls.push(url);
    if (url === 'https://api.anthropic.com/v1/models') {
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'claude-3-7-sonnet-20250219',
            },
          ],
        }),
      } as Response;
    }
    throw new Error(`unexpected_url:${url}`);
  }) as typeof fetch;

  try {
    const result = await service.discoverModels(
      createProfile({
        id: 'anthropic-default',
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        defaultModel: 'claude-3-7-sonnet-20250219',
        capabilities: {
          modelDiscovery: true,
          reasoningEffort: false,
          thinkingBudget: true,
        },
      })
    );

    assert.equal(result.source, 'live');
    assert.equal(result.models[0].id, 'claude-3-7-sonnet-20250219');
    assert.deepEqual(attemptedUrls, ['https://api.anthropic.com/v1/models']);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAnthropicDiscoveryFallsBackToOpenAiModelsEndpoint(): Promise<void> {
  const service = new ProfileIntrospectionService();
  const originalFetch = globalThis.fetch;
  const attempted: Array<{ url: string; authorization?: string; anthropicKey?: string }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const url = String(input);
    attempted.push({
      url,
      authorization: headers.Authorization,
      anthropicKey: headers['x-api-key'],
    });
    if (url === 'https://api.deepseek.com/anthropic/v1/models') {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response;
    }
    if (url === 'https://api.deepseek.com/models') {
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'deepseek-v4-flash',
            },
          ],
        }),
      } as Response;
    }
    throw new Error(`unexpected_url:${url}`);
  }) as typeof fetch;

  try {
    const result = await service.discoverModels(
      createProfile({
        id: 'deepseek-anthropic',
        provider: 'anthropic',
        apiBase: 'https://api.deepseek.com/anthropic',
        defaultModel: 'deepseek-v4-flash',
        capabilities: {
          modelDiscovery: true,
          reasoningEffort: false,
          thinkingBudget: true,
        },
      })
    );

    assert.equal(result.source, 'live');
    assert.equal(result.models[0].id, 'deepseek-v4-flash');
    assert.equal(attempted[0].anthropicKey, 'sk-openai-12345678901234567890');
    assert.equal(attempted[1].authorization, 'Bearer sk-openai-12345678901234567890');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runAll(): Promise<void> {
  await testDiscoverModelsReturnsLivePayload();
  await testDiscoverModelsFallsBackToCacheWhenSignatureMatches();
  await testDiscoverModelsFallsBackToManualWhenNoCacheExists();
  await testAnthropicDiscoveryHandlesApiBaseEndingInV1();
  await testAnthropicDiscoveryFallsBackToOpenAiModelsEndpoint();
  console.log('profile-introspection-service tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
