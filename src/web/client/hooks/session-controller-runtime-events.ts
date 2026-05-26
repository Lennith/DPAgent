import type { ToolResult } from '../chat-types.js';
import type {
  RunLlmRuntimeView,
  SessionRuntimeState,
} from '../app-shell-types.js';
import {
  appendLiveTextDelta,
  closeStreamingThinking,
  observeRunEvent,
  shouldApplyRunEvent,
  truncateLiveSummary,
  upsertRunStatusEvent,
  upsertToolCallState,
} from '../app-shell-types.js';

export function applyStepRuntimeEvent(input: {
  runtime: SessionRuntimeState;
  runId: string;
  step?: number;
  maxSteps?: number;
  now: number;
  processingTitle: string;
  stepTitle: string;
  modelTitle?: string;
  createEventId: () => string;
}): SessionRuntimeState {
  if (!shouldApplyRunEvent(input.runtime, input.runId)) {
    return input.runtime;
  }
  const nextRuntime = observeRunEvent(input.runtime, input.runId, input.now);
  const currentStep = typeof input.step === 'number' ? input.step : input.runtime.currentStep;
  const maxSteps = typeof input.maxSteps === 'number' ? input.maxSteps : input.runtime.maxSteps;
  return {
    ...nextRuntime,
    currentStep,
    maxSteps,
    liveEvents: upsertRunStatusEvent(nextRuntime.liveEvents, {
      title: currentStep > 0 && maxSteps > 0 ? input.stepTitle : input.processingTitle,
      summary: input.modelTitle,
      timestamp: input.now,
      createEventId: input.createEventId,
    }),
  };
}

export function applyThinkingRuntimeEvent(input: {
  runtime: SessionRuntimeState;
  runId: string;
  thinking: string;
  timestamp: number;
  createEventId: () => string;
}): SessionRuntimeState {
  if (!shouldApplyRunEvent(input.runtime, input.runId)) {
    return input.runtime;
  }
  const nextRuntime = observeRunEvent(input.runtime, input.runId, input.timestamp);
  const events = [...nextRuntime.liveEvents];
  const last = events[events.length - 1];
  if (last && last.type === 'thinking') {
    events[events.length - 1] = {
      ...last,
      thinking: `${last.thinking ?? ''}${input.thinking}`,
      isStreaming: true,
      timestamp: input.timestamp,
    };
  } else {
    events.push({
      id: input.createEventId(),
      type: 'thinking',
      thinking: input.thinking,
      isStreaming: true,
      timestamp: input.timestamp,
    });
  }
  return {
    ...nextRuntime,
    lastActivityAt: input.timestamp,
    liveEvents: events,
  };
}

export function applyToolCallRuntimeEvent(input: {
  runtime: SessionRuntimeState;
  runId: string;
  name: string;
  args: Record<string, unknown>;
  toolCallId?: string;
  timestamp: number;
  createEventId: () => string;
}): SessionRuntimeState {
  if (!shouldApplyRunEvent(input.runtime, input.runId)) {
    return input.runtime;
  }
  const nextRuntime = observeRunEvent(input.runtime, input.runId, input.timestamp);
  const { liveEvents, toolCallsAccumulator } = upsertToolCallState(
    closeStreamingThinking(nextRuntime.liveEvents),
    nextRuntime.toolCallsAccumulator,
    {
      toolCallId: input.toolCallId,
      name: input.name,
      args: input.args,
      timestamp: input.timestamp,
      createEventId: input.createEventId,
    }
  );
  return {
    ...nextRuntime,
    liveEvents,
    toolCallsAccumulator,
  };
}

export function applyToolResultRuntimeEvent(input: {
  runtime: SessionRuntimeState;
  runId: string;
  name: string;
  result: ToolResult['result'];
  timestamp: number;
  createEventId: () => string;
}): SessionRuntimeState {
  if (!shouldApplyRunEvent(input.runtime, input.runId)) {
    return input.runtime;
  }
  const nextRuntime = observeRunEvent(input.runtime, input.runId, input.timestamp);
  const nextEvents = closeStreamingThinking(nextRuntime.liveEvents);
  const toolResult: ToolResult = {
    name: input.name,
    result: input.result,
  };
  if (input.name !== 'send_file_to_user') {
    nextEvents.push({
      id: input.createEventId(),
      type: 'tool_result',
      name: input.name,
      result: input.result,
      timestamp: input.timestamp,
    });
  }
  return {
    ...nextRuntime,
    liveEvents: nextEvents,
    toolResultsAccumulator: [...nextRuntime.toolResultsAccumulator, toolResult],
  };
}

export function applyAssistantMessageDeltaRuntimeEvent(input: {
  runtime: SessionRuntimeState;
  runId: string;
  content: string;
  timestamp: number;
  llmRuntime?: RunLlmRuntimeView | null;
  createEventId: () => string;
}): SessionRuntimeState {
  if (!shouldApplyRunEvent(input.runtime, input.runId)) {
    return input.runtime;
  }
  const nextRuntime = observeRunEvent(input.runtime, input.runId, input.timestamp);
  const llmRuntime = input.llmRuntime ?? nextRuntime.currentLlmRuntime;
  return {
    ...nextRuntime,
    currentLlmRuntime: llmRuntime ?? null,
    liveEvents: appendLiveTextDelta(
      nextRuntime.liveEvents,
      input.content,
      input.timestamp,
      input.createEventId,
      llmRuntime
    ),
    contentAccumulator: nextRuntime.contentAccumulator + input.content,
  };
}

export function applyMemoryTriggerRuntimeEvent(input: {
  runtime: SessionRuntimeState;
  runId: string;
  title: string;
  content: string;
  liveTitle: string;
  timestamp: number;
  createEventId: () => string;
}): SessionRuntimeState {
  if (!shouldApplyRunEvent(input.runtime, input.runId)) {
    return input.runtime;
  }
  const nextRuntime = observeRunEvent(input.runtime, input.runId, input.timestamp);
  return {
    ...nextRuntime,
    liveEvents: [
      ...closeStreamingThinking(nextRuntime.liveEvents),
      {
        id: input.createEventId(),
        type: 'memory_trigger',
        title: input.liveTitle,
        summary: `${input.title}: ${truncateLiveSummary(input.content)}`,
        timestamp: input.timestamp,
      },
    ],
  };
}

export function applySkillTriggerRuntimeEvent(input: {
  runtime: SessionRuntimeState;
  runId: string;
  name: string;
  action?: 'create' | 'update';
  detail?: string;
  version?: string;
  liveTitle: string;
  timestamp: number;
  createEventId: () => string;
}): SessionRuntimeState {
  if (!shouldApplyRunEvent(input.runtime, input.runId)) {
    return input.runtime;
  }
  const detail = truncateLiveSummary(
    String(input.detail ?? '').trim() || (input.version ? `v${input.version}` : '')
  );
  const nextRuntime = observeRunEvent(input.runtime, input.runId, input.timestamp);
  return {
    ...nextRuntime,
    liveEvents: [
      ...closeStreamingThinking(nextRuntime.liveEvents),
      {
        id: input.createEventId(),
        type: 'skill_trigger',
        title: input.liveTitle,
        summary: `${input.action === 'update' ? 'update' : 'create'} ${input.name}${detail ? `: ${detail}` : ''}`,
        timestamp: input.timestamp,
      },
    ],
  };
}
