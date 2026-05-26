import type { ContextWindowTrimOptions, ResolvedContextBudget } from '../types.js';
import { tokensToCharHint } from '../shared/context-token-estimation.js';

export type ContextReductionMode = 'light' | 'aggressive' | 'disabled';
export type ContextReductionTrimOptions = Required<
  Pick<ContextWindowTrimOptions, 'maxTotalChars' | 'keepLatestCount' | 'maxToolChars' | 'maxNonToolChars'>
>;

export const CONTEXT_REDUCTION_MARKERS = {
  retryTruncated: 'COMPRESSION_RETRY_TRUNCATED',
  sourceTruncated: 'COMPRESSION_SOURCE_TRUNCATED',
  summaryTruncated: 'COMPRESSION_SUMMARY_TRUNCATED',
  contextPrecompressed: 'CONTEXT_PRECOMPRESSED',
  contextCompressed: 'CONTEXT_COMPRESSED',
  toolHistoryCompacted: 'TOOL_HISTORY_COMPACTED',
  maxTokensRecovery: 'MAX_TOKENS_RECOVERY',
} as const;

const NORMAL_KEEP_LATEST_COUNT = 24;
const NORMAL_TOOL_CHARS = 4000;
const NORMAL_NON_TOOL_CHARS = 12000;
const FORCED_KEEP_LATEST_COUNT = 14;
const FORCED_TOOL_CHARS = 2000;
const FORCED_NON_TOOL_CHARS = 6000;
const NORMAL_WINDOW_RESERVE_CHARS = 10000;
const MIN_TRIM_CHARS = 40000;
const MAX_TOKENS_RECOVERY_MIN_CHARS = 24000;
const MAX_TOKENS_RECOVERY_MAX_CHARS = 120000;
const MERGED_SUMMARY_MIN_CHARS = 12000;
const MERGED_SUMMARY_MAX_CHARS = 48000;

export function resolvePrecompressKeepRounds(input: {
  configuredKeepRounds: number;
  mode: ContextReductionMode;
  aggressiveKeepRoundsCap: number;
  override?: number;
}): number {
  const selected =
    input.override ??
    (input.mode === 'aggressive'
      ? Math.min(input.configuredKeepRounds, input.aggressiveKeepRoundsCap)
      : input.configuredKeepRounds);
  return Math.max(1, Math.floor(selected));
}

export function shouldTriggerPrecompress(input: {
  estimatedInputTokens: number;
  budget: ResolvedContextBudget;
  lastCompressionInputTokens: number;
  forced: boolean;
  mode: ContextReductionMode;
}): {
  shouldTrigger: boolean;
  hardRiskTokens: number;
  effectiveTrigger: boolean;
} {
  const shouldTrigger =
    input.estimatedInputTokens >= input.budget.compressionTriggerTokens &&
    (input.forced ||
      input.estimatedInputTokens - input.lastCompressionInputTokens >=
        input.budget.minTokensAddedAfterCompression);
  const hardRiskTokens = Math.floor(input.budget.safeInputTokens * 0.95);
  return {
    shouldTrigger,
    hardRiskTokens,
    effectiveTrigger:
      shouldTrigger ||
      (input.estimatedInputTokens >= hardRiskTokens && input.mode !== 'disabled'),
  };
}

export function buildNormalContextTrimOptions(budget: ResolvedContextBudget): ContextReductionTrimOptions {
  return {
    maxTotalChars: Math.max(MIN_TRIM_CHARS, budget.estimatedContextWindowChars - NORMAL_WINDOW_RESERVE_CHARS),
    keepLatestCount: NORMAL_KEEP_LATEST_COUNT,
    maxToolChars: NORMAL_TOOL_CHARS,
    maxNonToolChars: NORMAL_NON_TOOL_CHARS,
  };
}

export function buildProviderProjectionTrimOptions(
  budget: ResolvedContextBudget,
  maxTotalChars?: number
): ContextReductionTrimOptions {
  const normal = buildNormalContextTrimOptions(budget);
  const requestedMax =
    typeof maxTotalChars === 'number' && Number.isFinite(maxTotalChars)
      ? Math.max(1, Math.floor(maxTotalChars))
      : normal.maxTotalChars;
  return {
    ...normal,
    maxTotalChars: Math.min(normal.maxTotalChars, requestedMax),
  };
}

export function resolveForcedTrimChars(budget: ResolvedContextBudget): number {
  return Math.floor(tokensToCharHint(budget.postCompressionTargetTokens));
}

export function buildForcedContextTrimOptions(budget: ResolvedContextBudget): ContextReductionTrimOptions {
  return {
    maxTotalChars: Math.max(MIN_TRIM_CHARS, resolveForcedTrimChars(budget)),
    keepLatestCount: FORCED_KEEP_LATEST_COUNT,
    maxToolChars: FORCED_TOOL_CHARS,
    maxNonToolChars: FORCED_NON_TOOL_CHARS,
  };
}

export function resolveMergedSummaryMaxChars(budget: ResolvedContextBudget): number {
  const triggerCharEstimate = Math.floor(tokensToCharHint(budget.compressionTriggerTokens) * 0.25);
  return Math.max(MERGED_SUMMARY_MIN_CHARS, Math.min(MERGED_SUMMARY_MAX_CHARS, triggerCharEstimate));
}

export function resolveMaxTokensRecoveryTrimChars(budget: ResolvedContextBudget): number {
  return Math.max(
    MAX_TOKENS_RECOVERY_MIN_CHARS,
    Math.min(MAX_TOKENS_RECOVERY_MAX_CHARS, resolveForcedTrimChars(budget))
  );
}

export function buildMaxTokensRecoveryTrimOptions(budget: ResolvedContextBudget): ContextReductionTrimOptions {
  return {
    maxTotalChars: resolveMaxTokensRecoveryTrimChars(budget),
    keepLatestCount: 16,
    maxToolChars: FORCED_TOOL_CHARS,
    maxNonToolChars: FORCED_NON_TOOL_CHARS,
  };
}

export function truncateWithReductionMarker(
  content: string,
  maxChars: number,
  marker: string,
  attributes: Record<string, string | number | undefined> = {}
): string {
  if (content.length <= maxChars) {
    return content;
  }
  const serializedAttributes = Object.entries({
    ...attributes,
    original_chars: content.length,
    kept_chars: maxChars,
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  const header = `[${marker}${serializedAttributes ? ` ${serializedAttributes}` : ''}]`;
  const bodyBudget = Math.max(0, maxChars - header.length - 1);
  return bodyBudget > 0 ? `${header}\n${content.slice(0, bodyBudget)}` : header.slice(0, maxChars);
}

export function buildCompressionRetryTruncatedNotice(droppedMessages: number): string {
  return (
    `[${CONTEXT_REDUCTION_MARKERS.retryTruncated} dropped_messages=${droppedMessages} reason=prompt_too_long]\n` +
    'The oldest source messages were omitted from this compression request to fit the compressor context window.'
  );
}

export function prefixCompressionSourceTruncatedSummary(
  summary: string,
  droppedMessages: number
): string {
  return (
    `[${CONTEXT_REDUCTION_MARKERS.sourceTruncated} dropped_messages=${droppedMessages} reason=prompt_too_long]\n` +
    'The oldest source messages were intentionally omitted from the compression request after compressor prompt-size failures.\n' +
    summary
  );
}

export function buildContextPrecompressedContent(input: {
  mode: Exclude<ContextReductionMode, 'disabled'>;
  keepLlmRounds: number;
  chunkCount: number;
  sourceMessageCount: number;
  sourceDroppedMessageCount: number;
  summary: string;
}): string {
  return (
    `[${CONTEXT_REDUCTION_MARKERS.contextPrecompressed} mode=${input.mode}] kept_llm_rounds=${input.keepLlmRounds} chunks=${input.chunkCount} source_messages=${input.sourceMessageCount} source_dropped=${input.sourceDroppedMessageCount}\n` +
    input.summary
  );
}

export function buildContextCompressedRecoveryContent(summary: string): string {
  return (
    `[${CONTEXT_REDUCTION_MARKERS.contextCompressed}] Earlier history summary:\n` +
    `${summary}\n` +
    'Use this summary as canonical history for older steps.'
  );
}

export function buildMaxTokensContinuationPrompt(attempt: number, maxAttempts: number): string {
  return [
    `[${CONTEXT_REDUCTION_MARKERS.maxTokensRecovery}]`,
    `continuation_attempt=${attempt}/${maxAttempts}`,
    'Continue from the latest valid state with concise progress only.',
    'Do not repeat prior analysis; prioritize next actionable step.',
  ].join('\n');
}
