import type { ToolResult } from '../../chat-types.js';

export interface DownloadAttachmentView {
  href: string;
  displayPath: string;
  filename: string;
  size?: number;
  expiresAt?: string;
}

export function isSendFileToUserToolResult(toolResult?: ToolResult): boolean {
  return toolResult?.name === 'send_file_to_user';
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function parseSendFileToUserResult(toolResult: ToolResult): DownloadAttachmentView | null {
  if (!isSendFileToUserToolResult(toolResult) || toolResult.result.success !== true) {
    return null;
  }
  const parsed = parseJsonRecord(toolResult.result.content);
  if (!parsed) {
    return null;
  }
  const href = readString(parsed, 'href');
  const displayPath = readString(parsed, 'displayPath');
  const filename = readString(parsed, 'filename');
  if (!href || !displayPath) {
    return null;
  }
  const size = typeof parsed.size === 'number' && Number.isFinite(parsed.size) ? parsed.size : undefined;
  const expiresAt = readString(parsed, 'expiresAt') || undefined;
  return {
    href,
    displayPath,
    filename: filename || displayPath,
    size,
    expiresAt,
  };
}

export function collectDownloadAttachments(toolResults?: ToolResult[]): DownloadAttachmentView[] {
  if (!toolResults || toolResults.length === 0) {
    return [];
  }
  return toolResults
    .map((toolResult) => parseSendFileToUserResult(toolResult))
    .filter((attachment): attachment is DownloadAttachmentView => attachment !== null);
}
