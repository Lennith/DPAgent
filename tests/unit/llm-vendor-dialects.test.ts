import * as assert from 'node:assert/strict';
import {
  resolveLlmVendorDialect,
  resolveOpenAiThinkingRequest,
  resolveProviderRuntimeBaseUrlForDialect,
} from '../../src/llm/vendor-dialects/index.js';
import type { ResolvedLlmRuntimeConfig } from '../../src/types.js';

function runtime(overrides: Partial<ResolvedLlmRuntimeConfig>): ResolvedLlmRuntimeConfig {
  return {
    profileId: 'test-profile',
    provider: 'anthropic',
    apiKey: 'test-api-key',
    apiBase: 'https://api.example.local',
    model: 'test-model',
    maxOutputTokens: 4096,
    reasoningPreset: 'high',
    capabilities: {
      reasoningEffort: false,
      thinkingBudget: false,
    },
    ...overrides,
    capabilities: {
      reasoningEffort: false,
      thinkingBudget: false,
      ...overrides.capabilities,
    },
  };
}

function testResolvesXiaomiMimoDialect(): void {
  const dialect = resolveLlmVendorDialect(
    runtime({
      profileId: 'xiaomi-mimo',
      provider: 'anthropic',
      apiBase: 'https://token-plan-cn.xiaomimimo.com/anthropic',
      model: 'mimo-v2.5-pro',
      capabilities: {
        thinkingBudget: true,
      },
    })
  );

  assert.equal(dialect.id, 'xiaomi-mimo');
  assert.equal(dialect.anthropic.allowUnsignedThinkingReplay, true);
  assert.equal(dialect.openai.replayAssistantThinkingAsReasoningContent, true);
  assert.equal(dialect.openai.suppressReasoningEffort, true);
}

function testXiaomiMimoOpenAiThinkingRequestFollowsReasoningPreset(): void {
  const enabled = runtime({
    provider: 'openai',
    apiBase: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
    reasoningPreset: 'high',
  });
  assert.deepEqual(resolveOpenAiThinkingRequest(enabled), { type: 'enabled' });

  const disabled = {
    ...enabled,
    reasoningPreset: 'off' as const,
  };
  assert.equal(resolveOpenAiThinkingRequest(disabled), undefined);
}

function testDeepSeekUsesReasoningContentWithoutThinkingRequest(): void {
  const dialect = resolveLlmVendorDialect(
    runtime({
      profileId: 'deepseek',
      provider: 'openai',
      apiBase: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    })
  );

  assert.equal(dialect.id, 'deepseek');
  assert.equal(dialect.openai.replayAssistantThinkingAsReasoningContent, true);
  assert.equal(dialect.openai.enableThinkingRequest, false);
  assert.equal(resolveOpenAiThinkingRequest({ ...runtime({ provider: 'openai' }), model: 'deepseek-v4-flash' }), undefined);
}

function testDeepSeekServedByMiniMaxGatewayKeepsEndpointNormalization(): void {
  const llmRuntime = runtime({
    profileId: 'deepseek',
    provider: 'anthropic',
    apiBase: 'https://api.minimaxi.com',
    model: 'deepseek-v4-flash',
  });
  const dialect = resolveLlmVendorDialect(llmRuntime);

  assert.equal(dialect.id, 'deepseek');
  assert.equal(
    resolveProviderRuntimeBaseUrlForDialect('anthropic', 'https://api.minimaxi.com', llmRuntime),
    'https://api.minimaxi.com/anthropic'
  );
}

function testOfficialAnthropicUsesSignedThinkingAndOutputEffort(): void {
  const dialect = resolveLlmVendorDialect(
    runtime({
      provider: 'anthropic',
      apiBase: 'https://api.anthropic.com',
      model: 'claude-opus-4-7',
      capabilities: {
        thinkingBudget: true,
      },
    })
  );

  assert.equal(dialect.id, 'official-anthropic');
  assert.equal(dialect.anthropic.allowUnsignedThinkingReplay, false);
  assert.equal(dialect.anthropic.reasoningRequest, 'output_config_effort');
}

function testMiniMaxKeepsAnthropicBaseUrlNormalization(): void {
  const dialect = resolveLlmVendorDialect(
    runtime({
      provider: 'anthropic',
      apiBase: 'https://api.minimax.io/v1',
      model: 'MiniMax-M2.7',
    })
  );

  assert.equal(dialect.id, 'minimax');
  assert.equal(
    resolveProviderRuntimeBaseUrlForDialect('anthropic', 'https://api.minimax.io/v1'),
    'https://api.minimax.io/anthropic'
  );
}

function testMiniMaxPathOnProxyDoesNotTriggerDialect(): void {
  const dialect = resolveLlmVendorDialect(
    runtime({
      provider: 'anthropic',
      apiBase: 'https://proxy.example.com/minimax/v1',
      model: 'generic-model',
    })
  );

  assert.equal(dialect.id, 'generic-anthropic-compatible');
  assert.equal(
    resolveProviderRuntimeBaseUrlForDialect('anthropic', 'https://proxy.example.com/minimax/v1'),
    'https://proxy.example.com/minimax/v1'
  );
}

function testProxyHostSuffixDoesNotTriggerOfficialMiniMaxDialect(): void {
  const dialect = resolveLlmVendorDialect(
    runtime({
      provider: 'anthropic',
      apiBase: 'https://api.minimax.io.proxy.local/v1',
      model: 'generic-model',
    })
  );

  assert.equal(dialect.id, 'generic-anthropic-compatible');
  assert.equal(
    resolveProviderRuntimeBaseUrlForDialect('anthropic', 'https://api.minimax.io.proxy.local/v1'),
    'https://api.minimax.io.proxy.local/v1'
  );
}

function testMiniMaxModelOnProxyDoesNotRewriteEndpoint(): void {
  const llmRuntime = runtime({
    provider: 'anthropic',
    apiBase: 'https://proxy.example.com/anthropic/v1',
    model: 'MiniMax-M2.7',
  });
  const dialect = resolveLlmVendorDialect(llmRuntime);

  assert.equal(dialect.id, 'minimax');
  assert.equal(
    resolveProviderRuntimeBaseUrlForDialect('anthropic', 'https://proxy.example.com/anthropic/v1', llmRuntime),
    'https://proxy.example.com/anthropic/v1'
  );
}

function testXiaomiProfileNameAloneDoesNotTriggerMimoDialect(): void {
  const dialect = resolveLlmVendorDialect(
    runtime({
      profileId: 'xiaomi-proxy',
      provider: 'openai',
      apiBase: 'https://openai-compatible.local/v1',
      model: 'gpt-4o-mini',
    })
  );

  assert.equal(dialect.id, 'generic-openai-compatible');
}

function testMisleadingVendorHostsDoNotTriggerOfficialDialects(): void {
  const misleadingXiaomi = resolveLlmVendorDialect(
    runtime({
      provider: 'openai',
      apiBase: 'https://not-xiaomimimo.com/v1',
      model: 'manual-entry',
    })
  );
  assert.equal(misleadingXiaomi.id, 'generic-openai-compatible');

  const misleadingOpenAi = resolveLlmVendorDialect(
    runtime({
      provider: 'openai',
      apiBase: 'https://api.openai.com.proxy.local/v1',
      model: 'gpt-4o-mini',
    })
  );
  assert.equal(misleadingOpenAi.id, 'generic-openai-compatible');

  const misleadingAnthropic = resolveLlmVendorDialect(
    runtime({
      provider: 'anthropic',
      apiBase: 'https://api.anthropic.com.proxy.local',
      model: 'generic-model',
    })
  );
  assert.equal(misleadingAnthropic.id, 'generic-anthropic-compatible');

  const misleadingDeepSeek = resolveLlmVendorDialect(
    runtime({
      provider: 'openai',
      apiBase: 'https://api.deepseek.com.proxy.local/v1',
      model: 'manual-entry',
    })
  );
  assert.equal(misleadingDeepSeek.id, 'generic-openai-compatible');
}

function testXiaomiOfficialBaseTriggersMimoDialectForManualModels(): void {
  const dialect = resolveLlmVendorDialect(
    runtime({
      provider: 'openai',
      apiBase: 'https://token-plan-cn.xiaomimimo.com/v1',
      model: 'manual-entry',
    })
  );

  assert.equal(dialect.id, 'xiaomi-mimo');
}

function testGenericOpenAiDoesNotInheritVendorThinkingRules(): void {
  const dialect = resolveLlmVendorDialect(
    runtime({
      provider: 'openai',
      apiBase: 'https://openai-compatible.local/v1',
      model: 'gpt-4o-mini',
      capabilities: {
        reasoningEffort: true,
      },
    })
  );

  assert.equal(dialect.id, 'generic-openai-compatible');
  assert.equal(dialect.openai.replayAssistantThinkingAsReasoningContent, false);
  assert.equal(dialect.openai.enableThinkingRequest, false);
  assert.equal(dialect.openai.suppressReasoningEffort, false);
}

function runAll(): void {
  testResolvesXiaomiMimoDialect();
  testXiaomiMimoOpenAiThinkingRequestFollowsReasoningPreset();
  testDeepSeekUsesReasoningContentWithoutThinkingRequest();
  testDeepSeekServedByMiniMaxGatewayKeepsEndpointNormalization();
  testOfficialAnthropicUsesSignedThinkingAndOutputEffort();
  testMiniMaxKeepsAnthropicBaseUrlNormalization();
  testMiniMaxPathOnProxyDoesNotTriggerDialect();
  testProxyHostSuffixDoesNotTriggerOfficialMiniMaxDialect();
  testMiniMaxModelOnProxyDoesNotRewriteEndpoint();
  testXiaomiProfileNameAloneDoesNotTriggerMimoDialect();
  testMisleadingVendorHostsDoNotTriggerOfficialDialects();
  testXiaomiOfficialBaseTriggersMimoDialectForManualModels();
  testGenericOpenAiDoesNotInheritVendorThinkingRules();
  console.log('llm-vendor-dialects tests passed');
}

runAll();
