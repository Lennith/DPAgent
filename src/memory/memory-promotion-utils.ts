import * as path from 'node:path';
import type { MemoryPromotionState } from '../types.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
}

export function normalizeState(state: MemoryPromotionState | undefined): MemoryPromotionState {
  return {
    lastProcessedContextVersion: Math.max(0, Math.floor(state?.lastProcessedContextVersion ?? 0)),
    lastQueuedContextVersion: Math.max(0, Math.floor(state?.lastQueuedContextVersion ?? 0)),
    pendingTurnCount: Math.max(0, Math.floor(state?.pendingTurnCount ?? 0)),
    lastActivityAt: state?.lastActivityAt ?? nowIso(),
    lastProcessedAt: state?.lastProcessedAt,
    status: state?.status ?? 'idle',
    lastError: state?.lastError,
  };
}

export function normalizeWorkspacePathKey(workspaceDir: string | undefined): string {
  if (!workspaceDir) {
    return '';
  }
  const resolved = path.resolve(workspaceDir).replace(/\//g, path.sep);
  if (process.platform !== 'win32') {
    return resolved;
  }
  return resolved.toLowerCase();
}

export function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end < start) {
    return null;
  }
  return withoutFence.slice(start, end + 1);
}

export function normalizeConflictHints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((item) => String(item ?? '').trim())
        .filter((item) => item.length > 0)
        .slice(0, 6)
    )
  );
}
