import type {
  LlmProfilesConfigView,
  PublicLlmProfile,
  ReasoningPreset,
  SessionLlmSelectionPatch,
  SessionLlmSelectionView,
  SessionLlmProviderOptionsView,
} from './app-shell-types.js';

export const DEFAULT_REASONING_PRESET: ReasoningPreset = 'off';
export const DEFAULT_SYNTHETIC_SELECTION_UPDATED_AT = '1970-01-01T00:00:00.000Z';

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

export function createNextSessionLlmSelectionUpdatedAt(previousUpdatedAt?: string | null): string {
  const previousMs = Date.parse(normalizeSelectionUpdatedAt(previousUpdatedAt, DEFAULT_SYNTHETIC_SELECTION_UPDATED_AT));
  const nowMs = Date.now();
  const nextMs = Number.isFinite(previousMs) ? Math.max(nowMs, previousMs + 1) : nowMs;
  return new Date(nextMs).toISOString();
}

function normalizeReasoningPreset(value: unknown): ReasoningPreset {
  return value === 'low' || value === 'medium' || value === 'high' ? value : DEFAULT_REASONING_PRESET;
}

function normalizeProviderOptionsForProvider(
  provider: PublicLlmProfile['provider'],
  providerOptions?: SessionLlmProviderOptionsView
): SessionLlmProviderOptionsView | undefined {
  if (!providerOptions) {
    return undefined;
  }

  if (provider === 'openai') {
    const effort = providerOptions.openai?.reasoningEffort;
    if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === null) {
      return {
        openai: {
          reasoningEffort: effort,
        },
      };
    }
    return undefined;
  }

  const budget = providerOptions.anthropic?.thinkingBudgetTokens;
  if (typeof budget === 'number' || budget === null) {
    return {
      anthropic: {
        thinkingBudgetTokens: budget,
      },
    };
  }
  return undefined;
}

export function resolveDefaultLlmProfile(llmProfiles: LlmProfilesConfigView | null | undefined): PublicLlmProfile | null {
  if (!llmProfiles || llmProfiles.profiles.length === 0) {
    return null;
  }
  return (
    llmProfiles.profiles.find((profile) => profile.id === llmProfiles.defaultProfileId) ??
    llmProfiles.profiles[0] ??
    null
  );
}

export function resolveLlmProfileById(
  llmProfiles: LlmProfilesConfigView | null | undefined,
  profileId: string | undefined
): PublicLlmProfile | null {
  const trimmedId = String(profileId ?? '').trim();
  if (!trimmedId || !llmProfiles) {
    return resolveDefaultLlmProfile(llmProfiles);
  }
  return llmProfiles.profiles.find((profile) => profile.id === trimmedId) ?? resolveDefaultLlmProfile(llmProfiles);
}

export function resolveSessionLlmSelectionView(
  llmProfiles: LlmProfilesConfigView | null | undefined,
  selection?: SessionLlmSelectionView | SessionLlmSelectionPatch | null
): SessionLlmSelectionView {
  const defaultProfile =
    resolveDefaultLlmProfile(llmProfiles) ??
    ({
      id: 'legacy-default',
      name: 'Default Profile',
      provider: 'anthropic',
      apiBase: '',
      defaultModel: '',
      hasApiKey: false,
    } satisfies PublicLlmProfile);
  const resolvedProfile = resolveLlmProfileById(llmProfiles, selection?.profileId) ?? defaultProfile;
  const model = String(selection?.model ?? '').trim() || resolvedProfile.defaultModel;

  return {
    profileId: resolvedProfile.id,
    model,
    reasoningPreset: normalizeReasoningPreset(selection?.reasoningPreset),
    providerOptions: normalizeProviderOptionsForProvider(resolvedProfile.provider, selection?.providerOptions),
    updatedAt: normalizeSelectionUpdatedAt(
      (selection as SessionLlmSelectionView | SessionLlmSelectionPatch | undefined)?.updatedAt,
      resolvedProfile.updatedAt ?? DEFAULT_SYNTHETIC_SELECTION_UPDATED_AT
    ),
  };
}

export function applySessionLlmSelectionPatch(
  llmProfiles: LlmProfilesConfigView | null | undefined,
  currentSelection?: SessionLlmSelectionView | null,
  patch?: SessionLlmSelectionPatch | null
): SessionLlmSelectionView {
  const current = resolveSessionLlmSelectionView(llmProfiles, currentSelection);
  if (!patch) {
    return current;
  }

  const nextProfileId =
    typeof patch.profileId === 'string' && patch.profileId.trim().length > 0
      ? patch.profileId.trim()
      : current.profileId;
  const profileChanged = nextProfileId !== current.profileId;

  return resolveSessionLlmSelectionView(llmProfiles, {
    profileId: nextProfileId,
    model:
      patch.model !== undefined
        ? patch.model
        : profileChanged
          ? ''
          : current.model,
    reasoningPreset:
      patch.reasoningPreset !== undefined
        ? patch.reasoningPreset
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
