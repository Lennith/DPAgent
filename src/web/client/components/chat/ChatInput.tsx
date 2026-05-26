import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n } from '../../i18n/index.js';
import AutoLoopControl from '../auto-loop/AutoLoopControl.js';
import { SessionLlmBar } from './SessionLlmBar.js';
import { useAgentMention } from './useAgentMention.js';
import { useComposerDropPath } from './useComposerDropPath.js';
import { INPUT_SOFT_LIMIT, TEXTAREA_FIXED_HEIGHT } from './chat-input-constants.js';
import { useChatInputOnboarding } from './useChatInputOnboarding.js';
import { useVoiceInput } from './useVoiceInput.js';
import { LocalFilePickerModal } from '../common/LocalFilePickerModal.js';
import { mergeFileReferences } from './fileReferencePrompt.js';
import type { WSMessage } from '../../hooks/useWebSocket.js';
import type { ChatDisplayFilters } from './chat-display-filters.js';
import {
  resolveChatInputInteractivity,
  resolveComposerPlanModeButtonClick,
  resolveComposerPlanningAction,
} from './chat-input-interactivity.js';
import type {
  LlmProfilesConfigView,
  RunLlmRuntimeView,
  SessionLlmSelectionPatch,
  SessionLlmSelectionView,
  SessionPlanningState,
} from '../../app-shell-types.js';

interface ChatInputProps {
  sessionId?: string | null;
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
  onCancel?: () => void;
  isRunning: boolean;
  isCanceling?: boolean;
  isHydrating?: boolean;
  canCancel?: boolean;
  isInteractionLocked?: boolean;
  observeOnly?: boolean;
  runningInputAckId?: string;
  runningInputEditRestore?: { id: string; fileReferences?: string[] };
  llmProfiles?: LlmProfilesConfigView | null;
  llmSelection?: SessionLlmSelectionView;
  currentLlmRuntime?: RunLlmRuntimeView | null;
  onChangeLlmSelection?: (patch: SessionLlmSelectionPatch) => void;
  shareActive?: boolean;
  shareDisabled?: boolean;
  onToggleShare?: () => void;
  showAutoLoopControl?: boolean;
  displayFilters?: ChatDisplayFilters;
  onToggleDisplayFilter?: (key: keyof ChatDisplayFilters) => void;
  websocketConnected?: boolean;
  sendWebSocket?: (message: WSMessage) => boolean;
  subscribeWebSocket?: (type: string, listener: (data: unknown) => void) => () => void;
}

export function ChatInput({
  sessionId,
  input,
  setInput,
  onSend,
  planningState = 'normal',
  planModeIntent = false,
  onPlanModeIntentChange,
  onPlanningStateChange,
  onExitPlanDraft,
  onExitPlanExecution,
  onCancel,
  isRunning,
  isCanceling: isCancelingProp,
  isHydrating = false,
  canCancel = isRunning,
  isInteractionLocked = isRunning,
  observeOnly = false,
  runningInputAckId,
  runningInputEditRestore,
  llmProfiles = null,
  llmSelection,
  currentLlmRuntime = null,
  onChangeLlmSelection,
  shareActive = false,
  shareDisabled = false,
  onToggleShare,
  showAutoLoopControl = true,
  displayFilters,
  onToggleDisplayFilter,
  websocketConnected = false,
  sendWebSocket,
  subscribeWebSocket,
}: ChatInputProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const interactivity = resolveChatInputInteractivity({
    isRunning,
    isInteractionLocked,
    isCanceling: isCancelingProp,
    isHydrating,
    observeOnly,
    hasDraftContent: input.trim().length > 0,
  });
  const isCanceling = interactivity.isCanceling;
  const isTurnActive = interactivity.isTurnActive;
  const isDraftInputDisabled = interactivity.draftInputDisabled;
  const settingsDisabled = interactivity.settingsDisabled;
  const canSubmitMessage = interactivity.canSubmitMessage;
  const sendButtonMode = interactivity.sendButtonMode;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceInput = useVoiceInput({
    sessionId,
    input,
    setInput,
    textareaRef,
    disabled: isDraftInputDisabled || observeOnly,
    websocketConnected,
    sendWebSocket,
    subscribeWebSocket,
  });
  const [isTextareaOverflowing, setIsTextareaOverflowing] = useState(false);
  const [fileReferenceChips, setFileReferenceChips] = useState<string[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const pendingActiveRunSubmitRef = useRef<string | null>(null);
  const appliedRunningInputEditRestoreRef = useRef<string | null>(null);
  const { sessionVisitCount, onboardingVisible, dismissOnboarding } = useChatInputOnboarding();
  const {
    selectedAgent,
    mentionError,
    setMentionError,
    mentionCandidates,
    mentionOpen,
    mentionLoading,
    activeMentionIndex,
    setActiveMentionIndex,
    hasMentionCandidate,
    clearSelectedAgentForCurrentSession,
    applyAgentSelection,
    closeMention,
  } = useAgentMention({
    sessionId,
    input,
    setInput,
    disabled: isDraftInputDisabled,
  });

  const capabilityHint = useMemo(() => {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith('@')) {
      return t('chatInput.hint.delegate');
    }
    if (/\bsubagent\b|\bparallel\b/.test(trimmed)) {
      return t('chatInput.hint.subagent');
    }
    return null;
  }, [input, t]);

  const pushFileReferenceChips = useCallback((references: string[]): void => {
    if (references.length === 0) {
      return;
    }
    setFileReferenceChips((prev) => mergeFileReferences(prev, references, 8));
  }, []);

  useEffect(() => {
    setFileReferenceChips([]);
  }, [sessionId]);

  const updateTextareaOverflowState = useCallback((): void => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    setIsTextareaOverflowing(textarea.scrollHeight > textarea.clientHeight + 1);
  }, []);

  const insertFileReferences = useCallback(
    (references: string[]): void => {
      const normalized = references.map((reference) => String(reference ?? '').trim()).filter((reference) => reference.length > 0);
      if (normalized.length === 0) {
        return;
      }
      pushFileReferenceChips(normalized);
      setMentionError(null);
    },
    [pushFileReferenceChips, setMentionError]
  );

  const handleFilePickerClick = useCallback((): void => {
    if (isDraftInputDisabled) {
      return;
    }
    setFilePickerOpen(true);
  }, [isDraftInputDisabled]);

  const {
    isDropTargetActive,
    dropFeedback,
    setDropFeedbackMessage,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useComposerDropPath({
    sessionId,
    disabled: isDraftInputDisabled,
    onFileReferencesResolved: insertFileReferences,
    setMentionError,
    t,
  });

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      updateTextareaOverflowState();
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [input, updateTextareaOverflowState]);

  const handleTextareaScroll = (): void => {
    updateTextareaOverflowState();
  };

  const handleSubmit = (): void => {
    const trimmedInput = input.trim();
    const prompt = trimmedInput || (fileReferenceChips.length > 0 ? t('chatInput.fileReferences.defaultPrompt') : '');
    if (selectedAgent && !prompt) {
      setMentionError(t('chatInput.mention.requireMessage'));
      return;
    }
    if (!prompt || !canSubmitMessage) {
      return;
    }
    const planningAction = resolveComposerPlanningAction(planningState, planModeIntent);
    const accepted = onSend({
      prompt,
      selectedAgentName: selectedAgent?.name,
      ...(planningAction ? { planningAction } : {}),
      ...(fileReferenceChips.length > 0 ? { fileReferences: fileReferenceChips } : {}),
    });
    if (!accepted) {
      return;
    }
    if (voiceInput.isRecording) {
      voiceInput.cancelRecording();
    }
    if (isTurnActive) {
      pendingActiveRunSubmitRef.current = null;
      return;
    }
    setFileReferenceChips([]);
    closeMention();
    setMentionError(null);
  };

  useEffect(() => {
    if (!runningInputAckId || pendingActiveRunSubmitRef.current === runningInputAckId) {
      return;
    }
    pendingActiveRunSubmitRef.current = runningInputAckId;
    setFileReferenceChips([]);
    closeMention();
    setMentionError(null);
  }, [closeMention, runningInputAckId, setMentionError]);

  useEffect(() => {
    if (!runningInputEditRestore || appliedRunningInputEditRestoreRef.current === runningInputEditRestore.id) {
      return;
    }
    appliedRunningInputEditRestoreRef.current = runningInputEditRestore.id;
    setFileReferenceChips(runningInputEditRestore.fileReferences ?? []);
  }, [runningInputEditRestore]);

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (isDraftInputDisabled) {
      return;
    }
    if (mentionOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (mentionCandidates.length === 0) {
        return;
      }
      if (e.key === 'ArrowDown') {
        setActiveMentionIndex((prev) => (prev + 1) % mentionCandidates.length);
      } else {
        setActiveMentionIndex((prev) => (prev - 1 + mentionCandidates.length) % mentionCandidates.length);
      }
      return;
    }
    if (mentionOpen && e.key === 'Enter' && !e.shiftKey && mentionCandidates.length > 0) {
      e.preventDefault();
      const candidate = mentionCandidates[activeMentionIndex] ?? mentionCandidates[0];
      if (candidate) {
        applyAgentSelection(candidate);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (!canSubmitMessage) {
        return;
      }
      e.preventDefault();
      handleSubmit();
    }
  };

  const planModeLabel =
    planningState === 'plan_drafting'
      ? t('chatInput.planMode.stateDrafting')
      : planningState === 'plan_executing'
        ? t('chatInput.planMode.stateExecuting')
        : planModeIntent
          ? t('chatInput.planMode.stateDrafting')
          : t('chatInput.planMode.label');
  const planModeActive = planningState !== 'normal' || planModeIntent;
  const planModeButtonDisabled =
    settingsDisabled ||
    (planningState === 'plan_executing'
      ? !onExitPlanExecution
      : planningState === 'plan_drafting'
        ? isRunning || (!onExitPlanDraft && !onPlanningStateChange)
        : !onPlanModeIntentChange);
  const handlePlanModeButtonClick = () => {
    const effect = resolveComposerPlanModeButtonClick({
      planningState,
      planModeIntent,
      disabled: planModeButtonDisabled,
    });
    if (effect.kind === 'exit_plan_execution') {
      void onExitPlanExecution?.();
      return;
    }
    if (effect.kind === 'none') {
      return;
    }
    if (effect.kind === 'exit_plan_draft') {
      if (!window.confirm(t('chatInput.planMode.exitDraftConfirm'))) {
        return;
      }
      if (onExitPlanDraft) {
        void onExitPlanDraft();
        return;
      }
      onPlanningStateChange?.('normal');
      return;
    }
    onPlanModeIntentChange?.(effect.enabled);
  };
  const renderDisplayFilterButton = (key: keyof ChatDisplayFilters, label: string): React.ReactNode => {
    if (!displayFilters || !onToggleDisplayFilter) {
      return null;
    }
    const active = displayFilters[key];
    return (
      <button
        type="button"
        className="composer-display-filter-button inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-xl border px-2 text-[11px] font-semibold transition-all duration-200"
        style={{
          borderColor: active ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
          backgroundColor: active ? `${theme.colors.primary.DEFAULT}20` : theme.colors.bg.secondary,
          color: active ? theme.colors.primary.DEFAULT : theme.colors.text.muted,
        }}
        aria-pressed={active}
        title={`${label}: ${active ? 'shown' : 'hidden'}`}
        data-testid={`composer-display-filter-${label.toLowerCase()}`}
        onClick={() => onToggleDisplayFilter(key)}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="w-full px-4 py-3">
      {onboardingVisible && (
        <div
          className="mb-3 rounded-xl border px-3 py-2 flex items-start justify-between gap-3"
          style={{
            borderColor: theme.colors.border.DEFAULT,
            backgroundColor: theme.colors.bg.secondary,
            color: theme.colors.text.secondary,
          }}
        >
          <div className="text-xs leading-relaxed">
            {t('chatInput.onboarding', { count: sessionVisitCount })}
          </div>
          <button
            type="button"
            onClick={dismissOnboarding}
            className="text-xs"
            style={{ color: theme.colors.text.muted }}
          >
            {t('chatInput.dismissOnboarding')}
          </button>
        </div>
      )}
      <div className="composer-control-stack mb-3 flex items-center justify-end gap-2" data-testid="composer-control-row">
        <div className="composer-settings-row flex min-w-0 items-center justify-end gap-2">
          <div className="composer-primary-controls flex min-w-0 items-center gap-2">
            {selectedAgent && (
              <button
                type="button"
                onClick={clearSelectedAgentForCurrentSession}
                disabled={isDraftInputDisabled}
                className="composer-agent-chip inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-1.5 text-xs transition-opacity disabled:opacity-60 max-w-[220px]"
                style={{
                  borderColor: theme.colors.primary.DEFAULT,
                  color: theme.colors.primary.DEFAULT,
                  backgroundColor: `${theme.colors.primary.DEFAULT}18`,
                }}
                title={t('chatInput.clearSelectedAgent', { name: selectedAgent.name })}
              >
                <span className="truncate">{t('chatInput.toAgent', { name: selectedAgent.name })}</span>
                <span className="font-semibold leading-none">x</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleFilePickerClick}
              disabled={isDraftInputDisabled}
              className="h-8 w-8 shrink-0 rounded-full border text-base leading-none transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.secondary,
                color: theme.colors.text.secondary,
              }}
              title={t('chatInput.filePicker.title')}
              aria-label={t('chatInput.filePicker.title')}
              data-testid="chat-add-file-button"
            >
              +
            </button>
            {!observeOnly && llmSelection && onChangeLlmSelection && (
              <button
                type="button"
                onClick={handlePlanModeButtonClick}
                disabled={planModeButtonDisabled}
                className="shrink-0 text-xs px-2.5 py-1.5 rounded-xl border transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  borderColor: planModeActive ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
                  backgroundColor: planModeActive ? `${theme.colors.primary.DEFAULT}22` : theme.colors.bg.secondary,
                  color: planModeActive ? theme.colors.primary.DEFAULT : theme.colors.text.secondary,
                }}
                title={t('chatInput.planMode.title')}
              >
                {planModeLabel}
              </button>
            )}
            {observeOnly && (currentLlmRuntime || llmSelection) && (
              <div
                className="inline-flex min-w-0 items-center gap-2 rounded-xl border px-3 py-1.5 text-xs"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  backgroundColor: theme.colors.bg.secondary,
                  color: theme.colors.text.secondary,
                }}
                data-testid="cli-readonly-runtime"
                title={currentLlmRuntime?.model ?? llmSelection?.model}
              >
                <span className="font-semibold" style={{ color: theme.colors.primary.DEFAULT }}>CLI</span>
                <span className="truncate max-w-[220px]">{currentLlmRuntime?.model ?? llmSelection?.model}</span>
                <span style={{ color: theme.colors.text.muted }}>{currentLlmRuntime?.reasoningPreset ?? llmSelection?.reasoningPreset}</span>
                <span style={{ color: theme.colors.text.muted }}>{planModeLabel}</span>
              </div>
            )}
            {!observeOnly && llmSelection && onChangeLlmSelection && (
              <div className="composer-llm-slot min-w-0" data-testid="composer-llm-slot">
                <SessionLlmBar
                  sessionId={sessionId}
                  llmProfiles={llmProfiles}
                  selection={llmSelection}
                  disabled={settingsDisabled}
                  onChange={onChangeLlmSelection}
                  shareActive={shareActive}
                  shareDisabled={shareDisabled}
                  onToggleShare={onToggleShare}
                />
              </div>
            )}
          </div>
          <div className="composer-secondary-controls flex min-w-0 items-center gap-2">
            {displayFilters && onToggleDisplayFilter && (
              <div className="composer-display-filter-group inline-flex shrink-0 items-center gap-1" data-testid="composer-display-filter-group">
                {renderDisplayFilterButton('showThinking', 'TB')}
                {renderDisplayFilterButton('showToolCall', 'TC')}
                {renderDisplayFilterButton('showToolResult', 'TR')}
              </div>
            )}
            {showAutoLoopControl && !observeOnly && <div className="composer-ralph-slot min-w-0" data-testid="composer-ralph-slot">
              <AutoLoopControl sessionId={sessionId ?? null} disabled={settingsDisabled} compact />
            </div>}
          </div>
        </div>
      </div>

      <div className="relative">
        {mentionOpen && !selectedAgent && (
          <div
            className="absolute left-0 right-0 bottom-full mb-2 rounded-xl border z-30"
            style={{
              borderColor: theme.colors.border.DEFAULT,
              backgroundColor: theme.colors.bg.secondary,
            }}
          >
            {mentionLoading ? (
                <div className="px-3 py-2 text-xs" style={{ color: theme.colors.text.muted }}>
                {t('chatInput.mention.loading')}
                </div>
              ) : mentionCandidates.length === 0 ? (
                <div className="px-3 py-2 text-xs" style={{ color: theme.colors.text.muted }}>
                {t('chatInput.mention.noMatch')}
                </div>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                {mentionCandidates.map((candidate, index) => {
                  const isActive = index === activeMentionIndex;
                  return (
                    <button
                      key={`${candidate.name}-${candidate.mtime}`}
                      type="button"
                      className="w-full text-left px-3 py-2 border-b last:border-b-0"
                      style={{
                        borderColor: theme.colors.border.DEFAULT,
                        backgroundColor: isActive ? `${theme.colors.primary.DEFAULT}1f` : 'transparent',
                      }}
                      onMouseEnter={() => setActiveMentionIndex(index)}
                      onClick={() => applyAgentSelection(candidate)}
                    >
                      <div className="text-sm font-medium" style={{ color: theme.colors.text.primary }}>
                        @{candidate.name}
                      </div>
                      <div className="text-xs" style={{ color: theme.colors.text.secondary }}>
                        {candidate.description || t('chatInput.mention.noSummary')}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div
          className={`relative flex items-start gap-3 p-4 rounded-2xl border transition-all duration-300 focus-within:ring-2 ${
            isRunning ? 'sending-pulse' : ''
          }`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            backgroundColor: theme.colors.bg.tertiary,
            borderColor: isDropTargetActive
              ? theme.colors.primary.DEFAULT
              : selectedAgent
                ? theme.colors.primary.DEFAULT
                : theme.colors.border.DEFAULT,
            boxShadow: isDropTargetActive
              ? `0 0 0 2px ${theme.colors.primary.DEFAULT}40`
              : selectedAgent
                ? `0 0 0 1px ${theme.colors.primary.DEFAULT}40`
                : 'none',
            opacity: isInteractionLocked ? 0.92 : 1,
            overflow: 'hidden',
            borderStyle: isDropTargetActive ? 'dashed' : 'solid',
          }}
        >
          <div className="flex-1 min-w-0 w-full flex flex-col min-h-[24px]">
            {fileReferenceChips.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {fileReferenceChips.map((reference) => (
                  <span
                    key={reference}
                    className="inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px]"
                    style={{
                      borderColor: theme.colors.border.DEFAULT,
                      backgroundColor: theme.colors.bg.secondary,
                      color: theme.colors.text.secondary,
                    }}
                    title={reference}
                  >
                    <span className="truncate">{reference}</span>
                    <button
                      type="button"
                      className="font-semibold"
                      onClick={() => setFileReferenceChips((prev) => prev.filter((item) => item !== reference))}
                      aria-label={t('chatInput.fileReferences.remove')}
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              data-testid="chat-input-textarea"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (mentionError) {
                  setMentionError(null);
                }
                if (dropFeedback) {
                  setDropFeedbackMessage(null);
                }
              }}
              onKeyDown={handleKeyDown}
              onScroll={handleTextareaScroll}
              placeholder={
                isCanceling
                  ? t('chatInput.placeholder.canceling')
                  : isDraftInputDisabled
                    ? t('chatInput.placeholder.running')
                    : t('chatInput.placeholder.default')
              }
              disabled={isDraftInputDisabled}
              className="w-full bg-transparent resize-none outline-none text-sm leading-relaxed pt-0 pb-1 block disabled:opacity-70"
              style={{
                color: theme.colors.text.primary,
                height: `${TEXTAREA_FIXED_HEIGHT}px`,
                minHeight: `${TEXTAREA_FIXED_HEIGHT}px`,
                maxHeight: `${TEXTAREA_FIXED_HEIGHT}px`,
                overflowY: isTextareaOverflowing ? 'auto' : 'hidden',
              }}
            />
            {isTextareaOverflowing && (
              <div className="flex items-center justify-center py-1 text-[10px] opacity-50" style={{ color: theme.colors.text.muted }}>
                <svg className="w-3 h-3 mr-1 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
                {t('chatInput.scrollForMore')}
              </div>
            )}
            <div className="flex justify-end py-1 text-[10px]" style={{ color: theme.colors.text.muted }}>
              <span className={input.length > INPUT_SOFT_LIMIT ? 'text-red-400' : input.length > INPUT_SOFT_LIMIT - 1000 ? 'text-yellow-400' : ''}>
                {input.length}
              </span>
              <span className="mx-1">/</span>
              <span>{INPUT_SOFT_LIMIT}</span>
              {input.length > INPUT_SOFT_LIMIT - 200 && <span className="ml-2 text-red-400">{t('chatInput.charsRemaining')}</span>}
            </div>
            {isDropTargetActive && (
              <div className="text-center text-xs pb-1" style={{ color: theme.colors.primary.DEFAULT }}>
                {t('chatInput.dropTargetHint')}
              </div>
            )}
          </div>

          {!observeOnly && <div className="flex items-center gap-2">
            {voiceInput.shouldShowButton && <button
              type="button"
              onClick={voiceInput.toggleRecording}
              disabled={!voiceInput.canRecord || voiceInput.state === 'transcribing' || voiceInput.state === 'checking'}
              className="composer-voice-button inline-flex shrink-0 items-center justify-center rounded-xl border font-medium transition-all duration-300 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{
                borderColor: voiceInput.isRecording ? '#ef4444' : theme.colors.border.DEFAULT,
                background: voiceInput.isRecording
                  ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                  : voiceInput.state === 'transcribing'
                    ? `${theme.colors.primary.DEFAULT}22`
                    : theme.colors.bg.secondary,
                color: voiceInput.isRecording
                  ? theme.colors.text.inverse
                  : voiceInput.state === 'transcribing'
                    ? theme.colors.primary.DEFAULT
                    : theme.colors.text.secondary,
                boxShadow: voiceInput.isRecording ? theme.shadows.glow : 'none',
              }}
              title={
                voiceInput.isRecording
                  ? t('chatInput.voice.stop', { seconds: voiceInput.recordingSeconds })
                  : voiceInput.state === 'transcribing'
                    ? t('chatInput.voice.transcribing')
                    : voiceInput.error
                      ? t('chatInput.voice.error', { message: voiceInput.error })
                      : !voiceInput.canRecord
                        ? t('chatInput.voice.unavailable')
                        : t('chatInput.voice.start')
              }
              aria-label={voiceInput.isRecording ? t('chatInput.voice.stop', { seconds: voiceInput.recordingSeconds }) : t('chatInput.voice.start')}
              data-testid="chat-voice-input"
            >
              {voiceInput.state === 'transcribing' ? (
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v3m0 12v3m9-9h-3M6 12H3m15.36-6.36-2.12 2.12M7.76 16.24l-2.12 2.12m12.72 0-2.12-2.12M7.76 7.76 5.64 5.64" />
                </svg>
              ) : voiceInput.isRecording ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 7h10v10H7z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 10v2a7 7 0 0 1-14 0v-2m7 9v3m-4 0h8" />
                </svg>
              )}
            </button>}
            <button
              type="button"
              onClick={sendButtonMode === 'stop' ? onCancel : handleSubmit}
              disabled={
                sendButtonMode === 'stop'
                  ? !onCancel || !canCancel
                  : !canSubmitMessage || (!input.trim() && fileReferenceChips.length === 0)
              }
              className="p-3 rounded-xl font-medium transition-all duration-300 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{
                background: sendButtonMode === 'stop'
                  ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                  : (input.trim() || fileReferenceChips.length > 0) && canSubmitMessage
                    ? theme.colors.primary.gradient
                    : theme.colors.border.DEFAULT,
                color: sendButtonMode === 'stop'
                  ? theme.colors.text.inverse
                  : (input.trim() || fileReferenceChips.length > 0) && canSubmitMessage
                    ? theme.colors.text.inverse
                    : theme.colors.text.muted,
                boxShadow:
                  sendButtonMode === 'stop' || ((input.trim() || fileReferenceChips.length > 0) && canSubmitMessage)
                    ? theme.shadows.glow
                    : 'none',
              }}
              title={
                sendButtonMode === 'stop' ? t('chatInput.stopRun') : isCanceling ? t('chatInput.canceling') : t('chatInput.sendMessage')
              }
              data-testid={sendButtonMode === 'stop' ? 'chat-stop' : 'chat-send'}
            >
              {sendButtonMode === 'stop' ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 6h12v12H6z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              )}
            </button>
          </div>}
        </div>
      </div>

      {mentionError && (
        <div className="text-center text-xs mt-1" style={{ color: '#f87171' }}>
          {mentionError}
        </div>
      )}

      {dropFeedback && !mentionError && (
        <div
          className="text-center text-xs mt-1"
          style={{ color: dropFeedback.level === 'warning' ? '#f59e0b' : '#10b981' }}
        >
          {dropFeedback.message}
        </div>
      )}

      {voiceInput.shouldShowButton && voiceInput.error && !mentionError && !dropFeedback && (
        <div className="text-center text-xs mt-1" style={{ color: '#f59e0b' }}>
          {t('chatInput.voice.error', { message: voiceInput.error })}
        </div>
      )}

      {capabilityHint && !mentionError && !dropFeedback && !(voiceInput.shouldShowButton && voiceInput.error) && (
        <div
          className="text-center text-xs mt-1 px-3 py-1 rounded-full inline-block mx-auto border"
          style={{
            color: theme.colors.text.muted,
            borderColor: theme.colors.border.DEFAULT,
            backgroundColor: theme.colors.bg.secondary,
          }}
        >
          {capabilityHint}
        </div>
      )}

      {!selectedAgent && hasMentionCandidate && (
        <div className="text-center text-[11px] mt-1" style={{ color: theme.colors.text.muted }}>
          {t('chatInput.mention.keyboardHint')}
        </div>
      )}
      <LocalFilePickerModal
        isOpen={filePickerOpen}
        mode="file"
        title={t('chatInput.filePicker.title')}
        confirmLabel={t('chatInput.filePicker.confirm')}
        selectedPaths={fileReferenceChips}
        onClose={() => setFilePickerOpen(false)}
        onConfirm={(paths) => {
          insertFileReferences(paths);
          setFilePickerOpen(false);
          setDropFeedbackMessage({
            level: 'success',
            message: t('chatInput.drop.imported'),
          });
        }}
      />
    </div>
  );
}
