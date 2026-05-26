const LAST_SESSION_STORAGE_KEY = 'minimax-ui-last-session-id';

export function loadLastSessionIdFromStorage(): string | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const stored = String(localStorage.getItem(LAST_SESSION_STORAGE_KEY) ?? '').trim();
    return stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

export function saveLastSessionIdToStorage(sessionId: string | null): void {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    const normalized = String(sessionId ?? '').trim();
    if (!normalized) {
      localStorage.removeItem(LAST_SESSION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(LAST_SESSION_STORAGE_KEY, normalized);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}
