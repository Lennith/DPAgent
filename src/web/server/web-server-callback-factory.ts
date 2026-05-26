import { WebSocket } from 'ws';
import { autoLoopManager } from '../../auto-loop/index.js';
import { logger, webServerLogger } from '../../utils/logger.js';
import type {
  AgentCompletionMeta,
  ContextRef,
  ContextUsageEstimate,
  PlanInputAnswer,
  PlanInputRequest,
  ResolvedLlmRuntimeConfig,
  RunningInputInsertion,
} from '../../types.js';
import type {
  CallbackControlHandlers,
  CallbackEventDispatcher,
  CallbackObservationHandlers,
  ResolvedUserPromptResult,
} from './web-server-runtime-contracts.js';
import type { RunningInputQueueCoordinator } from './running-input-queue-coordinator.js';

export interface WebServerObservationCallbackHost {
  getContextBudget(llmRuntime?: ResolvedLlmRuntimeConfig): {
    estimatedContextWindowChars: number;
    contextWindowTokens: number;
  };
  updateContextNamespaceMetaSafe(context: ContextRef, patch: Record<string, unknown>): void;
}

export interface WebServerControlCallbackHost {
  rejectPendingPlanInputByRunId(runId: string, reason: string): void;
  refreshGlobalAgentCatalog(): void;
  requestUserInputFromSocket(
    ws: WebSocket,
    context: ContextRef,
    runId: string,
    request: PlanInputRequest,
    emitRequested: (request: PlanInputRequest) => void
  ): Promise<PlanInputAnswer[]>;
  getRunningInputQueue(): RunningInputQueueCoordinator;
  broadcastRunningInputQueue(context: ContextRef): void;
  resolveUserPrompt(input: {
    prompt: string;
    fileReferences?: string[];
    workspaceDir: string;
    context: ContextRef;
  }): ResolvedUserPromptResult;
  resolveWorkspaceDirForContext(context: ContextRef): string;
  handleCallbackCompletion(
    ws: WebSocket,
    context: ContextRef,
    runId: string,
    loopKey: string,
    result: string,
    dispatcher: CallbackEventDispatcher,
    finishReason?: string,
    meta?: AgentCompletionMeta
  ): Promise<void>;
  requestAutoLoopExitFromCallback(
    loopKey: string,
    context: ContextRef,
    runId: string,
    reason?: string
  ): { accepted: boolean; message: string };
}

export function createWebServerObservationCallbacks(
  host: WebServerObservationCallbackHost,
  dispatcher: CallbackEventDispatcher,
  context: ContextRef,
  llmRuntime?: ResolvedLlmRuntimeConfig
): CallbackObservationHandlers {
  const budget = host.getContextBudget(llmRuntime);
  const contextWindowChars = budget.estimatedContextWindowChars;
  const contextWindowTokens = budget.contextWindowTokens;
  let lastUtilizationSent = 0;
  const WARNING_THRESHOLD = 0.8;
  const BROADCAST_THRESHOLD = 0.1;

  const emitContextUtilization = (
    usedChars: number,
    isWarning = false,
    message?: string,
    tokenEstimate?: {
      usedTokens?: number;
      limitTokens?: number;
      source?: ContextUsageEstimate['source'];
      anchorPromptTokens?: number;
      deltaEstimatedTokens?: number;
    },
    forceBroadcast = false
  ): void => {
    const tokenRatio =
      typeof tokenEstimate?.usedTokens === 'number' &&
      typeof tokenEstimate.limitTokens === 'number' &&
      tokenEstimate.limitTokens > 0
        ? tokenEstimate.usedTokens / tokenEstimate.limitTokens
        : null;
    const ratio = Math.min(1.0, tokenRatio ?? usedChars / contextWindowChars);
    const observedAt = new Date().toISOString();
    if (context.scope === 'session') {
      host.updateContextNamespaceMetaSafe(context, {
        latestContextUtilization: {
          observedAt,
          ratio,
          usedChars,
          limitChars: contextWindowChars,
          usedTokens: tokenEstimate?.usedTokens,
          limitTokens: tokenEstimate?.limitTokens,
          source: tokenEstimate?.source,
          anchorPromptTokens: tokenEstimate?.anchorPromptTokens,
          deltaEstimatedTokens: tokenEstimate?.deltaEstimatedTokens,
          isWarning,
        },
      });
    }
    if (forceBroadcast || Math.abs(ratio - lastUtilizationSent) >= BROADCAST_THRESHOLD || isWarning) {
      lastUtilizationSent = ratio;
      dispatcher.contextUtilization({
        observedAt,
        ratio,
        usedChars,
        limitChars: contextWindowChars,
        usedTokens: tokenEstimate?.usedTokens,
        limitTokens: tokenEstimate?.limitTokens,
        source: tokenEstimate?.source,
        anchorPromptTokens: tokenEstimate?.anchorPromptTokens,
        deltaEstimatedTokens: tokenEstimate?.deltaEstimatedTokens,
        triggerRatio: isWarning ? WARNING_THRESHOLD : undefined,
        isWarning,
        message,
      });
    }
  };

  return {
    onThinking: (thinking: string) => {
      dispatcher.thinking(thinking);
    },
    onToolCall: (name: string, args: Record<string, unknown>, toolCallId?: string) => {
      logger.toolCall(name, args);
      dispatcher.toolCall(name, args, toolCallId);
    },
    onToolResult: (name: string, result) => {
      logger.toolResult(name, result, 0);
      dispatcher.toolResult(name, result);
    },
    onStep: (step: number, maxSteps: number) => {
      dispatcher.step(step, maxSteps);
    },
    onMessage: (role: string, content: string) => {
      dispatcher.message(role, content);
    },
    onMemoryTrigger: (event) => {
      dispatcher.memoryTrigger(event);
    },
    onSkillTrigger: (event) => {
      dispatcher.skillTrigger(event);
    },
    onContextUsageEstimate: (event) => {
      const ratio = event.ratio;
      emitContextUtilization(event.usedChars, ratio >= WARNING_THRESHOLD, undefined, {
        usedTokens: event.usedTokens,
        limitTokens: event.limitTokens,
        source: event.source,
        anchorPromptTokens: event.anchorPromptTokens,
        deltaEstimatedTokens: event.deltaEstimatedTokens,
      }, true);
    },
    onContextPrecompress: (event) => {
      if (event.triggered || event.forced) {
        const usedChars = event.totalCharsAfter;
        const ratio = usedChars / contextWindowChars;
        const warningMessage =
          ratio >= WARNING_THRESHOLD ? 'Context approaching capacity - compression triggered' : undefined;
        emitContextUtilization(usedChars, ratio >= WARNING_THRESHOLD, warningMessage, {
          usedTokens: event.providerPayloadTokensAfter,
          limitTokens: contextWindowTokens,
        });
        dispatcher.contextPrecompress({
          phase: event.phase ?? 'completed',
          source: event.source,
          observedAt: event.observedAt,
          ratio: Math.min(1.0, ratio),
          usedChars,
          limitChars: contextWindowChars,
          usedTokens: event.providerPayloadTokensAfter,
          limitTokens: contextWindowTokens,
          progressPercent: event.progressPercent,
          chunkIndex: event.chunkIndex,
          chunkTotal: event.chunkTotal,
          checkpointId: event.profileRuntimePath ?? null,
          failureReason: event.failureReason,
          durationMs: event.durationMs,
          willRetriggerImmediately: event.willRetriggerImmediately,
          willRetriggerNextTurn: event.willRetriggerNextTurn,
          providerPayloadCharsAfter: event.providerPayloadCharsAfter,
          providerPayloadTokensAfter: event.providerPayloadTokensAfter,
        });
      }
    },
    onContextOverflow: (event) => {
      const usedChars = event.afterChars ?? event.beforeChars;
      const usedTokens = event.afterTokens ?? event.beforeTokens;
      emitContextUtilization(usedChars, true, `Context overflow: ${event.stage}. Consider saving important work.`, {
        usedTokens,
        limitTokens: event.contextWindowTokens ?? contextWindowTokens,
      });
      dispatcher.contextOverflow({
        observedAt: event.observedAt,
        error: event.errorRaw,
        stage: event.stage,
        checkpointId: event.contextOverflowSnapshotPath ?? null,
        usedTokens,
        limitTokens: event.contextWindowTokens ?? contextWindowTokens,
      });
    },
  };
}

export function createWebServerControlCallbacks(
  host: WebServerControlCallbackHost,
  ws: WebSocket,
  context: ContextRef,
  runId: string,
  loopKey: string,
  dispatcher: CallbackEventDispatcher
): CallbackControlHandlers {
  return {
    onError: (error: Error) => {
      host.rejectPendingPlanInputByRunId(runId, error.message || 'run_error');
      host.refreshGlobalAgentCatalog();
      webServerLogger.warn(
        `[WebServer] Run callback error observed without direct terminal emission: context=${context.scope}/${context.namespace} runId=${runId} error=${error.message}`
      );
    },
    onRequestUserInput: async (request: PlanInputRequest): Promise<PlanInputAnswer[]> =>
      host.requestUserInputFromSocket(ws, context, runId, request, (nextRequest) => {
        dispatcher.planInputRequested(nextRequest);
      }),
    onConsumeRunningInput: async () => {
      const insertion = host.getRunningInputQueue().consumeInsert(context, runId);
      if (insertion) {
        host.broadcastRunningInputQueue(context);
      }
      return resolveInsertedRunningInput(host, context, insertion);
    },
    onRunningInputInserted: (event) => {
      dispatcher.runningInputInserted(event.itemId);
    },
    onComplete: async (result: string, finishReason?: string, meta?: AgentCompletionMeta) =>
      host.handleCallbackCompletion(ws, context, runId, loopKey, result, dispatcher, finishReason, meta),
    isInAutoLoop: () => {
      const controller = autoLoopManager.get(loopKey);
      return controller?.isInLoop() ?? false;
    },
    requestAutoLoopExit: (reason?: string) => host.requestAutoLoopExitFromCallback(loopKey, context, runId, reason),
  };
}

function resolveInsertedRunningInput(
  host: WebServerControlCallbackHost,
  context: ContextRef,
  insertion: RunningInputInsertion | null
): RunningInputInsertion | null {
  if (!insertion || !insertion.fileReferences || insertion.fileReferences.length === 0) {
    return insertion;
  }
  const resolved = host.resolveUserPrompt({
    prompt: insertion.prompt,
    fileReferences: insertion.fileReferences,
    workspaceDir: host.resolveWorkspaceDirForContext(context),
    context,
  });
  return resolved.ok
    ? {
        ...insertion,
        prompt: resolved.effectivePrompt,
      }
    : insertion;
}
