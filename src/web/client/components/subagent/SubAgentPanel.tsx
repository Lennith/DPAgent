import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemeConfig } from '../../styles/theme/index.js';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n, type TranslationKey } from '../../i18n/index.js';

export interface SubAgentStatusItem {
  subagentId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timeout';
  runSeq: number;
  updatedAt: string;
  queuePosition?: number;
  lastError?: string;
  latestResult?: {
    summary: string;
    status: string;
  };
}

interface SubAgentPanelProps {
  sessionId: string | null;
  onHide?: () => void;
  title?: string;
  onCancelSubagent?: (subagentId: string) => void;
  onRetrySubagent?: (subagentId: string) => void;
  onResumeSubagent?: (subagentId: string) => void;
  initialItems?: SubAgentStatusItem[];
  initialExpandedId?: string | null;
}

interface StatusVisual {
  label: string;
  background: string;
  color: string;
  borderColor: string;
  dot: string;
}

const STATUS_ORDER: Record<SubAgentStatusItem['status'], number> = {
  running: 0,
  queued: 1,
  failed: 2,
  timeout: 2,
  canceled: 2,
  succeeded: 3,
};

function statusVisual(
  status: SubAgentStatusItem['status'],
  theme: ThemeConfig,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
): StatusVisual {
  switch (status) {
    case 'running':
      return {
        label: t('subagent.status.running'),
        background: theme.colors.thinking.bg,
        color: theme.colors.thinking.text,
        borderColor: theme.colors.thinking.border,
        dot: theme.colors.thinking.text,
      };
    case 'queued':
      return {
        label: t('subagent.status.queued'),
        background: theme.colors.toolCall.bg,
        color: theme.colors.toolCall.text,
        borderColor: theme.colors.toolCall.border,
        dot: theme.colors.toolCall.text,
      };
    case 'succeeded':
      return {
        label: t('subagent.status.succeeded'),
        background: theme.colors.toolResult.success.bg,
        color: theme.colors.toolResult.success.text,
        borderColor: theme.colors.toolResult.success.border,
        dot: theme.colors.toolResult.success.text,
      };
    case 'failed':
    case 'timeout':
      return {
        label: status === 'failed' ? t('subagent.status.failed') : t('subagent.status.timeout'),
        background: theme.colors.toolResult.error.bg,
        color: theme.colors.toolResult.error.text,
        borderColor: theme.colors.toolResult.error.border,
        dot: theme.colors.toolResult.error.text,
      };
    case 'canceled':
      return {
        label: t('subagent.status.canceled'),
        background: theme.colors.bg.tertiary,
        color: theme.colors.text.muted,
        borderColor: theme.colors.border.DEFAULT,
        dot: theme.colors.text.muted,
      };
    default:
      return {
        label: status,
        background: theme.colors.bg.tertiary,
        color: theme.colors.text.muted,
        borderColor: theme.colors.border.DEFAULT,
        dot: theme.colors.text.muted,
      };
  }
}

function formatTime(value?: string): string {
  if (!value) {
    return '--';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatElapsedTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) {
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
}

function shortSessionId(sessionId: string | null): string {
  if (!sessionId) {
    return '';
  }
  if (sessionId.length <= 18) {
    return sessionId;
  }
  return `${sessionId.slice(0, 12)}...${sessionId.slice(-4)}`;
}

export function SubAgentPanel({
  sessionId,
  onHide,
  title,
  onCancelSubagent,
  onRetrySubagent,
  onResumeSubagent,
  initialItems,
  initialExpandedId = null,
}: SubAgentPanelProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const [items, setItems] = useState<SubAgentStatusItem[]>(() => initialItems ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, 'cancel' | 'retry' | 'resume'>>({});
  const [draftSaved, setDraftSaved] = useState<Record<string, boolean>>({});
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId);
  const [elapsedTimes, setElapsedTimes] = useState<Record<string, number>>({});
  const startTimesRef = useRef<Record<string, number>>({});

  const controlledByInitialItems = initialItems !== undefined;
  const hasRunning = useMemo(() => items.some((item) => item.status === 'running' || item.status === 'queued'), [items]);
  const headerBackground = theme.colors.bg.gradient;

  useEffect(() => {
    if (initialItems !== undefined) {
      setItems(initialItems);
    }
  }, [initialItems]);

  useEffect(() => {
    setExpandedId(initialExpandedId);
  }, [initialExpandedId]);

  useEffect(() => {
    if (!hasRunning) {
      setElapsedTimes({});
      return;
    }

    const interval = setInterval(() => {
      setElapsedTimes((prev) => {
        const next = { ...prev };
        items.forEach((item) => {
          if (item.status === 'running' || item.status === 'queued') {
            if (!startTimesRef.current[item.subagentId]) {
              startTimesRef.current[item.subagentId] = Date.now();
            }
            next[item.subagentId] = Math.floor((Date.now() - startTimesRef.current[item.subagentId]) / 1000);
          } else {
            delete startTimesRef.current[item.subagentId];
          }
        });
        return next;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [hasRunning, items]);

  const loadItems = useCallback(async () => {
    if (controlledByInitialItems) {
      return;
    }
    if (!sessionId) {
      setItems([]);
      setError(null);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/subagents`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as { items?: SubAgentStatusItem[] };
      setItems(Array.isArray(data.items) ? data.items : []);
      setError(null);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setError(t('subagent.failedLoad', { message }));
    } finally {
      setLoading(false);
    }
  }, [controlledByInitialItems, sessionId, t]);

  const runAction = useCallback(
    async (subagentId: string, action: 'cancel' | 'retry' | 'resume') => {
      const externalHandler =
        action === 'cancel' ? onCancelSubagent : action === 'retry' ? onRetrySubagent : onResumeSubagent;
      if (externalHandler) {
        externalHandler(subagentId);
        return;
      }
      if (!sessionId) {
        return;
      }
      setActionLoading((prev) => ({ ...prev, [subagentId]: action }));
      try {
        const response = await fetch(`/api/sessions/${sessionId}/subagents/${subagentId}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        if (action === 'cancel') {
          setDraftSaved((prev) => ({ ...prev, [subagentId]: true }));
        }
        if (action === 'resume') {
          setDraftSaved((prev) => {
            const next = { ...prev };
            delete next[subagentId];
            return next;
          });
        }
        await loadItems();
      } catch (actionError) {
        console.error(`Failed to ${action} subagent:`, actionError);
      } finally {
        setActionLoading((prev) => {
          const next = { ...prev };
          delete next[subagentId];
          return next;
        });
      }
    },
    [loadItems, onCancelSubagent, onResumeSubagent, onRetrySubagent, sessionId]
  );

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (!sessionId || controlledByInitialItems) {
      return;
    }
    const intervalMs = hasRunning ? 1000 : 5000;
    const timer = setInterval(() => {
      void loadItems();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [controlledByInitialItems, sessionId, hasRunning, loadItems]);

  const metrics = useMemo(
    () => ({
      running: items.filter((item) => item.status === 'running').length,
      queued: items.filter((item) => item.status === 'queued').length,
      needsAction: items.filter((item) => ['failed', 'timeout', 'canceled'].includes(item.status)).length,
      done: items.filter((item) => item.status === 'succeeded').length,
    }),
    [items]
  );

  const sortedItems = useMemo(
    () =>
      [...items].sort((a, b) => {
        const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (byStatus !== 0) {
          return byStatus;
        }
        return b.runSeq - a.runSeq;
      }),
    [items]
  );

  const renderMetric = (labelKey: TranslationKey, value: number) => (
    <div
      className="rounded-2xl border px-2.5 py-2"
      style={{
        borderColor: theme.colors.border.DEFAULT,
        backgroundColor: theme.colors.bg.tertiary,
        boxShadow: theme.shadows.sm,
      }}
    >
      <div className="text-base font-semibold leading-none" style={{ color: theme.colors.text.primary }}>
        {value}
      </div>
      <div className="mt-1 truncate text-[10px] uppercase tracking-[0.08em]" style={{ color: theme.colors.text.muted }}>
        {t(labelKey)}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ backgroundColor: 'transparent' }}>
      <div
        className="flex h-[var(--app-chrome-header-height)] shrink-0 flex-col justify-center border-b px-4"
        data-testid="subagent-header"
        style={{
          borderColor: theme.colors.border.DEFAULT,
          background: headerBackground,
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-semibold leading-tight" style={{ color: theme.colors.text.primary }}>
              {title ?? t('subagent.dashboardTitle')}
            </p>
            <p className="mt-1 truncate font-mono text-[11px]" style={{ color: theme.colors.text.muted }}>
              {sessionId ? t('subagent.session', { id: shortSessionId(sessionId) }) : t('subagent.noSession')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void loadItems()}
              className="rounded-xl border px-2.5 py-1.5 text-xs transition-colors"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                color: theme.colors.text.secondary,
                backgroundColor: theme.colors.bg.tertiary,
              }}
            >
              {t('subagent.refresh')}
            </button>
            {onHide && (
              <button
                type="button"
                onClick={onHide}
                className="rounded-xl border px-2.5 py-1.5 text-xs transition-colors"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.secondary,
                  backgroundColor: theme.colors.bg.tertiary,
                }}
              >
                {t('app.subagent.hidePanel')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="subagent-metric-grid grid grid-cols-4 gap-2">
          {renderMetric('subagent.metric.running', metrics.running)}
          {renderMetric('subagent.metric.queued', metrics.queued)}
          {renderMetric('subagent.metric.needsAction', metrics.needsAction)}
          {renderMetric('subagent.metric.done', metrics.done)}
        </div>

        <div className="mt-3 space-y-2.5">
          {!sessionId && (
            <div
              className="rounded-2xl border p-3 text-xs"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.secondary,
                color: theme.colors.text.muted,
              }}
            >
              {t('subagent.selectSession')}
            </div>
          )}

          {sessionId && loading && sortedItems.length === 0 && (
            <div
              className="rounded-2xl border p-3 text-xs"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.secondary,
                color: theme.colors.text.muted,
              }}
            >
              {t('subagent.loading')}
            </div>
          )}

          {sessionId && error && (
            <div
              className="rounded-2xl border p-3 text-xs"
              style={{
                borderColor: theme.colors.toolResult.error.border,
                background: theme.colors.toolResult.error.bg,
                color: theme.colors.toolResult.error.text,
              }}
            >
              {error}
            </div>
          )}

          {sessionId && !loading && sortedItems.length === 0 && !error && (
            <div
              className="rounded-2xl border p-3 text-xs"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.secondary,
                color: theme.colors.text.muted,
              }}
            >
              {t('subagent.noTasks')}
            </div>
          )}

          {sortedItems.map((item) => {
            const visual = statusVisual(item.status, theme, t);
            const isCancellable = item.status === 'running' || item.status === 'queued';
            const isRetryable = item.status === 'failed' || item.status === 'timeout';
            const isResumable = item.status === 'canceled';
            const isDraftSaved = draftSaved[item.subagentId];
            const isActionLoading = actionLoading[item.subagentId];
            const elapsedSecs = elapsedTimes[item.subagentId] || 0;
            const summary = item.latestResult?.summary || item.lastError || t('subagent.waitingForResult');
            const expanded = expandedId === item.subagentId;

            return (
              <div
                key={`${item.subagentId}-${item.runSeq}`}
                role="button"
                tabIndex={0}
                onClick={() => setExpandedId((prev) => (prev === item.subagentId ? null : item.subagentId))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setExpandedId((prev) => (prev === item.subagentId ? null : item.subagentId));
                  }
                }}
                className="block w-full cursor-pointer rounded-2xl border p-3 text-left transition-all duration-200 hover:-translate-y-[1px]"
                style={{
                  borderColor: expanded ? visual.borderColor : theme.colors.border.DEFAULT,
                  backgroundColor: theme.colors.bg.secondary,
                  boxShadow: expanded ? theme.shadows.lg : theme.shadows.sm,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${item.status === 'running' ? 'animate-pulse' : ''}`}
                      style={{ backgroundColor: visual.dot }}
                    />
                    <span className="truncate text-xs font-semibold" style={{ color: theme.colors.text.primary }}>
                      {item.subagentId}
                    </span>
                  </div>
                  <span
                    className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium"
                    style={{
                      background: visual.background,
                      borderColor: visual.borderColor,
                      color: visual.color,
                    }}
                  >
                    {visual.label}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: theme.colors.text.muted }}>
                  <span>{t('subagent.runSeq', { seq: item.runSeq })}</span>
                  {(item.status === 'running' || item.status === 'queued') && elapsedSecs > 0 && (
                    <span style={{ color: theme.colors.toolCall.text }}>{formatElapsedTime(elapsedSecs)}</span>
                  )}
                  {typeof item.queuePosition === 'number' && (
                    <span>{t('subagent.queuePosition', { position: item.queuePosition })}</span>
                  )}
                  {isDraftSaved && <span title={t('subagent.draftSavedTooltip')}>{t('subagent.draftSaved')}</span>}
                </div>

                <p
                  className={`mt-2 text-xs leading-relaxed ${expanded ? 'whitespace-pre-wrap' : 'truncate'}`}
                  style={{ color: theme.colors.text.secondary, overflowWrap: expanded ? 'anywhere' : undefined }}
                >
                  {summary}
                </p>

                {(isCancellable || isRetryable || isResumable) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
                    {isCancellable && (
                      <button
                        type="button"
                        onClick={() => void runAction(item.subagentId, 'cancel')}
                        disabled={isActionLoading === 'cancel'}
                        className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-all"
                        style={{
                          borderColor: theme.colors.toolResult.error.border,
                          backgroundColor: theme.colors.bg.tertiary,
                          color: theme.colors.toolResult.error.text,
                          opacity: isActionLoading === 'cancel' ? 0.7 : 1,
                        }}
                      >
                        {isActionLoading === 'cancel' ? t('subagent.canceling') : t('subagent.cancel')}
                      </button>
                    )}
                    {isRetryable && (
                      <button
                        type="button"
                        onClick={() => void runAction(item.subagentId, 'retry')}
                        disabled={isActionLoading === 'retry'}
                        className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-all"
                        style={{
                          borderColor: theme.colors.toolCall.border,
                          backgroundColor: theme.colors.bg.tertiary,
                          color: theme.colors.toolCall.text,
                          opacity: isActionLoading === 'retry' ? 0.7 : 1,
                        }}
                      >
                        {isActionLoading === 'retry' ? t('subagent.retrying') : t('subagent.retry')}
                      </button>
                    )}
                    {isResumable && (
                      <button
                        type="button"
                        onClick={() => void runAction(item.subagentId, 'resume')}
                        disabled={isActionLoading === 'resume'}
                        className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-all"
                        style={{
                          borderColor: theme.colors.thinking.border,
                          backgroundColor: theme.colors.bg.tertiary,
                          color: theme.colors.thinking.text,
                          opacity: isActionLoading === 'resume' ? 0.7 : 1,
                        }}
                      >
                        {isActionLoading === 'resume' ? t('subagent.resuming') : t('subagent.resume')}
                      </button>
                    )}
                  </div>
                )}

                {expanded && (
                  <div
                    className="mt-3 rounded-xl border p-2.5 text-[11px] leading-5"
                    style={{
                      borderColor: theme.colors.border.DEFAULT,
                      backgroundColor: theme.colors.bg.tertiary,
                      color: theme.colors.text.muted,
                    }}
                  >
                    <div>{t('subagent.updatedAt', { time: formatTime(item.updatedAt) })}</div>
                    {item.latestResult?.status && <div>{t('subagent.resultStatus', { status: item.latestResult.status })}</div>}
                    {item.lastError && <div style={{ color: theme.colors.toolResult.error.text }}>{item.lastError}</div>}
                    <div>{expanded ? t('subagent.details.hide') : t('subagent.details.show')}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
