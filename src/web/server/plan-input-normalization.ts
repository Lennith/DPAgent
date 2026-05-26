import type { PlanInputAnswer, PlanInputRequest } from '../../types.js';

export interface RawPlanInputAnswer {
  id?: unknown;
  selectedLabel?: unknown;
  selectedIndex?: unknown;
  freeText?: unknown;
}

export type NormalizedPlanInputAnswersResult =
  | {
      ok: true;
      answers: PlanInputAnswer[];
    }
  | {
      ok: false;
      error: string;
    };

export function normalizePlanInputAnswers(
  rawAnswers: RawPlanInputAnswer[] | undefined,
  request: PlanInputRequest
): NormalizedPlanInputAnswersResult {
  if (!Array.isArray(rawAnswers)) {
    return { ok: false, error: 'answers must be an array' };
  }

  const byQuestionId = new Map<string, PlanInputAnswer>();
  for (let i = 0; i < rawAnswers.length; i += 1) {
    const raw = rawAnswers[i];
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `answers[${i}] must be an object` };
    }

    const questionId = String(raw.id ?? '').trim();
    if (!questionId) {
      return { ok: false, error: `answers[${i}].id is required` };
    }
    if (byQuestionId.has(questionId)) {
      return { ok: false, error: `answers[${i}].id must be unique` };
    }

    const question = request.questions.find((item) => item.id === questionId);
    if (!question) {
      return { ok: false, error: `answers[${i}].id does not match any question` };
    }

    const selectedIndexRaw =
      typeof raw.selectedIndex === 'number'
        ? Math.floor(raw.selectedIndex)
        : Number.parseInt(String(raw.selectedIndex ?? '').trim(), 10);
    const hasSelectedLabelField = Object.prototype.hasOwnProperty.call(raw, 'selectedLabel');
    const selectedLabelRaw = String(raw.selectedLabel ?? '').trim();
    const freeText = String(raw.freeText ?? '').trim();

    let selectedIndex = Number.isFinite(selectedIndexRaw) ? selectedIndexRaw : -1;
    let selectedLabel = selectedLabelRaw;
    let hasSelectedOption = false;

    if (question.options.length > 0) {
      if (hasSelectedLabelField && !selectedLabel && freeText) {
        selectedIndex = -1;
      } else if (selectedIndex < 0 && selectedLabel) {
        selectedIndex = question.options.findIndex((option) => option.label === selectedLabel);
      }
      if (selectedIndex >= 0 && selectedIndex < question.options.length) {
        hasSelectedOption = true;
        selectedLabel = question.options[selectedIndex]?.label ?? selectedLabel;
      } else if (!freeText) {
        return { ok: false, error: `answers[${i}] must select an option or provide freeText` };
      }
    } else if (!freeText) {
      return { ok: false, error: `answers[${i}] must provide freeText` };
    }

    byQuestionId.set(questionId, {
      id: questionId,
      selectedLabel: hasSelectedOption ? selectedLabel : '',
      selectedIndex: hasSelectedOption ? selectedIndex : -1,
      freeText: freeText || undefined,
    });
  }

  const orderedAnswers: PlanInputAnswer[] = [];
  for (const question of request.questions) {
    const answer = byQuestionId.get(question.id);
    if (!answer) {
      return { ok: false, error: `missing answer for question id: ${question.id}` };
    }
    orderedAnswers.push(answer);
  }

  return { ok: true, answers: orderedAnswers };
}
