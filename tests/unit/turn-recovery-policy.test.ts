import * as assert from 'node:assert/strict';
import {
  decideContextOverflowRecovery,
  decideProgressOnlyRecovery,
  decideToolCallProtocolRecovery,
  shouldRetryTransportBeforeVisibleOutput,
} from '../../src/agent/TurnRecoveryPolicy.js';
import { buildMalformedToolProtocolNotice } from '../../src/llm/tool-protocol-analyzer.js';

function testToolCallProtocolRecoveryEscalatesOnSecondFailure(): void {
  assert.deepEqual(decideToolCallProtocolRecovery({ consecutiveFailureCount: 0 }), {
    kind: 'inject',
    nextCount: 1,
  });
  assert.deepEqual(decideToolCallProtocolRecovery({ consecutiveFailureCount: 1 }), {
    kind: 'escalate',
    nextCount: 2,
  });
}

function testTransportRetryRequiresNoVisibleOutput(): void {
  assert.equal(
    shouldRetryTransportBeforeVisibleOutput({
      streamedVisibleOutput: false,
      error: new Error('read ECONNRESET'),
      transportRetryCount: 0,
      maxAttempts: 2,
    }),
    true
  );
  assert.equal(
    shouldRetryTransportBeforeVisibleOutput({
      streamedVisibleOutput: true,
      error: new Error('read ECONNRESET'),
      transportRetryCount: 0,
      maxAttempts: 2,
    }),
    false
  );
}

function testContextOverflowDecisionSequence(): void {
  assert.equal(
    decideContextOverflowRecovery({ overflowCountInTurn: 1, maxErrorsBeforeTrim: 2 }),
    'retry_with_forced_compress'
  );
  assert.equal(
    decideContextOverflowRecovery({ overflowCountInTurn: 2, maxErrorsBeforeTrim: 2 }),
    'retry_with_forced_trim'
  );
  assert.equal(decideContextOverflowRecovery({ overflowCountInTurn: 3, maxErrorsBeforeTrim: 2 }), 'abort');
}

function testProgressOnlyRecoveryStallsAfterLimit(): void {
  assert.deepEqual(decideProgressOnlyRecovery({ consecutiveStopCount: 2, maxAttempts: 3 }), {
    kind: 'continue',
    nextCount: 3,
    maxAttempts: 3,
  });
  assert.deepEqual(decideProgressOnlyRecovery({ consecutiveStopCount: 3, maxAttempts: 3 }), {
    kind: 'stall',
    nextCount: 4,
    maxAttempts: 3,
  });
}

function testMalformedToolProtocolNotice(): void {
  assert.equal(
    buildMalformedToolProtocolNotice('orphan tool_result replay was converted to user note'),
    '[TOOLCALL_FAILED] orphan tool_result replay was converted to user note. next_action=Issue fresh tool calls and continue from latest valid state.'
  );
}

function runAll(): void {
  testToolCallProtocolRecoveryEscalatesOnSecondFailure();
  testTransportRetryRequiresNoVisibleOutput();
  testContextOverflowDecisionSequence();
  testProgressOnlyRecoveryStallsAfterLimit();
  testMalformedToolProtocolNotice();
  console.log('turn-recovery-policy tests passed');
}

runAll();
