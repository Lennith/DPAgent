import { useMemo } from 'react';
import { useTheme, useThemeConfig } from './providers/ThemeProvider.js';
import { useI18n } from '../i18n/index.js';
import {
  REMOTE_ACCESS_AUTH_DEFAULT_SESSION_TTL_MS,
  REMOTE_ACCESS_AUTH_TTL_OPTIONS,
} from '../../../shared/remote-access-auth-defaults.js';
import {
  DEFAULT_SESSION_SHARE_TTL_HOURS,
  MAX_SESSION_SHARE_TTL_HOURS,
  MIN_SESSION_SHARE_TTL_HOURS,
} from '../../../shared/session-share-defaults.js';
import {
  ConfigFieldLabel,
  FIELD_CONTROL_CLASS_NAME,
  createFieldControlStyle,
} from './config-modal-field-primitives.js';

interface ContextBudgetField {
  key: string;
  label: string;
  value: number;
  setter: (value: number) => void;
  min: number;
  max?: number;
  step: number;
}

interface SettingsToggleCardProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
  label: string;
  description: string;
  testId?: string;
}

function SettingsToggleCard({
  checked,
  onChange,
  disabled,
  label,
  description,
  testId,
}: SettingsToggleCardProps) {
  const theme = useThemeConfig();
  return (
    <label
      className="flex items-start gap-3 rounded-xl border p-4"
      style={{
        borderColor: theme.colors.border.DEFAULT,
        backgroundColor: theme.colors.bg.primary,
      }}
    >
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="mt-1 h-4 w-4 rounded border"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium" style={{ color: theme.colors.text.primary }}>
          {label}
        </span>
        <span className="block text-xs" style={{ color: theme.colors.text.muted }}>
          {description}
        </span>
      </span>
    </label>
  );
}

export interface ConfigModalOtherTabProps {
  settingsControlsDisabled: boolean;
  maxSteps: number;
  setMaxSteps: (value: number) => void;
  sessionShareTtlHours: number;
  setSessionShareTtlHours: (value: number) => void;
  completionMarkerEnforcementEnabled: boolean;
  setCompletionMarkerEnforcementEnabled: (value: boolean) => void;
  authEnabled: boolean;
  setAuthEnabled: (value: boolean) => void;
  authConfigured: boolean;
  authPassword: string;
  setAuthPassword: (value: string) => void;
  setAuthClearPassword: (value: boolean) => void;
  authSessionTtlMs: number;
  setAuthSessionTtlMs: (value: number) => void;
  authTrustProxy: boolean;
  setAuthTrustProxy: (value: boolean) => void;
  ctxWindowTokens: number;
  setCtxWindowTokens: (value: number) => void;
  ctxPrecompressTriggerRatio: number;
  setCtxPrecompressTriggerRatio: (value: number) => void;
  ctxReplayMinRounds: number;
  setCtxReplayMinRounds: (value: number) => void;
  ctxReplayMaxRounds: number;
  setCtxReplayMaxRounds: (value: number) => void;
  ctxReplayBudgetRatio: number;
  setCtxReplayBudgetRatio: (value: number) => void;
  ctxPrecompressKeepLlmRounds: number;
  setCtxPrecompressKeepLlmRounds: (value: number) => void;
  ctxPrecompressChunkTokens: number;
  setCtxPrecompressChunkTokens: (value: number) => void;
  ctxCompressionMaxTokens: number;
  setCtxCompressionMaxTokens: (value: number) => void;
}

export function ConfigModalOtherTab({
  settingsControlsDisabled,
  maxSteps,
  setMaxSteps,
  sessionShareTtlHours,
  setSessionShareTtlHours,
  completionMarkerEnforcementEnabled,
  setCompletionMarkerEnforcementEnabled,
  authEnabled,
  setAuthEnabled,
  authConfigured,
  authPassword,
  setAuthPassword,
  setAuthClearPassword,
  authSessionTtlMs,
  setAuthSessionTtlMs,
  authTrustProxy,
  setAuthTrustProxy,
  ctxWindowTokens,
  setCtxWindowTokens,
  ctxPrecompressTriggerRatio,
  setCtxPrecompressTriggerRatio,
  ctxReplayMinRounds,
  setCtxReplayMinRounds,
  ctxReplayMaxRounds,
  setCtxReplayMaxRounds,
  ctxReplayBudgetRatio,
  setCtxReplayBudgetRatio,
  ctxPrecompressKeepLlmRounds,
  setCtxPrecompressKeepLlmRounds,
  ctxPrecompressChunkTokens,
  setCtxPrecompressChunkTokens,
  ctxCompressionMaxTokens,
  setCtxCompressionMaxTokens,
}: ConfigModalOtherTabProps) {
  const { theme: activeTheme, setTheme } = useTheme();
  const theme = useThemeConfig();
  const { locale, setLocale, t } = useI18n();
  const fieldControlStyle = createFieldControlStyle(theme);

  const remoteAccessTtlOptions = useMemo(
    () =>
      REMOTE_ACCESS_AUTH_TTL_OPTIONS.map((option) => ({
        value: option.value,
        label:
          option.value === 60 * 60 * 1000
            ? t('config.remoteAccess.ttl.1h')
            : option.value === 12 * 60 * 60 * 1000
              ? t('config.remoteAccess.ttl.12h')
              : option.value === 24 * 60 * 60 * 1000
                ? t('config.remoteAccess.ttl.1d')
                : option.value === REMOTE_ACCESS_AUTH_DEFAULT_SESSION_TTL_MS
                  ? t('config.remoteAccess.ttl.7d')
                  : t('config.remoteAccess.ttl.30d'),
      })),
    [t]
  );
  const contextBudgetFields = useMemo<ContextBudgetField[]>(
    () => [
      {
        key: 'windowTokens',
        label: t('config.contextBudget.windowTokens'),
        value: ctxWindowTokens,
        setter: setCtxWindowTokens,
        min: 1,
        step: 1000,
      },
      {
        key: 'compressionTriggerRatio',
        label: t('config.contextBudget.compressionTriggerRatio'),
        value: ctxPrecompressTriggerRatio,
        setter: setCtxPrecompressTriggerRatio,
        min: 0.01,
        max: 1.0,
        step: 0.05,
      },
      {
        key: 'minReplayRounds',
        label: t('config.contextBudget.minReplayRounds'),
        value: ctxReplayMinRounds,
        setter: setCtxReplayMinRounds,
        min: 1,
        step: 1,
      },
      {
        key: 'maxReplayRounds',
        label: t('config.contextBudget.maxReplayRounds'),
        value: ctxReplayMaxRounds,
        setter: setCtxReplayMaxRounds,
        min: 1,
        step: 1,
      },
      {
        key: 'replayBudgetRatio',
        label: t('config.contextBudget.replayBudgetRatio'),
        value: ctxReplayBudgetRatio,
        setter: setCtxReplayBudgetRatio,
        min: 0.1,
        max: 1.0,
        step: 0.05,
      },
      {
        key: 'keepLlmRounds',
        label: t('config.contextBudget.keepLlmRounds'),
        value: ctxPrecompressKeepLlmRounds,
        setter: setCtxPrecompressKeepLlmRounds,
        min: 1,
        step: 1,
      },
      {
        key: 'precompressChunkTokens',
        label: t('config.contextBudget.precompressChunkTokens'),
        value: ctxPrecompressChunkTokens,
        setter: setCtxPrecompressChunkTokens,
        min: 1000,
        step: 500,
      },
      {
        key: 'compressionMaxTokens',
        label: t('config.contextBudget.compressionMaxTokens'),
        value: ctxCompressionMaxTokens,
        setter: setCtxCompressionMaxTokens,
        min: 100,
        step: 100,
      },
    ],
    [
      ctxCompressionMaxTokens,
      ctxPrecompressChunkTokens,
      ctxPrecompressKeepLlmRounds,
      ctxPrecompressTriggerRatio,
      ctxReplayBudgetRatio,
      ctxReplayMaxRounds,
      ctxReplayMinRounds,
      ctxWindowTokens,
      setCtxCompressionMaxTokens,
      setCtxPrecompressChunkTokens,
      setCtxPrecompressKeepLlmRounds,
      setCtxPrecompressTriggerRatio,
      setCtxReplayBudgetRatio,
      setCtxReplayMaxRounds,
      setCtxReplayMinRounds,
      setCtxWindowTokens,
      t,
    ]
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <ConfigFieldLabel>{t('common.language')}</ConfigFieldLabel>
          <select
            value={locale}
            onChange={(event) =>
              setLocale(event.target.value === 'en-US' ? 'en-US' : 'zh-CN')
            }
            className={FIELD_CONTROL_CLASS_NAME}
            style={fieldControlStyle}
          >
            <option value="zh-CN">{t('common.language.zhCN')}</option>
            <option value="en-US">{t('common.language.enUS')}</option>
          </select>
        </div>
        <div>
          <ConfigFieldLabel>{t('common.theme')}</ConfigFieldLabel>
          <select
            value={activeTheme}
            onChange={(event) => setTheme(event.target.value === 'light' ? 'light' : 'dark')}
            className={FIELD_CONTROL_CLASS_NAME}
            style={fieldControlStyle}
          >
            <option value="dark">{t('common.theme.dark')}</option>
            <option value="light">{t('common.theme.light')}</option>
          </select>
        </div>
        <div>
          <ConfigFieldLabel>{t('config.maxSteps.label')}</ConfigFieldLabel>
          <input
            type="number"
            min={1}
            value={maxSteps}
            onChange={(event) => setMaxSteps(Math.max(1, Number.parseInt(event.target.value, 10) || 100))}
            disabled={settingsControlsDisabled}
            className={FIELD_CONTROL_CLASS_NAME}
            style={fieldControlStyle}
          />
        </div>
        <div>
          <ConfigFieldLabel>{t('config.sessionShareTtl.label')}</ConfigFieldLabel>
          <input
            type="number"
            min={MIN_SESSION_SHARE_TTL_HOURS}
            max={MAX_SESSION_SHARE_TTL_HOURS}
            step={1}
            value={sessionShareTtlHours}
            onChange={(event) =>
              setSessionShareTtlHours(
                Number.parseInt(event.target.value, 10) || DEFAULT_SESSION_SHARE_TTL_HOURS
              )
            }
            disabled={settingsControlsDisabled}
            className={FIELD_CONTROL_CLASS_NAME}
            style={fieldControlStyle}
          />
          <p className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
            {t('config.sessionShareTtl.hint', {
              min: MIN_SESSION_SHARE_TTL_HOURS,
              max: MAX_SESSION_SHARE_TTL_HOURS,
            })}
          </p>
        </div>
      </div>
      <SettingsToggleCard
        testId="config-completion-marker-toggle"
        checked={completionMarkerEnforcementEnabled}
        onChange={setCompletionMarkerEnforcementEnabled}
        disabled={settingsControlsDisabled}
        label={t('config.completionMarker.label')}
        description={t('config.completionMarker.description')}
      />

      <div className="mt-6 space-y-3">
        <h3 className="text-sm font-semibold" style={{ color: theme.colors.text.primary }}>
          {t('config.remoteAccess.title')}
        </h3>
        <SettingsToggleCard
          checked={authEnabled}
          onChange={setAuthEnabled}
          disabled={settingsControlsDisabled}
          label={t('config.remoteAccess.enable')}
          description={t('config.remoteAccess.description')}
        />
        {authEnabled && (
          <div className="ml-6 space-y-3">
            <div>
              <ConfigFieldLabel>{t('config.remoteAccess.password')}</ConfigFieldLabel>
              <input
                type="password"
                name="remote-access-password"
                autoComplete="new-password"
                data-lpignore="true"
                data-1p-ignore="true"
                value={authPassword}
                onChange={(event) => { setAuthPassword(event.target.value); setAuthClearPassword(false); }}
                disabled={settingsControlsDisabled}
                placeholder={
                  authConfigured
                    ? t('config.remoteAccess.passwordPlaceholderConfigured')
                    : t('config.remoteAccess.passwordPlaceholderEmpty')
                }
                className={FIELD_CONTROL_CLASS_NAME}
                style={fieldControlStyle}
              />
            </div>
            {authConfigured && (
              <button
                type="button"
                onClick={() => { setAuthClearPassword(true); setAuthPassword(''); }}
                disabled={settingsControlsDisabled}
                className="rounded-lg border px-3 py-1 text-xs"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.muted,
                }}
              >
                {t('config.remoteAccess.clearPassword')}
              </button>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <ConfigFieldLabel>{t('config.remoteAccess.sessionTtl')}</ConfigFieldLabel>
                <select
                  value={authSessionTtlMs}
                  onChange={(event) => setAuthSessionTtlMs(Number(event.target.value))}
                  disabled={settingsControlsDisabled}
                  className={FIELD_CONTROL_CLASS_NAME}
                  style={fieldControlStyle}
                >
                  {remoteAccessTtlOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <ConfigFieldLabel>{t('config.remoteAccess.trustProxy')}</ConfigFieldLabel>
                <input
                  type="checkbox"
                  checked={authTrustProxy}
                  onChange={(event) => setAuthTrustProxy(event.target.checked)}
                  disabled={settingsControlsDisabled}
                  className="mt-2 h-4 w-4 rounded border"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 space-y-3">
        <h3 className="text-sm font-semibold" style={{ color: theme.colors.text.primary }}>
          {t('config.contextBudget.title')}
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {contextBudgetFields.map((field) => (
            <div key={field.key}>
              <ConfigFieldLabel>{field.label}</ConfigFieldLabel>
              <input
                type="number"
                value={field.value}
                min={field.min}
                max={field.max}
                step={field.step}
                onChange={(event) => field.setter(Number(event.target.value))}
                disabled={settingsControlsDisabled}
                className={FIELD_CONTROL_CLASS_NAME}
                style={fieldControlStyle}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
