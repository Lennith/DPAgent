import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  clearComposerInput,
  COMPOSER_DRAFT_KEY,
  getComposerInput,
  removeComposerInput,
  setComposerInput,
  type ComposerInputBySession,
} from '../composer-input-state.js';
import { evaluateRuntimeWatchdog } from '../runtime-watchdog.js';
import { normalizeMcpStatus, type MCPStatusView } from '../mcp-status.js';
import type { Message, ToolResult } from './useAgent.js';
import type { WSMessage } from './useWebSocket.js';
import type {
  ActiveRunView,
  ChatStartedEvent,
  ContextRef,
  ContextUtilizationMap,
  InterruptedArtifactView,
  LlmProfilesConfigView,
  MessageMap,
  PendingPlanInputSessionItem,
  PlanInputAnswerPayload,
  PlanInputRequestPayload,
  RunLlmRuntimeView,
  RuntimeCompressionStatus,
  RunTerminalStateView,
  RuntimeMap,
  SessionDetail,
  SessionInfo,
  SessionLlmSelectionPatch,
  SessionLlmSelectionView,
} from '../app-shell-types.js';
import {
  addIgnoredRunId,
  appendLiveTextDelta,
  closeStreamingThinking,
  contextUtilizationFromPrecompressPayload,
  createClientSessionId,
  createMessageId,
  createPendingRunRuntimeState,
  createRuntimeState,
  deriveSessionNameFromPrompt,
  finalizeRuntimeAfterComplete,
  finishRuntimeHydrationAfterLoadFailure,
  getSessionSortTimestamp,
  inferToolResultSuccess,
  isRuntimeInteractionLocked,
  isRuntimeLlmSelectionLocked,
  observeRunEvent,
  restorePendingPlanInputPayload,
  shouldApplyCancelAck,
  shouldApplyContextPrecompressEvent,
  shouldApplyRunEvent,
  shouldApplyRunTerminalEvent,
  upsertToolCallState,
  toSessionId,
  truncateLiveSummary,
  upsertRunStatusEvent,
  upsertSessionToFront,
} from '../app-shell-types.js';
import {
  applySessionLlmSelectionPatch,
  createNextSessionLlmSelectionUpdatedAt,
  resolveSessionLlmSelectionView,
} from '../llm-session-state.js';

interface UseAppSessionControllerOptions {
  currentSessionId: string | null;
  setCurrentSessionId: Dispatch<SetStateAction<string | null>>;
  setActiveView: Dispatch<SetStateAction<'chat' | 'automations'>>;
  workspaceDir: string;
  defaultWorkspaceDir: string;
  setWorkspaceDir: Dispatch<SetStateAction<string>>;
  llmProfiles: LlmProfilesConfigView | null;
  send: (message: WSMessage) => boolean;
  connect: () => void;
  subscribe: (type: string, listener: (data: unknown) => void) => () => void;
  addToast: (toast: {
    type: 'info' | 'warning' | 'error' | 'success';
    message: string;
    autoDismiss: boolean;
  }) => string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onRefreshGovernance: (sessionId: string | null) => void | Promise<void>;
}

const LAST_SESSION_STORAGE_KEY = 'minimax-ui-last-session-id';

function loadLastSessionIdFromStorage(): string | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const stored = String(localStorage.getItem(LAST_SESSION_STORAGE_KEY) ?? '').trim();
    return stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

function saveLastSessionIdToStorage(sessionId: string | null): void {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    const normalized = String(sessionId ?? '').trim();
    if (!normalized) {
      localStorage.removeItem(LAST_SESSION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(LAST_SESSION_STORAGE_KEY, normalized);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

export function normalizeThinkingDeltaForDisplay(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

export function normalizeTextDeltaForDisplay(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

export function useAppSessionController({
  currentSessionId,
  setCurrentSessionId,
  setActiveView,
  workspaceDir,
  defaultWorkspaceDir,
  setWorkspaceDir,
  llmProfiles,
  send,
  connect,
  subscribe,
  addToast,
  t,
  onRefreshGovernance,
}: UseAppSessionControllerOptions) {
  const [composerInputBySession, setComposerInputBySession] = useState<ComposerInputBySession>({});
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [mcpStatus, setMcpStatus] = useState<MCPStatusView | null>(null);
  const [contextUtilization, setContextUtilization] = useState<ContextUtilizationMap>({});
  const [messagesBySession, setMessagesBySession] = useState<MessageMap>({});
  const [runtimeBySession, setRuntimeBySession] = useState<RuntimeMap>({});
  const [sessionLlmSelectionBySession, setSessionLlmSelectionBySession] = useState<
    Record<string, SessionLlmSelectionView>
  >({});

  const runtimeBySessionRef = useRef<RuntimeMap>({});
  const messagesBySessionRef = useRef<MessageMap>({});
  const watchdogWarningBucketRef = useRef<Record<string, number>>({});
  const currentSessionIdRef = useRef<string | null>(null);
  const llmSelectionSeqRef = useRef<Record<string, number>>({});
  const reconnectRetryTimeoutsRef = useRef<Set<number>>(new Set());
  const hasAttemptedSessionRestoreRef = useRef(false);

  const activeComposerInput = useMemo(
    () => getComposerInput(composerInputBySession, currentSessionId),
    [composerInputBySession, currentSessionId]
  );

  const setActiveComposerInput = useCallback(
    (value: string) => {
      setComposerInputBySession((prev) => setComposerInput(prev, currentSessionId, value));
    },
    [currentSessionId]
  );

  const clearComposerInputForSession = useCallback((sessionId: string | null | undefined) => {
    setComposerInputBySession((prev) => clearComposerInput(prev, sessionId));
  }, []);

  const removeComposerInputForSession = useCallback((sessionId: string | null | undefined) => {
    setComposerInputBySession((prev) => removeComposerInput(prev, sessionId));
  }, []);

  const sendWithReconnectRetry = useCallback(
    (message: WSMessage, onFinalFailure: () => void): void => {
      if (send(message)) {
        return;
      }
      connect();
      const timeoutId = window.setTimeout(() => {
        reconnectRetryTimeoutsRef.current.delete(timeoutId);
        if (!send(message)) {
          onFinalFailure();
        }
      }, 350);
      reconnectRetryTimeoutsRef.current.add(timeoutId);
    },
    [connect, send]
  );

  useEffect(() => {
    return () => {
      reconnectRetryTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      reconnectRetryTimeoutsRef.current.clear();
    };
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const response = await fetch('/api/sessions');
      const data = (await response.json()) as { sessions: SessionInfo[] };
      const fetchedSessions = (data.sessions || []).map((session) => ({
        ...session,
        isLocalDraft: false,
      }));
      setSessionLlmSelectionBySession((prev) => {
        const next = { ...prev };
        for (const session of fetchedSessions) {
          next[session.id] = resolveSessionLlmSelectionView(llmProfiles, session.llmSelection);
        }
        return next;
      });
      setSessions((prev) => {
        const fetchedIds = new Set(fetchedSessions.map((session) => session.id));
        const retainedDrafts = prev.filter((session) => {
          if (!session.isLocalDraft || fetchedIds.has(session.id)) {
            return false;
          }
          const hasLocalMessages = (messagesBySessionRef.current[session.id] ?? []).length > 0;
          const isRunning = runtimeBySessionRef.current[session.id]?.isRunning === true;
          return hasLocalMessages || isRunning || currentSessionIdRef.current === session.id;
        });
        const merged = [...fetchedSessions, ...retainedDrafts];
        merged.sort((left, right) => getSessionSortTimestamp(right) - getSessionSortTimestamp(left));
        return merged;
      });
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    }
  }, [llmProfiles]);

  const fetchMcpStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/mcp/status');
      if (!response.ok) {
        throw new Error(`status=${response.status}`);
      }
      const data = await response.json();
      setMcpStatus(normalizeMcpStatus(data));
    } catch (error) {
      console.error('Failed to fetch MCP status:', error);
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    void fetchMcpStatus();
    const timer = window.setInterval(() => {
      void fetchMcpStatus();
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [fetchMcpStatus]);

  const updateRuntime = useCallback((sessionId: string, updater: (state: RuntimeMap[string]) => RuntimeMap[string]) => {
    setRuntimeBySession((prev) => {
      const current = prev[sessionId] ?? createRuntimeState();
      return {
        ...prev,
        [sessionId]: updater(current),
      };
    });
  }, []);

  const currentLlmSelection = useMemo(
    () =>
      resolveSessionLlmSelectionView(
        llmProfiles,
        sessionLlmSelectionBySession[currentSessionId ?? COMPOSER_DRAFT_KEY]
      ),
    [currentSessionId, llmProfiles, sessionLlmSelectionBySession]
  );

  const setCurrentSessionLlmSelection = useCallback(
    (patch: SessionLlmSelectionPatch) => {
      if (currentSessionId && isRuntimeLlmSelectionLocked(runtimeBySession[currentSessionId])) {
        return;
      }
      const sessionKey = currentSessionId ?? COMPOSER_DRAFT_KEY;
      const previousSelection = resolveSessionLlmSelectionView(
        llmProfiles,
        sessionLlmSelectionBySession[sessionKey]
      );
      const nextSelection = applySessionLlmSelectionPatch(llmProfiles, previousSelection, {
        ...patch,
        updatedAt: createNextSessionLlmSelectionUpdatedAt(previousSelection.updatedAt),
      });

      setSessionLlmSelectionBySession((prev) => ({
        ...prev,
        [sessionKey]: nextSelection,
      }));

      if (!currentSessionId) {
        return;
      }

      const nextSeq = (llmSelectionSeqRef.current[currentSessionId] ?? 0) + 1;
      llmSelectionSeqRef.current[currentSessionId] = nextSeq;

      void fetch(`/api/sessions/${currentSessionId}/llm-selection`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(nextSelection),
      })
        .then(async (response) => {
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string;
            llmSelection?: SessionLlmSelectionView;
          };
          if (!response.ok) {
            throw Object.assign(new Error(payload.error || `status=${response.status}`), {
              llmSelection: payload.llmSelection,
            });
          }
          return payload;
        })
        .then((payload) => {
          if (llmSelectionSeqRef.current[currentSessionId] !== nextSeq) {
            return;
          }
          setSessionLlmSelectionBySession((prev) => ({
            ...prev,
            [currentSessionId]: resolveSessionLlmSelectionView(llmProfiles, payload.llmSelection ?? nextSelection),
          }));
          setSessions((prev) =>
            prev.map((session) =>
              session.id === currentSessionId
                ? {
                    ...session,
                    llmSelection: resolveSessionLlmSelectionView(llmProfiles, payload.llmSelection ?? nextSelection),
                  }
                : session
            )
          );
        })
        .catch((error) => {
          if (llmSelectionSeqRef.current[currentSessionId] !== nextSeq) {
            return;
          }
          const rollbackSelection = resolveSessionLlmSelectionView(
            llmProfiles,
            (error as { llmSelection?: SessionLlmSelectionView }).llmSelection ?? previousSelection
          );
          setSessionLlmSelectionBySession((prev) => ({
            ...prev,
            [currentSessionId]: rollbackSelection,
          }));
          setSessions((prev) =>
            prev.map((session) =>
              session.id === currentSessionId
                ? {
                    ...session,
                    llmSelection: rollbackSelection,
                  }
                : session
            )
          );
          addToast({
            type: 'error',
            message: t('app.llm.switchFailed', {
              message: error instanceof Error ? error.message : String(error),
            }),
            autoDismiss: true,
          });
        });
    },
    [addToast, currentSessionId, llmProfiles, runtimeBySession, sessionLlmSelectionBySession, t]
  );

  useEffect(() => {
    runtimeBySessionRef.current = runtimeBySession;
  }, [runtimeBySession]);

  useEffect(() => {
    messagesBySessionRef.current = messagesBySession;
  }, [messagesBySession]);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    if (!currentSessionId) {
      return;
    }
    saveLastSessionIdToStorage(currentSessionId);
  }, [currentSessionId]);

  useEffect(() => {
    setSessionLlmSelectionBySession((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).map(([sessionKey, selection]) => [
          sessionKey,
          resolveSessionLlmSelectionView(llmProfiles, selection),
        ])
      );
      return next;
    });
  }, [llmProfiles]);

  const appendMessage = useCallback((sessionId: string, message: Message) => {
    setMessagesBySession((prev) => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] ?? []), message],
    }));
  }, []);

  const upsertLocalDraftSession = useCallback((sessionId: string, prompt: string, currentWorkspaceDir: string) => {
    const now = new Date().toISOString();
    const derivedName = deriveSessionNameFromPrompt(prompt, sessionId);
    setSessions((prev) => {
      const existing = prev.find((item) => item.id === sessionId);
      if (!existing) {
        return upsertSessionToFront(prev, {
          id: sessionId,
          name: derivedName,
          workspaceDir: currentWorkspaceDir,
          createdAt: now,
          updatedAt: now,
          isLocalDraft: true,
        });
      }
      const next: SessionInfo = {
        ...existing,
        name: existing.name?.trim().length ? existing.name : derivedName,
        workspaceDir: existing.workspaceDir?.trim().length ? existing.workspaceDir : currentWorkspaceDir,
        createdAt: existing.createdAt ?? now,
        updatedAt: now,
      };
      return upsertSessionToFront(prev, next);
    });
  }, []);

  const loadSessionMessages = useCallback(
    async (sessionId: string) => {
      try {
        const response = await fetch(`/api/sessions/${sessionId}`);
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error || response.statusText || `Failed to load session ${sessionId}`);
        }
        const session = (await response.json()) as SessionDetail;
        setSessionLlmSelectionBySession((prev) => ({
          ...prev,
          [sessionId]: resolveSessionLlmSelectionView(llmProfiles, session.llmSelection),
        }));
        if (session.workspaceDir && currentSessionIdRef.current === sessionId) {
          setWorkspaceDir(session.workspaceDir);
        }
        setContextUtilization((prev) => ({
          ...prev,
          [sessionId]: session.contextUtilization
            ? {
                ratio: session.contextUtilization.ratio ?? 0,
                usedChars: session.contextUtilization.usedChars ?? 0,
                limitChars: session.contextUtilization.limitChars ?? 230000,
                isWarning: session.contextUtilization.isWarning === true,
                initializing: false,
              }
            : {
                ratio: 0,
                usedChars: 0,
                limitChars: 230000,
                isWarning: false,
                initializing: true,
              },
        }));
        const sourceMessages = session.messages ?? [];
        const loadedMessages: Message[] = [];
        let renderedIndex = 0;

        for (const msg of sourceMessages) {
          if (msg.role === 'user' || msg.role === 'assistant') {
            loadedMessages.push({
              id: createMessageId(`msg-${sessionId}-${renderedIndex}`),
              role: msg.role,
              content: msg.content,
              timestamp: Date.now() - (sourceMessages.length - renderedIndex) * 1000,
              thinking: msg.thinking,
              metadata: msg.metadata,
              toolCalls: msg.toolCalls?.map((toolCall) => ({
                name: toolCall.function.name,
                args: toolCall.function.arguments,
              })),
              toolResults: [],
            });
            renderedIndex += 1;
            continue;
          }

          if (msg.role === 'tool') {
            const lastMessage = loadedMessages[loadedMessages.length - 1];
            if (lastMessage?.role === 'assistant') {
              lastMessage.toolResults = [
                ...(lastMessage.toolResults ?? []),
                {
                  name: msg.name || 'tool',
                  result: {
                    success: inferToolResultSuccess(msg.content),
                    content: msg.content,
                  },
                },
              ];
            }
          }
        }

        setMessagesBySession((prev) => ({
          ...prev,
          [sessionId]: loadedMessages,
        }));
        const activeRun = (session.activeRun ?? null) as ActiveRunView | null;
        const pendingResume = session.pendingResume === true;
        const interruptedArtifact = (session.interruptedArtifact ?? null) as InterruptedArtifactView | null;
        const restoredPendingPlanInput = restorePendingPlanInputPayload(sessionId, session.pendingPlanInput ?? null);
        const requestedAtMs = Date.parse(String(session.pendingPlanInput?.requestedAt ?? ''));
        const activeRunStartedAtMs = Date.parse(String(activeRun?.startedAt ?? ''));
        setRuntimeBySession((prev) => {
          const current = prev[sessionId] ?? createRuntimeState();
          const sameArtifact = Boolean(
            current.interruptedArtifact?.artifactId &&
              interruptedArtifact?.artifactId &&
              current.interruptedArtifact.artifactId === interruptedArtifact.artifactId
          );
          const keepResumePending =
            (pendingResume && !interruptedArtifact?.dismissedAt) ||
            (current.resumePending &&
              restoredPendingPlanInput === null &&
              activeRun === null &&
              sameArtifact &&
              !interruptedArtifact?.dismissedAt);
          const keepDismissPending =
            current.dismissPending &&
            restoredPendingPlanInput === null &&
            activeRun === null &&
            sameArtifact &&
            !interruptedArtifact?.dismissedAt;
          const startedAtMs =
            restoredPendingPlanInput
              ? Number.isFinite(requestedAtMs)
                ? requestedAtMs
                : Date.now()
              : Number.isFinite(activeRunStartedAtMs)
                ? activeRunStartedAtMs
                : 0;
          return {
            ...prev,
            [sessionId]: {
              ...current,
              hasHydrated: true,
              hydrating: false,
              runId: restoredPendingPlanInput?.runId ?? activeRun?.runId ?? null,
              isRunning: restoredPendingPlanInput !== null || activeRun !== null,
              resumePending: keepResumePending,
              dismissPending: keepDismissPending,
              runStartedAt: startedAtMs > 0 ? startedAtMs : 0,
              lastActivityAt: current.lastActivityAt || (startedAtMs > 0 ? startedAtMs : Date.now()),
              cancelInitiated: false,
              cancelAcknowledged: false,
              cancelRequestedAt: 0,
              contextPrecompressActive: false,
              compressionStatus: null,
              pendingPlanInput: restoredPendingPlanInput,
              pendingPlanInputError: session.pendingPlanInput?.lastError ?? null,
              currentLlmRuntime: activeRun?.llmRuntime ?? null,
              interruptedArtifact,
              error: null,
            },
          };
        });
      } catch (error) {
        console.error('Failed to load session messages:', error);
        setRuntimeBySession((prev) => {
          const current = prev[sessionId];
          if (!current) {
            return prev;
          }
          return {
            ...prev,
            [sessionId]: finishRuntimeHydrationAfterLoadFailure(current, error),
          };
        });
      }
    },
    [llmProfiles, setWorkspaceDir]
  );

  useEffect(() => {
    if (currentSessionId || hasAttemptedSessionRestoreRef.current || sessions.length === 0) {
      return;
    }
    hasAttemptedSessionRestoreRef.current = true;
    const lastSessionId = loadLastSessionIdFromStorage();
    if (!lastSessionId) {
      return;
    }
    if (!sessions.some((session) => session.id === lastSessionId)) {
      saveLastSessionIdToStorage(null);
      return;
    }
    updateRuntime(lastSessionId, (runtime) => ({
      ...runtime,
      hydrating: true,
    }));
    setCurrentSessionId(lastSessionId);
    void loadSessionMessages(lastSessionId);
  }, [currentSessionId, loadSessionMessages, sessions, setCurrentSessionId, updateRuntime]);

  useEffect(() => {
    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(
      subscribe('chat_started', (data: unknown) => {
        const payload = data as ChatStartedEvent;
        const sessionId = toSessionId(payload?.context);
        if (!sessionId || typeof payload?.runId !== 'string') {
          return;
        }
        updateRuntime(sessionId, (runtime) => ({
          runId: payload.runId,
          ignoredRunIds: runtime.ignoredRunIds,
          runStartedAt: Date.now(),
          lastActivityAt: Date.now(),
          hasHydrated: true,
          hydrating: false,
          isRunning: true,
          resumePending: false,
          dismissPending: false,
          cancelInitiated: false,
          cancelAcknowledged: false,
          cancelRequestedAt: 0,
          contextPrecompressActive: false,
          compressionStatus: null,
          forceResetCount: 0,
          currentStep: 0,
          maxSteps: 0,
          liveEvents: [],
          contentAccumulator: '',
          toolCallsAccumulator: [],
          toolResultsAccumulator: [],
          error: null,
          interruptedArtifact: runtime.interruptedArtifact,
          lastTerminalState: null,
          pendingPlanInput: null,
          pendingPlanInputError: null,
          currentLlmRuntime: payload.llmRuntime ?? null,
        }));
        setContextUtilization((prev) => ({
          ...prev,
          [sessionId]: prev[sessionId] ?? {
            ratio: 0,
            usedChars: 0,
            limitChars: 230000,
            isWarning: false,
            initializing: true,
          },
        }));
      })
    );

    unsubscribers.push(
      subscribe('step', (data: unknown) => {
        const payload = data as { runId?: string; context?: ContextRef; step?: number; maxSteps?: number };
        const sessionId = toSessionId(payload.context);
        if (!sessionId || typeof payload.runId !== 'string') {
          return;
        }
        const runId = payload.runId;
        updateRuntime(sessionId, (runtime) => {
          if (!shouldApplyRunEvent(runtime, runId)) {
            return runtime;
          }
          const now = Date.now();
          const nextRuntime = observeRunEvent(runtime, runId, now);
          const currentStep = typeof payload.step === 'number' ? payload.step : runtime.currentStep;
          const maxSteps = typeof payload.maxSteps === 'number' ? payload.maxSteps : runtime.maxSteps;
          const model = nextRuntime.currentLlmRuntime?.model;
          return {
            ...nextRuntime,
            currentStep,
            maxSteps,
            liveEvents: upsertRunStatusEvent(nextRuntime.liveEvents, {
              title:
                currentStep > 0 && maxSteps > 0
                  ? t('app.running.stepStatus', { current: currentStep, max: maxSteps })
                  : t('app.running.processing'),
              summary: model ? t('app.running.modelStatus', { model }) : undefined,
              timestamp: now,
              createEventId: () => createMessageId('live-run-status'),
            }),
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('thinking', (data: unknown) => {
        const payload = data as { runId?: string; context?: ContextRef; thinking?: string };
        const sessionId = toSessionId(payload.context);
        const thinkingText = normalizeThinkingDeltaForDisplay(payload.thinking);
        if (!sessionId || typeof payload.runId !== 'string' || thinkingText === null) {
          return;
        }
        const runId = payload.runId;

        updateRuntime(sessionId, (runtime) => {
          if (!shouldApplyRunEvent(runtime, runId)) {
            return runtime;
          }
          const now = Date.now();
          const nextRuntime = observeRunEvent(runtime, runId, now);
          const events = [...nextRuntime.liveEvents];
          const last = events[events.length - 1];

          if (last && last.type === 'thinking') {
            events[events.length - 1] = {
              ...last,
              thinking: `${last.thinking ?? ''}${thinkingText}`,
              isStreaming: true,
              timestamp: now,
            };
          } else {
            events.push({
              id: createMessageId('live-thinking'),
              type: 'thinking',
              thinking: thinkingText,
              isStreaming: true,
              timestamp: now,
            });
          }

          return {
            ...nextRuntime,
            lastActivityAt: now,
            liveEvents: events,
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('tool_call', (data: unknown) => {
        const payload = data as {
          runId?: string;
          context?: ContextRef;
          name?: string;
          args?: Record<string, unknown>;
          toolCallId?: string;
        };
        const sessionId = toSessionId(payload.context);
        if (!sessionId || typeof payload.runId !== 'string' || typeof payload.name !== 'string') {
          return;
        }
        const name = payload.name;
        const args = payload.args ?? {};
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
        const runId = payload.runId;

        updateRuntime(sessionId, (runtime) => {
          if (!shouldApplyRunEvent(runtime, runId)) {
            return runtime;
          }
          const timestamp = Date.now();
          const nextRuntime = observeRunEvent(runtime, runId, timestamp);
          const { liveEvents, toolCallsAccumulator } = upsertToolCallState(
            closeStreamingThinking(nextRuntime.liveEvents),
            nextRuntime.toolCallsAccumulator,
            {
              toolCallId,
              name,
              args,
              timestamp,
              createEventId: () => createMessageId('live-tool-call'),
            }
          );

          return {
            ...nextRuntime,
            liveEvents,
            toolCallsAccumulator,
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('tool_result', (data: unknown) => {
        const payload = data as {
          runId?: string;
          context?: ContextRef;
          name?: string;
          result?: { success: boolean; content: string; error?: string };
        };
        const sessionId = toSessionId(payload.context);
        if (!sessionId || typeof payload.runId !== 'string' || typeof payload.name !== 'string' || !payload.result) {
          return;
        }
        const name = payload.name;
        const result = payload.result;
        const runId = payload.runId;
        updateRuntime(sessionId, (runtime) => {
          if (!shouldApplyRunEvent(runtime, runId)) {
            return runtime;
          }
          const now = Date.now();
          const nextRuntime = observeRunEvent(runtime, runId, now);
          const nextEvents = closeStreamingThinking(nextRuntime.liveEvents);
          const toolResult: ToolResult = {
            name,
            result,
          };
          nextEvents.push({
            id: createMessageId('live-tool-result'),
            type: 'tool_result',
            name,
            result,
            timestamp: now,
          });
          return {
            ...nextRuntime,
            liveEvents: nextEvents,
            toolResultsAccumulator: [...nextRuntime.toolResultsAccumulator, toolResult],
          };
        });

        if (name === 'todo' && currentSessionIdRef.current === sessionId) {
          void onRefreshGovernance(sessionId);
        }
      })
    );

    unsubscribers.push(
      subscribe('message', (data: unknown) => {
        const payload = data as {
          runId?: string;
          context?: ContextRef;
          role?: string;
          content?: string;
          llmRuntime?: RunLlmRuntimeView;
        };
        const sessionId = toSessionId(payload.context);
        const content = normalizeTextDeltaForDisplay(payload.content);
        if (!sessionId || typeof payload.runId !== 'string' || content === null) {
          return;
        }
        const runId = payload.runId;
        updateRuntime(sessionId, (runtime) => {
          if (!shouldApplyRunEvent(runtime, runId)) {
            return runtime;
          }
          if (payload.role === 'assistant' || !payload.role) {
            const now = Date.now();
            const nextRuntime = observeRunEvent(runtime, runId, now);
            const llmRuntime = payload.llmRuntime ?? nextRuntime.currentLlmRuntime;
            return {
              ...nextRuntime,
              currentLlmRuntime: llmRuntime ?? null,
              liveEvents: appendLiveTextDelta(
                nextRuntime.liveEvents,
                content,
                now,
                () => createMessageId('live-text'),
                llmRuntime
              ),
              contentAccumulator: nextRuntime.contentAccumulator + content,
            };
          }
          return runtime;
        });
      })
    );

    unsubscribers.push(
      subscribe('memory_trigger', (data: unknown) => {
        const payload = data as {
          runId?: string;
          context?: ContextRef;
          title?: string;
          content?: string;
        };
        const sessionId = toSessionId(payload.context);
        const title = String(payload.title ?? '').trim();
        const content = truncateLiveSummary(String(payload.content ?? ''));
        if (!sessionId || typeof payload.runId !== 'string' || !title || !content) {
          return;
        }
        const runId = payload.runId;
        updateRuntime(sessionId, (runtime) => {
          if (!shouldApplyRunEvent(runtime, runId)) {
            return runtime;
          }
          const now = Date.now();
          const nextRuntime = observeRunEvent(runtime, runId, now);
          return {
            ...nextRuntime,
            liveEvents: [
              ...closeStreamingThinking(nextRuntime.liveEvents),
              {
                id: createMessageId('live-memory-trigger'),
                type: 'memory_trigger',
                title: 'Memory Trigger',
                summary: `${title}: ${content}`,
                timestamp: now,
              },
            ],
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('skill_trigger', (data: unknown) => {
        const payload = data as {
          runId?: string;
          context?: ContextRef;
          name?: string;
          action?: 'create' | 'update';
          detail?: string;
          version?: string;
        };
        const sessionId = toSessionId(payload.context);
        const name = String(payload.name ?? '').trim();
        if (!sessionId || typeof payload.runId !== 'string' || !name) {
          return;
        }
        const runId = payload.runId;
        const detail = truncateLiveSummary(
          String(payload.detail ?? '').trim() || (payload.version ? `v${payload.version}` : '')
        );
        updateRuntime(sessionId, (runtime) => {
          if (!shouldApplyRunEvent(runtime, runId)) {
            return runtime;
          }
          const now = Date.now();
          const nextRuntime = observeRunEvent(runtime, runId, now);
          return {
            ...nextRuntime,
            liveEvents: [
              ...closeStreamingThinking(nextRuntime.liveEvents),
              {
                id: createMessageId('live-skill-trigger'),
                type: 'skill_trigger',
                title: 'Skill Trigger',
                summary: `${payload.action === 'update' ? 'update' : 'create'} ${name}${detail ? `: ${detail}` : ''}`,
                timestamp: now,
              },
            ],
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('plan_input_requested', (data: unknown) => {
        const payload = data as PlanInputRequestPayload;
        const sessionId = toSessionId(payload.context);
        if (!sessionId || typeof payload.runId !== 'string' || typeof payload.requestId !== 'string') {
          return;
        }
        updateRuntime(sessionId, (runtime) => {
          if (!shouldApplyRunEvent(runtime, payload.runId)) {
            return runtime;
          }
          const now = Date.now();
          const nextRuntime = observeRunEvent(runtime, payload.runId, now);
          return {
            ...nextRuntime,
            pendingPlanInput: payload,
            pendingPlanInputError: null,
            isRunning: true,
            runStartedAt: nextRuntime.runStartedAt || now,
            lastActivityAt: now,
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('plan_input_resolved', (data: unknown) => {
        const payload = data as { runId?: string; context?: ContextRef; requestId?: string };
        const sessionId = toSessionId(payload.context);
        if (!sessionId || typeof payload.runId !== 'string') {
          return;
        }
        updateRuntime(sessionId, (runtime) => {
          if (!runtime.pendingPlanInput && runtime.runId !== payload.runId) {
            return runtime;
          }
          if (runtime.pendingPlanInput && payload.requestId && runtime.pendingPlanInput.requestId !== payload.requestId) {
            return runtime;
          }
          return {
            ...runtime,
            pendingPlanInput: null,
            pendingPlanInputError: null,
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('plan_input_error', (data: unknown) => {
        const payload = data as { runId?: string; context?: ContextRef; requestId?: string; error?: string };
        const sessionId = toSessionId(payload.context);
        if (!sessionId || typeof payload.runId !== 'string') {
          return;
        }
        const error = typeof payload.error === 'string' && payload.error.trim().length > 0 ? payload.error : 'plan input error';
        updateRuntime(sessionId, (runtime) => {
          if (runtime.pendingPlanInput && payload.requestId && runtime.pendingPlanInput.requestId !== payload.requestId) {
            return runtime;
          }
          if (!runtime.pendingPlanInput && runtime.runId !== payload.runId) {
            return runtime;
          }
          const shouldClearPending =
            error === 'run_completed' ||
            error === 'run_canceled' ||
            error === 'run_error';
          const nextRuntime =
            shouldClearPending && error === 'run_canceled' ? addIgnoredRunId(runtime, payload.runId) : runtime;
          return {
            ...nextRuntime,
            runId: shouldClearPending ? null : nextRuntime.runId,
            pendingPlanInput: shouldClearPending ? null : runtime.pendingPlanInput,
            pendingPlanInputError: error,
            isRunning: shouldClearPending ? false : runtime.isRunning,
            cancelInitiated: shouldClearPending ? false : runtime.cancelInitiated,
            cancelAcknowledged: shouldClearPending ? true : runtime.cancelAcknowledged,
            cancelRequestedAt: shouldClearPending ? 0 : runtime.cancelRequestedAt,
            contextPrecompressActive: shouldClearPending ? false : runtime.contextPrecompressActive,
            compressionStatus: shouldClearPending ? null : runtime.compressionStatus,
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('error', (data: unknown) => {
        const payload = data as { runId?: string; context?: ContextRef; error?: string; isSubagentError?: boolean };
        const sessionId = toSessionId(payload.context);
        if (!sessionId) {
          return;
        }
        updateRuntime(sessionId, (runtime) => {
          const errorText = typeof payload.error === 'string' ? payload.error : 'Unknown error';
          if (typeof payload.runId !== 'string') {
            return {
              ...runtime,
              resumePending: false,
              dismissPending: false,
              error: errorText,
            };
          }
          if (payload.isSubagentError && runtime.runId !== payload.runId) {
            console.warn('[App] Ignoring subagent error for different runId:', payload.runId, 'current:', runtime.runId);
            return runtime;
          }
          if (runtime.runId !== payload.runId) {
            return runtime;
          }
          const isCancelError = errorText.includes('cancel') || errorText.includes('abort') || errorText.includes('stopped');
          const nextRuntime = addIgnoredRunId(runtime, payload.runId);
          return {
            ...nextRuntime,
            runId: null,
            runStartedAt: 0,
            isRunning: false,
            resumePending: false,
            dismissPending: false,
            cancelAcknowledged: runtime.cancelInitiated || isCancelError ? true : runtime.cancelAcknowledged,
            cancelInitiated: false,
            cancelRequestedAt: 0,
            contextPrecompressActive: false,
            compressionStatus: null,
            liveEvents: closeStreamingThinking(nextRuntime.liveEvents),
            error: errorText,
            pendingPlanInput: null,
            pendingPlanInputError: null,
            currentLlmRuntime: null,
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('complete', (data: unknown) => {
        const payload = data as { context?: ContextRef; runId?: string; content?: string; sessionId?: string };
        const sessionId = toSessionId(payload.context);
        if (!sessionId || typeof payload.runId !== 'string') {
          return;
        }
        const runId = payload.runId;

        setRuntimeBySession((prev) => {
          const runtime = prev[sessionId] ?? createRuntimeState();
          if (!shouldApplyRunEvent(runtime, runId)) {
            return prev;
          }

          const finalContent = runtime.contentAccumulator || String(payload.content ?? '');
          const isCancelledComplete = finalContent.trim() === 'Task cancelled by user.';
          const finalThinking = runtime.liveEvents
            .filter((event): event is Extract<typeof runtime.liveEvents[number], { type: 'thinking' }> => event.type === 'thinking')
            .map((event) => event.thinking)
            .join('\n\n');

          if (
            !isCancelledComplete &&
            (finalContent ||
              finalThinking ||
              runtime.toolCallsAccumulator.length > 0 ||
              runtime.toolResultsAccumulator.length > 0)
          ) {
            appendMessage(sessionId, {
              id: createMessageId('assistant-msg'),
              role: 'assistant',
              content: finalContent,
              timestamp: Date.now(),
              thinking: finalThinking || undefined,
              toolCalls: runtime.toolCallsAccumulator,
              toolResults: runtime.toolResultsAccumulator,
              metadata: runtime.currentLlmRuntime
                ? {
                    llmProviderProfileId: runtime.currentLlmRuntime.profileId,
                    llmProvider: runtime.currentLlmRuntime.provider,
                    llmModel: runtime.currentLlmRuntime.model,
                  }
                : undefined,
            });
          }
          const completedAt = Date.now();

          return {
            ...prev,
            [sessionId]: finalizeRuntimeAfterComplete(runtime, runId, completedAt),
          };
        });

        if (!currentSessionIdRef.current && payload.sessionId) {
          setCurrentSessionId(payload.sessionId);
        }
        void onRefreshGovernance(sessionId);
        void fetchSessions();
      })
    );

    unsubscribers.push(
      subscribe('run_terminal', (data: unknown) => {
        const payload = data as RunTerminalStateView & {
          context?: ContextRef;
          artifact?: InterruptedArtifactView | null;
          sessionId?: string;
        };
        const sessionId = toSessionId(payload.context);
        if (!sessionId || typeof payload.runId !== 'string') {
          return;
        }

        updateRuntime(sessionId, (runtime) => {
          if (!shouldApplyRunTerminalEvent(runtime, payload.runId)) {
            return runtime;
          }
          const nextRuntime = addIgnoredRunId(runtime, payload.runId);
          const hasArtifact = payload.artifact !== undefined && payload.artifact !== null;
          const errorText =
            payload.terminalCode === 'error' && !hasArtifact
              ? typeof payload.errorSummary === 'string' && payload.errorSummary.trim().length > 0
                ? payload.errorSummary
                : 'Run failed'
              : null;
          return {
            ...nextRuntime,
            runId: null,
            runStartedAt: 0,
            lastActivityAt: Date.now(),
            isRunning: false,
            resumePending: false,
            dismissPending: false,
            cancelInitiated: false,
            cancelAcknowledged: payload.terminalCode === 'cancelled' ? true : runtime.cancelAcknowledged,
            cancelRequestedAt: 0,
            contextPrecompressActive: false,
            compressionStatus: null,
            liveEvents: [],
            contentAccumulator: '',
            toolCallsAccumulator: [],
            toolResultsAccumulator: [],
            currentStep: typeof payload.lastSafeStep === 'number' ? payload.lastSafeStep : runtime.currentStep,
            maxSteps: typeof payload.maxSteps === 'number' ? payload.maxSteps : runtime.maxSteps,
            error: errorText,
            interruptedArtifact: payload.artifact ?? null,
            lastTerminalState: payload,
            pendingPlanInput: null,
            pendingPlanInputError: null,
            currentLlmRuntime: null,
          };
        });

        if (currentSessionIdRef.current === sessionId) {
          void loadSessionMessages(sessionId);
          void onRefreshGovernance(sessionId);
        }
        void fetchSessions();
      })
    );

    unsubscribers.push(
      subscribe('interrupted_artifact_dismissed', (data: unknown) => {
        const payload = data as {
          context?: ContextRef;
          artifact?: InterruptedArtifactView | null;
        };
        const sessionId = toSessionId(payload.context);
        if (!sessionId || !payload.artifact) {
          return;
        }
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          lastActivityAt: Date.now(),
          resumePending: false,
          dismissPending: false,
          interruptedArtifact: payload.artifact ?? runtime.interruptedArtifact,
        }));
        if (currentSessionIdRef.current === sessionId) {
          void loadSessionMessages(sessionId);
        }
      })
    );

    unsubscribers.push(
      subscribe('cancel_ack', (data: unknown) => {
        const payload = data as { context?: ContextRef; runId?: string | null };
        const sessionId = toSessionId(payload.context);
        if (!sessionId) {
          return;
        }

        updateRuntime(sessionId, (runtime) => {
          if (!shouldApplyCancelAck(runtime, payload.runId ?? null)) {
            return runtime;
          }
          const nextRuntime = addIgnoredRunId(runtime, payload.runId ?? runtime.runId);
          return {
            ...nextRuntime,
            runId: null,
            runStartedAt: 0,
            isRunning: false,
            resumePending: false,
            dismissPending: false,
            cancelInitiated: false,
            cancelAcknowledged: true,
            cancelRequestedAt: 0,
            contextPrecompressActive: false,
            compressionStatus: null,
            liveEvents: closeStreamingThinking(nextRuntime.liveEvents),
            pendingPlanInput: null,
            pendingPlanInputError: null,
            currentLlmRuntime: null,
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('context_utilization', (data: unknown) => {
        const payload = data as {
          context?: ContextRef;
          ratio?: number;
          utilizationRatio?: number;
          usedChars: number;
          limitChars: number;
        };
        const sessionId = toSessionId(payload.context);
        const ratio =
          typeof payload.ratio === 'number'
            ? payload.ratio
            : typeof payload.utilizationRatio === 'number'
              ? payload.utilizationRatio
              : null;
        if (!sessionId || ratio === null) {
          return;
        }
        const isWarning = ratio >= 0.8;
        setContextUtilization((prev) => {
          if (isWarning && !prev?.[sessionId]?.isWarning) {
            const percentage = Math.round(ratio * 100);
            addToast({
              type: 'warning',
              message: t('app.context.utilizationWarning', { percentage }),
              autoDismiss: true,
            });
          }
          return {
            ...prev,
            [sessionId]: {
              ratio,
              usedChars: payload.usedChars,
              limitChars: payload.limitChars,
              isWarning,
              initializing: false,
            },
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('context_precompress', (data: unknown) => {
        const payload = data as {
          context?: ContextRef;
          runId?: string;
          source?: 'replay_prepare' | 'in_turn_precompress';
          ratio?: number;
          usedChars?: number;
          limitChars?: number;
          progressPercent?: number;
          chunkIndex?: number;
          chunkTotal?: number;
          observedAt?: string;
          phase?: 'started' | 'running' | 'completed' | 'failed';
        };
        const sessionId = toSessionId(payload.context);
        if (!sessionId) {
          return;
        }
        const runtimeSnapshot = runtimeBySessionRef.current[sessionId] ?? createRuntimeState();
        if (
          typeof payload.runId === 'string' &&
          !shouldApplyContextPrecompressEvent(runtimeSnapshot, payload.runId)
        ) {
          return;
        }
        const nextContextUtilization = contextUtilizationFromPrecompressPayload(payload);
        if (nextContextUtilization) {
          setContextUtilization((prev) => ({
            ...prev,
            [sessionId]: nextContextUtilization,
          }));
        }
        updateRuntime(sessionId, (runtime) => {
          const now = Date.now();
          const nextRuntime =
            typeof payload.runId === 'string' ? observeRunEvent(runtime, payload.runId, now) : runtime;
          const ratioValue =
            nextContextUtilization?.ratio ??
            (typeof payload.ratio === 'number' && Number.isFinite(payload.ratio) ? payload.ratio : undefined);
          const contextPrecompressActive =
            payload.phase === 'started' || payload.phase === 'running'
              ? true
              : payload.phase === 'completed' || payload.phase === 'failed'
                ? false
                : nextRuntime.contextPrecompressActive;
          const compressionStatus: RuntimeCompressionStatus | null = contextPrecompressActive
            ? {
                source: payload.source === 'replay_prepare' ? 'replay_prepare' : 'in_turn_precompress',
                phase: payload.phase === 'running' ? 'running' : 'started',
                observedAt:
                  typeof payload.observedAt === 'string' && payload.observedAt.trim().length > 0
                    ? payload.observedAt
                    : new Date(now).toISOString(),
                ratio: ratioValue,
                progressPercent:
                  typeof payload.progressPercent === 'number' && Number.isFinite(payload.progressPercent)
                    ? Math.min(100, Math.max(0, Math.round(payload.progressPercent)))
                    : undefined,
                chunkIndex:
                  typeof payload.chunkIndex === 'number' && Number.isFinite(payload.chunkIndex)
                    ? Math.max(1, Math.floor(payload.chunkIndex))
                    : undefined,
                chunkTotal:
                  typeof payload.chunkTotal === 'number' && Number.isFinite(payload.chunkTotal)
                    ? Math.max(1, Math.floor(payload.chunkTotal))
                    : undefined,
              }
            : null;
          return {
            ...nextRuntime,
            lastActivityAt: now,
            contextPrecompressActive,
            compressionStatus,
          };
        });
      })
    );

    unsubscribers.push(
      subscribe('context_overflow', (data: unknown) => {
        const payload = data as { context?: ContextRef; error?: string };
        const sessionId = toSessionId(payload.context);
        if (!sessionId) {
          return;
        }
        addToast({
          type: 'error',
          message: t('app.context.limitExceeded', {
            reason: payload.error || t('app.context.limitFallback'),
          }),
          autoDismiss: false,
        });
      })
    );

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    addToast,
    appendMessage,
    fetchSessions,
    loadSessionMessages,
    onRefreshGovernance,
    setCurrentSessionId,
    subscribe,
    t,
    updateRuntime,
  ]);

  useEffect(() => {
    const thresholds = {
      warningMs: 60000,
      cancelAckTimeoutMs: 10000,
    } as const;

    const timer = window.setInterval(() => {
      const now = Date.now();
      const activeSessions = new Set<string>();

      Object.entries(runtimeBySessionRef.current).forEach(([sessionId, runtime]) => {
        if (runtime.isRunning || runtime.cancelInitiated) {
          activeSessions.add(sessionId);
        }

        const decision = evaluateRuntimeWatchdog(
          now,
          runtime,
          thresholds,
          watchdogWarningBucketRef.current[sessionId] ?? 0
        );

        if (decision.kind === 'cancel_warning') {
          watchdogWarningBucketRef.current[sessionId] = decision.warningBucket;
          addToast({
            type: 'warning',
            message: t('app.watchdog.cancelTimeout'),
            autoDismiss: true,
          });
          void loadSessionMessages(sessionId);
          return;
        }

        if (decision.kind === 'run_warning') {
          watchdogWarningBucketRef.current[sessionId] = decision.warningBucket;
          addToast({
            type: 'warning',
            message: t('app.watchdog.stuckWarning', { seconds: Math.round(decision.elapsedMs / 1000) }),
            autoDismiss: true,
          });
          return;
        }

        if (!runtime.isRunning) {
          delete watchdogWarningBucketRef.current[sessionId];
        }
      });

      Object.keys(watchdogWarningBucketRef.current).forEach((sessionId) => {
        if (!activeSessions.has(sessionId)) {
          delete watchdogWarningBucketRef.current[sessionId];
        }
      });
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [addToast, loadSessionMessages, t, updateRuntime]);

  const handleSend = useCallback(
    (payload: { prompt: string; selectedAgentName?: string; usePlanMode?: boolean }) => {
      const trimmedPrompt = payload.prompt.trim();
      if (!trimmedPrompt) {
        return;
      }
      setActiveView('chat');

      const sessionId = currentSessionId ?? createClientSessionId();
      if (!currentSessionId) {
        setCurrentSessionId(sessionId);
      }
      const sessionKey = currentSessionId ?? COMPOSER_DRAFT_KEY;
      const effectiveLlmSelection = resolveSessionLlmSelectionView(
        llmProfiles,
        sessionLlmSelectionBySession[sessionKey]
      );

      const currentRuntime = runtimeBySession[sessionId];
      if (isRuntimeInteractionLocked(currentRuntime)) {
        return;
      }

      upsertLocalDraftSession(sessionId, trimmedPrompt, workspaceDir);

      appendMessage(sessionId, {
        id: createMessageId('user-msg'),
        role: 'user',
        content: trimmedPrompt,
        timestamp: Date.now(),
      });

      updateRuntime(sessionId, (runtime) => ({
        ...createPendingRunRuntimeState(runtime, Date.now()),
      }));

      if (currentSessionId) {
        clearComposerInputForSession(sessionId);
      } else {
        setComposerInputBySession((prev) => {
          const clearedDraft = clearComposerInput(prev, COMPOSER_DRAFT_KEY);
          return clearComposerInput(clearedDraft, sessionId);
        });
        setSessionLlmSelectionBySession((prev) => {
          const draftSelection = prev[COMPOSER_DRAFT_KEY];
          if (!draftSelection) {
            return prev;
          }
          const next = {
            ...prev,
            [sessionId]: draftSelection,
          };
          delete next[COMPOSER_DRAFT_KEY];
          return next;
        });
      }

      const context: ContextRef = {
        scope: 'session',
        namespace: sessionId,
      };

      const message: WSMessage = {
        type: 'chat',
        data: {
          prompt: trimmedPrompt,
          selectedAgentName: payload.selectedAgentName,
          ...(payload.usePlanMode === true ? { usePlanMode: true } : {}),
          ...(llmProfiles ? { llmSelection: effectiveLlmSelection } : {}),
          workspaceDir,
          context,
        },
      };

      sendWithReconnectRetry(message, () => {
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          isRunning: false,
          contextPrecompressActive: false,
          compressionStatus: null,
          error: t('app.websocket.sendFailed'),
        }));
      });
      void fetchSessions();
    },
    [
      appendMessage,
      clearComposerInputForSession,
      currentSessionId,
      fetchSessions,
      runtimeBySession,
      llmProfiles,
      sendWithReconnectRetry,
      sessionLlmSelectionBySession,
      setActiveView,
      setCurrentSessionId,
      t,
      updateRuntime,
      upsertLocalDraftSession,
      workspaceDir,
    ]
  );

  const handleCancelCurrentRun = useCallback(() => {
    if (!currentSessionId) {
      return;
    }
    const runtime = runtimeBySession[currentSessionId];
    const cancelInFlight = runtime?.cancelInitiated && !runtime.cancelAcknowledged;
    if (!runtime || cancelInFlight) {
      return;
    }
    const runId = runtime?.runId;

    updateRuntime(currentSessionId, (state) => ({
      ...addIgnoredRunId(state, runId),
      runId: null,
      runStartedAt: 0,
      isRunning: false,
      resumePending: false,
      cancelInitiated: true,
      cancelAcknowledged: false,
      cancelRequestedAt: Date.now(),
      contextPrecompressActive: false,
      compressionStatus: null,
      liveEvents: [],
      contentAccumulator: '',
      toolCallsAccumulator: [],
      toolResultsAccumulator: [],
      pendingPlanInput: null,
      pendingPlanInputError: null,
      currentLlmRuntime: null,
    }));

    const sent = send({
      type: 'cancel',
      data: {
        runId,
        context: {
          scope: 'session',
          namespace: currentSessionId,
        },
      },
    });
    if (!sent) {
      updateRuntime(currentSessionId, (state) => ({
        ...state,
        cancelInitiated: false,
        cancelAcknowledged: true,
        cancelRequestedAt: 0,
        error: t('app.websocket.cancelFailed'),
      }));
    }
  }, [currentSessionId, runtimeBySession, send, t, updateRuntime]);

  const handleResumeInterruptedRun = useCallback(() => {
    if (!currentSessionId) {
      return;
    }
    const runtime = runtimeBySession[currentSessionId];
    const artifact = runtime?.interruptedArtifact;
    if (
      !artifact?.resumable ||
      !artifact.artifactId ||
      runtime?.isRunning ||
      runtime?.resumePending ||
      runtime?.dismissPending
    ) {
      return;
    }
    updateRuntime(currentSessionId, (state) => ({
      ...state,
      error: null,
      lastActivityAt: Date.now(),
      resumePending: true,
      dismissPending: false,
    }));
    sendWithReconnectRetry(
      {
        type: 'resume_failed_turn',
        data: {
          context: {
            scope: 'session',
            namespace: currentSessionId,
          },
          sessionId: currentSessionId,
          artifactId: artifact.artifactId,
        },
      },
      () => {
        updateRuntime(currentSessionId, (state) => ({
          ...state,
          resumePending: false,
          error: t('app.websocket.sendFailed'),
        }));
      }
    );
  }, [currentSessionId, runtimeBySession, sendWithReconnectRetry, t, updateRuntime]);

  const handleDismissInterruptedArtifact = useCallback(() => {
    if (!currentSessionId) {
      return;
    }
    const runtime = runtimeBySession[currentSessionId];
    const artifact = runtime?.interruptedArtifact;
    if (!artifact || runtime?.isRunning || runtime?.resumePending || runtime?.dismissPending) {
      return;
    }
    updateRuntime(currentSessionId, (state) => ({
      ...state,
      error: null,
      lastActivityAt: Date.now(),
      dismissPending: true,
    }));
    sendWithReconnectRetry(
      {
        type: 'dismiss_interrupted_artifact',
        data: {
          context: {
            scope: 'session',
            namespace: currentSessionId,
          },
          sessionId: currentSessionId,
        },
      },
      () => {
        updateRuntime(currentSessionId, (state) => ({
          ...state,
          dismissPending: false,
          error: t('app.websocket.sendFailed'),
        }));
      }
    );
  }, [currentSessionId, runtimeBySession, sendWithReconnectRetry, t, updateRuntime]);

  const handleSubmitPlanInput = useCallback(
    (answers: PlanInputAnswerPayload[]) => {
      if (!currentSessionId) {
        return;
      }
      const runtime = runtimeBySession[currentSessionId];
      const pending = runtime?.pendingPlanInput;
      const runId = runtime?.runId;
      if (!pending || !runId) {
        return;
      }
      const sent = send({
        type: 'plan_input_response',
        data: {
          runId,
          context: pending.context,
          requestId: pending.requestId,
          answers,
        },
      });
      if (!sent) {
        updateRuntime(currentSessionId, (state) => ({
          ...state,
          pendingPlanInputError: t('app.websocket.planInputFailed'),
        }));
      }
    },
    [currentSessionId, runtimeBySession, send, t, updateRuntime]
  );

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      setActiveView('chat');
      updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        hydrating: true,
      }));
      setCurrentSessionId(sessionId);
      const selectedSession = sessions.find((session) => session.id === sessionId);
      const selectedWorkspaceDir = String(selectedSession?.workspaceDir ?? '').trim();
      setWorkspaceDir(selectedWorkspaceDir || defaultWorkspaceDir);
      await loadSessionMessages(sessionId);
    },
    [
      defaultWorkspaceDir,
      loadSessionMessages,
      sessions,
      setActiveView,
      setCurrentSessionId,
      setWorkspaceDir,
      updateRuntime,
    ]
  );

  const handleOpenAutomationSession = useCallback(
    async (sessionId: string) => {
      setActiveView('chat');
      await handleSelectSession(sessionId);
    },
    [handleSelectSession, setActiveView]
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, newName: string) => {
      const normalizedName = String(newName ?? '').trim();
      if (!normalizedName) {
        return;
      }
      const target = sessions.find((item) => item.id === sessionId);
      if (target?.isLocalDraft) {
        setSessions((prev) =>
          prev.map((item) =>
            item.id === sessionId ? { ...item, name: normalizedName, updatedAt: new Date().toISOString() } : item
          )
        );
        return;
      }
      try {
        const response = await fetch(`/api/sessions/${sessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: normalizedName }),
        });
        if (!response.ok) {
          const error = (await response.json().catch(() => ({ error: 'Unknown error' }))) as { error?: string };
          alert(`${t('common.error')}: ${error.error || response.statusText}`);
          return;
        }
        await fetchSessions();
      } catch (error) {
        console.error('Failed to rename session:', error);
        alert(t('common.error'));
      }
    },
    [fetchSessions, sessions, t]
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!window.confirm(t('app.deleteSession.confirm'))) {
        return;
      }
      try {
        await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
        removeComposerInputForSession(sessionId);
        if (currentSessionId === sessionId) {
          setCurrentSessionId(null);
          clearComposerInputForSession(COMPOSER_DRAFT_KEY);
          void onRefreshGovernance(null);
          saveLastSessionIdToStorage(null);
        } else if (loadLastSessionIdFromStorage() === sessionId) {
          saveLastSessionIdToStorage(null);
        }
        setMessagesBySession((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
        setRuntimeBySession((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
        setSessionLlmSelectionBySession((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
        await fetchSessions();
      } catch (error) {
        console.error('Failed to delete session:', error);
      }
    },
    [
      clearComposerInputForSession,
      currentSessionId,
      fetchSessions,
      onRefreshGovernance,
      removeComposerInputForSession,
      setCurrentSessionId,
      t,
    ]
  );

  const currentMessages = useMemo(() => {
    if (!currentSessionId) {
      return [];
    }
    return messagesBySession[currentSessionId] ?? [];
  }, [currentSessionId, messagesBySession]);

  const currentRuntime = useMemo(() => {
    if (!currentSessionId) {
      return createRuntimeState();
    }
    return runtimeBySession[currentSessionId] ?? createRuntimeState();
  }, [currentSessionId, runtimeBySession]);
  const currentInteractionLocked = useMemo(
    () => isRuntimeInteractionLocked(currentRuntime),
    [currentRuntime]
  );
  const currentCanceling = useMemo(
    () => currentRuntime.cancelInitiated === true && currentRuntime.cancelAcknowledged !== true,
    [currentRuntime]
  );

  const runningSessionIds = useMemo(
    () =>
      Object.entries(runtimeBySession)
        .filter(([, runtime]) => runtime.isRunning)
        .map(([sessionId]) => sessionId),
    [runtimeBySession]
  );

  const pendingPlanInputSessions = useMemo<PendingPlanInputSessionItem[]>(() => {
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
  }, [runtimeBySession, sessions]);

  const pendingPlanInputSessionIds = useMemo(
    () => pendingPlanInputSessions.map((item) => item.sessionId),
    [pendingPlanInputSessions]
  );

  return {
    composerInputBySession,
    setComposerInputBySession,
    sessions,
    setSessions,
    mcpStatus,
    contextUtilization,
    messagesBySession,
    setMessagesBySession,
    runtimeBySession,
    setRuntimeBySession,
    activeComposerInput,
    setActiveComposerInput,
    clearComposerInputForSession,
    removeComposerInputForSession,
    fetchSessions,
    fetchMcpStatus,
    loadSessionMessages,
    handleSend,
    handleCancelCurrentRun,
    handleResumeInterruptedRun,
    handleDismissInterruptedArtifact,
    handleSubmitPlanInput,
    handleSelectSession,
    handleOpenAutomationSession,
    handleRenameSession,
    handleDeleteSession,
    currentMessages,
    currentRuntime,
    currentInteractionLocked,
    currentCanceling,
    currentLlmSelection,
    setCurrentSessionLlmSelection,
    runningSessionIds,
    pendingPlanInputSessions,
    pendingPlanInputSessionIds,
  };
}
