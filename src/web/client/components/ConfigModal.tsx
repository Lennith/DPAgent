import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useThemeConfig } from './providers/ThemeProvider.js';
import { useI18n, type TranslationKey } from '../i18n/index.js';
import type {
  LlmProfileIntrospectionView,
  LlmProfilesConfigView,
  PublicSettingsView,
  AgentListItemView,
  AgentProfileConfigView,
} from '../app-shell-types.js';
import {
  createDefaultSettingsDraft,
  createSettingsDraftFromResponse,
  buildAgentSettingsPayload,
  settingsDraftReducer,
  type SettingsDraft,
} from './config-modal-settings-draft.js';
import {
  buildAvailableModelOptions,
  createEditableProfiles,
  createEmptyProfile,
  normalizeAvailableModels,
  profileDraftToDiscoveryPayload,
  profileDraftToSavePayload,
  type EditableProfile,
  type EditableProfileUpdater,
} from './config-modal-profile-draft.js';
import {
  agentConfigDraftToPayload,
  createAgentConfigDraft,
  type AgentConfigDraft,
} from './config-modal-agent-draft.js';
import { ConfigModalProvidersTab } from './config-modal-providers-tab.js';
import { ConfigModalAgentsTab } from './config-modal-agents-tab.js';
import { ConfigModalSkillsTab } from './config-modal-skills-tab.js';
import { ConfigModalGovernanceTab } from './config-modal-governance-tab.js';
import { ConfigModalOtherTab } from './config-modal-other-tab.js';

// ConfigModal owns the settings shell, provider profile editor, capability paths, and governance tab.
// Major edit points: profile draft state, auto model discovery, responsive modal chrome, and tab bodies.
type ConfigModalTabId = 'providers' | 'skills' | 'agents' | 'governance' | 'other';

interface ConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  llmProfiles?: LlmProfilesConfigView | null;
  onSaved?: () => void | Promise<void>;
  governanceSlot?: ReactNode;
  initialSettings?: PublicSettingsView | null;
  initialActiveTab?: ConfigModalTabId;
  initialAgentItems?: AgentListItemView[];
}

interface SaveSettingsResponse extends PublicSettingsView {
  success?: boolean;
}

type SettingsLoadState = 'idle' | 'loading' | 'ready' | 'error';
type ModelDiscoveryStatus = 'idle' | 'waiting' | 'loading' | 'success' | 'error';

const LOAD_SETTINGS_ERROR = '__config_load_failed__';

const CONFIG_MODAL_TABS: ReadonlyArray<{
  id: ConfigModalTabId;
  testId: string;
  labelKey: TranslationKey;
}> = [
  { id: 'providers', testId: 'config-tab-providers', labelKey: 'config.providerCenter.tabProviders' },
  { id: 'skills', testId: 'config-tab-skills', labelKey: 'config.tab.skills' },
  { id: 'agents', testId: 'config-tab-agents', labelKey: 'config.tab.agents' },
  { id: 'governance', testId: 'config-tab-governance', labelKey: 'config.tab.governance' },
  { id: 'other', testId: 'config-tab-other', labelKey: 'config.tab.other' },
];

export function ConfigModal({
  isOpen,
  onClose,
  llmProfiles = null,
  onSaved,
  governanceSlot,
  initialSettings = null,
  initialActiveTab = 'providers',
  initialAgentItems = [],
}: ConfigModalProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const [profiles, setProfilesState] = useState<EditableProfile[]>(() =>
    createEditableProfiles(llmProfiles)
  );
  const profilesRef = useRef<EditableProfile[]>(profiles);
  const setProfiles = (updater: EditableProfileUpdater): void => {
    const nextProfiles =
      typeof updater === 'function' ? updater(profilesRef.current) : updater;
    profilesRef.current = nextProfiles;
    setProfilesState(nextProfiles);
  };
  const [selectedProfileId, setSelectedProfileId] = useState(
    llmProfiles?.profiles[0]?.id ?? ''
  );
  const [defaultProfileId, setDefaultProfileId] = useState(
    llmProfiles?.defaultProfileId ?? llmProfiles?.profiles[0]?.id ?? ''
  );
  const [settingsDraftState, dispatchSettingsDraft] = useReducer(
    settingsDraftReducer,
    initialSettings,
    (seedSettings) => {
      const nextDraft =
        seedSettings == null
          ? createDefaultSettingsDraft()
          : createSettingsDraftFromResponse(seedSettings);
      return {
        initial: nextDraft,
        draft: nextDraft,
      };
    }
  );
  const settingsDraft = settingsDraftState.draft;
  const {
    skillsDir,
    globalAgentsDir,
    completionMarkerEnforcementEnabled,
    maxSteps,
    authEnabled,
    authConfigured,
    authPassword,
    authSessionTtlMs,
    authTrustProxy,
    sessionShareTtlHours,
    ctxReplayMinRounds,
    ctxReplayMaxRounds,
    ctxReplayBudgetRatio,
    ctxWindowTokens,
    ctxPrecompressTriggerRatio,
    ctxPrecompressKeepLlmRounds,
    ctxPrecompressChunkTokens,
    ctxCompressionMaxTokens,
    workspaceTimelineEnabled,
  } = settingsDraft;
  const patchSettingsDraft = (patch: Partial<SettingsDraft>): void => {
    dispatchSettingsDraft({ type: 'patch', patch });
  };
  const setSkillsDir = (value: string): void => patchSettingsDraft({ skillsDir: value });
  const setGlobalAgentsDir = (value: string): void => patchSettingsDraft({ globalAgentsDir: value });
  const setCompletionMarkerEnforcementEnabled = (value: boolean): void =>
    patchSettingsDraft({ completionMarkerEnforcementEnabled: value });
  const setMaxSteps = (value: number): void => patchSettingsDraft({ maxSteps: value });
  const setAuthEnabled = (value: boolean): void => patchSettingsDraft({ authEnabled: value });
  const setAuthPassword = (value: string): void => patchSettingsDraft({ authPassword: value });
  const setAuthClearPassword = (value: boolean): void => patchSettingsDraft({ authClearPassword: value });
  const setAuthSessionTtlMs = (value: number): void => patchSettingsDraft({ authSessionTtlMs: value });
  const setAuthTrustProxy = (value: boolean): void => patchSettingsDraft({ authTrustProxy: value });
  const setSessionShareTtlHours = (value: number): void =>
    patchSettingsDraft({ sessionShareTtlHours: value });
  const setCtxReplayMinRounds = (value: number): void => patchSettingsDraft({ ctxReplayMinRounds: value });
  const setCtxReplayMaxRounds = (value: number): void => patchSettingsDraft({ ctxReplayMaxRounds: value });
  const setCtxReplayBudgetRatio = (value: number): void => patchSettingsDraft({ ctxReplayBudgetRatio: value });
  const setCtxWindowTokens = (value: number): void => patchSettingsDraft({ ctxWindowTokens: value });
  const setCtxPrecompressTriggerRatio = (value: number): void => patchSettingsDraft({ ctxPrecompressTriggerRatio: value });
  const setCtxPrecompressKeepLlmRounds = (value: number): void => patchSettingsDraft({ ctxPrecompressKeepLlmRounds: value });
  const setCtxPrecompressChunkTokens = (value: number): void =>
    patchSettingsDraft({ ctxPrecompressChunkTokens: value });
  const setCtxCompressionMaxTokens = (value: number): void =>
    patchSettingsDraft({ ctxCompressionMaxTokens: value });
  const setWorkspaceTimelineEnabled = (value: boolean): void =>
    patchSettingsDraft({ workspaceTimelineEnabled: value });
  const [activeTab, setActiveTab] = useState<'providers' | 'skills' | 'agents' | 'governance' | 'other'>(
    initialActiveTab
  );
  const [settingsLoadState, setSettingsLoadState] = useState<SettingsLoadState>(
    initialSettings == null ? 'idle' : 'ready'
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelDiscoveryStatusByProfile, setModelDiscoveryStatusByProfile] = useState<
    Record<string, ModelDiscoveryStatus>
  >({});
  const [advancedOpenByProfile, setAdvancedOpenByProfile] = useState<Record<string, boolean>>({});
  const [introspectionByProfile, setIntrospectionByProfile] = useState<
    Record<string, LlmProfileIntrospectionView>
  >({});
  const [agentItems, setAgentItems] = useState<AgentListItemView[]>(initialAgentItems);
  const [selectedAgentName, setSelectedAgentName] = useState(initialAgentItems[0]?.name ?? '');
  const [agentConfigDraft, setAgentConfigDraft] = useState<AgentConfigDraft>(() =>
    createAgentConfigDraft(initialAgentItems[0]?.config)
  );
  const [manualModelInputByProfile, setManualModelInputByProfile] = useState<Record<string, string>>({});
  const [agentModelOptionsOpen, setAgentModelOptionsOpen] = useState(false);
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);
  const [agentConfigSaving, setAgentConfigSaving] = useState(false);
  const [agentConfigError, setAgentConfigError] = useState<string | null>(null);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0] ?? null,
    [profiles, selectedProfileId]
  );
  const selectedIntrospection = selectedProfile
    ? introspectionByProfile[selectedProfile.id]
    : undefined;
  const selectedDiscoveryStatus = selectedProfile
    ? modelDiscoveryStatusByProfile[selectedProfile.id] ?? 'idle'
    : 'idle';
  const selectedAdvancedOpen = selectedProfile
    ? advancedOpenByProfile[selectedProfile.id] === true
    : false;
  const selectedAvailableModels = useMemo(
    () => normalizeAvailableModels(selectedProfile?.availableModels, selectedProfile?.defaultModel ?? ''),
    [selectedProfile?.availableModels, selectedProfile?.defaultModel]
  );
  const selectedDiscoveryCandidates = useMemo(() => {
    const existing = new Set(selectedAvailableModels);
    return (selectedIntrospection?.models ?? [])
      .map((model) => ({
        id: String(model.id ?? '').trim(),
        label: String(model.displayName || model.id || '').trim(),
      }))
      .filter((model) => model.id.length > 0)
      .map((model) => ({
        ...model,
        added: existing.has(model.id),
      }));
  }, [selectedAvailableModels, selectedIntrospection?.models]);
  const selectedManualModelInput = selectedProfile
    ? manualModelInputByProfile[selectedProfile.id] ?? ''
    : '';
  const selectedAgentItem = useMemo(
    () => agentItems.find((agent) => agent.name === selectedAgentName) ?? agentItems[0] ?? null,
    [agentItems, selectedAgentName]
  );
  const agentSelectedProfileId = agentConfigDraft.llmProfileId.trim() || defaultProfileId;
  const agentSelectedProfile = useMemo(
    () => profiles.find((item) => item.id === agentSelectedProfileId) ?? profiles[0] ?? null,
    [agentSelectedProfileId, profiles]
  );
  const agentModelOptions = useMemo(
    () =>
      buildAvailableModelOptions(
        agentSelectedProfile
      ),
    [agentSelectedProfile]
  );
  const agentModelPlaceholder = useMemo(() => {
    return agentSelectedProfile?.defaultModel
      ? `${t('config.agentConfig.model.inherit')}: ${agentSelectedProfile.defaultModel}`
      : t('config.agentConfig.inherit');
  }, [agentSelectedProfile?.defaultModel, t]);

  useEffect(() => {
    if (!isOpen) {
      setSettingsLoadState(initialSettings == null ? 'idle' : 'ready');
      setError(null);
      setAgentConfigError(null);
      return;
    }

    if (initialSettings != null) {
      dispatchSettingsDraft({ type: 'reset', value: createSettingsDraftFromResponse(initialSettings) });
      setSettingsLoadState('ready');
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
        return response.json() as Promise<PublicSettingsView>;
      })
      .then((settings) => {
        if (canceled) {
          return;
        }
        applyPersistedProfiles(settings.llmProfiles ?? llmProfiles);
        dispatchSettingsDraft({
          type: 'reset',
          value: createSettingsDraftFromResponse(settings),
        });
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
  }, [initialSettings, isOpen, llmProfiles]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let canceled = false;
    setAgentConfigLoading(true);
    setAgentConfigError(null);
    void fetch('/api/agents')
      .then((response) => response.json())
      .then((payload: { agents?: AgentListItemView[] }) => {
        if (canceled) {
          return;
        }
        const agents = Array.isArray(payload.agents)
          ? payload.agents.filter((agent) => agent.source === 'global')
          : [];
        setAgentItems(agents);
        setSelectedAgentName((current) =>
          agents.some((agent) => agent.name === current) ? current : agents[0]?.name ?? ''
        );
      })
      .catch((loadError) => {
        if (!canceled) {
          setAgentItems([]);
          setAgentConfigError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      })
      .finally(() => {
        if (!canceled) {
          setAgentConfigLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!selectedAgentItem) {
      setAgentConfigDraft(createAgentConfigDraft());
      return;
    }
    setAgentConfigDraft(createAgentConfigDraft(selectedAgentItem.config));
    setAgentConfigError(null);
  }, [selectedAgentItem?.name]);

  const handleProfileChange = (patch: Partial<EditableProfile>): void => {
    if (!selectedProfile) {
      return;
    }
    const affectsDiscovery =
      patch.provider !== undefined ||
      patch.apiBase !== undefined ||
      patch.apiKeyInput !== undefined ||
      patch.apiKeyEditing !== undefined ||
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

  const updateSelectedProfileModels = (models: string[], defaultModel?: string): void => {
    if (!selectedProfile) {
      return;
    }
    const normalized = normalizeAvailableModels(models, defaultModel ?? selectedProfile.defaultModel);
    const nextDefault =
      defaultModel && normalized.includes(defaultModel)
        ? defaultModel
        : normalized.includes(selectedProfile.defaultModel)
          ? selectedProfile.defaultModel
          : normalized[0] ?? selectedProfile.defaultModel;
    handleProfileChange({
      availableModels: normalized,
      defaultModel: nextDefault,
    });
  };

  const handleAddAvailableModel = (model: string): void => {
    const trimmed = model.trim();
    if (!selectedProfile || !trimmed) {
      return;
    }
    const nextModels = normalizeAvailableModels(
      [...selectedAvailableModels, trimmed],
      selectedProfile.defaultModel || trimmed
    );
    updateSelectedProfileModels(nextModels, selectedProfile.defaultModel || trimmed);
    setManualModelInputByProfile((prev) => ({
      ...prev,
      [selectedProfile.id]: '',
    }));
  };

  const handleRemoveAvailableModel = (model: string): void => {
    if (!selectedProfile) {
      return;
    }
    const remaining = selectedAvailableModels.filter((item) => item !== model);
    if (remaining.length === 0) {
      return;
    }
    updateSelectedProfileModels(remaining, selectedProfile.defaultModel === model ? remaining[0] : selectedProfile.defaultModel);
  };

  const handleSetDefaultAvailableModel = (model: string): void => {
    if (!selectedProfile || !selectedAvailableModels.includes(model)) {
      return;
    }
    handleProfileChange({
      defaultModel: model,
      availableModels: selectedAvailableModels,
    });
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
          profile: profileDraftToDiscoveryPayload(profile),
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

  const handleAgentDraftChange = (patch: Partial<AgentConfigDraft>): void => {
    setAgentConfigDraft((prev) => ({ ...prev, ...patch }));
  };

  const handleSaveAgentConfig = async (): Promise<void> => {
    if (!selectedAgentItem || agentConfigSaving) {
      return;
    }
    setAgentConfigSaving(true);
    setAgentConfigError(null);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(selectedAgentItem.name)}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: agentConfigDraftToPayload(agentConfigDraft) }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `status=${response.status}`);
      }
      const payload = (await response.json()) as {
        name: string;
        config: AgentProfileConfigView;
      };
      setAgentItems((prev) =>
        prev.map((agent) =>
          agent.name === payload.name
            ? {
                ...agent,
                config: payload.config,
                description: payload.config.description || agent.description,
              }
            : agent
        )
      );
      setAgentConfigDraft(createAgentConfigDraft(payload.config));
    } catch (saveError) {
      setAgentConfigError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setAgentConfigSaving(false);
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

    try {
      const profilesSnapshot = profilesRef.current;
      if (profilesSnapshot.length === 0) {
        throw new Error(t('config.providerCenter.errorMissingProfiles'));
      }

      const settingsResponse = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultProfileId: defaultProfileId || profilesSnapshot[0].id,
          profiles: profilesSnapshot.map(profileDraftToSavePayload),
          ...buildAgentSettingsPayload(settingsDraft),
        }),
      });

      if (!settingsResponse.ok) {
        const payload = (await settingsResponse.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error || t('config.error.saveApi'));
      }

      const savedSettings = (await settingsResponse.json()) as SaveSettingsResponse;
      const nextPersistedProfiles: LlmProfilesConfigView = {
        defaultProfileId: savedSettings.llmProfiles.defaultProfileId,
        profiles: savedSettings.llmProfiles.profiles,
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
      dispatchSettingsDraft({ type: 'reset', value: createSettingsDraftFromResponse(savedSettings) });

      await onSaved?.();
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('config.error.unknown'));
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
            {CONFIG_MODAL_TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={tab.testId}
                  onClick={() => setActiveTab(tab.id)}
                  className="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all"
                  style={{
                    backgroundColor: isActive ? theme.colors.bg.secondary : 'transparent',
                    color: isActive ? theme.colors.text.primary : theme.colors.text.secondary,
                  }}
                >
                  {t(tab.labelKey)}
                </button>
              );
            })}
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
          <ConfigModalProvidersTab
            profiles={profiles}
            selectedProfile={selectedProfile}
            defaultProfileId={defaultProfileId}
            settingsControlsDisabled={settingsControlsDisabled}
            selectedAvailableModels={selectedAvailableModels}
            selectedManualModelInput={selectedManualModelInput}
            selectedIntrospection={selectedIntrospection}
            selectedDiscoveryStatus={selectedDiscoveryStatus}
            selectedDiscoveryCandidates={selectedDiscoveryCandidates}
            selectedAdvancedOpen={selectedAdvancedOpen}
            ctxWindowTokens={ctxWindowTokens}
            onAddProfile={handleAddProfile}
            onRemoveProfile={handleRemoveProfile}
            onSelectProfile={setSelectedProfileId}
            onSetDefaultProfile={setDefaultProfileId}
            onProfileChange={handleProfileChange}
            onSetDefaultAvailableModel={handleSetDefaultAvailableModel}
            onRemoveAvailableModel={handleRemoveAvailableModel}
            onManualModelInputChange={(profileId, value) =>
              setManualModelInputByProfile((prev) => ({
                ...prev,
                [profileId]: value,
              }))
            }
            onAddAvailableModel={handleAddAvailableModel}
            onDiscoverModels={handleDiscoverModels}
            onAdvancedOpenChange={(profileId, open) =>
              setAdvancedOpenByProfile((prev) => ({
                ...prev,
                [profileId]: open,
              }))
            }
          />
        ) : activeTab === 'skills' ? (
          <ConfigModalSkillsTab
            skillsDir={skillsDir}
            setSkillsDir={setSkillsDir}
            globalAgentsDir={globalAgentsDir}
            setGlobalAgentsDir={setGlobalAgentsDir}
            settingsControlsDisabled={settingsControlsDisabled}
          />
        ) : activeTab === 'agents' ? (
          <ConfigModalAgentsTab
            agentConfigLoading={agentConfigLoading}
            agentItems={agentItems}
            selectedAgentItem={selectedAgentItem}
            agentConfigDraft={agentConfigDraft}
            agentConfigSaving={agentConfigSaving}
            agentConfigError={agentConfigError}
            profiles={profiles}
            agentModelOptions={agentModelOptions}
            agentModelPlaceholder={agentModelPlaceholder}
            agentModelOptionsOpen={agentModelOptionsOpen}
            setAgentModelOptionsOpen={setAgentModelOptionsOpen}
            onSelectAgentName={setSelectedAgentName}
            onSaveAgentConfig={handleSaveAgentConfig}
            onAgentDraftChange={handleAgentDraftChange}
          />
        ) : activeTab === 'governance' ? (
          <ConfigModalGovernanceTab governanceSlot={governanceSlot} />
        ) : (
          <ConfigModalOtherTab
            settingsControlsDisabled={settingsControlsDisabled}
            maxSteps={maxSteps}
            setMaxSteps={setMaxSteps}
            sessionShareTtlHours={sessionShareTtlHours}
            setSessionShareTtlHours={setSessionShareTtlHours}
            completionMarkerEnforcementEnabled={completionMarkerEnforcementEnabled}
            setCompletionMarkerEnforcementEnabled={setCompletionMarkerEnforcementEnabled}
            authEnabled={authEnabled}
            setAuthEnabled={setAuthEnabled}
            authConfigured={authConfigured}
            authPassword={authPassword}
            setAuthPassword={setAuthPassword}
            setAuthClearPassword={setAuthClearPassword}
            authSessionTtlMs={authSessionTtlMs}
            setAuthSessionTtlMs={setAuthSessionTtlMs}
            authTrustProxy={authTrustProxy}
            setAuthTrustProxy={setAuthTrustProxy}
            ctxWindowTokens={ctxWindowTokens}
            setCtxWindowTokens={setCtxWindowTokens}
            ctxPrecompressTriggerRatio={ctxPrecompressTriggerRatio}
            setCtxPrecompressTriggerRatio={setCtxPrecompressTriggerRatio}
            ctxReplayMinRounds={ctxReplayMinRounds}
            setCtxReplayMinRounds={setCtxReplayMinRounds}
            ctxReplayMaxRounds={ctxReplayMaxRounds}
            setCtxReplayMaxRounds={setCtxReplayMaxRounds}
            ctxReplayBudgetRatio={ctxReplayBudgetRatio}
            setCtxReplayBudgetRatio={setCtxReplayBudgetRatio}
            ctxPrecompressKeepLlmRounds={ctxPrecompressKeepLlmRounds}
            setCtxPrecompressKeepLlmRounds={setCtxPrecompressKeepLlmRounds}
            ctxPrecompressChunkTokens={ctxPrecompressChunkTokens}
            setCtxPrecompressChunkTokens={setCtxPrecompressChunkTokens}
            ctxCompressionMaxTokens={ctxCompressionMaxTokens}
            setCtxCompressionMaxTokens={setCtxCompressionMaxTokens}
            workspaceTimelineEnabled={workspaceTimelineEnabled}
            setWorkspaceTimelineEnabled={setWorkspaceTimelineEnabled}
          />
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
