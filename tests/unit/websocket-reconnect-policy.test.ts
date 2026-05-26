import * as assert from 'node:assert/strict';
import {
  FAST_RECONNECT_ATTEMPTS,
  SLOW_RECONNECT_DELAY_MS,
  resolveReconnectPolicy,
} from '../../src/web/client/websocket-reconnect-policy.js';

function testFastReconnectAttemptsUseFastDelay(): void {
  const decision = resolveReconnectPolicy({ nextAttempt: 3, fastDelayMs: 1234 });
  assert.equal(decision.attempt, 3);
  assert.equal(decision.displayAttempt, 3);
  assert.equal(decision.maxDisplayAttempts, FAST_RECONNECT_ATTEMPTS);
  assert.equal(decision.delayMs, 1234);
  assert.equal(decision.slowMode, false);
}

function testReconnectContinuesAfterFastAttempts(): void {
  const decision = resolveReconnectPolicy({ nextAttempt: FAST_RECONNECT_ATTEMPTS + 1, fastDelayMs: 999 });
  assert.equal(decision.attempt, FAST_RECONNECT_ATTEMPTS + 1);
  assert.equal(decision.displayAttempt, FAST_RECONNECT_ATTEMPTS);
  assert.equal(decision.maxDisplayAttempts, FAST_RECONNECT_ATTEMPTS);
  assert.equal(decision.delayMs, SLOW_RECONNECT_DELAY_MS);
  assert.equal(decision.slowMode, true);
}

testFastReconnectAttemptsUseFastDelay();
testReconnectContinuesAfterFastAttempts();

console.log('websocket-reconnect-policy tests passed');
