import { COMPOSER_DRAFT_KEY, resolveComposerInputKey } from '../composer-input-state.js';
import type { Message } from '../chat-types.js';
import {
  createRuntimeState,
  type MessageMap,
  type PendingPlanInputSessionItem,
  type RuntimeMap,
  type SessionInfo,
  type SessionPlanningState,
  type SessionRuntimeState,
} from '../app-shell-types.js';

export function timestampFromServerCreatedAt(createdAt: unknown, fallback = Date.now()): number {
  const parsed = Date.parse(String(createdAt ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveCurrentMessages(
  currentSessionId: string | null,
  messagesBySession: MessageMap
): Message[] {
  if (!currentSessionId) {
    return [];
  }
  return messagesBySession[currentSessionId] ?? [];
}

export function resolveCurrentRuntime(
  currentSessionId: string | null,
  runtimeBySession: RuntimeMap
): SessionRuntimeState {
  if (!currentSessionId) {
    return createRuntimeState();
  }
  return runtimeBySession[currentSessionId] ?? createRuntimeState();
}

export function resolveCurrentPlanningState({
  currentSessionId,
  optimisticPlanningStateBySession,
  sessions,
}: {
  currentSessionId: string | null;
  optimisticPlanningStateBySession: Record<string, SessionPlanningState>;
  sessions: SessionInfo[];
}): SessionPlanningState {
  const key = currentSessionId ?? COMPOSER_DRAFT_KEY;
  const optimisticState = optimisticPlanningStateBySession[key];
  if (optimisticState) {
    return optimisticState;
  }
  if (currentSessionId) {
    const session = sessions.find((item) => item.id === currentSessionId);
    if (session?.planningState?.state) {
      return session.planningState.state;
    }
  }
  return 'normal';
}

export function resolveCurrentPlanModeIntent(
  currentSessionId: string | null,
  planModeIntentBySession: Record<string, boolean>
): boolean {
  const key = currentSessionId ?? COMPOSER_DRAFT_KEY;
  return planModeIntentBySession[key] === true;
}

export function clearPlanModeIntentState(
  state: Record<string, boolean>,
  sessionId: string | null | undefined
): Record<string, boolean> {
  const key = resolveComposerInputKey(sessionId);
  if (!state[key]) {
    return state;
  }
  const next = { ...state };
  delete next[key];
  return next;
}

export function setPlanModeIntentState({
  state,
  sessionId,
  enabled,
}: {
  state: Record<string, boolean>;
  sessionId: string | null | undefined;
  enabled: boolean;
}): Record<string, boolean> {
  if (!enabled) {
    return clearPlanModeIntentState(state, sessionId);
  }
  const key = resolveComposerInputKey(sessionId);
  return {
    ...state,
    [key]: true,
  };
}

export function resolveRunningSessionIds(runtimeBySession: RuntimeMap): string[] {
  return Object.entries(runtimeBySession)
    .filter(([, runtime]) => runtime.isRunning)
    .map(([sessionId]) => sessionId);
}

export function resolvePendingPlanInputSessions(
  runtimeBySession: RuntimeMap,
  sessions: SessionInfo[]
): PendingPlanInputSessionItem[] {
  const sessionNameById = new Map(sessions.map((session) => [session.id, session.name]));
  const seen = new Set<string>();
  const items: PendingPlanInputSessionItem[] = [];
  for (const [sessionId, runtime] of Object.entries(runtimeBySession)) {
    if (!runtime.pendingPlanInput || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    items.push({
      sessionId,
      sessionName: sessionNameById.get(sessionId) ?? sessionId,
      requestId: runtime.pendingPlanInput.requestId,
    });
  }
  return items;
}

export function resolvePendingPlanInputSessionIds(
  pendingPlanInputSessions: PendingPlanInputSessionItem[]
): string[] {
  return pendingPlanInputSessions.map((item) => item.sessionId);
}
