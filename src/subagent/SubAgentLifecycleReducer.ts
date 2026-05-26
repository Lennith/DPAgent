import type { SubAgentLifecycleStatus, SubAgentResult } from '../types.js';
import type { SubAgentRecord } from './types.js';

export function isTerminalSubAgentStatus(status: SubAgentLifecycleStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'timeout';
}

export function applySubAgentHeartbeat(record: SubAgentRecord, nowIso: string): void {
  if (isTerminalSubAgentStatus(record.status)) {
    return;
  }
  record.lastHeartbeatAt = nowIso;
  record.updatedAt = nowIso;
}

export function applySubAgentRunningTransition(record: SubAgentRecord, nowIso: string): void {
  record.status = 'running';
  record.queuePosition = undefined;
  record.updatedAt = nowIso;
  record.lastHeartbeatAt = nowIso;
  record.lifecycleDiagnostic = undefined;
}

export function applySubAgentTerminalTransition(
  record: SubAgentRecord,
  input: {
    status: Extract<SubAgentLifecycleStatus, 'succeeded' | 'failed' | 'canceled' | 'timeout'>;
    nowIso: string;
    error?: string;
    result: SubAgentResult;
  }
): void {
  record.status = input.status;
  record.queuePosition = undefined;
  record.updatedAt = input.nowIso;
  record.lastHeartbeatAt = input.nowIso;
  record.lastError = input.error;
  record.lifecycleDiagnostic = undefined;
  record.latestResult = input.result;
}
