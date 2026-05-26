import type { ResolvedContextBudget } from '../../src/types.js';
import { tokensToCharHint } from '../../src/shared/context-token-estimation.js';

export function createResolvedTestContextBudget(
  overrides: Partial<ResolvedContextBudget> = {}
): ResolvedContextBudget {
  const contextWindowTokens = overrides.contextWindowTokens ?? 200000;
  const reservedOutputTokens = overrides.reservedOutputTokens ?? 16000;
  const reservedReasoningTokens = overrides.reservedReasoningTokens ?? 0;
  const reservedProtocolTokens = overrides.reservedProtocolTokens ?? 8000;
  const compressionTriggerRatio = overrides.compressionTriggerRatio ?? 0.9;
  const postCompressionTargetRatio = overrides.postCompressionTargetRatio ?? 0.35;
  const safeInputTokens = Math.max(
    1,
    contextWindowTokens - reservedOutputTokens - reservedReasoningTokens - reservedProtocolTokens
  );

  return {
    provider: 'test',
    model: 'test-model',
    contextWindowTokens,
    estimatedContextWindowChars: tokensToCharHint(contextWindowTokens),
    compressionTriggerRatio,
    postCompressionTargetRatio,
    minTokensAddedAfterCompression: 16000,
    compressionMaxChars: 6000,
    precompressKeepLlmRounds: 5,
    precompressChunkChars: 60000,
    precompressRetry: 1,
    reservedOutputTokens,
    reservedReasoningTokens,
    reservedProtocolTokens,
    safeInputTokens,
    compressionTriggerTokens: Math.floor(safeInputTokens * compressionTriggerRatio),
    postCompressionTargetTokens: Math.floor(contextWindowTokens * postCompressionTargetRatio),
    source: 'config_default',
    ...overrides,
  };
}
