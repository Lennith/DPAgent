import type { AutomationRunRecord, AutomationTriggerSource } from '../types.js';
import { createStateId, nowIso } from '../storage/index.js';

export class AutomationRunCoordinator {
  static createRunId(): string {
    return createStateId('run');
  }

  static findActiveRun(runs: AutomationRunRecord[]): AutomationRunRecord | undefined {
    return runs.find((item) => item.status === 'running' && !item.completedAt);
  }

  static createOverlapSkipRecord(input: {
    jobId: string;
    triggerAt: string;
    triggerSource?: AutomationTriggerSource;
    now?: Date;
  }): AutomationRunRecord {
    const timestamp = input.now ? input.now.toISOString() : nowIso();
    return {
      id: this.createRunId(),
      jobId: input.jobId,
      sessionId: '',
      status: 'skipped',
      triggerAt: input.triggerAt,
      ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
      startedAt: timestamp,
      completedAt: timestamp,
      skippedReason: 'overlap_running',
      resultSummary: 'Skipped because a previous run is still active.',
    };
  }
}
