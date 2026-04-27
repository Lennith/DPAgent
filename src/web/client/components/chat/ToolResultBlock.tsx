import React from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { summarizeToolResult } from './toolEventSummary.js';

interface ToolResultBlockProps {
  name: string;
  result: {
    success: boolean;
    content: string;
    error?: string;
  };
}

export function ToolResultBlock({ name, result }: ToolResultBlockProps) {
  const theme = useThemeConfig();
  const colors = result.success ? theme.colors.toolResult.success : theme.colors.toolResult.error;
  const summary = summarizeToolResult(name, result);

  return (
    <details
      className="group rounded-xl border overflow-hidden"
      style={{
        background: colors.bg,
        borderColor: colors.border,
      }}
    >
      <summary className="list-none cursor-pointer px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-semibold"
            style={{
              borderColor: colors.border,
              backgroundColor: `${colors.icon}14`,
              color: colors.text,
            }}
          >
            {result.success ? 'Tool Result' : 'Tool Error'}
          </span>
          <span className="shrink-0 font-mono text-xs" style={{ color: colors.text }}>
            {name}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs" style={{ color: theme.colors.text.secondary }}>
            {summary.subtitle || summary.title}
          </span>
          <span className="shrink-0 text-xs opacity-70 transition-transform group-open:rotate-90" style={{ color: theme.colors.text.muted }}>
            ›
          </span>
        </div>
      </summary>

      <div className="px-3 pb-3">
        <div className="mb-1.5 text-[11px] uppercase tracking-wide" style={{ color: theme.colors.text.muted }}>
          Details
        </div>
        <pre
          className="text-xs overflow-x-auto p-2.5 rounded-lg font-mono max-h-48 overflow-y-auto"
          style={{
            backgroundColor: 'rgba(0,0,0,0.2)',
            color: theme.colors.text.secondary,
          }}
        >
          {summary.detailText}
        </pre>
      </div>
    </details>
  );
}
