import { useEffect, useMemo, useState } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n } from '../../i18n/index.js';
import type { FinalizedPlanView } from '../../app-shell-types.js';
import { FinalizedPlanCard } from './FinalizedPlanCard.js';

export interface PlanInputOption {
  label: string;
  description: string;
}

export interface PlanInputQuestion {
  header: string;
  id: string;
  question: string;
  options: PlanInputOption[];
}

export interface PlanInputRequestViewModel {
  requestId: string;
  questions: PlanInputQuestion[];
  planPreview?: FinalizedPlanView;
}

export interface PlanInputAnswerViewModel {
  id: string;
  selectedLabel: string;
  selectedIndex: number;
  freeText?: string;
}

interface PlanInputCardProps {
  request: PlanInputRequestViewModel;
  error?: string | null;
  disabled?: boolean;
  disabledReason?: string;
  onSubmit: (answers: PlanInputAnswerViewModel[]) => void;
}

interface AnswerState {
  selectedIndex: number;
  customSelected: boolean;
  freeText: string;
}

export function resolvePlanInputAnswerPayload(
  question: PlanInputQuestion,
  answer: AnswerState
): PlanInputAnswerViewModel {
  const trimmedFreeText = answer.freeText.trim();
  const customAnswerActive = question.options.length > 0 && answer.customSelected && trimmedFreeText.length > 0;
  const hasSelectedOption =
    !customAnswerActive && answer.selectedIndex >= 0 && answer.selectedIndex < question.options.length;
  const option = hasSelectedOption ? question.options[answer.selectedIndex] : undefined;
  return {
    id: question.id,
    selectedIndex: hasSelectedOption ? answer.selectedIndex : -1,
    selectedLabel: hasSelectedOption ? option?.label ?? '' : '',
    freeText: trimmedFreeText || undefined,
  };
}

function createInitialState(questions: PlanInputQuestion[]): Record<string, AnswerState> {
  const next: Record<string, AnswerState> = {};
  for (const question of questions) {
    next[question.id] = {
      selectedIndex: -1,
      customSelected: false,
      freeText: '',
    };
  }
  return next;
}

export function PlanInputCard({ request, error, disabled = false, disabledReason, onSubmit }: PlanInputCardProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Record<string, AnswerState>>(() => createInitialState(request.questions));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setAnswers(createInitialState(request.questions));
    setValidationError(null);
  }, [request.requestId, request.questions]);

  const canSubmit = useMemo(() => {
    if (disabled) {
      return false;
    }
    return request.questions.every((question) => {
      const state = answers[question.id];
      if (!state) {
        return false;
      }
      const hasSelectedOption = state.selectedIndex >= 0 && state.selectedIndex < question.options.length;
      const hasFreeText = state.freeText.trim().length > 0;
      const hasCustomAnswer = question.options.length > 0 ? state.customSelected && hasFreeText : hasFreeText;
      return hasSelectedOption || hasCustomAnswer;
    });
  }, [answers, disabled, request.questions]);

  const handleSubmit = () => {
    if (disabled) {
      setValidationError(null);
      return;
    }
    if (!canSubmit) {
      setValidationError(t('planInput.validation'));
      return;
    }
    setValidationError(null);
    const payload: PlanInputAnswerViewModel[] = request.questions.map((question) =>
      resolvePlanInputAnswerPayload(question, answers[question.id])
    );
    onSubmit(payload);
  };

  return (
    <div
      data-testid="plan-input-card"
      aria-disabled={disabled}
      className="rounded-2xl border p-4 space-y-4"
      style={{
        backgroundColor: theme.colors.bg.secondary,
        borderColor: theme.colors.border.DEFAULT,
      }}
    >
      <div className="flex items-center justify-between">
        <div
          className="text-sm font-medium"
          style={{ color: theme.colors.text.primary }}
        >
          {t('planInput.title')}
        </div>
        <div className="text-xs font-mono" style={{ color: theme.colors.text.muted }}>
          {request.requestId}
        </div>
      </div>

      {request.planPreview && <FinalizedPlanCard plan={request.planPreview} />}

      {disabled && (
        <div
          className="rounded-lg border px-3 py-2 text-sm"
          style={{
            borderColor: theme.colors.border.DEFAULT,
            color: theme.colors.text.secondary,
            backgroundColor: theme.colors.bg.tertiary,
          }}
        >
          {disabledReason || t('planInput.readOnly')}
        </div>
      )}

      {request.questions.map((question) => {
        const answer = answers[question.id] ?? { selectedIndex: -1, customSelected: false, freeText: '' };
        return (
          <div
            key={question.id}
            className="rounded-xl border p-3 space-y-3"
            style={{
              borderColor: theme.colors.border.DEFAULT,
              backgroundColor: theme.colors.bg.tertiary,
            }}
          >
            <div>
              <div className="text-xs uppercase tracking-wide" style={{ color: theme.colors.text.muted }}>
                {question.header}
              </div>
              <div className="text-sm mt-1" style={{ color: theme.colors.text.primary }}>
                {question.question}
              </div>
            </div>

            <div className="space-y-2">
              {question.options.length === 0 ? (
                <div className="text-xs" style={{ color: theme.colors.text.muted }}>
                  {t('planInput.noPresetOptions')}
                </div>
              ) : (
                question.options.map((option, index) => {
                  const selected = answer.selectedIndex === index;
                  return (
                    <label
                      key={`${question.id}-${option.label}`}
                      className={`flex items-start gap-2 rounded-lg border p-2 ${disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
                      style={{
                        borderColor: selected ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
                        backgroundColor: selected ? `${theme.colors.primary.DEFAULT}20` : 'transparent',
                      }}
                    >
                      <input
                        type="radio"
                        checked={selected}
                        disabled={disabled}
                        onChange={() =>
                          setAnswers((prev) => ({
                            ...prev,
                            [question.id]: {
                              ...answer,
                              selectedIndex: index,
                              customSelected: false,
                            },
                          }))
                        }
                      />
                      <span className="text-sm" style={{ color: theme.colors.text.primary }}>
                        <strong>{option.label}</strong>
                        <br />
                        <span style={{ color: theme.colors.text.secondary }}>{option.description}</span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>

            <div>
              {question.options.length > 0 && (
                <label
                  className={`mb-2 flex items-start gap-2 rounded-lg border p-2 ${disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
                  style={{
                    borderColor: answer.customSelected ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
                    backgroundColor: answer.customSelected ? `${theme.colors.primary.DEFAULT}20` : 'transparent',
                  }}
                >
                  <input
                    type="radio"
                    checked={answer.customSelected}
                    disabled={disabled}
                    onChange={() =>
                      setAnswers((prev) => ({
                        ...prev,
                        [question.id]: {
                          ...answer,
                          selectedIndex: -1,
                          customSelected: true,
                        },
                      }))
                    }
                  />
                  <span className="text-sm font-medium" style={{ color: theme.colors.text.primary }}>
                    {t('planInput.customAnswer')}
                  </span>
                </label>
              )}
              <textarea
                value={answer.freeText}
                disabled={disabled}
                onFocus={() => {
                  if (
                    question.options.length === 0 ||
                    answer.customSelected ||
                    (answer.selectedIndex >= 0 && answer.selectedIndex < question.options.length)
                  ) {
                    return;
                  }
                  setAnswers((prev) => ({
                    ...prev,
                    [question.id]: {
                      ...answer,
                      selectedIndex: -1,
                      customSelected: true,
                    },
                  }));
                }}
                onChange={(event) =>
                  setAnswers((prev) => ({
                    ...prev,
                    [question.id]: {
                      ...answer,
                      selectedIndex:
                        question.options.length > 0 && answer.customSelected ? -1 : answer.selectedIndex,
                      customSelected:
                        question.options.length > 0 &&
                        (answer.customSelected ||
                          !(answer.selectedIndex >= 0 && answer.selectedIndex < question.options.length)),
                      freeText: event.target.value,
                    },
                  }))
                }
                placeholder={
                  question.options.length === 0
                    ? t('planInput.placeholder.freeTextOnly')
                    : t('planInput.placeholder.optional')
                }
                className="w-full resize-y min-h-[70px] rounded-lg border p-2 text-sm bg-transparent outline-none"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.primary,
                }}
              />
            </div>
          </div>
        );
      })}

      {(validationError || error) && (
        <div className="text-sm" style={{ color: '#f87171' }}>
          {validationError ?? error}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || !canSubmit}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{
            background: theme.colors.primary.gradient,
            color: theme.colors.text.inverse,
            opacity: canSubmit ? 1 : 0.6,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {t('planInput.submit')}
        </button>
      </div>
    </div>
  );
}
