import React from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n } from '../../i18n/index.js';

export interface GovernanceAuditListItem {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  status: 'info' | 'success' | 'warning';
  createdAt: string;
}

interface GovernanceAuditListProps {
  items: GovernanceAuditListItem[];
}

function statusColors(
  status: GovernanceAuditListItem['status'],
  theme: ReturnType<typeof useThemeConfig>
) {
  if (status === 'success') {
    return theme.colors.toolResult.success;
  }
  if (status === 'warning') {
    return theme.colors.toolCall;
  }
  return theme.colors.thinking;
}

export function GovernanceAuditList({ items }: GovernanceAuditListProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();

  return (
    <div className="h-full flex flex-col">
      <div
        className="px-4 py-3 border-b"
        style={{
          borderColor: theme.colors.border.DEFAULT,
          backgroundColor: theme.colors.bg.secondary,
        }}
      >
        <p className="text-sm font-semibold" style={{ color: theme.colors.text.primary }}>
          {t('subagent.audit.title')}
        </p>
        <p className="text-xs" style={{ color: theme.colors.text.muted }}>
          {t('subagent.audit.subtitle')}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {items.length === 0 ? (
          <div
            className="rounded-xl border p-3 text-xs"
            style={{
              borderColor: theme.colors.border.DEFAULT,
              backgroundColor: theme.colors.bg.secondary,
              color: theme.colors.text.muted,
            }}
          >
            {t('subagent.audit.empty')}
          </div>
        ) : (
          items.map((item) => {
            const colors = statusColors(item.status, theme);
            return (
              <div
                key={item.id}
                className="rounded-xl border p-3"
                style={{
                  borderColor: colors.border,
                  backgroundColor: colors.bg,
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs font-medium leading-relaxed" style={{ color: colors.text }}>
                    {item.title}
                  </div>
                  <span className="shrink-0 text-[10px]" style={{ color: theme.colors.text.muted }}>
                    {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                {item.detail && (
                  <div className="mt-1 text-[11px] leading-relaxed" style={{ color: theme.colors.text.secondary }}>
                    {item.detail}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
