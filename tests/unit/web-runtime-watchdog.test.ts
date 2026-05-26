import * as assert from 'node:assert/strict';
import { evaluateRuntimeWatchdog } from '../../src/web/client/runtime-watchdog.js';
import {
  buildRuntimeInteractionLockDiagnostic,
  createRuntimeState,
  contextUtilizationFromPrecompressPayload,
  createPendingRunRuntimeState,
  finishRuntimeHydrationAfterLoadFailure,
  finalizeRuntimeAfterComplete,
  finalizeRuntimeAfterRecoverableConflictError,
  hydrateRuntimeFromActiveRun,
  isRuntimeInteractionLocked,
  isRuntimeLlmSelectionLocked,
  resolveActiveRunForHydration,
  resolveInterruptedArtifactForHydration,
  removeRunningInputQueueItem,
  shouldApplyContextPrecompressEvent,
  shouldApplyCancelAck,
  shouldApplyRunEvent,
  shouldApplyRunTerminalEvent,
  shouldPreserveCurrentRunForIgnoredActiveRunHydration,
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
      cancelInitiated: true,
      cancelAcknowledged: false,
    }),
    true
  );
  assert.equal(
    isRuntimeInteractionLocked({
      hydrating: false,
      isRunning: false,
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
      cancelInitiated: false,
      cancelAcknowledged: false,
    }),
    true
  );
}

function testInteractionLockDiagnosticExplainsStaleRunningState(): void {
  const diagnostic = buildRuntimeInteractionLockDiagnostic({
    sessionId: 'sess-locked',
    runtime: {
      ...createRuntimeState(),
      runId: 'run-stale',
      isRunning: true,
      hasHydrated: true,
      hydrating: false,
      runStartedAt: Date.parse('2026-05-10T01:00:00.000Z'),
      lastActivityAt: Date.parse('2026-05-10T01:02:00.000Z'),
    },
  });

  assert.deepEqual(diagnostic, {
    sessionId: 'sess-locked',
    reason: 'running',
    runId: 'run-stale',
    isRunning: true,
    hydrating: false,
    cancelInitiated: false,
    cancelAcknowledged: false,
    observeOnly: false,
    lastActivityAt: '2026-05-10T01:02:00.000Z',
  });
}

function testLlmSelectionLockBlocksHydrationAndCancelingButAllowsActiveRun(): void {
  assert.equal(
    isRuntimeLlmSelectionLocked({
      hydrating: true,
      hasHydrated: false,
      error: null,
      isRunning: false,
    }),
    true
  );
  assert.equal(
    isRuntimeLlmSelectionLocked({
      hydrating: false,
      hasHydrated: false,
      error: 'Failed to load session messages',
      isRunning: false,
    }),
    false
  );
  assert.equal(
    isRuntimeLlmSelectionLocked({
      hydrating: false,
      hasHydrated: true,
      error: null,
      isRunning: true,
    }),
    false
  );
  assert.equal(
    isRuntimeLlmSelectionLocked({
      hydrating: false,
      hasHydrated: true,
      error: null,
      isRunning: false,
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

function testPendingRunStateClearsInterruptedArtifactBeforeNextRun(): void {
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
  assert.equal(next.interruptedArtifact, null);
}

function testActiveRunHydrationRefreshesProgressAndWatchdogActivity(): void {
  const runtime = {
    ...createRuntimeState(),
    runId: 'run-active',
    isRunning: true,
    runStartedAt: Date.parse('2026-05-05T01:00:00.000Z'),
    lastActivityAt: Date.parse('2026-05-05T01:00:05.000Z'),
    currentStep: 1,
    maxSteps: 10,
  };

  const hydrated = hydrateRuntimeFromActiveRun({
    runtime,
    activeRun: {
      runId: 'run-active',
      context: { scope: 'session', namespace: 'sess-active' },
      startedAt: '2026-05-05T01:00:00.000Z',
      lastActivityAt: '2026-05-05T01:00:30.000Z',
      currentStep: 4,
      maxSteps: 20,
      owner: 'cli',
      interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
    },
    now: Date.parse('2026-05-05T01:00:40.000Z'),
  });

  assert.equal(hydrated.hasHydrated, true);
  assert.equal(hydrated.hydrating, false);
  assert.equal(hydrated.isRunning, true);
  assert.equal(hydrated.runId, 'run-active');
  assert.equal(hydrated.runStartedAt, Date.parse('2026-05-05T01:00:00.000Z'));
  assert.equal(hydrated.lastActivityAt, Date.parse('2026-05-05T01:00:30.000Z'));
  assert.equal(hydrated.currentStep, 4);
  assert.equal(hydrated.maxSteps, 20);
  assert.equal(hydrated.activeRunOwner, 'cli');
  assert.deepEqual(hydrated.interactionState, {
    mode: 'observe_only',
    reason: 'cli_active_run',
    owner: 'cli',
  });
}

function testActiveRunHydrationDoesNotRegressNewerClientActivity(): void {
  const runtime = {
    ...createRuntimeState(),
    runId: 'run-active',
    isRunning: true,
    runStartedAt: Date.parse('2026-05-05T01:00:00.000Z'),
    lastActivityAt: Date.parse('2026-05-05T01:00:45.000Z'),
    currentStep: 3,
    maxSteps: 12,
  };

  const hydrated = hydrateRuntimeFromActiveRun({
    runtime,
    activeRun: {
      runId: 'run-active',
      context: { scope: 'session', namespace: 'sess-active' },
      startedAt: '2026-05-05T01:00:00.000Z',
      lastActivityAt: '2026-05-05T01:00:30.000Z',
      currentStep: 2,
      maxSteps: 8,
    },
    now: Date.parse('2026-05-05T01:00:50.000Z'),
  });

  assert.equal(hydrated.lastActivityAt, Date.parse('2026-05-05T01:00:45.000Z'));
  assert.equal(hydrated.currentStep, 3);
  assert.equal(hydrated.maxSteps, 12);
}

function testActiveRunHydrationIgnoresCompletedRunIds(): void {
  const runtime = {
    ...finalizeRuntimeAfterComplete(
      {
        ...createRuntimeState(),
        runId: 'run-complete',
        isRunning: true,
      },
      'run-complete',
      Date.parse('2026-05-05T01:01:00.000Z')
    ),
    hydrating: true,
  };

  const hydrated = hydrateRuntimeFromActiveRun({
    runtime,
    activeRun: {
      runId: 'run-complete',
      context: { scope: 'session', namespace: 'sess-active' },
      startedAt: '2026-05-05T01:00:00.000Z',
      lastActivityAt: '2026-05-05T01:00:30.000Z',
      currentStep: 4,
      maxSteps: 20,
    },
    now: Date.parse('2026-05-05T01:01:05.000Z'),
  });

  assert.equal(hydrated.hydrating, false);
  assert.equal(hydrated.isRunning, false);
  assert.equal(hydrated.runId, null);
  assert.equal(hydrated.lastActivityAt, Date.parse('2026-05-05T01:01:00.000Z'));
  assert.deepEqual(hydrated.ignoredRunIds, ['run-complete']);
}

function testActiveRunHydrationFiltersIgnoredRunBeforeDetailProjection(): void {
  const runtime = finalizeRuntimeAfterComplete(
    {
      ...createRuntimeState(),
      runId: 'run-complete',
      isRunning: true,
    },
    'run-complete',
    Date.parse('2026-05-05T01:01:00.000Z')
  );
  const staleActiveRun = {
    runId: 'run-complete',
    context: { scope: 'session' as const, namespace: 'sess-active' },
    startedAt: '2026-05-05T01:00:00.000Z',
    lastActivityAt: '2026-05-05T01:00:30.000Z',
  };

  assert.equal(resolveActiveRunForHydration(runtime, staleActiveRun), null);
  assert.equal(resolveActiveRunForHydration(createRuntimeState(), staleActiveRun), staleActiveRun);
}

function testIgnoredActiveRunDetailHydrationPreservesNewerCurrentRun(): void {
  const current = {
    ...createRuntimeState(),
    runId: 'run-new',
    ignoredRunIds: ['run-old'],
    isRunning: true,
  };
  const rawActiveRun = {
    runId: 'run-old',
    context: { scope: 'session' as const, namespace: 'sess-active' },
    startedAt: '2026-05-05T01:00:00.000Z',
    lastActivityAt: '2026-05-05T01:00:30.000Z',
  };

  assert.equal(
    shouldPreserveCurrentRunForIgnoredActiveRunHydration({
      runtime: current,
      rawActiveRun,
      activeRunForHydration: resolveActiveRunForHydration(current, rawActiveRun),
      pendingPlanInput: null,
    }),
    true
  );
  assert.equal(
    shouldPreserveCurrentRunForIgnoredActiveRunHydration({
      runtime: current,
      rawActiveRun,
      activeRunForHydration: resolveActiveRunForHydration(current, rawActiveRun),
      pendingPlanInput: { runId: 'run-old' },
    }),
    false
  );
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
    runningInputQueue: [
      {
        id: 'queued-1',
        runId: 'run-active',
        context: { scope: 'session' as const, namespace: 'sess-1' },
        prompt: 'next question',
        createdAt: '2026-05-06T10:00:00.000Z',
        updatedAt: '2026-05-06T10:00:00.000Z',
        status: 'queued_next' as const,
      },
    ],
    interruptedArtifact: {
      artifactId: 'artifact-1',
      context: { scope: 'session', namespace: 'sess-1' },
      draftId: 'draft-1',
      turnId: 'turn-1',
      runId: 'run-1',
      runFamilyId: 'family-1',
      terminalCode: 'error',
      replayCutoffKind: 'checkpoint',
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
  assert.deepEqual(
    next.runningInputQueue.map((item) => item.id),
    ['queued-1']
  );
  assert.deepEqual(next.ignoredRunIds, ['run-active']);
}

function testRecoverableConflictErrorClearsRunningStateWithoutRuntimeError(): void {
  const runtime = {
    ...createRuntimeState(),
    runId: 'run-conflict',
    isRunning: true,
    cancelInitiated: true,
    cancelAcknowledged: false,
    cancelRequestedAt: 900,
    contextPrecompressActive: true,
    compressionStatus: {
      source: 'in_turn_precompress' as const,
      phase: 'running' as const,
      observedAt: '2026-05-03T10:00:00.000Z',
      progressPercent: 60,
    },
    liveEvents: [
      {
        id: 'evt-thinking',
        type: 'thinking' as const,
        thinking: 'working',
        isStreaming: true,
        timestamp: 900,
      },
    ],
    currentLlmRuntime: {
      profileId: 'default',
      provider: 'openai' as const,
      model: 'gpt-4.1-mini',
      reasoningPreset: 'medium' as const,
    },
  };

  const next = finalizeRuntimeAfterRecoverableConflictError(runtime, 'run-conflict', 1_000);

  assert.equal(next.runId, null);
  assert.equal(next.isRunning, false);
  assert.equal(next.cancelInitiated, false);
  assert.equal(next.cancelAcknowledged, true);
  assert.equal(next.cancelRequestedAt, 0);
  assert.equal(next.contextPrecompressActive, false);
  assert.equal(next.compressionStatus, null);
  assert.equal(next.error, null);
  assert.equal(next.currentLlmRuntime, null);
  assert.equal(next.lastActivityAt, 1_000);
  assert.deepEqual(next.ignoredRunIds, ['run-conflict']);
  assert.equal(next.liveEvents[0]?.type, 'thinking');
  assert.equal(next.liveEvents[0]?.isStreaming, false);
  assert.equal(finalizeRuntimeAfterRecoverableConflictError(runtime, 'run-stale', 1_000), runtime);
}

function testRemoveRunningInputQueueItemOptimisticallyHidesTarget(): void {
  const runtime = {
    ...createRuntimeState(),
    runningInputQueue: [
      {
        id: 'queued-1',
        runId: 'run-active',
        context: { scope: 'session' as const, namespace: 'sess-1' },
        prompt: 'first',
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:00.000Z',
        status: 'queued_next' as const,
      },
      {
        id: 'queued-2',
        runId: 'run-active',
        context: { scope: 'session' as const, namespace: 'sess-1' },
        prompt: 'second',
        createdAt: '2026-05-06T00:00:01.000Z',
        updatedAt: '2026-05-06T00:00:01.000Z',
        status: 'queued_next' as const,
      },
    ],
  };

  const next = removeRunningInputQueueItem(runtime, 'queued-1');
  assert.deepEqual(
    next.runningInputQueue.map((item) => item.id),
    ['queued-2']
  );
  assert.equal(removeRunningInputQueueItem(next, 'missing'), next);
}

function testHydrationSuppressesInterruptedArtifactDuringNextRun(): void {
  const artifact = {
    artifactId: 'artifact-1',
    context: { scope: 'session' as const, namespace: 'sess-1' },
    draftId: 'draft-1',
    turnId: 'turn-1',
    runId: 'run-canceled',
    runFamilyId: 'family-1',
    terminalCode: 'cancelled' as const,
    replayCutoffKind: 'checkpoint' as const,
    lastSafeStep: 12,
    maxSteps: 40,
    createdAt: '2026-04-26T10:00:00.000Z',
    updatedAt: '2026-04-26T10:00:00.000Z',
    previewMessages: [],
    sideEffectLedger: [],
  };
  const idleRuntime = createRuntimeState();
  const pendingRuntime = createPendingRunRuntimeState(idleRuntime, 1_000);

  assert.equal(
    resolveInterruptedArtifactForHydration({
      interruptedArtifact: artifact,
      currentRuntime: idleRuntime,
      activeRun: null,
      pendingPlanInput: null,
    }),
    artifact
  );
  assert.equal(
    resolveInterruptedArtifactForHydration({
      interruptedArtifact: artifact,
      currentRuntime: pendingRuntime,
      activeRun: null,
      pendingPlanInput: null,
    }),
    null
  );
  assert.equal(
    resolveInterruptedArtifactForHydration({
      interruptedArtifact: artifact,
      currentRuntime: idleRuntime,
      activeRun: {
        runId: 'run-next',
        context: { scope: 'session', namespace: 'sess-1' },
        startedAt: '2026-04-26T10:01:00.000Z',
      },
      pendingPlanInput: null,
    }),
    null
  );
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

function testActiveRunRejectsIgnoredStaleRunTerminalEvent(): void {
  const runtime = {
    ...createRuntimeState(),
    runId: 'run-active',
    isRunning: true,
    ignoredRunIds: ['run-stale'],
  };

  assert.equal(shouldApplyRunTerminalEvent(runtime, 'run-stale'), false);
  assert.equal(shouldApplyRunTerminalEvent(runtime, 'run-active'), true);
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
  testInteractionLockDiagnosticExplainsStaleRunningState();
  testLlmSelectionLockBlocksHydrationAndCancelingButAllowsActiveRun();
  testHydrationFailureUnlocksNeverHydratedIdleRuntime();
  testCancelAckAcceptsOnlyCurrentCancel();
  testPendingRunRejectsUnboundRunEventsUntilChatStarted();
  testPendingRunStateClearsInterruptedArtifactBeforeNextRun();
  testActiveRunHydrationRefreshesProgressAndWatchdogActivity();
  testActiveRunHydrationDoesNotRegressNewerClientActivity();
  testActiveRunHydrationIgnoresCompletedRunIds();
  testActiveRunHydrationFiltersIgnoredRunBeforeDetailProjection();
  testIgnoredActiveRunDetailHydrationPreservesNewerCurrentRun();
  testCompletedRunClearsInterruptedArtifactAfterSuccessfulRecovery();
  testRecoverableConflictErrorClearsRunningStateWithoutRuntimeError();
  testRemoveRunningInputQueueItemOptimisticallyHidesTarget();
  testHydrationSuppressesInterruptedArtifactDuringNextRun();
  testIdleRuntimeRejectsUnknownRunTerminalEvent();
  testActiveRunRejectsIgnoredStaleRunTerminalEvent();
  testContextPrecompressPayloadUpdatesUtilization();
  console.log('web-runtime-watchdog tests passed');
}

runAll();
