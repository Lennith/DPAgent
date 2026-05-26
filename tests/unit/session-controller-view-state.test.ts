import * as assert from 'node:assert/strict';
import {
  clearPlanModeIntentState,
  resolveCurrentMessages,
  resolveCurrentPlanModeIntent,
  resolveCurrentPlanningState,
  resolveCurrentRuntime,
  resolvePendingPlanInputSessionIds,
  resolvePendingPlanInputSessions,
  resolveRunningSessionIds,
  setPlanModeIntentState,
  timestampFromServerCreatedAt,
} from '../../src/web/client/hooks/session-controller-view-state.js';
import { COMPOSER_DRAFT_KEY } from '../../src/web/client/composer-input-state.js';
import { createRuntimeState, type RuntimeMap, type SessionInfo } from '../../src/web/client/app-shell-types.js';
import type { MessageMap } from '../../src/web/client/app-shell-types.js';

function testTimestampFromServerCreatedAtUsesFallbackForInvalidInput(): void {
  assert.equal(timestampFromServerCreatedAt('2026-05-17T01:02:03.000Z'), Date.parse('2026-05-17T01:02:03.000Z'));
  assert.equal(timestampFromServerCreatedAt('not-a-date', 1234), 1234);
  assert.equal(timestampFromServerCreatedAt(undefined, 5678), 5678);
}

function testCurrentMessagesAndRuntimeUseCurrentSessionOnly(): void {
  const messagesBySession: MessageMap = {
    'sess-a': [{ id: 'm1', role: 'user', content: 'A', timestamp: 1 }],
    'sess-b': [{ id: 'm2', role: 'assistant', content: 'B', timestamp: 2 }],
  };
  assert.deepEqual(resolveCurrentMessages(null, messagesBySession), []);
  assert.equal(resolveCurrentMessages('sess-a', messagesBySession)[0]?.content, 'A');

  const runningRuntime = { ...createRuntimeState(), isRunning: true, runId: 'run-a' };
  assert.equal(resolveCurrentRuntime(null, { 'sess-a': runningRuntime }).isRunning, false);
  assert.equal(resolveCurrentRuntime('sess-a', { 'sess-a': runningRuntime }).runId, 'run-a');
}

function testPlanningStatePrefersOptimisticThenPersistedThenNormal(): void {
  const sessions: SessionInfo[] = [
    { id: 'sess-a', name: 'A', planningState: { state: 'plan_executing' } },
  ];
  assert.equal(
    resolveCurrentPlanningState({
      currentSessionId: 'sess-a',
      optimisticPlanningStateBySession: { 'sess-a': 'plan_drafting' },
      sessions,
    }),
    'plan_drafting'
  );
  assert.equal(
    resolveCurrentPlanningState({
      currentSessionId: 'sess-a',
      optimisticPlanningStateBySession: {},
      sessions,
    }),
    'plan_executing'
  );
  assert.equal(
    resolveCurrentPlanningState({
      currentSessionId: null,
      optimisticPlanningStateBySession: {},
      sessions,
    }),
    'normal'
  );
}

function testPlanModeIntentHelpersUseDraftKeyForMissingSession(): void {
  let state: Record<string, boolean> = {};
  state = setPlanModeIntentState({ state, sessionId: null, enabled: true });
  assert.equal(state[COMPOSER_DRAFT_KEY], true);
  assert.equal(resolveCurrentPlanModeIntent(null, state), true);

  const empty: Record<string, boolean> = {};
  const same = clearPlanModeIntentState(empty, 'missing');
  assert.strictEqual(same, empty);

  state = clearPlanModeIntentState(state, undefined);
  assert.equal(resolveCurrentPlanModeIntent(null, state), false);
}

function testRunningAndPendingPlanInputSelectors(): void {
  const runtimeBySession: RuntimeMap = {
    'sess-a': {
      ...createRuntimeState(),
      isRunning: true,
      pendingPlanInput: {
        runId: 'run-a',
        context: { scope: 'session', namespace: 'sess-a' },
        requestId: 'req-a',
        questions: [],
      },
    },
    'sess-b': {
      ...createRuntimeState(),
      isRunning: false,
      pendingPlanInput: {
        runId: 'run-b',
        context: { scope: 'session', namespace: 'sess-b' },
        requestId: 'req-b',
        questions: [],
      },
    },
  };
  const sessions: SessionInfo[] = [{ id: 'sess-a', name: 'Session A' }];
  assert.deepEqual(resolveRunningSessionIds(runtimeBySession), ['sess-a']);

  const pending = resolvePendingPlanInputSessions(runtimeBySession, sessions);
  assert.deepEqual(pending, [
    { sessionId: 'sess-a', sessionName: 'Session A', requestId: 'req-a' },
    { sessionId: 'sess-b', sessionName: 'sess-b', requestId: 'req-b' },
  ]);
  assert.deepEqual(resolvePendingPlanInputSessionIds(pending), ['sess-a', 'sess-b']);
}

testTimestampFromServerCreatedAtUsesFallbackForInvalidInput();
testCurrentMessagesAndRuntimeUseCurrentSessionOnly();
testPlanningStatePrefersOptimisticThenPersistedThenNormal();
testPlanModeIntentHelpersUseDraftKeyForMissingSession();
testRunningAndPendingPlanInputSelectors();

console.log('session-controller-view-state tests passed');
