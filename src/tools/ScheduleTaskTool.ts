import type { ToolResult } from '../types.js';
import { Tool, errorResult, successResult } from './Tool.js';
import type { AutomationStore } from '../automation/AutomationStore.js';
import { normalizeAutomationSchedule } from '../automation/schedule.js';
import { agentLogger } from '../utils/logger.js';

export interface ScheduleTaskToolOptions {
  getSessionId: () => string;
  getDefaultWorkspaceDir: () => string;
  store: AutomationStore;
}

type ScheduleAction = 'create' | 'query' | 'cancel';

/**
 * schedule_task - manage timed tasks for the current session.
 *
 *   action = 'create' (default)
 *     Schedule a recurring fixed-interval task using interval_seconds.
 *
 *   action = 'query'
 *     List active (enabled=true) tasks in this session.
 *     Returns id, name, type, nextRunAt for each.
 *
 *   action = 'cancel'
 *     Delete a task by its job id. Only tasks belonging to this session
 *     can be cancelled.
 */
export class ScheduleTaskTool extends Tool {
  private readonly opts: ScheduleTaskToolOptions;

  constructor(opts: ScheduleTaskToolOptions) {
    super();
    this.opts = opts;
  }

  get name(): string {
    return 'schedule_task';
  }

  get description(): string {
    return [
      'Manage fixed-interval scheduled tasks for the current session.',
      'This is a base agent tool for creating, listing, and canceling this session\'s timed follow-up work.',
      'Actions:',
      "- 'create': schedule a new recurring task that runs every interval_seconds.",
      "- 'query': list all active tasks in this session (enabled=true only).",
      "- 'cancel': delete a task by its job id (only tasks belonging to this session).",
      'For create: provide interval_seconds as an integer from 5 to 2592000 seconds.',
      'Waiting for one future moment is modeled as a recurring interval task; cancel it when it is no longer needed.',
      'For cancel: provide the jobId returned by create or query.',
    ].join(' ');
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'query', 'cancel'],
          description:
            "Action to perform. 'create' schedules a new task (default). 'query' lists active tasks. 'cancel' deletes a task by id.",
          default: 'create',
        },
        name: {
          type: 'string',
          description: "Short name for the task (required for 'create').",
        },
        prompt: {
          type: 'string',
          description: "Future user message to inject when the task triggers (required for 'create').",
        },
        interval_seconds: {
          type: 'number',
          description: "Fixed interval in seconds for 'create' (integer, 5-2592000).",
        },
        enabled: {
          type: 'boolean',
          description: "Enable immediately (default true, only for 'create').",
        },
        jobId: {
          type: 'string',
          description: "Job id to cancel (required for 'cancel').",
        },
      },
      required: ['action'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = this.resolveAction(args);
    const sessionId = this.opts.getSessionId();

    try {
      switch (action) {
        case 'query':
          return this.doQuery(sessionId);
        case 'cancel':
          return this.doCancel(sessionId, args);
        case 'create':
        default:
          return this.doCreate(sessionId, args);
      }
    } catch (err) {
      return errorResult(`schedule_task ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private resolveAction(args: Record<string, unknown>): ScheduleAction {
    const raw = String(args.action ?? '').trim().toLowerCase();
    if (raw === 'query') return 'query';
    if (raw === 'cancel') return 'cancel';
    return 'create';
  }

  private requireSession(sessionId: string): string {
    if (!sessionId) throw new Error('no active session');
    return sessionId;
  }

  private doCreate(sessionId: string, args: Record<string, unknown>): ToolResult {
    this.requireSession(sessionId);

    const name = String(args.name ?? '').trim();
    if (!name) return errorResult("name is required for 'create'");
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return errorResult("prompt is required for 'create'");

    if (args.type !== undefined || args.delayMs !== undefined || args.schedule !== undefined) {
      return errorResult('schedule_task create now uses interval_seconds; delay/cron schedule templates are not accepted');
    }

    const enabled = args.enabled !== false;
    const workspaceDir = this.opts.getDefaultWorkspaceDir();
    return this.doCreateInterval(name, prompt, args, enabled, workspaceDir, sessionId);
  }

  private doCreateInterval(
    name: string,
    prompt: string,
    args: Record<string, unknown>,
    enabled: boolean,
    workspaceDir: string,
    sessionId: string
  ): ToolResult {
    const intervalSeconds = Number(args.interval_seconds);
    if (!Number.isFinite(intervalSeconds)) return errorResult('interval_seconds is required for create');
    const schedule = normalizeAutomationSchedule({
      frequency: 'interval',
      intervalSeconds,
    });

    const job = this.opts.store.createJob({
      name,
      prompt,
      workspaceDir,
      schedule,
      timezone: 'UTC',
      enabled,
      sessionId,
    });

    agentLogger.info(`[schedule_task] Created interval id=${job.id} name=${name} interval=${schedule.intervalSeconds}s`);
    return successResult(
      `Created interval task "${name}" (id: ${job.id}) - runs every ${schedule.intervalSeconds}s. Next run: ${job.nextRunAt ?? '(pending)'}.`
    );
  }

  private doQuery(sessionId: string): ToolResult {
    this.requireSession(sessionId);
    const jobs = this.opts.store.listJobs().filter(
      (job) => job.sessionId === sessionId && job.enabled && !job.systemTask
    );
    if (jobs.length === 0) {
      return successResult('No active scheduled tasks in this session.');
    }
    const items = jobs.map((job) => ({
      id: job.id,
      name: job.name,
      type:
        job.schedule.frequency === 'interval'
          ? 'interval'
          : job.schedule.frequency === 'once'
            ? 'delay'
            : 'calendar',
      intervalSeconds: job.schedule.intervalSeconds,
      nextRunAt: job.nextRunAt ?? '(pending)',
      enabled: job.enabled,
    }));
    return successResult(JSON.stringify(items, null, 2));
  }

  private doCancel(sessionId: string, args: Record<string, unknown>): ToolResult {
    this.requireSession(sessionId);
    const jobId = String(args.jobId ?? '').trim();
    if (!jobId) return errorResult("jobId is required for 'cancel'");

    const job = this.opts.store.getJob(jobId);
    if (!job) return errorResult(`Task not found: ${jobId}`);
    if (job.sessionId !== sessionId) {
      return errorResult(`Task ${jobId} does not belong to this session`);
    }

    const deleted = this.opts.store.deleteJob(jobId);
    if (!deleted) return errorResult(`Failed to delete task: ${jobId}`);

    agentLogger.info(`[schedule_task] Cancelled id=${jobId} name=${job.name}`);
    return successResult(`Cancelled task "${job.name}" (id: ${jobId}).`);
  }
}
