import * as assert from 'node:assert/strict';
import { evaluateRuntimeWatchdog } from '../../src/web/client/runtime-watchdog.js';
import {
  createRuntimeState,
  contextUtilizationFromPrecompressPayload,
  createPendingRunRuntimeState,
  finishRuntimeHydrationAfterLoadFailure,
  finalizeRuntimeAfterComplete,
  isRuntimeInteractionLocked,
  isRuntimeLlmSelectionLocked,
  shouldApplyContextPrecompressEvent,
  shouldApplyCancelAck,
  shouldApplyRunEvent,
  shouldApplyRunTerminalEvent,
} from '../../src/web/client/app-shell-types.js';

const THRESHOLDS = {
  warningMs: 60000,
  cancelAckTimeoutMs: 10000,
};

function testCancelTimeoutUsesCancelRequestTimestamp(): void {
  const now = 1_000_000;
  const decision = evaluateRuntimeWatchdog(
    now,
    {
      isRunning: false,
      runStartedAt: now - 300_000,
      lastActivityAt: now - 300_000,
      cancelInitiated: true,
      cancelAcknowledged: false,
      cancelRequestedAt: now - 5_000,
    },
    THRESHOLDS,
    0
  );

  assert.deepEqual(decision, { kind: 'none' });
}

function testCancelTimeoutOnlyWarnsAfterAcknowledgmentWindow(): void {
  const now = 1_000_000;
  const decision = evaluateRuntimeWatchdog(
    now,
    {
      isRunning: false,
      runStartedAt: now - 300_000,
      lastActivityAt: now - 300_000,
      cancelInitiated: true,
      cancelAcknowledged: false,
      cancelRequestedAt: now - 11_000,
    },
    THRESHOLDS,
    0
  );

  assert.deepEqual(decision, {
    kind: 'cancel_warning',
    elapsedMs: 11_000,
    warningBucket: 1,
  });
}

function testRunWarningIsBucketedAndDeduped(): void {
  const now = 1_000_000;
  const runtime = {
    isRunning: true,
    runStartedAt: now - 61_000,
    lastActivityAt: now - 61_000,
    cancelInitiated: false,
    cancelAcknowledged: false,
    cancelRequestedAt: 0,
  };

  assert.deepEqual(evaluateRuntimeWatchdog(now, runtime, THRESHOLDS, 0), {
    kind: 'run_warning',
    elapsedMs: 61_000,
    warningBucket: 1,
  });
  assert.deepEqual(evaluateRuntimeWatchdog(now, runtime, THRESHOLDS, 1), {
    kind: 'none',
  });
}

function testLongIdleRunOnlyWarnsAfterResetThreshold(): void {
  const now = 1_000_000;
  const decision = evaluateRuntimeWatchdog(
    now,
    {
      isRunning: true,
      runStartedAt: now - 121_000,
      lastActivityAt: now - 121_000,
      cancelInitiated: false,
      cancelAcknowledged: false,
      cancelRequestedAt: 0,
    },
    THRESHOLDS,
    1
  );

  assert.deepEqual(decision, {
    kind: 'run_warning',
    elapsedMs: 121_000,
    warningBucket: 2,
  });
}

function testRecentActivitySuppressesRunWarning(): void {
  const now = 1_000_000;
  const decision = evaluateRuntimeWatchdog(
    now,
    {
      isRunning: true,
      runStartedAt: now - 180_000,
      lastActivityAt: now - 5_000,
      cancelInitiated: false,
      cancelAcknowledged: false,
      cancelRequestedAt: 0,
    },
    THRESHOLDS,
    0
  );

  assert.deepEqual(decision, { kind: 'none' });
}

function testLongIdleUsesIdleTimeSinceLastActivityForWarning(): void {
  const now = 1_000_000;
  const decision = evaluateRuntimeWatchdog(
    now,
    {
      isRunning: true,
      runStartedAt: now - 300_000,
      lastActivityAt: now - 121_000,
      cancelInitiated: false,
      cancelAcknowledged: false,
      cancelRequestedAt: 0,
    },
    THRESHOLDS,
    1
  );

  assert.deepEqual(decision, {
    kind: 'run_warning',
    elapsedMs: 121_000,
    warningBucket: 2,
  });
}

function testContextPrecompressOnlyWarns(): void {
  const now = 1_000_000;
  const decision = evaluateRuntimeWatchdog(
    now,
    {
      isRunning: true,
      runStartedAt: now - 300_000,
      lastActivityAt: now - 300_000,
      cancelInitiated: false,
      cancelAcknowledged: false,
      cancelRequestedAt: 0,
      contextPrecompressActive: true,
    },
    THRESHOLDS,
    1
  );

  assert.deepEqual(decision, {
    kind: 'run_warning',
    elapsedMs: 300_000,
    warningBucket: 5,
  });
}

function testContextPrecompressEventRejectsCompletedRunEvent(): void {
  const completed = createRuntimeState();
  assert.equal(shouldApplyContextPrecompressEvent(completed, 'run-old'), false);
  const pending = createPendingRunRuntimeState(completed, 1_000);
  assert.equal(shouldApplyContextPrecompressEvent(pending, 'run-stale'), false);
  assert.equal(
    shouldApplyContextPrecompressEvent(
      {
        ...completed,
        runId: 'run-active',
        isRunning: true,
      },
      'run-active'
    ),
    true
  );
  assert.equal(
    shouldApplyContextPrecompressEvent(
      {
        ...completed,
        runId: 'run-active',
        isRunning: true,
      },
      'run-other'
    ),
    false
  );
}

function testInteractionLockBlocksHydrationAndActiveRun(): void {
  assert.equal(
    isRuntimeInteractionLocked({
      hydrating: false,
      isRunning: false,
      resumePending: false,
      dismissPending: false,
      cancelInitiated: true,
      cancelAcknowledged: false,
    }),
    true
  );
  assert.equal(
    isRuntimeInteractionLocked({
      hydrating: false,
      isRunning: false,
      resumePending: false,
      dismissPending: false,
      cancelInitiated: true,
      cancelAcknowledged: true,
    }),
    false
  );
  assert.equal(
    isRuntimeInteractionLocked({
      hydrating: true,
      hasHydrated: false,
      error: null,
      isRunning: false,
      resumePending: false,
      dismissPending: false,
      cancelInitiated: false,
      cancelAcknowledged: false,
    }),
    true
  );
  assert.equal(
    isRuntimeInteractionLocked({
      hydrating: false,
      hasHydrated: false,
      error: 'Failed to load session messages',
      isRunning: false,
      resumePending: false,
      dismissPending: false,
      cancelInitiated: false,
      cancelAcknowledged: false,
    }),
    false
  );
  assert.equal(
    isRuntimeInteractionLocked({
      hydrating: false,
      hasHydrated: false,
      error: null,
      isRunning: true,
      resumePending: false,
      dismissPending: false,
      cancelInitiated: false,
      cancelAcknowledged: false,
    }),
    true
  );
  assert.equal(
    isRuntimeInteractionLocked({
      hydrating: false,
      hasHydrated: true,
      error: null,
      isRunning: false,
      resumePending: false,
      dismissPending: true,
      cancelInitiated: false,
      cancelAcknowledged: false,
    }),
    true
  );
}

function testLlmSelectionLockBlocksHydrationAndActiveRun(): void {
  assert.equal(
    isRuntimeLlmSelectionLocked({
      hydrating: true,
      hasHydrated: false,
      error: null,
      isRunning: false,
      resumePending: false,
      dismissPending: false,
    }),
    true
  );
  assert.equal(
    isRuntimeLlmSelectionLocked({
      hydrating: false,
      hasHydrated: false,
      error: 'Failed to load session messages',
      isRunning: false,
      resumePending: false,
      dismissPending: false,
    }),
    false
  );
  assert.equal(
    isRuntimeLlmSelectionLocked({
      hydrating: false,
      hasHydrated: true,
      error: null,
      isRunning: true,
      resumePending: false,
      dismissPending: false,
    }),
    true
  );
  assert.equal(
    isRuntimeLlmSelectionLocked({
      hydrating: false,
      hasHydrated: true,
      error: null,
      isRunning: false,
      resumePending: true,
      dismissPending: false,
    }),
    true
  );
  assert.equal(
    isRuntimeLlmSelectionLocked({
      hydrating: false,
      hasHydrated: true,
      error: null,
      isRunning: false,
      resumePending: false,
      dismissPending: true,
    }),
    true
  );
  assert.equal(
    isRuntimeLlmSelectionLocked({
      hydrating: false,
      hasHydrated: true,
      error: null,
      isRunning: false,
      resumePending: false,
      dismissPending: false,
    }),
    false
  );
}

function testHydrationFailureUnlocksNeverHydratedIdleRuntime(): void {
  const failed = finishRuntimeHydrationAfterLoadFailure(
    {
      ...createRuntimeState(),
      hydrating: true,
      hasHydrated: false,
    },
    new Error('load failed')
  );
  assert.equal(failed.hydrating, false);
  assert.equal(failed.hasHydrated, false);
  assert.equal(failed.error, 'load failed');
  assert.equal(isRuntimeInteractionLocked(failed), false);
  assert.equal(isRuntimeLlmSelectionLocked(failed), false);
}

function testCancelAckAcceptsOnlyCurrentCancel(): void {
  assert.equal(
    shouldApplyCancelAck(
      { runId: 'run-active', cancelInitiated: false, ignoredRunIds: [] },
      'run-active'
    ),
    true
  );
  assert.equal(
    shouldApplyCancelAck(
      { runId: null, cancelInitiated: true, ignoredRunIds: ['run-stopped'] },
      'run-stopped'
    ),
    true
  );
  assert.equal(
    shouldApplyCancelAck(
      { runId: 'run-next', cancelInitiated: false, ignoredRunIds: ['run-stopped'] },
      'run-stopped'
    ),
    false
  );
}

function testPendingRunRejectsUnboundRunEventsUntilChatStarted(): void {
  const pending = createPendingRunRuntimeState(createRuntimeState(), 1_000);
  assert.equal(shouldApplyRunEvent(pending, 'run-stale'), false);
  assert.equal(
    shouldApplyRunEvent(
      {
        ...pending,
        runId: 'run-active',
      },
      'run-active'
    ),
    true
  );
}

function testPendingRunStatePreservesInterruptedArtifactUntilServerAck(): void {
  const startedAt = 1_234_567;
  const runtime = {
    ...createRuntimeState(),
    ignoredRunIds: ['run-old'],
    interruptedArtifact: {
      artifactId: 'artifact-1',
      context: { scope: 'session', namespace: 'sess-1' },
      draftId: 'draft-1',
      turnId: 'turn-1',
      runId: 'run-1',
      runFamilyId: 'family-1',
      terminalCode: 'error',
      replayCutoffKind: 'checkpoint',
      resumable: true,
      lastSafeStep: 55,
      maxSteps: 100,
      createdAt: '2026-04-26T10:00:00.000Z',
      updatedAt: '2026-04-26T10:00:00.000Z',
      previewMessages: [],
      sideEffectLedger: [],
    },
  };

  const next = createPendingRunRuntimeState(runtime, startedAt);

  assert.equal(next.isRunning, true);
  assert.equal(next.runStartedAt, startedAt);
  assert.equal(next.lastActivityAt, startedAt);
  assert.deepEqual(next.ignoredRunIds, ['run-old']);
  assert.equal(next.interruptedArtifact?.artifactId, 'artifact-1');
}

function testCompletedRunClearsInterruptedArtifactAfterSuccessfulRecovery(): void {
  const completedAt = 2_000_000;
  const runtime = {
    ...createRuntimeState(),
    runId: 'run-active',
    isRunning: true,
    compressionStatus: {
      source: 'in_turn_precompress',
      phase: 'running',
      observedAt: '2026-04-26T10:00:00.000Z',
      progressPercent: 80,
    },
    currentStep: 55,
    maxSteps: 100,
    interruptedArtifact: {
      artifactId: 'artifact-1',
      context: { scope: 'session', namespace: 'sess-1' },
      draftId: 'draft-1',
      turnId: 'turn-1',
      runId: 'run-1',
      runFamilyId: 'family-1',
      terminalCode: 'error',
      replayCutoffKind: 'checkpoint',
      resumable: false,
      lastSafeStep: 55,
      maxSteps: 100,
      createdAt: '2026-04-26T10:00:00.000Z',
      updatedAt: '2026-04-26T10:00:00.000Z',
      previewMessages: [],
      sideEffectLedger: [],
    },
  };

  const next = finalizeRuntimeAfterComplete(runtime, 'run-active', completedAt);

  assert.equal(next.isRunning, false);
  assert.equal(next.runId, null);
  assert.equal(next.lastActivityAt, completedAt);
  assert.equal(next.interruptedArtifact, null);
  assert.equal(next.lastTerminalState, null);
  assert.equal(next.compressionStatus, null);
  assert.deepEqual(next.ignoredRunIds, ['run-active']);
}

function testIdleRuntimeRejectsUnknownRunTerminalEvent(): void {
  const runtime = createRuntimeState();
  assert.equal(shouldApplyRunTerminalEvent(runtime, 'run-stale'), false);
  assert.equal(
    shouldApplyRunTerminalEvent(
      {
        ...runtime,
        ignoredRunIds: ['run-known'],
      },
      'run-known'
    ),
    true
  );
}

function testContextPrecompressPayloadUpdatesUtilization(): void {
  assert.deepEqual(
    contextUtilizationFromPrecompressPayload({
      ratio: 0.12,
      usedChars: 6000,
      limitChars: 50000,
    }),
    {
      ratio: 0.12,
      usedChars: 6000,
      limitChars: 50000,
      isWarning: false,
      initializing: false,
    }
  );
  assert.deepEqual(
    contextUtilizationFromPrecompressPayload({
      ratio: 0.1,
      usedChars: 43500,
      limitChars: 50000,
    }),
    {
      ratio: 0.87,
      usedChars: 43500,
      limitChars: 50000,
      isWarning: true,
      initializing: false,
    }
  );
  assert.equal(contextUtilizationFromPrecompressPayload({ ratio: 0.1, usedChars: 100, limitChars: 0 }), null);
  assert.equal(contextUtilizationFromPrecompressPayload({ ratio: 0.1, usedChars: 100, limitChars: 0.5 }), null);
  assert.equal(contextUtilizationFromPrecompressPayload({ ratio: 0.1, usedChars: -1, limitChars: 1000 }), null);
}

function runAll(): void {
  testCancelTimeoutUsesCancelRequestTimestamp();
  testCancelTimeoutOnlyWarnsAfterAcknowledgmentWindow();
  testRunWarningIsBucketedAndDeduped();
  testLongIdleRunOnlyWarnsAfterResetThreshold();
  testRecentActivitySuppressesRunWarning();
  testLongIdleUsesIdleTimeSinceLastActivityForWarning();
  testContextPrecompressOnlyWarns();
  testContextPrecompressEventRejectsCompletedRunEvent();
  testInteractionLockBlocksHydrationAndActiveRun();
  testLlmSelectionLockBlocksHydrationAndActiveRun();
  testHydrationFailureUnlocksNeverHydratedIdleRuntime();
  testCancelAckAcceptsOnlyCurrentCancel();
  testPendingRunRejectsUnboundRunEventsUntilChatStarted();
  testPendingRunStatePreservesInterruptedArtifactUntilServerAck();
  testCompletedRunClearsInterruptedArtifactAfterSuccessfulRecovery();
  testIdleRuntimeRejectsUnknownRunTerminalEvent();
  testContextPrecompressPayloadUpdatesUtilization();
  console.log('web-runtime-watchdog tests passed');
}

runAll();
