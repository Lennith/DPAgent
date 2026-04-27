import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n, type TranslationKey } from '../../i18n/index.js';
import { buildDroppedPathInsertion } from './dragPathUtils.js';
import AutoLoopControl from '../auto-loop/AutoLoopControl.js';
import { SessionLlmBar } from './SessionLlmBar.js';
import type {
  LlmProfilesConfigView,
  SessionLlmSelectionPatch,
  SessionLlmSelectionView,
} from '../../app-shell-types.js';

interface AgentCandidate {
  name: string;
  description: string;
  mtime: string;
}

interface ChatInputProps {
  sessionId?: string | null;
  input: string;
  setInput: (value: string) => void;
  onSend: (payload: { prompt: string; selectedAgentName?: string; usePlanMode?: boolean }) => void;
  onCancel?: () => void;
  isRunning: boolean;
  isCanceling?: boolean;
  canCancel?: boolean;
  isInteractionLocked?: boolean;
  llmProfiles?: LlmProfilesConfigView | null;
  llmSelection?: SessionLlmSelectionView;
  onChangeLlmSelection?: (patch: SessionLlmSelectionPatch) => void;
}

const ONBOARDING_SESSION_COUNT_KEY = 'minimax-ux-session-count';
const ONBOARDING_SESSION_MARK_KEY = 'minimax-ux-session-marked';
const ONBOARDING_DISMISSED_KEY = 'minimax-ux-onboarding-dismissed';
const DRAFT_SESSION_KEY = '__draft__';

type QuickActionKey = 'analyze' | 'summarize' | 'compare';

type TemplatePromptKey = 'reviewPr' | 'debugIssue' | 'planTask';

const QUICK_ACTION_DEFS: Array<{
  id: QuickActionKey;
  labelKey: TranslationKey;
  textKey: TranslationKey;
}> = [
  {
    id: 'analyze',
    labelKey: 'chatInput.quick.analyze.label',
    textKey: 'chatInput.quick.analyze.text',
  },
  {
    id: 'summarize',
    labelKey: 'chatInput.quick.summarize.label',
    textKey: 'chatInput.quick.summarize.text',
  },
  {
    id: 'compare',
    labelKey: 'chatInput.quick.compare.label',
    textKey: 'chatInput.quick.compare.text',
  },
];

const TEMPLATE_PROMPT_DEFS: Array<{
  id: TemplatePromptKey;
  labelKey: TranslationKey;
  templateKey: TranslationKey;
  descriptionKey: TranslationKey;
  usePlanMode?: boolean;
}> = [
  {
    id: 'reviewPr',
    labelKey: 'chatInput.template.reviewPr.label',
    templateKey: 'chatInput.template.reviewPr.template',
    descriptionKey: 'chatInput.template.reviewPr.description',
  },
  {
    id: 'debugIssue',
    labelKey: 'chatInput.template.debugIssue.label',
    templateKey: 'chatInput.template.debugIssue.template',
    descriptionKey: 'chatInput.template.debugIssue.description',
  },
  {
    id: 'planTask',
    labelKey: 'chatInput.template.planTask.label',
    templateKey: 'chatInput.template.planTask.template',
    descriptionKey: 'chatInput.template.planTask.description',
    usePlanMode: true,
  },
];

function extractLeadingMentionQuery(value: string): string | null {
  const match = value.match(/^@([^\s]*)/);
  if (!match) {
    return null;
  }
  return String(match[1] ?? '');
}

function hasFileLikeDragData(transfer: DataTransfer): boolean {
  if (transfer.files.length > 0) {
    return true;
  }
  const hasFilesType = Array.from(transfer.types).some((entry) => entry === 'Files');
  if (hasFilesType) {
    return true;
  }
  const uriList = transfer.getData('text/uri-list');
  return String(uriList ?? '').trim().length > 0;
}

interface FileWithOptionalPath extends File {
  path?: string;
}

type DropFeedbackState =
  | {
      level: 'success' | 'warning';
      message: string;
    }
  | null;

export function ChatInput({
  sessionId,
  input,
  setInput,
  onSend,
  onCancel,
  isRunning,
  isCanceling: isCancelingProp,
  canCancel = isRunning,
  isInteractionLocked = isRunning,
  llmProfiles = null,
  llmSelection,
  onChangeLlmSelection,
}: ChatInputProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const isComposerDisabled = isInteractionLocked;
  const [selectedAgentBySession, setSelectedAgentBySession] = useState<Record<string, AgentCandidate>>({});
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<AgentCandidate[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [sessionVisitCount, setSessionVisitCount] = useState(0);
  const [dismissedOnboarding, setDismissedOnboarding] = useState(
    () => localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1'
  );
  const fetchControllerRef = useRef<AbortController | null>(null);
  const fetchSeqRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const quickActionScrollRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const dropFeedbackTimerRef = useRef<number | null>(null);
  const [isTextareaOverflowing, setIsTextareaOverflowing] = useState(false);
  const [quickActionHasOverflow, setQuickActionHasOverflow] = useState(false);
  const [quickActionCanScrollLeft, setQuickActionCanScrollLeft] = useState(false);
  const [quickActionCanScrollRight, setQuickActionCanScrollRight] = useState(false);
  const [planModeNextSend, setPlanModeNextSend] = useState(false);
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);
  const [dropFeedback, setDropFeedback] = useState<DropFeedbackState>(null);

  const quickActions = useMemo(
    () =>
      QUICK_ACTION_DEFS.map((definition) => ({
        key: definition.id,
        label: t(definition.labelKey),
        text: t(definition.textKey),
      })),
    [t]
  );

  const templatePrompts = useMemo(
    () =>
      TEMPLATE_PROMPT_DEFS.map((definition) => ({
        key: definition.id,
        label: t(definition.labelKey),
        template: t(definition.templateKey),
        description: t(definition.descriptionKey),
        usePlanMode: definition.usePlanMode === true,
      })),
    [t]
  );

  const TEXTAREA_FIXED_HEIGHT = 56;
  const INPUT_SOFT_LIMIT = 4000;
  const hasMentionCandidate = mentionOpen && mentionCandidates.length > 0;
  const activeSessionKey = sessionId ?? DRAFT_SESSION_KEY;
  const selectedAgent = selectedAgentBySession[activeSessionKey] ?? null;
  const isWindowsClient = useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    const platform = String(navigator.platform ?? '');
    const userAgent = String(navigator.userAgent ?? '');
    return /win/i.test(platform) || /windows/i.test(userAgent);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    setSelectedAgentBySession((prev) => {
      const draft = prev[DRAFT_SESSION_KEY];
      if (!draft || prev[sessionId]) {
        return prev;
      }
      const next = { ...prev, [sessionId]: draft };
      delete next[DRAFT_SESSION_KEY];
      return next;
    });
  }, [sessionId]);

  useEffect(() => {
    const alreadyMarked = sessionStorage.getItem(ONBOARDING_SESSION_MARK_KEY) === '1';
    const stored = Number.parseInt(localStorage.getItem(ONBOARDING_SESSION_COUNT_KEY) ?? '0', 10);
    const safeStored = Number.isFinite(stored) && stored > 0 ? stored : 0;
    if (!alreadyMarked) {
      const next = safeStored + 1;
      localStorage.setItem(ONBOARDING_SESSION_COUNT_KEY, String(next));
      sessionStorage.setItem(ONBOARDING_SESSION_MARK_KEY, '1');
      setSessionVisitCount(next);
      return;
    }
    setSessionVisitCount(safeStored);
  }, []);

  useEffect(() => {
    return () => {
      if (dropFeedbackTimerRef.current !== null) {
        window.clearTimeout(dropFeedbackTimerRef.current);
      }
    };
  }, []);

  const onboardingVisible = sessionVisitCount > 0 && sessionVisitCount <= 3 && !dismissedOnboarding;

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
    if (/\bsummarize\b|\bsummary\b/.test(trimmed)) {
      return t('chatInput.hint.summarize');
    }
    return null;
  }, [input, t]);

  const applyQuickAction = (text: string): void => {
    if (isComposerDisabled) {
      return;
    }
    const next = input.trim().length > 0 ? `${input.trim()}\n${text}` : text;
    setInput(next);
    setMentionError(null);
  };

  const setDropFeedbackMessage = useCallback((feedback: DropFeedbackState): void => {
    if (dropFeedbackTimerRef.current !== null) {
      window.clearTimeout(dropFeedbackTimerRef.current);
      dropFeedbackTimerRef.current = null;
    }
    setDropFeedback(feedback);
    if (!feedback) {
      return;
    }
    dropFeedbackTimerRef.current = window.setTimeout(() => {
      setDropFeedback(null);
      dropFeedbackTimerRef.current = null;
    }, 5000);
  }, []);

  const applyTemplatePrompt = (template: string, usePlanMode?: boolean): void => {
    if (isComposerDisabled) {
      return;
    }
    const filledTemplate = template.replace(/\$\{[^}]+\}/g, '');
    const next = input.trim().length > 0 ? `${input.trim()}\n${filledTemplate}` : filledTemplate;
    setInput(next);
    if (usePlanMode) {
      setPlanModeNextSend(true);
    }
    setMentionError(null);
  };

  useEffect(() => {
    if (input.trim().length === 0 && planModeNextSend) {
      setPlanModeNextSend(false);
    }
  }, [input, planModeNextSend]);

  const updateQuickActionScrollState = useCallback((): void => {
    const container = quickActionScrollRef.current;
    if (!container) {
      setQuickActionHasOverflow(false);
      setQuickActionCanScrollLeft(false);
      setQuickActionCanScrollRight(false);
      return;
    }
    const maxScrollLeft = container.scrollWidth - container.clientWidth;
    const hasOverflow = maxScrollLeft > 2;
    setQuickActionHasOverflow(hasOverflow);
    setQuickActionCanScrollLeft(hasOverflow && container.scrollLeft > 2);
    setQuickActionCanScrollRight(hasOverflow && container.scrollLeft < maxScrollLeft - 2);
  }, []);

  const scrollQuickActions = (direction: 'left' | 'right'): void => {
    const container = quickActionScrollRef.current;
    if (!container) {
      return;
    }
    const distance = Math.max(Math.floor(container.clientWidth * 0.75), 180);
    container.scrollBy({
      left: direction === 'left' ? -distance : distance,
      behavior: 'smooth',
    });
  };

  useEffect(() => {
    if (selectedAgent || isComposerDisabled) {
      setMentionOpen(false);
      setMentionCandidates([]);
      setMentionLoading(false);
      if (isComposerDisabled) {
        dragDepthRef.current = 0;
        setIsDropTargetActive(false);
      }
      return;
    }

    const query = extractLeadingMentionQuery(input);
    if (query === null) {
      setMentionOpen(false);
      setMentionCandidates([]);
      setMentionLoading(false);
      return;
    }

    const seq = fetchSeqRef.current + 1;
    fetchSeqRef.current = seq;
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;

    setMentionLoading(true);
    setMentionOpen(true);
    const url = query.trim().length > 0 ? `/api/agents?query=${encodeURIComponent(query.trim())}` : '/api/agents';
    void fetch(url, { signal: controller.signal })
      .then((response) => response.json())
      .then((payload: { agents?: AgentCandidate[] }) => {
        if (fetchSeqRef.current !== seq) {
          return;
        }
        const agents = Array.isArray(payload.agents) ? payload.agents : [];
        setMentionCandidates(agents);
        setActiveMentionIndex(0);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        console.error('Failed to load agents:', error);
        if (fetchSeqRef.current !== seq) {
          return;
        }
        setMentionCandidates([]);
      })
      .finally(() => {
        if (fetchSeqRef.current === seq) {
          setMentionLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [input, isComposerDisabled, selectedAgent]);

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      updateQuickActionScrollState();
    });
    const handleResize = (): void => {
      updateQuickActionScrollState();
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
    };
  }, [updateQuickActionScrollState]);

  const updateTextareaOverflowState = useCallback((): void => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    setIsTextareaOverflowing(textarea.scrollHeight > textarea.clientHeight + 1);
  }, []);

  const insertTextAtCursor = useCallback(
    (snippet: string): void => {
      if (!snippet) {
        return;
      }
      const textarea = textareaRef.current;
      const currentText = input;
      if (!textarea) {
        setInput(`${currentText}${snippet}`);
        return;
      }
      const selectionStart = textarea.selectionStart ?? currentText.length;
      const selectionEnd = textarea.selectionEnd ?? currentText.length;
      const nextValue = `${currentText.slice(0, selectionStart)}${snippet}${currentText.slice(selectionEnd)}`;
      const nextCursor = selectionStart + snippet.length;
      setInput(nextValue);
      window.requestAnimationFrame(() => {
        const target = textareaRef.current;
        if (!target) {
          return;
        }
        target.focus();
        target.setSelectionRange(nextCursor, nextCursor);
        updateTextareaOverflowState();
      });
    },
    [input, setInput, updateTextareaOverflowState]
  );

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFileLikeDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (isComposerDisabled) {
      return;
    }
    dragDepthRef.current += 1;
    setIsDropTargetActive(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFileLikeDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (isComposerDisabled) {
      return;
    }
    event.dataTransfer.dropEffect = 'copy';
    if (!isDropTargetActive) {
      setIsDropTargetActive(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFileLikeDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (isComposerDisabled) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDropTargetActive(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFileLikeDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (isComposerDisabled) {
      return;
    }
    dragDepthRef.current = 0;
    setIsDropTargetActive(false);

    const firstFile = event.dataTransfer.files[0] as FileWithOptionalPath | undefined;
    const uriList = event.dataTransfer.getData('text/uri-list');
    const dropResult = buildDroppedPathInsertion({
      uriList,
      filePath: firstFile?.path,
      fileName: firstFile?.name,
      isWindows: isWindowsClient,
    });

    if (!dropResult.text) {
      setDropFeedbackMessage({
        level: 'warning',
        message: t('chatInput.drop.noPath'),
      });
      return;
    }

    insertTextAtCursor(dropResult.text);
    setMentionError(null);
    if (dropResult.resolved) {
      setDropFeedbackMessage({
        level: 'success',
        message: t('chatInput.drop.imported'),
      });
      return;
    }
    setDropFeedbackMessage({
      level: 'warning',
      message: t('chatInput.drop.partial'),
    });
  };

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

  const clearSelectedAgentForCurrentSession = useCallback((): void => {
    setSelectedAgentBySession((prev) => {
      if (!prev[activeSessionKey]) {
        return prev;
      }
      const next = { ...prev };
      delete next[activeSessionKey];
      return next;
    });
  }, [activeSessionKey]);

  const applyAgentSelection = (agent: AgentCandidate): void => {
    const stripped = input.replace(/^@\S*\s*/, '');
    setInput(stripped);
    setSelectedAgentBySession((prev) => ({
      ...prev,
      [activeSessionKey]: agent,
    }));
    setMentionCandidates([]);
    setMentionOpen(false);
    setActiveMentionIndex(0);
    setMentionError(null);
  };

  const handleSubmit = (): void => {
    const trimmed = input.trim();
    if (selectedAgent && !trimmed) {
      setMentionError(t('chatInput.mention.requireMessage'));
      return;
    }
    if (!trimmed || isComposerDisabled) {
      return;
    }
    onSend({
      prompt: trimmed,
      selectedAgentName: selectedAgent?.name,
      ...(planModeNextSend ? { usePlanMode: true } : {}),
    });
    setPlanModeNextSend(false);
    setMentionCandidates([]);
    setMentionOpen(false);
    setActiveMentionIndex(0);
    setMentionError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (isComposerDisabled) {
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
      e.preventDefault();
      handleSubmit();
    }
  };

  const isCanceling = isCancelingProp ?? (isInteractionLocked && !isRunning);
  const isTurnActive = isRunning || isCanceling;

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
            onClick={() => {
              setDismissedOnboarding(true);
              localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
            }}
            className="text-xs"
            style={{ color: theme.colors.text.muted }}
          >
            {t('chatInput.dismissOnboarding')}
          </button>
        </div>
      )}

      <div className="composer-control-stack mb-3 flex items-center gap-2" data-testid="composer-control-row">
        <div className="composer-quick-row flex min-w-0 flex-1 items-center gap-2">
          <span
            className="text-[11px] uppercase tracking-[0.12em] px-2 py-1 rounded-full border shrink-0"
            style={{
              borderColor: theme.colors.border.DEFAULT,
              color: theme.colors.text.muted,
              backgroundColor: theme.colors.bg.secondary,
            }}
          >
            {t('chatInput.quickActions')}
          </span>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div
              ref={quickActionScrollRef}
              className="flex items-center gap-2 min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1"
              onScroll={updateQuickActionScrollState}
            >
              {quickActions.map((action) => (
                <button
                  key={`quick-${action.label}`}
                  type="button"
                  onClick={() => applyQuickAction(action.text)}
                  disabled={isComposerDisabled}
                  className="shrink-0 text-xs px-2.5 py-1 rounded-full border transition-all duration-200 hover:-translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    backgroundColor: theme.colors.bg.secondary,
                    color: theme.colors.text.secondary,
                  }}
                >
                  {action.label}
                </button>
              ))}
              {templatePrompts.map((template) => (
                <button
                  key={`template-${template.label}`}
                  type="button"
                  onClick={() => applyTemplatePrompt(template.template, template.usePlanMode)}
                  disabled={isComposerDisabled}
                  className="shrink-0 text-xs px-2.5 py-1 rounded-full border transition-all duration-200 hover:-translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    backgroundColor: theme.colors.bg.secondary,
                    color: theme.colors.text.secondary,
                  }}
                  title={template.description}
                >
                  {template.label}
                </button>
              ))}
            </div>
            {quickActionHasOverflow && (
              <div className="shrink-0 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => scrollQuickActions('left')}
                  disabled={!quickActionCanScrollLeft}
                  className="h-7 w-7 rounded-full border text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    color: theme.colors.text.secondary,
                    backgroundColor: theme.colors.bg.secondary,
                  }}
                  title={t('chatInput.scrollLeft')}
                >
                  {'<'}
                </button>
                <button
                  type="button"
                  onClick={() => scrollQuickActions('right')}
                  disabled={!quickActionCanScrollRight}
                  className="h-7 w-7 rounded-full border text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    color: theme.colors.text.secondary,
                    backgroundColor: theme.colors.bg.secondary,
                  }}
                  title={t('chatInput.scrollRight')}
                >
                  {'>'}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="composer-settings-row flex shrink-0 items-center justify-end gap-2">
          {selectedAgent && (
            <button
              type="button"
              onClick={clearSelectedAgentForCurrentSession}
              disabled={isComposerDisabled}
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
          {llmSelection && onChangeLlmSelection && (
            <div className="composer-llm-slot min-w-0" data-testid="composer-llm-slot">
              <SessionLlmBar
                sessionId={sessionId}
                llmProfiles={llmProfiles}
                selection={llmSelection}
                disabled={isRunning}
                onChange={onChangeLlmSelection}
              />
            </div>
          )}
          <div className="composer-ralph-slot min-w-0" data-testid="composer-ralph-slot">
            <AutoLoopControl sessionId={sessionId ?? null} disabled={isComposerDisabled} compact />
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
                  : isComposerDisabled
                    ? t('chatInput.placeholder.running')
                    : t('chatInput.placeholder.default')
              }
              disabled={isComposerDisabled}
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

          <div className="flex items-center">
            <button
              type="button"
              onClick={isRunning ? onCancel : handleSubmit}
              disabled={isRunning ? !onCancel || !canCancel : isCanceling || !input.trim() || isComposerDisabled}
              className="p-3 rounded-xl font-medium transition-all duration-300 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{
                background: isTurnActive
                  ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                  : input.trim() && !isComposerDisabled
                    ? theme.colors.primary.gradient
                    : theme.colors.border.DEFAULT,
                color: isTurnActive
                  ? theme.colors.text.inverse
                  : input.trim() && !isComposerDisabled
                    ? theme.colors.text.inverse
                    : theme.colors.text.muted,
                boxShadow: isTurnActive || (input.trim() && !isComposerDisabled) ? theme.shadows.glow : 'none',
              }}
              title={
                isRunning ? t('chatInput.stopRun') : isCanceling ? t('chatInput.canceling') : t('chatInput.sendMessage')
              }
              data-testid={isTurnActive ? 'chat-stop' : 'chat-send'}
            >
              {isTurnActive ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 6h12v12H6z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              )}
            </button>
          </div>
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

      {capabilityHint && !mentionError && !dropFeedback && (
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
    </div>
  );
}
