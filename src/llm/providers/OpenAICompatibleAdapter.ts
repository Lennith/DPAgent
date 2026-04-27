import OpenAI from 'openai';
import { llmLogger } from '../../utils/logger.js';
import { messageTextContent } from '../message-preparation.js';
import { buildToolProtocolFrames } from '../tool-protocol.js';
import type { LLMClientConfig, LLMRequestOptions, LLMStreamEvent } from '../runtime-types.js';
import type {
  LLMResponse,
  Message,
  ResolvedLlmRuntimeConfig,
  TokenUsage,
  ToolCall,
  ToolSchema,
} from '../../types.js';

interface StreamingToolCallState {
  id?: string;
  name?: string;
  argumentsText: string;
  started: boolean;
}

interface StreamingThinkPrefixState {
  prefixResolved: boolean;
  consumedThinkBlocks: boolean;
  buffer: string;
}

export class OpenAICompatibleAdapter {
  private client: OpenAI;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly llmRuntime?: ResolvedLlmRuntimeConfig;

  constructor(config: LLMClientConfig) {
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.llmRuntime = config.llmRuntime;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.apiBase.replace(/\/$/, ''),
    });
  }

  async generate(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const requestParams = this.buildRequestParams(messages, tools, systemPrompt, options, false);
    const response = await this.client.chat.completions.create(requestParams as never);
    return this.convertResponse(response as unknown as Record<string, unknown>);
  }

  async *generateStream(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
    const requestParams = this.buildRequestParams(messages, tools, systemPrompt, options, true);
    const stream = (await this.client.chat.completions.create(requestParams as never)) as unknown as AsyncIterable<
      Record<string, unknown>
    >;

    let textContent = '';
    let thinking = '';
    let finishReason: string | undefined;
    let usage: TokenUsage | undefined;
    const toolStates = new Map<number, StreamingToolCallState>();
    const thinkPrefixState: StreamingThinkPrefixState = {
      prefixResolved: false,
      consumedThinkBlocks: false,
      buffer: '',
    };

    for await (const chunk of stream) {
      const chunkUsage = this.extractUsage(chunk);
      if (chunkUsage) {
        usage = chunkUsage;
      }

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = (choices[0] ?? null) as Record<string, unknown> | null;
      if (!choice) {
        continue;
      }

      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      const reasoningDelta = this.extractReasoningText(delta);
      if (reasoningDelta) {
        thinking += reasoningDelta;
        yield { type: 'thinking', data: reasoningDelta };
      }

      const contentDelta = this.extractContentText(delta.content);
      if (contentDelta) {
        const normalized = consumeStreamingThinkPrefix(thinkPrefixState, contentDelta, false);
        for (const thinkingDelta of normalized.thinkingDeltas) {
          thinking = appendThinkingText(thinking, thinkingDelta) ?? thinking;
          yield { type: 'thinking', data: thinkingDelta };
        }
        for (const textDelta of normalized.textDeltas) {
          textContent += textDelta;
          yield { type: 'text', data: textDelta };
        }
      }

      const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const entry of rawToolCalls) {
        const toolCallDelta = (entry ?? {}) as Record<string, unknown>;
        const index =
          typeof toolCallDelta.index === 'number' && Number.isFinite(toolCallDelta.index) ? toolCallDelta.index : 0;
        const state = toolStates.get(index) ?? { argumentsText: '', started: false };
        const functionDelta =
          toolCallDelta.function && typeof toolCallDelta.function === 'object'
            ? (toolCallDelta.function as Record<string, unknown>)
            : undefined;

        if (typeof toolCallDelta.id === 'string' && toolCallDelta.id.trim().length > 0) {
          state.id = toolCallDelta.id.trim();
        }
        if (typeof functionDelta?.name === 'string' && functionDelta.name.trim().length > 0) {
          state.name = functionDelta.name.trim();
        }
        if (!state.started && state.id && state.name) {
          state.started = true;
          yield { type: 'tool_start', data: { id: state.id, name: state.name } };
        }

        if (typeof functionDelta?.arguments === 'string' && functionDelta.arguments.length > 0) {
          state.argumentsText += functionDelta.arguments;
          yield { type: 'tool_input', data: functionDelta.arguments };
        }

        toolStates.set(index, state);
      }

      if (typeof choice.finish_reason === 'string' && choice.finish_reason.trim().length > 0) {
        finishReason = choice.finish_reason;
      }
    }

    const trailingNormalized = consumeStreamingThinkPrefix(thinkPrefixState, '', true);
    for (const thinkingDelta of trailingNormalized.thinkingDeltas) {
      thinking = appendThinkingText(thinking, thinkingDelta) ?? thinking;
      yield { type: 'thinking', data: thinkingDelta };
    }
    for (const textDelta of trailingNormalized.textDeltas) {
      textContent += textDelta;
      yield { type: 'text', data: textDelta };
    }

    const response = this.buildResponseFromStreamingState({
      textContent,
      thinking,
      usage,
      finishReason,
      toolStates,
    });
    yield { type: 'complete', data: response };
    return response;
  }

  private buildRequestParams(
    messages: Message[],
    tools: ToolSchema[] | undefined,
    systemPrompt: string | undefined,
    options: LLMRequestOptions | undefined,
    stream: boolean
  ): Record<string, unknown> {
    const requestParams: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      messages: this.convertMessages(messages, systemPrompt),
      stream,
    };

    if (tools && tools.length > 0) {
      requestParams.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      requestParams.tool_choice = 'auto';
    }

    if (stream) {
      requestParams.stream_options = { include_usage: true };
    }

    const reasoningEffort = resolveOpenAiReasoningEffort(this.llmRuntime);
    if (reasoningEffort) {
      requestParams.reasoning_effort = reasoningEffort;
    }

    return requestParams;
  }

  private convertMessages(messages: Message[], systemPrompt?: string): Array<Record<string, unknown>> {
    const payload: Array<Record<string, unknown>> = [];
    if (systemPrompt && systemPrompt.trim().length > 0) {
      payload.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    const protocol = buildToolProtocolFrames(messages);
    if (protocol.assistantToolBundleCount > 0) {
      llmLogger.debug(
        `[OpenAICompatibleAdapter] Replay protocol bundles=${protocol.assistantToolBundleCount} tool_results=${protocol.toolResultMessageCount} max_bundle=${protocol.maxToolResultsPerBundle}`
      );
    }

    for (const frame of protocol.frames) {
      if (frame.kind === 'assistant_tool_bundle') {
        payload.push(this.convertAssistantMessage(frame.assistant));
        for (const toolMessage of frame.toolResults) {
          payload.push(this.convertToolMessage(toolMessage));
        }
        continue;
      }
      if (this.hasUnbundledToolCalls(frame.message)) {
        payload.push(this.convertAssistantMessage({ ...frame.message, toolCalls: undefined }));
        payload.push({
          role: 'user',
          content: this.buildMalformedToolProtocolNotice(
            'assistant tool_use replay was dropped because aligned tool_result messages were missing'
          ),
        });
        continue;
      }
      payload.push(this.convertSingleMessage(frame.message));
    }

    return payload;
  }

  private convertSingleMessage(message: Message): Record<string, unknown> {
    if (message.role === 'assistant') {
      return this.convertAssistantMessage(message);
    }

    if (message.role === 'tool') {
      return this.convertToolMessage(message);
    }

    if (message.role === 'system') {
      return { role: 'system', content: messageTextContent(message.content) };
    }

    return {
      role: 'user',
      content: this.convertUserContent(message.content),
    };
  }

  private convertAssistantMessage(message: Message): Record<string, unknown> {
    const assistantPayload: Record<string, unknown> = {
      role: 'assistant',
    };
    const textContent = messageTextContent(message.content);
    const replayContent = this.buildAssistantReplayContent(message.thinking, textContent);
    assistantPayload.content = replayContent.length > 0 ? replayContent : null;
    if (message.toolCalls && message.toolCalls.length > 0) {
      assistantPayload.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.function.name,
          arguments: JSON.stringify(toolCall.function.arguments ?? {}),
        },
      }));
    }
    return assistantPayload;
  }

  private convertToolMessage(message: Message): Record<string, unknown> {
    const toolCallId = message.toolCallId?.trim() ?? '';
    if (!toolCallId) {
      return {
        role: 'user',
        content: this.buildMalformedToolProtocolNotice('orphan tool_result replay was converted to user note'),
      };
    }
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content: messageTextContent(message.content),
    };
  }

  private hasUnbundledToolCalls(message: Message): boolean {
    return message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
  }

  private buildMalformedToolProtocolNotice(reason: string): string {
    return `[TOOLCALL_FAILED] ${reason}. next_action=Issue fresh tool calls and continue from latest valid state.`;
  }

  private buildAssistantReplayContent(thinking: string | undefined, textContent: string): string {
    const normalizedThinking = String(thinking ?? '').trim();
    const normalizedText = textContent.trim();
    if (!normalizedThinking) {
      return normalizedText;
    }
    const thinkCarrier = `<think>\n${normalizedThinking}\n</think>`;
    if (!normalizedText) {
      return thinkCarrier;
    }
    return `${thinkCarrier}\n${normalizedText}`;
  }

  private convertUserContent(content: Message['content']): string | Array<Record<string, unknown>> {
    if (typeof content === 'string') {
      return content;
    }

    const parts: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'image' && block.source?.type === 'base64') {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        });
        continue;
      }
      if (block.type === 'tool_result' && block.content) {
        parts.push({ type: 'text', text: block.content });
        continue;
      }
      if (block.type === 'tool_use') {
        parts.push({ type: 'text', text: JSON.stringify(block.input ?? {}) });
      }
    }

    if (parts.length === 1 && parts[0]?.type === 'text' && typeof parts[0].text === 'string') {
      return parts[0].text as string;
    }

    return parts;
  }

  private convertResponse(response: Record<string, unknown>): LLMResponse {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const message =
      choice.message && typeof choice.message === 'object' ? (choice.message as Record<string, unknown>) : {};
    const rawContent = this.extractContentText(message.content);
    const inlineThinkNormalized = normalizeInlineThinkingFromContent(rawContent);
    const content = inlineThinkNormalized.content;
    const thinking = appendThinkingText(this.extractReasoningText(message), inlineThinkNormalized.thinking);
    const toolCalls = this.extractToolCalls(message.tool_calls);
    const usage = this.extractUsage(response);
    const finishReason = normalizeOpenAiFinishReason(choice.finish_reason, toolCalls.length);

    llmLogger.info(
      `[OpenAICompatibleAdapter] Response normalized: raw_finish_reason=${String(choice.finish_reason ?? 'undefined')} finishReason=${finishReason} toolCalls=${toolCalls.length} contentChars=${content.length} thinkingChars=${thinking?.length ?? 0}`
    );

    return {
      content,
      thinking,
      thinkingSignature: undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage,
    };
  }

  private buildResponseFromStreamingState(input: {
    textContent: string;
    thinking: string;
    usage?: TokenUsage;
    finishReason?: string;
    toolStates: Map<number, StreamingToolCallState>;
  }): LLMResponse {
    const orderedStates = Array.from(input.toolStates.entries())
      .sort((left, right) => left[0] - right[0])
      .map((entry) => entry[1]);
    const toolCalls: ToolCall[] = orderedStates
      .filter((state) => state.name)
      .map((state, index) => ({
        id: state.id || `openai-tool-${index + 1}`,
        type: 'function',
        function: {
          name: state.name || `tool_${index + 1}`,
          arguments: parseToolArguments(state.argumentsText),
        },
      }));
    const normalizedFinishReason = normalizeOpenAiFinishReason(input.finishReason, toolCalls.length);

    return {
      content: input.textContent,
      thinking: input.thinking.length > 0 ? input.thinking : undefined,
      thinkingSignature: undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: normalizedFinishReason,
      usage: input.usage,
    };
  }

  private extractContentText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (!item || typeof item !== 'object') {
          return '';
        }
        const record = item as Record<string, unknown>;
        if (typeof record.text === 'string') {
          return record.text;
        }
        if (record.type === 'output_text' && typeof record.text === 'string') {
          return record.text;
        }
        return '';
      })
      .join('');
  }

  private extractReasoningText(source: Record<string, unknown>): string | undefined {
    const directCandidates = ['reasoning', 'reasoning_content', 'thinking'];
    for (const key of directCandidates) {
      const value = source[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }

    const reasoning = source.reasoning;
    if (Array.isArray(reasoning)) {
      const combined = reasoning
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return '';
          }
          const record = item as Record<string, unknown>;
          if (typeof record.text === 'string') {
            return record.text;
          }
          if (Array.isArray(record.summary)) {
            return record.summary
              .map((summaryItem) => {
                if (!summaryItem || typeof summaryItem !== 'object') {
                  return '';
                }
                const summaryRecord = summaryItem as Record<string, unknown>;
                return typeof summaryRecord.text === 'string' ? summaryRecord.text : '';
              })
              .join('\n');
          }
          return '';
        })
        .filter((item) => item.length > 0)
        .join('\n');
      return combined.length > 0 ? combined : undefined;
    }

    return undefined;
  }

  private extractToolCalls(rawToolCalls: unknown): ToolCall[] {
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

  private extractUsage(source: Record<string, unknown>): TokenUsage | undefined {
    const usage = source.usage;
    if (!usage || typeof usage !== 'object') {
      return undefined;
    }
    const usageRecord = usage as Record<string, unknown>;
    const promptTokens = typeof usageRecord.prompt_tokens === 'number' ? usageRecord.prompt_tokens : undefined;
    const completionTokens =
      typeof usageRecord.completion_tokens === 'number' ? usageRecord.completion_tokens : undefined;
    const totalTokens = typeof usageRecord.total_tokens === 'number' ? usageRecord.total_tokens : undefined;

    if (
      promptTokens === undefined &&
      completionTokens === undefined &&
      totalTokens === undefined
    ) {
      return undefined;
    }

    const resolvedPrompt = promptTokens ?? 0;
    const resolvedCompletion = completionTokens ?? 0;
    return {
      promptTokens: resolvedPrompt,
      completionTokens: resolvedCompletion,
      totalTokens: totalTokens ?? resolvedPrompt + resolvedCompletion,
    };
  }
}

function resolveOpenAiReasoningEffort(
  llmRuntime: ResolvedLlmRuntimeConfig | undefined
): 'low' | 'medium' | 'high' | undefined {
  if (!llmRuntime || llmRuntime.reasoningPreset === 'off' || llmRuntime.capabilities.reasoningEffort !== true) {
    return undefined;
  }

  const override = llmRuntime.providerOptions?.openai?.reasoningEffort;
  if (override === 'low' || override === 'medium' || override === 'high') {
    return override;
  }

  switch (llmRuntime.reasoningPreset) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    default:
      return undefined;
  }
}

function normalizeOpenAiFinishReason(rawFinishReason: unknown, toolCallCount: number): string {
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

function appendThinkingText(existing: string | undefined, next: string | undefined): string | undefined {
  const values = [String(existing ?? '').trim(), String(next ?? '').trim()].filter((item) => item.length > 0);
  return values.length > 0 ? values.join('\n\n') : undefined;
}

function normalizeInlineThinkingFromContent(content: string): { content: string; thinking?: string } {
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

function consumeStreamingThinkPrefix(
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

function parseToolArguments(rawArguments: string): Record<string, unknown> {
  const trimmed = rawArguments.trim();
  if (trimmed.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch (error) {
    llmLogger.warn(
      `[OpenAICompatibleAdapter] Failed to parse tool arguments; preserving raw payload. error=${String(error)}`
    );
    return { _raw: rawArguments };
  }
}
