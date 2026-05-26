import * as assert from 'node:assert/strict';
import {
  buildContextCompressedRecoveryContent,
  buildContextPrecompressedContent,
  buildForcedContextTrimOptions,
  buildMaxTokensContinuationPrompt,
  buildNormalContextTrimOptions,
  prefixCompressionSourceTruncatedSummary,
  resolveMaxTokensRecoveryTrimChars,
  resolvePrecompressKeepRounds,
  shouldTriggerPrecompress,
  truncateWithReductionMarker,
} from '../../src/runtime/context-reduction-policy.js';
import type { ResolvedContextBudget } from '../../src/types.js';

function createBudget(): ResolvedContextBudget {
  return {
    provider: 'anthropic',
    model: 'test-model',
    contextWindowTokens: 100000,
    estimatedContextWindowChars: 400000,
    compressionTriggerRatio: 0.8,
    postCompressionTargetRatio: 0.3,
    minTokensAddedAfterCompression: 1000,
    compressionMaxChars: 6000,
    precompressKeepLlmRounds: 5,
    precompressChunkChars: 60000,
    precompressRetry: 1,
    reservedOutputTokens: 10000,
    reservedReasoningTokens: 0,
    reservedProtocolTokens: 5000,
    safeInputTokens: 85000,
    compressionTriggerTokens: 68000,
    postCompressionTargetTokens: 30000,
    source: 'config_default',
  };
}

function testPrecompressDecisionPreservesHysteresis(): void {
  const budget = createBudget();
  assert.deepEqual(
    shouldTriggerPrecompress({
      estimatedInputTokens: 69000,
      budget,
      lastCompressionInputTokens: 68500,
      forced: false,
      mode: 'light',
    }),
    {
      shouldTrigger: false,
      hardRiskTokens: 80750,
      effectiveTrigger: false,
    }
  );
  const hardRiskDecision = shouldTriggerPrecompress({
      estimatedInputTokens: 82000,
      budget,
      lastCompressionInputTokens: 81999,
      forced: false,
      mode: 'light',
    });
  assert.equal(hardRiskDecision.shouldTrigger, false);
  assert.equal(hardRiskDecision.effectiveTrigger, true);
}

function testTrimPoliciesPreserveExistingBounds(): void {
  const budget = createBudget();
  assert.deepEqual(buildNormalContextTrimOptions(budget), {
    maxTotalChars: 390000,
    keepLatestCount: 24,
    maxToolChars: 4000,
    maxNonToolChars: 12000,
  });
  assert.deepEqual(buildForcedContextTrimOptions(budget), {
    maxTotalChars: 66666,
    keepLatestCount: 14,
    maxToolChars: 2000,
    maxNonToolChars: 6000,
  });
  assert.equal(resolveMaxTokensRecoveryTrimChars(budget), 66666);
}

function testMarkersPreserveExternalStrings(): void {
  assert.equal(
    resolvePrecompressKeepRounds({
      configuredKeepRounds: 5,
      mode: 'aggressive',
      aggressiveKeepRoundsCap: 3,
    }),
    3
  );
  assert.match(
    prefixCompressionSourceTruncatedSummary('summary', 2),
    /^\[COMPRESSION_SOURCE_TRUNCATED dropped_messages=2 reason=prompt_too_long\]/
  );
  assert.match(
    buildContextPrecompressedContent({
      mode: 'light',
      keepLlmRounds: 1,
      chunkCount: 2,
      sourceMessageCount: 3,
      sourceDroppedMessageCount: 4,
      summary: 'summary',
    }),
    /^\[CONTEXT_PRECOMPRESSED mode=light\] kept_llm_rounds=1 chunks=2 source_messages=3 source_dropped=4/
  );
  assert.match(buildContextCompressedRecoveryContent('summary'), /^\[CONTEXT_COMPRESSED\]/);
  assert.match(buildMaxTokensContinuationPrompt(1, 2), /^\[MAX_TOKENS_RECOVERY\]/);
  assert.match(
    truncateWithReductionMarker('abcdef'.repeat(20), 80, 'COMPRESSION_SUMMARY_TRUNCATED', { reason: 'test' }),
    /^\[COMPRESSION_SUMMARY_TRUNCATED reason=test original_chars=120 kept_chars=80\]/
  );
}

testPrecompressDecisionPreservesHysteresis();
testTrimPoliciesPreserveExistingBounds();
testMarkersPreserveExternalStrings();
console.log('context-reduction-policy tests passed');
