import type {
  CompletionMarkerStats,
  ContextOverflowEvent,
  ContextPrecompressEvent,
  ContextRef,
  MemoryTriggerEvent,
  PlanInputRequest,
  RunTerminalState,
  SkillTriggerEvent,
  ResolvedLlmRuntimeConfig,
} from '../../types.js';
import { toInterruptedArtifactView, toRunTerminalStateView } from './interrupted-artifact-view.js';

export interface ServerWsMessage {
  type: string;
  data: unknown;
}

interface CallbackEventScope {
  runId: string;
  context: ContextRef;
  llmRuntime?: ResolvedLlmRuntimeConfig;
}

interface ContextUtilizationPayload {
  observedAt: string;
  ratio: number;
  usedChars: number;
  limitChars: number;
  triggerRatio?: number;
  isWarning: boolean;
  message?: string;
}

interface ContextPrecompressPayload {
  phase?: ContextPrecompressEvent['phase'];
  source?: ContextPrecompressEvent['source'];
  observedAt: string;
  ratio: number;
  usedChars: number;
  limitChars: number;
  progressPercent?: number;
  chunkIndex?: number;
  chunkTotal?: number;
  checkpointId: ContextPrecompressEvent['profileRuntimePath'] | null;
  failureReason?: string;
  durationMs?: number;
  willRetriggerImmediately?: boolean;
  willRetriggerNextTurn?: boolean;
  providerPayloadCharsAfter?: number;
}

interface ContextOverflowPayload {
  observedAt: string;
  error: string;
  stage: ContextOverflowEvent['stage'];
  checkpointId: ContextOverflowEvent['contextOverflowSnapshotPath'] | null;
}

export function createCallbackEventMessageFactory(scope: CallbackEventScope) {
  const base = {
    runId: scope.runId,
    context: scope.context,
  };

  return {
    thinking(thinking: string): ServerWsMessage {
      return {
        type: 'thinking',
        data: { ...base, thinking },
      };
    },
    toolCall(name: string, args: Record<string, unknown>, toolCallId?: string): ServerWsMessage {
      const data =
        typeof toolCallId === 'string' && toolCallId.trim().length > 0
          ? { ...base, name, args, toolCallId }
          : { ...base, name, args };
      return {
        type: 'tool_call',
        data,
      };
    },
    toolResult(name: string, result: unknown): ServerWsMessage {
      return {
        type: 'tool_result',
        data: { ...base, name, result },
      };
    },
    step(step: number, maxSteps: number): ServerWsMessage {
      return {
        type: 'step',
        data: { ...base, step, maxSteps },
      };
    },
    message(role: string, content: string): ServerWsMessage {
      const llmRuntime = scope.llmRuntime
        ? {
            profileId: scope.llmRuntime.profileId,
            provider: scope.llmRuntime.provider,
            model: scope.llmRuntime.model,
            reasoningPreset: scope.llmRuntime.reasoningPreset,
          }
        : undefined;
      return {
        type: 'message',
        data: { ...base, role, content, ...(llmRuntime ? { llmRuntime } : {}) },
      };
    },
    memoryTrigger(event: MemoryTriggerEvent): ServerWsMessage {
      return {
        type: 'memory_trigger',
        data: {
          ...base,
          ...event,
        },
      };
    },
    skillTrigger(event: SkillTriggerEvent): ServerWsMessage {
      return {
        type: 'skill_trigger',
        data: {
          ...base,
          ...event,
        },
      };
    },
    error(error: string): ServerWsMessage {
      return {
        type: 'error',
        data: { ...base, error },
      };
    },
    contextUtilization(payload: ContextUtilizationPayload): ServerWsMessage {
      return {
        type: 'context_utilization',
        data: {
          ...base,
          observedAt: payload.observedAt,
          ratio: payload.ratio,
          utilizationRatio: payload.ratio,
          usedChars: payload.usedChars,
          limitChars: payload.limitChars,
          triggerRatio: payload.triggerRatio,
          isWarning: payload.isWarning,
          message: payload.message,
        },
      };
    },
    contextPrecompress(payload: ContextPrecompressPayload): ServerWsMessage {
      return {
        type: 'context_precompress',
        data: {
          ...base,
          ...(payload.phase ? { phase: payload.phase } : {}),
          ...(payload.source ? { source: payload.source } : {}),
          observedAt: payload.observedAt,
          ratio: payload.ratio,
          usedChars: payload.usedChars,
          limitChars: payload.limitChars,
          ...(typeof payload.progressPercent === 'number'
            ? { progressPercent: payload.progressPercent }
            : {}),
          ...(typeof payload.chunkIndex === 'number' ? { chunkIndex: payload.chunkIndex } : {}),
          ...(typeof payload.chunkTotal === 'number' ? { chunkTotal: payload.chunkTotal } : {}),
          checkpointId: payload.checkpointId ?? null,
          ...(payload.failureReason ? { failureReason: payload.failureReason } : {}),
          ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
          ...(typeof payload.willRetriggerImmediately === 'boolean'
            ? { willRetriggerImmediately: payload.willRetriggerImmediately }
            : {}),
          ...(typeof payload.willRetriggerNextTurn === 'boolean'
            ? { willRetriggerNextTurn: payload.willRetriggerNextTurn }
            : {}),
          ...(typeof payload.providerPayloadCharsAfter === 'number'
            ? { providerPayloadCharsAfter: payload.providerPayloadCharsAfter }
            : {}),
        },
      };
    },
    contextOverflow(payload: ContextOverflowPayload): ServerWsMessage {
      return {
        type: 'context_overflow',
        data: {
          ...base,
          observedAt: payload.observedAt,
          error: payload.error,
          stage: payload.stage,
          checkpointId: payload.checkpointId ?? null,
        },
      };
    },
    planInputRequested(request: PlanInputRequest): ServerWsMessage {
      return {
        type: 'plan_input_requested',
        data: {
          ...base,
          requestId: request.requestId,
          questions: request.questions,
        },
      };
    },
    complete(content: string, completionMarkerStats?: CompletionMarkerStats | null): ServerWsMessage {
      return {
        type: 'complete',
        data: {
          ...base,
          content,
          completionMarkerStats: completionMarkerStats ?? null,
          sessionId: scope.context.scope === 'session' ? scope.context.namespace : undefined,
        },
      };
    },
    runTerminal(state: RunTerminalState): ServerWsMessage {
      const view = toRunTerminalStateView(state);
      return {
        type: 'run_terminal',
        data: {
          ...base,
          ...view,
          sessionId: scope.context.scope === 'session' ? scope.context.namespace : undefined,
        },
      };
    },
    autoLoopStopped(reason: string | undefined, totalRounds: number): ServerWsMessage {
      return {
        type: 'auto_loop_stopped',
        data: {
          ...base,
          reason,
          totalRounds,
        },
      };
    },
    autoLoopRound(round: number, prompt: string): ServerWsMessage {
      return {
        type: 'auto_loop_round',
        data: {
          ...base,
          round,
          prompt,
        },
      };
    },
    chatStarted(startedAt: string, llmRuntime?: ResolvedLlmRuntimeConfig): ServerWsMessage {
      return {
        type: 'chat_started',
        data: {
          ...base,
          startedAt,
          ...(llmRuntime
            ? {
                llmRuntime: {
                  profileId: llmRuntime.profileId,
                  provider: llmRuntime.provider,
                  model: llmRuntime.model,
                  reasoningPreset: llmRuntime.reasoningPreset,
                },
              }
            : {}),
        },
      };
    },
  };
}
