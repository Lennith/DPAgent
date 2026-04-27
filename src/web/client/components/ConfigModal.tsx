import React, { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTheme, useThemeConfig } from './providers/ThemeProvider.js';
import { useI18n } from '../i18n/index.js';
import type {
  LlmProfileIntrospectionView,
  LlmProfilesConfigView,
  PublicLlmProfile,
} from '../app-shell-types.js';

// ConfigModal owns the settings shell, provider profile editor, capability paths, and governance tab.
// Major edit points: profile draft state, auto model discovery, responsive modal chrome, and tab bodies.
interface ConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  llmProfiles?: LlmProfilesConfigView | null;
  onSaved?: () => void | Promise<void>;
  governanceSlot?: ReactNode;
}

interface SettingsResponse {
  llmProfiles?: LlmProfilesConfigView;
  api?: {
    hasApiKey?: boolean;
  };
  agent?: {
    skillsDir?: string;
    globalAgentsDir?: string;
    completionMarkerEnforcementEnabled?: boolean;
    maxSteps?: number;
  };
}

interface SaveLlmProfilesResponse extends LlmProfilesConfigView {
  success?: boolean;
}

interface EditableProfile extends Omit<PublicLlmProfile, 'hasApiKey'> {
  hasApiKey: boolean;
  apiKeyInput: string;
  clearApiKey: boolean;
}

type SettingsLoadState = 'idle' | 'loading' | 'ready' | 'error';
type ModelDiscoveryStatus = 'idle' | 'waiting' | 'loading' | 'success' | 'error';

const LOAD_SETTINGS_ERROR = '__config_load_failed__';
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

function createEditableProfiles(llmProfiles: LlmProfilesConfigView | null | undefined): EditableProfile[] {
  return (llmProfiles?.profiles ?? []).map((profile) => ({
    ...profile,
    apiKeyInput: '',
    clearApiKey: false,
  }));
}

function createEmptyProfile(index: number): EditableProfile {
  const id = `profile-${index + 1}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: `Profile ${index + 1}`,
    provider: 'anthropic',
    apiBase: 'https://api.minimaxi.com',
    defaultModel: 'MiniMax-M2.7',
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    enabled: true,
    capabilities: {
      modelDiscovery: true,
      reasoningEffort: false,
      thinkingBudget: true,
    },
    hasApiKey: false,
    apiKeyInput: '',
    clearApiKey: false,
  };
}

export function ConfigModal({
  isOpen,
  onClose,
  llmProfiles = null,
  onSaved,
  governanceSlot,
}: ConfigModalProps) {
  const { theme: activeTheme, setTheme } = useTheme();
  const theme = useThemeConfig();
  const { locale, setLocale, t } = useI18n();
  const [profiles, setProfiles] = useState<EditableProfile[]>(() =>
    createEditableProfiles(llmProfiles)
  );
  const [selectedProfileId, setSelectedProfileId] = useState(
    llmProfiles?.profiles[0]?.id ?? ''
  );
  const [defaultProfileId, setDefaultProfileId] = useState(
    llmProfiles?.defaultProfileId ?? llmProfiles?.profiles[0]?.id ?? ''
  );
  const [skillsDir, setSkillsDir] = useState('');
  const [initialSkillsDir, setInitialSkillsDir] = useState('');
  const [globalAgentsDir, setGlobalAgentsDir] = useState('');
  const [initialGlobalAgentsDir, setInitialGlobalAgentsDir] = useState('');
  const [completionMarkerEnforcementEnabled, setCompletionMarkerEnforcementEnabled] =
    useState(false);
  const [
    initialCompletionMarkerEnforcementEnabled,
    setInitialCompletionMarkerEnforcementEnabled,
  ] = useState(false);
  const [maxSteps, setMaxSteps] = useState(100);
  const [initialMaxSteps, setInitialMaxSteps] = useState(100);
  const [activeTab, setActiveTab] = useState<'providers' | 'skills' | 'governance' | 'other'>('providers');
  const [settingsLoadState, setSettingsLoadState] = useState<SettingsLoadState>('idle');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelDiscoveryStatusByProfile, setModelDiscoveryStatusByProfile] = useState<
    Record<string, ModelDiscoveryStatus>
  >({});
  const [advancedOpenByProfile, setAdvancedOpenByProfile] = useState<Record<string, boolean>>({});
  const [introspectionByProfile, setIntrospectionByProfile] = useState<
    Record<string, LlmProfileIntrospectionView>
  >({});

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0] ?? null,
    [profiles, selectedProfileId]
  );
  const selectedIntrospection = selectedProfile
    ? introspectionByProfile[selectedProfile.id]
    : undefined;
  const selectedModelOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const model of selectedIntrospection?.models ?? []) {
      options.set(model.id, model.displayName || model.id);
    }
    if (selectedProfile?.defaultModel) {
      options.set(selectedProfile.defaultModel, selectedProfile.defaultModel);
    }
    return [...options.entries()];
  }, [selectedIntrospection?.models, selectedProfile?.defaultModel]);
  const selectedDiscoveryStatus = selectedProfile
    ? modelDiscoveryStatusByProfile[selectedProfile.id] ?? 'idle'
    : 'idle';
  const selectedAdvancedOpen = selectedProfile
    ? advancedOpenByProfile[selectedProfile.id] === true
    : false;

  useEffect(() => {
    if (!isOpen) {
      setSettingsLoadState('idle');
      setError(null);
      return;
    }

    let canceled = false;
    setSettingsLoadState('loading');
    setError(null);

    const applyPersistedProfiles = (
      nextConfig: LlmProfilesConfigView | null | undefined
    ): void => {
      const normalized = nextConfig ?? null;
      const nextProfiles = createEditableProfiles(normalized);
      setProfiles(nextProfiles);
      setDefaultProfileId(normalized?.defaultProfileId ?? nextProfiles[0]?.id ?? '');
      setSelectedProfileId((current) => {
        if (nextProfiles.some((profile) => profile.id === current)) {
          return current;
        }
        return nextProfiles[0]?.id ?? '';
      });
      setIntrospectionByProfile((prev) =>
        Object.fromEntries(
          Object.entries(prev).filter(([profileId]) =>
            nextProfiles.some((profile) => profile.id === profileId)
          )
        )
      );
    };

    applyPersistedProfiles(llmProfiles);

    void fetch('/api/settings')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load settings: ${response.status}`);
        }
        return response.json() as Promise<SettingsResponse>;
      })
      .then((settings) => {
        if (canceled) {
          return;
        }
        applyPersistedProfiles(settings.llmProfiles ?? llmProfiles);
        const nextSkillsDir = String(settings.agent?.skillsDir ?? '');
        const nextGlobalAgentsDir = String(settings.agent?.globalAgentsDir ?? '');
        const nextCompletionMarkerEnforcementEnabled =
          settings.agent?.completionMarkerEnforcementEnabled === true;
        const nextMaxSteps =
          typeof settings.agent?.maxSteps === 'number' && Number.isFinite(settings.agent.maxSteps)
            ? Math.max(1, Math.floor(settings.agent.maxSteps))
            : 100;
        setSkillsDir(nextSkillsDir);
        setInitialSkillsDir(nextSkillsDir);
        setGlobalAgentsDir(nextGlobalAgentsDir);
        setInitialGlobalAgentsDir(nextGlobalAgentsDir);
        setCompletionMarkerEnforcementEnabled(nextCompletionMarkerEnforcementEnabled);
        setInitialCompletionMarkerEnforcementEnabled(nextCompletionMarkerEnforcementEnabled);
        setMaxSteps(nextMaxSteps);
        setInitialMaxSteps(nextMaxSteps);
        setSettingsLoadState('ready');
      })
      .catch((fetchError) => {
        if (canceled) {
          return;
        }
        console.error(fetchError);
        setSettingsLoadState('error');
        setError(LOAD_SETTINGS_ERROR);
      });

    return () => {
      canceled = true;
    };
  }, [isOpen, llmProfiles]);

  const handleProfileChange = (patch: Partial<EditableProfile>): void => {
    if (!selectedProfile) {
      return;
    }
    const affectsDiscovery =
      patch.provider !== undefined ||
      patch.apiBase !== undefined ||
      patch.apiKeyInput !== undefined ||
      patch.clearApiKey !== undefined;
    setProfiles((prev) =>
      prev.map((profile) =>
        profile.id === selectedProfile.id
          ? {
              ...profile,
              ...patch,
            }
          : profile
      )
    );
    if (affectsDiscovery) {
      setModelDiscoveryStatusByProfile((prev) => ({
        ...prev,
        [selectedProfile.id]: 'waiting',
      }));
    }
  };

  const handleAddProfile = (): void => {
    setProfiles((prev) => {
      const nextProfile = createEmptyProfile(prev.length);
      const next = [...prev, nextProfile];
      setSelectedProfileId(nextProfile.id);
      if (!defaultProfileId) {
        setDefaultProfileId(nextProfile.id);
      }
      return next;
    });
  };

  const handleRemoveProfile = (): void => {
    if (!selectedProfile || profiles.length <= 1) {
      return;
    }
    const nextProfiles = profiles.filter((profile) => profile.id !== selectedProfile.id);
    setProfiles(nextProfiles);
    if (defaultProfileId === selectedProfile.id) {
      setDefaultProfileId(nextProfiles[0]?.id ?? '');
    }
    setSelectedProfileId(nextProfiles[0]?.id ?? '');
  };

  const settingsControlsDisabled = settingsLoadState !== 'ready' || saving;

  const handleDiscoverModels = async (profileArg?: EditableProfile): Promise<void> => {
    const profile = profileArg ?? selectedProfile;
    if (!profile || settingsControlsDisabled) {
      return;
    }
    setModelDiscoveryStatusByProfile((prev) => ({
      ...prev,
      [profile.id]: 'loading',
    }));
    try {
      const response = await fetch(`/api/llm-profiles/${profile.id}/discover-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: {
            id: profile.id,
            name: profile.name,
            provider: profile.provider,
            apiBase: profile.apiBase,
            defaultModel: profile.defaultModel,
            maxOutputTokens: profile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            enabled: profile.enabled,
            capabilities: {
              ...(profile.capabilities ?? {}),
              modelDiscovery: true,
            },
            ...(profile.apiKeyInput.trim().length > 0
              ? { apiKey: profile.apiKeyInput.trim() }
              : {}),
          },
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `status=${response.status}`);
      }
      const payload = (await response.json()) as LlmProfileIntrospectionView;
      setIntrospectionByProfile((prev) => ({
        ...prev,
        [profile.id]: payload,
      }));
      setModelDiscoveryStatusByProfile((prev) => ({
        ...prev,
        [profile.id]: payload.models.length > 0 ? 'success' : 'error',
      }));
    } catch (discoverError) {
      setIntrospectionByProfile((prev) => ({
        ...prev,
        [profile.id]: {
          profileId: profile.id,
          source: 'manual',
          fetchedAt: new Date().toISOString(),
          models: [],
          manualModelEntryAllowed: true,
          capabilities: {
            modelDiscovery: Boolean(profile.capabilities?.modelDiscovery),
            reasoningEffort: Boolean(profile.capabilities?.reasoningEffort),
            thinkingBudget: Boolean(profile.capabilities?.thinkingBudget),
          },
          error:
            discoverError instanceof Error ? discoverError.message : String(discoverError),
        },
      }));
      setModelDiscoveryStatusByProfile((prev) => ({
        ...prev,
        [profile.id]: 'error',
      }));
    }
  };

  useEffect(() => {
    if (!isOpen || settingsControlsDisabled || !selectedProfile) {
      return;
    }

    const hasDiscoveryCredentials =
      selectedProfile.apiBase.trim().length > 0 &&
      !selectedProfile.clearApiKey &&
      (selectedProfile.apiKeyInput.trim().length > 0 || selectedProfile.hasApiKey);
    if (!hasDiscoveryCredentials) {
      return;
    }

    const status = modelDiscoveryStatusByProfile[selectedProfile.id] ?? 'idle';
    if (status === 'loading' || status === 'success' || status === 'error') {
      return;
    }

    const profileSnapshot = { ...selectedProfile };
    const timer = window.setTimeout(() => {
      void handleDiscoverModels(profileSnapshot);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [
    isOpen,
    settingsControlsDisabled,
    selectedProfile?.id,
    selectedProfile?.provider,
    selectedProfile?.apiBase,
    selectedProfile?.apiKeyInput,
    selectedProfile?.clearApiKey,
    selectedProfile?.hasApiKey,
    modelDiscoveryStatusByProfile,
  ]);

  const handleSave = async (): Promise<void> => {
    if (settingsLoadState !== 'ready' || saving) {
      return;
    }

    setSaving(true);
    setError(null);
    let profilesSaved = false;
    let agentSettingsSaveAttempted = false;
    let agentSettingsSaved = false;

    try {
      if (profiles.length === 0) {
        throw new Error(t('config.providerCenter.errorMissingProfiles'));
      }

      const profileResponse = await fetch('/api/llm-profiles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultProfileId: defaultProfileId || profiles[0].id,
          profiles: profiles.map((profile) => ({
            id: profile.id,
            name: profile.name,
            provider: profile.provider,
            apiBase: profile.apiBase,
            defaultModel: profile.defaultModel,
            maxOutputTokens: profile.maxOutputTokens,
            enabled: profile.enabled,
            capabilities: {
              ...(profile.capabilities ?? {}),
              modelDiscovery: true,
            },
            ...(profile.apiKeyInput.trim().length > 0
              ? { apiKey: profile.apiKeyInput.trim() }
              : {}),
            ...(profile.clearApiKey ? { clearApiKey: true } : {}),
          })),
        }),
      });

      if (!profileResponse.ok) {
        const payload = (await profileResponse.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error || t('config.error.saveApi'));
      }

      const savedProfiles = (await profileResponse.json()) as SaveLlmProfilesResponse;
      const nextPersistedProfiles: LlmProfilesConfigView = {
        defaultProfileId: savedProfiles.defaultProfileId,
        profiles: savedProfiles.profiles,
      };
      const nextEditableProfiles = createEditableProfiles(nextPersistedProfiles);
      setProfiles(nextEditableProfiles);
      setDefaultProfileId(
        nextPersistedProfiles.defaultProfileId ?? nextEditableProfiles[0]?.id ?? ''
      );
      setSelectedProfileId((current) => {
        if (nextEditableProfiles.some((profile) => profile.id === current)) {
          return current;
        }
        return nextEditableProfiles[0]?.id ?? '';
      });
      setIntrospectionByProfile((prev) =>
        Object.fromEntries(
          Object.entries(prev).filter(([profileId]) =>
            nextEditableProfiles.some((profile) => profile.id === profileId)
          )
        )
      );
      profilesSaved = true;

      const agentSettingsChanged =
        skillsDir !== initialSkillsDir ||
        globalAgentsDir !== initialGlobalAgentsDir ||
        completionMarkerEnforcementEnabled !== initialCompletionMarkerEnforcementEnabled ||
        maxSteps !== initialMaxSteps;
      if (agentSettingsChanged) {
        agentSettingsSaveAttempted = true;
        const agentResponse = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            skillsDir,
            globalAgentsDir,
            completionMarkerEnforcementEnabled,
            maxSteps,
          }),
        });
        if (!agentResponse.ok) {
          throw new Error(t('config.error.saveAgent'));
        }
        agentSettingsSaved = true;
        setInitialSkillsDir(skillsDir);
        setInitialGlobalAgentsDir(globalAgentsDir);
        setInitialCompletionMarkerEnforcementEnabled(completionMarkerEnforcementEnabled);
        setInitialMaxSteps(maxSteps);
      }

      await onSaved?.();
      onClose();
    } catch (saveError) {
      if (profilesSaved && agentSettingsSaveAttempted && !agentSettingsSaved) {
        try {
          await onSaved?.();
        } catch (refreshError) {
          console.error(refreshError);
        }
        const message =
          saveError instanceof Error ? saveError.message : t('config.error.unknown');
        setError(t('config.providerCenter.partialSaveAgent', { message }));
      } else {
        setError(saveError instanceof Error ? saveError.message : t('config.error.unknown'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  const resolvedError =
    error === LOAD_SETTINGS_ERROR ? t('config.error.loadSettings') : error;
  const showLoadingHint =
    settingsLoadState === 'idle' || settingsLoadState === 'loading';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-3">
      <div
        data-testid="config-modal-shell"
        className="config-modal-shell flex max-w-full flex-col overflow-hidden rounded-2xl border"
        style={{
          backgroundColor: theme.colors.bg.secondary,
          borderColor: theme.colors.border.DEFAULT,
        }}
      >
        <div
          className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-4 border-b px-3 py-2.5"
          style={{
            borderColor: theme.colors.border.DEFAULT,
            backgroundColor: theme.colors.bg.secondary,
          }}
        >
          <h2 className="text-lg font-bold" style={{ color: theme.colors.text.primary }}>
            {t('config.settingsTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            data-testid="config-close"
            className="rounded-xl border px-3 py-1.5 text-sm transition-colors"
            style={{
              borderColor: theme.colors.border.DEFAULT,
              backgroundColor: theme.colors.bg.tertiary,
              color: theme.colors.text.secondary,
            }}
          >
            {t('common.close')}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <div className="mb-3 flex gap-1 rounded-lg p-1" style={{ backgroundColor: theme.colors.bg.tertiary }}>
          <button
            type="button"
            data-testid="config-tab-providers"
            onClick={() => setActiveTab('providers')}
            className="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all"
            style={{
              backgroundColor:
                activeTab === 'providers' ? theme.colors.bg.secondary : 'transparent',
              color:
                activeTab === 'providers'
                  ? theme.colors.text.primary
                  : theme.colors.text.secondary,
            }}
          >
            {t('config.providerCenter.tabProviders')}
          </button>
          <button
            type="button"
            data-testid="config-tab-skills"
            onClick={() => setActiveTab('skills')}
            className="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all"
            style={{
              backgroundColor:
                activeTab === 'skills' ? theme.colors.bg.secondary : 'transparent',
              color:
                activeTab === 'skills'
                  ? theme.colors.text.primary
                  : theme.colors.text.secondary,
            }}
          >
            {t('config.tab.skills')}
          </button>
          <button
            type="button"
            data-testid="config-tab-governance"
            onClick={() => setActiveTab('governance')}
            className="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all"
            style={{
              backgroundColor:
                activeTab === 'governance' ? theme.colors.bg.secondary : 'transparent',
              color:
                activeTab === 'governance'
                  ? theme.colors.text.primary
                  : theme.colors.text.secondary,
            }}
          >
            {t('config.tab.governance')}
          </button>
          <button
            type="button"
            data-testid="config-tab-other"
            onClick={() => setActiveTab('other')}
            className="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all"
            style={{
              backgroundColor:
                activeTab === 'other' ? theme.colors.bg.secondary : 'transparent',
              color:
                activeTab === 'other'
                  ? theme.colors.text.primary
                  : theme.colors.text.secondary,
            }}
          >
            {t('config.tab.other')}
          </button>
        </div>

        {showLoadingHint && (
          <div
            data-testid="config-settings-loading"
            className="mb-4 rounded-lg border px-3 py-2 text-sm"
            style={{
              borderColor: theme.colors.border.DEFAULT,
              backgroundColor: theme.colors.bg.tertiary,
              color: theme.colors.text.secondary,
            }}
          >
            {t('config.loadingSettings')}
          </div>
        )}

        {activeTab === 'providers' ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
            <div
              className="rounded-2xl border p-3"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.primary,
              }}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-medium" style={{ color: theme.colors.text.primary }}>
                  {t('config.providerCenter.profiles')}
                </div>
                <button
                  type="button"
                  onClick={handleAddProfile}
                  disabled={settingsControlsDisabled}
                  className="rounded-lg border px-2.5 py-1.5 text-xs transition-colors"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    backgroundColor: theme.colors.bg.tertiary,
                    color: theme.colors.text.secondary,
                    opacity: settingsControlsDisabled ? 0.6 : 1,
                  }}
                >
                  {t('config.providerCenter.addProfile')}
                </button>
              </div>

              <div className="space-y-2">
                {profiles.map((profile) => {
                  const active = profile.id === selectedProfile?.id;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => setSelectedProfileId(profile.id)}
                      data-testid="config-provider-profile-row"
                      className="flex w-full min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors"
                      style={{
                        borderColor: active
                          ? theme.colors.primary.DEFAULT
                          : theme.colors.border.DEFAULT,
                        backgroundColor: active
                          ? theme.colors.bg.secondary
                          : theme.colors.bg.tertiary,
                      }}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className="shrink-0 text-sm font-medium"
                          style={{ color: theme.colors.text.primary }}
                        >
                          {profile.name}
                        </span>
                        <span className="shrink-0 text-xs" style={{ color: theme.colors.text.muted }}>
                          {profile.provider === 'openai'
                            ? t('config.provider.openai')
                            : t('config.provider.anthropic')}
                        </span>
                        <span className="min-w-0 truncate text-xs" style={{ color: theme.colors.text.muted }}>
                          {profile.defaultModel}
                        </span>
                      </div>
                      {defaultProfileId === profile.id && (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: theme.colors.primary.DEFAULT,
                            color: theme.colors.text.inverse,
                          }}
                        >
                          {t('config.providerCenter.defaultProfile')}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              className="rounded-2xl border p-3"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.primary,
              }}
            >
              {selectedProfile ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div
                        className="text-lg font-semibold"
                        style={{ color: theme.colors.text.primary }}
                      >
                        {selectedProfile.name}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <label
                        className="flex items-center gap-2 text-sm"
                        style={{ color: theme.colors.text.secondary }}
                      >
                        <input
                          type="radio"
                          checked={defaultProfileId === selectedProfile.id}
                          onChange={() => setDefaultProfileId(selectedProfile.id)}
                          disabled={settingsControlsDisabled}
                        />
                        {t('config.providerCenter.useAsDefault')}
                      </label>
                      <button
                        type="button"
                        onClick={handleRemoveProfile}
                        disabled={profiles.length <= 1 || settingsControlsDisabled}
                        className="rounded-lg border px-3 py-2 text-sm transition-colors"
                        style={{
                          borderColor: theme.colors.border.DEFAULT,
                          backgroundColor: theme.colors.bg.tertiary,
                          color: theme.colors.text.secondary,
                          opacity:
                            profiles.length <= 1 || settingsControlsDisabled ? 0.45 : 1,
                        }}
                      >
                        {t('config.providerCenter.removeProfile')}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
                        {t('config.providerCenter.profileName')}
                      </label>
                      <input
                        value={selectedProfile.name}
                        onChange={(event) =>
                          handleProfileChange({ name: event.target.value })
                        }
                        disabled={settingsControlsDisabled}
                        className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                        style={{
                          backgroundColor: theme.colors.bg.tertiary,
                          borderColor: theme.colors.border.DEFAULT,
                          color: theme.colors.text.primary,
                        }}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
                        {t('config.provider')}
                      </label>
                      <select
                        value={selectedProfile.provider}
                        onChange={(event) =>
                          handleProfileChange({
                            provider:
                              event.target.value === 'openai' ? 'openai' : 'anthropic',
                          })
                        }
                        disabled={settingsControlsDisabled}
                        className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                        style={{
                          backgroundColor: theme.colors.bg.tertiary,
                          borderColor: theme.colors.border.DEFAULT,
                          color: theme.colors.text.primary,
                        }}
                      >
                        <option value="anthropic">{t('config.provider.anthropic')}</option>
                        <option value="openai">{t('config.provider.openai')}</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
                        {t('config.apiBase')}
                      </label>
                      <input
                        value={selectedProfile.apiBase}
                        onChange={(event) =>
                          handleProfileChange({ apiBase: event.target.value })
                        }
                        disabled={settingsControlsDisabled}
                        className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                        style={{
                          backgroundColor: theme.colors.bg.tertiary,
                          borderColor: theme.colors.border.DEFAULT,
                          color: theme.colors.text.primary,
                        }}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
                        {t('config.model')}
                      </label>
                      <input
                        list="config-model-options"
                        value={selectedProfile.defaultModel}
                        onChange={(event) =>
                          handleProfileChange({ defaultModel: event.target.value })
                        }
                        disabled={settingsControlsDisabled}
                        className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                        style={{
                          backgroundColor: theme.colors.bg.tertiary,
                          borderColor: theme.colors.border.DEFAULT,
                          color: theme.colors.text.primary,
                        }}
                      />
                      <datalist id="config-model-options">
                        {selectedModelOptions.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </datalist>
                      <div className="mt-1 truncate text-xs" style={{ color: theme.colors.text.muted }}>
                        {selectedDiscoveryStatus === 'loading'
                          ? t('config.providerCenter.discovering')
                          : selectedIntrospection?.models.length
                            ? t('config.providerCenter.discoverySummary', {
                                source: selectedIntrospection.source,
                                count: selectedIntrospection.models.length,
                              })
                            : selectedIntrospection?.error
                              ? t('config.providerCenter.discoveryFailed')
                              : t('config.providerCenter.discoveryAutoHint')}
                      </div>
                    </div>
                    <div>
                      <label
                        className="mb-1 flex items-center gap-2 text-sm"
                        style={{ color: theme.colors.text.secondary }}
                      >
                        {t('config.apiKey.label')}
                        {selectedProfile.hasApiKey && !selectedProfile.clearApiKey && (
                          <span className="rounded-full bg-green-500 px-2 py-0.5 text-xs text-white">
                            {t('config.apiKey.configured')}
                          </span>
                        )}
                      </label>
                      <input
                        type="password"
                        value={selectedProfile.apiKeyInput}
                        onChange={(event) =>
                          handleProfileChange({
                            apiKeyInput: event.target.value,
                            clearApiKey: false,
                          })
                        }
                        placeholder={
                          selectedProfile.hasApiKey && !selectedProfile.clearApiKey
                            ? t('config.apiKey.placeholderConfigured')
                            : t('config.apiKey.placeholderGeneric')
                        }
                        disabled={settingsControlsDisabled}
                        className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                        style={{
                          backgroundColor: theme.colors.bg.tertiary,
                          borderColor: theme.colors.border.DEFAULT,
                          color: theme.colors.text.primary,
                        }}
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            handleProfileChange({
                              apiKeyInput: '',
                              clearApiKey: true,
                              hasApiKey: false,
                            })
                          }
                          disabled={settingsControlsDisabled}
                          className="rounded-lg border px-2.5 py-1.5 text-xs transition-colors"
                          style={{
                            borderColor: theme.colors.border.DEFAULT,
                            backgroundColor: theme.colors.bg.tertiary,
                            color: theme.colors.text.secondary,
                            opacity: settingsControlsDisabled ? 0.6 : 1,
                          }}
                        >
                          {t('config.providerCenter.clearStoredKey')}
                        </button>
                      </div>
                    </div>
                  </div>

                  <details
                    data-testid="config-provider-advanced"
                    open={selectedAdvancedOpen}
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setAdvancedOpenByProfile((prev) => ({
                        ...prev,
                        [selectedProfile.id]: open,
                      }));
                    }}
                    className="rounded-2xl border p-3"
                    style={{
                      borderColor: theme.colors.border.DEFAULT,
                      backgroundColor: theme.colors.bg.secondary,
                    }}
                  >
                    <summary
                      className="cursor-pointer text-sm font-medium"
                      style={{ color: theme.colors.text.secondary }}
                    >
                      {t('config.providerCenter.advancedParameters')}
                    </summary>
                    <div className="mt-3 max-w-md">
                      <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
                        {t('config.providerCenter.outputLimit')}
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={selectedProfile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS}
                        onChange={(event) =>
                          handleProfileChange({
                            maxOutputTokens:
                              Number.parseInt(event.target.value, 10) || DEFAULT_MAX_OUTPUT_TOKENS,
                          })
                        }
                        disabled={settingsControlsDisabled}
                        className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                        style={{
                          backgroundColor: theme.colors.bg.tertiary,
                          borderColor: theme.colors.border.DEFAULT,
                          color: theme.colors.text.primary,
                        }}
                      />
                      <p className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
                        {t('config.providerCenter.outputLimitHint')}
                      </p>
                    </div>
                  </details>
                </div>
              ) : (
                <div className="text-sm" style={{ color: theme.colors.text.muted }}>
                  {t('config.providerCenter.errorMissingProfiles')}
                </div>
              )}
            </div>
          </div>
        ) : activeTab === 'skills' ? (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
                {t('config.skillsDir')}
              </label>
              <input
                type="text"
                value={skillsDir}
                onChange={(event) => setSkillsDir(event.target.value)}
                placeholder={t('config.skillsDir.placeholder')}
                disabled={settingsControlsDisabled}
                className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                style={{
                  backgroundColor: theme.colors.bg.tertiary,
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.primary,
                }}
              />
              <p className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
                {t('config.skillsDir.hint')}
              </p>
            </div>

            <div>
              <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
                {t('config.globalAgentsDir')}
              </label>
              <input
                type="text"
                value={globalAgentsDir}
                onChange={(event) => setGlobalAgentsDir(event.target.value)}
                placeholder={t('config.globalAgentsDir.placeholder')}
                disabled={settingsControlsDisabled}
                className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                style={{
                  backgroundColor: theme.colors.bg.tertiary,
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.primary,
                }}
              />
              <p className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
                {t('config.globalAgentsDir.hint')}
              </p>
            </div>

            <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: theme.colors.bg.tertiary }}>
              <p style={{ color: theme.colors.text.secondary }}>{t('config.tips.title')}</p>
              <ul className="mt-1 space-y-1" style={{ color: theme.colors.text.muted }}>
                <li className="list-inside list-disc">{t('config.tips.item1')}</li>
                <li className="list-inside list-disc">{t('config.tips.item2')}</li>
                <li className="list-inside list-disc">{t('config.tips.item3')}</li>
                <li className="list-inside list-disc">{t('config.tips.item4')}</li>
              </ul>
            </div>
          </div>
        ) : activeTab === 'governance' ? (
          <div className="space-y-4">
            {governanceSlot ?? (
              <div
                className="rounded-2xl border p-4 text-sm"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  backgroundColor: theme.colors.bg.secondary,
                  color: theme.colors.text.muted,
                }}
              >
                Governance controls are available after a session is selected.
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
                  {t('common.language')}
                </label>
                <select
                  value={locale}
                  onChange={(event) =>
                    setLocale(event.target.value === 'en-US' ? 'en-US' : 'zh-CN')
                  }
                  className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                  style={{
                    backgroundColor: theme.colors.bg.tertiary,
                    borderColor: theme.colors.border.DEFAULT,
                    color: theme.colors.text.primary,
                  }}
                >
                  <option value="zh-CN">{t('common.language.zhCN')}</option>
                  <option value="en-US">{t('common.language.enUS')}</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
                  {t('common.theme')}
                </label>
                <select
                  value={activeTheme}
                  onChange={(event) => setTheme(event.target.value === 'light' ? 'light' : 'dark')}
                  className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                  style={{
                    backgroundColor: theme.colors.bg.tertiary,
                    borderColor: theme.colors.border.DEFAULT,
                    color: theme.colors.text.primary,
                  }}
                >
                  <option value="dark">{t('common.theme.dark')}</option>
                  <option value="light">{t('common.theme.light')}</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
                  {t('config.maxSteps.label')}
                </label>
                <input
                  type="number"
                  min={1}
                  value={maxSteps}
                  onChange={(event) => setMaxSteps(Math.max(1, Number.parseInt(event.target.value, 10) || 100))}
                  disabled={settingsControlsDisabled}
                  className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2"
                  style={{
                    backgroundColor: theme.colors.bg.tertiary,
                    borderColor: theme.colors.border.DEFAULT,
                    color: theme.colors.text.primary,
                  }}
                />
              </div>
            </div>
            <label
              className="flex items-start gap-3 rounded-xl border p-4"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.primary,
              }}
            >
              <input
                type="checkbox"
                data-testid="config-completion-marker-toggle"
                checked={completionMarkerEnforcementEnabled}
                onChange={(event) => setCompletionMarkerEnforcementEnabled(event.target.checked)}
                disabled={settingsControlsDisabled}
                className="mt-1 h-4 w-4 rounded border"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium" style={{ color: theme.colors.text.primary }}>
                  {t('config.completionMarker.label')}
                </span>
                <span className="block text-xs" style={{ color: theme.colors.text.muted }}>
                  {t('config.completionMarker.description')}
                </span>
              </span>
            </label>
          </div>
        )}

        {resolvedError && (
          <div className="mt-4 rounded-lg bg-red-500/10 p-2 text-sm text-red-400">
            {resolvedError}
          </div>
        )}
        </div>

        <div
          className="sticky bottom-0 flex shrink-0 gap-2 border-t px-3 py-2.5"
          style={{
            borderColor: theme.colors.border.DEFAULT,
            backgroundColor: theme.colors.bg.secondary,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl px-4 py-2 font-medium transition-all"
            style={{
              backgroundColor: theme.colors.bg.tertiary,
              color: theme.colors.text.primary,
              opacity: saving ? 0.5 : 1,
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            data-testid="config-save-reload"
            onClick={() => void handleSave()}
            disabled={settingsControlsDisabled}
            className="flex-1 rounded-xl py-2 font-medium transition-all"
            style={{
              background: theme.colors.primary.gradient,
              color: theme.colors.text.inverse,
              opacity: settingsControlsDisabled ? 0.5 : 1,
            }}
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
