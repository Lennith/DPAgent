import { llmLogger } from '../../utils/logger.js';
import type { ResolvedLlmRuntimeConfig, ToolCall } from '../../types.js';

export interface StreamingToolCallState {
  id?: string;
  name?: string;
  argumentsText: string;
  pendingArgumentChunks: string[];
  started: boolean;
}

export interface StreamingThinkPrefixState {
  prefixResolved: boolean;
  consumedThinkBlocks: boolean;
  buffer: string;
}

export function resolveOpenAiReasoningEffort(
  llmRuntime: ResolvedLlmRuntimeConfig | undefined
): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (!llmRuntime || llmRuntime.reasoningPreset === 'off' || llmRuntime.capabilities.reasoningEffort !== true) {
    return undefined;
  }

  const override = llmRuntime.providerOptions?.openai?.reasoningEffort;
  if (override === 'low' || override === 'medium' || override === 'high' || override === 'xhigh') {
    return override;
  }

  switch (llmRuntime.reasoningPreset) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    default:
      return undefined;
  }
}

export function normalizeOpenAiFinishReason(rawFinishReason: unknown, toolCallCount: number): string {
  if (typeof rawFinishReason !== 'string' || rawFinishReason.trim().length === 0) {
    return toolCallCount > 0 ? 'tool_use' : 'end_turn';
  }

  switch (rawFinishReason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return rawFinishReason;
  }
}

export function createStreamingToolCallState(): StreamingToolCallState {
  return {
    argumentsText: '',
    pendingArgumentChunks: [],
    started: false,
  };
}

export function normalizeStreamingToolCallIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('[INVALID_TOOL_STREAM_DELTA] OpenAI-compatible tool_call delta is missing numeric index');
  }
  return value;
}

export function appendThinkingText(existing: string | undefined, next: string | undefined): string | undefined {
  const values = [String(existing ?? ''), String(next ?? '')].filter((item) => item.trim().length > 0);
  return values.length > 0 ? values.join('\n\n') : undefined;
}

export function normalizeInlineThinkingFromContent(content: string): { content: string; thinking?: string } {
  let remaining = String(content || '');
  const thinkingParts: string[] = [];

  while (true) {
    const leadingWhitespaceMatch = remaining.match(/^\s*/u);
    const leadingWhitespace = leadingWhitespaceMatch?.[0] ?? '';
    const afterWhitespace = remaining.slice(leadingWhitespace.length);
    if (!afterWhitespace.startsWith('<think>')) {
      break;
    }
    const closeIndex = afterWhitespace.indexOf('</think>', '<think>'.length);
    if (closeIndex < 0) {
      break;
    }
    const inner = afterWhitespace.slice('<think>'.length, closeIndex).trim();
    if (inner.length > 0) {
      thinkingParts.push(inner);
    }
    remaining = afterWhitespace.slice(closeIndex + '</think>'.length);
  }

  return {
    content: thinkingParts.length > 0 ? remaining.replace(/^\s+/u, '') : content,
    thinking: thinkingParts.length > 0 ? thinkingParts.join('\n\n') : undefined,
  };
}

export function consumeStreamingThinkPrefix(
  state: StreamingThinkPrefixState,
  contentDelta: string,
  finalize: boolean
): { textDeltas: string[]; thinkingDeltas: string[] } {
  if (contentDelta.length > 0) {
    state.buffer += contentDelta;
  }

  const textDeltas: string[] = [];
  const thinkingDeltas: string[] = [];

  while (true) {
    if (state.prefixResolved) {
      if (state.buffer.length > 0) {
        textDeltas.push(state.buffer);
        state.buffer = '';
      }
      return { textDeltas, thinkingDeltas };
    }

    const leadingWhitespaceMatch = state.buffer.match(/^\s*/u);
    const leadingWhitespace = leadingWhitespaceMatch?.[0] ?? '';
    const afterWhitespace = state.buffer.slice(leadingWhitespace.length);

    if (afterWhitespace.length === 0) {
      if (finalize) {
        state.prefixResolved = true;
        state.buffer = '';
      }
      return { textDeltas, thinkingDeltas };
    }

    if (afterWhitespace.startsWith('<think>')) {
      const closeIndex = afterWhitespace.indexOf('</think>', '<think>'.length);
      if (closeIndex < 0) {
        if (finalize) {
          const fallbackText = state.consumedThinkBlocks ? afterWhitespace : state.buffer;
          if (fallbackText.length > 0) {
            textDeltas.push(fallbackText);
          }
          state.prefixResolved = true;
          state.buffer = '';
        }
        return { textDeltas, thinkingDeltas };
      }

      const inner = afterWhitespace.slice('<think>'.length, closeIndex).trim();
      if (inner.length > 0) {
        thinkingDeltas.push(inner);
      }
      state.consumedThinkBlocks = true;
      state.buffer = afterWhitespace.slice(closeIndex + '</think>'.length);
      continue;
    }

    if (!finalize && '<think>'.startsWith(afterWhitespace)) {
      return { textDeltas, thinkingDeltas };
    }

    const text = state.consumedThinkBlocks ? afterWhitespace.replace(/^\s+/u, '') : state.buffer;
    if (text.length > 0) {
      textDeltas.push(text);
    }
    state.prefixResolved = true;
    state.buffer = '';
    return { textDeltas, thinkingDeltas };
  }
}

export function buildToolCallsFromStreamingStates(toolStates: Map<number, StreamingToolCallState>): ToolCall[] {
  return Array.from(toolStates.entries())
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1])
    .filter((state) => state.name)
    .map((state, index) => ({
      id: state.id || `openai-tool-${index + 1}`,
      type: 'function',
      function: {
        name: state.name || `tool_${index + 1}`,
        arguments: parseToolArguments(state.argumentsText),
      },
    }));
}

export function parseOpenAiToolCalls(rawToolCalls: unknown): ToolCall[] {
  if (!Array.isArray(rawToolCalls)) {
    return [];
  }

  return rawToolCalls
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const fn =
        record.function && typeof record.function === 'object' ? (record.function as Record<string, unknown>) : {};
      const name = typeof fn.name === 'string' ? fn.name.trim() : '';
      if (!name) {
        return null;
      }
      const rawArguments = typeof fn.arguments === 'string' ? fn.arguments : '';
      return {
        id: typeof record.id === 'string' && record.id.trim().length > 0 ? record.id.trim() : `openai-tool-${index + 1}`,
        type: 'function' as const,
        function: {
          name,
          arguments: parseToolArguments(rawArguments),
        },
      };
    })
    .filter((item): item is ToolCall => item !== null);
}

export function parseToolArguments(rawArguments: string): Record<string, unknown> {
  const trimmed = rawArguments.trim();
  if (trimmed.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error('tool arguments must be a JSON object');
  } catch (error) {
    llmLogger.warn(`[OpenAICompatibleAdapter] Invalid tool arguments rejected. error=${String(error)}`);
    throw new Error('[OpenAICompatibleAdapter] tool arguments must be a JSON object');
  }
}
