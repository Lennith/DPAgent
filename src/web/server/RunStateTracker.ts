import { sleep } from '../../runtime/async-primitives.js';
import type {
  ContextRef,
  ResolvedLlmRuntimeConfig,
  RunOwner,
  RunningInputQueueItem,
  SessionInteractionState,
  SessionOrigin,
} from '../../types.js';
import { isSameContextRef, type WSMessage } from './web-server-shared.js';
import type { ActiveRunState } from './web-server-runtime-contracts.js';

export interface RunStateTrackerOptions {
  getActiveRunContexts: () => Map<string, ContextRef>;
  getActiveRunStatesByContext: () => Map<string, ActiveRunState>;
  getCancelingRunIds: () => Set<string>;
  getRunningInputQueueItems?: (context: ContextRef) => RunningInputQueueItem[];
}

export interface TrackRunOptions {
  runId: string;
  context: ContextRef;
  llmRuntime?: ResolvedLlmRuntimeConfig;
  includeIdentityFields?: boolean;
  state?: {
    runFamilyId?: string;
    draftId?: string;
  };
  runOrigin?: SessionOrigin;
}

export class RunStateTracker {
  constructor(private readonly options: RunStateTrackerOptions) {}

  makeContextStateKey(context: ContextRef): string {
    return `${context.scope}:${context.namespace}`;
  }

  buildInteractionState(owner: RunOwner): SessionInteractionState {
    if (owner === 'cli') {
      return {
        mode: 'observe_only',
        reason: 'cli_active_run',
        owner,
      };
    }
    if (owner === 'automation') {
      return {
        mode: 'observe_only',
        reason: 'automation_active_run',
        owner,
      };
    }
    return {
      mode: 'normal',
      owner,
    };
  }

  getActiveRunState(context: ContextRef): ActiveRunState | null {
    const active = this.options.getActiveRunStatesByContext().get(this.makeContextStateKey(context));
    return active ? this.cloneActiveRunState(active) : null;
  }

  listActiveSessionRunStates(): ActiveRunState[] {
    return [...this.options.getActiveRunStatesByContext().values()]
      .filter((state) => state.context.scope === 'session')
      .map((state) => this.cloneActiveRunState(state));
  }

  hasActiveRunForContext(context: ContextRef): boolean {
    for (const activeContext of this.options.getActiveRunContexts().values()) {
      if (isSameContextRef(activeContext, context)) {
        return true;
      }
    }
    return false;
  }

  hasActiveRootAgentRun(): boolean {
    for (const activeContext of this.options.getActiveRunContexts().values()) {
      if (activeContext.scope !== 'session') {
        return true;
      }
    }
    return false;
  }

  getActiveRunIdsForContext(context: ContextRef): string[] {
    const runIds: string[] = [];
    for (const [runId, activeContext] of this.options.getActiveRunContexts().entries()) {
      if (isSameContextRef(activeContext, context)) {
        runIds.push(runId);
      }
    }
    return runIds;
  }

  markCancelingRun(runId: string | null | undefined): void {
    const normalizedRunId = String(runId ?? '').trim();
    if (normalizedRunId) {
      this.options.getCancelingRunIds().add(normalizedRunId);
    }
  }

  markCancelingRunsForContext(context: ContextRef): void {
    for (const runId of this.getActiveRunIdsForContext(context)) {
      this.markCancelingRun(runId);
    }
  }

  hasCancelingRunForContext(context: ContextRef): boolean {
    const cancelingRunIds = this.options.getCancelingRunIds();
    return this.getActiveRunIdsForContext(context).some((runId) => cancelingRunIds.has(runId));
  }

  async waitForNoActiveRunForContext(context: ContextRef, timeoutMs = 10000): Promise<boolean> {
    const startedAt = Date.now();
    while (this.hasActiveRunForContext(context)) {
      if (Date.now() - startedAt >= timeoutMs) {
        return false;
      }
      await sleep(100);
    }
    return true;
  }

  removeTrackedRunsForContext(context: ContextRef): void {
    const activeRunContexts = this.options.getActiveRunContexts();
    const cancelingRunIds = this.options.getCancelingRunIds();
    for (const [runId, activeContext] of activeRunContexts.entries()) {
      if (!isSameContextRef(activeContext, context)) {
        continue;
      }
      activeRunContexts.delete(runId);
      cancelingRunIds.delete(runId);
    }
    this.options.getActiveRunStatesByContext().delete(this.makeContextStateKey(context));
  }

  refreshActiveRunSnapshotFromEvent(context: ContextRef, message: WSMessage): void {
    const activeRunStatesByContext = this.options.getActiveRunStatesByContext();
    const contextKey = this.makeContextStateKey(context);
    const active = activeRunStatesByContext.get(contextKey);
    if (!active) {
      return;
    }
    const data = (message.data ?? {}) as { step?: unknown; maxSteps?: unknown };
    const currentStep =
      message.type === 'step' && typeof data.step === 'number' && Number.isFinite(data.step)
        ? Math.max(0, Math.floor(data.step))
        : active.currentStep;
    const maxSteps =
      message.type === 'step' && typeof data.maxSteps === 'number' && Number.isFinite(data.maxSteps)
        ? Math.max(0, Math.floor(data.maxSteps))
        : active.maxSteps;
    activeRunStatesByContext.set(contextKey, {
      ...active,
      lastActivityAt: new Date().toISOString(),
      currentStep,
      maxSteps,
    });
  }

  activateRun(options: TrackRunOptions): string {
    const startedAt = this.trackRun({ ...options, includeIdentityFields: true });
    return startedAt;
  }

  reserveRun(options: TrackRunOptions): () => void {
    this.trackRun(options);
    return () => this.clearRun(options.runId, options.context);
  }

  finalizeRun(runId: string): ContextRef | undefined {
    const activeRunContexts = this.options.getActiveRunContexts();
    const context = activeRunContexts.get(runId);
    if (context) {
      this.clearRun(runId, context);
    } else {
      activeRunContexts.delete(runId);
      this.options.getCancelingRunIds().delete(runId);
    }
    return context;
  }

  private trackRun(options: TrackRunOptions): string {
    const runOrigin = options.runOrigin ?? 'web';
    const owner: RunOwner = runOrigin;
    const startedAt = new Date().toISOString();
    this.options.getActiveRunContexts().set(options.runId, options.context);
    this.options.getActiveRunStatesByContext().set(this.makeContextStateKey(options.context), {
      runId: options.runId,
      ...(options.includeIdentityFields
        ? {
            runFamilyId: options.state?.runFamilyId,
            draftId: options.state?.draftId,
          }
        : {}),
      context: options.context,
      startedAt,
      lastActivityAt: startedAt,
      currentStep: 0,
      maxSteps: undefined,
      owner,
      origin: runOrigin,
      interactionState: this.buildInteractionState(owner),
      llmRuntime: options.llmRuntime
        ? {
            profileId: options.llmRuntime.profileId,
            provider: options.llmRuntime.provider,
            model: options.llmRuntime.model,
            reasoningPreset: options.llmRuntime.reasoningPreset,
          }
        : undefined,
    });
    return startedAt;
  }

  private clearRun(runId: string, context: ContextRef): void {
    const activeRunContexts = this.options.getActiveRunContexts();
    activeRunContexts.delete(runId);
    const contextKey = this.makeContextStateKey(context);
    const activeState = this.options.getActiveRunStatesByContext().get(contextKey);
    if (activeState?.runId === runId) {
      this.options.getActiveRunStatesByContext().delete(contextKey);
    }
    this.options.getCancelingRunIds().delete(runId);
  }

  private cloneActiveRunState(state: ActiveRunState): ActiveRunState {
    return {
      ...state,
      context: { ...state.context },
      interactionState: { ...state.interactionState },
      llmRuntime: state.llmRuntime ? { ...state.llmRuntime } : undefined,
      runningInputQueue: this.options.getRunningInputQueueItems?.(state.context) ?? state.runningInputQueue,
    };
  }
}
