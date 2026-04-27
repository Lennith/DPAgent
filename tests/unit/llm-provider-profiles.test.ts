import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import {
  DEFAULT_SYNTHETIC_SELECTION_UPDATED_AT,
  resolveSessionLlmSelection,
} from '../../src/llm/provider-profiles.js';

function createProfile(id: string, provider: 'anthropic' | 'openai', model: string) {
  return {
    id,
    name: id,
    provider,
    apiKey: `${id}-api-key`,
    apiBase: provider === 'openai' ? 'https://openai.local/v1' : 'https://anthropic.local',
    defaultModel: model,
    maxOutputTokens: 4096,
    enabled: true,
  } as const;
}

async function testConfigManagerPreservesProfilesOnPartialLlmProfilesOverride(): Promise<void> {
  const configManager = new ConfigManager({
    api: {
      apiKey: 'default-api-key',
      apiBase: 'https://anthropic.local',
      model: 'claude-3-7-sonnet-20250219',
      provider: 'anthropic',
      maxOutputTokens: 4096,
    },
    llmProfiles: {
      defaultProfileId: 'profile-a',
      profiles: [
        createProfile('profile-a', 'anthropic', 'claude-3-7-sonnet-20250219'),
        createProfile('profile-b', 'openai', 'gpt-4.1-mini'),
      ],
    },
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-llm-profiles-'));
  const configPath = path.join(tempDir, 'override.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      llmProfiles: {
        defaultProfileId: 'profile-b',
      },
    }),
    'utf8'
  );

  try {
    configManager.loadFromJson(configPath);
    const nextConfig = configManager.get();
    assert.equal(nextConfig.llmProfiles.defaultProfileId, 'profile-b');
    assert.deepEqual(
      nextConfig.llmProfiles.profiles.map((profile) => profile.id),
      ['profile-a', 'profile-b']
    );
    assert.equal(nextConfig.api.provider, 'openai');
    assert.equal(nextConfig.api.model, 'gpt-4.1-mini');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testConfigManagerKeepsLegacyApiOverridesWithoutExplicitProfiles(): void {
  const configManager = new ConfigManager({
    api: {
      apiKey: 'test-api-key-0123456789012345',
      apiBase: 'https://openai-compatible.local/v1',
      model: 'gpt-4o-mini',
      provider: 'openai',
      maxOutputTokens: 4096,
    },
  });

  const nextConfig = configManager.get();
  assert.equal(nextConfig.api.apiKey, 'test-api-key-0123456789012345');
  assert.equal(nextConfig.api.apiBase, 'https://openai-compatible.local/v1');
  assert.equal(nextConfig.api.model, 'gpt-4o-mini');
  assert.equal(nextConfig.api.provider, 'openai');
  assert.equal(nextConfig.llmProfiles.defaultProfileId, 'legacy-default');
  assert.equal(nextConfig.llmProfiles.profiles[0]?.apiKey, 'test-api-key-0123456789012345');
  assert.equal(nextConfig.llmProfiles.profiles[0]?.apiBase, 'https://openai-compatible.local/v1');
  assert.equal(nextConfig.llmProfiles.profiles[0]?.defaultModel, 'gpt-4o-mini');
  assert.equal(nextConfig.llmProfiles.profiles[0]?.provider, 'openai');
}

function testResolveSessionLlmSelectionIsStableWithoutPersistedSelection(): void {
  const configManager = new ConfigManager({
    api: {
      apiKey: 'default-api-key',
      apiBase: 'https://anthropic.local',
      model: 'claude-3-7-sonnet-20250219',
      provider: 'anthropic',
      maxOutputTokens: 4096,
    },
    llmProfiles: {
      defaultProfileId: 'profile-a',
      profiles: [createProfile('profile-a', 'anthropic', 'claude-3-7-sonnet-20250219')],
    },
  });
  const config = configManager.get();

  const first = resolveSessionLlmSelection(config, null);
  const second = resolveSessionLlmSelection(config, null);

  assert.deepEqual(first, second);
  assert.equal(first.updatedAt, DEFAULT_SYNTHETIC_SELECTION_UPDATED_AT);
}

function testResolveSessionLlmSelectionFiltersInactiveProviderOptions(): void {
  const configManager = new ConfigManager({
    api: {
      apiKey: 'default-api-key',
      apiBase: 'https://openai.local/v1',
      model: 'gpt-4.1-mini',
      provider: 'openai',
      maxOutputTokens: 4096,
    },
    llmProfiles: {
      defaultProfileId: 'profile-b',
      profiles: [
        createProfile('profile-a', 'anthropic', 'claude-3-7-sonnet-20250219'),
        createProfile('profile-b', 'openai', 'gpt-4.1-mini'),
      ],
    },
  });
  const config = configManager.get();

  const selection = resolveSessionLlmSelection(config, {
    profileId: 'profile-b',
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
  });

  assert.deepEqual(selection.providerOptions, {
    openai: {
      reasoningEffort: 'high',
    },
  });
}

function testResolveSessionLlmSelectionNormalizesInvalidUpdatedAt(): void {
  const configManager = new ConfigManager({
    api: {
      apiKey: 'default-api-key',
      apiBase: 'https://anthropic.local',
      model: 'claude-3-7-sonnet-20250219',
      provider: 'anthropic',
      maxOutputTokens: 4096,
    },
    llmProfiles: {
      defaultProfileId: 'profile-a',
      profiles: [
        {
          ...createProfile('profile-a', 'anthropic', 'claude-3-7-sonnet-20250219'),
          updatedAt: '2026-04-24T03:00:00.000Z',
        },
      ],
    },
  });
  const config = configManager.get();

  const selection = resolveSessionLlmSelection(config, {
    profileId: 'profile-a',
    model: 'claude-3-7-sonnet-20250219',
    updatedAt: 'not-a-timestamp',
  });

  assert.equal(selection.updatedAt, '2026-04-24T03:00:00.000Z');
}

function testResolveSessionLlmSelectionFallsBackWhenProfileTimestampIsInvalid(): void {
  const configManager = new ConfigManager({
    api: {
      apiKey: 'default-api-key',
      apiBase: 'https://anthropic.local',
      model: 'claude-3-7-sonnet-20250219',
      provider: 'anthropic',
      maxOutputTokens: 4096,
    },
    llmProfiles: {
      defaultProfileId: 'profile-a',
      profiles: [
        {
          ...createProfile('profile-a', 'anthropic', 'claude-3-7-sonnet-20250219'),
          updatedAt: 'invalid-profile-timestamp',
        },
      ],
    },
  });
  const config = configManager.get();

  const selection = resolveSessionLlmSelection(config, {
    profileId: 'profile-a',
    model: 'claude-3-7-sonnet-20250219',
  });

  assert.equal(selection.updatedAt, DEFAULT_SYNTHETIC_SELECTION_UPDATED_AT);
}

async function runAll(): Promise<void> {
  await testConfigManagerPreservesProfilesOnPartialLlmProfilesOverride();
  testConfigManagerKeepsLegacyApiOverridesWithoutExplicitProfiles();
  testResolveSessionLlmSelectionIsStableWithoutPersistedSelection();
  testResolveSessionLlmSelectionFiltersInactiveProviderOptions();
  testResolveSessionLlmSelectionNormalizesInvalidUpdatedAt();
  testResolveSessionLlmSelectionFallsBackWhenProfileTimestampIsInvalid();
  console.log('llm-provider-profiles tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
