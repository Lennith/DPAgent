import React from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n } from '../../i18n/index.js';

export interface PendingPlanInputBannerItem {
  sessionId: string;
  sessionName: string;
  requestId: string;
}

interface PendingPlanInputBannerProps {
  items: PendingPlanInputBannerItem[];
  onOpenSession: (sessionId: string) => void;
}

export function PendingPlanInputBanner({ items, onOpenSession }: PendingPlanInputBannerProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="pending-plan-input-banner"
      className="border-b px-4 py-3 space-y-3"
      style={{
        borderColor: theme.colors.border.DEFAULT,
        backgroundColor: theme.colors.bg.secondary,
      }}
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold" style={{ color: theme.colors.text.primary }}>
          {t('app.pendingPlanInput.title', { count: items.length })}
        </div>
        <div className="text-xs mt-1" style={{ color: theme.colors.text.muted }}>
          {t('app.pendingPlanInput.subtitle')}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <button
            key={`${item.sessionId}:${item.requestId}`}
            type="button"
            data-testid={`pending-plan-input-open-${item.sessionId}`}
            onClick={() => onOpenSession(item.sessionId)}
            className="min-w-0 rounded-xl border px-3 py-2 text-left"
            style={{
              borderColor: theme.colors.border.DEFAULT,
              backgroundColor: theme.colors.bg.tertiary,
            }}
            title={`${item.sessionName} · ${item.requestId}`}
          >
            <div className="truncate text-sm font-medium" style={{ color: theme.colors.text.primary }}>
              {item.sessionName}
            </div>
            <div className="truncate text-[11px] font-mono mt-0.5" style={{ color: theme.colors.text.muted }}>
              {t('app.pendingPlanInput.requestId', { requestId: item.requestId })}
            </div>
            <div className="text-xs mt-1" style={{ color: theme.colors.primary.DEFAULT }}>
              {t('app.pendingPlanInput.openSession')}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
