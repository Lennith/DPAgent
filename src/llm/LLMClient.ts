import type {
  APIProvider,
  ContextUsageEstimate,
  LLMResponse,
  Message,
  PreparedMessagesResult,
  PreparedMessagesSnapshot,
  ResolvedLlmRuntimeConfig,
  ToolSchema,
} from '../types.js';
import { llmLogger } from '../utils/logger.js';
import { estimateMessagesCharacters, prepareMessagesForModel } from './message-preparation.js';
import { assertReplaySafeToolProtocol, prepareToolProtocol } from './tool-protocol-analyzer.js';
import { estimateContextUsageFromPayload } from '../runtime/context-window-budget.js';
import { buildPreparedInputUsageSnapshot } from '../runtime/context-window-budget.js';
import type {
  LLMClientConfig,
  LLMRequestOptions,
  PreparedProviderPayload,
  LLMRuntime,
  LLMStreamEvent,
  StreamCallbacks,
} from './runtime-types.js';
import { AnthropicAdapter } from './providers/AnthropicAdapter.js';
import { OpenAICompatibleAdapter } from './providers/OpenAICompatibleAdapter.js';

interface LLMProviderAdapter {
  generate(
    payload: PreparedProviderPayload,
    tools?: ToolSchema[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse>;
  generateStream(
    payload: PreparedProviderPayload,
    tools?: ToolSchema[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown>;
  buildPromptEstimationPayload(
    payload: PreparedProviderPayload,
    tools?: ToolSchema[],
    options?: LLMRequestOptions
  ): unknown;
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
    const payload = this.prepareProviderPayload(messages, systemPrompt, options);
    this.emitPreparedMessagesSnapshot(options?.snapshotStage ?? 'initial', payload.preparation);
    return this.adapter.generate(payload, tools, options);
  }

  async *generateStream(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
    const payload = this.prepareProviderPayload(messages, systemPrompt, options);
    this.emitPreparedMessagesSnapshot(options?.snapshotStage ?? 'initial', payload.preparation);
    const generator = this.adapter.generateStream(payload, tools, options);
    return yield* generator;
  }

  async generateWithCallbacks(
    messages: Message[],
    callbacks: StreamCallbacks,
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    return this.consumeStreamWithCallbacks(
      this.generateStream(messages, tools, systemPrompt, options),
      callbacks
    );
  }

  async generatePreparedWithCallbacks(
    messages: Message[],
    callbacks: StreamCallbacks,
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const payload = this.prepareTrustedProviderPayload(messages, systemPrompt);
    this.emitPreparedMessagesSnapshot(options?.snapshotStage ?? 'initial', payload.preparation);
    return this.consumeStreamWithCallbacks(
      this.adapter.generateStream(payload, tools, options),
      callbacks
    );
  }

  private async consumeStreamWithCallbacks(
    generator: AsyncGenerator<LLMStreamEvent, LLMResponse, unknown>,
    callbacks: StreamCallbacks
  ): Promise<LLMResponse> {
    let finalResponse: LLMResponse | undefined;
    const toolInputBuffer = new Map<string, { name: string; rawInput: string }>();
    const toolIndexToId = new Map<number, string>();
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
          if (typeof event.data.index === 'number') {
            toolIndexToId.set(event.data.index, event.data.id);
          }
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
          const activeToolId = resolveToolInputDeltaId(event.data, toolIndexToId, toolInputBuffer);
          const existing = toolInputBuffer.get(activeToolId);
          if (!existing) {
            throw new Error(`[INVALID_TOOL_STREAM_DELTA] tool_input referenced unknown tool id=${activeToolId}`);
          }
          toolInputBuffer.set(activeToolId, {
            ...existing,
            rawInput: existing.rawInput + event.data.chunk,
          });
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

  estimatePreparedInputUsage(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): ContextUsageEstimate {
    const payload = this.prepareTrustedProviderPayload(messages, systemPrompt);
    return estimateContextUsageFromPayload(
      this.adapter.buildPromptEstimationPayload(payload, tools, options)
    );
  }

  capturePreparedInputUsageSnapshot(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ) {
    const payload = this.prepareTrustedProviderPayload(messages, systemPrompt);
    return buildPreparedInputUsageSnapshot(
      this.adapter.buildPromptEstimationPayload(payload, tools, options)
    );
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

  private prepareProviderPayload(
    messages: Message[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): PreparedProviderPayload {
    const preparation = prepareMessagesForModel(messages, {
      trimOptions: options?.trimOptions,
    });
    return this.buildProviderPayloadFromPreparation(preparation, systemPrompt);
  }

  private prepareTrustedProviderPayload(
    messages: Message[],
    systemPrompt?: string
  ): PreparedProviderPayload {
    return this.buildProviderPayloadFromPreparation(
      buildTrustedPreparedMessagesResult(messages),
      systemPrompt
    );
  }

  private buildProviderPayloadFromPreparation(
    preparation: PreparedMessagesResult,
    systemPrompt?: string
  ): PreparedProviderPayload {
    const preparedMessages = preparation.postTrimSanitized.messages;
    assertPreparedMessagesValid(preparedMessages);
    const { providerMessages, systemPrompt: canonicalSystemPrompt } = splitSystemMessages(preparedMessages, systemPrompt);
    assertProviderPayloadMessages(providerMessages);
    return {
      messages: providerMessages,
      systemPrompt: canonicalSystemPrompt,
      preparation,
    };
  }
}

function splitSystemMessages(
  messages: Message[],
  systemPrompt?: string
): {
  providerMessages: Message[];
  systemPrompt?: string;
} {
  const systemMessages: string[] = [];
  const providerMessages: Message[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemMessages.push(messageTextForSystem(message));
      continue;
    }
    providerMessages.push(message);
  }
  const explicitSystemPrompt = String(systemPrompt ?? '').trim();
  const parts = [
    ...(explicitSystemPrompt.length > 0 ? [explicitSystemPrompt] : []),
    ...systemMessages.filter((item) => item.trim().length > 0),
  ];
  return {
    providerMessages,
    systemPrompt: parts.length > 0 ? parts.join('\n\n') : undefined,
  };
}

function messageTextForSystem(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .map((block) => {
      if (block.type === 'text') {
        return block.text ?? '';
      }
      return '';
    })
    .join('\n');
}

function assertProviderPayloadMessages(messages: Message[]): void {
  if (messages.some((message) => message.role === 'system')) {
    throw new Error('[INVALID_PROVIDER_PAYLOAD] provider messages must not contain system role messages.');
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

function resolveToolInputDeltaId(
  data: Extract<LLMStreamEvent, { type: 'tool_input' }>['data'],
  toolIndexToId: Map<number, string>,
  toolInputBuffer: Map<string, { name: string; rawInput: string }>
): string {
  if (data.id) {
    return data.id;
  }
  if (typeof data.index === 'number') {
    const id = toolIndexToId.get(data.index);
    if (id) {
      return id;
    }
    throw new Error(`[INVALID_TOOL_STREAM_DELTA] tool_input index=${data.index} has no matching tool_start`);
  }
  if (toolInputBuffer.size === 1) {
    throw new Error('[INVALID_TOOL_STREAM_DELTA] tool_input must include id or index even when only one tool is active');
  }
  throw new Error('[INVALID_TOOL_STREAM_DELTA] tool_input must include id or index');
}

function assertPreparedMessagesValid(messages: Message[]): void {
  assertReplaySafeToolProtocol(messages);
}

function buildTrustedPreparedMessagesResult(messages: Message[]): PreparedMessagesResult {
  const chars = estimateMessagesCharacters(messages);
  const protocol = prepareToolProtocol(messages);
  const sanitized = {
    messages: [...messages],
    correctedCount: 0,
    orphanToolCallFixed: 0,
    orphanToolResultFixed: 0,
  };
  return {
    preTrimSanitized: sanitized,
    trim: {
      messages: [...messages],
      originalChars: chars,
      trimmedChars: chars,
      removedCount: 0,
      truncatedCount: 0,
    },
    postTrimSanitized: sanitized,
    toolProtocol: {
      assistantToolBundleCount: protocol.assistantToolBundleCount,
      toolResultMessageCount: protocol.toolResultMessageCount,
      maxToolResultsPerBundle: protocol.maxToolResultsPerBundle,
    },
  };
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
