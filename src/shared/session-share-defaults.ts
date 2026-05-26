export const DEFAULT_SESSION_SHARE_TTL_HOURS = 24;
export const MIN_SESSION_SHARE_TTL_HOURS = 1;
export const MAX_SESSION_SHARE_TTL_HOURS = 24 * 30;

export function normalizeSessionShareTtlHours(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return DEFAULT_SESSION_SHARE_TTL_HOURS;
  }
  return Math.min(
    MAX_SESSION_SHARE_TTL_HOURS,
    Math.max(MIN_SESSION_SHARE_TTL_HOURS, Math.floor(raw))
  );
}
