import { buildCompressionPrompt } from '../compression/index.js';
import { sanitizeMessagesForToolProtocol } from '../llm/index.js';
import {
  CONTEXT_REDUCTION_MARKERS,
  buildContextPrecompressedContent,
  buildCompressionRetryTruncatedNotice,
  prefixCompressionSourceTruncatedSummary,
  resolvePrecompressKeepRounds,
  shouldTriggerPrecompress,
} from '../runtime/context-reduction-policy.js';
import {
  buildCompressionChunks,
  collectCompressibleItems,
  extractChunkMessages,
} from '../runtime/compression-chunks.js';
import { tokensToCharHint } from '../shared/context-token-estimation.js';
import type {
  AgentCallback,
  ContextPrecompressEvent,
  Message,
  ResolvedContextBudget,
} from '../types.js';
import type { ContextReductionTrimOptions } from '../runtime/context-reduction-policy.js';
import type { ContextPayloadProjector } from '../context/ContextPayloadProjector.js';
import type { ContextCompressor } from '../compression/index.js';
import type {
  CompressionChunk,
  PreparedInputUsageEstimateResult,
} from './agent-contracts.js';
import { hashAgentMessages } from './agent-message-utils.js';
import { toPersistedMessages } from '../runtime/persisted-message-utils.js';
import {
  dropOldestCompressionRound,
  isPromptTooLongCompressionError,
  mergeCompressionChunkSummaries,
  yieldCompressionLoop,
} from './agent-compression-utils.js';
import { agentLogger } from '../utils/logger.js';
import type { MessageStore } from './MessageStore.js';

export type PrecompressMode = 'light' | 'aggressive' | 'disabled';

export interface CompressionRetryProgress {
  chunkIndex: number;
  chunkTotal: number;
  progressPercent: number;
}

export interface CompressionRetryResult {
  ok: boolean;
  summaries: string[];
  retryCount: number;
  droppedSourceMessageCount: number;
  compressionCallCount: number;
  failureReason?: string;
}

export interface LlmInputPreparatorHost {
  contextPrecompressChunkChars: number;
  contextPrecompressRetry: number;
  contextPrecompressKeepLlmRounds: number;
  contextPrecompressAggressiveKeepLlmRoundsCap: number;
  contextBudget: ResolvedContextBudget;
  contextPayloadProjector: ContextPayloadProjector;
  contextCompressor: ContextCompressor;
  messageStore: MessageStore;
  callback?: AgentCallback;
  lastCompletedPrecompressEvent: ContextPrecompressEvent | null;
  lastCompressionInputTokens: number;
  buildCompressionChunk(messages: Message[]): CompressionChunk;
  chunkMessagesForCompression(messages: Message[]): CompressionChunk[];
  resolveAdaptiveCompressionChunks(messages: Message[]): {
    chunkCharsApplied: number;
    chunks: CompressionChunk[];
  };
  compressChunksWithRetry(
    chunks: CompressionChunk[],
    onChunkProgress?: (input: CompressionRetryProgress) => Promise<void> | void
  ): Promise<CompressionRetryResult>;
  emitContextPrecompress(
    event: ContextPrecompressEvent,
    phase: NonNullable<ContextPrecompressEvent['phase']>,
    options?: { swallowErrors?: boolean }
  ): Promise<void>;
  splitMessagesForPrecompress(
    contentMessages: Message[],
    keepLlmRounds: number
  ): {
    olderMessages: Message[];
    tailMessages: Message[];
  };
  withCheckpointMetadata(
    message: Message,
    reason: 'user_prompt' | 'assistant_toolcall' | 'summary_anchor'
  ): Message;
  buildPreparedInputUsageEstimate(
    messages: Message[],
    systemPrompt: string | undefined,
    options?: { snapshotStage?: 'initial' | 'overflow_retry_after_compress' | 'overflow_retry_after_forced_trim' }
  ): PreparedInputUsageEstimateResult;
  buildNormalTrimOptions(): ContextReductionTrimOptions;
  buildProviderProjectionTrimOptions(maxTotalChars?: number): ContextReductionTrimOptions;
  contextCompactionConfigFingerprint(): string;
  clearPromptUsageAnchor(): void;
}

type CompressionChunkingHost = Pick<
  LlmInputPreparatorHost,
  'contextPrecompressChunkChars' | 'buildCompressionChunk'
>;

type AdaptiveCompressionHost = Pick<
  LlmInputPreparatorHost,
  'contextPrecompressChunkChars' | 'chunkMessagesForCompression'
>;

type CompressionChunkBuilderHost = Pick<LlmInputPreparatorHost, 'contextPayloadProjector'>;

type CompressionRetryHost = Pick<
  LlmInputPreparatorHost,
  'contextPrecompressRetry' | 'contextCompressor' | 'buildCompressionChunk'
>;

type ContextPrecompressEventHost = Pick<LlmInputPreparatorHost, 'callback'>;

type PrecompressValidationHost = Pick<
  LlmInputPreparatorHost,
  | 'lastCompletedPrecompressEvent'
  | 'messageStore'
  | 'contextPayloadProjector'
  | 'buildNormalTrimOptions'
  | 'buildPreparedInputUsageEstimate'
  | 'contextBudget'
  | 'emitContextPrecompress'
>;

export function splitMessagesForPrecompress(
    contentMessages: Message[],
    keepLlmRounds: number
  ): {
    olderMessages: Message[];
    tailMessages: Message[];
  } {
    if (contentMessages.length <= 2) {
      return {
        olderMessages: [],
        tailMessages: [...contentMessages],
      };
    }

    const rounds: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    while (cursor < contentMessages.length) {
      let assistantIdx = -1;
      for (let i = cursor; i < contentMessages.length; i += 1) {
        if (contentMessages[i]?.role === 'assistant') {
          assistantIdx = i;
          break;
        }
      }
      if (assistantIdx < 0) {
        break;
      }
      let end = assistantIdx;
      while (end + 1 < contentMessages.length && contentMessages[end + 1]?.role === 'tool') {
        end += 1;
      }
      rounds.push({ start: cursor, end });
      cursor = end + 1;
    }

    const normalizedKeepRounds = Math.max(1, Math.floor(keepLlmRounds));
    if (rounds.length <= normalizedKeepRounds) {
      return {
        olderMessages: [],
        tailMessages: [...contentMessages],
      };
    }

    const tailStart = rounds[rounds.length - normalizedKeepRounds].start;
    return {
      olderMessages: contentMessages.slice(0, tailStart),
      tailMessages: contentMessages.slice(tailStart),
    };
  }

export function chunkMessagesForCompression(this: CompressionChunkingHost, messages: Message[]): CompressionChunk[] {
    const compressible = collectCompressibleItems(messages);
    const maxChunkChars = Math.max(4000, Math.floor(this.contextPrecompressChunkChars));
    const rawChunks = buildCompressionChunks({ items: compressible, maxChunks: 3, maxChunkChars });
    return rawChunks.map((rawChunk) => {
      const chunkMessages = extractChunkMessages(messages, rawChunk);
      return this.buildCompressionChunk(chunkMessages);
    });
  }

export function resolveAdaptiveCompressionChunks(this: AdaptiveCompressionHost, messages: Message[]): {
    chunkCharsApplied: number;
    chunks: CompressionChunk[];
  } {
    const chunkCharsApplied = Math.max(4000, Math.floor(this.contextPrecompressChunkChars));
    return {
      chunkCharsApplied,
      chunks: this.chunkMessagesForCompression(messages),
    };
  }

export function buildCompressionChunk(this: CompressionChunkBuilderHost, messages: Message[]): CompressionChunk {
    const normalized = this.contextPayloadProjector.normalizeMessages(messages, {
      maxToolResultChars: 6000,
      maxNonToolChars: 12000,
      truncateNonToolMessages: true,
    });
    const preparedMessages = toPersistedMessages(normalized.messages);
    const compressorPromptChars = buildCompressionPrompt(
      preparedMessages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
        }))
    ).length;
    return {
      messages: normalized.messages,
      preparedMessages,
      chars: compressorPromptChars,
    };
  }

export async function compressChunksWithRetry(this: CompressionRetryHost,
    chunks: CompressionChunk[],
    onChunkProgress?: (input: CompressionRetryProgress) => Promise<void> | void
  ): Promise<CompressionRetryResult> {
    const summaries: string[] = [];
    let retryCount = 0;
    let droppedSourceMessageCount = 0;
    let compressionCallCount = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      await Promise.resolve(
        onChunkProgress?.({
          chunkIndex: i + 1,
          chunkTotal: chunks.length,
          progressPercent: Math.round((i / Math.max(1, chunks.length)) * 100),
        })
      );
      let success = false;
      let lastError = '';
      let candidate = chunks[i];
      let droppedForChunk = 0;
      let maxAttempts = Math.max(this.contextPrecompressRetry + 1, 3);
      const hardMaxAttempts = maxAttempts + 3;
      let attempt = 0;
      while (attempt < maxAttempts) {
        if (attempt > 0) {
          retryCount += 1;
        }
        compressionCallCount += 1;
        const result = await this.contextCompressor.compress(candidate.preparedMessages);
        if (result.success && result.compressedContent && result.compressedContent.trim().length > 0) {
          summaries.push(result.compressedContent.trim());
          droppedSourceMessageCount += droppedForChunk;
          success = true;
          break;
        }
        lastError = result.error ?? 'compress_empty_result';
        if (!isPromptTooLongCompressionError(lastError) || candidate.messages.length <= 2) {
          if (attempt >= this.contextPrecompressRetry) {
            break;
          }
          attempt += 1;
          continue;
        }
        const truncated = dropOldestCompressionRound(candidate.messages);
        if (truncated.messages.length >= candidate.messages.length) {
          break;
        }
        const droppedLeadingMarker =
          typeof candidate.messages[0]?.content === 'string' &&
          candidate.messages[0].content.startsWith(`[${CONTEXT_REDUCTION_MARKERS.retryTruncated}`)
            ? 1
            : 0;
        droppedForChunk += Math.max(0, truncated.droppedCount - droppedLeadingMarker);
        candidate = this.buildCompressionChunk([
          {
            role: 'user',
            content: buildCompressionRetryTruncatedNotice(truncated.droppedCount),
          },
          ...truncated.messages,
        ]);
        if (attempt + 1 >= maxAttempts && maxAttempts < hardMaxAttempts) {
          maxAttempts += 1;
        }
        attempt += 1;
      }
      if (!success) {
        return {
          ok: false,
          summaries,
          retryCount,
          droppedSourceMessageCount,
          compressionCallCount,
          failureReason: `chunk_${i + 1}_failed:${lastError}`,
        };
      }
      await Promise.resolve(
        onChunkProgress?.({
          chunkIndex: i + 1,
          chunkTotal: chunks.length,
          progressPercent: Math.round(((i + 1) / Math.max(1, chunks.length)) * 100),
        })
      );
      await yieldCompressionLoop();
    }
    return {
      ok: true,
      summaries,
      retryCount,
      droppedSourceMessageCount,
      compressionCallCount,
    };
  }

export async function emitContextPrecompress(this: ContextPrecompressEventHost,
    event: ContextPrecompressEvent,
    phase: NonNullable<ContextPrecompressEvent['phase']>,
    options?: { swallowErrors?: boolean }
  ): Promise<void> {
    const snapshot: ContextPrecompressEvent = {
      ...event,
      phase,
      observedAt: new Date().toISOString(),
    };
    try {
      await Promise.resolve(this.callback?.onContextPrecompress?.(snapshot));
    } catch (error) {
      if (!options?.swallowErrors) {
        throw error;
      }
      console.warn('[Agent] Context precompress callback failed:', error);
    }
  }

export async function applyPrecompressIfNeeded(this: LlmInputPreparatorHost,
    effectiveSystemPrompt: string,
    profileNormalizedCount: number,
    profileRuntime?: { sourceName?: string; sourcePath?: string; failureReason?: string },
    options?: {
      mode?: PrecompressMode;
      forced?: boolean;
      keepLlmRoundsOverride?: number;
    }
  ): Promise<ContextPrecompressEvent> {
    const mode = options?.mode ?? 'light';
    const forceApply = options?.forced === true;
    const keepLlmRoundsApplied = resolvePrecompressKeepRounds({
      configuredKeepRounds: this.contextPrecompressKeepLlmRounds,
      mode,
      aggressiveKeepRoundsCap: this.contextPrecompressAggressiveKeepLlmRoundsCap,
      override: options?.keepLlmRoundsOverride,
    });
    const hasSystem = this.messageStore.messages[0]?.role === 'system';
    const contentMessages = hasSystem ? this.messageStore.messages.slice(1) : [...this.messageStore.messages];
    const projectedBefore = this.contextPayloadProjector.projectForProvider(contentMessages, {
      systemPrompt: effectiveSystemPrompt,
      trimOptions: this.buildProviderProjectionTrimOptions(),
    });
    const totalCharsBefore = projectedBefore.metrics.preparedChars;
    const messageCharsBefore = Math.max(0, totalCharsBefore - effectiveSystemPrompt.length);
    const precompressEstimate = this.buildPreparedInputUsageEstimate(
      projectedBefore.messages,
      effectiveSystemPrompt
    );
    const estimatedInputTokens = precompressEstimate.effectiveEstimate.inputTokens;
    const triggerTokens = this.contextBudget.compressionTriggerTokens;
    const triggerCharsEstimate = tokensToCharHint(triggerTokens);
    const triggerRatio = this.contextBudget.compressionTriggerRatio;

    const triggerDecision = shouldTriggerPrecompress({
      estimatedInputTokens,
      budget: this.contextBudget,
      lastCompressionInputTokens: this.lastCompressionInputTokens,
      forced: forceApply,
      mode,
    });
    const effectiveTrigger = triggerDecision.effectiveTrigger;

    const event: ContextPrecompressEvent = {
      source: 'in_turn_precompress',
      observedAt: new Date().toISOString(),
      triggerChars: triggerCharsEstimate,
      triggerTokens,
      triggerRatio,
      triggerThresholdChars: triggerCharsEstimate,
      triggerThresholdTokens: triggerTokens,
      keepLlmRounds: this.contextPrecompressKeepLlmRounds,
      keepLlmRoundsApplied,
      chunkChars: this.contextPrecompressChunkChars,
      retryLimit: this.contextPrecompressRetry,
      totalCharsBefore,
      totalCharsAfter: totalCharsBefore,
      systemPromptChars: effectiveSystemPrompt.length,
      messageCharsBefore,
      messageCharsAfter: messageCharsBefore,
      triggered: false,
      applied: false,
      chunkCount: 0,
      retryCount: 0,
      profileNormalizedCount,
      profileRuntimeSource: profileRuntime?.sourceName,
      profileRuntimePath: profileRuntime?.sourcePath,
      failureReason: profileRuntime?.failureReason,
      mode: mode === 'disabled' ? 'light' : mode,
      forced: forceApply,
      progressPercent: 0,
      chunkIndex: 0,
      chunkTotal: 0,
    };

    if (mode === 'disabled') {
      event.failureReason = event.failureReason ?? 'precompress_disabled';
      return event;
    }

    if (!effectiveTrigger && !forceApply) {
      return event;
    }

    agentLogger.info(
      `[DPAgent] Context precompress trigger: mode=${mode} forced=${forceApply} staticEstimatedInputTokens=${precompressEstimate.staticEstimate.inputTokens} calibratedEstimatedInputTokens=${precompressEstimate.calibratedEstimate.inputTokens} anchorPromptTokens=${precompressEstimate.anchorPromptTokens ?? 0} deltaEstimatedTokens=${precompressEstimate.deltaEstimatedTokens ?? 0} effectiveEstimatedInputTokens=${estimatedInputTokens} triggerTokens=${triggerTokens}`
    );

    const split = this.splitMessagesForPrecompress(contentMessages, keepLlmRoundsApplied);
    if (split.olderMessages.length <= 2) {
      event.failureReason = event.failureReason ?? 'precompress_skipped_not_enough_older_messages';
      return event;
    }

    const adaptiveChunkPlan = this.resolveAdaptiveCompressionChunks(split.olderMessages);
    event.chunkChars = adaptiveChunkPlan.chunkCharsApplied;
    const chunks = adaptiveChunkPlan.chunks;
    event.chunkCount = chunks.length;
    event.chunkTotal = chunks.length;
    if (chunks.length === 0) {
      event.failureReason = event.failureReason ?? 'precompress_no_chunks';
      return event;
    }

    const compressStartedAt = Date.now();
    event.triggered = effectiveTrigger;
    await this.emitContextPrecompress(event, 'started');
    let mergedSummary = '';
    try {
      const chunkResult = await this.compressChunksWithRetry(
        chunks,
        async ({
          chunkIndex,
          chunkTotal,
          progressPercent,
        }: {
          chunkIndex: number;
          chunkTotal: number;
          progressPercent: number;
        }) => {
        event.chunkIndex = chunkIndex;
        event.chunkTotal = chunkTotal;
        event.progressPercent = progressPercent;
        if (chunkTotal > 1 || progressPercent < 100) {
          await this.emitContextPrecompress(event, 'running', { swallowErrors: true });
        }
      });
      event.retryCount = chunkResult.retryCount;
      event.sourceDroppedMessageCount = chunkResult.droppedSourceMessageCount;
      if (!chunkResult.ok || chunkResult.summaries.length === 0) {
        event.phase = 'failed';
        event.observedAt = new Date().toISOString();
        event.durationMs = Date.now() - compressStartedAt;
        event.failureReason = chunkResult.failureReason ?? event.failureReason ?? 'precompress_chunk_failed';
        agentLogger.info(
          `[DPAgent] Context precompress failed: durationMs=${event.durationMs} before=${event.totalCharsBefore} chunks=${event.chunkCount} compressionCalls=${chunkResult.compressionCallCount} reason=${event.failureReason}`
        );
        if ((event.durationMs ?? 0) > 180_000) {
          agentLogger.warn(
            `[DPAgent] Context precompress exceeded guardrail on failure: durationMs=${event.durationMs}`
          );
        }
        return event;
      }

      event.progressPercent = 100;
      mergedSummary = mergeCompressionChunkSummaries(chunkResult.summaries, this.contextBudget);
      if (chunkResult.droppedSourceMessageCount > 0) {
        mergedSummary = prefixCompressionSourceTruncatedSummary(
          mergedSummary,
          chunkResult.droppedSourceMessageCount
        );
      }
    } catch (error) {
      event.phase = 'failed';
      event.observedAt = new Date().toISOString();
      event.durationMs = Date.now() - compressStartedAt;
      event.failureReason =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : event.failureReason ?? 'precompress_failed';
      await this.emitContextPrecompress(event, 'failed', { swallowErrors: true });
      throw error;
    }

    const summaryMessage = this.withCheckpointMetadata(
      {
        role: 'assistant',
        content: buildContextPrecompressedContent({
          mode,
          keepLlmRounds: keepLlmRoundsApplied,
          chunkCount: chunks.length,
          sourceMessageCount: split.olderMessages.length,
          sourceDroppedMessageCount: event.sourceDroppedMessageCount ?? 0,
          summary: mergedSummary,
        }),
        metadata: {
          compressed: true,
          originalSize: totalCharsBefore,
          contextCompaction: {
            sourceRange: {
              startIndex: 0,
              endIndex: Math.max(0, split.olderMessages.length - 1),
              messageCount: split.olderMessages.length,
              sourceHash: hashAgentMessages(split.olderMessages),
            },
            sourceCoverage: {
              status: (event.sourceDroppedMessageCount ?? 0) > 0 ? 'truncated' : 'complete',
              droppedMessageCount: event.sourceDroppedMessageCount ?? 0,
              reason: (event.sourceDroppedMessageCount ?? 0) > 0 ? 'prompt_too_long' : undefined,
            },
            sealedBoundary: {
              keptLlmRounds: keepLlmRoundsApplied,
              tailMessageCount: split.tailMessages.length,
            },
            payloadMetrics: this.contextPayloadProjector.projectForProvider(split.olderMessages, {
              systemPrompt: effectiveSystemPrompt,
              trimOptions: this.buildNormalTrimOptions(),
            }).metrics,
            configFingerprint: this.contextCompactionConfigFingerprint(),
          },
        },
      },
      'summary_anchor'
    );

    const nextMessages: Message[] = [];
    if (hasSystem) {
      nextMessages.push(this.messageStore.messages[0]);
    }
    nextMessages.push(summaryMessage, ...split.tailMessages);
    this.messageStore.messages = sanitizeMessagesForToolProtocol(nextMessages).messages;
    this.clearPromptUsageAnchor();

    const nextContentMessages = this.messageStore.messages[0]?.role === 'system' ? this.messageStore.messages.slice(1) : [...this.messageStore.messages];
    event.applied = true;
    event.phase = 'completed';
    event.observedAt = new Date().toISOString();
    event.durationMs = Date.now() - compressStartedAt;
    const postProjection = this.contextPayloadProjector.projectForProvider(nextContentMessages, {
      systemPrompt: effectiveSystemPrompt,
      trimOptions: this.buildNormalTrimOptions(),
    });
    event.messageCharsAfter = Math.max(0, postProjection.metrics.preparedChars - effectiveSystemPrompt.length);
    event.totalCharsAfter = postProjection.metrics.preparedChars;
    const postTokenEstimate = this.buildPreparedInputUsageEstimate(
      postProjection.messages,
      effectiveSystemPrompt
    ).effectiveEstimate.inputTokens;
    event.projectedCharsAfter = postProjection.metrics.projectedChars;
    event.providerPayloadCharsAfter = postProjection.metrics.preparedChars;
    event.providerPayloadTokensAfter = postTokenEstimate;
    event.projectedTokensAfter = postTokenEstimate;
    event.postCompactValidation = 'provider_payload';
    summaryMessage.metadata = {
      ...(summaryMessage.metadata ?? {}),
      compressedSize: event.totalCharsAfter,
    };
    event.postCompressRatio = event.totalCharsAfter / Math.max(1, this.contextBudget.estimatedContextWindowChars);
    event.willRetriggerImmediately = postTokenEstimate >= triggerTokens;
    event.willRetriggerNextTurn = postTokenEstimate >= triggerTokens;
    event.progressPercent = 100;
    this.lastCompressionInputTokens = estimatedInputTokens;
    this.lastCompletedPrecompressEvent = { ...event };
    agentLogger.info(
      `[DPAgent] Context precompress completed: durationMs=${event.durationMs} before=${event.totalCharsBefore} after=${event.totalCharsAfter} ratio=${event.postCompressRatio.toFixed(3)} chunks=${event.chunkCount} willRetriggerImmediately=${event.willRetriggerImmediately}`
    );
    if ((event.durationMs ?? 0) > 180_000) {
      agentLogger.warn(`[DPAgent] Context precompress exceeded guardrail: durationMs=${event.durationMs}`);
    }
    return event;
  }

export async function refreshLastPrecompressValidation(
    this: PrecompressValidationHost,
    effectiveSystemPrompt: string
  ): Promise<void> {
    const lastEvent = this.lastCompletedPrecompressEvent;
    if (!lastEvent?.applied) {
      return;
    }
    const contentMessages = this.messageStore.messages[0]?.role === 'system' ? this.messageStore.messages.slice(1) : [...this.messageStore.messages];
    const postProjection = this.contextPayloadProjector.projectForProvider(contentMessages, {
      systemPrompt: effectiveSystemPrompt,
      trimOptions: this.buildNormalTrimOptions(),
    });
    const postTokenEstimate = this.buildPreparedInputUsageEstimate(
      postProjection.messages,
      effectiveSystemPrompt
    ).effectiveEstimate.inputTokens;
    const nextEvent: ContextPrecompressEvent = {
      ...lastEvent,
      observedAt: new Date().toISOString(),
      phase: 'completed',
      messageCharsAfter: Math.max(0, postProjection.metrics.preparedChars - effectiveSystemPrompt.length),
      totalCharsAfter: postProjection.metrics.preparedChars,
      projectedCharsAfter: postProjection.metrics.projectedChars,
      providerPayloadCharsAfter: postProjection.metrics.preparedChars,
      providerPayloadTokensAfter: postTokenEstimate,
      projectedTokensAfter: postTokenEstimate,
      postCompactValidation: 'provider_payload_after_turn',
      postCompressRatio: postProjection.metrics.preparedChars / Math.max(1, this.contextBudget.estimatedContextWindowChars),
      willRetriggerImmediately: postTokenEstimate >= this.contextBudget.compressionTriggerTokens,
      willRetriggerNextTurn: postTokenEstimate >= this.contextBudget.compressionTriggerTokens,
    };
    this.lastCompletedPrecompressEvent = nextEvent;
    agentLogger.info(
      `[DPAgent] Context precompress post-turn validation: providerPayloadChars=${nextEvent.providerPayloadCharsAfter} ratio=${(nextEvent.postCompressRatio ?? 0).toFixed(3)} willRetriggerNextTurn=${nextEvent.willRetriggerNextTurn}`
    );
    await this.emitContextPrecompress(nextEvent, 'completed', { swallowErrors: true });
  }
