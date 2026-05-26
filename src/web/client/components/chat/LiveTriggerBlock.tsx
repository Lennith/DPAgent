import { useThemeConfig } from '../providers/ThemeProvider.js';

interface LiveTriggerBlockProps {
  kind: 'memory' | 'skill';
  title: string;
  summary: string;
}

export function LiveTriggerBlock({ kind, title, summary }: LiveTriggerBlockProps) {
  const theme = useThemeConfig();
  const colors = kind === 'memory' ? theme.colors.thinking : theme.colors.toolCall;

  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{
        background: colors.bg,
        borderColor: colors.border,
      }}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-lg" style={{ color: colors.icon }}>
          {kind === 'memory' ? 'M' : 'S'}
        </span>
        <span className="font-medium text-sm" style={{ color: colors.text }}>
          {title}
        </span>
      </div>
      <div className="px-4 pb-4">
        <div
          className="text-xs overflow-hidden rounded-xl px-3 py-2 leading-relaxed"
          style={{
            backgroundColor: 'rgba(0,0,0,0.18)',
            color: theme.colors.text.secondary,
          }}
        >
          {summary}
        </div>
      </div>
    </div>
  );
}
