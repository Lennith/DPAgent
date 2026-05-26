import * as assert from 'node:assert/strict';
import {
  clearFetchedPlanningState,
  hydrateRuntimeFromSessionDetail,
  hydrateSessionListRuntimeMap,
  mergeFetchedSessionsWithLocalDrafts,
} from '../../src/web/client/hooks/session-controller-hydration.js';
import { createRuntimeState, type RuntimeMap, type SessionDetail, type SessionInfo } from '../../src/web/client/app-shell-types.js';

function testSessionListHydrationFinalizesStaleRunsAndHydratesActiveRuns(): void {
  const staleRuntime = {
    ...createRuntimeState(),
    isRunning: true,
    runId: 'run-stale',
    lastActivityAt: 1000,
  };
  const sessions: SessionInfo[] = [
    {
      id: 'sess-active',
      name: 'Active',
      activeRun: {
        runId: 'run-active',
        context: { scope: 'session', namespace: 'sess-active' },
        startedAt: '2026-05-17T00:00:00.000Z',
      },
    },
  ];
  const result = hydrateSessionListRuntimeMap({
    runtimeBySession: { 'sess-stale': staleRuntime },
    sessions,
    now: () => 2000,
  });
  assert.deepEqual(result.staleRuns, [
    {
      sessionId: 'sess-stale',
      runId: 'run-stale',
      isRunning: true,
      hydrating: false,
      lastActivityAt: 1000,
    },
  ]);
  assert.equal(result.runtimeBySession['sess-stale']?.isRunning, false);
  assert.equal(result.runtimeBySession['sess-active']?.runId, 'run-active');
  assert.equal(result.runtimeBySession['sess-active']?.isRunning, true);
}

function testMergeFetchedSessionsRetainsOnlyUsefulDrafts(): void {
  const previousSessions: SessionInfo[] = [
    { id: 'draft-keep-message', name: 'Draft A', isLocalDraft: true, updatedAt: '2026-05-17T00:00:00.000Z' },
    { id: 'draft-drop', name: 'Draft B', isLocalDraft: true, updatedAt: '2026-05-16T00:00:00.000Z' },
  ];
  const fetchedSessions: SessionInfo[] = [
    { id: 'persisted', name: 'Persisted', updatedAt: '2026-05-18T00:00:00.000Z' },
  ];
  const merged = mergeFetchedSessionsWithLocalDrafts({
    previousSessions,
    fetchedSessions,
    hasLocalMessages: (sessionId) => sessionId === 'draft-keep-message',
    isSessionRunning: () => false,
    currentSessionId: null,
  });
  assert.deepEqual(merged.map((session) => session.id), ['persisted', 'draft-keep-message']);
}

function testClearFetchedPlanningStateUsesPredicate(): void {
  const sessions: SessionInfo[] = [
    { id: 'normal', name: 'Normal', planningState: { state: 'normal' } },
    { id: 'drafting', name: 'Drafting', planningState: { state: 'plan_drafting' } },
  ];
  assert.deepEqual(
    clearFetchedPlanningState({ normal: true, drafting: true, other: true }, sessions, (session) =>
      Boolean(session.planningState?.state && session.planningState.state !== 'normal')
    ),
    { normal: true, other: true }
  );
}

function testHydrateRuntimeFromSessionDetailRestoresPendingPlanInput(): void {
  const session: SessionDetail = {
    id: 'sess-plan',
    pendingPlanInput: {
      runId: 'run-plan',
      requestId: 'req-plan',
      requestedAt: '2026-05-17T00:00:01.000Z',
      questions: [],
      lastError: 'needs answer',
    },
    messages: [],
  };
  const runtime = hydrateRuntimeFromSessionDetail({
    sessionId: 'sess-plan',
    session,
    currentRuntime: createRuntimeState(),
    now: () => 9999,
  });
  assert.equal(runtime.runId, 'run-plan');
  assert.equal(runtime.isRunning, true);
  assert.equal(runtime.pendingPlanInput?.requestId, 'req-plan');
  assert.equal(runtime.pendingPlanInputError, 'needs answer');
  assert.equal(runtime.runStartedAt, Date.parse('2026-05-17T00:00:01.000Z'));
}

function testHydrateRuntimeFromSessionDetailPreservesIgnoredCurrentRun(): void {
  const current = {
    ...createRuntimeState(),
    ignoredRunIds: ['run-ignored'],
    isRunning: false,
    runId: null,
  };
  const session: SessionDetail = {
    id: 'sess-ignored',
    activeRun: {
      runId: 'run-ignored',
      context: { scope: 'session', namespace: 'sess-ignored' },
      startedAt: '2026-05-17T00:00:00.000Z',
    },
    messages: [],
  };
  const runtime = hydrateRuntimeFromSessionDetail({
    sessionId: 'sess-ignored',
    session,
    currentRuntime: current,
  });
  assert.equal(runtime.isRunning, false);
  assert.equal(runtime.hasHydrated, true);
  assert.deepEqual(runtime.ignoredRunIds, ['run-ignored']);
}

testSessionListHydrationFinalizesStaleRunsAndHydratesActiveRuns();
testMergeFetchedSessionsRetainsOnlyUsefulDrafts();
testClearFetchedPlanningStateUsesPredicate();
testHydrateRuntimeFromSessionDetailRestoresPendingPlanInput();
testHydrateRuntimeFromSessionDetailPreservesIgnoredCurrentRun();

console.log('session-controller-hydration tests passed');
