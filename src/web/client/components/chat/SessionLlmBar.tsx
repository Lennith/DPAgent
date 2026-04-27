import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n } from '../../i18n/index.js';
import type {
  LlmProfileIntrospectionView,
  LlmProfilesConfigView,
  SessionLlmSelectionPatch,
  SessionLlmSelectionView,
} from '../../app-shell-types.js';
import { resolveLlmProfileById } from '../../llm-session-state.js';

interface SessionLlmBarProps {
  sessionId?: string | null;
  llmProfiles: LlmProfilesConfigView | null;
  selection: SessionLlmSelectionView;
  disabled: boolean;
  onChange: (patch: SessionLlmSelectionPatch) => void;
}

const REASONING_PRESETS: Array<SessionLlmSelectionView['reasoningPreset']> = ['off', 'low', 'medium', 'high'];

function ChevronDown({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-2 w-2 rotate-45 border-b-2 border-r-2 ${className}`}
      aria-hidden="true"
    />
  );
}

export function SessionLlmBar({
  llmProfiles,
  selection,
  disabled,
  onChange,
}: SessionLlmBarProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const [panelOpen, setPanelOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loadingProfileId, setLoadingProfileId] = useState<string | null>(null);
  const [introspectionByProfile, setIntrospectionByProfile] = useState<Record<string, LlmProfileIntrospectionView>>({});
  const [modelInput, setModelInput] = useState(selection.model);
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [reasoningDropdownOpen, setReasoningDropdownOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [thinkingBudgetInput, setThinkingBudgetInput] = useState(
    selection.providerOptions?.anthropic?.thinkingBudgetTokens?.toString() ?? ''
  );

  const currentProfile = useMemo(
    () => resolveLlmProfileById(llmProfiles, selection.profileId),
    [llmProfiles, selection.profileId]
  );
  const introspection = currentProfile ? introspectionByProfile[currentProfile.id] : undefined;
  const supportsReasoning = Boolean(
    currentProfile?.capabilities?.reasoningEffort || currentProfile?.capabilities?.thinkingBudget
  );
  const canTuneThinkingBudget = Boolean(currentProfile?.capabilities?.thinkingBudget);
  const canTuneReasoningEffort = Boolean(currentProfile?.capabilities?.reasoningEffort);
  const modelOptions = useMemo(() => {
    const discovered = introspection?.models ?? [];
    const next = new Map<string, string>();
    for (const model of discovered) {
      next.set(model.id, model.displayName || model.id);
    }
    if (selection.model) {
      next.set(selection.model, selection.model);
    }
    if (currentProfile?.defaultModel) {
      next.set(currentProfile.defaultModel, currentProfile.defaultModel);
    }
    return [...next.entries()];
  }, [currentProfile?.defaultModel, introspection?.models, selection.model]);
  const profileOptions = llmProfiles?.profiles ?? [];
  const visibleModelOptions = useMemo(() => {
    const query = modelInput.trim().toLowerCase();
    if (!query) {
      return modelOptions;
    }
    return modelOptions.filter(([value, label]) => {
      return value.toLowerCase().includes(query) || label.toLowerCase().includes(query);
    });
  }, [modelInput, modelOptions]);

  useEffect(() => {
    setModelInput(selection.model);
  }, [selection.model]);

  useEffect(() => {
    setThinkingBudgetInput(selection.providerOptions?.anthropic?.thinkingBudgetTokens?.toString() ?? '');
  }, [selection.providerOptions?.anthropic?.thinkingBudgetTokens]);

  useEffect(() => {
    if (!currentProfile || introspectionByProfile[currentProfile.id]) {
      return;
    }
    void discoverModels(currentProfile.id);
  }, [currentProfile, introspectionByProfile]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (panelOpen && !popoverRef.current?.contains(target)) {
        setPanelOpen(false);
        setProfileDropdownOpen(false);
        setModelDropdownOpen(false);
        setReasoningDropdownOpen(false);
      }
      if (!modelDropdownRef.current?.contains(target)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [panelOpen]);

  async function discoverModels(profileId: string): Promise<void> {
    setLoadingProfileId(profileId);
    try {
      const response = await fetch(`/api/llm-profiles/${profileId}/discover-models`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(`status=${response.status}`);
      }
      const payload = (await response.json()) as LlmProfileIntrospectionView;
      setIntrospectionByProfile((prev) => ({
        ...prev,
        [profileId]: payload,
      }));
    } catch (error) {
      setIntrospectionByProfile((prev) => ({
        ...prev,
        [profileId]: {
          profileId,
          source: 'manual',
          fetchedAt: new Date().toISOString(),
          models: [],
          manualModelEntryAllowed: true,
          capabilities: {
            modelDiscovery: false,
            reasoningEffort: Boolean(currentProfile?.capabilities?.reasoningEffort),
            thinkingBudget: Boolean(currentProfile?.capabilities?.thinkingBudget),
          },
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setLoadingProfileId((prev) => (prev === profileId ? null : prev));
    }
  }

  const commitModelInput = (): void => {
    const trimmed = modelInput.trim();
    if (!trimmed || trimmed === selection.model) {
      setModelInput(selection.model);
      setModelDropdownOpen(false);
      return;
    }
    setModelDropdownOpen(false);
    onChange({ model: trimmed });
  };

  const commitThinkingBudgetInput = (): void => {
    if (!canTuneThinkingBudget) {
      return;
    }
    const trimmed = thinkingBudgetInput.trim();
    if (!trimmed) {
      onChange({
        providerOptions: {
          anthropic: {
            thinkingBudgetTokens: null,
          },
        },
      });
      return;
    }
    const numeric = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      setThinkingBudgetInput(selection.providerOptions?.anthropic?.thinkingBudgetTokens?.toString() ?? '');
      return;
    }
    onChange({
      providerOptions: {
        anthropic: {
          thinkingBudgetTokens: numeric,
        },
      },
    });
  };

  if (!currentProfile) {
    return null;
  }

  const reasoningLabel = t(`app.llm.reasoningPreset.${selection.reasoningPreset}` as never);
  const providerLabel =
    currentProfile.name ||
    (currentProfile.provider === 'openai' ? t('config.provider.openai') : t('config.provider.anthropic'));
  const dropdownPanelStyle = {
    backgroundColor: theme.colors.bg.tertiary,
    borderColor: theme.colors.border.DEFAULT,
    boxShadow: theme.shadows.lg,
  };
  const dropdownButtonStyle = {
    backgroundColor: theme.colors.bg.tertiary,
    borderColor: theme.colors.border.DEFAULT,
    color: theme.colors.text.primary,
    opacity: disabled ? 0.7 : 1,
  };

  return (
    <div ref={popoverRef} className="session-llm-control relative inline-flex min-w-0" data-testid="session-llm-compact">
      <button
        type="button"
        onClick={() => setPanelOpen((prev) => !prev)}
        className="session-llm-trigger inline-flex max-w-[340px] items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-all duration-200 hover:-translate-y-[1px] disabled:opacity-70"
        style={{
          borderColor: panelOpen ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
          backgroundColor: theme.colors.bg.secondary,
          color: theme.colors.text.secondary,
          boxShadow: panelOpen ? theme.shadows.glow : theme.shadows.sm,
        }}
        aria-expanded={panelOpen}
        aria-label={t('app.llm.compactAria')}
      >
        <span className="font-semibold" style={{ color: theme.colors.primary.DEFAULT }}>
          LLM
        </span>
        <span className="session-llm-provider hidden sm:inline opacity-70">{providerLabel}</span>
        <span className="session-llm-model max-w-[120px] truncate font-medium" style={{ color: theme.colors.text.primary }}>
          {selection.model}
        </span>
        <span
          className="session-llm-reasoning shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5"
          style={{ backgroundColor: `${theme.colors.primary.DEFAULT}18` }}
        >
          {reasoningLabel}
        </span>
        <ChevronDown className={panelOpen ? 'rotate-[225deg]' : ''} />
      </button>

      {panelOpen && (
        <div
          className="session-llm-popover absolute bottom-full right-0 z-[80] mb-3 w-[min(720px,calc(100vw-2rem))] overflow-visible rounded-[1.35rem] border p-3"
          data-testid="session-llm-popover"
          style={{
            borderColor: theme.colors.border.DEFAULT,
            backgroundColor: theme.colors.bg.secondary,
            boxShadow: theme.shadows.xl,
            color: theme.colors.text.primary,
            backdropFilter: 'blur(20px)',
          }}
        >
          <div className="mb-2 flex items-center justify-end">
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="rounded-full border px-2 py-1 text-xs"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.tertiary,
                color: theme.colors.text.secondary,
              }}
            >
              {t('common.close')}
            </button>
          </div>

          <div className="session-llm-fields grid gap-3">
            <div className="relative">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: theme.colors.text.muted }}>
                {t('app.llm.profile')}
              </label>
              <button
                type="button"
                data-testid="session-llm-profile-trigger"
                disabled={disabled}
                onClick={() => {
                  setProfileDropdownOpen((prev) => !prev);
                  setModelDropdownOpen(false);
                  setReasoningDropdownOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm outline-none transition-colors focus:ring-2"
                style={dropdownButtonStyle}
              >
                <span className="min-w-0 truncate">{providerLabel}</span>
                <span className="shrink-0">
                  <ChevronDown />
                </span>
              </button>
              {profileDropdownOpen && !disabled && (
                <div
                  data-testid="session-llm-profile-menu"
                  className="absolute bottom-full left-0 right-0 z-[90] mb-1 max-h-56 overflow-y-auto rounded-xl border py-1"
                  style={dropdownPanelStyle}
                >
                  {profileOptions.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setProfileDropdownOpen(false);
                        if (profile.id !== selection.profileId) {
                          onChange({ profileId: profile.id });
                        }
                      }}
                      className="block w-full truncate px-3 py-2 text-left text-sm transition-colors"
                      style={{
                        color: profile.id === selection.profileId ? theme.colors.text.primary : theme.colors.text.secondary,
                        backgroundColor: profile.id === selection.profileId ? `${theme.colors.primary.DEFAULT}18` : 'transparent',
                      }}
                    >
                      {profile.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div ref={modelDropdownRef} className="relative">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: theme.colors.text.muted }}>
                {t('app.llm.model')}
              </label>
              <div className="relative">
                <input
                  data-testid="session-llm-model-input"
                  value={modelInput}
                  disabled={disabled}
                  onFocus={() => {
                    setProfileDropdownOpen(false);
                    setReasoningDropdownOpen(false);
                    setModelDropdownOpen(true);
                  }}
                  onChange={(event) => {
                    setModelInput(event.target.value);
                    setProfileDropdownOpen(false);
                    setModelDropdownOpen(true);
                    setReasoningDropdownOpen(false);
                  }}
                  onBlur={commitModelInput}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitModelInput();
                    }
                    if (event.key === 'Escape') {
                      setModelDropdownOpen(false);
                      setModelInput(selection.model);
                    }
                  }}
                  className="w-full rounded-xl border px-3 py-2 pr-9 text-sm outline-none focus:ring-2"
                  style={dropdownButtonStyle}
                />
                <button
                  type="button"
                  data-testid="session-llm-model-trigger"
                  disabled={disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setProfileDropdownOpen(false);
                    setReasoningDropdownOpen(false);
                    setModelDropdownOpen((prev) => !prev);
                  }}
                  className="absolute inset-y-0 right-0 flex w-9 items-center justify-center"
                  style={{ color: theme.colors.text.secondary, opacity: disabled ? 0.5 : 1 }}
                  aria-label={t('app.llm.model')}
                >
                  <ChevronDown />
                </button>
              </div>
              {modelDropdownOpen && !disabled && visibleModelOptions.length > 0 && (
                <div
                  data-testid="session-llm-model-menu"
                  className="absolute bottom-full left-0 right-0 z-[90] mb-1 max-h-56 overflow-y-auto rounded-xl border py-1"
                  style={{
                    ...dropdownPanelStyle,
                  }}
                >
                  {visibleModelOptions.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setModelInput(value);
                        setModelDropdownOpen(false);
                        if (value !== selection.model) {
                          onChange({ model: value });
                        }
                      }}
                      className="block w-full truncate px-3 py-2 text-left text-sm transition-colors"
                      style={{
                        color: value === selection.model ? theme.colors.text.primary : theme.colors.text.secondary,
                        backgroundColor: value === selection.model ? `${theme.colors.primary.DEFAULT}18` : 'transparent',
                      }}
                      title={label === value ? value : `${label} (${value})`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: theme.colors.text.muted }}>
                {t('app.llm.reasoning')}
              </label>
              <button
                type="button"
                data-testid="session-llm-reasoning-trigger"
                disabled={disabled}
                onClick={() => {
                  setReasoningDropdownOpen((prev) => !prev);
                  setProfileDropdownOpen(false);
                  setModelDropdownOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm outline-none transition-colors focus:ring-2"
                style={dropdownButtonStyle}
              >
                <span className="min-w-0 truncate">{reasoningLabel}</span>
                <span className="shrink-0">
                  <ChevronDown />
                </span>
              </button>
              {reasoningDropdownOpen && !disabled && (
                <div
                  data-testid="session-llm-reasoning-menu"
                  className="absolute bottom-full left-0 right-0 z-[90] mb-1 max-h-56 overflow-y-auto rounded-xl border py-1"
                  style={dropdownPanelStyle}
                >
                  {REASONING_PRESETS.map((preset) => {
                    const isDisabled = preset !== 'off' && !supportsReasoning;
                    const active = selection.reasoningPreset === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        disabled={isDisabled}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          if (isDisabled) {
                            return;
                          }
                          setReasoningDropdownOpen(false);
                          onChange({ reasoningPreset: preset });
                        }}
                        className="block w-full truncate px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed"
                        style={{
                          color: active ? theme.colors.text.primary : theme.colors.text.secondary,
                          backgroundColor: active ? `${theme.colors.primary.DEFAULT}18` : 'transparent',
                          opacity: isDisabled ? 0.45 : 1,
                        }}
                      >
                        {t(`app.llm.reasoningPreset.${preset}` as never)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setAdvancedOpen((prev) => !prev)}
              className="rounded-xl border px-3 py-2 text-xs font-medium transition-colors"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.tertiary,
                color: theme.colors.text.secondary,
              }}
            >
              {advancedOpen ? t('app.llm.hideAdvanced') : t('app.llm.showAdvanced')}
            </button>
            <button
              type="button"
              onClick={() => void discoverModels(currentProfile.id)}
              disabled={disabled || loadingProfileId === currentProfile.id}
              className="rounded-xl border px-3 py-2 text-xs font-medium transition-colors"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.tertiary,
                color: theme.colors.text.secondary,
                opacity: disabled || loadingProfileId === currentProfile.id ? 0.6 : 1,
              }}
            >
              {loadingProfileId === currentProfile.id ? t('app.llm.discovering') : t('app.llm.discover')}
            </button>
          </div>

          {advancedOpen && (
            <div
              className="mt-3 grid grid-cols-1 gap-3 rounded-2xl border p-3 md:grid-cols-3"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.primary,
              }}
            >
              <div className="md:col-span-3">
                <div className="mb-1 text-xs font-medium" style={{ color: theme.colors.text.secondary }}>
                  {t('app.llm.discoveryStatus')}
                </div>
                <div className="text-xs leading-5" style={{ color: theme.colors.text.muted }}>
                  {introspection
                    ? t('app.llm.discoverySummary', {
                        source: introspection.source,
                        count: introspection.models.length,
                      })
                    : t('app.llm.discoveryPending')}
                  {introspection?.error ? ` ${introspection.error}` : ''}
                </div>
              </div>

              {canTuneReasoningEffort && (
                <div>
                  <label className="mb-1 block text-xs font-medium" style={{ color: theme.colors.text.secondary }}>
                    {t('app.llm.reasoningEffort')}
                  </label>
                  <select
                    value={selection.providerOptions?.openai?.reasoningEffort ?? ''}
                    disabled={disabled || selection.reasoningPreset === 'off'}
                    onChange={(event) =>
                      onChange({
                        providerOptions: {
                          openai: {
                            reasoningEffort:
                              event.target.value === '' ? null : (event.target.value as 'low' | 'medium' | 'high'),
                          },
                        },
                      })
                    }
                    className="w-full appearance-none rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2"
                    style={{
                      backgroundColor: theme.colors.bg.tertiary,
                      borderColor: theme.colors.border.DEFAULT,
                      color: theme.colors.text.primary,
                      opacity: disabled || selection.reasoningPreset === 'off' ? 0.65 : 1,
                    }}
                  >
                    <option value="">{t('app.llm.followPreset')}</option>
                    <option value="low">{t('app.llm.reasoningPreset.low')}</option>
                    <option value="medium">{t('app.llm.reasoningPreset.medium')}</option>
                    <option value="high">{t('app.llm.reasoningPreset.high')}</option>
                  </select>
                </div>
              )}

              {canTuneThinkingBudget && (
                <div>
                  <label className="mb-1 block text-xs font-medium" style={{ color: theme.colors.text.secondary }}>
                    {t('app.llm.thinkingBudget')}
                  </label>
                  <input
                    value={thinkingBudgetInput}
                    disabled={disabled || selection.reasoningPreset === 'off'}
                    onChange={(event) => setThinkingBudgetInput(event.target.value)}
                    onBlur={commitThinkingBudgetInput}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitThinkingBudgetInput();
                      }
                    }}
                    placeholder={t('app.llm.followPreset')}
                    className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2"
                    style={{
                      backgroundColor: theme.colors.bg.tertiary,
                      borderColor: theme.colors.border.DEFAULT,
                      color: theme.colors.text.primary,
                      opacity: disabled || selection.reasoningPreset === 'off' ? 0.65 : 1,
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
