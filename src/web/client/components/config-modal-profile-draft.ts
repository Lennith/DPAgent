import type {
  LlmProfilesConfigView,
  PublicLlmProfile,
} from '../app-shell-types.js';

export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export interface EditableProfile extends Omit<PublicLlmProfile, 'hasApiKey'> {
  hasApiKey: boolean;
  apiKeyInput: string;
  apiKeyEditing: boolean;
  clearApiKey: boolean;
}

export type EditableProfileUpdater =
  | EditableProfile[]
  | ((profiles: EditableProfile[]) => EditableProfile[]);

export interface ModelOption {
  id: string;
  label: string;
}

export function createEditableProfiles(llmProfiles: LlmProfilesConfigView | null | undefined): EditableProfile[] {
  return (llmProfiles?.profiles ?? []).map((profile) => ({
    ...profile,
    apiKeyInput: '',
    apiKeyEditing: !profile.hasApiKey,
    clearApiKey: false,
  }));
}

export function createEmptyProfile(index: number): EditableProfile {
  const id = `profile-${index + 1}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: `Profile ${index + 1}`,
    provider: 'anthropic',
    apiBase: '',
    defaultModel: '',
    availableModels: [],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    enabled: true,
    capabilities: {
      modelDiscovery: true,
      reasoningEffort: false,
      thinkingBudget: true,
    },
    hasApiKey: false,
    apiKeyInput: '',
    apiKeyEditing: true,
    clearApiKey: false,
  };
}

export function normalizeAvailableModels(value: unknown, defaultModel: string): string[] {
  const models = new Map<string, string>();
  const addModel = (model: unknown): void => {
    const id = typeof model === 'string' ? model.trim() : '';
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

export function buildAvailableModelOptions(
  profile: Pick<EditableProfile, 'availableModels' | 'defaultModel'> | null | undefined,
  ...fallbackModels: Array<string | undefined>
): ModelOption[] {
  const options = new Map<string, string>();
  normalizeAvailableModels(profile?.availableModels, profile?.defaultModel ?? '').forEach((model) =>
    options.set(model, model)
  );
  for (const model of fallbackModels) {
    const id = String(model ?? '').trim();
    if (id && !options.has(id)) {
      options.set(id, id);
    }
  }
  return [...options.entries()].map(([id, label]) => ({ id, label }));
}

export function profileDraftToDiscoveryPayload(profile: EditableProfile): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    apiBase: profile.apiBase,
    defaultModel: profile.defaultModel,
    availableModels: normalizeAvailableModels(profile.availableModels, profile.defaultModel),
    maxOutputTokens: profile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    contextWindowTokens: profile.contextWindowTokens ?? null,
    enabled: profile.enabled,
    capabilities: {
      ...(profile.capabilities ?? {}),
      modelDiscovery: true,
    },
    ...(profile.apiKeyEditing && profile.apiKeyInput.trim().length > 0
      ? { apiKey: profile.apiKeyInput.trim() }
      : {}),
  };
}

export function profileDraftToSavePayload(profile: EditableProfile): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    apiBase: profile.apiBase,
    defaultModel: profile.defaultModel,
    availableModels: normalizeAvailableModels(profile.availableModels, profile.defaultModel),
    maxOutputTokens: profile.maxOutputTokens,
    contextWindowTokens: profile.contextWindowTokens ?? null,
    enabled: profile.enabled,
    capabilities: {
      ...(profile.capabilities ?? {}),
      modelDiscovery: true,
    },
    ...(profile.apiKeyEditing && profile.apiKeyInput.trim().length > 0
      ? { apiKey: profile.apiKeyInput.trim() }
      : {}),
    ...(profile.clearApiKey ? { clearApiKey: true } : {}),
  };
}
