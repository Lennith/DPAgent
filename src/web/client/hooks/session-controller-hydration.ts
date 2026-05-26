import {
  createRuntimeState,
  finalizeRuntimeAfterComplete,
  getSessionSortTimestamp,
  hydrateRuntimeFromActiveRun,
  resolveActiveRunForHydration,
  resolveInterruptedArtifactForHydration,
  restorePendingPlanInputPayload,
  shouldPreserveCurrentRunForIgnoredActiveRunHydration,
  type ActiveRunView,
  type InterruptedArtifactView,
  type RuntimeMap,
  type SessionDetail,
  type SessionInfo,
  type SessionRuntimeState,
} from '../app-shell-types.js';

export interface StaleHydratedRun {
  sessionId: string;
  runId: string | null;
  isRunning: boolean;
  hydrating: boolean;
  lastActivityAt: number;
}

export function hydrateSessionListRuntimeMap(input: {
  runtimeBySession: RuntimeMap;
  sessions: SessionInfo[];
  now?: () => number;
}): { runtimeBySession: RuntimeMap; staleRuns: StaleHydratedRun[] } {
  const next = { ...input.runtimeBySession };
  const staleRuns: StaleHydratedRun[] = [];
  const activeRunBySession = new Map(
    input.sessions
      .filter((session) => session.activeRun)
      .map((session) => [session.id, session.activeRun])
  );
  const now = input.now ?? Date.now;
  for (const [sessionId, runtime] of Object.entries(next)) {
    if (!runtime.isRunning || activeRunBySession.has(sessionId)) {
      continue;
    }
    staleRuns.push({
      sessionId,
      runId: runtime.runId,
      isRunning: runtime.isRunning,
      hydrating: runtime.hydrating,
      lastActivityAt: runtime.lastActivityAt,
    });
    next[sessionId] = finalizeRuntimeAfterComplete(runtime, runtime.runId ?? `finished-${sessionId}`, now());
  }
  for (const session of input.sessions) {
    if (!session.activeRun) {
      continue;
    }
    const current = next[session.id] ?? createRuntimeState();
    next[session.id] = hydrateRuntimeFromActiveRun({
      runtime: current,
      activeRun: session.activeRun,
      interactionState: session.interactionState,
    });
  }
  return {
    runtimeBySession: next,
    staleRuns,
  };
}

export function mergeFetchedSessionsWithLocalDrafts(input: {
  previousSessions: SessionInfo[];
  fetchedSessions: SessionInfo[];
  hasLocalMessages: (sessionId: string) => boolean;
  isSessionRunning: (sessionId: string) => boolean;
  currentSessionId: string | null;
}): SessionInfo[] {
  const fetchedIds = new Set(input.fetchedSessions.map((session) => session.id));
  const retainedDrafts = input.previousSessions.filter((session) => {
    if (!session.isLocalDraft || fetchedIds.has(session.id)) {
      return false;
    }
    return (
      input.hasLocalMessages(session.id) ||
      input.isSessionRunning(session.id) ||
      input.currentSessionId === session.id
    );
  });
  const merged = [...input.fetchedSessions, ...retainedDrafts];
  merged.sort((left, right) => getSessionSortTimestamp(right) - getSessionSortTimestamp(left));
  return merged;
}

export function clearFetchedPlanningState<T>(
  state: Record<string, T>,
  sessions: SessionInfo[],
  shouldClear: (session: SessionInfo) => boolean
): Record<string, T> {
  const next = { ...state };
  for (const session of sessions) {
    if (shouldClear(session)) {
      delete next[session.id];
    }
  }
  return next;
}

export function hydrateRuntimeFromSessionDetail(input: {
  sessionId: string;
  session: SessionDetail;
  currentRuntime?: SessionRuntimeState;
  now?: () => number;
}): SessionRuntimeState {
  const current = input.currentRuntime ?? createRuntimeState();
  const now = input.now ?? Date.now;
  const activeRun = (input.session.activeRun ?? null) as ActiveRunView | null;
  const interruptedArtifact = (input.session.interruptedArtifact ?? null) as InterruptedArtifactView | null;
  const pendingPlanInput = restorePendingPlanInputPayload(input.sessionId, input.session.pendingPlanInput ?? null);
  const requestedAtMs = Date.parse(String(input.session.pendingPlanInput?.requestedAt ?? ''));
  const activeRunStartedAtMs = Date.parse(String(activeRun?.startedAt ?? ''));
  const activeRunForHydration = resolveActiveRunForHydration(current, activeRun);
  if (
    shouldPreserveCurrentRunForIgnoredActiveRunHydration({
      runtime: current,
      rawActiveRun: activeRun,
      activeRunForHydration,
      pendingPlanInput,
    })
  ) {
    return {
      ...current,
      hasHydrated: true,
      hydrating: false,
      error: null,
    };
  }
  const hydratedInterruptedArtifact = resolveInterruptedArtifactForHydration({
    interruptedArtifact,
    currentRuntime: current,
    activeRun: activeRunForHydration,
    pendingPlanInput,
  });
  const startedAtMs =
    pendingPlanInput
      ? Number.isFinite(requestedAtMs)
        ? requestedAtMs
        : now()
      : activeRunForHydration && Number.isFinite(activeRunStartedAtMs)
        ? activeRunStartedAtMs
        : 0;
  const baseRuntime: SessionRuntimeState = {
    ...current,
    hasHydrated: true,
    hydrating: false,
    runId: pendingPlanInput?.runId ?? activeRunForHydration?.runId ?? null,
    isRunning: pendingPlanInput !== null || activeRunForHydration !== null,
    runStartedAt: startedAtMs > 0 ? startedAtMs : 0,
    lastActivityAt: current.lastActivityAt || (startedAtMs > 0 ? startedAtMs : now()),
    cancelInitiated: false,
    cancelAcknowledged: false,
    cancelRequestedAt: 0,
    contextPrecompressActive: false,
    compressionStatus: null,
    pendingPlanInput,
    pendingPlanInputError: input.session.pendingPlanInput?.lastError ?? null,
    currentLlmRuntime: activeRunForHydration?.llmRuntime ?? null,
    activeRunOwner: activeRunForHydration?.owner ?? null,
    interactionState: activeRunForHydration?.interactionState ?? input.session.interactionState ?? { mode: 'normal' },
    interruptedArtifact: hydratedInterruptedArtifact,
    error: null,
  };
  if (!activeRunForHydration || pendingPlanInput) {
    return baseRuntime;
  }
  return {
    ...hydrateRuntimeFromActiveRun({
      runtime: current,
      activeRun: activeRunForHydration,
      interactionState: input.session.interactionState,
    }),
    cancelInitiated: false,
    cancelAcknowledged: false,
    cancelRequestedAt: 0,
    contextPrecompressActive: false,
    compressionStatus: null,
    pendingPlanInput: null,
    pendingPlanInputError: input.session.pendingPlanInput?.lastError ?? null,
    error: null,
  };
}
