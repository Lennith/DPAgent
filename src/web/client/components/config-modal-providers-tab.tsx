import { useThemeConfig } from './providers/ThemeProvider.js';
import { useI18n } from '../i18n/index.js';
import type { LlmProfileIntrospectionView } from '../app-shell-types.js';
import type { EditableProfile } from './config-modal-profile-draft.js';
import {
  ConfigFieldLabel,
  FIELD_CONTROL_CLASS_NAME,
  createFieldControlStyle,
} from './config-modal-field-primitives.js';
import { ConfigModalProviderAdvanced } from './config-modal-provider-advanced.js';

type ModelDiscoveryStatus = 'idle' | 'waiting' | 'loading' | 'success' | 'error';

interface DiscoveryCandidate {
  id: string;
  label: string;
  added: boolean;
}

export interface ConfigModalProvidersTabProps {
  profiles: EditableProfile[];
  selectedProfile: EditableProfile | null;
  defaultProfileId: string;
  settingsControlsDisabled: boolean;
  selectedAvailableModels: string[];
  selectedManualModelInput: string;
  selectedIntrospection?: LlmProfileIntrospectionView;
  selectedDiscoveryStatus: ModelDiscoveryStatus;
  selectedDiscoveryCandidates: DiscoveryCandidate[];
  selectedAdvancedOpen: boolean;
  ctxWindowTokens: number;
  onAddProfile: () => void;
  onRemoveProfile: () => void;
  onSelectProfile: (profileId: string) => void;
  onSetDefaultProfile: (profileId: string) => void;
  onProfileChange: (patch: Partial<EditableProfile>) => void;
  onSetDefaultAvailableModel: (model: string) => void;
  onRemoveAvailableModel: (model: string) => void;
  onManualModelInputChange: (profileId: string, value: string) => void;
  onAddAvailableModel: (model: string) => void;
  onDiscoverModels: (profile: EditableProfile) => void | Promise<void>;
  onAdvancedOpenChange: (profileId: string, open: boolean) => void;
}

export function ConfigModalProvidersTab({
  profiles,
  selectedProfile,
  defaultProfileId,
  settingsControlsDisabled,
  selectedAvailableModels,
  selectedManualModelInput,
  selectedIntrospection,
  selectedDiscoveryStatus,
  selectedDiscoveryCandidates,
  selectedAdvancedOpen,
  ctxWindowTokens,
  onAddProfile,
  onRemoveProfile,
  onSelectProfile,
  onSetDefaultProfile,
  onProfileChange,
  onSetDefaultAvailableModel,
  onRemoveAvailableModel,
  onManualModelInputChange,
  onAddAvailableModel,
  onDiscoverModels,
  onAdvancedOpenChange,
}: ConfigModalProvidersTabProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const fieldControlStyle = createFieldControlStyle(theme);

  return (
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
            onClick={onAddProfile}
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
                onClick={() => onSelectProfile(profile.id)}
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
                    onChange={() => onSetDefaultProfile(selectedProfile.id)}
                    disabled={settingsControlsDisabled}
                  />
                  {t('config.providerCenter.useAsDefault')}
                </label>
                <button
                  type="button"
                  onClick={onRemoveProfile}
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
                <ConfigFieldLabel>{t('config.providerCenter.profileName')}</ConfigFieldLabel>
                <input
                  value={selectedProfile.name}
                  onChange={(event) =>
                    onProfileChange({ name: event.target.value })
                  }
                  disabled={settingsControlsDisabled}
                  className={FIELD_CONTROL_CLASS_NAME}
                  style={fieldControlStyle}
                />
              </div>
              <div>
                <ConfigFieldLabel>{t('config.provider')}</ConfigFieldLabel>
                <select
                  value={selectedProfile.provider}
                  onChange={(event) =>
                    onProfileChange({
                      provider:
                        event.target.value === 'openai' ? 'openai' : 'anthropic',
                    })
                  }
                  disabled={settingsControlsDisabled}
                  className={FIELD_CONTROL_CLASS_NAME}
                  style={fieldControlStyle}
                >
                  <option value="anthropic">{t('config.provider.anthropic')}</option>
                  <option value="openai">{t('config.provider.openai')}</option>
                </select>
              </div>
              <div>
                <ConfigFieldLabel>{t('config.apiBase')}</ConfigFieldLabel>
                <input
                  value={selectedProfile.apiBase}
                  onChange={(event) =>
                    onProfileChange({ apiBase: event.target.value })
                  }
                  disabled={settingsControlsDisabled}
                  className={FIELD_CONTROL_CLASS_NAME}
                  style={fieldControlStyle}
                />
              </div>
              <div className="md:col-span-2">
                <div className="mb-2">
                  <div className="text-sm font-medium" style={{ color: theme.colors.text.secondary }}>
                    {t('config.providerCenter.availableModels')}
                  </div>
                </div>

                <div
                  data-testid="config-provider-available-models"
                  className="space-y-2 rounded-xl border p-2"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    backgroundColor: theme.colors.bg.secondary,
                  }}
                >
                  {selectedAvailableModels.map((model) => {
                    const isDefault = model === selectedProfile.defaultModel;
                    return (
                      <div
                        key={model}
                        className="flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2"
                        style={{
                          borderColor: isDefault
                            ? theme.colors.primary.DEFAULT
                            : theme.colors.border.DEFAULT,
                          backgroundColor: isDefault
                            ? `${theme.colors.primary.DEFAULT}12`
                            : theme.colors.bg.tertiary,
                        }}
                      >
                        <label className="flex min-w-0 flex-1 items-center gap-2">
                          <input
                            type="radio"
                            checked={isDefault}
                            onChange={() => onSetDefaultAvailableModel(model)}
                            disabled={settingsControlsDisabled}
                          />
                          <span
                            className="min-w-0 truncate text-sm font-medium"
                            style={{ color: theme.colors.text.primary }}
                            title={model}
                          >
                            {model}
                          </span>
                        </label>
                        {isDefault && (
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
                        <button
                          type="button"
                          data-testid={`config-provider-model-remove-${model}`}
                          onClick={() => onRemoveAvailableModel(model)}
                          disabled={settingsControlsDisabled || selectedAvailableModels.length <= 1}
                          className="shrink-0 rounded-md border px-2 py-1 text-xs"
                          style={{
                            borderColor: theme.colors.border.DEFAULT,
                            backgroundColor: theme.colors.bg.secondary,
                            color: theme.colors.text.secondary,
                            opacity:
                              settingsControlsDisabled || selectedAvailableModels.length <= 1
                                ? 0.45
                                : 1,
                          }}
                        >
                          {t('common.remove')}
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-3">
                  <div>
                    <ConfigFieldLabel>{t('config.providerCenter.manualModel')}</ConfigFieldLabel>
                    <div className="flex gap-2">
                      <input
                        data-testid="config-provider-manual-model-input"
                        value={selectedManualModelInput}
                        onChange={(event) =>
                          onManualModelInputChange(selectedProfile.id, event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            onAddAvailableModel(selectedManualModelInput);
                          }
                        }}
                        disabled={settingsControlsDisabled}
                        placeholder={t('config.providerCenter.manualModelPlaceholder')}
                        className="min-w-0 flex-1 rounded-xl border px-3 py-2 outline-none focus:ring-2"
                        style={fieldControlStyle}
                      />
                      <button
                        type="button"
                        data-testid="config-provider-manual-model-add"
                        onClick={() => onAddAvailableModel(selectedManualModelInput)}
                        disabled={settingsControlsDisabled || selectedManualModelInput.trim().length === 0}
                        className="rounded-xl border px-3 py-2 text-sm"
                        style={{
                          borderColor: theme.colors.border.DEFAULT,
                          backgroundColor: theme.colors.bg.tertiary,
                          color: theme.colors.text.secondary,
                          opacity:
                            settingsControlsDisabled || selectedManualModelInput.trim().length === 0
                              ? 0.55
                              : 1,
                        }}
                      >
                        {t('common.add')}
                      </button>
                    </div>
                  </div>

                  <div className="mt-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-sm" style={{ color: theme.colors.text.secondary }}>
                        {t('config.providerCenter.discoveryCandidates')}
                      </span>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-xs" style={{ color: theme.colors.text.muted }}>
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
                        </span>
                        <button
                          type="button"
                          onClick={() => void onDiscoverModels(selectedProfile)}
                          disabled={settingsControlsDisabled || selectedDiscoveryStatus === 'loading'}
                          className="shrink-0 rounded-md border px-2 py-1 text-xs"
                          style={{
                            borderColor: theme.colors.border.DEFAULT,
                            backgroundColor: theme.colors.bg.tertiary,
                            color: theme.colors.text.secondary,
                            opacity:
                              settingsControlsDisabled || selectedDiscoveryStatus === 'loading' ? 0.55 : 1,
                          }}
                        >
                          {t('config.providerCenter.validateDiscover')}
                        </button>
                      </div>
                    </div>
                    <div
                      data-testid="config-provider-discovery-candidates"
                      className="max-h-40 space-y-2 overflow-auto rounded-xl border p-2"
                      style={{
                        borderColor: theme.colors.border.DEFAULT,
                        backgroundColor: theme.colors.bg.secondary,
                      }}
                    >
                      {selectedDiscoveryCandidates.length > 0 ? (
                        selectedDiscoveryCandidates.map((candidate) => (
                          <div
                            key={candidate.id}
                            className="flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2"
                            style={{
                              borderColor: theme.colors.border.DEFAULT,
                              backgroundColor: theme.colors.bg.tertiary,
                            }}
                          >
                            <div className="min-w-0 flex-1">
                              <div
                                className="truncate text-sm font-medium"
                                style={{ color: theme.colors.text.primary }}
                                title={candidate.id}
                              >
                                {candidate.id}
                              </div>
                              {candidate.label !== candidate.id && (
                                <div className="truncate text-xs" style={{ color: theme.colors.text.muted }}>
                                  {candidate.label}
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => onAddAvailableModel(candidate.id)}
                              disabled={settingsControlsDisabled || candidate.added}
                              className="shrink-0 rounded-md border px-2 py-1 text-xs"
                              style={{
                                borderColor: theme.colors.border.DEFAULT,
                                backgroundColor: theme.colors.bg.tertiary,
                                color: theme.colors.text.secondary,
                                opacity: settingsControlsDisabled || candidate.added ? 0.55 : 1,
                              }}
                            >
                              {candidate.added
                                ? t('config.providerCenter.modelAdded')
                                : t('common.add')}
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="text-xs leading-5" style={{ color: theme.colors.text.muted }}>
                          {t('config.providerCenter.discoveryIdle')}
                        </div>
                      )}
                    </div>
                  </div>
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
                {(!selectedProfile.hasApiKey ||
                  selectedProfile.clearApiKey ||
                  selectedProfile.apiKeyEditing) && (
                  <input
                    type="password"
                    name={`llm-api-key-${selectedProfile.id}`}
                    autoComplete="new-password"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    value={selectedProfile.apiKeyInput}
                    onChange={(event) =>
                      onProfileChange({
                        apiKeyInput: event.target.value,
                        apiKeyEditing: true,
                        clearApiKey: false,
                      })
                    }
                    placeholder={
                      selectedProfile.hasApiKey && !selectedProfile.clearApiKey
                        ? t('config.apiKey.placeholderConfigured')
                        : t('config.apiKey.placeholderGeneric')
                    }
                    disabled={settingsControlsDisabled}
                    className={FIELD_CONTROL_CLASS_NAME}
                    style={fieldControlStyle}
                  />
                )}
                <div className="mt-2 flex items-center gap-2">
                  {selectedProfile.hasApiKey &&
                    !selectedProfile.clearApiKey &&
                    !selectedProfile.apiKeyEditing && (
                      <button
                        type="button"
                        onClick={() =>
                          onProfileChange({
                            apiKeyInput: '',
                            apiKeyEditing: true,
                            clearApiKey: false,
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
                        {t('config.providerCenter.replaceStoredKey')}
                      </button>
                    )}
                  <button
                    type="button"
                    onClick={() =>
                      onProfileChange({
                        apiKeyInput: '',
                        apiKeyEditing: false,
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

            <ConfigModalProviderAdvanced
              profile={selectedProfile}
              open={selectedAdvancedOpen}
              settingsControlsDisabled={settingsControlsDisabled}
              ctxWindowTokens={ctxWindowTokens}
              onOpenChange={(open) => onAdvancedOpenChange(selectedProfile.id, open)}
              onProfileChange={onProfileChange}
            />
          </div>
        ) : (
          <div className="text-sm" style={{ color: theme.colors.text.muted }}>
            {t('config.providerCenter.errorMissingProfiles')}
          </div>
        )}
      </div>
    </div>
  );
}
