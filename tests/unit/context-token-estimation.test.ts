import * as assert from 'node:assert/strict';
import {
  charsToTokenHint,
  estimateWeightedTokenDeltaFromSerializedPayload,
  estimateWeightedTokensFromPayload,
  estimateWeightedTokensFromString,
  estimateWeightedTokensFromStringAllowZero,
  stringifyPayloadForTokenEstimation,
  tokensToCharHint,
} from '../../src/shared/context-token-estimation.js';

function testEnglishWeighting(): void {
  assert.equal(estimateWeightedTokensFromString('abcd'), 2);
}

function testChineseWeighting(): void {
  assert.equal(estimateWeightedTokensFromString('你好世界'), 3);
}

function testMixedPayloadEstimation(): void {
  const estimate = estimateWeightedTokensFromPayload({
    text: 'Hello世界',
    count: 2,
  });
  assert.equal(estimate.rawChars, estimate.serialized.length);
  assert.equal(estimate.inputTokens > 0, true);
}

function testHintConversionsStayPositive(): void {
  assert.equal(tokensToCharHint(1000), 2222);
  assert.equal(charsToTokenHint(2222), 999);
  assert.equal(charsToTokenHint(0), 1);
}

function testPayloadStringifyFallsBack(): void {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.match(stringifyPayloadForTokenEstimation(circular), /\[object Object\]/);
}

function testAllowZeroWeightedEstimate(): void {
  assert.equal(estimateWeightedTokensFromStringAllowZero('', { allowZero: true }), 0);
}

function testSerializedPayloadDelta(): void {
  assert.deepEqual(
    estimateWeightedTokenDeltaFromSerializedPayload('alpha', 'alphabet'),
    {
      appendOnly: true,
      deltaChars: 3,
      deltaTokens: 1,
    }
  );
  assert.deepEqual(
    estimateWeightedTokenDeltaFromSerializedPayload('alpha', 'betaalpha'),
    {
      appendOnly: false,
      deltaChars: 0,
      deltaTokens: 0,
    }
  );
}

testEnglishWeighting();
testChineseWeighting();
testMixedPayloadEstimation();
testHintConversionsStayPositive();
testPayloadStringifyFallsBack();
testAllowZeroWeightedEstimate();
testSerializedPayloadDelta();
console.log('context-token-estimation tests passed');
