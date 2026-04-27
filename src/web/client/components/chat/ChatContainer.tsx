import React, { useEffect, useRef, useState } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n } from '../../i18n/index.js';
import type { Message, ToolResult } from '../../hooks/useAgent';
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
import type {
  InterruptedArtifactView,
  LlmProfilesConfigView,
  RuntimeCompressionStatus,
  RunLlmRuntimeView,
  SessionLlmSelectionPatch,
  SessionLlmSelectionView,
} from '../../app-shell-types.js';
import { inferToolResultSuccess } from '../../app-shell-types.js';

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
  isWarning: boolean;
  initializing: boolean;
}

interface ChatContainerProps {
  messages: Message[];
  liveEvents: LiveEvent[];
  pendingPlanInput: PlanInputRequestViewModel | null;
  pendingPlanInputError: string | null;
  onSubmitPlanInput: (answers: PlanInputAnswerViewModel[]) => void;
  input: string;
  setInput: (value: string) => void;
  onSend: (payload: { prompt: string; selectedAgentName?: string; usePlanMode?: boolean }) => void;
  onCancel?: () => void;
  onResumeInterruptedRun?: () => void;
  onDismissInterruptedArtifact?: () => void;
  isRunning: boolean;
  isCanceling?: boolean;
  canCancel?: boolean;
  isInteractionLocked?: boolean;
  error: string | null;
  interruptedArtifact?: InterruptedArtifactView | null;
  sessionId?: string | null;
  llmProfiles?: LlmProfilesConfigView | null;
  llmSelection?: SessionLlmSelectionView;
  onChangeLlmSelection?: (patch: SessionLlmSelectionPatch) => void;
  contextUtilization?: ContextUtilizationData | null;
  compressionStatus?: RuntimeCompressionStatus | null;
  currentStep?: number;
  maxSteps?: number;
}

export function ChatContainer({
  messages,
  liveEvents,
  pendingPlanInput,
  pendingPlanInputError,
  onSubmitPlanInput,
  input,
  setInput,
  onSend,
  onCancel,
  onResumeInterruptedRun,
  onDismissInterruptedArtifact,
  isRunning,
  isCanceling = false,
  canCancel = isRunning,
  isInteractionLocked = isRunning,
  error,
  interruptedArtifact = null,
  sessionId,
  llmProfiles = null,
  llmSelection,
  onChangeLlmSelection,
  contextUtilization,
  compressionStatus = null,
  currentStep = 0,
  maxSteps = 0,
}: ChatContainerProps) {
  const theme = useThemeConfig();
  const { t, locale } = useI18n();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const operationStartTimeRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

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

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [messages, liveEvents]);

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
    if (!isRunning || !compressionStatus) {
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
            {t('app.context.compression')}
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
  const visibleInterruptedArtifact =
    interruptedArtifact && !interruptedArtifact.dismissedAt ? interruptedArtifact : null;
  const interruptedToolResultSuccessById = new Map(
    (visibleInterruptedArtifact?.sideEffectLedger ?? [])
      .filter((entry) => typeof entry.toolCallId === 'string' && entry.toolCallId.trim().length > 0)
      .map((entry) => [String(entry.toolCallId), entry.resultSuccess !== false] as const)
  );

  const renderInterruptedArtifact = (): React.ReactNode => {
    if (!visibleInterruptedArtifact) {
      return null;
    }
    const previewMessages = visibleInterruptedArtifact.previewMessages.slice(-6);
    const statusTitle =
      visibleInterruptedArtifact.terminalCode === 'cancelled'
        ? `${t('app.running.cancel')}ed`
        : t('app.error.title');
    const statusSummary =
      visibleInterruptedArtifact.replayCutoffKind === 'checkpoint'
        ? `Saved through step ${visibleInterruptedArtifact.lastSafeStep}/${visibleInterruptedArtifact.maxSteps}. This saved progress is already part of future context.`
        : 'The run stopped before a replay-safe checkpoint was saved.';

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
            <div className="flex items-center gap-2">
              {visibleInterruptedArtifact.resumable && !isInteractionLocked && onResumeInterruptedRun ? (
                <button
                  type="button"
                  onClick={onResumeInterruptedRun}
                  className="rounded-lg border px-3 py-1 text-xs transition-colors"
                  style={{
                    borderColor: theme.colors.primary.DEFAULT,
                    color: theme.colors.primary.DEFAULT,
                  }}
                >
                  {t('subagent.resume')}
                </button>
              ) : null}
              {onDismissInterruptedArtifact && !isInteractionLocked ? (
                <button
                  type="button"
                  onClick={onDismissInterruptedArtifact}
                  className="rounded-lg border px-3 py-1 text-xs transition-colors"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    color: theme.colors.text.secondary,
                  }}
                >
                  {t('common.hide')}
                </button>
              ) : null}
            </div>
          </div>

          {previewMessages.length > 0 ? (
            <div className="space-y-3">
              {previewMessages.map((message, index) => {
                if (message.role === 'tool') {
                  return (
                    <ToolResultBlock
                      key={`interrupted-tool-${index}`}
                      name={message.name || 'tool'}
                      result={{
                        success:
                          interruptedToolResultSuccessById.get(String(message.toolCallId ?? '')) ??
                          inferToolResultSuccess(String(message.content ?? '')),
                        content: message.content,
                      }}
                    />
                  );
                }
                return (
                  <MessageItem
                    key={`interrupted-msg-${index}`}
                    message={{
                      id: `interrupted-msg-${index}`,
                      role: message.role === 'user' ? 'user' : 'assistant',
                      content: message.content,
                      timestamp: Date.now(),
                      thinking: message.thinking,
                      toolCalls: message.toolCalls?.map((toolCall) => ({
                        name: toolCall.function.name,
                        args: toolCall.function.arguments,
                      })),
                      toolResults: [],
                      metadata: message.metadata,
                    }}
                  />
                );
              })}
            </div>
          ) : null}
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

      <div ref={messagesViewportRef} className="chat-messages-viewport flex-1 overflow-y-auto px-5 py-4">
        <div className="chat-transcript mx-auto w-full space-y-3">
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
          <MessageItem key={msg.id} message={msg} />
          ))}

          {liveEvents.map((event) => {
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
              <PlanInputCard request={pendingPlanInput} error={pendingPlanInputError} onSubmit={onSubmitPlanInput} />
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
      </div>

      <div
        className="chat-composer-zone px-4 pb-4 pt-3"
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,0.16) 26%, rgba(0,0,0,0.22))',
        }}
      >
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
            onCancel={onCancel}
            isRunning={isRunning}
            isCanceling={isCanceling}
            canCancel={canCancel}
            isInteractionLocked={isInteractionLocked}
            llmProfiles={llmProfiles}
            llmSelection={llmSelection}
            onChangeLlmSelection={onChangeLlmSelection}
          />
        </div>
      </div>
    </div>
  );
}
