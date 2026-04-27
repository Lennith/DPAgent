import React, { useEffect, useMemo, useState } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n } from '../../i18n/index.js';

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
  onSubmit: (answers: PlanInputAnswerViewModel[]) => void;
}

interface AnswerState {
  selectedIndex: number;
  freeText: string;
}

function createInitialState(questions: PlanInputQuestion[]): Record<string, AnswerState> {
  const next: Record<string, AnswerState> = {};
  for (const question of questions) {
    next[question.id] = {
      selectedIndex: -1,
      freeText: '',
    };
  }
  return next;
}

export function PlanInputCard({ request, error, onSubmit }: PlanInputCardProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Record<string, AnswerState>>(() => createInitialState(request.questions));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setAnswers(createInitialState(request.questions));
    setValidationError(null);
  }, [request.requestId, request.questions]);

  const canSubmit = useMemo(() => {
    return request.questions.every((question) => {
      const state = answers[question.id];
      if (!state) {
        return false;
      }
      const hasSelectedOption = state.selectedIndex >= 0 && state.selectedIndex < question.options.length;
      const hasFreeText = state.freeText.trim().length > 0;
      return hasSelectedOption || hasFreeText;
    });
  }, [answers, request.questions]);

  const handleSubmit = () => {
    if (!canSubmit) {
      setValidationError(t('planInput.validation'));
      return;
    }
    setValidationError(null);
    const payload: PlanInputAnswerViewModel[] = request.questions.map((question) => {
      const answer = answers[question.id];
      const hasSelectedOption = answer.selectedIndex >= 0 && answer.selectedIndex < question.options.length;
      const option = hasSelectedOption ? question.options[answer.selectedIndex] : undefined;
      const trimmedFreeText = answer.freeText.trim();
      return {
        id: question.id,
        selectedIndex: hasSelectedOption ? answer.selectedIndex : -1,
        selectedLabel: hasSelectedOption ? option?.label ?? '' : '',
        freeText: trimmedFreeText || undefined,
      };
    });
    onSubmit(payload);
  };

  return (
    <div
      data-testid="plan-input-card"
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

      {request.questions.map((question) => {
        const answer = answers[question.id] ?? { selectedIndex: -1, freeText: '' };
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
                      className="flex items-start gap-2 rounded-lg border p-2 cursor-pointer"
                      style={{
                        borderColor: selected ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
                        backgroundColor: selected ? `${theme.colors.primary.DEFAULT}20` : 'transparent',
                      }}
                    >
                      <input
                        type="radio"
                        checked={selected}
                        onChange={() =>
                          setAnswers((prev) => ({
                            ...prev,
                            [question.id]: {
                              ...answer,
                              selectedIndex: index,
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
              <textarea
                value={answer.freeText}
                onChange={(event) =>
                  setAnswers((prev) => ({
                    ...prev,
                    [question.id]: {
                      ...answer,
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
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{
            background: theme.colors.primary.gradient,
            color: theme.colors.text.inverse,
            opacity: canSubmit ? 1 : 0.9,
          }}
        >
          {t('planInput.submit')}
        </button>
      </div>
    </div>
  );
}
