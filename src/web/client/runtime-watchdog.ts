export interface RuntimeWatchdogInput {
  isRunning: boolean;
  runStartedAt: number;
  lastActivityAt: number;
  cancelInitiated: boolean;
  cancelAcknowledged: boolean;
  cancelRequestedAt: number;
  contextPrecompressActive?: boolean;
}

export interface RuntimeWatchdogThresholds {
  warningMs: number;
  cancelAckTimeoutMs: number;
}

export type RuntimeWatchdogDecision =
  | { kind: 'none' }
  | { kind: 'cancel_warning'; elapsedMs: number; warningBucket: number }
  | { kind: 'run_warning'; elapsedMs: number; warningBucket: number };

export function evaluateRuntimeWatchdog(
  now: number,
  runtime: RuntimeWatchdogInput,
  thresholds: RuntimeWatchdogThresholds,
  lastWarningBucket: number
): RuntimeWatchdogDecision {
  if (runtime.cancelInitiated && !runtime.cancelAcknowledged && runtime.cancelRequestedAt > 0) {
    const elapsedSinceCancel = now - runtime.cancelRequestedAt;
    if (elapsedSinceCancel > thresholds.cancelAckTimeoutMs) {
      const warningBucket = Math.floor(elapsedSinceCancel / thresholds.cancelAckTimeoutMs);
      if (warningBucket > lastWarningBucket) {
        return {
          kind: 'cancel_warning',
          elapsedMs: elapsedSinceCancel,
          warningBucket,
        };
      }
    }
  }

  if (!runtime.isRunning || runtime.runStartedAt <= 0) {
    return { kind: 'none' };
  }

  const lastActivityAt = Math.max(runtime.runStartedAt, runtime.lastActivityAt);
  const idleElapsed = now - lastActivityAt;
  if (idleElapsed > thresholds.warningMs) {
    const warningBucket = Math.floor(idleElapsed / thresholds.warningMs);
    if (warningBucket > lastWarningBucket) {
      return {
        kind: 'run_warning',
        elapsedMs: idleElapsed,
        warningBucket,
      };
    }
  }

  return { kind: 'none' };
}
