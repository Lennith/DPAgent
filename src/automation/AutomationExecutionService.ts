import type {
  AutomationJob,
  AutomationMemoryTemplate,
  AutomationRunMeta,
  AutomationRunRecord,
  AutomationRunReport,
  AutomationRunStatus,
  AutomationTriggerSource,
  AgentRuntimeOverrides,
  ContextNamespaceMeta,
  ContextRef,
  Message,
  ResolvedLlmRuntimeConfig,
  SessionLlmSelection,
} from '../types.js';
import type { AutomationStore } from './AutomationStore.js';
import { AutomationRunCoordinator } from './AutomationRunCoordinator.js';

interface RuntimeAgentLike {
  updateContextNamespaceMeta: (
    context: ContextRef,
    updates: Partial<ContextNamespaceMeta>
  ) => ContextNamespaceMeta;
  runWithResult: (input: {
    prompt: string;
    context: ContextRef;
    workspaceDir: string;
    additionalSystemPrompt: string;
    agentRuntimeOverrides?: AgentRuntimeOverrides;
  }) => Promise<{ content: string }>;
}

interface AutomationAgentRuntimeResolution {
  llmSelection?: SessionLlmSelection;
  llmRuntime?: ResolvedLlmRuntimeConfig;
  agentRuntimeOverrides?: AgentRuntimeOverrides;
  agentName?: string;
  effectiveAgentName?: string;
  fallbackReason?: string;
}

interface SystemTaskExecutionResult {
  status: AutomationRunStatus;
  summary: string;
  completedAt?: string;
  sessionId?: string;
  report?: AutomationRunReport;
}

interface AutomationExecutionServiceDeps {
  store: AutomationStore;
  ensureSessionRuntime: (
    sessionId: string,
    workspaceDir: string,
    llmRuntime?: ResolvedLlmRuntimeConfig,
    llmSelection?: SessionLlmSelection
  ) => Promise<{ agent: RuntimeAgentLike; reused: boolean }>;
  cleanupSessionRuntime: (sessionId: string) => Promise<void>;
  trackActiveRun?: (runId: string, context: ContextRef) => (() => void);
  updateContextNamespaceMetaSafe: (
    context: ContextRef,
    updates: Partial<ContextNamespaceMeta>
  ) => ContextNamespaceMeta | null;
  getDefaultWorkspaceDir: () => string;
  getContextMessages: (context: ContextRef) => Message[];
  mutateWorkspaceMemory: (input: {
    title: string;
    content: string;
    workspaceDir: string;
    sessionId: string;
    reason: string;
  }) => Promise<{ entry?: { id?: string } | null }>;
  executeSystemTask?: (input: {
    job: AutomationJob;
    runId: string;
    triggerAt: string;
    triggerSource: AutomationTriggerSource;
    workspaceDir: string;
  }) => Promise<SystemTaskExecutionResult>;
  resolveAutomationAgentRuntime?: (job: AutomationJob) => AutomationAgentRuntimeResolution;
  logger: {
    warn: (message: string) => void;
  };
}

export class AutomationExecutionService {
  private readonly store: AutomationStore;
  private readonly ensureSessionRuntime: AutomationExecutionServiceDeps['ensureSessionRuntime'];
  private readonly cleanupSessionRuntime: AutomationExecutionServiceDeps['cleanupSessionRuntime'];
  private readonly trackActiveRun?: AutomationExecutionServiceDeps['trackActiveRun'];
  private readonly updateContextNamespaceMetaSafe: AutomationExecutionServiceDeps['updateContextNamespaceMetaSafe'];
  private readonly getDefaultWorkspaceDir: AutomationExecutionServiceDeps['getDefaultWorkspaceDir'];
  private readonly getContextMessages: AutomationExecutionServiceDeps['getContextMessages'];
  private readonly mutateWorkspaceMemory: AutomationExecutionServiceDeps['mutateWorkspaceMemory'];
  private readonly executeSystemTask?: AutomationExecutionServiceDeps['executeSystemTask'];
  private readonly resolveAutomationAgentRuntime?: AutomationExecutionServiceDeps['resolveAutomationAgentRuntime'];
  private readonly logger: AutomationExecutionServiceDeps['logger'];

  constructor(deps: AutomationExecutionServiceDeps) {
    this.store = deps.store;
    this.ensureSessionRuntime = deps.ensureSessionRuntime;
    this.cleanupSessionRuntime = deps.cleanupSessionRuntime;
    this.trackActiveRun = deps.trackActiveRun;
    this.updateContextNamespaceMetaSafe = deps.updateContextNamespaceMetaSafe;
    this.getDefaultWorkspaceDir = deps.getDefaultWorkspaceDir;
    this.getContextMessages = deps.getContextMessages;
    this.mutateWorkspaceMemory = deps.mutateWorkspaceMemory;
    this.executeSystemTask = deps.executeSystemTask;
    this.resolveAutomationAgentRuntime = deps.resolveAutomationAgentRuntime;
    this.logger = deps.logger;
  }

  async executeJob(
    job: AutomationJob,
    triggerAt: string,
    options: {
      triggerSource?: AutomationTriggerSource;
      claimedRunRecord?: AutomationRunRecord;
    } = {}
  ): Promise<AutomationRunRecord> {
    const triggerSource = options.triggerSource ?? 'schedule';
    const workspaceDir = job.workspaceDir || this.getDefaultWorkspaceDir();
    const runningRecord = this.resolveClaimedRunRecord({
      job,
      triggerAt,
      triggerSource,
      claimedRunRecord: options.claimedRunRecord,
    });
    if (runningRecord.status === 'skipped') {
      return runningRecord;
    }
    const runId = runningRecord.id;
    let sessionId = runningRecord.sessionId;
    const agentRuntime = job.systemTask
      ? undefined
      : this.resolveAutomationAgentRuntime?.(job) ?? this.createDefaultAgentRuntimeResolution(job);
    if (agentRuntime?.fallbackReason) {
      this.logger.warn(
        `[Automation] agent fallback: job=${job.id} requested=${agentRuntime.agentName ?? ''} reason=${agentRuntime.fallbackReason}`
      );
    }
    this.store.updateRun(job.id, runId, {
      sessionId,
      triggerSource,
      ...(agentRuntime?.agentName ? { agentName: agentRuntime.agentName } : {}),
      ...(agentRuntime?.effectiveAgentName ? { effectiveAgentName: agentRuntime.effectiveAgentName } : {}),
      ...(agentRuntime?.fallbackReason ? { agentFallbackReason: agentRuntime.fallbackReason } : {}),
    });

    let status: AutomationRunStatus = 'failed';
    let summary = '';
    let completedAt = '';
    let reportPath: string | undefined;

    try {
      if (job.systemTask && this.executeSystemTask) {
        const result = await this.executeSystemTask({
          job,
          runId,
          triggerAt,
          triggerSource,
          workspaceDir,
        });
        status = result.status;
        summary = this.summarizeText(result.summary, 320);
        completedAt = result.completedAt || new Date().toISOString();
        sessionId = result.sessionId || '';
        if (result.report) {
          this.store.updateRunReport(job.id, runId, result.report);
          reportPath = `${job.id}:${runId}`;
        }
      } else {
        const context: ContextRef = { scope: 'session', namespace: sessionId };
        const metaPatch: Partial<ContextNamespaceMeta> = {
          name: this.buildAutomationSessionName(job, triggerAt),
          workspaceDir,
          automationRun: this.createAutomationRunMeta({
            job,
            triggerAt,
            status: 'running',
            runId,
            triggerSource,
            agentRuntime,
          }),
          ...(agentRuntime?.llmSelection ? { llmSelection: agentRuntime.llmSelection } : {}),
        };
        this.updateContextNamespaceMetaSafe(context, metaPatch);
        const runtime = await this.ensureSessionRuntime(
          sessionId,
          workspaceDir,
          agentRuntime?.llmRuntime,
          agentRuntime?.llmSelection
        );
        const runAgent = runtime.agent;
        const currentTemplate = this.store.getMemoryTemplate(job.id);
        runAgent.updateContextNamespaceMeta(context, metaPatch);

        const releaseActiveRun = this.trackActiveRun?.(runId, context);
        let result: { content: string };
        try {
          result = await runAgent.runWithResult({
            prompt: job.prompt,
            context,
            workspaceDir,
            additionalSystemPrompt: this.buildAutomationAdditionalSystemPrompt(
              job,
              currentTemplate,
              triggerSource,
              agentRuntime
            ),
            ...(agentRuntime?.agentRuntimeOverrides
              ? { agentRuntimeOverrides: agentRuntime.agentRuntimeOverrides }
              : {}),
          });
        } finally {
          releaseActiveRun?.();
        }
        status = 'succeeded';
        summary = this.summarizeText(result.content, 320) || 'Automation run completed.';
        if (job.sessionId && job.schedule.frequency === "once") { this.store.updateJob(job.id, { enabled: false }); }
        completedAt = new Date().toISOString();
        runAgent.updateContextNamespaceMeta(context, {
          automationRun: this.createAutomationRunMeta({
            job,
            triggerAt,
            status,
            runId,
            triggerSource,
            completedAt,
            agentRuntime,
          }),
        });
      }
    } catch (error) {
      status = 'failed';
      completedAt = new Date().toISOString();
      summary = this.summarizeText(error instanceof Error ? error.message : String(error), 320);
      if (sessionId) {
        this.updateContextNamespaceMetaSafe(
          { scope: 'session', namespace: sessionId },
          {
            automationRun: this.createAutomationRunMeta({
              job,
              triggerAt,
              status,
              runId,
              triggerSource,
              completedAt,
              agentRuntime,
            }),
          }
        );
      }
    } finally {
      const finalRecord = this.store.updateRun(job.id, runId, {
        sessionId,
        status,
        completedAt,
        resultSummary: summary,
        error: status === 'failed' ? summary : undefined,
        ...(agentRuntime?.agentName ? { agentName: agentRuntime.agentName } : {}),
        ...(agentRuntime?.effectiveAgentName ? { effectiveAgentName: agentRuntime.effectiveAgentName } : {}),
        ...(agentRuntime?.fallbackReason ? { agentFallbackReason: agentRuntime.fallbackReason } : {}),
        reportPath,
      }) ?? {
        ...runningRecord,
        sessionId,
        status,
        completedAt,
        resultSummary: summary,
        error: status === 'failed' ? summary : undefined,
        ...(agentRuntime?.agentName ? { agentName: agentRuntime.agentName } : {}),
        ...(agentRuntime?.effectiveAgentName ? { effectiveAgentName: agentRuntime.effectiveAgentName } : {}),
        ...(agentRuntime?.fallbackReason ? { agentFallbackReason: agentRuntime.fallbackReason } : {}),
        reportPath,
      };
      this.store.updateJob(job.id, {
        lastRunAt: completedAt || new Date().toISOString(),
      });

      if (!job.systemTask && sessionId) {
        await this.syncCompletionMemory({
          job,
          sessionId,
          status,
          triggerAt,
          completedAt: completedAt || new Date().toISOString(),
          summary: summary || (status === 'failed' ? 'Automation run failed.' : 'Automation run completed.'),
          runId,
        });
        try {
          await this.cleanupSessionRuntime(sessionId);
        } catch (cleanupError) {
          this.logger.warn(`[Automation] session runtime cleanup failed: ${String(cleanupError)}`);
        }
      }

      return finalRecord;
    }
  }

  private resolveClaimedRunRecord(input: {
    job: AutomationJob;
    triggerAt: string;
    triggerSource: AutomationTriggerSource;
    claimedRunRecord?: AutomationRunRecord;
  }): AutomationRunRecord {
    if (input.claimedRunRecord) {
      return input.claimedRunRecord;
    }
    return this.store.claimRun({
      jobId: input.job.id,
      triggerAt: input.triggerAt,
      triggerSource: input.triggerSource,
      runId: AutomationRunCoordinator.createRunId(),
    }).record;
  }

  async saveManualCorrectionFromSession(input: {
    job: AutomationJob;
    sessionId: string;
    note: string;
  }): Promise<{ template: AutomationMemoryTemplate; memoryEntryId: string | null }> {
    const context: ContextRef = { scope: 'session', namespace: input.sessionId };
    const messages = this.getContextMessages(context);
    const note = this.buildCorrectionNote(messages, input.note);
    if (!note) {
      throw new Error('unable to derive correction note from session');
    }

    const template = this.appendAutomationMemoryTemplate({
      job: input.job,
      entry: `Manual fix from ${input.sessionId}: ${note}`,
      sourceSessionId: input.sessionId,
    });
    const memoryResult = await this.mutateWorkspaceMemory({
      title: `Automation ${input.job.name} manual correction`,
      content: note,
      workspaceDir: input.job.workspaceDir,
      sessionId: input.sessionId,
      reason: 'automation_manual_correction',
    });
    return {
      template,
      memoryEntryId: memoryResult.entry?.id ?? null,
    };
  }

  private createAutomationRunMeta(input: {
    job: AutomationJob;
    triggerAt: string;
    status: AutomationRunStatus;
    runId: string;
    triggerSource: AutomationTriggerSource;
    agentRuntime?: AutomationAgentRuntimeResolution;
    completedAt?: string;
  }): AutomationRunMeta {
    return {
      jobId: input.job.id,
      triggerAt: input.triggerAt,
      status: input.status,
      runId: input.runId,
      scheduledBy: 'automation',
      triggerSource: input.triggerSource,
      ...(input.agentRuntime?.agentName ? { agentName: input.agentRuntime.agentName } : {}),
      ...(input.agentRuntime?.effectiveAgentName
        ? { effectiveAgentName: input.agentRuntime.effectiveAgentName }
        : {}),
      ...(input.agentRuntime?.fallbackReason
        ? { agentFallbackReason: input.agentRuntime.fallbackReason }
        : {}),
      completedAt: input.completedAt,
    };
  }

  private createDefaultAgentRuntimeResolution(job: AutomationJob): AutomationAgentRuntimeResolution {
    return {
      ...(job.llmSelection ? { llmSelection: job.llmSelection } : {}),
      effectiveAgentName: 'default',
    };
  }

  private async syncCompletionMemory(input: {
    job: AutomationJob;
    sessionId: string;
    status: AutomationRunStatus;
    triggerAt: string;
    completedAt: string;
    summary: string;
    runId: string;
  }): Promise<void> {
    try {
      const template = this.appendAutomationMemoryTemplate({
        job: input.job,
        entry: `Run ${input.status} (session=${input.sessionId}): ${input.summary}`,
        sourceSessionId: input.sessionId,
      });
      await this.mutateWorkspaceMemory({
        title: `Automation ${input.job.name} latest outcome`,
        content: [
          `status=${input.status}`,
          `trigger_at=${input.triggerAt}`,
          `completed_at=${input.completedAt}`,
          `session_id=${input.sessionId}`,
          `summary=${input.summary}`,
          `template_version=${template.version}`,
        ].join('\n'),
        workspaceDir: input.job.workspaceDir,
        sessionId: input.sessionId,
        reason: 'automation_completion',
      });
      this.store.updateRun(input.job.id, input.runId, {
        memorySyncStatus: 'succeeded',
        memorySyncError: undefined,
      });
    } catch (error) {
      const memoryError = this.summarizeText(
        error instanceof Error ? error.message : String(error),
        320
      );
      this.store.updateRun(input.job.id, input.runId, {
        memorySyncStatus: 'failed',
        memorySyncError: memoryError,
      });
      this.logger.warn(`[Automation] completion memory sync failed: ${memoryError}`);
    }
  }

  private buildAutomationAdditionalSystemPrompt(
    job: AutomationJob,
    template: AutomationMemoryTemplate | undefined,
    triggerSource: AutomationTriggerSource,
    agentRuntime?: AutomationAgentRuntimeResolution
  ): string {
    const effectiveAgentName = agentRuntime?.effectiveAgentName ?? 'default';
    const segments: string[] = [
      '[AUTOMATION_RUN]',
      `job_id=${job.id}`,
      `job_name=${job.name}`,
      `timezone=${job.timezone}`,
      `trigger_source=${triggerSource}`,
      `agent=${effectiveAgentName}`,
      'This run executes in an isolated session.',
    ];
    if (agentRuntime?.fallbackReason) {
      segments.push(`agent_fallback_reason=${agentRuntime.fallbackReason}`);
    }
    if (!agentRuntime?.agentRuntimeOverrides && job.skills.length > 0) {
      segments.push(`Preferred skills: ${job.skills.join(', ')}`);
    }
    segments.push('## Automation Memory Template');
    const templateText = String(template?.template ?? '').trim();
    segments.push(templateText || '(empty)');
    segments.push('[/AUTOMATION_RUN]');
    return segments.join('\n');
  }

  private appendAutomationMemoryTemplate(input: {
    job: AutomationJob;
    entry: string;
    sourceSessionId?: string;
  }): AutomationMemoryTemplate {
    const existing = this.store.getMemoryTemplate(input.job.id);
    const current = String(existing?.template ?? '').trim();
    const stamped = `- [${new Date().toISOString()}] ${input.entry}`;
    let nextTemplate =
      current.length > 0 ? `${current}\n${stamped}` : `## Automation Memory\n${stamped}`;
    if (nextTemplate.length > 6_000) {
      nextTemplate = nextTemplate.slice(nextTemplate.length - 6_000);
    }
    return this.store.updateMemoryTemplate({
      jobId: input.job.id,
      template: nextTemplate,
      sourceSessionId: input.sourceSessionId,
    });
  }

  private buildCorrectionNote(messages: Message[], explicitNote: string): string {
    if (explicitNote.trim().length > 0) {
      return this.summarizeText(explicitNote, 1_200);
    }
    const lastUser = [...messages]
      .reverse()
      .find((item) => item.role === 'user' && String(item.content ?? '').trim().length > 0);
    const lastAssistant = [...messages]
      .reverse()
      .find((item) => item.role === 'assistant' && String(item.content ?? '').trim().length > 0);
    const chunks: string[] = [];
    if (lastUser) {
      chunks.push(`User correction: ${this.summarizeText(lastUser.content, 480)}`);
    }
    if (lastAssistant) {
      chunks.push(`Assistant output: ${this.summarizeText(lastAssistant.content, 480)}`);
    }
    return chunks.join(' | ').trim();
  }

  private summarizeText(value: unknown, maxChars = 240): string {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
  }

  private buildAutomationSessionName(job: AutomationJob, triggerAt: string): string {
    const suffix = triggerAt.replace(/[:.]/g, '-');
    return `[AUTO] ${job.name} @ ${suffix}`;
  }
}
