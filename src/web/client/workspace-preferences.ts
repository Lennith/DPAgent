export const DEFAULT_WORKSPACE_STORAGE_KEY = 'minimax-ui-default-workspace';

export const FALLBACK_WORKSPACE_DIR = './workspace';

export function normalizeWorkspaceDir(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function loadDefaultWorkspaceFromStorage(): string | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return normalizeWorkspaceDir(localStorage.getItem(DEFAULT_WORKSPACE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveDefaultWorkspaceToStorage(workspaceDir: string): void {
  const normalized = normalizeWorkspaceDir(workspaceDir);
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    if (!normalized) {
      localStorage.removeItem(DEFAULT_WORKSPACE_STORAGE_KEY);
      return;
    }
    localStorage.setItem(DEFAULT_WORKSPACE_STORAGE_KEY, normalized);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

export function resolveDefaultWorkspaceDir(input: {
  storedWorkspaceDir?: string | null;
  configuredWorkspaceDir?: string | null;
  fallbackWorkspaceDir?: string | null;
}): string {
  const fallback =
    normalizeWorkspaceDir(input.fallbackWorkspaceDir ?? undefined) ?? FALLBACK_WORKSPACE_DIR;
  const stored = normalizeWorkspaceDir(input.storedWorkspaceDir ?? undefined);
  if (stored) {
    return stored;
  }
  const configured = normalizeWorkspaceDir(input.configuredWorkspaceDir ?? undefined);
  if (configured) {
    return configured;
  }
  return fallback;
}
