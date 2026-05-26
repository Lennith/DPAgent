import { useThemeConfig } from '../providers/ThemeProvider.js';
import type { DownloadAttachmentView } from './downloadAttachment.js';

interface DownloadAttachmentBlockProps {
  attachments: DownloadAttachmentView[];
}

function formatBytes(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return '';
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function formatExpiresAt(value: string | undefined): string {
  if (!value) {
    return '';
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  return `Expires ${new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

export function DownloadAttachmentBlock({ attachments }: DownloadAttachmentBlockProps) {
  const theme = useThemeConfig();
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2" data-download-attachments="true">
      {attachments.map((attachment) => {
        const size = formatBytes(attachment.size);
        const expiresAt = formatExpiresAt(attachment.expiresAt);
        const detail = [size, expiresAt].filter(Boolean).join(' | ');
        return (
          <a
            key={`${attachment.href}-${attachment.displayPath}`}
            href={attachment.href}
            className="group flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 no-underline shadow-sm transition-colors"
            style={{
              backgroundColor: theme.colors.bg.secondary,
              borderColor: theme.colors.border.DEFAULT,
              color: theme.colors.text.primary,
            }}
            data-download-attachment-link="true"
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold"
              style={{
                backgroundColor: `${theme.colors.primary.DEFAULT}12`,
                borderColor: `${theme.colors.primary.DEFAULT}44`,
                color: theme.colors.primary.DEFAULT,
              }}
              aria-hidden="true"
            >
              DL
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" title={attachment.displayPath}>
                {attachment.displayPath}
              </span>
              {detail ? (
                <span className="mt-0.5 block truncate text-xs" style={{ color: theme.colors.text.muted }}>
                  {detail}
                </span>
              ) : null}
            </span>
            <span
              className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                color: theme.colors.text.secondary,
              }}
            >
              Download
            </span>
          </a>
        );
      })}
    </div>
  );
}
