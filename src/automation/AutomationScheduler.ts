import type { AutomationJob, AutomationRunRecord } from '../types.js';
import { computeNextRunAt } from './schedule.js';
import type { AutomationStore } from './AutomationStore.js';

interface AutomationSchedulerDeps {
  store: AutomationStore;
  executeJob: (job: AutomationJob, triggerAt: string) => Promise<void>;
  logger: {
    warn: (message: string) => void;
  };
}

interface AutomationSchedulerOptions {
  intervalMs?: number;
  staleThresholdMs?: number;
}

function createRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export class AutomationScheduler {
  private readonly deps: AutomationSchedulerDeps;
  private readonly intervalMs: number;
  private readonly staleThresholdMs: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly runningJobIds = new Set<string>();

  constructor(deps: AutomationSchedulerDeps, options?: AutomationSchedulerOptions) {
    this.deps = deps;
    this.intervalMs = Math.max(1_000, Math.trunc(options?.intervalMs ?? 60_000));
    this.staleThresholdMs = Math.max(1_000, Math.trunc(options?.staleThresholdMs ?? 90_000));
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const tick = () => {
      void this.runTick().catch((error) => {
        this.deps.logger.warn(`[Automation] scheduler tick failed: ${String(error)}`);
      });
    };
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async runTick(now = new Date()): Promise<void> {
    const nowMs = now.getTime();
    const jobs = this.deps.store.listJobs().filter((item) => item.enabled);
    for (const job of jobs) {
      try {
        this.processDueJob(job, now, nowMs);
      } catch (error) {
        this.deps.logger.warn(
          `[Automation] scheduler job failed: job=${job.id} error=${String(error)}`
        );
      }
    }
  }

  private processDueJob(job: AutomationJob, now: Date, nowMs: number): void {
    const nextRunAtRaw = String(job.nextRunAt ?? '').trim();
    if (!nextRunAtRaw) {
      const nextRunAt = computeNextRunAt(job.schedule, job.timezone, now);
      this.deps.store.updateJob(job.id, { nextRunAt });
      return;
    }

    const nextRunMs = Date.parse(nextRunAtRaw);
    if (!Number.isFinite(nextRunMs)) {
      const nextRunAt = computeNextRunAt(job.schedule, job.timezone, now);
      this.deps.store.updateJob(job.id, { nextRunAt });
      return;
    }

    if (nextRunMs > nowMs) {
      return;
    }

    if (nowMs - nextRunMs > this.staleThresholdMs) {
      const nextRunAt = computeNextRunAt(job.schedule, job.timezone, now);
      this.deps.store.updateJob(job.id, { nextRunAt });
      return;
    }

    const triggerAt = new Date(nextRunMs).toISOString();
    const nextRunAt = computeNextRunAt(job.schedule, job.timezone, now);
    this.deps.store.updateJob(job.id, { nextRunAt });

    if (this.runningJobIds.has(job.id)) {
      const skippedRecord: AutomationRunRecord = {
        id: createRunId(),
        jobId: job.id,
        sessionId: '',
        status: 'skipped',
        triggerAt,
        startedAt: now.toISOString(),
        completedAt: now.toISOString(),
        skippedReason: 'overlap_running',
        resultSummary: 'Skipped because a previous run is still active.',
      };
      this.deps.store.appendRun(job.id, skippedRecord);
      return;
    }

    this.runningJobIds.add(job.id);
    void this.deps
      .executeJob(job, triggerAt)
      .catch((error) => {
        this.deps.logger.warn(`[Automation] run failed: job=${job.id} error=${String(error)}`);
      })
      .finally(() => {
        this.runningJobIds.delete(job.id);
      });
  }
}

