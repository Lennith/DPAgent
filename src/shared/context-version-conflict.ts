export interface ContextEventVersionConflictInfo {
  scope: string;
  namespace: string;
  expected: number;
  found: number;
}

const CONTEXT_EVENT_VERSION_CONFLICT_RE =
  /^Context event version conflict for ([^:]+):(.+): expected (\d+), found (\d+)$/;

function messageFromErrorLike(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'object' && value !== null && 'message' in value) {
    return String((value as { message?: unknown }).message ?? '');
  }
  return String(value ?? '');
}

export function parseContextEventVersionConflictError(
  value: unknown
): ContextEventVersionConflictInfo | null {
  const message = messageFromErrorLike(value).trim();
  const match = CONTEXT_EVENT_VERSION_CONFLICT_RE.exec(message);
  if (!match) {
    return null;
  }
  const expected = Number.parseInt(match[3] ?? '', 10);
  const found = Number.parseInt(match[4] ?? '', 10);
  if (!Number.isFinite(expected) || !Number.isFinite(found)) {
    return null;
  }
  return {
    scope: match[1] ?? '',
    namespace: match[2] ?? '',
    expected,
    found,
  };
}

export function isContextEventVersionConflictError(value: unknown): boolean {
  return parseContextEventVersionConflictError(value) !== null;
}
