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
import {
  createCallbackEventMessageFactory,
  type ServerWsMessage,
} from './callback-event-messages.js';

export interface CallbackEventDispatcherScope {
  runId: string;
  context: ContextRef;
  llmRuntime?: ResolvedLlmRuntimeConfig;
}

export interface ContextUtilizationDispatchPayload {
  observedAt: string;
  ratio: number;
  usedChars: number;
  limitChars: number;
  triggerRatio?: number;
  isWarning: boolean;
  message?: string;
}

export interface ContextPrecompressDispatchPayload {
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

export interface ContextOverflowDispatchPayload {
  observedAt: string;
  error: string;
  stage: ContextOverflowEvent['stage'];
  checkpointId: ContextOverflowEvent['contextOverflowSnapshotPath'] | null;
}

export function createCallbackEventDispatcher(
  emit: (message: ServerWsMessage) => void,
  scope: CallbackEventDispatcherScope
) {
  const messages = createCallbackEventMessageFactory(scope);

  return {
    thinking(thinking: string): void {
      emit(messages.thinking(thinking));
    },
    toolCall(name: string, args: Record<string, unknown>, toolCallId?: string): void {
      emit(messages.toolCall(name, args, toolCallId));
    },
    toolResult(name: string, result: unknown): void {
      emit(messages.toolResult(name, result));
    },
    step(step: number, maxSteps: number): void {
      emit(messages.step(step, maxSteps));
    },
    message(role: string, content: string): void {
      emit(messages.message(role, content));
    },
    memoryTrigger(event: MemoryTriggerEvent): void {
      emit(messages.memoryTrigger(event));
    },
    skillTrigger(event: SkillTriggerEvent): void {
      emit(messages.skillTrigger(event));
    },
    error(error: string): void {
      emit(messages.error(error));
    },
    contextUtilization(payload: ContextUtilizationDispatchPayload): void {
      emit(messages.contextUtilization(payload));
    },
    contextPrecompress(payload: ContextPrecompressDispatchPayload): void {
      emit(messages.contextPrecompress(payload));
    },
    contextOverflow(payload: ContextOverflowDispatchPayload): void {
      emit(messages.contextOverflow(payload));
    },
    planInputRequested(request: PlanInputRequest): void {
      emit(messages.planInputRequested(request));
    },
    complete(content: string, completionMarkerStats?: CompletionMarkerStats | null): void {
      emit(messages.complete(content, completionMarkerStats));
    },
    runTerminal(state: RunTerminalState): void {
      emit(messages.runTerminal(state));
    },
    autoLoopStopped(reason: string | undefined, totalRounds: number): void {
      emit(messages.autoLoopStopped(reason, totalRounds));
    },
    autoLoopRound(round: number, prompt: string): void {
      emit(messages.autoLoopRound(round, prompt));
    },
    chatStarted(startedAt: string, llmRuntime?: ResolvedLlmRuntimeConfig): void {
      emit(messages.chatStarted(startedAt, llmRuntime));
    },
  };
}
