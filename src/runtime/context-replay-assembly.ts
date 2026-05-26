import * as crypto from 'crypto';
import {
  estimateMessageCharacters,
  messageTextContent,
  sanitizeMessagesForToolProtocol,
  type LLMRuntime,
} from '../llm/index.js';
import { resolveModelRuntimeBudgetOptions } from '../llm/provider-profiles.js';
import { ContextCompressor } from '../compression/index.js';
import type { AgentProfileReference } from '../agents/AgentProfiles.js';
import { INTERRUPTED_TURN_RESUME_MARKER } from '../interrupted-turn-recovery.js';
import { agentLogger } from '../utils/logger.js';
import { tokensToCharHint } from '../shared/context-token-estimation.js';
import type {
  AgentConfig,
  ContextNamespaceMeta,
  ContextPrecompressEvent,
  ContextRef,
  Message,
} from '../types.js';
import { resolveContextBudget } from './context-window-budget.js';
import { toPersistedMessages } from './persisted-message-utils.js';
import {
  buildProviderProjectionTrimOptions,
  CONTEXT_REDUCTION_MARKERS,
} from './context-reduction-policy.js';
import {
  isContextPrecompressedMarkerText,
  joinOptionalSegments,
  normalizeReplayText,
  normalizeReplayUserPrompt,
  sanitizeCompressedHistoryUserContent,
  truncateReplayText,
} from './context-replay-utils.js';

export const INTERNAL_CONTEXT_MARKERS = [
  '[SUMMARY_MESSAGES_APPLIED',
  `[${CONTEXT_REDUCTION_MARKERS.contextPrecompressed}`,
  `[${CONTEXT_REDUCTION_MARKERS.contextCompressed}]`,
  `[${CONTEXT_REDUCTION_MARKERS.toolHistoryCompacted}]`,
  `[${CONTEXT_REDUCTION_MARKERS.maxTokensRecovery}]`,
  '[TOOLCALL_FAILED]',
  '[EXECUTION_CONTINUE_REQUIRED]',
  '[CONTEXT_WINDOW_GUARD]',
  INTERRUPTED_TURN_RESUME_MARKER,
] as const;

const HISTORY_REPLAY_ROUNDS_HARD_CAP = 48;
const COMPRESSED_HISTORY_CHAR_HARD_MAX = 12000;

export interface ReplayRound {
  messages: Message[];
  chars: number;
}

export interface ContextReplayAssembly {
  replayMessages: Message[];
  compressedHistorySegment?: string;
  compressedHistoryContextUpdate?: ContextNamespaceMeta['compressedHistoryContext'] | null;
  compressedHistoryGenerated: boolean;
  compressedHistoryUsed: boolean;
  compressionCache: 'bypass' | 'hit' | 'miss';
  compressionCallCount: number;
  compressionDurationMs: number;
  sealedRoundCount: number;
  replayRoundCount: number;
  compressedPrefixChars: number;
}

export interface ContextReplayAssemblerOptions {
  getConfig: () => AgentConfig;
  getLlmClient: () => LLMRuntime | null;
}

export class ContextReplayAssembler {
  constructor(private readonly options: ContextReplayAssemblerOptions) {}

  async build(
    context: ContextRef,
    conversationMessages: Message[],
    meta?: ContextNamespaceMeta,
    options?: {
      onContextPrecompress?: (event: ContextPrecompressEvent) => Promise<void> | void;
    }
  ): Promise<ContextReplayAssembly> {
    const durableCompactionSummary = this.extractDurableContextCompactionSummary(conversationMessages);
    const durableCompactionSegment = durableCompactionSummary
      ? this.buildDurableContextCompactionSystemSegment(durableCompactionSummary)
      : undefined;
    const replayMessages = this.extractReplayMessages(conversationMessages);
    if (replayMessages.length === 0) {
      return {
        replayMessages: [],
        compressedHistorySegment: durableCompactionSegment,
        compressedHistoryGenerated: false,
        compressedHistoryUsed: Boolean(durableCompactionSegment),
        compressionCache: 'bypass',
        compressionCallCount: 0,
        compressionDurationMs: 0,
        sealedRoundCount: 0,
        replayRoundCount: 0,
        compressedPrefixChars: 0,
      };
    }

    const normalizedReplay = sanitizeMessagesForToolProtocol(replayMessages);
    if (normalizedReplay.correctedCount > 0) {
      agentLogger.warn(
        `[DPAgent] Replay tool-protocol normalization applied: context=${context.scope}/${context.namespace} corrections=${normalizedReplay.correctedCount} orphan_tool_calls=${normalizedReplay.orphanToolCallFixed} orphan_tool_results=${normalizedReplay.orphanToolResultFixed}`
      );
    }

    const rounds = this.groupReplayRoundsByUser(normalizedReplay.messages);
    if (rounds.length === 0) {
      return {
        replayMessages: [],
        compressedHistoryGenerated: false,
        compressedHistoryUsed: false,
        compressionCache: 'bypass',
        compressionCallCount: 0,
        compressionDurationMs: 0,
        sealedRoundCount: 0,
        replayRoundCount: 0,
        compressedPrefixChars: 0,
      };
    }

    const budget = this.getBudget();
    const triggerTokens = budget.compressionTriggerTokens;
    const triggerChars = this.resolveCompressedHistoryTriggerChars();
    const totalReplayChars = this.estimateReplayRoundsChars(rounds);
    const hadPersistedCompressedHistory = Boolean(meta?.compressedHistoryContext);
    let compressedHistoryContext = this.resolveCompressedHistoryContext(meta, rounds);
    let replayRounds = rounds.slice(compressedHistoryContext?.sealedRoundCount ?? 0);
    let compressedHistoryGenerated = false;
    let compressedHistoryContextUpdate: ContextReplayAssembly['compressedHistoryContextUpdate'];
    let compressionCache: ContextReplayAssembly['compressionCache'] = totalReplayChars > triggerChars ? 'miss' : 'bypass';
    let compressionCallCount = 0;
    let compressionDurationMs = 0;

    if (totalReplayChars <= triggerChars) {
      if (hadPersistedCompressedHistory) {
        compressedHistoryContextUpdate = null;
      }
      return {
        replayMessages: rounds.flatMap((round) => round.messages.map((message) => ({ ...message }))),
        compressedHistorySegment: durableCompactionSegment,
        compressedHistoryContextUpdate,
        compressedHistoryGenerated: false,
        compressedHistoryUsed: Boolean(durableCompactionSegment),
        compressionCache,
        compressionCallCount,
        compressionDurationMs,
        sealedRoundCount: 0,
        replayRoundCount: rounds.length,
        compressedPrefixChars: 0,
      };
    }

    if (compressedHistoryContext) {
      compressionCache = 'hit';
    }

    if (this.estimateReplayRoundsChars(replayRounds) > triggerChars) {
      const { olderRounds, recentRounds } = this.selectAdaptiveReplayWindow(replayRounds);
      if (olderRounds.length > 0) {
        const precompressSeed: ContextPrecompressEvent = {
          source: 'replay_prepare',
          phase: 'started',
          observedAt: new Date().toISOString(),
          triggerChars,
          triggerTokens,
          triggerRatio: budget.compressionTriggerRatio,
          triggerThresholdChars: triggerChars,
          triggerThresholdTokens: triggerTokens,
          keepLlmRounds: 0,
          keepLlmRoundsApplied: 0,
          chunkChars: this.resolveContextCompressionMaxChars(),
          retryLimit: 0,
          totalCharsBefore: totalReplayChars,
          totalCharsAfter: totalReplayChars,
          systemPromptChars: 0,
          messageCharsBefore: totalReplayChars,
          messageCharsAfter: totalReplayChars,
          triggered: true,
          applied: false,
          chunkCount: 1,
          retryCount: 0,
          profileNormalizedCount: 0,
          progressPercent: 0,
          chunkIndex: 0,
          chunkTotal: 1,
        };
        await Promise.resolve(options?.onContextPrecompress?.(precompressSeed));
        const compressionStartedAt = Date.now();
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          const nextCompressedHistoryContext = await this.buildNextCompressedHistoryContext({
            allRounds: rounds,
            currentCompressedHistoryContext: compressedHistoryContext,
            newlySealedRounds: olderRounds,
          });
          compressionCallCount = 1;
          compressionDurationMs = Date.now() - compressionStartedAt;
          compressedHistoryContext = nextCompressedHistoryContext;
          compressedHistoryContextUpdate = nextCompressedHistoryContext;
          replayRounds = recentRounds;
          compressedHistoryGenerated = true;
          compressionCache = 'miss';
          const replayCharsAfter = this.estimateReplayRoundsChars(replayRounds);
          await Promise.resolve(
            options?.onContextPrecompress?.({
              ...precompressSeed,
              phase: 'completed',
              observedAt: new Date().toISOString(),
              applied: true,
              durationMs: compressionDurationMs,
              progressPercent: 100,
              chunkIndex: 1,
              totalCharsAfter: replayCharsAfter,
              messageCharsAfter: replayCharsAfter,
              willRetriggerImmediately: replayCharsAfter >= triggerChars,
              willRetriggerNextTurn: replayCharsAfter >= triggerChars,
            })
          );
        } catch (error) {
          compressionDurationMs = Date.now() - compressionStartedAt;
          const failureReason = error instanceof Error ? error.message : String(error);
          await Promise.resolve(
            options?.onContextPrecompress?.({
              ...precompressSeed,
              phase: 'failed',
              observedAt: new Date().toISOString(),
              durationMs: compressionDurationMs,
              failureReason,
            })
          );
          throw error;
        }
      }
    }

    if (!compressedHistoryContext && hadPersistedCompressedHistory) {
      compressedHistoryContextUpdate = null;
    }

    const compressedPrefixChars = compressedHistoryContext
      ? this.estimateReplayRoundsChars(rounds.slice(0, compressedHistoryContext.sealedRoundCount))
      : 0;

    const compressedHistorySegment = compressedHistoryContext
      ? this.buildCompressedHistorySystemSegment(
          compressedHistoryContext.summary,
          compressedHistoryContext.sealedRoundCount,
          replayRounds.length
        )
      : undefined;

    return {
      replayMessages: replayRounds.flatMap((round) => round.messages.map((message) => ({ ...message }))),
      compressedHistorySegment: joinOptionalSegments(durableCompactionSegment, compressedHistorySegment),
      compressedHistoryContextUpdate,
      compressedHistoryGenerated,
      compressedHistoryUsed: Boolean(compressedHistoryContext?.summary || durableCompactionSegment),
      compressionCache,
      compressionCallCount,
      compressionDurationMs,
      sealedRoundCount: compressedHistoryContext?.sealedRoundCount ?? 0,
      replayRoundCount: replayRounds.length,
      compressedPrefixChars,
    };
  }

  extractSessionSearchMessages(conversationMessages: Message[]): Message[] {
    const transcriptMessages: Message[] = [];
    for (const message of conversationMessages) {
      if (message.role !== 'user' && message.role !== 'assistant') {
        continue;
      }
      const text = messageTextContent(message.content).trim();
      if (text.length === 0) {
        continue;
      }
      if (INTERNAL_CONTEXT_MARKERS.some((marker) => text.startsWith(marker))) {
        continue;
      }
      transcriptMessages.push({
        role: message.role,
        content: text,
      });
    }
    return transcriptMessages;
  }

  buildProviderProjectionTrimOptions(): {
    maxTotalChars: number;
    keepLatestCount: number;
    maxToolChars: number;
    maxNonToolChars: number;
  } {
    return buildProviderProjectionTrimOptions(this.getBudget());
  }

  private getBudget() {
    const cfg = this.options.getConfig();
    const llmClient = this.options.getLlmClient();
    const runtimeConfig = llmClient?.getRuntimeConfig?.();
    return resolveContextBudget({
      config: cfg,
      profileId: runtimeConfig?.profileId,
      provider: runtimeConfig?.provider ?? 'anthropic',
      model: runtimeConfig?.model ?? 'MiniMax-M2.5',
      modelRuntimeOptions: resolveModelRuntimeBudgetOptions(runtimeConfig),
    });
  }

  private extractDurableContextCompactionSummary(conversationMessages: Message[]): string | undefined {
    let latest: string | undefined;
    for (const message of conversationMessages) {
      if (message.role !== 'assistant') {
        continue;
      }
      const text = messageTextContent(message.content).trim();
      if (isContextPrecompressedMarkerText(text)) {
        latest = text;
      }
    }
    return latest;
  }

  private buildDurableContextCompactionSystemSegment(summary: string): string {
    return [
      '## Durable In-Turn Context Compaction',
      'Use this compressed context as the canonical replacement for older history before the recent replay messages.',
      summary.trim(),
    ].join('\n');
  }

  private extractReplayMessages(conversationMessages: Message[]): Message[] {
    const replayMessages: Message[] = [];
    let activeProfileRef: AgentProfileReference | undefined;
    for (const message of conversationMessages) {
      if (message.role === 'tool') {
        replayMessages.push({ ...message });
        continue;
      }

      if (message.role !== 'user' && message.role !== 'assistant') {
        continue;
      }
      let text = messageTextContent(message.content).trim();
      const hasToolCalls = message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0;
      const hasThinking =
        message.role === 'assistant' &&
        (String(message.thinking ?? '').trim().length > 0 ||
          String(message.thinkingSignature ?? '').trim().length > 0);
      if (text.length === 0 && !hasToolCalls && !hasThinking) {
        continue;
      }
      if (isContextPrecompressedMarkerText(text)) {
        continue;
      }
      if (INTERNAL_CONTEXT_MARKERS.some((marker) => text.startsWith(marker))) {
        continue;
      }
      if (message.role === 'user') {
        const normalized = normalizeReplayUserPrompt(text, activeProfileRef);
        text = normalized.text;
        activeProfileRef = normalized.activeProfileRef;
        if (text.length === 0) {
          continue;
        }
      }
      if (message.role === 'assistant') {
        replayMessages.push({
          ...message,
          content: text,
        });
        continue;
      }

      replayMessages.push({
        role: message.role,
        content: text,
      });
    }
    return replayMessages;
  }

  private groupReplayRoundsByUser(messages: Message[]): ReplayRound[] {
    const rounds: ReplayRound[] = [];
    let currentRound: ReplayRound | null = null;
    for (const message of messages) {
      if (message.role === 'user') {
        currentRound = {
          messages: [{ ...message }],
          chars: estimateMessageCharacters(message),
        };
        rounds.push(currentRound);
        continue;
      }
      if (!currentRound) {
        continue;
      }
      currentRound.messages.push({ ...message });
      currentRound.chars += estimateMessageCharacters(message);
    }
    return rounds;
  }

  private selectAdaptiveReplayWindow(rounds: ReplayRound[]): {
    olderRounds: ReplayRound[];
    recentRounds: ReplayRound[];
  } {
    const cfg = this.options.getConfig().agent;
    const minRoundsCfg = Math.floor(cfg.contextReplayMinRounds ?? 6);
    const maxRoundsCfg = Math.floor(cfg.contextReplayMaxRounds ?? 12);
    const minRounds = Math.min(HISTORY_REPLAY_ROUNDS_HARD_CAP, Math.max(1, minRoundsCfg));
    const maxRounds = Math.min(HISTORY_REPLAY_ROUNDS_HARD_CAP, Math.max(minRounds, maxRoundsCfg));

    if (rounds.length <= minRounds) {
      return {
        olderRounds: [],
        recentRounds: rounds,
      };
    }

    const ratioRaw = cfg.contextReplayBudgetRatio ?? 0.55;
    const ratio = Math.max(0.1, Math.min(1, ratioRaw));
    const budget = this.getBudget();
    const baseWindowChars = budget.estimatedContextWindowChars;
    const replayBudgetChars = Math.max(2000, Math.floor(baseWindowChars * ratio));
    const cappedMaxRounds = Math.min(rounds.length, maxRounds);

    let start = Math.max(0, rounds.length - Math.min(minRounds, cappedMaxRounds));
    let keptRoundCount = rounds.length - start;
    let keptChars = 0;
    for (let i = start; i < rounds.length; i += 1) {
      keptChars += rounds[i].chars;
    }

    while (start > 0 && keptRoundCount < cappedMaxRounds) {
      const candidateChars = rounds[start - 1].chars;
      if (keptRoundCount >= minRounds && keptChars + candidateChars > replayBudgetChars) {
        break;
      }
      start -= 1;
      keptRoundCount += 1;
      keptChars += candidateChars;
    }

    return {
      olderRounds: rounds.slice(0, start),
      recentRounds: rounds.slice(start),
    };
  }

  private resolveCompressedHistoryTriggerChars(): number {
    const budget = this.getBudget();
    return Math.max(10000, Math.floor(tokensToCharHint(budget.compressionTriggerTokens)));
  }

  private resolveContextCompressionMaxChars(): number {
    const configuredChars = this.getBudget().compressionMaxChars;
    return Math.max(800, Math.min(COMPRESSED_HISTORY_CHAR_HARD_MAX, Math.floor(configuredChars)));
  }

  private resolveCompressedHistoryContext(
    meta: ContextNamespaceMeta | undefined,
    rounds: ReplayRound[]
  ): NonNullable<ContextNamespaceMeta['compressedHistoryContext']> | undefined {
    const cached = meta?.compressedHistoryContext;
    if (!cached || typeof cached.summary !== 'string' || cached.summary.trim().length === 0) {
      return undefined;
    }

    const sealedRoundCount = Math.max(0, Math.floor(cached.sealedRoundCount ?? 0));
    if (sealedRoundCount <= 0 || sealedRoundCount > rounds.length) {
      return undefined;
    }

    const sealedPrefixHash = this.computeReplayRoundHash(rounds.slice(0, sealedRoundCount));
    if (sealedPrefixHash !== cached.sealedPrefixHash) {
      return undefined;
    }

    if (cached.configFingerprint !== this.resolveCompressedHistoryConfigFingerprint()) {
      return undefined;
    }

    return {
      ...cached,
      sealedRoundCount,
      sealedPrefixHash,
      summary: truncateReplayText(cached.summary.trim(), this.resolveContextCompressionMaxChars()),
      formatVersion: cached.formatVersion ?? 1,
    };
  }

  private estimateReplayRoundsChars(rounds: ReplayRound[]): number {
    return rounds.reduce((sum, round) => sum + round.chars, 0);
  }

  private resolveCompressedHistoryConfigFingerprint(): string {
    const runtimeConfig = this.options.getLlmClient()?.getRuntimeConfig?.();
    const cfg = this.options.getConfig().agent;
    const budget = this.getBudget();
    const payload = {
      formatVersion: 1,
      maxChars: this.resolveContextCompressionMaxChars(),
      provider: runtimeConfig?.provider ?? 'anthropic',
      model: runtimeConfig?.model ?? 'MiniMax-M2.5',
      contextWindowTokens: budget.contextWindowTokens,
      compressionTriggerTokens: budget.compressionTriggerTokens,
      compressionTriggerRatio: budget.compressionTriggerRatio,
      replayMinRounds: Math.floor(cfg.contextReplayMinRounds ?? 6),
      replayMaxRounds: Math.floor(cfg.contextReplayMaxRounds ?? 12),
      replayBudgetRatio: cfg.contextReplayBudgetRatio ?? 0.55,
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private async buildNextCompressedHistoryContext(input: {
    allRounds: ReplayRound[];
    currentCompressedHistoryContext?: NonNullable<ContextNamespaceMeta['compressedHistoryContext']>;
    newlySealedRounds: ReplayRound[];
  }): Promise<NonNullable<ContextNamespaceMeta['compressedHistoryContext']>> {
    const nextSealedRoundCount =
      (input.currentCompressedHistoryContext?.sealedRoundCount ?? 0) + input.newlySealedRounds.length;
    const sealedPrefixHash = this.computeReplayRoundHash(input.allRounds.slice(0, nextSealedRoundCount));
    const maxChars = this.resolveContextCompressionMaxChars();
    const generatedSummary = await this.generateCompressedHistorySummary(
      input.newlySealedRounds,
      input.currentCompressedHistoryContext?.summary,
      maxChars
    );
    return {
      sealedRoundCount: nextSealedRoundCount,
      sealedPrefixHash,
      summary: generatedSummary.summary,
      updatedAt: new Date().toISOString(),
      formatVersion: 1,
      configFingerprint: this.resolveCompressedHistoryConfigFingerprint(),
    };
  }

  private async generateCompressedHistorySummary(
    rounds: ReplayRound[],
    previousSummary: string | undefined,
    maxChars: number
  ): Promise<{
    summary: string;
  }> {
    const compressedHistoryMessages = this.buildCompressedHistoryMessages(rounds);
    const llmClient = this.options.getLlmClient();
    if (!llmClient) {
      return {
        summary: this.buildFallbackCompressedHistory(compressedHistoryMessages, previousSummary, maxChars),
      };
    }

    const compressor = new ContextCompressor(llmClient);
    const result = await compressor.compressCompressedHistory(
      toPersistedMessages(compressedHistoryMessages, { idPrefix: 'replay' }),
      previousSummary
    );
    if (result.success && result.compressedContent && result.compressedContent.trim().length > 0) {
      return {
        summary: truncateReplayText(result.compressedContent.trim(), maxChars),
      };
    }

    agentLogger.warn(
      `[DPAgent] Compressed history fallback engaged: ${result.error ?? 'unknown_compressed_history_error'}`
    );
    return {
      summary: this.buildFallbackCompressedHistory(compressedHistoryMessages, previousSummary, maxChars),
    };
  }

  private buildCompressedHistoryMessages(rounds: ReplayRound[]): Message[] {
    return rounds.flatMap((round) =>
      round.messages.map((message) => {
        if (message.role !== 'user') {
          return { ...message };
        }
        return {
          ...message,
          content: sanitizeCompressedHistoryUserContent(message.content),
        };
      })
    );
  }

  private buildFallbackCompressedHistory(
    messages: Message[],
    previousSummary: string | undefined,
    maxChars: number
  ): string {
    const lines: string[] = [];
    const normalizedPreviousSummary = String(previousSummary ?? '').trim();
    if (normalizedPreviousSummary) {
      lines.push(normalizedPreviousSummary);
    }
    const rounds = this.groupReplayRoundsByUser(messages);
    for (const round of rounds) {
      const userMessage = round.messages.find((message) => message.role === 'user');
      const assistantMessage =
        [...round.messages].reverse().find((message) => message.role === 'assistant') ??
        round.messages.find((message) => message.role === 'assistant');
      const userText = userMessage ? truncateReplayText(normalizeReplayText(userMessage.content), 180) : '';
      const assistantText = assistantMessage
        ? truncateReplayText(normalizeReplayText(assistantMessage.content), 220)
        : '';
      const parts = ['-'];
      if (userText) {
        parts.push(`User asked: ${userText}.`);
      }
      if (assistantText) {
        parts.push(`Assistant concluded: ${assistantText}.`);
      }
      const bullet = parts.join(' ').trim();
      if (bullet !== '-') {
        lines.push(bullet);
      }
      const nextSnapshot = lines.join('\n');
      if (nextSnapshot.length >= maxChars) {
        return truncateReplayText(nextSnapshot, maxChars);
      }
    }
    return truncateReplayText(lines.join('\n'), maxChars);
  }

  private buildCompressedHistorySystemSegment(
    summary: string,
    sealedRoundCount: number,
    replayRoundCount: number
  ): string {
    return [
      '## Compressed Earlier Session Context',
      `sealed_rounds=${sealedRoundCount}`,
      `recent_raw_rounds=${replayRoundCount}`,
      'Use this compressed context only for older-session continuity. The recent replay messages remain the canonical dialogue context.',
      summary.trim(),
    ].join('\n');
  }

  private computeReplayRoundHash(rounds: ReplayRound[]): string {
    const normalized = rounds
      .map((round, index) => {
        const payload = round.messages
          .map((message) => `${message.role}:${normalizeReplayText(message.content)}`)
          .join('\n');
        return `#${index + 1}\n${payload}`;
      })
      .join('\n---\n');
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }
}
