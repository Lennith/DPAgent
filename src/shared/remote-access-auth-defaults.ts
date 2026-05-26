export const REMOTE_ACCESS_AUTH_DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const REMOTE_ACCESS_AUTH_TTL_OPTIONS = [
  { value: 60 * 60 * 1000 },
  { value: 12 * 60 * 60 * 1000 },
  { value: 24 * 60 * 60 * 1000 },
  { value: REMOTE_ACCESS_AUTH_DEFAULT_SESSION_TTL_MS },
  { value: 30 * 24 * 60 * 60 * 1000 },
] as const;

export const DEFAULT_REMOTE_ACCESS_AUTH_SETTINGS = {
  enabled: false,
  sessionTtlMs: REMOTE_ACCESS_AUTH_DEFAULT_SESSION_TTL_MS,
  trustProxy: false,
} as const;
