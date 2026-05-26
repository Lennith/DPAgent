import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../i18n/index.js';
import { useThemeConfig } from '../providers/ThemeProvider.js';

interface AutoLoopConfig {
  enabled: boolean;
  mode?: 'ralph' | 'todo';
  ralphEnabled?: boolean;
  pendingPlanConfirmation?: boolean;
  prompt: string;
  maxRounds: number;
  maxDurationMinutes: number;
  similarityThreshold: number;
  compareRounds: number;
  pausedByUser?: boolean;
}

interface AutoLoopState {
  isRunning: boolean;
  currentRound: number;
  stopReason?: string;
}

interface AutoLoopResponse {
  config?: AutoLoopConfig;
  state?: AutoLoopState;
  todoDriven?: boolean;
}

interface AutoLoopControlProps {
  sessionId: string | null;
  disabled?: boolean;
  sendMessage?: (message: { type: string; data: unknown }) => boolean;
  compact?: boolean;
}

const DEFAULT_CONFIG: AutoLoopConfig = {
  enabled: false,
  mode: 'ralph',
  ralphEnabled: false,
  pendingPlanConfirmation: false,
  prompt: '',
  maxRounds: 20,
  maxDurationMinutes: 120,
  similarityThreshold: 0.85,
  compareRounds: 3,
  pausedByUser: false,
};

export default function AutoLoopControl({ sessionId, disabled, compact = false }: AutoLoopControlProps) {
  const { t } = useI18n();
  const theme = useThemeConfig();
  const defaultConfig = useCallback(
    (): AutoLoopConfig => ({
      ...DEFAULT_CONFIG,
      prompt: t('autoLoop.defaultPrompt'),
    }),
    [t]
  );
  const [config, setConfig] = useState<AutoLoopConfig>(defaultConfig);
  const [state, setState] = useState<AutoLoopState>({ isRunning: false, currentRound: 0 });
  const [showConfig, setShowConfig] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [todoDriven, setTodoDriven] = useState(false);
  const toggleLabel = todoDriven ? t('autoLoop.toggleTodoAria') : t('autoLoop.toggleRalphAria');

  useEffect(() => {
    if (!sessionId) {
      setConfig(defaultConfig());
      setState({ isRunning: false, currentRound: 0 });
      setTodoDriven(false);
      return;
    }

    const loadConfig = async () => {
      try {
        const response = await fetch(`/api/sessions/${sessionId}/autoloop`);
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as AutoLoopResponse;
        if (data.config) {
          setConfig(data.config);
        }
        if (data.state) {
          setState(data.state);
        }
        setTodoDriven(data.todoDriven === true);
      } catch (error) {
        console.error('Failed to load auto loop config:', error);
      }
    };

    void loadConfig();
  }, [defaultConfig, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const interval = window.setInterval(() => {
      fetch(`/api/sessions/${sessionId}/autoloop`)
        .then((response) => response.json())
        .then((data: AutoLoopResponse) => {
          if (data.state) {
            setState(data.state);
          }
          setTodoDriven(data.todoDriven === true);
          if (data.config) {
            setConfig(data.config);
          }
        })
        .catch(() => undefined);
    }, 2000);

    return () => window.clearInterval(interval);
  }, [sessionId]);

  const updateConfig = useCallback(
    async (updates: Partial<AutoLoopConfig>) => {
      if (!sessionId || disabled) {
        return;
      }
      const nextConfig = { ...config, ...updates };
      setConfig(nextConfig);
      setIsSaving(true);
      try {
        const response = await fetch(`/api/sessions/${sessionId}/autoloop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        if (!response.ok) {
          throw new Error(`status=${response.status}`);
        }
        const data = (await response.json()) as AutoLoopResponse;
        if (data.config) {
          setConfig(data.config);
        }
        if (data.state) {
          setState(data.state);
        }
        setTodoDriven(data.todoDriven === true);
      } catch (error) {
        console.error('Failed to update auto loop config:', error);
      } finally {
        setIsSaving(false);
      }
    },
    [config, disabled, sessionId]
  );

  const toggleEnabled = useCallback(() => {
    void updateConfig({ enabled: !config.enabled });
  }, [config.enabled, updateConfig]);

  if (!sessionId) {
    if (compact) {
      return (
        <button
          type="button"
          disabled
          className="rounded-full border px-3 py-1.5 text-xs opacity-50"
          style={{
            borderColor: theme.colors.border.DEFAULT,
            color: theme.colors.text.muted,
            backgroundColor: theme.colors.bg.secondary,
          }}
        >
          {t('autoLoop.titleRalph')}
        </button>
      );
    }
    return <div className="rounded-xl border px-3 py-2 text-xs text-neutral-500">{t('autoLoop.selectSession')}</div>;
  }

  if (compact) {
    return (
      <div className="auto-loop-compact relative min-w-0">
        {showConfig && (
          <div
            className="auto-loop-popover absolute bottom-full right-0 z-30 mb-2 w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border p-3 shadow-2xl"
            style={{
              borderColor: theme.colors.border.DEFAULT,
              backgroundColor: theme.colors.bg.secondary,
              boxShadow: '0 18px 46px rgba(0, 0, 0, 0.42)',
            }}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold" style={{ color: theme.colors.text.primary }}>
                  {todoDriven ? t('autoLoop.titleTodo') : t('autoLoop.titleRalph')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowConfig(false)}
                className="rounded-lg border px-2 py-1 text-xs"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.secondary,
                  backgroundColor: theme.colors.bg.tertiary,
                }}
              >
                x
              </button>
            </div>

            <div className="space-y-3">
              {!todoDriven && (
                <div>
                  <label className="mb-1 block text-xs" style={{ color: theme.colors.text.secondary }}>
                    {t('autoLoop.loopPrompt')}
                  </label>
                  <textarea
                    value={config.prompt}
                    disabled={disabled}
                    onChange={(event) => {
                      void updateConfig({ prompt: event.target.value });
                    }}
                    className="h-20 w-full resize-none rounded-xl border p-2 text-xs outline-none"
                    style={{
                      borderColor: theme.colors.border.DEFAULT,
                      backgroundColor: theme.colors.bg.tertiary,
                      color: theme.colors.text.primary,
                    }}
                    placeholder={t('autoLoop.loopPromptPlaceholder')}
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs" style={{ color: theme.colors.text.secondary }}>
                  {t('autoLoop.maxRounds')}
                  <input
                    type="number"
                    value={config.maxRounds}
                    disabled={disabled}
                    onChange={(event) => {
                      void updateConfig({ maxRounds: parseInt(event.target.value, 10) || 20 });
                    }}
                    className="mt-1 w-full rounded-lg border p-2 text-xs outline-none"
                    style={{
                      borderColor: theme.colors.border.DEFAULT,
                      backgroundColor: theme.colors.bg.tertiary,
                      color: theme.colors.text.primary,
                    }}
                    min={1}
                    max={50}
                  />
                </label>
                <label className="text-xs" style={{ color: theme.colors.text.secondary }}>
                  {t('autoLoop.maxDurationMinutes')}
                  <input
                    type="number"
                    value={config.maxDurationMinutes}
                    disabled={disabled}
                    onChange={(event) => {
                      void updateConfig({ maxDurationMinutes: parseInt(event.target.value, 10) || 120 });
                    }}
                    className="mt-1 w-full rounded-lg border p-2 text-xs outline-none"
                    style={{
                      borderColor: theme.colors.border.DEFAULT,
                      backgroundColor: theme.colors.bg.tertiary,
                      color: theme.colors.text.primary,
                    }}
                    min={1}
                    max={600}
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        <div
          className="auto-loop-trigger inline-flex min-w-0 items-center gap-2 rounded-full border px-3 py-1.5"
          style={{
            borderColor: config.enabled ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
            backgroundColor: config.enabled ? `${theme.colors.primary.DEFAULT}18` : theme.colors.bg.secondary,
          }}
        >
          <button
            type="button"
            onClick={toggleEnabled}
            disabled={disabled || isSaving}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              config.enabled ? 'bg-orange-500' : 'bg-neutral-600'
            } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
            aria-label={toggleLabel}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                config.enabled ? 'translate-x-5' : 'translate-x-1'
              }`}
            />
          </button>
          <button
            type="button"
            onClick={() => setShowConfig((prev) => !prev)}
            disabled={disabled}
            className="min-w-0 truncate text-xs font-medium"
            style={{ color: config.enabled ? theme.colors.primary.DEFAULT : theme.colors.text.secondary }}
          >
            {todoDriven ? t('autoLoop.titleTodo') : t('autoLoop.titleRalph')}
            {state.isRunning ? ` ${t('autoLoop.round', { round: state.currentRound })}` : ''}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggleEnabled}
          disabled={disabled || isSaving}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            config.enabled ? 'bg-orange-500' : 'bg-neutral-300'
          } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
          aria-label={toggleLabel}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              config.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {todoDriven ? t('autoLoop.titleTodo') : t('autoLoop.titleRalph')}
            {state.isRunning && <span className="ml-2 text-orange-500">{t('autoLoop.round', { round: state.currentRound })}</span>}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setShowConfig((prev) => !prev)}
        className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        {showConfig ? t('autoLoop.hideSettings') : t('autoLoop.showSettings')}
      </button>

      {showConfig && (
        <div className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-800">
          <div className="space-y-3">
            {!todoDriven && (
              <div>
                <label className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t('autoLoop.loopPrompt')}</label>
                <textarea
                  value={config.prompt}
                  disabled={disabled}
                  onChange={(event) => {
                    void updateConfig({ prompt: event.target.value });
                  }}
                  className="h-24 w-full resize-none rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-900 dark:border-neutral-600 dark:bg-neutral-700 dark:text-white"
                  placeholder={t('autoLoop.loopPromptPlaceholder')}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t('autoLoop.maxRounds')}</label>
                <input
                  type="number"
                  value={config.maxRounds}
                  disabled={disabled}
                  onChange={(event) => {
                    void updateConfig({ maxRounds: parseInt(event.target.value, 10) || 20 });
                  }}
                  className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-900 dark:border-neutral-600 dark:bg-neutral-700 dark:text-white"
                  min={1}
                  max={50}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t('autoLoop.maxDurationMinutes')}</label>
                <input
                  type="number"
                  value={config.maxDurationMinutes}
                  disabled={disabled}
                  onChange={(event) => {
                    void updateConfig({ maxDurationMinutes: parseInt(event.target.value, 10) || 120 });
                  }}
                  className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-900 dark:border-neutral-600 dark:bg-neutral-700 dark:text-white"
                  min={1}
                  max={600}
                />
              </div>

              {!todoDriven && (
                <>
                  <div>
                    <label className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t('autoLoop.similarityThreshold')}</label>
                    <input
                      type="number"
                      value={config.similarityThreshold}
                      disabled={disabled}
                      onChange={(event) => {
                        void updateConfig({ similarityThreshold: parseFloat(event.target.value) || 0.85 });
                      }}
                      className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-900 dark:border-neutral-600 dark:bg-neutral-700 dark:text-white"
                      min={0}
                      max={1}
                      step={0.05}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t('autoLoop.compareRounds')}</label>
                    <input
                      type="number"
                      value={config.compareRounds}
                      disabled={disabled}
                      onChange={(event) => {
                        void updateConfig({ compareRounds: parseInt(event.target.value, 10) || 3 });
                      }}
                      className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-900 dark:border-neutral-600 dark:bg-neutral-700 dark:text-white"
                      min={2}
                      max={5}
                    />
                  </div>
                </>
              )}
            </div>

            {state.stopReason && (
              <div className="rounded bg-neutral-100 p-2 text-xs text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                {t('autoLoop.lastStopReason', { reason: state.stopReason })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
