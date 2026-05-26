import OpenAI from 'openai';
import { llmLogger } from '../../utils/logger.js';
import { messageTextContent } from '../message-preparation.js';
import { prepareToolProtocol } from '../tool-protocol-analyzer.js';
import { resolveProviderRuntimeBaseUrl } from '../provider-endpoints.js';
import { normalizeTokenUsage } from '../token-usage.js';
import type { LLMClientConfig, LLMRequestOptions, LLMStreamEvent, PreparedProviderPayload } from '../runtime-types.js';
import type {
  LLMResponse,
  Message,
  ResolvedLlmRuntimeConfig,
  TokenUsage,
  ToolSchema,
} from '../../types.js';
import {
  appendThinkingText,
  buildToolCallsFromStreamingStates,
  consumeStreamingThinkPrefix,
  createStreamingToolCallState,
  normalizeInlineThinkingFromContent,
  normalizeOpenAiFinishReason,
  normalizeStreamingToolCallIndex,
  parseOpenAiToolCalls,
  resolveOpenAiReasoningEffort,
  type StreamingThinkPrefixState,
  type StreamingToolCallState,
} from './openai-compatible-utils.js';

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
      baseURL: resolveProviderRuntimeBaseUrl('openai', config.apiBase),
    });
  }

  async generate(
    payload: PreparedProviderPayload,
    tools?: ToolSchema[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const requestParams = this.buildRequestParams(payload, tools, options, false);
    const response = await this.client.chat.completions.create(requestParams as never, {
      signal: options?.signal,
    });
    return this.convertResponse(response as unknown as Record<string, unknown>);
  }

  async *generateStream(
    payload: PreparedProviderPayload,
    tools?: ToolSchema[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
    const requestParams = this.buildRequestParams(payload, tools, options, true);
    const stream = (await this.client.chat.completions.create(requestParams as never, {
      signal: options?.signal,
    })) as unknown as AsyncIterable<
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
        const index = normalizeStreamingToolCallIndex(toolCallDelta.index);
        const state = toolStates.get(index) ?? createStreamingToolCallState();
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
        if (typeof functionDelta?.arguments === 'string' && functionDelta.arguments.length > 0) {
          state.argumentsText += functionDelta.arguments;
          if (state.started && state.id) {
            yield { type: 'tool_input', data: { chunk: functionDelta.arguments, id: state.id, index } };
          } else {
            state.pendingArgumentChunks.push(functionDelta.arguments);
          }
        }
        if (!state.started && state.id && state.name) {
          state.started = true;
          yield { type: 'tool_start', data: { id: state.id, name: state.name, index } };
          if (state.pendingArgumentChunks.length > 0) {
            yield { type: 'tool_input', data: { chunk: state.pendingArgumentChunks.join(''), id: state.id, index } };
            state.pendingArgumentChunks = [];
          }
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

  buildPromptEstimationPayload(
    payload: PreparedProviderPayload,
    tools?: ToolSchema[],
    options?: LLMRequestOptions
  ): unknown {
    return this.buildRequestParams(payload, tools, options, true);
  }

  private buildRequestParams(
    payload: PreparedProviderPayload,
    tools: ToolSchema[] | undefined,
    options: LLMRequestOptions | undefined,
    stream: boolean
  ): Record<string, unknown> {
    const requestParams: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      messages: this.convertMessages(payload.messages, payload.systemPrompt),
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

    const protocol = prepareToolProtocol(messages);
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
        throw new Error('[OpenAICompatibleAdapter] provider payload must not contain unbundled assistant tool calls');
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
      throw new Error('[OpenAICompatibleAdapter] provider payload must not contain unbundled tool_result messages');
    }

    if (message.role === 'system') {
      throw new Error('[OpenAICompatibleAdapter] provider payload must not contain system role messages');
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
    const thinking = String(message.thinking ?? '');
    const replayThinkingAsReasoningContent = this.shouldReplayThinkingAsReasoningContent(message);
    if (replayThinkingAsReasoningContent) {
      assistantPayload.reasoning_content = thinking;
    }
    const replayContent = this.buildAssistantReplayContent(
      replayThinkingAsReasoningContent ? undefined : thinking,
      textContent
    );
    assistantPayload.content =
      replayContent.length > 0 ? replayContent : replayThinkingAsReasoningContent ? '' : null;
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

  private shouldReplayThinkingAsReasoningContent(message?: Message): boolean {
    const runtime = this.llmRuntime;
    const metadata =
      message?.metadata && typeof message.metadata === 'object'
        ? (message.metadata as Record<string, unknown>)
        : {};
    const candidates = [
      runtime?.profileId,
      runtime?.model,
      runtime?.apiBase,
      metadata.llmProviderProfileId,
      metadata.llmProvider,
      metadata.llmModel,
      this.model,
    ]
      .map((value) => String(value ?? '').toLowerCase())
      .filter(Boolean);
    return candidates.some((value) => value.includes('deepseek'));
  }

  private convertToolMessage(message: Message): Record<string, unknown> {
    const toolCallId = message.toolCallId?.trim() ?? '';
    if (!toolCallId) {
      throw new Error('[OpenAICompatibleAdapter] tool_result replay requires non-empty toolCallId');
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
    const toolCalls = parseOpenAiToolCalls(message.tool_calls);
    const usage = normalizeTokenUsage(response.usage, 'openai');
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
    const toolCalls = buildToolCallsFromStreamingStates(input.toolStates);
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

  private extractUsage(source: Record<string, unknown>): TokenUsage | undefined {
    return normalizeTokenUsage(source.usage, 'openai');
  }
}
