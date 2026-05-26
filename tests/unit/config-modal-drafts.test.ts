import * as assert from 'node:assert/strict';
import type {
  LlmProfilesConfigView,
  PublicSettingsView,
} from '../../src/web/client/app-shell-types.js';
import {
  buildAgentSettingsPayload,
  createDefaultSettingsDraft,
  createSettingsDraftFromResponse,
  optionalPositiveIntegerOrUndefined,
  settingsDraftReducer,
} from '../../src/web/client/components/config-modal-settings-draft.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  buildAvailableModelOptions,
  createEditableProfiles,
  createEmptyProfile,
  normalizeAvailableModels,
  profileDraftToDiscoveryPayload,
  profileDraftToSavePayload,
  type EditableProfile,
} from '../../src/web/client/components/config-modal-profile-draft.js';
import {
  agentConfigDraftToPayload,
  createAgentConfigDraft,
} from '../../src/web/client/components/config-modal-agent-draft.js';

const profilesView: LlmProfilesConfigView = {
  defaultProfileId: 'main',
  profiles: [
    {
      id: 'main',
      name: 'Main',
      provider: 'anthropic',
      apiBase: 'https://api.example.com',
      defaultModel: 'model-a',
      availableModels: ['model-a', 'model-b'],
      maxOutputTokens: 4096,
      contextWindowTokens: 64000,
      enabled: true,
      capabilities: {
        modelDiscovery: true,
        reasoningEffort: false,
        thinkingBudget: true,
      },
      hasApiKey: true,
    },
    {
      id: 'new',
      name: 'New',
      provider: 'openai',
      apiBase: 'https://openai.example.com',
      defaultModel: 'model-o',
      enabled: true,
      hasApiKey: false,
    },
  ],
};

const settingsView: PublicSettingsView = {
  hasApiKey: true,
  llmProfiles: profilesView,
  contextBudget: {
    defaultContextWindowTokens: 57500,
    compressionTriggerRatio: 0.85,
    compressionMaxChars: 6000,
    precompressKeepLlmRounds: 4,
    precompressChunkChars: 60000,
  },
  web: {
    sessionShareTtlHours: 72,
  },
  agent: {
    workspaceDir: 'D:/workspace',
    skillsDir: 'D:/skills',
    globalAgentsDir: 'D:/agents',
    maxSteps: 9.8,
    completionMarkerEnforcementEnabled: true,
    defaultToolset: 'default',
    contextReplayMinRounds: 3,
    contextReplayMaxRounds: 9,
    contextReplayBudgetRatio: 0.45,
  },
  remoteAccessAuth: {
    enabled: true,
    configured: true,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    trustProxy: true,
  },
};

function testSettingsDraftFromResponseNormalizesServerView(): void {
  const draft = createSettingsDraftFromResponse(settingsView);

  assert.equal(draft.skillsDir, 'D:/skills');
  assert.equal(draft.globalAgentsDir, 'D:/agents');
  assert.equal(draft.completionMarkerEnforcementEnabled, true);
  assert.equal(draft.maxSteps, 9);
  assert.equal(draft.authEnabled, true);
  assert.equal(draft.authConfigured, true);
  assert.equal(draft.authPassword, '');
  assert.equal(draft.authClearPassword, false);
  assert.equal(draft.authSessionTtlMs, 12 * 60 * 60 * 1000);
  assert.equal(draft.authTrustProxy, true);
  assert.equal(draft.sessionShareTtlHours, 72);
  assert.equal(draft.ctxReplayMinRounds, 3);
  assert.equal(draft.ctxReplayMaxRounds, 9);
  assert.equal(draft.ctxReplayBudgetRatio, 0.45);
  assert.equal(draft.ctxWindowTokens, 57500);
  assert.equal(draft.ctxPrecompressTriggerRatio, 0.85);
  assert.equal(draft.ctxPrecompressKeepLlmRounds, 4);
  assert.ok(draft.ctxPrecompressChunkTokens > 0);
  assert.ok(draft.ctxCompressionMaxTokens > 0);
}

function testBuildAgentSettingsPayloadPreservesMutationShape(): void {
  const draft = {
    ...createDefaultSettingsDraft(),
    skillsDir: 'D:/skills',
    globalAgentsDir: 'D:/agents',
    maxSteps: 11,
    authEnabled: true,
    authPassword: '  secret  ',
    authSessionTtlMs: 60 * 60 * 1000,
    authTrustProxy: true,
    sessionShareTtlHours: 9999,
    ctxWindowTokens: 12345.9,
    ctxPrecompressChunkTokens: 3000,
    ctxCompressionMaxTokens: 900,
  };

  const payload = buildAgentSettingsPayload(draft);

  assert.equal(payload.skillsDir, 'D:/skills');
  assert.equal(payload.globalAgentsDir, 'D:/agents');
  assert.equal(payload.maxSteps, 11);
  assert.deepEqual(payload.remoteAccessAuth, {
    enabled: true,
    password: '  secret  ',
    sessionTtlMs: 60 * 60 * 1000,
    trustProxy: true,
  });
  assert.deepEqual(payload.web, { sessionShareTtlHours: 720 });
  assert.equal(
    (payload.contextBudget as { defaultContextWindowTokens: number }).defaultContextWindowTokens,
    12345
  );
}

function testBuildAgentSettingsPayloadCanClearPassword(): void {
  const payload = buildAgentSettingsPayload({
    ...createDefaultSettingsDraft(),
    authEnabled: false,
    authPassword: 'ignored',
    authClearPassword: true,
  });

  assert.deepEqual(payload.remoteAccessAuth, {
    enabled: false,
    clearPassword: true,
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    trustProxy: false,
  });
}

function testSettingsDraftReducerKeepsInitialOnPatch(): void {
  const initial = createDefaultSettingsDraft();
  const patched = settingsDraftReducer(
    { initial, draft: initial },
    { type: 'patch', patch: { maxSteps: 12 } }
  );

  assert.equal(patched.initial.maxSteps, 100);
  assert.equal(patched.draft.maxSteps, 12);
}

function testProfileDraftHelpersNormalizeSecretsAndModels(): void {
  const editable = createEditableProfiles(profilesView);

  assert.equal(editable[0]?.apiKeyInput, '');
  assert.equal(editable[0]?.apiKeyEditing, false);
  assert.equal(editable[0]?.clearApiKey, false);
  assert.equal(editable[1]?.apiKeyEditing, true);
  assert.deepEqual(normalizeAvailableModels([' model-b ', 'model-b', '', 'model-c'], 'model-a'), [
    'model-b',
    'model-c',
    'model-a',
  ]);
  assert.deepEqual(buildAvailableModelOptions(editable[0], 'model-c', 'model-a'), [
    { id: 'model-a', label: 'model-a' },
    { id: 'model-b', label: 'model-b' },
    { id: 'model-c', label: 'model-c' },
  ]);
}

function testProfileDraftPayloadsPreserveProviderContracts(): void {
  const profile: EditableProfile = {
    ...createEditableProfiles(profilesView)[0]!,
    apiKeyInput: '  sk-test  ',
    apiKeyEditing: true,
    clearApiKey: true,
    availableModels: ['model-b', 'model-b'],
    defaultModel: 'model-a',
    maxOutputTokens: undefined,
    contextWindowTokens: undefined,
  };

  assert.deepEqual(profileDraftToDiscoveryPayload(profile), {
    id: 'main',
    name: 'Main',
    provider: 'anthropic',
    apiBase: 'https://api.example.com',
    defaultModel: 'model-a',
    availableModels: ['model-b', 'model-a'],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    contextWindowTokens: null,
    enabled: true,
    capabilities: {
      modelDiscovery: true,
      reasoningEffort: false,
      thinkingBudget: true,
    },
    apiKey: 'sk-test',
  });
  assert.deepEqual(profileDraftToSavePayload(profile), {
    id: 'main',
    name: 'Main',
    provider: 'anthropic',
    apiBase: 'https://api.example.com',
    defaultModel: 'model-a',
    availableModels: ['model-b', 'model-a'],
    maxOutputTokens: undefined,
    contextWindowTokens: null,
    enabled: true,
    capabilities: {
      modelDiscovery: true,
      reasoningEffort: false,
      thinkingBudget: true,
    },
    apiKey: 'sk-test',
    clearApiKey: true,
  });
}

function testCreateEmptyProfileUsesExpectedDefaults(): void {
  const profile = createEmptyProfile(2);

  assert.match(profile.id, /^profile-3-/);
  assert.equal(profile.name, 'Profile 3');
  assert.equal(profile.provider, 'anthropic');
  assert.equal(profile.defaultModel, 'MiniMax-M2.7');
  assert.equal(profile.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(profile.apiKeyEditing, true);
}

function testAgentConfigDraftPayloadOnlySavesExplicitOverrides(): void {
  const inherited = createAgentConfigDraft();
  assert.deepEqual(agentConfigDraftToPayload(inherited), { version: 1 });

  const payload = agentConfigDraftToPayload(
    createAgentConfigDraft({
      description: '  Coder  ',
      llmProfileId: '  main  ',
      llmModel: '  model-a  ',
      reasoningPreset: 'high',
      loadGlobalSkills: false,
      exposeAsSubagent: true,
      promptAppend: '  extra prompt  ',
    })
  );
  assert.deepEqual(payload, {
    version: 1,
    description: 'Coder',
    llmProfileId: 'main',
    llmModel: 'model-a',
    reasoningPreset: 'high',
    loadGlobalSkills: false,
    exposeAsSubagent: true,
    promptAppend: 'extra prompt',
  });
}

function testOptionalPositiveInteger(): void {
  assert.equal(optionalPositiveIntegerOrUndefined(12.9), 12);
  assert.equal(optionalPositiveIntegerOrUndefined(0), undefined);
  assert.equal(optionalPositiveIntegerOrUndefined(Number.NaN), undefined);
}

testSettingsDraftFromResponseNormalizesServerView();
testBuildAgentSettingsPayloadPreservesMutationShape();
testBuildAgentSettingsPayloadCanClearPassword();
testSettingsDraftReducerKeepsInitialOnPatch();
testProfileDraftHelpersNormalizeSecretsAndModels();
testProfileDraftPayloadsPreserveProviderContracts();
testCreateEmptyProfileUsesExpectedDefaults();
testAgentConfigDraftPayloadOnlySavesExplicitOverrides();
testOptionalPositiveInteger();

console.log('config-modal-drafts tests passed');
