import * as crypto from 'crypto';
import type {
  AgentCallback,
  ContextUsageEstimate,
  ContextUsageEstimateEvent,
  Message,
  ResolvedContextBudget,
  TokenUsage,
} from '../types.js';
import type { LLMRuntime } from '../llm/index.js';
import type { ToolRegistry } from '../tools/index.js';
import {
  applyCalibrationMultiplier,
  buildPreparedInputUsageSnapshot,
  createPromptUsageAnchor,
  estimateAnchoredContextUsage,
  type PreparedInputUsageSnapshot,
  type PromptUsageAnchor,
} from '../runtime/context-window-budget.js';
import type { ContextUsageCalibrationStore } from '../runtime/context-usage-calibration-store.js';
import { agentLogger } from '../utils/logger.js';
import type { PreparedInputUsageEstimateResult } from './agent-contracts.js';

export interface ContextBudgetServiceOptions {
  llm: LLMRuntime;
  tools: ToolRegistry;
  contextBudget: ResolvedContextBudget;
  contextUsageCalibrationStore?: ContextUsageCalibrationStore;
  getCallback: () => AgentCallback | undefined;
  compactionFingerprint: {
    keepLlmRounds: number;
    chunkChars: number;
    retry: number;
  };
}

export class ContextBudgetService {
  private latestPromptUsageAnchor: PromptUsageAnchor | null = null;

  constructor(private readonly options: ContextBudgetServiceOptions) {}

  getCalibrationMultiplier(): number {
    const runtime = this.options.llm.getRuntimeConfig?.();
    if (!runtime || !this.options.contextUsageCalibrationStore) {
      return 1;
    }
    return this.options.contextUsageCalibrationStore.getMultiplier({
      adapterProvider: runtime.provider,
      apiBase: runtime.apiBase,
      model: runtime.model,
    });
  }

  clearPromptUsageAnchor(): void {
    this.latestPromptUsageAnchor = null;
  }

  capturePreparedInputUsageSnapshot(
    messages: Message[],
    systemPrompt: string | undefined,
    options?: { snapshotStage?: 'initial' | 'overflow_retry_after_compress' | 'overflow_retry_after_forced_trim' }
  ): PreparedInputUsageSnapshot {
    return (
      this.options.llm.capturePreparedInputUsageSnapshot?.(
        messages,
        this.options.tools.getSchemas(),
        systemPrompt,
        {
          snapshotStage: options?.snapshotStage,
        }
      ) ??
      buildPreparedInputUsageSnapshot({
        system: systemPrompt ?? '',
        messages,
        tools: this.options.tools.getSchemas(),
      })
    );
  }

  buildPreparedInputUsageEstimate(
    messages: Message[],
    systemPrompt: string | undefined,
    options?: { snapshotStage?: 'initial' | 'overflow_retry_after_compress' | 'overflow_retry_after_forced_trim' }
  ): PreparedInputUsageEstimateResult {
    const snapshot = this.capturePreparedInputUsageSnapshot(messages, systemPrompt, options);
    const staticEstimate: ContextUsageEstimate = {
      inputTokens: snapshot.inputTokens,
      source: 'weighted_char_estimate',
      confidence: 'estimated',
      rawChars: snapshot.rawChars,
    };
    const calibrationMultiplier = this.getCalibrationMultiplier();
    const calibratedEstimate = applyCalibrationMultiplier(staticEstimate, calibrationMultiplier);
    const runtime = this.options.llm.getRuntimeConfig?.();
    const anchoredEstimate =
      runtime && this.latestPromptUsageAnchor
        ? estimateAnchoredContextUsage({
            anchor: this.latestPromptUsageAnchor,
            adapterProvider: runtime.provider,
            apiBase: runtime.apiBase,
            model: runtime.model,
            snapshot,
          })
        : null;
    if (runtime && this.latestPromptUsageAnchor && !anchoredEstimate) {
      this.clearPromptUsageAnchor();
    }

    return {
      snapshot,
      staticEstimate,
      calibratedEstimate,
      effectiveEstimate: anchoredEstimate
        ? {
            inputTokens: anchoredEstimate.inputTokens,
            source: anchoredEstimate.deltaEstimatedTokens > 0 ? 'weighted_char_estimate' : 'provider_usage',
            confidence: anchoredEstimate.deltaEstimatedTokens > 0 ? 'estimated' : 'exact',
            rawChars: anchoredEstimate.rawChars,
          }
        : calibratedEstimate,
      calibrationMultiplier,
      anchorPromptTokens: anchoredEstimate?.anchorPromptTokens,
      deltaEstimatedTokens: anchoredEstimate?.deltaEstimatedTokens,
    };
  }

  async emitContextUsageEstimate(
    estimate: PreparedInputUsageEstimateResult,
    stage: ContextUsageEstimateEvent['stage']
  ): Promise<void> {
    const usedTokens = Math.max(0, Math.ceil(estimate.effectiveEstimate.inputTokens));
    const limitTokens = Math.max(1, Math.ceil(this.options.contextBudget.contextWindowTokens));
    const usedChars = Math.max(0, Math.ceil(estimate.effectiveEstimate.rawChars ?? estimate.snapshot.rawChars));
    const limitChars = Math.max(1, Math.ceil(this.options.contextBudget.estimatedContextWindowChars));
    await Promise.resolve(
      this.options.getCallback()?.onContextUsageEstimate?.({
        observedAt: new Date().toISOString(),
        stage,
        source: estimate.effectiveEstimate.source,
        confidence: estimate.effectiveEstimate.confidence,
        usedTokens,
        limitTokens,
        usedChars,
        limitChars,
        ratio: usedTokens / limitTokens,
        anchorPromptTokens: estimate.anchorPromptTokens,
        deltaEstimatedTokens: estimate.deltaEstimatedTokens,
        calibrationMultiplier: estimate.calibrationMultiplier,
      })
    );
  }

  async emitProviderUsageAnchorEstimate(
    snapshot: PreparedInputUsageEstimateResult['snapshot'],
    usage?: TokenUsage
  ): Promise<void> {
    const usageFeedback = this.classifyPromptUsageForFeedback(
      {
        inputTokens: snapshot.inputTokens,
        source: 'weighted_char_estimate',
        confidence: 'estimated',
        rawChars: snapshot.rawChars,
      },
      usage
    );
    if (!usageFeedback?.accepted) {
      return;
    }
    const usedTokens = Math.max(1, Math.ceil(usageFeedback.promptTokens));
    const limitTokens = Math.max(1, Math.ceil(this.options.contextBudget.contextWindowTokens));
    const usedChars = Math.max(0, Math.ceil(snapshot.rawChars));
    const limitChars = Math.max(1, Math.ceil(this.options.contextBudget.estimatedContextWindowChars));
    await Promise.resolve(
      this.options.getCallback()?.onContextUsageEstimate?.({
        observedAt: new Date().toISOString(),
        stage: 'provider_usage_anchor',
        source: 'provider_usage',
        confidence: 'exact',
        usedTokens,
        limitTokens,
        usedChars,
        limitChars,
        ratio: usedTokens / limitTokens,
        anchorPromptTokens: usedTokens,
        deltaEstimatedTokens: 0,
        calibrationMultiplier: 1,
      })
    );
  }

  recordCalibrationObservation(estimate: ContextUsageEstimate, usage?: TokenUsage): void {
    const runtime = this.options.llm.getRuntimeConfig?.();
    const usageFeedback = this.classifyPromptUsageForFeedback(estimate, usage);
    if (
      !runtime ||
      !this.options.contextUsageCalibrationStore ||
      !usageFeedback ||
      !usageFeedback.accepted ||
      estimate.inputTokens <= 0
    ) {
      return;
    }
    this.options.contextUsageCalibrationStore.recordObservation({
      adapterProvider: runtime.provider,
      apiBase: runtime.apiBase,
      model: runtime.model,
      weightedTokens: estimate.inputTokens,
      promptTokens: usageFeedback.promptTokens,
    });
  }

  updatePromptUsageAnchor(
    snapshot: PreparedInputUsageSnapshot,
    estimate: ContextUsageEstimate,
    usage?: TokenUsage
  ): void {
    const runtime = this.options.llm.getRuntimeConfig?.();
    const usageFeedback = this.classifyPromptUsageForFeedback(estimate, usage);
    if (!runtime || !usageFeedback) {
      return;
    }
    if (!usageFeedback.accepted) {
      this.clearPromptUsageAnchor();
      agentLogger.info(
        `[DPAgent] Context usage anchor skipped: promptTokens=${usageFeedback.promptTokens} staticEstimatedInputTokens=${estimate.inputTokens} underflowBound=${usageFeedback.underflowBound} provider=${runtime.provider} model=${runtime.model}`
      );
      return;
    }
    this.latestPromptUsageAnchor = createPromptUsageAnchor({
      adapterProvider: runtime.provider,
      apiBase: runtime.apiBase,
      model: runtime.model,
      snapshot,
      promptTokens: usageFeedback.promptTokens,
    });
    if (this.latestPromptUsageAnchor) {
      agentLogger.info(
        `[DPAgent] Context usage anchor updated: promptTokens=${this.latestPromptUsageAnchor.promptTokens} rawChars=${this.latestPromptUsageAnchor.rawChars} provider=${runtime.provider} model=${runtime.model}`
      );
    }
  }

  contextCompactionConfigFingerprint(): string {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          contextWindowTokens: this.options.contextBudget.contextWindowTokens,
          compressionTriggerRatio: this.options.contextBudget.compressionTriggerRatio,
          keepLlmRounds: this.options.compactionFingerprint.keepLlmRounds,
          chunkChars: this.options.compactionFingerprint.chunkChars,
          retry: this.options.compactionFingerprint.retry,
          tokenEstimator: 'ascii=0.3;unicode=0.6',
        })
      )
      .digest('hex');
  }

  private classifyPromptUsageForFeedback(
    estimate: ContextUsageEstimate,
    usage?: TokenUsage
  ): { promptTokens: number; underflowBound: number; accepted: boolean } | null {
    if (!usage || !Number.isFinite(usage.promptTokens) || usage.promptTokens <= 0) {
      return null;
    }
    const promptTokens = Math.max(1, Math.ceil(usage.promptTokens));
    const underflowBound = Math.max(64, Math.floor(estimate.inputTokens * 0.05));
    const accepted = !(promptTokens <= 1024 && promptTokens < underflowBound);
    return {
      promptTokens,
      underflowBound,
      accepted,
    };
  }
}
