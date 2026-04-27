import * as assert from 'node:assert/strict';
import {
  applySessionLlmSelectionPatch,
  createNextSessionLlmSelectionUpdatedAt,
  resolveSessionLlmSelectionView,
} from '../../src/web/client/llm-session-state.js';
import type { LlmProfilesConfigView } from '../../src/web/client/app-shell-types.js';

function createProfiles(): LlmProfilesConfigView {
  return {
    defaultProfileId: 'anthropic-default',
    profiles: [
      {
        id: 'anthropic-default',
        name: 'Anthropic Default',
        provider: 'anthropic',
        apiBase: 'https://api.minimaxi.com',
        defaultModel: 'MiniMax-M2.7',
        maxOutputTokens: 4096,
        hasApiKey: true,
        capabilities: {
          modelDiscovery: true,
          reasoningEffort: false,
          thinkingBudget: true,
        },
        updatedAt: '2026-04-24T00:00:00.000Z',
      },
      {
        id: 'openai-alt',
        name: 'OpenAI Alt',
        provider: 'openai',
        apiBase: 'https://openai.local/v1',
        defaultModel: 'gpt-4.1-mini',
        maxOutputTokens: 2048,
        hasApiKey: true,
        capabilities: {
          modelDiscovery: true,
          reasoningEffort: true,
          thinkingBudget: false,
        },
        updatedAt: '2026-04-24T01:00:00.000Z',
      },
    ],
  };
}

function testResolveSelectionFallsBackToDefaultProfile(): void {
  const selection = resolveSessionLlmSelectionView(createProfiles(), null);
  assert.equal(selection.profileId, 'anthropic-default');
  assert.equal(selection.model, 'MiniMax-M2.7');
  assert.equal(selection.reasoningPreset, 'off');
}

function testApplyPatchResetsModelAndProviderOptionsWhenProfileChanges(): void {
  const current = resolveSessionLlmSelectionView(createProfiles(), {
    profileId: 'anthropic-default',
    model: 'MiniMax-M2.7',
    reasoningPreset: 'high',
    providerOptions: {
      anthropic: {
        thinkingBudgetTokens: 8192,
      },
    },
    updatedAt: '2026-04-24T00:00:00.000Z',
  });

  const next = applySessionLlmSelectionPatch(createProfiles(), current, {
    profileId: 'openai-alt',
  });

  assert.equal(next.profileId, 'openai-alt');
  assert.equal(next.model, 'gpt-4.1-mini');
  assert.equal(next.providerOptions, undefined);
}

function testResolveSelectionFiltersInactiveProviderOptions(): void {
  const selection = resolveSessionLlmSelectionView(createProfiles(), {
    profileId: 'openai-alt',
    model: 'gpt-4.1-mini',
    reasoningPreset: 'high',
    providerOptions: {
      openai: {
        reasoningEffort: 'high',
      },
      anthropic: {
        thinkingBudgetTokens: 4096,
      },
    },
    updatedAt: '2026-04-24T01:00:00.000Z',
  });

  assert.deepEqual(selection.providerOptions, {
    openai: {
      reasoningEffort: 'high',
    },
  });
}

function testCreateNextSelectionUpdatedAtIsMonotonic(): void {
  const first = createNextSessionLlmSelectionUpdatedAt('2026-04-24T01:00:00.000Z');
  const second = createNextSessionLlmSelectionUpdatedAt(first);

  assert.ok(first > '2026-04-24T01:00:00.000Z');
  assert.ok(second > first);
}

function testApplyPatchAcceptsExplicitUpdatedAt(): void {
  const current = resolveSessionLlmSelectionView(createProfiles(), {
    profileId: 'anthropic-default',
    model: 'MiniMax-M2.7',
    reasoningPreset: 'off',
    updatedAt: '2026-04-24T00:00:00.000Z',
  });

  const next = applySessionLlmSelectionPatch(createProfiles(), current, {
    model: 'MiniMax-M2.5-Reasoning',
    updatedAt: '2026-04-24T02:00:00.000Z',
  });

  assert.equal(next.model, 'MiniMax-M2.5-Reasoning');
  assert.equal(next.updatedAt, '2026-04-24T02:00:00.000Z');
}

function runAll(): void {
  testResolveSelectionFallsBackToDefaultProfile();
  testApplyPatchResetsModelAndProviderOptionsWhenProfileChanges();
  testResolveSelectionFiltersInactiveProviderOptions();
  testCreateNextSelectionUpdatedAtIsMonotonic();
  testApplyPatchAcceptsExplicitUpdatedAt();
  console.log('llm-session-state tests passed');
}

runAll();
