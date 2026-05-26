import * as assert from 'node:assert/strict';
import {
  buildPreparedInputUsageSnapshot,
  createPromptUsageAnchor,
  estimateAnchoredContextUsage,
} from '../../src/runtime/context-window-budget.js';

function testAnchoredEstimateUsesPromptUsagePlusDelta(): void {
  const anchorSnapshot = buildPreparedInputUsageSnapshot('alpha');
  const nextSnapshot = buildPreparedInputUsageSnapshot('alphabeta');
  const anchor = createPromptUsageAnchor({
    adapterProvider: 'anthropic',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7-highspeed',
    snapshot: anchorSnapshot,
    promptTokens: 120,
  });
  assert.ok(anchor);
  const anchored = estimateAnchoredContextUsage({
    anchor,
    adapterProvider: 'anthropic',
    apiBase: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M2.7-highspeed',
    snapshot: nextSnapshot,
  });
  assert.ok(anchored);
  assert.equal(anchored.anchorPromptTokens, 120);
  assert.equal(anchored.deltaEstimatedTokens > 0, true);
  assert.equal(anchored.inputTokens, anchored.anchorPromptTokens + anchored.deltaEstimatedTokens);
}

function testAnchoredEstimateAcceptsAppendedPreparedMessageSequence(): void {
  const anchorSnapshot = buildPreparedInputUsageSnapshot({
    model: 'MiniMax-M2.7-highspeed',
    system: 'system',
    tools: [{ name: 'read_file' }],
    messages: [{ role: 'user', content: 'alpha' }],
  });
  const nextSnapshot = buildPreparedInputUsageSnapshot({
    model: 'MiniMax-M2.7-highspeed',
    system: 'system',
    tools: [{ name: 'read_file' }],
    messages: [
      { role: 'user', content: 'alpha' },
      { role: 'assistant', content: 'planning', tool_calls: [{ id: 'tool-1', name: 'read_file' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'beta' }] },
    ],
  });
  const anchor = createPromptUsageAnchor({
    adapterProvider: 'anthropic',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7-highspeed',
    snapshot: anchorSnapshot,
    promptTokens: 120,
  });
  assert.ok(anchor);
  const anchored = estimateAnchoredContextUsage({
    anchor,
    adapterProvider: 'anthropic',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7-highspeed',
    snapshot: nextSnapshot,
  });
  assert.ok(anchored);
  assert.equal(anchored.anchorPromptTokens, 120);
  assert.equal(anchored.deltaEstimatedTokens > 0, true);
}

function testAnchoredEstimateRejectsProtocolBucketMismatch(): void {
  const anchorSnapshot = buildPreparedInputUsageSnapshot('alpha');
  const nextSnapshot = buildPreparedInputUsageSnapshot('alphabeta');
  const anchor = createPromptUsageAnchor({
    adapterProvider: 'anthropic',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7-highspeed',
    snapshot: anchorSnapshot,
    promptTokens: 120,
  });
  assert.equal(
    estimateAnchoredContextUsage({
      anchor,
      adapterProvider: 'openai',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7-highspeed',
      snapshot: nextSnapshot,
    }),
    null
  );
}

function testAnchoredEstimateRejectsNonAppendPayload(): void {
  const anchorSnapshot = buildPreparedInputUsageSnapshot('alpha');
  const nextSnapshot = buildPreparedInputUsageSnapshot('betaalpha');
  const anchor = createPromptUsageAnchor({
    adapterProvider: 'anthropic',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7-highspeed',
    snapshot: anchorSnapshot,
    promptTokens: 120,
  });
  assert.equal(
    estimateAnchoredContextUsage({
      anchor,
      adapterProvider: 'anthropic',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7-highspeed',
      snapshot: nextSnapshot,
    }),
    null
  );
}

testAnchoredEstimateUsesPromptUsagePlusDelta();
testAnchoredEstimateAcceptsAppendedPreparedMessageSequence();
testAnchoredEstimateRejectsProtocolBucketMismatch();
testAnchoredEstimateRejectsNonAppendPayload();
console.log('context-window-budget-anchor tests passed');
