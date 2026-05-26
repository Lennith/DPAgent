const DEFAULT_TOOLCALL_PROTOCOL_FAILURE_ESCALATE_AFTER = 2;
export const DEFAULT_PROGRESS_ONLY_RECOVERY_MAX_ATTEMPTS = 3;
export const DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS = 2;

export function isRetriableTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('econnreset') ||
    normalized.includes('etimedout') ||
    normalized.includes('socket hang up') ||
    normalized.includes('fetch failed') ||
    normalized.includes('stream ended without receiving a complete event') ||
    normalized.includes('network') ||
    normalized.includes('connection reset')
  );
}

export function decideToolCallProtocolRecovery(input: {
  consecutiveFailureCount: number;
  escalateAfter?: number;
}): { kind: 'inject' | 'escalate'; nextCount: number } {
  const nextCount = Math.max(0, Math.floor(input.consecutiveFailureCount)) + 1;
  const escalateAfter = Math.max(
    1,
    Math.floor(input.escalateAfter ?? DEFAULT_TOOLCALL_PROTOCOL_FAILURE_ESCALATE_AFTER)
  );
  return {
    kind: nextCount >= escalateAfter ? 'escalate' : 'inject',
    nextCount,
  };
}

export function shouldRetryTransportBeforeVisibleOutput(input: {
  streamedVisibleOutput: boolean;
  error: unknown;
  transportRetryCount: number;
  maxAttempts?: number;
}): boolean {
  const maxAttempts = Math.max(0, Math.floor(input.maxAttempts ?? DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS));
  return (
    !input.streamedVisibleOutput &&
    isRetriableTransportError(input.error) &&
    input.transportRetryCount < maxAttempts
  );
}

export function decideContextOverflowRecovery(input: {
  overflowCountInTurn: number;
  maxErrorsBeforeTrim: number;
}): 'retry_with_forced_compress' | 'retry_with_forced_trim' | 'abort' {
  const overflowCount = Math.max(0, Math.floor(input.overflowCountInTurn));
  const maxBeforeTrim = Math.max(1, Math.floor(input.maxErrorsBeforeTrim));
  if (overflowCount < maxBeforeTrim) {
    return 'retry_with_forced_compress';
  }
  if (overflowCount === maxBeforeTrim) {
    return 'retry_with_forced_trim';
  }
  return 'abort';
}

export function decideProgressOnlyRecovery(input: {
  consecutiveStopCount: number;
  maxAttempts?: number;
}): { kind: 'continue' | 'stall'; nextCount: number; maxAttempts: number } {
  const nextCount = Math.max(0, Math.floor(input.consecutiveStopCount)) + 1;
  const maxAttempts = Math.max(
    0,
    Math.floor(input.maxAttempts ?? DEFAULT_PROGRESS_ONLY_RECOVERY_MAX_ATTEMPTS)
  );
  return {
    kind: nextCount > maxAttempts ? 'stall' : 'continue',
    nextCount,
    maxAttempts,
  };
}
