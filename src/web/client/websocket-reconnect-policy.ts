export const FAST_RECONNECT_ATTEMPTS = 8;
export const SLOW_RECONNECT_DELAY_MS = 30000;

export interface ReconnectPolicyDecision {
  attempt: number;
  displayAttempt: number;
  maxDisplayAttempts: number;
  delayMs: number;
  slowMode: boolean;
}

export function resolveReconnectPolicy(input: {
  nextAttempt: number;
  fastDelayMs: number;
  slowDelayMs?: number;
}): ReconnectPolicyDecision {
  const attempt = Math.max(1, Math.floor(input.nextAttempt));
  const slowMode = attempt > FAST_RECONNECT_ATTEMPTS;
  return {
    attempt,
    displayAttempt: slowMode ? FAST_RECONNECT_ATTEMPTS : attempt,
    maxDisplayAttempts: FAST_RECONNECT_ATTEMPTS,
    delayMs: slowMode ? Math.max(1000, Math.floor(input.slowDelayMs ?? SLOW_RECONNECT_DELAY_MS)) : input.fastDelayMs,
    slowMode,
  };
}
