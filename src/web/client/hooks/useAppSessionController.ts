import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  clearComposerInput,
  clearComposerInputIfUnchanged,
  COMPOSER_DRAFT_KEY,
  getComposerInput,
  removeComposerInput,
  resolveComposerInputKey,
  setComposerInput,
  type ComposerInputBySession,
} from '../composer-input-state.js';
import { evaluateRuntimeWatchdog } from '../runtime-watchdog.js';
import { normalizeMcpStatus, type MCPStatusView } from '../mcp-status.js';
import type { Message } from '../chat-types.js';
import type { WSMessage } from './useWebSocket.js';
import { isContextEventVersionConflictError } from '../../../shared/context-version-conflict.js';
import {
  projectSessionContextUtilization,
  projectSessionMessages,
} from '../chat-message-projection.js';
import {
  deleteSession as deleteSessionRequest,
  exitPlanDraft,
  exitPlanExecution,
  fetchMcpStatusPayload,
  fetchSessionDetail,
  fetchSessionList,
  patchSessionLlmSelection,
  renameSession,
} from '../session-rest-api.js';
import type {
  ChatStartedEvent,
  ContextRef,
  ContextUtilizationMap,
  InterruptedArtifactView,
  LlmProfilesConfigView,
  MessageMap,
  PlanInputAnswerPayload,
  PlanInputRequestPayload,
  RunLlmRuntimeView,
  RunningInputQueueItemView,
  RuntimeCompressionStatus,
  RunTerminalStateView,
  RuntimeMap,
  SessionInfo,
  SessionLlmSelectionPatch,
  SessionLlmSelectionView,
  SessionPlanningState,
} from '../app-shell-types.js';
import {
  addIgnoredRunId,
  buildRuntimeInteractionLockDiagnostic,
  closeStreamingThinking,
  contextUtilizationFromPrecompressPayload,
  createClientSessionId,
  createMessageId,
  createPendingRunRuntimeState,
  createRuntimeState,
  createRunErrorTranscriptMessage,
  deriveSessionNameFromPrompt,
  finalizeRuntimeAfterComplete,
  finalizeRuntimeAfterRecoverableConflictError,
  finishRuntimeHydrationAfterLoadFailure,
  isRuntimeInteractionLocked,
  isRuntimeLlmSelectionLocked,
  observeRunEvent,
  removeRunningInputQueueItem,
  shouldApplyCancelAck,
  shouldApplyContextPrecompressEvent,
  shouldApplyRunEvent,
  shouldApplyRunTerminalEvent,
  toSessionId,
  upsertSessionToFront,
} from '../app-shell-types.js';
import {
  applySessionLlmSelectionPatch,
  createNextSessionLlmSelectionUpdatedAt,
  resolveSessionLlmSelectionView,
} from '../llm-session-state.js';
import {
  loadLastSessionIdFromStorage,
  saveLastSessionIdToStorage,
} from '../last-session-storage.js';
import {
  clearReconnectSendRetryTimeouts,
  scheduleReconnectSendRetry,
} from '../websocket-reconnect-send.js';
import {
  normalizeThinkingDeltaForDisplay,
  normalizeTextDeltaForDisplay,
} from '../display-delta-normalization.js';
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
} from './session-controller-view-state.js';
import {
  clearFetchedPlanningState,
  hydrateRuntimeFromSessionDetail,
  hydrateSessionListRuntimeMap,
  mergeFetchedSessionsWithLocalDrafts,
} from './session-controller-hydration.js';
import {
  buildCancelRunMessage,
  buildChatMessage,
  buildPlanInputResponseMessage,
  buildRunningInputCancelMessage,
  buildRunningInputEnqueueMessage,
  buildRunningInputInsertMessage,
  createRunningInputClientRequestId,
} from './session-controller-message-builders.js';
import {
  applyAssistantMessageDeltaRuntimeEvent,
  applyMemoryTriggerRuntimeEvent,
  applySkillTriggerRuntimeEvent,
  applyStepRuntimeEvent,
  applyThinkingRuntimeEvent,
  applyToolCallRuntimeEvent,
  applyToolResultRuntimeEvent,
} from './session-controller-runtime-events.js';

export {
  normalizeThinkingDeltaForDisplay,
  normalizeTextDeltaForDisplay,
} from '../display-delta-normalization.js';

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
  const [optimisticPlanningStateBySession, setOptimisticPlanningStateBySession] = useState<
    Record<string, SessionPlanningState>
  >({});
  const [planModeIntentBySession, setPlanModeIntentBySession] = useState<Record<string, boolean>>({});
  const [runningInputAckBySession, setRunningInputAckBySession] = useState<Record<string, string>>({});
  const [runningInputEditRestoreBySession, setRunningInputEditRestoreBySession] = useState<
    Record<string, { id: string; fileReferences?: string[] }>
  >({});

  const runtimeBySessionRef = useRef<RuntimeMap>({});
  const messagesBySessionRef = useRef<MessageMap>({});
  const watchdogWarningBucketRef = useRef<Record<string, number>>({});
  const currentSessionIdRef = useRef<string | null>(null);
  const llmSelectionSeqRef = useRef<Record<string, number>>({});
  const reconnectRetryTimeoutsRef = useRef<Set<number>>(new Set());
  const composerRevisionBySessionRef = useRef<Record<string, number>>({});
  const lastInteractionLockDiagnosticRef = useRef<string | null>(null);
  const pendingRunningInputRequestBySessionRef = useRef<
    Record<string, { clientRequestId: string; prompt: string; composerRevision: number }>
  >({});
  const hasAttemptedSessionRestoreRef = useRef(false);

  const activeComposerInput = useMemo(
    () => getComposerInput(composerInputBySession, currentSessionId),
    [composerInputBySession, currentSessionId]
  );

  const setActiveComposerInput = useCallback(
    (value: string) => {
      const key = resolveComposerInputKey(currentSessionId);
      composerRevisionBySessionRef.current[key] = (composerRevisionBySessionRef.current[key] ?? 0) + 1;
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

  const clearPlanModeIntentForSession = useCallback((sessionId: string | null | undefined) => {
    setPlanModeIntentBySession((prev) => clearPlanModeIntentState(prev, sessionId));
  }, []);

  const sendWithReconnectRetry = useCallback(
    (message: WSMessage, onFinalFailure: () => void): void => {
      scheduleReconnectSendRetry({
        message,
        send,
        connect,
        retryTimeouts: reconnectRetryTimeoutsRef.current,
        onFinalFailure,
      });
    },
    [connect, send]
  );

  useEffect(() => {
    return () => {
      clearReconnectSendRetryTimeouts(reconnectRetryTimeoutsRef.current);
    };
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const fetchedSessions = await fetchSessionList();
      setSessionLlmSelectionBySession((prev) => {
        const next = { ...prev };
        for (const session of fetchedSessions) {
          next[session.id] = resolveSessionLlmSelectionView(llmProfiles, session.llmSelection);
        }
        return next;
      });
      setRuntimeBySession((prev) => {
        const hydrated = hydrateSessionListRuntimeMap({
          runtimeBySession: prev,
          sessions: fetchedSessions,
        });
        for (const runtime of hydrated.staleRuns) {
          console.warn('[App] Self-healing stale running state after session list hydration:', {
            sessionId: runtime.sessionId,
            runId: runtime.runId,
            isRunning: runtime.isRunning,
            hydrating: runtime.hydrating,
            lastActivityAt: runtime.lastActivityAt ? new Date(runtime.lastActivityAt).toISOString() : undefined,
          });
        }
        return hydrated.runtimeBySession;
      });
      setSessions((prev) => {
        return mergeFetchedSessionsWithLocalDrafts({
          previousSessions: prev,
          fetchedSessions,
          hasLocalMessages: (sessionId) => (messagesBySessionRef.current[sessionId] ?? []).length > 0,
          isSessionRunning: (sessionId) => runtimeBySessionRef.current[sessionId]?.isRunning === true,
          currentSessionId: currentSessionIdRef.current,
        });
      });
      setOptimisticPlanningStateBySession((prev) => {
        return clearFetchedPlanningState(prev, fetchedSessions, (session) => Boolean(session.planningState?.state));
      });
      setPlanModeIntentBySession((prev) => {
        return clearFetchedPlanningState(
          prev,
          fetchedSessions,
          (session) => Boolean(session.planningState?.state && session.planningState.state !== 'normal')
        );
      });
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    }
  }, [llmProfiles]);

  const fetchMcpStatus = useCallback(async () => {
    try {
      setMcpStatus(normalizeMcpStatus(await fetchMcpStatusPayload()));
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
      if (currentSessionId && runtimeBySession[currentSessionId]?.interactionState.mode === 'observe_only') {
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

      void patchSessionLlmSelection(currentSessionId, nextSelection)
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
      [sessionId]: [
        ...(prev[sessionId] ?? []).filter((item) => item.id !== message.id),
        message,
      ],
    }));
  }, []);

  const upsertRuntimeErrorMessage = useCallback((sessionId: string, runId: string, errorText: string) => {
    const message = createRunErrorTranscriptMessage({
      runId,
      message: errorText,
      timestamp: Date.now(),
    });
    setMessagesBySession((prev) => {
      const existing = prev[sessionId] ?? [];
      return {
        ...prev,
        [sessionId]: [...existing.filter((item) => item.id !== message.id), message],
      };
    });
  }, []);

  const upsertLocalDraftSession = useCallback((sessionId: string, prompt: string, currentWorkspaceDir: string, planningState: SessionPlanningState) => {
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
          planningState: planningState !== 'normal' ? { state: planningState, updatedAt: now } : undefined,
          origin: 'web',
          isLocalDraft: true,
        });
      }
      const next: SessionInfo = {
        ...existing,
        name: existing.name?.trim().length ? existing.name : derivedName,
        workspaceDir: existing.workspaceDir?.trim().length ? existing.workspaceDir : currentWorkspaceDir,
        createdAt: existing.createdAt ?? now,
        updatedAt: now,
        planningState: planningState !== 'normal' ? { state: planningState, updatedAt: now } : existing.planningState,
      };
      return upsertSessionToFront(prev, next);
    });
  }, []);

  const loadSessionMessages = useCallback(
    async (sessionId: string) => {
      try {
        const session = await fetchSessionDetail(sessionId);
        setSessionLlmSelectionBySession((prev) => ({
          ...prev,
          [sessionId]: resolveSessionLlmSelectionView(llmProfiles, session.llmSelection),
        }));
        if (session.workspaceDir && currentSessionIdRef.current === sessionId) {
          setWorkspaceDir(session.workspaceDir);
        }
        if (session.planningState?.state) {
          setOptimisticPlanningStateBySession((prev) => {
            const next = { ...prev };
            delete next[sessionId];
            return next;
          });
          if (session.planningState.state !== 'normal') {
            clearPlanModeIntentForSession(sessionId);
          }
        }
        setContextUtilization((prev) => ({
          ...prev,
          [sessionId]: projectSessionContextUtilization(session),
        }));
        const loadedMessages = projectSessionMessages(sessionId, session);

        setMessagesBySession((prev) => ({
          ...prev,
          [sessionId]: loadedMessages,
        }));
        setRuntimeBySession((prev) => {
          return {
            ...prev,
            [sessionId]: hydrateRuntimeFromSessionDetail({
              sessionId,
              session,
              currentRuntime: prev[sessionId],
            }),
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
    [clearPlanModeIntentForSession, llmProfiles, setWorkspaceDir]
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
          interruptedArtifact: null,
          lastTerminalState: null,
          pendingPlanInput: null,
          pendingPlanInputError: null,
          currentLlmRuntime: payload.llmRuntime ?? null,
          activeRunOwner: payload.owner ?? null,
          interactionState: payload.interactionState ?? {
            mode: payload.owner === 'cli' || payload.owner === 'automation' ? 'observe_only' : 'normal',
            owner: payload.owner,
          },
          runningInputQueue: payload.runningInputQueue ?? runtime.runningInputQueue,
        }));
        setSessions((prev) => {
          const existing = prev.find((item) => item.id === sessionId);
          const startedAt = payload.startedAt ?? new Date().toISOString();
          return upsertSessionToFront(prev, {
            ...(existing ?? {
              id: sessionId,
              name: sessionId,
              createdAt: startedAt,
            }),
            updatedAt: startedAt,
            origin: payload.origin ?? existing?.origin ?? 'web',
            activeRun: {
              runId: payload.runId,
              context: payload.context,
              startedAt,
              owner: payload.owner,
              origin: payload.origin,
              interactionState: payload.interactionState,
              llmRuntime: payload.llmRuntime,
              runningInputQueue: payload.runningInputQueue,
            },
            interactionState: payload.interactionState ?? existing?.interactionState ?? { mode: 'normal' },
          });
        });
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
      subscribe('running_input_queue_updated', (data: unknown) => {
        const payload = data as {
          context?: ContextRef;
          items?: RunningInputQueueItemView[];
        };
        const sessionId = toSessionId(payload.context);
        if (!sessionId) {
          return;
        }
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          runningInputQueue: Array.isArray(payload.items) ? payload.items : [],
        }));
      })
    );

    unsubscribers.push(
      subscribe('running_input_queued', (data: unknown) => {
        const payload = data as {
          context?: ContextRef;
          item?: RunningInputQueueItemView;
        };
        const sessionId = toSessionId(payload.context ?? payload.item?.context);
        const queuedPrompt = String(payload.item?.prompt ?? '').trim();
        const clientRequestId = String(payload.item?.clientRequestId ?? '').trim();
        const pending = sessionId ? pendingRunningInputRequestBySessionRef.current[sessionId] : undefined;
        const currentRevision = sessionId
          ? (composerRevisionBySessionRef.current[resolveComposerInputKey(sessionId)] ?? 0)
          : 0;
        if (
          !sessionId ||
          !queuedPrompt ||
          !clientRequestId ||
          !pending ||
          pending.clientRequestId !== clientRequestId ||
          pending.composerRevision !== currentRevision
        ) {
          return;
        }
        delete pendingRunningInputRequestBySessionRef.current[sessionId];
        setRunningInputAckBySession((prev) => ({
          ...prev,
          [sessionId]: clientRequestId,
        }));
        setComposerInputBySession((prev) => {
          return clearComposerInputIfUnchanged(prev, sessionId, queuedPrompt);
        });
      })
    );

    unsubscribers.push(
      subscribe('running_input_error', (data: unknown) => {
        const payload = data as {
          context?: ContextRef;
          error?: string;
        };
        const sessionId = toSessionId(payload.context);
        if (!sessionId) {
          return;
        }
        const error = typeof payload.error === 'string' && payload.error.trim().length > 0
          ? payload.error.trim()
          : 'running_input_error';
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          error: t('runningInput.error', { error }),
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
          const now = Date.now();
          const currentStep = typeof payload.step === 'number' ? payload.step : runtime.currentStep;
          const maxSteps = typeof payload.maxSteps === 'number' ? payload.maxSteps : runtime.maxSteps;
          return applyStepRuntimeEvent({
            runtime,
            runId,
            step: payload.step,
            maxSteps: payload.maxSteps,
            now,
            processingTitle: t('app.running.processing'),
            stepTitle: t('app.running.stepStatus', { current: currentStep, max: maxSteps }),
            modelTitle: runtime.currentLlmRuntime?.model
              ? t('app.running.modelStatus', { model: runtime.currentLlmRuntime.model })
              : undefined,
            createEventId: () => createMessageId('live-run-status'),
          });
        });
      })
    );

    unsubscribers.push(
      subscribe('thinking', (data: unknown) => {
        const payload = data as { runId?: string; context?: ContextRef; thinking?: string; createdAt?: string };
        const sessionId = toSessionId(payload.context);
        const thinkingText = normalizeThinkingDeltaForDisplay(payload.thinking);
        if (!sessionId || typeof payload.runId !== 'string' || thinkingText === null) {
          return;
        }
        const runId = payload.runId;

        updateRuntime(sessionId, (runtime) => {
          const now = timestampFromServerCreatedAt(payload.createdAt);
          return applyThinkingRuntimeEvent({
            runtime,
            runId,
            thinking: thinkingText,
            timestamp: now,
            createEventId: () => createMessageId('live-thinking'),
          });
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
          createdAt?: string;
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
          const timestamp = timestampFromServerCreatedAt(payload.createdAt);
          return applyToolCallRuntimeEvent({
            runtime,
            runId,
            name,
            args,
            toolCallId,
            timestamp,
            createEventId: () => createMessageId('live-tool-call'),
          });
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
          createdAt?: string;
        };
        const sessionId = toSessionId(payload.context);
        if (!sessionId || typeof payload.runId !== 'string' || typeof payload.name !== 'string' || !payload.result) {
          return;
        }
        const name = payload.name;
        const result = payload.result;
        const runId = payload.runId;
        updateRuntime(sessionId, (runtime) => {
          const now = timestampFromServerCreatedAt(payload.createdAt);
          return applyToolResultRuntimeEvent({
            runtime,
            runId,
            name,
            result,
            timestamp: now,
            createEventId: () => createMessageId('live-tool-result'),
          });
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
          clientMessageId?: string;
          createdAt?: string;
        };
        const sessionId = toSessionId(payload.context);
        const content = normalizeTextDeltaForDisplay(payload.content);
        if (!sessionId || typeof payload.runId !== 'string' || content === null) {
          return;
        }
        const runId = payload.runId;
        if (payload.role === 'user') {
          appendMessage(sessionId, {
            id: String(payload.clientMessageId ?? '').trim() || `user-msg-${runId}`,
            role: 'user',
            content,
            timestamp: timestampFromServerCreatedAt(payload.createdAt),
          });
          return;
        }
        updateRuntime(sessionId, (runtime) => {
          if (payload.role === 'assistant' || !payload.role) {
            const now = timestampFromServerCreatedAt(payload.createdAt);
            return applyAssistantMessageDeltaRuntimeEvent({
              runtime,
              runId,
              content,
              timestamp: now,
              llmRuntime: payload.llmRuntime,
              createEventId: () => createMessageId('live-text'),
            });
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
        const content = String(payload.content ?? '');
        if (!sessionId || typeof payload.runId !== 'string' || !title || !content.replace(/\s+/g, ' ').trim()) {
          return;
        }
        const runId = payload.runId;
        updateRuntime(sessionId, (runtime) => {
          const now = Date.now();
          return applyMemoryTriggerRuntimeEvent({
            runtime,
            runId,
            title,
            content,
            liveTitle: t('app.live.memoryTrigger'),
            timestamp: now,
            createEventId: () => createMessageId('live-memory-trigger'),
          });
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
        updateRuntime(sessionId, (runtime) => {
          const now = Date.now();
          return applySkillTriggerRuntimeEvent({
            runtime,
            runId,
            name,
            action: payload.action,
            detail: payload.detail,
            version: payload.version,
            liveTitle: t('app.live.skillTrigger'),
            timestamp: now,
            createEventId: () => createMessageId('live-skill-trigger'),
          });
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
        console.info('[PlanInput] requested', {
          sessionId,
          runId: payload.runId,
          requestId: payload.requestId,
          questionCount: Array.isArray(payload.questions) ? payload.questions.length : 0,
        });
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
        console.info('[PlanInput] resolved', {
          sessionId,
          runId: payload.runId,
          requestId: payload.requestId,
        });
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
        if (currentSessionIdRef.current === sessionId) {
          void onRefreshGovernance(sessionId);
        }
        void fetchSessions();
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
        console.warn('[PlanInput] error', {
          sessionId,
          runId: payload.runId,
          requestId: payload.requestId,
          error,
        });
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
        const errorText = typeof payload.error === 'string' ? payload.error : 'Unknown error';
        const isRecoverableConflict =
          typeof payload.runId === 'string' && isContextEventVersionConflictError(errorText);
        updateRuntime(sessionId, (runtime) => {
          if (typeof payload.runId !== 'string') {
            return {
              ...runtime,
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
          if (isRecoverableConflict) {
            return finalizeRuntimeAfterRecoverableConflictError(runtime, payload.runId, Date.now());
          }
          const isCancelError = errorText.includes('cancel') || errorText.includes('abort') || errorText.includes('stopped');
          const nextRuntime = addIgnoredRunId(runtime, payload.runId);
          if (!isCancelError) {
            upsertRuntimeErrorMessage(sessionId, payload.runId, errorText);
          }
          return {
            ...nextRuntime,
            runId: null,
            runStartedAt: 0,
            isRunning: false,
          cancelAcknowledged: runtime.cancelInitiated || isCancelError ? true : runtime.cancelAcknowledged,
            cancelInitiated: false,
            cancelRequestedAt: 0,
            contextPrecompressActive: false,
            compressionStatus: null,
            liveEvents: closeStreamingThinking(nextRuntime.liveEvents),
            error: null,
            pendingPlanInput: null,
            pendingPlanInputError: null,
            currentLlmRuntime: null,
            activeRunOwner: null,
            interactionState: { mode: 'normal' },
          };
        });
        if (isRecoverableConflict && currentSessionIdRef.current === sessionId) {
          void loadSessionMessages(sessionId);
        }
      })
    );

    unsubscribers.push(
      subscribe('complete', (data: unknown) => {
        const payload = data as { context?: ContextRef; runId?: string; content?: string; sessionId?: string; createdAt?: string };
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
              timestamp: timestampFromServerCreatedAt(payload.createdAt),
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
          const completedAt = timestampFromServerCreatedAt(payload.createdAt);

          return {
            ...prev,
            [sessionId]: finalizeRuntimeAfterComplete(runtime, runId, completedAt),
          };
        });

        if (!currentSessionIdRef.current && payload.sessionId) {
          setCurrentSessionId(payload.sessionId);
        }
        setSessions((prev) =>
          prev.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  activeRun: null,
                  interactionState: { mode: 'normal' },
                }
              : session
          )
        );
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
          const shouldPreserveCancelledSnapshot = payload.terminalCode === 'cancelled';
          const errorText =
            payload.terminalCode === 'error' && !hasArtifact
              ? typeof payload.errorSummary === 'string' && payload.errorSummary.trim().length > 0
                ? payload.errorSummary
                : 'Run failed'
              : null;
          const isRecoverableConflict = errorText ? isContextEventVersionConflictError(errorText) : false;
          if (isRecoverableConflict) {
            return finalizeRuntimeAfterRecoverableConflictError(runtime, payload.runId, Date.now());
          }
          if (errorText) {
            upsertRuntimeErrorMessage(sessionId, payload.runId, errorText);
          }
          return {
            ...nextRuntime,
            runId: null,
            runStartedAt: 0,
            lastActivityAt: Date.now(),
            isRunning: false,
            cancelInitiated: false,
            cancelAcknowledged: payload.terminalCode === 'cancelled' ? true : runtime.cancelAcknowledged,
            cancelRequestedAt: 0,
            contextPrecompressActive: false,
            compressionStatus: null,
            liveEvents: shouldPreserveCancelledSnapshot ? closeStreamingThinking(nextRuntime.liveEvents) : [],
            contentAccumulator: shouldPreserveCancelledSnapshot ? nextRuntime.contentAccumulator : '',
            toolCallsAccumulator: shouldPreserveCancelledSnapshot ? nextRuntime.toolCallsAccumulator : [],
            toolResultsAccumulator: shouldPreserveCancelledSnapshot ? nextRuntime.toolResultsAccumulator : [],
            currentStep: typeof payload.lastSafeStep === 'number' ? payload.lastSafeStep : runtime.currentStep,
            maxSteps: typeof payload.maxSteps === 'number' ? payload.maxSteps : runtime.maxSteps,
            error: null,
            interruptedArtifact: payload.artifact ?? null,
            lastTerminalState: payload,
            pendingPlanInput: null,
            pendingPlanInputError: null,
            currentLlmRuntime: null,
            activeRunOwner: null,
            interactionState: { mode: 'normal' },
          };
        });

        if (currentSessionIdRef.current === sessionId) {
          void loadSessionMessages(sessionId);
          void onRefreshGovernance(sessionId);
        }
        setSessions((prev) =>
          prev.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  activeRun: null,
                  interactionState: { mode: 'normal' },
                }
              : session
          )
        );
        void fetchSessions();
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
            cancelInitiated: false,
            cancelAcknowledged: true,
            cancelRequestedAt: 0,
            contextPrecompressActive: false,
            compressionStatus: null,
            liveEvents: closeStreamingThinking(nextRuntime.liveEvents),
            pendingPlanInput: null,
            pendingPlanInputError: null,
            currentLlmRuntime: null,
            activeRunOwner: null,
            interactionState: { mode: 'normal' },
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
          usedChars?: number;
          limitChars?: number;
          usedTokens?: number;
          limitTokens?: number;
          source?: 'provider_usage' | 'weighted_char_estimate' | 'calibrated_weighted_estimate';
          anchorPromptTokens?: number;
          deltaEstimatedTokens?: number;
        };
        const sessionId = toSessionId(payload.context);
        const tokenRatio =
          typeof payload.usedTokens === 'number' &&
          typeof payload.limitTokens === 'number' &&
          payload.limitTokens > 0
            ? payload.usedTokens / payload.limitTokens
            : null;
        const ratio =
          tokenRatio ??
          (typeof payload.ratio === 'number'
            ? payload.ratio
            : typeof payload.utilizationRatio === 'number'
              ? payload.utilizationRatio
              : null);
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
              usedChars: typeof payload.usedChars === 'number' ? payload.usedChars : 0,
              limitChars: typeof payload.limitChars === 'number' ? payload.limitChars : 230000,
              usedTokens: payload.usedTokens,
              limitTokens: payload.limitTokens,
              source: payload.source,
              anchorPromptTokens: payload.anchorPromptTokens,
              deltaEstimatedTokens: payload.deltaEstimatedTokens,
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
    upsertRuntimeErrorMessage,
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
    (payload: {
      prompt: string;
      selectedAgentName?: string;
      planningAction?: 'enter_drafting';
      fileReferences?: string[];
    }): boolean => {
      const trimmedPrompt = payload.prompt.trim();
      if (!trimmedPrompt) {
        return false;
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
      if (
        currentRuntime?.isRunning &&
        currentRuntime.interactionState.mode !== 'observe_only' &&
        !isRuntimeLlmSelectionLocked(currentRuntime)
      ) {
        const clientRequestId = createRunningInputClientRequestId();
        pendingRunningInputRequestBySessionRef.current[sessionId] = {
          clientRequestId,
          prompt: trimmedPrompt,
          composerRevision: composerRevisionBySessionRef.current[resolveComposerInputKey(sessionId)] ?? 0,
        };
        const message = buildRunningInputEnqueueMessage({
          sessionId,
          prompt: trimmedPrompt,
          clientRequestId,
          selectedAgentName: payload.selectedAgentName,
          fileReferences: payload.fileReferences,
        });
        const sent = send(message);
        if (!sent) {
          delete pendingRunningInputRequestBySessionRef.current[sessionId];
          updateRuntime(sessionId, (runtime) => ({
            ...runtime,
            error: t('app.websocket.sendFailed'),
          }));
        }
        return sent;
      }
      if (isRuntimeInteractionLocked(currentRuntime)) {
        return false;
      }

      const nextPlanningState: SessionPlanningState = payload.planningAction === 'enter_drafting' ? 'plan_drafting' : 'normal';
      const clientMessageId = createMessageId('user-msg');
      upsertLocalDraftSession(sessionId, trimmedPrompt, workspaceDir, nextPlanningState);
      if (nextPlanningState !== 'normal') {
        setOptimisticPlanningStateBySession((prev) => ({
          ...prev,
          [sessionId]: nextPlanningState,
        }));
      }
      setPlanModeIntentBySession((prev) => {
        const next = { ...prev };
        delete next[sessionKey];
        delete next[sessionId];
        return next;
      });

      appendMessage(sessionId, {
        id: clientMessageId,
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

      const message = buildChatMessage({
        sessionId,
        prompt: trimmedPrompt,
        clientMessageId,
        selectedAgentName: payload.selectedAgentName,
        planningAction: payload.planningAction,
        fileReferences: payload.fileReferences,
        llmSelection: llmProfiles ? effectiveLlmSelection : undefined,
        workspaceDir,
      });

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
      return true;
    },
    [
      appendMessage,
      clearComposerInputForSession,
      currentSessionId,
      fetchSessions,
      runtimeBySession,
      llmProfiles,
      send,
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
    if (!runtime || cancelInFlight || runtime.interactionState.mode === 'observe_only') {
      return;
    }
    const runId = runtime?.runId;

    updateRuntime(currentSessionId, (state) => ({
      ...addIgnoredRunId(state, runId),
      runId: null,
      runStartedAt: 0,
      isRunning: false,
      cancelInitiated: true,
      cancelAcknowledged: false,
      cancelRequestedAt: Date.now(),
      contextPrecompressActive: false,
      compressionStatus: null,
      liveEvents: closeStreamingThinking(state.liveEvents),
      pendingPlanInput: null,
      pendingPlanInputError: null,
      currentLlmRuntime: null,
      activeRunOwner: null,
      interactionState: { mode: 'normal' },
    }));

    const sent = send(buildCancelRunMessage(currentSessionId, runId));
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

  const handleInsertRunningInput = useCallback(
    (itemId: string) => {
      if (!currentSessionId) {
        return;
      }
      const runtime = runtimeBySession[currentSessionId];
      if (!runtime?.runId || runtime.interactionState.mode === 'observe_only' || isRuntimeLlmSelectionLocked(runtime)) {
        return;
      }
      const sent = send(buildRunningInputInsertMessage({
        sessionId: currentSessionId,
        runId: runtime.runId,
        itemId,
      }));
      if (!sent) {
        updateRuntime(currentSessionId, (state) => ({
          ...state,
          error: t('app.websocket.sendFailed'),
        }));
      }
    },
    [currentSessionId, runtimeBySession, send, t, updateRuntime]
  );

  const sendRunningInputCancel = useCallback(
    (sessionId: string, itemId: string): boolean => {
      const sent = send(buildRunningInputCancelMessage(sessionId, itemId));
      if (!sent) {
        updateRuntime(sessionId, (state) => ({
          ...state,
          error: t('app.websocket.sendFailed'),
        }));
      }
      return sent;
    },
    [send, t, updateRuntime]
  );

  const handleCancelRunningInput = useCallback(
    (itemId: string) => {
      if (!currentSessionId) {
        return;
      }
      const runtime = runtimeBySession[currentSessionId];
      if (runtime?.interactionState.mode === 'observe_only') {
        return;
      }
      if (sendRunningInputCancel(currentSessionId, itemId)) {
        updateRuntime(currentSessionId, (state) => removeRunningInputQueueItem(state, itemId));
      }
    },
    [currentSessionId, runtimeBySession, sendRunningInputCancel, updateRuntime]
  );

  const handleEditRunningInput = useCallback(
    (item: RunningInputQueueItemView) => {
      const sessionId = toSessionId(item.context) ?? currentSessionId;
      if (!sessionId) {
        return;
      }
      const runtime = runtimeBySession[sessionId];
      if (runtime?.interactionState.mode === 'observe_only') {
        return;
      }
      if (!sendRunningInputCancel(sessionId, item.id)) {
        return;
      }
      const key = resolveComposerInputKey(sessionId);
      composerRevisionBySessionRef.current[key] = (composerRevisionBySessionRef.current[key] ?? 0) + 1;
      setComposerInputBySession((prev) => setComposerInput(prev, sessionId, item.prompt));
      setRunningInputEditRestoreBySession((prev) => ({
        ...prev,
        [sessionId]: {
          id: item.id,
          ...(item.fileReferences && item.fileReferences.length > 0 ? { fileReferences: item.fileReferences } : {}),
        },
      }));
      updateRuntime(sessionId, (state) => removeRunningInputQueueItem(state, item.id));
    },
    [currentSessionId, runtimeBySession, sendRunningInputCancel, updateRuntime]
  );

  const handleExitCurrentPlanExecution = useCallback(async () => {
    if (!currentSessionId) {
      return;
    }
    if (runtimeBySession[currentSessionId]?.interactionState.mode === 'observe_only') {
      return;
    }
    if (!window.confirm(t('chatInput.planMode.exitExecutingConfirm'))) {
      return;
    }
    try {
      await exitPlanExecution(currentSessionId, 'normal', 'Plan execution completed from UI');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!window.confirm(t('chatInput.planMode.exitForceConfirm', { message }))) {
        return;
      }
      try {
        await exitPlanExecution(currentSessionId, 'force', 'Plan execution force-exited from UI');
      } catch (forceError) {
        addToast({
          type: 'error',
          message: t('chatInput.planMode.exitFailed', {
            message: forceError instanceof Error ? forceError.message : String(forceError),
          }),
          autoDismiss: true,
        });
        return;
      }
    }
    setOptimisticPlanningStateBySession((prev) => ({
      ...prev,
      [currentSessionId]: 'normal',
    }));
    addToast({
      type: 'success',
      message: t('chatInput.planMode.exitSucceeded'),
      autoDismiss: true,
    });
    await fetchSessions();
    await loadSessionMessages(currentSessionId);
  }, [addToast, currentSessionId, fetchSessions, loadSessionMessages, runtimeBySession, t]);

  const handleExitCurrentPlanDraft = useCallback(async () => {
    const key = currentSessionId ?? COMPOSER_DRAFT_KEY;
    if (!currentSessionId) {
      setOptimisticPlanningStateBySession((prev) => ({
        ...prev,
        [key]: 'normal',
      }));
      return;
    }
    if (runtimeBySession[currentSessionId]?.interactionState.mode === 'observe_only') {
      return;
    }
    try {
      await exitPlanDraft(currentSessionId, 'Plan draft exited from UI');
    } catch (error) {
      addToast({
        type: 'error',
        message: t('chatInput.planMode.exitFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
        autoDismiss: true,
      });
      return;
    }
    setOptimisticPlanningStateBySession((prev) => ({
      ...prev,
      [currentSessionId]: 'normal',
    }));
    await fetchSessions();
    await loadSessionMessages(currentSessionId);
  }, [addToast, currentSessionId, fetchSessions, loadSessionMessages, runtimeBySession, t]);

  const handleSubmitPlanInput = useCallback(
    (answers: PlanInputAnswerPayload[]) => {
      if (!currentSessionId) {
        return;
      }
      const runtime = runtimeBySession[currentSessionId];
      const pending = runtime?.pendingPlanInput;
      const runId = runtime?.runId;
      if (runtime?.interactionState.mode === 'observe_only') {
        return;
      }
      if (!pending || !runId) {
        return;
      }
      const sent = send(buildPlanInputResponseMessage({
        runId,
        context: pending.context,
        requestId: pending.requestId,
        answers,
      }));
      if (!sent) {
        console.warn('[PlanInput] submit failed: websocket not connected', {
          sessionId: currentSessionId,
          runId,
          requestId: pending.requestId,
          answerCount: answers.length,
        });
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
      if (target?.interactionState?.mode === 'observe_only') {
        addToast({
          type: 'warning',
          message: t('app.session.observeOnly'),
          autoDismiss: true,
        });
        return;
      }
      if (target?.isLocalDraft) {
        setSessions((prev) =>
          prev.map((item) =>
            item.id === sessionId ? { ...item, name: normalizedName, updatedAt: new Date().toISOString() } : item
          )
        );
        return;
      }
      try {
        await renameSession(sessionId, normalizedName);
        await fetchSessions();
      } catch (error) {
        console.error('Failed to rename session:', error);
        alert(`${t('common.error')}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [addToast, fetchSessions, sessions, t]
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!window.confirm(t('app.deleteSession.confirm'))) {
        return;
      }
      const target = sessions.find((item) => item.id === sessionId);
      if (target?.interactionState?.mode === 'observe_only') {
        addToast({
          type: 'warning',
          message: t('app.session.observeOnly'),
          autoDismiss: true,
        });
        return;
      }
      try {
        await deleteSessionRequest(sessionId);
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
      addToast,
      onRefreshGovernance,
      removeComposerInputForSession,
      setCurrentSessionId,
      sessions,
      t,
    ]
  );

  const currentMessages = useMemo(
    () => resolveCurrentMessages(currentSessionId, messagesBySession),
    [currentSessionId, messagesBySession]
  );

  const currentRuntime = useMemo(
    () => resolveCurrentRuntime(currentSessionId, runtimeBySession),
    [currentSessionId, runtimeBySession]
  );
  const currentPlanningState = useMemo<SessionPlanningState>(
    () =>
      resolveCurrentPlanningState({
        currentSessionId,
        optimisticPlanningStateBySession,
        sessions,
      }),
    [currentSessionId, optimisticPlanningStateBySession, sessions]
  );
  const currentPlanModeIntent = useMemo(
    () => resolveCurrentPlanModeIntent(currentSessionId, planModeIntentBySession),
    [currentSessionId, planModeIntentBySession]
  );
  const setCurrentPlanModeIntent = useCallback(
    (enabled: boolean) => {
      setPlanModeIntentBySession((prev) =>
        setPlanModeIntentState({ state: prev, sessionId: currentSessionId, enabled })
      );
    },
    [currentSessionId]
  );
  const setCurrentPlanningState = useCallback(
    (state: SessionPlanningState) => {
      const key = currentSessionId ?? COMPOSER_DRAFT_KEY;
      setOptimisticPlanningStateBySession((prev) => {
        const next = { ...prev };
        if (state === 'normal') {
          delete next[key];
        } else {
          next[key] = state;
        }
        return next;
      });
    },
    [currentSessionId]
  );
  const currentInteractionLocked = useMemo(
    () => isRuntimeInteractionLocked(currentRuntime) || currentRuntime.interactionState.mode === 'observe_only',
    [currentRuntime]
  );
  const currentCanceling = useMemo(
    () => currentRuntime.cancelInitiated === true && currentRuntime.cancelAcknowledged !== true,
    [currentRuntime]
  );

  useEffect(() => {
    if (!currentSessionId) {
      lastInteractionLockDiagnosticRef.current = null;
      return;
    }
    const diagnostic = buildRuntimeInteractionLockDiagnostic({
      sessionId: currentSessionId,
      runtime: currentRuntime,
    });
    if (!diagnostic) {
      lastInteractionLockDiagnosticRef.current = null;
      return;
    }
    const { lastActivityAt: _lastActivityAt, ...stableDiagnostic } = diagnostic;
    const signature = JSON.stringify(stableDiagnostic);
    if (signature === lastInteractionLockDiagnosticRef.current) {
      return;
    }
    lastInteractionLockDiagnosticRef.current = signature;
    console.warn('[App] Chat input locked:', diagnostic);
  }, [currentSessionId, currentRuntime]);

  const runningSessionIds = useMemo(
    () => resolveRunningSessionIds(runtimeBySession),
    [runtimeBySession]
  );

  const pendingPlanInputSessions = useMemo(
    () => resolvePendingPlanInputSessions(runtimeBySession, sessions),
    [runtimeBySession, sessions]
  );

  const pendingPlanInputSessionIds = useMemo(
    () => resolvePendingPlanInputSessionIds(pendingPlanInputSessions),
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
    handleInsertRunningInput,
    handleEditRunningInput,
    handleCancelRunningInput,
    handleCancelCurrentRun,
    handleExitCurrentPlanDraft,
    handleExitCurrentPlanExecution,
    handleSubmitPlanInput,
    handleSelectSession,
    handleOpenAutomationSession,
    handleRenameSession,
    handleDeleteSession,
    currentMessages,
    currentRuntime,
    currentPlanningState,
    currentPlanModeIntent,
    currentRunningInputAckId: currentSessionId ? runningInputAckBySession[currentSessionId] : undefined,
    currentRunningInputEditRestore: currentSessionId ? runningInputEditRestoreBySession[currentSessionId] : undefined,
    setCurrentPlanModeIntent,
    setCurrentPlanningState,
    currentInteractionLocked,
    currentCanceling,
    currentLlmSelection,
    setCurrentSessionLlmSelection,
    runningSessionIds,
    pendingPlanInputSessions,
    pendingPlanInputSessionIds,
  };
}
