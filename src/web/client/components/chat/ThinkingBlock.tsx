import React from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';

interface ThinkingBlockProps {
  thinking: string;
  isStreaming?: boolean;
}

export function ThinkingBlock({ thinking, isStreaming = false }: ThinkingBlockProps) {
  const theme = useThemeConfig();
  const [isExpanded, setIsExpanded] = React.useState(true);

  return (
    <div
      className={`
        min-w-0 rounded-2xl border overflow-hidden
        transition-all duration-300
      `}
      style={{
        background: theme.colors.thinking.bg,
        borderColor: theme.colors.thinking.border,
      }}
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-black/5 transition-colors"
      >
        <div className="relative flex h-4 w-4 items-center justify-center">
          <span
            className="inline-flex h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: theme.colors.thinking.icon }}
          />
          {isStreaming && (
            <span
              className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full opacity-50"
              style={{ backgroundColor: theme.colors.thinking.icon }}
            />
          )}
        </div>

        <span className="font-medium text-sm" style={{ color: theme.colors.thinking.text }}>
          {isStreaming ? 'Thinking...' : 'Thought Process'}
        </span>

        <svg
          className={`
            ml-auto w-4 h-4 transition-transform duration-300
            ${isExpanded ? 'rotate-180' : ''}
          `}
          style={{ color: theme.colors.thinking.icon }}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <div
        className={`
          overflow-hidden transition-all duration-300
          ${isExpanded ? 'max-h-[min(72vh,2400px)] opacity-100 overflow-y-auto' : 'max-h-0 opacity-0'}
        `}
      >
        <div className="min-w-0 px-4 pb-4">
          <pre
            className="min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words text-sm font-sans leading-relaxed"
            style={{
              color: theme.colors.text.secondary,
              overflowWrap: 'anywhere',
            }}
          >
            {thinking}
          </pre>
        </div>
      </div>
    </div>
  );
}
