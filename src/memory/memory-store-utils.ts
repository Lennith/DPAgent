import * as crypto from 'node:crypto';
import * as path from 'node:path';

export function nowIso(): string {
  return new Date().toISOString();
}

export function hashText(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
}

export function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function normalizeWorkspacePathForIdentity(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\//g, path.sep);
  if (process.platform !== 'win32') {
    return resolved;
  }
  return resolved.toLowerCase();
}
