import { useThemeConfig } from '../providers/ThemeProvider.js';
import { summarizeToolCall } from './toolEventSummary.js';
import { FinalizedPlanCard, normalizeFinalizedPlanView } from './FinalizedPlanCard.js';

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
}

export function ToolCallBlock({ name, args }: ToolCallBlockProps) {
  const theme = useThemeConfig();
  const summary = summarizeToolCall(name, args);
  const finalizedPlan = name.trim() === 'finalize_plan' ? normalizeFinalizedPlanView(args) : null;

  if (finalizedPlan) {
    return (
      <div className="space-y-2">
        <FinalizedPlanCard plan={finalizedPlan} />
        <details
          className="group rounded-xl border overflow-hidden"
          style={{
            background: theme.colors.toolCall.bg,
            borderColor: theme.colors.toolCall.border,
          }}
        >
          <summary className="list-none cursor-pointer px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-semibold"
                style={{
                  borderColor: theme.colors.toolCall.border,
                  backgroundColor: `${theme.colors.toolCall.icon}14`,
                  color: theme.colors.toolCall.text,
                }}
              >
                Tool Call
              </span>
              <span className="shrink-0 font-mono text-xs" style={{ color: theme.colors.toolCall.text }}>
                {name}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs" style={{ color: theme.colors.text.secondary }}>
                Raw payload
              </span>
              <span className="shrink-0 text-xs opacity-70 transition-transform group-open:rotate-90" style={{ color: theme.colors.text.muted }}>
                {'>'}
              </span>
            </div>
          </summary>

          <div className="px-3 pb-3">
            <div className="mb-1.5 text-[11px] uppercase tracking-wide" style={{ color: theme.colors.text.muted }}>
              Raw payload
            </div>
            <pre
              className="text-xs overflow-x-auto p-2.5 rounded-lg font-mono max-h-40 overflow-y-auto"
              style={{
                backgroundColor: 'rgba(0,0,0,0.2)',
                color: theme.colors.text.secondary,
              }}
            >
              {summary.detailJson}
            </pre>
          </div>
        </details>
      </div>
    );
  }

  return (
    <details
      className="group rounded-xl border overflow-hidden"
      style={{
        background: theme.colors.toolCall.bg,
        borderColor: theme.colors.toolCall.border,
      }}
    >
      <summary className="list-none cursor-pointer px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-semibold"
            style={{
              borderColor: theme.colors.toolCall.border,
              backgroundColor: `${theme.colors.toolCall.icon}14`,
              color: theme.colors.toolCall.text,
            }}
          >
            Tool Call
          </span>
          <span className="shrink-0 font-mono text-xs" style={{ color: theme.colors.toolCall.text }}>
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
          Arguments
        </div>
        <pre
          className="text-xs overflow-x-auto p-2.5 rounded-lg font-mono max-h-40 overflow-y-auto"
          style={{
            backgroundColor: 'rgba(0,0,0,0.2)',
            color: theme.colors.text.secondary,
          }}
        >
          {summary.detailJson}
        </pre>
      </div>
    </details>
  );
}
