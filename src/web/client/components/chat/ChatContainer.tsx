import React, { useEffect, useRef, useState } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n } from '../../i18n/index.js';
import type { Message, ToolResult } from '../../chat-types';
import { MessageItem } from './MessageItem.js';
import { ThinkingBlock } from './ThinkingBlock.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { ToolResultBlock } from './ToolResultBlock.js';
import { LiveTriggerBlock } from './LiveTriggerBlock.js';
import {
  PlanInputCard,
  type PlanInputAnswerViewModel,
  type PlanInputRequestViewModel,
} from './PlanInputCard.js';
import { ChatInput } from './ChatInput.js';
import { ProcessingSkeleton } from '../common/LoadingSkeleton.js';
import {
  DEFAULT_CHAT_DISPLAY_FILTERS,
  loadChatDisplayFilters,
  saveChatDisplayFilters,
  type ChatDisplayFilters,
} from './chat-display-filters.js';
import {
  isChatScrolledNearBottom,
  shouldAutoScrollToLatest,
} from './chat-scroll-policy.js';
import type {
  InterruptedArtifactView,
  LlmProfilesConfigView,
  RuntimeCompressionStatus,
  RunLlmRuntimeView,
  RunningInputQueueItemView,
  SessionInteractionStateView,
  SessionLlmSelectionPatch,
  SessionLlmSelectionView,
  SessionPlanningState,
} from '../../app-shell-types.js';
import type { WSMessage } from '../../hooks/useWebSocket.js';
import type { RequestConfirm } from '../common/ConfirmDialog.js';

export type LiveEvent =
  | {
      id: string;
      type: 'text';
      content: string;
      llmRuntime?: RunLlmRuntimeView | null;
      timestamp: number;
    }
  | {
      id: string;
      type: 'thinking';
      thinking: string;
      isStreaming?: boolean;
      timestamp: number;
    }
  | {
      id: string;
      type: 'tool_call';
      toolCallId?: string;
      name: string;
      args: Record<string, unknown>;
      timestamp: number;
    }
  | {
      id: string;
      type: 'tool_result';
      name: string;
      result: ToolResult['result'];
      timestamp: number;
    }
  | {
      id: string;
      type: 'memory_trigger';
      title: string;
      summary: string;
      timestamp: number;
    }
  | {
      id: string;
      type: 'skill_trigger';
      title: string;
      summary: string;
      timestamp: number;
    }
  | {
      id: string;
      type: 'run_status';
      title: string;
      summary?: string;
      timestamp: number;
    };

export interface ContextUtilizationData {
  ratio: number;
  usedChars: number;
  limitChars: number;
  usedTokens?: number;
  limitTokens?: number;
  source?: 'provider_usage' | 'weighted_char_estimate' | 'calibrated_weighted_estimate';
  anchorPromptTokens?: number;
  deltaEstimatedTokens?: number;
  isWarning: boolean;
  initializing: boolean;
}

interface ChatContainerProps {
  messages: Message[];
  liveEvents: LiveEvent[];
  pendingPlanInput: PlanInputRequestViewModel | null;
  pendingPlanInputError: string | null;
  onSubmitPlanInput: (answers: PlanInputAnswerViewModel[]) => void;
  runningInputQueue?: RunningInputQueueItemView[];
  onInsertRunningInput?: (itemId: string) => void;
  onEditRunningInput?: (item: RunningInputQueueItemView) => void;
  onCancelRunningInput?: (itemId: string) => void;
  input: string;
  setInput: (value: string) => void;
  onSend: (payload: {
    prompt: string;
    selectedAgentName?: string;
    planningAction?: 'enter_drafting';
    fileReferences?: string[];
  }) => boolean;
  planningState?: SessionPlanningState;
  planModeIntent?: boolean;
  onPlanModeIntentChange?: (enabled: boolean) => void;
  onPlanningStateChange?: (state: SessionPlanningState) => void;
  onExitPlanDraft?: () => void | Promise<void>;
  onExitPlanExecution?: () => void | Promise<void>;
  requestConfirm?: RequestConfirm;
  onCancel?: () => void;
  isRunning: boolean;
  isCanceling?: boolean;
  isHydrating?: boolean;
  canCancel?: boolean;
  isInteractionLocked?: boolean;
  interactionState?: SessionInteractionStateView;
  runningInputAckId?: string;
  runningInputEditRestore?: { id: string; fileReferences?: string[] };
  error: string | null;
  interruptedArtifact?: InterruptedArtifactView | null;
  sessionId?: string | null;
  llmProfiles?: LlmProfilesConfigView | null;
  llmSelection?: SessionLlmSelectionView;
  currentLlmRuntime?: RunLlmRuntimeView | null;
  onChangeLlmSelection?: (patch: SessionLlmSelectionPatch) => void;
  shareActive?: boolean;
  shareDisabled?: boolean;
  onToggleShare?: () => void;
  forkDisabled?: boolean;
  onForkSession?: () => void;
  onResyncSession?: () => void | Promise<void>;
  showAutoLoopControl?: boolean;
  contextUtilization?: ContextUtilizationData | null;
  compressionStatus?: RuntimeCompressionStatus | null;
  currentStep?: number;
  maxSteps?: number;
  websocketConnected?: boolean;
  sendWebSocket?: (message: WSMessage) => boolean;
  subscribeWebSocket?: (type: string, listener: (data: unknown) => void) => () => void;
}

export function ChatContainer({
  messages,
  liveEvents,
  pendingPlanInput,
  pendingPlanInputError,
  onSubmitPlanInput,
  runningInputQueue = [],
  onInsertRunningInput,
  onEditRunningInput,
  onCancelRunningInput,
  input,
  setInput,
  onSend,
  planningState = 'normal',
  planModeIntent = false,
  onPlanModeIntentChange,
  onPlanningStateChange,
  onExitPlanDraft,
  onExitPlanExecution,
  requestConfirm,
  onCancel,
  isRunning,
  isCanceling = false,
  isHydrating = false,
  canCancel = isRunning,
  isInteractionLocked = isRunning,
  interactionState = { mode: 'normal' },
  runningInputAckId,
  runningInputEditRestore,
  error,
  interruptedArtifact = null,
  sessionId,
  llmProfiles = null,
  llmSelection,
  currentLlmRuntime = null,
  onChangeLlmSelection,
  shareActive = false,
  shareDisabled = false,
  onToggleShare,
  forkDisabled = false,
  onForkSession,
  onResyncSession,
  showAutoLoopControl = true,
  contextUtilization,
  compressionStatus = null,
  currentStep = 0,
  maxSteps = 0,
  websocketConnected = false,
  sendWebSocket,
  subscribeWebSocket,
}: ChatContainerProps) {
  const theme = useThemeConfig();
  const { t, locale } = useI18n();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const wasNearBottomBeforeUpdateRef = useRef(true);
  const lastScrollSessionKeyRef = useRef<string | null>(null);
  const lastScrollContentSignatureRef = useRef('');
  const operationStartTimeRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [displayFilters, setDisplayFilters] = useState<ChatDisplayFilters>(() => loadChatDisplayFilters());
  const [isUserReadingHistory, setIsUserReadingHistory] = useState(false);
  const [hasUnseenUpdates, setHasUnseenUpdates] = useState(false);

  useEffect(() => {
    if (isRunning && operationStartTimeRef.current === null) {
      operationStartTimeRef.current = Date.now();
      setElapsedSeconds(0);
      return;
    }
    if (!isRunning) {
      operationStartTimeRef.current = null;
      setElapsedSeconds(0);
    }
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const timer = setInterval(() => {
      if (operationStartTimeRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - operationStartTimeRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  const latestMessage = messages[messages.length - 1];
  const latestLiveEvent = liveEvents[liveEvents.length - 1];
  const scrollContentSignature = [
    sessionId ?? '',
    messages.length,
    latestMessage?.id ?? '',
    latestMessage?.role ?? '',
    latestMessage?.content?.length ?? 0,
    liveEvents.length,
    latestLiveEvent?.id ?? '',
    latestLiveEvent?.timestamp ?? '',
    latestLiveEvent?.type ?? '',
    latestLiveEvent && 'content' in latestLiveEvent ? latestLiveEvent.content.length : '',
    latestLiveEvent && 'thinking' in latestLiveEvent ? latestLiveEvent.thinking.length : '',
    pendingPlanInput?.requestId ?? '',
    runningInputQueue.map((item) => item.id).join(','),
  ].join('|');

  const scrollToLatest = (behavior: ScrollBehavior = 'auto'): void => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    if (typeof viewport.scrollTo === 'function') {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
    wasNearBottomBeforeUpdateRef.current = true;
    setIsUserReadingHistory(false);
    setHasUnseenUpdates(false);
  };

  const handleMessagesScroll = (): void => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    const nearBottom = isChatScrolledNearBottom(viewport);
    wasNearBottomBeforeUpdateRef.current = nearBottom;
    setIsUserReadingHistory(!nearBottom);
    if (nearBottom) {
      setHasUnseenUpdates(false);
    }
  };

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    const sessionKey = sessionId ?? '';
    const sessionChanged = lastScrollSessionKeyRef.current !== sessionKey;
    const contentChanged = lastScrollContentSignatureRef.current !== scrollContentSignature;
    lastScrollSessionKeyRef.current = sessionKey;
    lastScrollContentSignatureRef.current = scrollContentSignature;
    if (!contentChanged && !sessionChanged) {
      return;
    }
    if (
      shouldAutoScrollToLatest({
        sessionChanged,
        wasNearBottomBeforeUpdate: wasNearBottomBeforeUpdateRef.current,
        latestMessageRole: latestMessage?.role,
      })
    ) {
      scrollToLatest('auto');
      return;
    }
    setIsUserReadingHistory(true);
    setHasUnseenUpdates(true);
  }, [scrollContentSignature, sessionId, latestMessage?.role]);

  useEffect(() => {
    saveChatDisplayFilters(displayFilters);
  }, [displayFilters]);

  const toggleDisplayFilter = (key: keyof ChatDisplayFilters): void => {
    setDisplayFilters((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const shouldRenderLiveEvent = (event: LiveEvent): boolean => {
    if (event.type === 'thinking') {
      return displayFilters.showThinking;
    }
    if (event.type === 'tool_call') {
      return displayFilters.showToolCall;
    }
    if (event.type === 'tool_result') {
      if (event.name === 'send_file_to_user') {
        return false;
      }
      return displayFilters.showToolResult;
    }
    return true;
  };

  const getStreamingETA = (): string | null => {
    if (!isRunning || liveEvents.length === 0) {
      return null;
    }
    const hasStreaming = liveEvents.some((event) => event.type === 'thinking' && event.isStreaming);
    if (!hasStreaming) {
      return null;
    }
    if (currentStep > 0 && maxSteps > 0) {
      const progress = currentStep / maxSteps;
      const estimatedTotalMs = 30000;
      const remainingMs = Math.max(0, estimatedTotalMs - estimatedTotalMs * progress);
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      if (remainingSeconds < 60) {
        return t('app.running.remainingSeconds', { seconds: remainingSeconds });
      }
      return t('app.running.remainingMinutes', { minutes: Math.ceil(remainingSeconds / 60) });
    }
    return null;
  };

  const renderContextUtilization = () => {
    const displayContext = contextUtilization ?? {
      ratio: 0,
      usedChars: 0,
      limitChars: 230000,
      isWarning: false,
      initializing: true,
    };
    const { ratio, usedChars, limitChars, isWarning, initializing } = displayContext;
    const safeRatio = Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
    const percentage = Math.round(safeRatio * 100);
    const progressColor = isWarning
      ? ratio >= 0.95
        ? theme.colors.toolResult.error.text
        : theme.colors.toolCall.text
      : '#3b82f6';
    return (
      <div className="px-5 pt-4">
        <div
          className="mx-auto flex items-center gap-3 rounded-[1.1rem] border px-4 py-2"
          style={{
            maxWidth: 'var(--chat-readable-max)',
            backgroundColor: theme.colors.bg.secondary,
            borderColor: theme.colors.border.DEFAULT,
            boxShadow: theme.shadows.sm,
          }}
        >
          <span className="text-xs font-medium" style={{ color: theme.colors.text.secondary }}>
            {t('app.context.label')}
          </span>
          <div
            className="h-2 flex-1 overflow-hidden rounded-full"
            style={{ backgroundColor: theme.name === 'light' ? 'rgba(185,68,55,0.1)' : theme.colors.bg.tertiary }}
          >
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${Math.min(Math.max(percentage, 0), 100)}%`, backgroundColor: progressColor }}
            />
          </div>
          <span
            className="text-xs font-mono"
            style={{
              color: isWarning
                ? ratio >= 0.95
                  ? theme.colors.toolResult.error.text
                  : theme.colors.toolCall.text
                : theme.colors.text.secondary,
            }}
            title={`${usedChars}/${limitChars} chars`}
          >
            {percentage}%
          </span>
          <span className="text-xs" style={{ color: theme.colors.text.muted }}>
            {initializing ? (locale === 'zh-CN' ? '初始化中' : 'Initializing') : ''}
          </span>
        </div>
      </div>
    );
  };

  const renderCompressionStatus = (): React.ReactNode => {
    if (!compressionStatus) {
      return null;
    }
    const ratioFromContext = contextUtilization ? Math.round(contextUtilization.ratio * 100) : 0;
    const percentage =
      typeof compressionStatus.progressPercent === 'number'
        ? compressionStatus.progressPercent
        : typeof compressionStatus.ratio === 'number'
          ? Math.round(compressionStatus.ratio * 100)
          : ratioFromContext;
    const chunkSummary =
      typeof compressionStatus.chunkIndex === 'number' &&
      typeof compressionStatus.chunkTotal === 'number' &&
      compressionStatus.chunkTotal > 1
        ? ` ${compressionStatus.chunkIndex}/${compressionStatus.chunkTotal}`
        : '';
    return (
      <div className="flex justify-start">
        <div
          className="message-width-assistant w-full rounded-2xl border px-4 py-3 text-sm"
          style={{
            backgroundColor: theme.colors.assistantMessage.bg,
            borderColor: theme.colors.assistantMessage.border,
            color: theme.colors.text.secondary,
          }}
        >
          <div className="font-semibold" style={{ color: theme.colors.text.primary }}>
            {compressionStatus.source === 'replay_prepare'
              ? t('app.context.replayPrepare')
              : t('app.context.compression')}
          </div>
          <div className="mt-1 text-xs">
            {t('app.context.compressionProgress', { percentage })}
            {chunkSummary ? ` · chunk ${chunkSummary}` : ''}
          </div>
        </div>
      </div>
    );
  };

  const eta = getStreamingETA();
  const visibleInterruptedArtifact = interruptedArtifact ?? null;
  const observeOnly = interactionState.mode === 'observe_only';

  const renderInterruptedArtifact = (): React.ReactNode => {
    if (!visibleInterruptedArtifact) {
      return null;
    }
    const statusTitle =
      visibleInterruptedArtifact.terminalCode === 'cancelled'
        ? t('app.running.cancelled')
        : t('app.error.title');
    const statusSummary =
      visibleInterruptedArtifact.replayCutoffKind === 'checkpoint'
        ? t('app.interrupted.savedThroughCheckpoint', {
            lastSafeStep: visibleInterruptedArtifact.lastSafeStep,
            maxSteps: visibleInterruptedArtifact.maxSteps,
          })
        : t('app.interrupted.noReplayCheckpoint');

    return (
      <div className="flex justify-start">
        <div
          className="message-width-assistant w-full rounded-2xl border px-5 py-4 space-y-3"
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.08)',
            borderColor: 'rgba(239, 68, 68, 0.22)',
            color: theme.colors.text.primary,
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="text-sm font-semibold" style={{ color: theme.colors.text.primary }}>
                {statusTitle}
              </div>
              <div className="text-sm" style={{ color: theme.colors.text.secondary }}>
                {statusSummary}
              </div>
              {visibleInterruptedArtifact.errorSummary ? (
                <div className="text-sm" style={{ color: theme.colors.text.secondary }}>
                  {visibleInterruptedArtifact.errorSummary}
                </div>
              ) : null}
            </div>
            {onResyncSession ? (
              <button
                type="button"
                onClick={() => {
                  void onResyncSession();
                }}
                className="shrink-0 rounded-xl border px-3 py-1.5 text-xs font-semibold"
                style={{
                  borderColor: 'rgba(239, 68, 68, 0.28)',
                  backgroundColor: theme.colors.bg.secondary,
                  color: theme.colors.text.primary,
                }}
                data-testid="session-resync-button"
              >
                {t('app.session.sync')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      className="chat-panel-root flex h-full flex-col"
      data-current-session-id={sessionId ?? ''}
      style={{ background: theme.colors.bg.gradient }}
    >
      {renderContextUtilization()}

      <div
        ref={messagesViewportRef}
        className="chat-messages-viewport flex-1 overflow-y-auto px-5 py-4"
        onScroll={handleMessagesScroll}
      >
        <div className="chat-transcript mx-auto w-full space-y-3">
          {observeOnly && (
            <div
              className="message-width-assistant rounded-2xl border px-4 py-3 text-sm"
              style={{
                backgroundColor: theme.colors.assistantMessage.bg,
                borderColor: theme.colors.border.DEFAULT,
                color: theme.colors.text.secondary,
              }}
              data-testid="cli-observe-only-banner"
            >
              <div className="font-semibold" style={{ color: theme.colors.text.primary }}>
                {t('app.session.observeOnlyTitle')}
              </div>
              <div className="mt-1 text-xs">{t('app.session.observeOnlyDetail')}</div>
            </div>
          )}
          {messages.length === 0 && liveEvents.length === 0 && (
            <div className="flex min-h-full items-center justify-center">
              {isRunning ? (
                <div className="text-center rounded-2xl p-5" style={{ backgroundColor: theme.colors.bg.secondary }}>
                  <ProcessingSkeleton step={currentStep} maxSteps={maxSteps} />
                  <p className="mt-3 text-sm" style={{ color: theme.colors.text.muted }}>
                    {t('app.running.processingRequest')}
                  </p>
                </div>
              ) : (
                <div
                  className="text-center rounded-2xl px-6 py-4"
                  style={{
                    backgroundColor: theme.colors.bg.secondary,
                    color: theme.colors.text.muted,
                  }}
                >
                  <div className="mb-1 text-2xl">AI</div>
                  <p className="text-lg font-medium" style={{ color: theme.colors.text.secondary }}>
                    DPAgent
                  </p>
                  <p className="mt-0.5 text-sm">{t('app.empty.startConversation')}</p>
                </div>
              )}
            </div>
          )}

          {messages.map((msg) => (
          <MessageItem key={msg.id} message={msg} displayFilters={displayFilters} />
          ))}

          {liveEvents.map((event) => {
          if (!shouldRenderLiveEvent(event)) {
            return null;
          }
          if (event.type === 'text') {
            return (
              <MessageItem
                key={event.id}
                message={{
                  id: event.id,
                  role: 'assistant',
                  content: event.content,
                  timestamp: event.timestamp,
                  metadata: event.llmRuntime
                    ? {
                        llmProviderProfileId: event.llmRuntime.profileId,
                        llmProvider: event.llmRuntime.provider,
                        llmModel: event.llmRuntime.model,
                      }
                    : undefined,
                }}
                displayFilters={DEFAULT_CHAT_DISPLAY_FILTERS}
              />
            );
          }
          return (
            <div className="flex justify-start" key={event.id}>
              <div className="message-width-assistant w-full">
                {event.type === 'thinking' && <ThinkingBlock thinking={event.thinking} isStreaming={Boolean(event.isStreaming)} />}
                {event.type === 'tool_call' && <ToolCallBlock name={event.name} args={event.args} />}
                {event.type === 'tool_result' && <ToolResultBlock name={event.name} result={event.result} />}
                {event.type === 'memory_trigger' && (
                  <LiveTriggerBlock kind="memory" title={event.title} summary={event.summary} />
                )}
                {event.type === 'skill_trigger' && (
                  <LiveTriggerBlock kind="skill" title={event.title} summary={event.summary} />
                )}
                {event.type === 'run_status' && (
                  <div
                    className="rounded-2xl border px-4 py-3 text-sm"
                    style={{
                      backgroundColor: theme.colors.assistantMessage.bg,
                      borderColor: theme.colors.assistantMessage.border,
                      color: theme.colors.text.secondary,
                    }}
                  >
                    <div className="font-semibold" style={{ color: theme.colors.text.primary }}>
                      {event.title}
                    </div>
                    {event.summary ? <div className="mt-1 text-xs">{event.summary}</div> : null}
                  </div>
                )}
              </div>
            </div>
          );
          })}

          {renderCompressionStatus()}

          {isRunning && liveEvents.length > 0 && messages.length > 0 && (
          <div className="flex justify-start">
            <div
              className="message-width-assistant w-full px-4 py-3 rounded-2xl border streaming-progress"
              style={{
                backgroundColor: theme.colors.assistantMessage.bg,
                borderColor: theme.colors.assistantMessage.border,
              }}
            >
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="w-2 h-2 rounded-full animate-bounce"
                      style={{
                        backgroundColor: theme.colors.primary.DEFAULT,
                        animationDelay: `${i * 150}ms`,
                      }}
                    />
                  ))}
                </div>
                <div className="flex-1">
                  <span className="text-sm" style={{ color: theme.colors.text.secondary }}>
                    {elapsedSeconds < 10
                      ? t('app.running.processing')
                      : elapsedSeconds < 30
                        ? t('app.running.stillWorking')
                        : elapsedSeconds < 60
                          ? t('app.running.processingLong')
                          : t('app.running.pleaseWait')}
                    {currentStep > 0 &&
                      maxSteps > 0 &&
                      ` ${t('app.running.stepProgress', { current: currentStep, max: maxSteps })}`}
                    {elapsedSeconds >= 10 && elapsedSeconds < 30 && (
                      <span className="ml-2 text-xs opacity-70">{t('app.running.elapsedInline', { seconds: elapsedSeconds })}</span>
                    )}
                  </span>
                  {(elapsedSeconds >= 30 || eta) && (
                    <span className="text-xs ml-2" style={{ color: theme.colors.text.muted }}>
                      {eta || t('app.running.elapsed', { seconds: elapsedSeconds })}
                    </span>
                  )}
                </div>
                {elapsedSeconds >= 60 && onCancel && canCancel && (
                  <button
                    onClick={onCancel}
                    className="px-3 py-1 rounded-lg text-xs border transition-colors hover:bg-red-500/10"
                    style={{
                      borderColor: theme.colors.toolResult.error.text,
                      color: theme.colors.toolResult.error.text,
                    }}
                    title={t('app.running.cancel')}
                  >
                    {t('app.running.cancel')}
                  </button>
                )}
              </div>
              {(currentStep > 0 && maxSteps > 0) || elapsedSeconds >= 30 ? (
                <div className="mt-2">
                  <div className="h-1 rounded-full overflow-hidden relative" style={{ backgroundColor: theme.colors.bg.tertiary }}>
                    <div
                      className="h-full rounded-full transition-all duration-300 relative overflow-hidden"
                      style={{
                        width: currentStep > 0 && maxSteps > 0 ? `${Math.min((currentStep / maxSteps) * 100, 100)}%` : elapsedSeconds >= 60 ? '80%' : '60%',
                        backgroundColor: elapsedSeconds >= 60 ? theme.colors.toolResult.error.text : theme.colors.primary.DEFAULT,
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          )}

          {pendingPlanInput && (
          <div className="flex justify-start">
            <div className="message-width-assistant w-full">
              <PlanInputCard
                request={pendingPlanInput}
                error={pendingPlanInputError}
                disabled={observeOnly}
                disabledReason={observeOnly ? t('planInput.readOnly') : undefined}
                onSubmit={onSubmitPlanInput}
              />
            </div>
          </div>
          )}

          {renderInterruptedArtifact()}

          {error && (
          <div className="flex justify-center">
            <div
              className="rounded-2xl p-4 max-w-[80%] border"
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                borderColor: 'rgba(239, 68, 68, 0.3)',
                color: theme.colors.text.primary,
              }}
            >
              <div className="flex items-center gap-2 text-red-400 font-medium mb-1">
                <span>!</span>
                <span>{t('app.error.title')}</span>
              </div>
              <div className="text-sm">{error}</div>
            </div>
          </div>
          )}

          <div ref={messagesEndRef} />
        </div>
        {isUserReadingHistory && hasUnseenUpdates ? (
          <div className="sticky bottom-3 z-20 flex justify-center pt-2">
            <button
              type="button"
              onClick={() => scrollToLatest('smooth')}
              className="rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg transition-transform hover:-translate-y-0.5"
              style={{
                backgroundColor: theme.colors.bg.secondary,
                borderColor: theme.colors.primary.DEFAULT,
                color: theme.colors.primary.DEFAULT,
              }}
            >
              {t('chatMessages.jumpToLatest')}
            </button>
          </div>
        ) : null}
      </div>

      <div
        className="chat-composer-zone px-4 pb-4 pt-3"
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,0.16) 26%, rgba(0,0,0,0.22))',
        }}
      >
        {runningInputQueue.length > 0 && (
          <div className="mx-auto mb-2 flex w-full max-w-4xl flex-col gap-2">
            {runningInputQueue.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-lg border px-3 py-2 text-xs"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  backgroundColor: theme.colors.bg.secondary,
                  color: theme.colors.text.secondary,
                }}
              >
                <div className="min-w-0 flex-1 truncate">{item.prompt}</div>
                <button
                  type="button"
                  className="shrink-0 rounded-md border px-2 py-1 transition-opacity disabled:opacity-50"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    color: theme.colors.text.primary,
                  }}
                  disabled={isHydrating || observeOnly}
                  onClick={() => onEditRunningInput?.(item)}
                >
                  {t('runningInput.edit')}
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded-md border px-2 py-1 transition-opacity disabled:opacity-50"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    color: theme.colors.text.secondary,
                  }}
                  disabled={isHydrating || observeOnly}
                  onClick={() => onCancelRunningInput?.(item.id)}
                >
                  {t('runningInput.cancel')}
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded-md border px-2 py-1 transition-opacity disabled:opacity-50"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    color: theme.colors.text.primary,
                  }}
                  disabled={!isRunning || isCanceling || isHydrating || item.status === 'insert_requested' || observeOnly}
                  onClick={() => onInsertRunningInput?.(item.id)}
                >
                  {item.status === 'insert_requested'
                    ? t('runningInput.insertPending')
                    : t('runningInput.insert')}
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className="chat-composer-card mx-auto w-full rounded-[1.4rem] border"
          style={{
            borderColor: theme.colors.border.DEFAULT,
            backgroundColor: theme.colors.input.bg,
            boxShadow: theme.shadows.lg,
            backdropFilter: 'blur(18px)',
          }}
        >
          <ChatInput
            sessionId={sessionId}
            input={input}
            setInput={setInput}
            onSend={onSend}
            planningState={planningState}
            planModeIntent={planModeIntent}
            onPlanModeIntentChange={onPlanModeIntentChange}
            onPlanningStateChange={onPlanningStateChange}
            onExitPlanDraft={onExitPlanDraft}
            onExitPlanExecution={onExitPlanExecution}
            requestConfirm={requestConfirm}
            onCancel={onCancel}
            isRunning={isRunning}
            isCanceling={isCanceling}
            isHydrating={isHydrating}
            canCancel={canCancel}
            isInteractionLocked={isInteractionLocked}
            observeOnly={observeOnly}
            runningInputAckId={runningInputAckId}
            runningInputEditRestore={runningInputEditRestore}
            llmProfiles={llmProfiles}
            llmSelection={llmSelection}
            currentLlmRuntime={currentLlmRuntime}
            onChangeLlmSelection={onChangeLlmSelection}
            shareActive={shareActive}
            shareDisabled={shareDisabled}
            onToggleShare={onToggleShare}
            forkDisabled={forkDisabled}
            onForkSession={onForkSession}
            showAutoLoopControl={showAutoLoopControl}
            displayFilters={displayFilters}
            onToggleDisplayFilter={toggleDisplayFilter}
            websocketConnected={websocketConnected}
            sendWebSocket={sendWebSocket}
            subscribeWebSocket={subscribeWebSocket}
          />
        </div>
      </div>
    </div>
  );
}
