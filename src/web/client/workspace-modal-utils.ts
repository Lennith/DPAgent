import type { SessionInfo } from './app-shell-types.js';
import { getSessionSortTimestamp } from './app-shell-types.js';
import { normalizeWorkspaceDir } from './workspace-preferences.js';

interface FileWithOptionalPath extends File {
  path?: string;
}

function pathDedupeKey(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
    return value.toLowerCase();
  }
  return value;
}

export function collectRecentWorkspaceDirsFromSessions(
  sessions: SessionInfo[],
  limit = 3
): string[] {
  if (limit <= 0 || sessions.length === 0) {
    return [];
  }
  const sorted = [...sessions].sort(
    (left, right) => getSessionSortTimestamp(right) - getSessionSortTimestamp(left)
  );
  const seen = new Set<string>();
  const results: string[] = [];
  for (const session of sorted) {
    const normalizedDir = normalizeWorkspaceDir(session.workspaceDir);
    if (!normalizedDir) {
      continue;
    }
    const dedupeKey = pathDedupeKey(normalizedDir);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    results.push(normalizedDir);
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

export function deriveWorkspaceDirFromFilePath(filePath: string): string | null {
  const normalizedPath = String(filePath ?? '').trim().replace(/^["']|["']$/g, '');
  if (!normalizedPath) {
    return null;
  }
  const separatorIndex = Math.max(normalizedPath.lastIndexOf('\\'), normalizedPath.lastIndexOf('/'));
  if (separatorIndex < 0) {
    return null;
  }
  const candidateDir = normalizedPath.slice(0, separatorIndex);
  return normalizeWorkspaceDir(candidateDir);
}

export function deriveWorkspaceDirFromRelativeFilePath(relativePath: string): string | null {
  const normalizedRelative = String(relativePath ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalizedRelative) {
    return null;
  }
  const firstSeparator = normalizedRelative.indexOf('/');
  if (firstSeparator <= 0) {
    return null;
  }
  const topLevelDir = normalizedRelative.slice(0, firstSeparator);
  return normalizeWorkspaceDir(topLevelDir);
}

function deriveWorkspaceDirFromPickerEntry(file: FileWithOptionalPath): string | null {
  const explicitPath = String(file.path ?? '').trim();
  const relativePath = String(file.webkitRelativePath ?? '').trim();
  if (explicitPath && relativePath) {
    const normalizedExplicit = explicitPath.replace(/\\/g, '/');
    const normalizedRelative = relativePath.replace(/\\/g, '/');
    if (
      normalizedRelative.length > 0 &&
      normalizedExplicit.length > normalizedRelative.length &&
      normalizedExplicit.endsWith(normalizedRelative)
    ) {
      const workspaceRoot = explicitPath
        .slice(0, explicitPath.length - relativePath.length)
        .replace(/[\\\/]+$/, '');
      const normalizedRoot = normalizeWorkspaceDir(workspaceRoot);
      if (normalizedRoot) {
        return normalizedRoot;
      }
    }
  }
  if (explicitPath) {
    return deriveWorkspaceDirFromFilePath(explicitPath);
  }
  if (relativePath) {
    return deriveWorkspaceDirFromRelativeFilePath(relativePath);
  }
  return null;
}

export function resolveWorkspaceDirFromPickerFiles(
  files: ArrayLike<File> | null | undefined
): string | null {
  if (!files || files.length === 0) {
    return null;
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] as FileWithOptionalPath;
    const resolvedWorkspaceDir = deriveWorkspaceDirFromPickerEntry(file);
    if (resolvedWorkspaceDir) {
      return resolvedWorkspaceDir;
    }
  }
  return null;
}
