import React from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';

export interface MemoryOrganizeControlProps {
  sessionId: string | null;
  pendingCount: number;
  isLoading: boolean;
  error: string | null;
  onOrganize: () => void;
}

function resolveButtonLabel(pendingCount: number, isLoading: boolean, error: string | null): string {
  if (isLoading) {
    return 'Organizing...';
  }
  if (error) {
    return 'Retry organize';
  }
  if (pendingCount === 0) {
    return 'No memory to organize';
  }
  return 'Organize memory';
}

function resolveStatusText(pendingCount: number, isLoading: boolean, error: string | null): string {
  if (isLoading) {
    return 'Organizing current session turns into durable memory.';
  }
  if (error) {
    return `Last organize failed: ${error}`;
  }
  if (pendingCount === 0) {
    return 'No pending session turns for this session.';
  }
  if (pendingCount === 1) {
    return '1 committed turn is ready for memory organize.';
  }
  return `${pendingCount} committed turns are ready for memory organize.`;
}

export function MemoryOrganizeControl({
  sessionId,
  pendingCount,
  isLoading,
  error,
  onOrganize,
}: MemoryOrganizeControlProps) {
  const theme = useThemeConfig();
  const canRetry = Boolean(error) && !isLoading;
  const effectiveDisabled = !sessionId || isLoading || (!canRetry && pendingCount === 0);
  const hasRetry = Boolean(error) && !isLoading;
  const statusText = resolveStatusText(pendingCount, isLoading, error);
  const buttonLabel = resolveButtonLabel(pendingCount, isLoading, error);

  return (
    <div
      className="rounded-2xl border px-3 py-3 space-y-2"
      style={{
        borderColor: theme.colors.border.DEFAULT,
        backgroundColor: theme.colors.bg.secondary,
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
            Memory Organize
          </div>
          <div className="text-xs mt-1" style={{ color: theme.colors.text.secondary }}>
            {statusText}
          </div>
        </div>
        <span
          className="shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium"
          style={{
            borderColor: pendingCount > 0 ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
            color: pendingCount > 0 ? theme.colors.primary.DEFAULT : theme.colors.text.muted,
            backgroundColor: pendingCount > 0 ? `${theme.colors.primary.DEFAULT}12` : theme.colors.bg.tertiary,
          }}
        >
          {pendingCount}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={onOrganize}
          disabled={effectiveDisabled}
          className="rounded-xl px-3 py-2 text-xs font-medium border transition-opacity disabled:opacity-50"
          style={{
            borderColor: hasRetry ? theme.colors.toolResult.error.border : theme.colors.border.DEFAULT,
            color: hasRetry ? theme.colors.toolResult.error.text : theme.colors.text.primary,
            backgroundColor: hasRetry ? theme.colors.toolResult.error.bg : theme.colors.bg.primary,
          }}
        >
          {buttonLabel}
        </button>
        {sessionId ? (
          <span className="text-[11px]" style={{ color: theme.colors.text.muted }}>
            Current session only
          </span>
        ) : (
          <span className="text-[11px]" style={{ color: theme.colors.text.muted }}>
            Select a session to organize memory
          </span>
        )}
      </div>
    </div>
  );
}
