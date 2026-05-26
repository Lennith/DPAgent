import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { DPAgent } from '../../src/index.js';
import {
  DEFAULT_CONTEXT_BUDGET_CONFIG,
  resolveContextBudget,
} from '../../src/runtime/context-window-budget.js';
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
    availableModels: [model],
    maxOutputTokens: 4096,
    enabled: true,
  } as const;
}

function testResolveContextBudgetPrefersProfileOverrideOverModelOverride(): void {
  const configManager = new ConfigManager({
    llmProfiles: {
      defaultProfileId: 'profile-a',
      profiles: [
        {
          ...createProfile('profile-a', 'openai', 'gpt-4.1-mini'),
          contextWindowTokens: 88000,
        },
      ],
    },
    contextBudget: {
      defaultContextWindowTokens: 57500,
      compressionTriggerRatio: 0.9,
      postCompressionTargetRatio: 0.35,
      minTokensAddedAfterCompression: 16000,
      compressionMaxChars: 6000,
      precompressKeepLlmRounds: 5,
      precompressChunkChars: 60000,
      precompressRetry: 1,
      reservedOutputTokens: 16000,
      reservedReasoningTokens: 0,
      reservedProtocolTokens: 8000,
      modelOverrides: {
        'openai:gpt-4.1-mini': {
          contextWindowTokens: 99000,
        },
      },
    },
  });

  const budget = resolveContextBudget({
    config: configManager.get(),
    profileId: 'profile-a',
    provider: 'openai',
    model: 'gpt-4.1-mini',
  });

  assert.equal(budget.contextWindowTokens, 88000);
  assert.equal(budget.source, 'profile_override');
}

function testResolveContextBudgetFallsBackToModelOverrideThenDefault(): void {
  const configManager = new ConfigManager({
    llmProfiles: {
      defaultProfileId: 'profile-a',
      profiles: [createProfile('profile-a', 'openai', 'gpt-4.1-mini')],
    },
    contextBudget: {
      defaultContextWindowTokens: 57500,
      compressionTriggerRatio: 0.9,
      postCompressionTargetRatio: 0.35,
      minTokensAddedAfterCompression: 16000,
      compressionMaxChars: 6000,
      precompressKeepLlmRounds: 5,
      precompressChunkChars: 60000,
      precompressRetry: 1,
      reservedOutputTokens: 16000,
      reservedReasoningTokens: 0,
      reservedProtocolTokens: 8000,
      modelOverrides: {
        'openai:gpt-4.1-mini': {
          contextWindowTokens: 99000,
        },
      },
    },
  });

  const modelBudget = resolveContextBudget({
    config: configManager.get(),
    profileId: 'profile-a',
    provider: 'openai',
    model: 'gpt-4.1-mini',
  });
  const defaultBudget = resolveContextBudget({
    config: configManager.get(),
    profileId: 'profile-a',
    provider: 'openai',
    model: 'gpt-4.1-nano',
  });

  assert.equal(modelBudget.contextWindowTokens, 99000);
  assert.equal(modelBudget.source, 'model_override');
  assert.equal(defaultBudget.contextWindowTokens, 57500);
  assert.equal(defaultBudget.source, 'config_default');
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
    assert.equal(nextConfig.api.provider, 'anthropic');
    assert.equal(nextConfig.api.model, 'claude-3-7-sonnet-20250219');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testConfigManagerIgnoresLegacyApiOverridesWithoutExplicitProfiles(): void {
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
  assert.equal(nextConfig.llmProfiles.defaultProfileId, 'default');
  assert.equal(nextConfig.llmProfiles.profiles[0]?.apiKey, '');
  assert.equal(nextConfig.llmProfiles.profiles[0]?.apiBase, 'https://api.minimax.io');
  assert.equal(nextConfig.llmProfiles.profiles[0]?.defaultModel, 'MiniMax-M2.5');
  assert.equal(nextConfig.llmProfiles.profiles[0]?.provider, 'anthropic');
}

function testConfigManagerPreservesRootContextBudgetAndRemoteAuthOverrides(): void {
  const configManager = new ConfigManager({
    contextBudget: {
      defaultContextWindowTokens: 123456,
      compressionTriggerRatio: 0.75,
      postCompressionTargetRatio: 0.25,
      minTokensAddedAfterCompression: 777,
      compressionMaxChars: 888,
      precompressKeepLlmRounds: 4,
      precompressChunkChars: 99999,
      precompressRetry: 2,
      reservedOutputTokens: 111,
      reservedReasoningTokens: 222,
      reservedProtocolTokens: 333,
      modelOverrides: {
        'openai:test-model': {
          contextWindowTokens: 654321,
        },
      },
    },
    remoteAccessAuth: {
      enabled: true,
      passwordHash: 'hash',
      passwordSalt: 'salt',
      sessionTtlMs: 1234,
      trustProxy: true,
    },
  });

  const nextConfig = configManager.get();
  assert.equal(nextConfig.contextBudget?.defaultContextWindowTokens, 123456);
  assert.equal(nextConfig.contextBudget?.compressionMaxChars, 888);
  assert.equal(nextConfig.contextBudget?.precompressKeepLlmRounds, 4);
  assert.equal(nextConfig.contextBudget?.precompressChunkChars, 99999);
  assert.equal(nextConfig.contextBudget?.precompressRetry, 2);
  assert.equal(nextConfig.contextBudget?.modelOverrides['openai:test-model']?.contextWindowTokens, 654321);
  assert.equal(nextConfig.remoteAccessAuth?.enabled, true);
  assert.equal(nextConfig.remoteAccessAuth?.passwordHash, 'hash');
  assert.equal(nextConfig.remoteAccessAuth?.passwordSalt, 'salt');
  assert.equal(nextConfig.remoteAccessAuth?.sessionTtlMs, 1234);
  assert.equal(nextConfig.remoteAccessAuth?.trustProxy, true);
}

function testConfigManagerRejectsLegacyContextRuntimeFields(): void {
  assert.throws(
    () =>
      new ConfigManager({
        agent: {
          tokenLimit: 50000,
          contextWindowChars: 360000,
          contextPrecompressTriggerRatio: 0.5,
          contextCompressionMaxChars: 9000,
          contextPrecompressKeepLlmRounds: 7,
          contextPrecompressChunkChars: 71000,
          contextPrecompressRetry: 3,
        } as any,
      }),
    /Removed agent config field\(s\).*contextWindowChars/
  );
}

function testConfigManagerRejectsLegacyContextRuntimeFieldsEvenWithContextBudget(): void {
  assert.throws(
    () =>
      new ConfigManager({
        contextBudget: {
          defaultContextWindowTokens: 123456,
          compressionTriggerRatio: 0.7,
          postCompressionTargetRatio: 0.3,
          minTokensAddedAfterCompression: 123,
          compressionMaxChars: 4321,
          precompressKeepLlmRounds: 4,
          precompressChunkChars: 54321,
          precompressRetry: 1,
          reservedOutputTokens: 111,
          reservedReasoningTokens: 222,
          reservedProtocolTokens: 333,
          modelOverrides: {},
        },
        agent: {
          contextWindowChars: 999999,
          contextPrecompressTriggerRatio: 0.2,
          contextCompressionMaxChars: 999,
          contextPrecompressKeepLlmRounds: 9,
          contextPrecompressChunkChars: 99999,
          contextPrecompressRetry: 9,
        } as any,
      }),
    /Removed agent config field\(s\).*contextWindowChars/
  );
}

function testConfigManagerRejectsPartialLegacyContextRuntimeFields(): void {
  assert.throws(
    () =>
      new ConfigManager({
        contextBudget: {
          precompressRetry: 1,
        },
        agent: {
          contextPrecompressRetry: 9,
        } as any,
      }),
    /Removed agent config field\(s\).*contextPrecompressRetry/
  );
}

function testConfigManagerRejectsLegacyContextFieldsOnReload(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-context-budget-reload-'));
  const configPath = path.join(tempDir, 'legacy.json');
  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agent: {
          contextPrecompressRetry: 2,
          contextPrecompressKeepLlmRounds: 6,
        },
      })
    );

    const configManager = new ConfigManager();
    assert.throws(
      () => configManager.loadFromJson(configPath),
      /Removed agent config field\(s\).*contextPrecompressRetry/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testConfigManagerRejectsRemovedAgentSkillFields(): void {
  assert.throws(
    () =>
      new ConfigManager({
        agent: {
          memoryWriteMode: 'auto',
          skillListPath: './skill-list.yaml',
          skillWriteMode: 'confirm',
        } as any,
      }),
    /Removed agent config field\(s\).*memoryWriteMode.*skillListPath.*skillWriteMode/
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-removed-agent-fields-'));
  const configPath = path.join(tempDir, 'removed-agent-fields.json');
  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agent: {
          skillWriteMode: 'confirm',
        },
      })
    );
    const configManager = new ConfigManager();
    assert.throws(
      () => configManager.loadFromJson(configPath),
      /Removed agent config field\(s\).*skillWriteMode/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testConfigManagerReloadsOldContextBudgetSchemaWithoutStaleNewFields(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-old-budget-reload-'));
  const firstPath = path.join(tempDir, 'first.json');
  const secondPath = path.join(tempDir, 'second.json');
  try {
    fs.writeFileSync(
      firstPath,
      JSON.stringify({
        contextBudget: {
          defaultContextWindowTokens: 123456,
          compressionTriggerRatio: 0.7,
          postCompressionTargetRatio: 0.3,
          minTokensAddedAfterCompression: 123,
          compressionMaxChars: 7777,
          precompressKeepLlmRounds: 9,
          precompressChunkChars: 71000,
          precompressRetry: 3,
          reservedOutputTokens: 111,
          reservedReasoningTokens: 222,
          reservedProtocolTokens: 333,
          modelOverrides: {},
        },
      })
    );
    fs.writeFileSync(
      secondPath,
      JSON.stringify({
        contextBudget: {
          defaultContextWindowTokens: 654321,
          compressionTriggerRatio: 0.8,
          postCompressionTargetRatio: 0.25,
          minTokensAddedAfterCompression: 456,
          reservedOutputTokens: 222,
          reservedReasoningTokens: 0,
          reservedProtocolTokens: 444,
          modelOverrides: {},
        },
      })
    );

    const configManager = new ConfigManager();
    configManager.loadFromJson(firstPath);
    assert.equal(configManager.get().contextBudget?.compressionMaxChars, 7777);
    assert.equal(configManager.get().contextBudget?.precompressRetry, 3);

    configManager.loadFromJson(secondPath);
    assert.equal(configManager.get().contextBudget?.defaultContextWindowTokens, 654321);
    assert.equal(
      configManager.get().contextBudget?.compressionMaxChars,
      DEFAULT_CONTEXT_BUDGET_CONFIG.compressionMaxChars
    );
    assert.equal(
      configManager.get().contextBudget?.precompressKeepLlmRounds,
      DEFAULT_CONTEXT_BUDGET_CONFIG.precompressKeepLlmRounds
    );
    assert.equal(
      configManager.get().contextBudget?.precompressChunkChars,
      DEFAULT_CONTEXT_BUDGET_CONFIG.precompressChunkChars
    );
    assert.equal(
      configManager.get().contextBudget?.precompressRetry,
      DEFAULT_CONTEXT_BUDGET_CONFIG.precompressRetry
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testConfigManagerPartialContextBudgetOverlayPreservesExistingFields(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-partial-budget-overlay-'));
  const partialPath = path.join(tempDir, 'partial.json');
  try {
    fs.writeFileSync(
      partialPath,
      JSON.stringify({
        contextBudget: {
          compressionTriggerRatio: 0.8,
        },
      })
    );

    const configManager = new ConfigManager({
      contextBudget: {
        defaultContextWindowTokens: 123456,
        compressionTriggerRatio: 0.7,
        postCompressionTargetRatio: 0.3,
        minTokensAddedAfterCompression: 123,
        compressionMaxChars: 7777,
        precompressKeepLlmRounds: 9,
        precompressChunkChars: 71000,
        precompressRetry: 3,
        reservedOutputTokens: 111,
        reservedReasoningTokens: 222,
        reservedProtocolTokens: 333,
        modelOverrides: {},
      },
    });

    configManager.loadFromJson(partialPath);
    const budget = configManager.get().contextBudget;
    assert.equal(budget?.compressionTriggerRatio, 0.8);
    assert.equal(budget?.defaultContextWindowTokens, 123456);
    assert.equal(budget?.compressionMaxChars, 7777);
    assert.equal(budget?.precompressKeepLlmRounds, 9);
    assert.equal(budget?.precompressChunkChars, 71000);
    assert.equal(budget?.precompressRetry, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testConfigManagerFiveFieldContextBudgetOverlayPreservesRuntimeFields(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-five-field-budget-overlay-'));
  const partialPath = path.join(tempDir, 'partial.json');
  try {
    fs.writeFileSync(
      partialPath,
      JSON.stringify({
        contextBudget: {
          defaultContextWindowTokens: 654321,
          compressionTriggerRatio: 0.8,
          postCompressionTargetRatio: 0.25,
          minTokensAddedAfterCompression: 456,
        },
      })
    );

    const configManager = new ConfigManager({
      contextBudget: {
        defaultContextWindowTokens: 123456,
        compressionTriggerRatio: 0.7,
        postCompressionTargetRatio: 0.3,
        minTokensAddedAfterCompression: 123,
        compressionMaxChars: 7777,
        precompressKeepLlmRounds: 9,
        precompressChunkChars: 71000,
        precompressRetry: 3,
        reservedOutputTokens: 111,
        reservedReasoningTokens: 222,
        reservedProtocolTokens: 333,
        modelOverrides: {},
      },
    });

    configManager.loadFromJson(partialPath);
    const budget = configManager.get().contextBudget;
    assert.equal(budget?.defaultContextWindowTokens, 654321);
    assert.equal(budget?.compressionTriggerRatio, 0.8);
    assert.equal(budget?.compressionMaxChars, 7777);
    assert.equal(budget?.precompressKeepLlmRounds, 9);
    assert.equal(budget?.precompressChunkChars, 71000);
    assert.equal(budget?.precompressRetry, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testConfigManagerSmallCanonicalBudgetHasNoAgentMirror(): void {
  const configManager = new ConfigManager({
    contextBudget: {
      defaultContextWindowTokens: 8192,
      compressionTriggerRatio: 0.8,
      postCompressionTargetRatio: 0.3,
      minTokensAddedAfterCompression: 512,
      compressionMaxChars: 3000,
      precompressKeepLlmRounds: 2,
      precompressChunkChars: 12000,
      precompressRetry: 1,
      reservedOutputTokens: 1024,
      reservedReasoningTokens: 0,
      reservedProtocolTokens: 512,
      modelOverrides: {},
    },
  });

  const config = configManager.get();
  assert.equal(config.contextBudget?.defaultContextWindowTokens, 8192);
  assert.equal((config.agent as any).contextWindowChars, undefined);
}

function testDPAgentAllowsSmallCanonicalContextBudgetAtStartup(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'small-context-budget-startup-'));
  try {
    const workspaceDir = path.join(tempDir, 'workspace');
    const runtimeDataDir = path.join(tempDir, 'runtime');
    const contextDir = path.join(tempDir, 'contexts');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(runtimeDataDir, { recursive: true });
    fs.mkdirSync(contextDir, { recursive: true });

    const agent = new DPAgent({
      allowMissingApiKeyAtBoot: true,
      workspaceDir,
      runtimeDataDir,
      contextDir,
      config: {
        contextBudget: {
          defaultContextWindowTokens: 8192,
          compressionTriggerRatio: 0.8,
          postCompressionTargetRatio: 0.3,
          minTokensAddedAfterCompression: 512,
          compressionMaxChars: 3000,
          precompressKeepLlmRounds: 2,
          precompressChunkChars: 12000,
          precompressRetry: 1,
          reservedOutputTokens: 1024,
          reservedReasoningTokens: 0,
          reservedProtocolTokens: 512,
          modelOverrides: {},
        },
      },
    });

    assert.equal((agent.getConfig().agent as any).contextWindowChars, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

function testResolveSessionLlmSelectionFallsBackWhenModelIsUnavailable(): void {
  const configManager = new ConfigManager({
    llmProfiles: {
      defaultProfileId: 'profile-a',
      profiles: [
        {
          ...createProfile('profile-a', 'anthropic', 'MiniMax-M2.7'),
          availableModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
        },
      ],
    },
  });

  const selection = resolveSessionLlmSelection(configManager.get(), {
    profileId: 'profile-a',
    model: 'live-discovered-but-not-enabled',
  });

  assert.equal(selection.model, 'MiniMax-M2.7');
}

async function runAll(): Promise<void> {
  await testConfigManagerPreservesProfilesOnPartialLlmProfilesOverride();
  testConfigManagerIgnoresLegacyApiOverridesWithoutExplicitProfiles();
  testResolveContextBudgetPrefersProfileOverrideOverModelOverride();
  testResolveContextBudgetFallsBackToModelOverrideThenDefault();
  testConfigManagerPreservesRootContextBudgetAndRemoteAuthOverrides();
  testConfigManagerRejectsLegacyContextRuntimeFields();
  testConfigManagerRejectsLegacyContextRuntimeFieldsEvenWithContextBudget();
  testConfigManagerRejectsPartialLegacyContextRuntimeFields();
  testConfigManagerRejectsLegacyContextFieldsOnReload();
  testConfigManagerRejectsRemovedAgentSkillFields();
  testConfigManagerPartialContextBudgetOverlayPreservesExistingFields();
  testConfigManagerFiveFieldContextBudgetOverlayPreservesRuntimeFields();
  testConfigManagerSmallCanonicalBudgetHasNoAgentMirror();
  testDPAgentAllowsSmallCanonicalContextBudgetAtStartup();
  testResolveSessionLlmSelectionIsStableWithoutPersistedSelection();
  testResolveSessionLlmSelectionFiltersInactiveProviderOptions();
  testResolveSessionLlmSelectionFallsBackWhenModelIsUnavailable();
  testResolveSessionLlmSelectionNormalizesInvalidUpdatedAt();
  testResolveSessionLlmSelectionFallsBackWhenProfileTimestampIsInvalid();
  console.log('llm-provider-profiles tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
