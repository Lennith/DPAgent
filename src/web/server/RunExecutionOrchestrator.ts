import type { DPAgent } from '../../dpagent-runtime.js';
import type {
  ContextNamespaceMeta,
  ContextRef,
  ContextRuntimeErrorMessage,
  RunTerminalState,
} from '../../types.js';
import { isContextEventVersionConflictError } from '../../shared/context-version-conflict.js';
import { webServerLogger } from '../../utils/logger.js';
import type { TrackedRunExecution } from './web-server-runtime-contracts.js';

export interface RunExecutionOrchestratorOptions {
  getActiveRunCount: () => number;
  resolveAgentForContext: (context: ContextRef) => DPAgent;
  resolveAdditionalSystemPrompt: (context: ContextRef) => string | undefined;
  updateContextNamespaceMeta: (context: ContextRef, patch: Partial<ContextNamespaceMeta>) => void;
  getContextNamespaceMeta: (context: ContextRef) => ContextNamespaceMeta | undefined;
  updateAgentInjectionState: (
    context: ContextRef,
    next: Partial<NonNullable<ContextNamespaceMeta['agentInjectionState']>>
  ) => void;
  touchSessionRuntime: (sessionId: string) => void;
  finalizeTrackedRun: (runId: string, refreshCatalogOnFinish?: boolean) => Promise<void>;
  recordRuntimeErrorMessage: (
    context: ContextRef,
    input: {
      runId: string;
      message: string;
      terminalState?: RunTerminalState | null;
    }
  ) => void;
  isRecoverableCheckpointTerminalState: (state: RunTerminalState | null | undefined) => boolean;
  scheduleRecoverableCheckpointContinuation: (
    execution: TrackedRunExecution,
    terminalState: RunTerminalState
  ) => void;
  afterFinalizeTrackedRun?: (execution: TrackedRunExecution) => void | Promise<void>;
}

export class RunExecutionOrchestrator {
  constructor(private readonly options: RunExecutionOrchestratorOptions) {}

  recordRuntimeErrorMessage(
    context: ContextRef,
    input: {
      runId: string;
      message: string;
      terminalState?: RunTerminalState | null;
    }
  ): void {
    const runId = String(input.runId ?? '').trim();
    const message = String(input.message ?? '').trim();
    if (!runId || !message) {
      return;
    }
    if (isContextEventVersionConflictError(message)) {
      return;
    }
    const terminalState = input.terminalState ?? null;
    const createdAt = terminalState?.createdAt ?? new Date().toISOString();
    const nextError: ContextRuntimeErrorMessage = {
      id: `run-error-${runId}`,
      runId,
      message,
      createdAt,
      ...(terminalState?.terminalCode === 'cancelled' || terminalState?.terminalCode === 'error'
        ? { terminalCode: terminalState.terminalCode }
        : {}),
      ...(terminalState?.replayCutoffKind ? { replayCutoffKind: terminalState.replayCutoffKind } : {}),
      ...(typeof terminalState?.lastSafeStep === 'number' ? { lastSafeStep: terminalState.lastSafeStep } : {}),
      ...(typeof terminalState?.maxSteps === 'number' ? { maxSteps: terminalState.maxSteps } : {}),
    };
    const existing = this.options.getContextNamespaceMeta(context)?.runtimeErrors ?? [];
    const nextErrors = [...existing.filter((item) => item.runId !== runId), nextError].slice(-20);
    this.options.updateContextNamespaceMeta(context, { runtimeErrors: nextErrors });
  }

  async executeTrackedRun(execution: TrackedRunExecution): Promise<void> {
    let deferredTerminalState: RunTerminalState | null = null;
    let deferredErrorMessage: string | null = null;
    let shouldStopController = false;
    try {
      const runInput = execution.resolveRunInput();
      if (!runInput) {
        webServerLogger.warn(
          `[WebServer] Run skipped runId=${execution.runId} context=${execution.context.scope}:${execution.context.namespace} reason=missing_run_input`
        );
        return;
      }
      webServerLogger.info(
        `[WebServer] Run start runId=${execution.runId} context=${execution.context.scope}:${execution.context.namespace} provider=${execution.llmRuntime?.provider ?? 'default'} model=${execution.llmRuntime?.model ?? 'default'} activeRuns=${this.options.getActiveRunCount()}`
      );
      if (runInput.llmSelectionUpdate) {
        this.options.updateContextNamespaceMeta(execution.context, {
          llmSelection: runInput.llmSelectionUpdate,
        });
      }
      const agent = this.options.resolveAgentForContext(execution.context);
      const result = await agent.runWithResult({
        prompt: runInput.prompt,
        runId: execution.runId,
        ...(runInput.runFamilyId !== undefined ? { runFamilyId: runInput.runFamilyId } : {}),
        ...(runInput.rawUserPrompt !== undefined ? { rawUserPrompt: runInput.rawUserPrompt } : {}),
        ...(runInput.historyUserPrompt !== undefined
          ? { historyUserPrompt: runInput.historyUserPrompt }
          : {}),
        ...(runInput.effectivePrompt !== undefined ? { effectivePrompt: runInput.effectivePrompt } : {}),
        ...(runInput.promptReference !== undefined ? { promptReference: runInput.promptReference } : {}),
        ...(runInput.hasSystemPromptInjection !== undefined
          ? { hasSystemPromptInjection: runInput.hasSystemPromptInjection }
          : {}),
        ...(runInput.planningState !== undefined ? { planningState: runInput.planningState } : {}),
        ...(runInput.agentRuntimeOverrides !== undefined
          ? { agentRuntimeOverrides: runInput.agentRuntimeOverrides }
          : {}),
        context: execution.context,
        callback: runInput.callback,
        additionalSystemPrompt: this.options.resolveAdditionalSystemPrompt(execution.context),
        ...(runInput.workspaceDir !== undefined || runInput.includeWorkspaceDir
          ? { workspaceDir: runInput.workspaceDir }
          : {}),
      });
      if (runInput.agentInjectionStateUpdate) {
        this.options.updateAgentInjectionState(execution.context, runInput.agentInjectionStateUpdate);
      }
      if (execution.context.scope === 'session') {
        this.options.touchSessionRuntime(execution.context.namespace);
      }
      if (result.terminalState) {
        deferredTerminalState = result.terminalState;
      }
      webServerLogger.info(
        `[WebServer] Run finished runId=${execution.runId} context=${execution.context.scope}:${execution.context.namespace} terminal=${result.terminalState?.terminalCode ?? 'complete'}`
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const terminalState = (err as Error & { terminalState?: RunTerminalState | null }).terminalState ?? null;
      webServerLogger.error(
        `[WebServer] Run failed runId=${execution.runId} context=${execution.context.scope}:${execution.context.namespace} terminal=${terminalState?.terminalCode ?? 'none'} error=${err.message || 'Unknown error'}`
      );
      if (terminalState) {
        deferredTerminalState = terminalState;
      } else {
        deferredErrorMessage = err.message || 'Unknown error';
      }
      shouldStopController =
        !terminalState ||
        (terminalState.terminalCode === 'error' && !this.options.isRecoverableCheckpointTerminalState(terminalState));
    } finally {
      await this.options.finalizeTrackedRun(execution.runId, execution.refreshCatalogOnFinish ?? false);
      await this.options.afterFinalizeTrackedRun?.(execution);
      webServerLogger.info(
        `[WebServer] Run finalized runId=${execution.runId} context=${execution.context.scope}:${execution.context.namespace} activeRuns=${this.options.getActiveRunCount()}`
      );
    }
    let deferredFailure: Error | null = null;
    try {
      if (deferredTerminalState) {
        const terminalError =
          deferredTerminalState.terminalCode === 'error' &&
          !deferredTerminalState.artifact &&
          String(deferredTerminalState.errorSummary ?? '').trim();
        if (terminalError) {
          this.options.recordRuntimeErrorMessage(execution.context, {
            runId: deferredTerminalState.runId,
            message: terminalError,
            terminalState: deferredTerminalState,
          });
        }
        execution.dispatcher.runTerminal(deferredTerminalState);
        if (this.options.isRecoverableCheckpointTerminalState(deferredTerminalState)) {
          try {
            this.options.scheduleRecoverableCheckpointContinuation(execution, deferredTerminalState);
          } catch (error) {
            if (!deferredFailure) {
              deferredFailure = error instanceof Error ? error : new Error(String(error));
            }
          }
        }
      } else if (deferredErrorMessage) {
        this.options.recordRuntimeErrorMessage(execution.context, {
          runId: execution.runId,
          message: deferredErrorMessage,
        });
        execution.dispatcher.error(deferredErrorMessage);
      }
    } catch (error) {
      deferredFailure = error instanceof Error ? error : new Error(String(error));
    }
    if (shouldStopController) {
      try {
        execution.stopControllerOnError?.stop('error');
      } catch (error) {
        if (!deferredFailure) {
          deferredFailure = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
    if (deferredFailure) {
      throw deferredFailure;
    }
  }
}
