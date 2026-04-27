import type {
  APIProvider,
  LLMResponse,
  Message,
  PreparedMessagesResult,
  PreparedMessagesSnapshot,
  ResolvedLlmRuntimeConfig,
  ToolSchema,
} from '../types.js';
import { llmLogger } from '../utils/logger.js';
import { prepareMessagesForModel } from './message-preparation.js';
import { buildToolProtocolFrames } from './tool-protocol.js';
import type {
  LLMClientConfig,
  LLMRequestOptions,
  LLMRuntime,
  LLMStreamEvent,
  StreamCallbacks,
} from './runtime-types.js';
import { AnthropicAdapter } from './providers/AnthropicAdapter.js';
import { OpenAICompatibleAdapter } from './providers/OpenAICompatibleAdapter.js';

interface LLMProviderAdapter {
  generate(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<LLMResponse>;
  generateStream(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown>;
}

export class LLMClient implements LLMRuntime {
  readonly provider: APIProvider;
  private readonly adapter: LLMProviderAdapter;
  private readonly onPreparedMessages?: (snapshot: PreparedMessagesSnapshot) => void;
  private readonly llmRuntime?: ResolvedLlmRuntimeConfig;

  constructor(config: LLMClientConfig) {
    this.provider = normalizeProvider(config.provider);
    this.onPreparedMessages = config.onPreparedMessages;
    this.llmRuntime = config.llmRuntime;
    this.adapter = createProviderAdapter({
      ...config,
      provider: this.provider,
    });
  }

  getRuntimeConfig(): ResolvedLlmRuntimeConfig | undefined {
    return this.llmRuntime;
  }

  async generate(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const prepared = prepareMessagesForModel(messages, {
      trimOptions: options?.trimOptions,
    });
    this.emitPreparedMessagesSnapshot(options?.snapshotStage ?? 'initial', prepared);
    assertPreparedMessagesValid(prepared.postTrimSanitized.messages);
    return this.adapter.generate(prepared.postTrimSanitized.messages, tools, systemPrompt, options);
  }

  async *generateStream(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
    const prepared = prepareMessagesForModel(messages, {
      trimOptions: options?.trimOptions,
    });
    this.emitPreparedMessagesSnapshot(options?.snapshotStage ?? 'initial', prepared);
    assertPreparedMessagesValid(prepared.postTrimSanitized.messages);
    const generator = this.adapter.generateStream(prepared.postTrimSanitized.messages, tools, systemPrompt, options);
    return yield* generator;
  }

  async generateWithCallbacks(
    messages: Message[],
    callbacks: StreamCallbacks,
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const generator = this.generateStream(messages, tools, systemPrompt, options);
    let finalResponse: LLMResponse | undefined;
    const toolInputBuffer = new Map<string, { name: string; rawInput: string }>();
    const emittedToolUseInputs = new Map<string, Record<string, unknown>>();

    for await (const event of generator) {
      switch (event.type) {
        case 'text':
          callbacks.onText?.(event.data);
          break;
        case 'thinking':
          llmLogger.llmStreamEvent('thinking', event.data);
          callbacks.onThinking?.(event.data);
          break;
        case 'tool_start':
          toolInputBuffer.set(event.data.id, {
            name: event.data.name,
            rawInput: '',
          });
          if (!emittedToolUseInputs.has(event.data.id)) {
            callbacks.onToolUse?.(event.data.id, event.data.name, {});
            emittedToolUseInputs.set(event.data.id, {});
          }
          break;
        case 'tool_input': {
          const activeToolId = Array.from(toolInputBuffer.keys()).pop();
          if (activeToolId) {
            const existing = toolInputBuffer.get(activeToolId);
            if (existing) {
              toolInputBuffer.set(activeToolId, {
                ...existing,
                rawInput: existing.rawInput + event.data,
              });
            }
          }
          break;
        }
        case 'complete':
          finalResponse = event.data;
          emitToolUseCallbacks(finalResponse, toolInputBuffer, emittedToolUseInputs, callbacks);
          callbacks.onComplete?.(event.data);
          break;
      }
    }

    if (finalResponse === undefined) {
      throw new Error('[LLMClient] Stream ended without receiving a complete event. The LLM response may be incomplete or the stream was interrupted.');
    }

    return finalResponse;
  }

  private emitPreparedMessagesSnapshot(
    stage: PreparedMessagesSnapshot['stage'],
    prepared: PreparedMessagesResult
  ): void {
    if (!this.onPreparedMessages) {
      return;
    }
    const toolProtocol = prepared.toolProtocol ?? {
      assistantToolBundleCount: 0,
      toolResultMessageCount: 0,
      maxToolResultsPerBundle: 0,
    };

    this.onPreparedMessages({
      stage,
      capturedAt: new Date().toISOString(),
      preTrimSanitized: {
        correctedCount: prepared.preTrimSanitized.correctedCount,
        orphanToolCallFixed: prepared.preTrimSanitized.orphanToolCallFixed,
        orphanToolResultFixed: prepared.preTrimSanitized.orphanToolResultFixed,
      },
      postTrimSanitized: {
        correctedCount: prepared.postTrimSanitized.correctedCount,
        orphanToolCallFixed: prepared.postTrimSanitized.orphanToolCallFixed,
        orphanToolResultFixed: prepared.postTrimSanitized.orphanToolResultFixed,
      },
      trim: {
        originalChars: prepared.trim.originalChars,
        trimmedChars: prepared.trim.trimmedChars,
        removedCount: prepared.trim.removedCount,
        truncatedCount: prepared.trim.truncatedCount,
      },
      toolProtocol: {
        assistantToolBundleCount: toolProtocol.assistantToolBundleCount,
        toolResultMessageCount: toolProtocol.toolResultMessageCount,
        maxToolResultsPerBundle: toolProtocol.maxToolResultsPerBundle,
      },
      messages: prepared.postTrimSanitized.messages,
    });
  }
}

function normalizeProvider(provider?: APIProvider): APIProvider {
  return provider === 'openai' ? 'openai' : 'anthropic';
}

function createProviderAdapter(config: LLMClientConfig): LLMProviderAdapter {
  const provider = normalizeProvider(config.provider);
  if (provider === 'openai') {
    return new OpenAICompatibleAdapter(config);
  }
  return new AnthropicAdapter(config);
}

function emitToolUseCallbacks(
  response: LLMResponse,
  bufferedInputs: Map<string, { name: string; rawInput: string }>,
  alreadyEmittedInputs: Map<string, Record<string, unknown>>,
  callbacks: StreamCallbacks
): void {
  for (const toolCall of response.toolCalls ?? []) {
    const nextInput = toToolInputRecord(toolCall.function.arguments);
    const previousInput = alreadyEmittedInputs.get(toolCall.id);
    if (!shouldEmitToolUse(previousInput, nextInput)) {
      continue;
    }
    callbacks.onToolUse?.(toolCall.id, toolCall.function.name, nextInput);
    alreadyEmittedInputs.set(toolCall.id, nextInput);
  }

  for (const [toolId, buffered] of bufferedInputs.entries()) {
    const nextInput = parseBufferedToolInput(buffered.rawInput);
    const previousInput = alreadyEmittedInputs.get(toolId);
    if (!shouldEmitToolUse(previousInput, nextInput)) {
      continue;
    }
    callbacks.onToolUse?.(toolId, buffered.name, nextInput);
    alreadyEmittedInputs.set(toolId, nextInput);
  }
}

function assertPreparedMessagesValid(messages: Message[]): void {
  const frames = buildToolProtocolFrames(messages);
  const bundledToolIds = new Set<string>();
  for (const frame of frames.frames) {
    if (frame.kind !== 'assistant_tool_bundle') {
      continue;
    }
    for (const toolResult of frame.toolResults) {
      if (toolResult.toolCallId?.trim()) {
        bundledToolIds.add(toolResult.toolCallId.trim());
      }
    }
  }
  for (const message of messages) {
    if (message.role !== 'tool') {
      continue;
    }
    const toolCallId = message.toolCallId?.trim();
    if (!toolCallId || !bundledToolIds.has(toolCallId)) {
      throw new Error('[INVALID_REPLAY_PROTOCOL] tool_result message is not part of a valid assistant/tool bundle.');
    }
  }
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.toolCalls || message.toolCalls.length === 0) {
      continue;
    }
    const expectedIds = message.toolCalls.map((toolCall) => toolCall.id?.trim() ?? '');
    if (expectedIds.some((id) => id.length === 0) || new Set(expectedIds).size !== expectedIds.length) {
      throw new Error('[INVALID_REPLAY_PROTOCOL] assistant tool bundle contains missing or duplicate tool_call ids.');
    }
    const followingTools = messages.slice(i + 1, i + 1 + expectedIds.length);
    if (followingTools.length !== expectedIds.length || followingTools.some((entry) => entry.role !== 'tool')) {
      throw new Error('[INVALID_REPLAY_PROTOCOL] assistant tool bundle is missing aligned tool_result messages.');
    }
    const actualIds = followingTools.map((entry) => entry.toolCallId?.trim() ?? '');
    if (new Set(actualIds).size !== expectedIds.length || expectedIds.some((id) => !actualIds.includes(id))) {
      throw new Error('[INVALID_REPLAY_PROTOCOL] assistant tool bundle has misaligned tool_result ids.');
    }
  }
}

function shouldEmitToolUse(
  previousInput: Record<string, unknown> | undefined,
  nextInput: Record<string, unknown>
): boolean {
  if (!previousInput) {
    return true;
  }
  if (Object.keys(previousInput).length === 0 && Object.keys(nextInput).length > 0) {
    return true;
  }
  return false;
}

function toToolInputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function parseBufferedToolInput(rawInput: string): Record<string, unknown> {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return toToolInputRecord(JSON.parse(trimmed));
  } catch {
    return {};
  }
}
