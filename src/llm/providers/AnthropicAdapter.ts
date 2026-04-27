import Anthropic from '@anthropic-ai/sdk';
import { llmLogger } from '../../utils/logger.js';
import { messageTextContent } from '../message-preparation.js';
import { buildToolProtocolFrames } from '../tool-protocol.js';
import type { LLMClientConfig, LLMRequestOptions, LLMStreamEvent } from '../runtime-types.js';
import type { LLMResponse, Message, ResolvedLlmRuntimeConfig, TokenUsage, ToolCall, ToolSchema } from '../../types.js';

const MINIMAX_DOMAINS = ['api.minimax.io', 'api.minimaxi.com'];

export class AnthropicAdapter {
  private client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly llmRuntime?: ResolvedLlmRuntimeConfig;

  constructor(config: LLMClientConfig) {
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.llmRuntime = config.llmRuntime;

    let apiBase = config.apiBase.replace(/\/$/, '');
    const isMinimax = MINIMAX_DOMAINS.some((domain) => apiBase.includes(domain));
    if (isMinimax) {
      apiBase = apiBase.replace('/anthropic', '').replace('/v1', '');
      apiBase = `${apiBase}/anthropic`;
    }

    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: apiBase,
    });
  }

  async generate(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const requestParams = this.buildRequestParams(messages, tools, systemPrompt, options);
    const response = await this.client.messages.create(requestParams);
    return this.convertResponse(response as Anthropic.Messages.Message);
  }

  async *generateStream(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
    const requestParams = this.buildRequestParams(messages, tools, systemPrompt, options);
    const stream = this.client.messages.stream(requestParams);

    let thinking = '';
    let thinkingSignature: string | undefined;
    let usage: TokenUsage | undefined;

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
          yield { type: 'tool_input', data: delta.partial_json };
        } else {
          llmLogger.warn(`Unknown delta type: ${delta.type}`);
        }
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          yield { type: 'tool_start', data: { id: block.id, name: block.name } };
        }
      } else if (event.type === 'message_start') {
        usage = {
          promptTokens: event.message.usage.input_tokens,
          completionTokens: 0,
          totalTokens: event.message.usage.input_tokens,
        };
      } else if (event.type === 'message_delta') {
        if (usage && event.usage) {
          usage.completionTokens = event.usage.output_tokens;
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
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

  private buildRequestParams(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Anthropic.Messages.MessageCreateParams {
    const requestParams: Anthropic.Messages.MessageCreateParams = {
      model: this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      messages: this.convertMessages(messages),
    };

    if (systemPrompt) {
      requestParams.system = systemPrompt;
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

    return requestParams;
  }

  private convertMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
    const protocol = buildToolProtocolFrames(messages);
    const payload: Anthropic.Messages.MessageParam[] = [];

    if (protocol.assistantToolBundleCount > 0) {
      llmLogger.debug(
        `[AnthropicAdapter] Replay protocol bundles=${protocol.assistantToolBundleCount} tool_results=${protocol.toolResultMessageCount} max_bundle=${protocol.maxToolResultsPerBundle}`
      );
    }

    for (const frame of protocol.frames) {
      if (frame.kind === 'assistant_tool_bundle') {
        if (this.hasNonReplayableThinking(frame.assistant)) {
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

      if (this.hasNonReplayableThinking(frame.message)) {
        payload.push({
          role: 'user' as const,
          content: this.buildNonReplayableThinkingMessageNotice(frame.message),
        });
        continue;
      }

      if (this.hasUnbundledToolCalls(frame.message)) {
        payload.push(this.convertAssistantMessage({ ...frame.message, toolCalls: undefined }));
        payload.push({
          role: 'user' as const,
          content: this.buildMalformedToolProtocolNotice(
            `assistant tool_use replay was dropped because aligned tool_result messages were missing`
          ),
        });
        continue;
      }

      payload.push(this.convertSingleMessage(frame.message));
    }

    return payload;
  }

  private convertSingleMessage(message: Message): Anthropic.Messages.MessageParam {
    if (message.role === 'assistant') {
      return this.convertAssistantMessage(message);
    }

    if (message.role === 'tool') {
      const toolUseId = message.toolCallId?.trim() ?? '';
      if (!toolUseId) {
        return {
          role: 'user' as const,
          content: this.buildMalformedToolProtocolNotice('orphan tool_result replay was converted to user note'),
        };
      }
      return {
        role: 'user' as const,
        content: [this.convertToolResultBlock(message)],
      };
    }

    if (message.role === 'system') {
      return { role: 'user' as const, content: messageTextContent(message.content) };
    }

    if (typeof message.content === 'string') {
      return { role: 'user' as const, content: message.content };
    }

    return { role: 'user' as const, content: this.convertUserContent(message.content) };
  }

  private convertAssistantMessage(message: Message): Anthropic.Messages.MessageParam {
    const content: Anthropic.Messages.ContentBlockParam[] = [];

    if (message.thinking && message.thinkingSignature && this.canReplayThinking(message)) {
      content.push({
        type: 'thinking',
        thinking: message.thinking,
        signature: message.thinkingSignature,
      } as Anthropic.Messages.ContentBlockParam);
    } else if (message.thinking) {
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

  private hasUnbundledToolCalls(message: Message): boolean {
    return message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
  }

  private hasNonReplayableThinking(message: Message): boolean {
    if (message.role !== 'assistant') {
      return false;
    }
    if (message.thinking) {
      return !this.canReplayThinking(message);
    }
    return Boolean(message.thinkingSignature);
  }

  private canReplayThinking(message: Message): boolean {
    if (!message.thinking || !message.thinkingSignature) {
      return false;
    }
    if (!this.llmRuntime) {
      return true;
    }
    const metadata = message.metadata;
    return (
      metadata?.thinkingComplete === true &&
      metadata.llmProvider === this.llmRuntime.provider &&
      metadata.llmModel === this.llmRuntime.model &&
      metadata.llmProviderProfileId === this.llmRuntime.profileId
    );
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

  private buildMalformedToolProtocolNotice(reason: string): string {
    return `[TOOLCALL_FAILED] ${reason}. next_action=Issue fresh tool calls and continue from latest valid state.`;
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
      usage = {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      };
    }

    const finishReason = String(response.stop_reason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn'));
    llmLogger.info(
      `[AnthropicAdapter] Response normalized: raw_stop_reason=${String(response.stop_reason ?? 'undefined')} finishReason=${finishReason} toolCalls=${toolCalls.length} contentChars=${content.length} thinkingChars=${thinking?.length ?? 0}`
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

function resolveAnthropicThinkingBudgetTokens(llmRuntime: ResolvedLlmRuntimeConfig | undefined): number | undefined {
  if (!llmRuntime || llmRuntime.reasoningPreset === 'off' || llmRuntime.capabilities.thinkingBudget !== true) {
    return undefined;
  }

  const override = llmRuntime.providerOptions?.anthropic?.thinkingBudgetTokens;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }

  switch (llmRuntime.reasoningPreset) {
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 8192;
    default:
      return undefined;
  }
}
