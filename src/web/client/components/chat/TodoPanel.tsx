import React from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n } from '../../i18n/index.js';

export interface TodoPanelItem {
  id: string;
  work: string;
  detectionStandard: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'completed';
  priority: 'low' | 'medium' | 'high';
  blockedReason?: string;
  completionTaskId?: string;
  evidence?: string[];
  createdAt: string;
  updatedAt: string;
}

interface TodoPanelProps {
  items: TodoPanelItem[];
  compact?: boolean;
}

function StatusBadge({
  label,
  color,
  background,
  border,
}: {
  label: string;
  color: string;
  background: string;
  border: string;
}) {
  return (
    <span
      className="rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap"
      style={{
        borderColor: border,
        color,
        backgroundColor: background,
      }}
    >
      {label}
    </span>
  );
}

function sortTodoItems(items: TodoPanelItem[]): TodoPanelItem[] {
  const order: Record<TodoPanelItem['status'], number> = {
    in_progress: 0,
    blocked: 1,
    pending: 2,
    completed: 3,
  };
  return [...items].sort((left, right) => {
    const byStatus = order[left.status] - order[right.status];
    if (byStatus !== 0) {
      return byStatus;
    }
    return String(left.updatedAt).localeCompare(String(right.updatedAt));
  });
}

export function TodoPanel({ items, compact = false }: TodoPanelProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const unfinished = items.filter((item) => item.status !== 'completed');
  const orderedItems = sortTodoItems(items);

  if (items.length === 0) {
    return null;
  }

  const renderStatusBadge = (item: TodoPanelItem) => {
    if (item.status === 'in_progress') {
      return (
        <StatusBadge
          label={t('todo.status.inProgress')}
          border={theme.colors.primary.DEFAULT}
          color={theme.colors.primary.DEFAULT}
          background={`${theme.colors.primary.DEFAULT}12`}
        />
      );
    }
    if (item.status === 'blocked') {
      return (
        <StatusBadge
          label={t('todo.status.blocked')}
          border={theme.colors.toolResult.error.border}
          color={theme.colors.toolResult.error.text}
          background={theme.colors.toolResult.error.bg}
        />
      );
    }
    if (item.status === 'completed') {
      return (
        <StatusBadge
          label={t('todo.status.completed')}
          border="rgba(34, 197, 94, 0.45)"
          color="#16a34a"
          background="rgba(34, 197, 94, 0.12)"
        />
      );
    }
    return (
      <StatusBadge
        label={t('todo.status.pending')}
        border={theme.colors.border.DEFAULT}
        color={theme.colors.text.muted}
        background={theme.colors.bg.tertiary}
      />
    );
  };

  return (
    <div
      data-testid="todo-panel"
      className={compact ? 'space-y-2' : 'mx-2 mt-2 rounded-xl border p-3'}
      style={{
        borderColor: compact ? undefined : theme.colors.border.DEFAULT,
        backgroundColor: compact ? undefined : theme.colors.bg.secondary,
      }}
    >
      {!compact && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold leading-5" style={{ color: theme.colors.text.primary }}>
            {t('todo.title')}
          </p>
          <span
            className="rounded-full border px-2.5 py-1 text-[11px] font-medium"
            style={{
              borderColor: unfinished.length > 0 ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
              color: unfinished.length > 0 ? theme.colors.primary.DEFAULT : theme.colors.text.muted,
              backgroundColor: unfinished.length > 0 ? `${theme.colors.primary.DEFAULT}12` : theme.colors.bg.tertiary,
            }}
          >
            {t('todo.openCount', { count: unfinished.length })}
          </span>
        </div>
      )}

      <div className={`${compact ? '' : 'mt-2'} space-y-2`}>
        {orderedItems.map((item) => {
          const isBlocked = item.status === 'blocked';
          const isCompleted = item.status === 'completed';
          return (
            <div
              key={item.id}
              className="rounded-lg border px-3 py-2"
              style={{
                borderColor: isBlocked ? theme.colors.toolResult.error.border : theme.colors.border.DEFAULT,
                backgroundColor: isBlocked ? theme.colors.toolResult.error.bg : theme.colors.bg.primary,
                opacity: isCompleted ? 0.78 : 1,
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0" style={{ overflowWrap: 'anywhere' }}>
                  <div
                    className="text-sm font-medium leading-5"
                    style={{
                      color: isBlocked
                        ? theme.colors.toolResult.error.text
                        : isCompleted
                          ? theme.colors.text.secondary
                          : theme.colors.text.primary,
                    }}
                  >
                    {item.work}
                  </div>
                  <div
                    className="text-xs leading-5"
                    style={{
                      color: isBlocked ? theme.colors.toolResult.error.text : theme.colors.text.secondary,
                    }}
                  >
                    {isBlocked
                      ? t('todo.blockedReason', {
                          value: item.blockedReason || t('todo.blockedReasonMissing'),
                        })
                      : t('todo.detectionStandard', { value: item.detectionStandard })}
                  </div>
                </div>
                {renderStatusBadge(item)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
