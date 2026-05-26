import Anthropic from '@anthropic-ai/sdk';
import { llmLogger } from '../../utils/logger.js';
import { messageTextContent } from '../message-preparation.js';
import { prepareToolProtocol } from '../tool-protocol-analyzer.js';
import {
  createReasoningReplayPolicy,
  ReasoningReplayPolicy,
} from '../thinking-replay.js';
import { resolveAnthropicReasoningEffort, resolveAnthropicThinkingBudgetTokens } from '../anthropic-thinking-budget.js';
import { resolveProviderRuntimeBaseUrl } from '../provider-endpoints.js';
import { normalizeTokenUsage } from '../token-usage.js';
import type { LLMClientConfig, LLMRequestOptions, LLMStreamEvent, PreparedProviderPayload } from '../runtime-types.js';
import type { LLMResponse, Message, ResolvedLlmRuntimeConfig, TokenUsage, ToolCall, ToolSchema } from '../../types.js';

export class AnthropicAdapter {
  private client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly llmRuntime?: ResolvedLlmRuntimeConfig;
  private readonly reasoningReplayPolicy: ReasoningReplayPolicy;

  constructor(config: LLMClientConfig) {
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.llmRuntime = config.llmRuntime;
    this.reasoningReplayPolicy = createReasoningReplayPolicy(this.llmRuntime);
    const apiBase = resolveProviderRuntimeBaseUrl('anthropic', config.apiBase);

    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: apiBase,
    });
  }

  async generate(
    payload: PreparedProviderPayload,
    tools?: ToolSchema[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const requestParams = this.buildRequestParams(payload, tools, options);
    const response = await this.client.messages.create(requestParams, {
      signal: options?.signal,
    });
    return this.convertResponse(response as Anthropic.Messages.Message);
  }

  async *generateStream(
    payload: PreparedProviderPayload,
    tools?: ToolSchema[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
    const requestParams = this.buildRequestParams(payload, tools, options);
    const stream = this.client.messages.stream(requestParams, {
      signal: options?.signal,
    });

    let thinking = '';
    let thinkingSignature: string | undefined;
    let usage: TokenUsage | undefined;
    let streamPromptTokens: number | undefined;

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield { type: 'text', data: delta.text };
        } else if (delta.type === 'thinking_delta') {
          thinking += delta.thinking;
          yield { type: 'thinking', data: delta.thinking };
        } else if (delta.type === 'signature_delta') {
          thinkingSignature = delta.signature;
        } else if (delta.type === 'input_json_delta') {
          yield { type: 'tool_input', data: { chunk: delta.partial_json, index: event.index } };
        } else {
          llmLogger.warn(`Unknown delta type: ${delta.type}`);
        }
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          yield { type: 'tool_start', data: { id: block.id, name: block.name, index: event.index } };
        }
      } else if (event.type === 'message_start') {
        streamPromptTokens = event.message.usage.input_tokens;
        usage = undefined;
      } else if (event.type === 'message_delta') {
        if (typeof streamPromptTokens === 'number' && event.usage) {
          usage = normalizeTokenUsage(
            {
              input_tokens: streamPromptTokens,
              output_tokens: event.usage.output_tokens,
            },
            'anthropic'
          );
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    const response = this.convertResponse(finalMessage, {
      streamedThinking: thinking || undefined,
      streamedThinkingSignature: thinkingSignature,
      streamedUsage: usage,
    });
    yield { type: 'complete', data: response };
    return response;
  }

  buildPromptEstimationPayload(
    payload: PreparedProviderPayload,
    tools?: ToolSchema[],
    options?: LLMRequestOptions
  ): unknown {
    return this.buildRequestParams(payload, tools, options);
  }

  private buildRequestParams(
    payload: PreparedProviderPayload,
    tools?: ToolSchema[],
    options?: LLMRequestOptions
  ): Anthropic.Messages.MessageCreateParams {
    const requestParams: Anthropic.Messages.MessageCreateParams = {
      model: this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      messages: this.convertMessages(payload.messages),
    };

    if (payload.systemPrompt) {
      requestParams.system = payload.systemPrompt;
    }

    if (tools && tools.length > 0) {
      requestParams.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Messages.Tool['input_schema'],
      }));
    }

    const thinkingBudgetTokens = resolveAnthropicThinkingBudgetTokens(this.llmRuntime);
    if (thinkingBudgetTokens !== undefined) {
      (requestParams as unknown as Record<string, unknown>).thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudgetTokens,
      };
    }

    const reasoningEffort = resolveAnthropicReasoningEffort(this.llmRuntime);
    if (reasoningEffort !== undefined) {
      (requestParams as unknown as Record<string, unknown>).output_config = {
        effort: reasoningEffort,
      };
    }

    return requestParams;
  }

  private convertMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
    const protocol = prepareToolProtocol(messages);
    const payload: Anthropic.Messages.MessageParam[] = [];

    if (protocol.assistantToolBundleCount > 0) {
      llmLogger.debug(
        `[AnthropicAdapter] Replay protocol bundles=${protocol.assistantToolBundleCount} tool_results=${protocol.toolResultMessageCount} max_bundle=${protocol.maxToolResultsPerBundle}`
      );
    }

    for (const frame of protocol.frames) {
      if (frame.kind === 'assistant_tool_bundle') {
        if (
          this.reasoningReplayPolicy.shouldCollapseAnthropicToolBundle(frame.assistant) ||
          this.reasoningReplayPolicy.hasNonReplayableThinking(frame.assistant)
        ) {
          const textContent = messageTextContent(frame.assistant.content);
          if (textContent) {
            payload.push(this.convertAssistantMessage({
              ...frame.assistant,
              thinking: undefined,
              thinkingSignature: undefined,
              toolCalls: undefined,
            }));
          }
          payload.push({
            role: 'user' as const,
            content: this.buildNonReplayableThinkingToolBundleNotice(frame.assistant, frame.toolResults),
          });
          continue;
        }
        payload.push(this.convertAssistantMessage(frame.assistant));
        payload.push({
          role: 'user' as const,
          content: frame.toolResults.map((toolMessage) => this.convertToolResultBlock(toolMessage)),
        });
        continue;
      }

      if (this.reasoningReplayPolicy.hasNonReplayableThinking(frame.message)) {
        payload.push({
          role: 'user' as const,
          content: this.buildNonReplayableThinkingMessageNotice(frame.message),
        });
        continue;
      }

      payload.push(this.convertSingleMessage(frame.message));
    }

    return payload;
  }

  private convertSingleMessage(message: Message): Anthropic.Messages.MessageParam {
    if (message.role === 'assistant') {
      if (message.toolCalls && message.toolCalls.length > 0) {
        throw new Error('[AnthropicAdapter] provider payload must not contain unbundled assistant tool calls');
      }
      return this.convertAssistantMessage(message);
    }

    if (message.role === 'tool') {
      throw new Error('[AnthropicAdapter] provider payload must not contain unbundled tool_result messages');
    }

    if (message.role === 'system') {
      throw new Error('[AnthropicAdapter] provider payload must not contain system role messages');
    }

    if (typeof message.content === 'string') {
      return { role: 'user' as const, content: message.content };
    }

    return { role: 'user' as const, content: this.convertUserContent(message.content) };
  }

  private convertAssistantMessage(message: Message): Anthropic.Messages.MessageParam {
    const content: Anthropic.Messages.ContentBlockParam[] = [];
    const replayableThinking = this.reasoningReplayPolicy.getReplayableThinkingBlock(message);

    if (replayableThinking) {
      content.push({
        type: 'thinking',
        thinking: replayableThinking.thinking,
        ...(replayableThinking.signature ? { signature: replayableThinking.signature } : {}),
      } as Anthropic.Messages.ContentBlockParam);
    } else if (this.reasoningReplayPolicy.hasNonReplayableThinking(message)) {
      llmLogger.debug('Dropping non-replayable thinking block from replay payload');
    }

    const textContent = messageTextContent(message.content);
    if (textContent) {
      content.push({
        type: 'text',
        text: textContent,
      } as Anthropic.Messages.ContentBlockParam);
    }

    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: toolCall.function.arguments,
        } as Anthropic.Messages.ContentBlockParam);
      }
    }

    return { role: 'assistant', content };
  }

  private convertToolResultBlock(message: Message): Anthropic.Messages.ContentBlockParam {
    const toolUseId = message.toolCallId?.trim() ?? '';
    if (!toolUseId) {
      throw new Error('[AnthropicAdapter] tool_result replay requires non-empty toolCallId');
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: messageTextContent(message.content),
    } as Anthropic.Messages.ContentBlockParam;
  }

  private convertUserContent(content: Message['content']): string | Anthropic.Messages.ContentBlockParam[] {
    if (typeof content === 'string') {
      return content;
    }

    const blocks: Anthropic.Messages.ContentBlockParam[] = [];
    for (const block of content) {
      if (block.type === 'text') {
        blocks.push({
          type: 'text',
          text: block.text ?? '',
        } as Anthropic.Messages.ContentBlockParam);
        continue;
      }

      if (block.type === 'image' && block.source?.type === 'base64') {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: block.source.media_type,
            data: block.source.data,
          },
        } as Anthropic.Messages.ContentBlockParam);
        continue;
      }

      if (block.type === 'tool_result') {
        blocks.push({
          type: 'text',
          text: block.content ?? '',
        } as Anthropic.Messages.ContentBlockParam);
        continue;
      }

      if (block.type === 'tool_use') {
        blocks.push({
          type: 'text',
          text: JSON.stringify(block.input ?? {}),
        } as Anthropic.Messages.ContentBlockParam);
      }
    }

    if (blocks.length === 1 && blocks[0]?.type === 'text') {
      return String((blocks[0] as { text?: string }).text ?? '');
    }

    return blocks;
  }

  private buildNonReplayableThinkingToolBundleNotice(assistant: Message, toolResults: Message[]): string {
    const toolNames = (assistant.toolCalls ?? [])
      .map((toolCall) => toolCall.function.name)
      .filter((name) => name.trim().length > 0);
    const resultSummaries = toolResults
      .map((message) => {
        const content = messageTextContent(message.content).replace(/\s+/g, ' ').trim();
        return `${message.name ?? 'tool'}:${content.slice(0, 240)}`;
      })
      .join(' | ');
    return [
      '[TOOLCALL_REPLAY_DROPPED]',
      'replay_action=dropped_non_replayable_thinking_tool_protocol',
      'reason=assistant thinking block cannot be replayed with its original signature/runtime',
      `tools=${toolNames.join(',') || 'unknown'}`,
      resultSummaries ? `results=${resultSummaries}` : 'results=unavailable',
      'next_action=Continue from this summarized tool state or issue fresh tool calls.',
    ].join(' ');
  }

  private buildNonReplayableThinkingMessageNotice(assistant: Message): string {
    const textContent = messageTextContent(assistant.content).replace(/\s+/g, ' ').trim();
    return [
      '[ASSISTANT_REPLAY_DROPPED]',
      'replay_action=dropped_non_replayable_thinking_message',
      'reason=assistant thinking block cannot be replayed with its original signature/runtime',
      textContent ? `assistant_summary=${textContent.slice(0, 480)}` : 'assistant_summary=empty',
      'next_action=Continue from this summarized assistant state.',
    ].join(' ');
  }

  private convertResponse(
    response: Anthropic.Messages.Message,
    streamed?: {
      streamedThinking?: string;
      streamedThinkingSignature?: string;
      streamedUsage?: TokenUsage;
    }
  ): LLMResponse {
    let content = '';
    let thinking: string | undefined = streamed?.streamedThinking;
    let thinkingSignature: string | undefined = streamed?.streamedThinkingSignature;
    const toolCalls: ToolCall[] = [];
    let usage = streamed?.streamedUsage;

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'thinking') {
        thinking = block.thinking;
        thinkingSignature = block.signature ?? thinkingSignature;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          },
        });
      }
    }

    if (!usage && response.usage) {
      usage = normalizeTokenUsage(response.usage, 'anthropic');
    }

    const finishReason = String(response.stop_reason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn'));
    llmLogger.info(
      `[AnthropicAdapter] Response normalized: raw_stop_reason=${String(response.stop_reason ?? 'undefined')} finishReason=${finishReason} toolCalls=${toolCalls.length} contentChars=${content.length} thinkingChars=${thinking?.length ?? 0} usage=${usage ? `prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens}` : 'none'}`
    );

    return {
      content,
      thinking,
      thinkingSignature,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage,
    };
  }
}
