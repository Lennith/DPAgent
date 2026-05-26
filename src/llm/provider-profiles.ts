import type {
  APIProvider,
  LlmProfileIntrospection,
  LlmProfilesConfig,
  LlmProviderCapabilities,
  LlmProviderProfileConfig,
  ReasoningPreset,
  ResolvedLlmRuntimeConfig,
  SessionLlmSelection,
  SessionLlmSelectionInput,
  SessionLlmProviderOptions,
} from '../types.js';
import { resolveAnthropicThinkingBudgetTokens } from './anthropic-thinking-budget.js';

export const DEFAULT_LLM_PROFILE_ID = 'default';
export const DEFAULT_REASONING_PRESET: ReasoningPreset = 'high';
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
export const DEFAULT_SYNTHETIC_SELECTION_UPDATED_AT = '1970-01-01T00:00:00.000Z';

export function normalizeApiProvider(value: unknown): APIProvider {
  return value === 'openai' ? 'openai' : 'anthropic';
}

export function normalizeReasoningPreset(value: unknown): ReasoningPreset {
  return value === 'off' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : DEFAULT_REASONING_PRESET;
}

function normalizeOptionalTimestamp(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return undefined;
  }
  const timestampMs = Date.parse(trimmed);
  if (!Number.isFinite(timestampMs)) {
    return undefined;
  }
  return new Date(timestampMs).toISOString();
}

function normalizeSelectionUpdatedAt(value: unknown, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return fallback;
  }
  const timestampMs = Date.parse(trimmed);
  if (!Number.isFinite(timestampMs)) {
    return fallback;
  }
  return new Date(timestampMs).toISOString();
}

function normalizeProfileId(value: unknown, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeProfileName(value: unknown, _fallbackId: string, provider: APIProvider): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > 0) {
    return trimmed;
  }
  return `${provider === 'openai' ? 'OpenAI-Compatible' : 'Anthropic-Compatible'} Profile`;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizeModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAvailableModels(value: unknown, defaultModel: string): string[] {
  const models = new Map<string, string>();
  const addModel = (model: unknown): void => {
    const id = normalizeModelId(model);
    if (id && !models.has(id)) {
      models.set(id, id);
    }
  };

  if (Array.isArray(value)) {
    value.forEach(addModel);
  }
  addModel(defaultModel);

  return [...models.values()];
}

export function getAvailableLlmProfileModels(
  profile: Pick<LlmProviderProfileConfig, 'defaultModel' | 'availableModels'>
): string[] {
  return normalizeAvailableModels(profile.availableModels, profile.defaultModel);
}

function normalizeThinkingBudgetTokens(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeReasoningEffort(value: unknown): 'low' | 'medium' | 'high' | 'xhigh' | null | undefined {
  if (value === null) {
    return null;
  }
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' ? value : undefined;
}

function defaultCapabilitiesForProvider(provider: APIProvider): Required<LlmProviderCapabilities> {
  if (provider === 'anthropic') {
    return {
      modelDiscovery: true,
      reasoningEffort: false,
      thinkingBudget: true,
    };
  }
  return {
    modelDiscovery: true,
    reasoningEffort: false,
    thinkingBudget: false,
  };
}

export function getResolvedProfileCapabilities(
  profile: Pick<LlmProviderProfileConfig, 'provider' | 'capabilities'>
): Required<LlmProviderCapabilities> {
  const defaults = defaultCapabilitiesForProvider(normalizeApiProvider(profile.provider));
  return {
    modelDiscovery:
      typeof profile.capabilities?.modelDiscovery === 'boolean'
        ? profile.capabilities.modelDiscovery
        : defaults.modelDiscovery,
    reasoningEffort:
      typeof profile.capabilities?.reasoningEffort === 'boolean'
        ? profile.capabilities.reasoningEffort
        : defaults.reasoningEffort,
    thinkingBudget:
      typeof profile.capabilities?.thinkingBudget === 'boolean'
        ? profile.capabilities.thinkingBudget
        : defaults.thinkingBudget,
  };
}

export function createDefaultLlmProfile(profileId = DEFAULT_LLM_PROFILE_ID): LlmProviderProfileConfig {
  const provider: APIProvider = 'anthropic';
  return {
    id: profileId,
    name: 'Default Profile',
    provider,
    apiKey: '',
    apiBase: 'https://api.minimax.io',
    defaultModel: 'MiniMax-M2.5',
    availableModels: ['MiniMax-M2.5'],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    enabled: true,
    capabilities: getResolvedProfileCapabilities({ provider, capabilities: undefined }),
  };
}

export function normalizeLlmProfilesConfig(config: {
  llmProfiles?: LlmProfilesConfig | null | undefined;
}): LlmProfilesConfig {
  const fallbackProfile = createDefaultLlmProfile();
  const rawProfiles = Array.isArray(config.llmProfiles?.profiles) ? config.llmProfiles?.profiles : [];
  const profilesToNormalize = rawProfiles.length > 0 ? rawProfiles : [fallbackProfile];
  const dedupedProfiles = new Map<string, LlmProviderProfileConfig>();

  profilesToNormalize.forEach((rawProfile, index) => {
    const provider = normalizeApiProvider(rawProfile?.provider);
    const fallbackId = index === 0 ? fallbackProfile.id : `profile-${index + 1}`;
    const id = normalizeProfileId(rawProfile?.id, fallbackId);
    const apiBase = String(rawProfile?.apiBase ?? '').trim() || fallbackProfile.apiBase;
    const rawDefaultModel = String(rawProfile?.defaultModel ?? '').trim() || fallbackProfile.defaultModel;
    const availableModels = normalizeAvailableModels(rawProfile?.availableModels, rawDefaultModel);
    const defaultModel = availableModels.includes(rawDefaultModel)
      ? rawDefaultModel
      : availableModels[0] ?? rawDefaultModel;
    const maxOutputTokens = normalizePositiveInteger(rawProfile?.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);

    dedupedProfiles.set(id, {
      id,
      name: normalizeProfileName(rawProfile?.name, id, provider),
      provider,
      apiKey: typeof rawProfile?.apiKey === 'string' ? rawProfile.apiKey.trim() : '',
      apiBase,
      defaultModel,
      availableModels,
      maxOutputTokens,
      contextWindowTokens: normalizeOptionalPositiveInteger(rawProfile?.contextWindowTokens),
      enabled: rawProfile?.enabled !== false,
      capabilities: getResolvedProfileCapabilities({
        provider,
        capabilities: rawProfile?.capabilities,
      }),
      createdAt: normalizeOptionalTimestamp(rawProfile?.createdAt),
      updatedAt: normalizeOptionalTimestamp(rawProfile?.updatedAt),
    });
  });

  const profiles = [...dedupedProfiles.values()];
  const defaultProfileId = normalizeProfileId(config.llmProfiles?.defaultProfileId, profiles[0]?.id ?? fallbackProfile.id);
  const resolvedDefaultProfileId =
    profiles.some((profile) => profile.id === defaultProfileId) && defaultProfileId
      ? defaultProfileId
      : profiles[0]?.id ?? fallbackProfile.id;

  return {
    defaultProfileId: resolvedDefaultProfileId,
    profiles: profiles.length > 0 ? profiles : [fallbackProfile],
  };
}

export function resolveDefaultLlmProfile(config: {
  llmProfiles: LlmProfilesConfig;
}): LlmProviderProfileConfig {
  const normalized = normalizeLlmProfilesConfig(config);
  return normalized.profiles.find((profile) => profile.id === normalized.defaultProfileId) ?? normalized.profiles[0] ?? createDefaultLlmProfile();
}

export function findResolvedLlmProfile(
  config: {
    llmProfiles?: LlmProfilesConfig | null | undefined;
  },
  profileId: string
): LlmProviderProfileConfig | undefined {
  const normalized = normalizeLlmProfilesConfig(config);
  const trimmedProfileId = String(profileId ?? '').trim();
  if (!trimmedProfileId) {
    return undefined;
  }
  return normalized.profiles.find((profile) => profile.id === trimmedProfileId);
}

function normalizeProviderOptionsForProvider(
  value: SessionLlmProviderOptions | undefined,
  provider: APIProvider
): SessionLlmProviderOptions | undefined {
  const openaiReasoningEffort = normalizeReasoningEffort(value?.openai?.reasoningEffort);
  const anthropicThinkingBudget = normalizeThinkingBudgetTokens(value?.anthropic?.thinkingBudgetTokens);
  const next: SessionLlmProviderOptions = {};

  if (provider === 'openai' && openaiReasoningEffort !== undefined) {
    next.openai = {
      reasoningEffort: openaiReasoningEffort,
    };
  }
  if (provider === 'anthropic' && anthropicThinkingBudget !== undefined) {
    next.anthropic = {
      thinkingBudgetTokens: anthropicThinkingBudget,
    };
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function resolveSessionLlmSelection(
  config: {
    llmProfiles?: LlmProfilesConfig | null | undefined;
  },
  selection?: SessionLlmSelection | SessionLlmSelectionInput | null
): SessionLlmSelection {
  const llmProfiles = normalizeLlmProfilesConfig(config);
  const defaultProfile = resolveDefaultLlmProfile({
    llmProfiles,
  });
  const requestedProfileId = typeof selection?.profileId === 'string' ? selection.profileId.trim() : '';
  const resolvedProfile =
    llmProfiles.profiles.find((profile) => profile.id === requestedProfileId) ?? defaultProfile;
  const requestedModel = typeof selection?.model === 'string' ? selection.model.trim() : '';
  const availableModels = getAvailableLlmProfileModels(resolvedProfile);
  const resolvedModel =
    requestedModel && availableModels.includes(requestedModel)
      ? requestedModel
      : resolvedProfile.defaultModel || availableModels[0] || '';

  return {
    profileId: resolvedProfile.id,
    model: resolvedModel,
    reasoningPreset: normalizeReasoningPreset(selection?.reasoningPreset),
    providerOptions: normalizeProviderOptionsForProvider(selection?.providerOptions, resolvedProfile.provider),
    updatedAt: normalizeSelectionUpdatedAt(
      (selection as SessionLlmSelection | SessionLlmSelectionInput | undefined)?.updatedAt,
      resolvedProfile.updatedAt ?? DEFAULT_SYNTHETIC_SELECTION_UPDATED_AT
    ),
  };
}

export function applySessionLlmSelectionInput(
  config: {
    llmProfiles?: LlmProfilesConfig | null | undefined;
  },
  currentSelection?: SessionLlmSelection | SessionLlmSelectionInput | null,
  patch?: SessionLlmSelectionInput | null
): SessionLlmSelection {
  const current = resolveSessionLlmSelection(config, currentSelection);
  if (!patch) {
    return current;
  }

  const nextProfileId =
    typeof patch.profileId === 'string' && patch.profileId.trim().length > 0
      ? patch.profileId.trim()
      : current.profileId;
  const profileChanged = nextProfileId !== current.profileId;

  return resolveSessionLlmSelection(config, {
    profileId: nextProfileId,
    model:
      patch.model !== undefined
        ? patch.model
        : profileChanged
          ? ''
          : current.model,
    reasoningPreset:
      patch.reasoningPreset !== undefined
        ? normalizeReasoningPreset(patch.reasoningPreset)
        : current.reasoningPreset,
    providerOptions:
      patch.providerOptions !== undefined
        ? patch.providerOptions
        : profileChanged
          ? undefined
          : current.providerOptions,
    updatedAt: normalizeSelectionUpdatedAt(patch.updatedAt, current.updatedAt),
  });
}

export function resolveLlmRuntimeConfig(
  config: {
    llmProfiles?: LlmProfilesConfig | null | undefined;
  },
  selection?: SessionLlmSelection | SessionLlmSelectionInput | null
): ResolvedLlmRuntimeConfig {
  const llmProfiles = normalizeLlmProfilesConfig(config);
  const resolvedSelection = resolveSessionLlmSelection(config, selection);
  const profile =
    llmProfiles.profiles.find((item) => item.id === resolvedSelection.profileId) ??
    resolveDefaultLlmProfile({
      llmProfiles,
    });
  const capabilities = getResolvedProfileCapabilities(profile);

  return {
    profileId: profile.id,
    provider: profile.provider,
    apiKey: profile.apiKey,
    apiBase: profile.apiBase,
    model: resolvedSelection.model || profile.defaultModel,
    maxOutputTokens: normalizePositiveInteger(profile.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
    reasoningPreset: resolvedSelection.reasoningPreset,
    capabilities: {
      reasoningEffort: capabilities.reasoningEffort,
      thinkingBudget: capabilities.thinkingBudget,
    },
    providerOptions: resolvedSelection.providerOptions,
  };
}

export function resolveModelRuntimeBudgetOptions(
  runtimeConfig: ResolvedLlmRuntimeConfig | undefined
): {
  maxOutputTokens?: number;
  thinkingBudgetTokens?: number;
} {
  if (!runtimeConfig) {
    return {};
  }
  return {
    maxOutputTokens: runtimeConfig.maxOutputTokens,
    thinkingBudgetTokens: resolveAnthropicThinkingBudgetTokens(runtimeConfig),
  };
}

export function createManualLlmIntrospection(
  profile: LlmProviderProfileConfig,
  error?: string
): LlmProfileIntrospection {
  const capabilities = getResolvedProfileCapabilities(profile);
  return {
    profileId: profile.id,
    source: 'manual',
    fetchedAt: new Date().toISOString(),
    models: getAvailableLlmProfileModels(profile).map((model) => ({
      id: model,
      displayName: model,
      provider: profile.provider,
      supportsReasoningEffort: capabilities.reasoningEffort,
      supportsThinkingBudget: capabilities.thinkingBudget,
    })),
    manualModelEntryAllowed: true,
    capabilities,
    error,
  };
}
