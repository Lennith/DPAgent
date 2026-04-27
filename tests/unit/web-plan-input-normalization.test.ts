import * as assert from 'node:assert/strict';
import { normalizePlanInputAnswers } from '../../src/web/server/plan-input-normalization.js';
import type { PlanInputRequest } from '../../src/types.js';

function createRequest(overrides: Partial<PlanInputRequest> = {}): PlanInputRequest {
  return {
    requestId: 'req-1',
    questions: [
      {
        header: 'Mode',
        id: 'mode',
        question: 'Pick a mode',
        options: [
          { label: 'Fast', description: 'Speed first' },
          { label: 'Safe', description: 'Risk first' },
        ],
      },
      {
        header: 'Notes',
        id: 'notes',
        question: 'Add notes',
        options: [],
      },
    ],
    ...overrides,
  };
}

function testAnswersMustBeArray(): void {
  const result = normalizePlanInputAnswers(undefined, createRequest());
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('expected error');
  }
  assert.equal(result.error, 'answers must be an array');
}

function testAnswerItemMustBeObject(): void {
  const result = normalizePlanInputAnswers([null as never], createRequest());
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('expected error');
  }
  assert.equal(result.error, 'answers[0] must be an object');
}

function testDuplicateQuestionIdsRejected(): void {
  const result = normalizePlanInputAnswers(
    [
      { id: 'mode', selectedIndex: 0 },
      { id: 'mode', selectedIndex: 1 },
      { id: 'notes', freeText: 'carry on' },
    ],
    createRequest()
  );
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('expected error');
  }
  assert.equal(result.error, 'answers[1].id must be unique');
}

function testUnknownQuestionRejected(): void {
  const result = normalizePlanInputAnswers(
    [
      { id: 'unknown', selectedIndex: 0 },
      { id: 'notes', freeText: 'carry on' },
    ],
    createRequest()
  );
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('expected error');
  }
  assert.equal(result.error, 'answers[0].id does not match any question');
}

function testSelectedLabelBackfillsCanonicalOptionAndOrder(): void {
  const result = normalizePlanInputAnswers(
    [
      { id: 'notes', freeText: 'Ship after QA' },
      { id: 'mode', selectedLabel: 'Safe' },
    ],
    createRequest()
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.deepEqual(result.answers, [
    {
      id: 'mode',
      selectedLabel: 'Safe',
      selectedIndex: 1,
      freeText: undefined,
    },
    {
      id: 'notes',
      selectedLabel: '',
      selectedIndex: -1,
      freeText: 'Ship after QA',
    },
  ]);
}

function testOptionQuestionAllowsFreeTextFallback(): void {
  const result = normalizePlanInputAnswers(
    [
      { id: 'mode', selectedIndex: 'not-a-number', freeText: 'Prefer hybrid' },
      { id: 'notes', freeText: 'Need signoff' },
    ],
    createRequest()
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.deepEqual(result.answers[0], {
    id: 'mode',
    selectedLabel: '',
    selectedIndex: -1,
    freeText: 'Prefer hybrid',
  });
}

function testOptionQuestionRequiresSelectionOrFreeText(): void {
  const result = normalizePlanInputAnswers(
    [
      { id: 'mode', selectedIndex: 9 },
      { id: 'notes', freeText: 'Need signoff' },
    ],
    createRequest()
  );
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('expected error');
  }
  assert.equal(result.error, 'answers[0] must select an option or provide freeText');
}

function testFreeTextQuestionRequiresFreeText(): void {
  const result = normalizePlanInputAnswers(
    [
      { id: 'mode', selectedIndex: 0 },
      { id: 'notes', selectedLabel: 'ignored' },
    ],
    createRequest()
  );
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('expected error');
  }
  assert.equal(result.error, 'answers[1] must provide freeText');
}

function testMissingAnswerRejectedAfterNormalization(): void {
  const result = normalizePlanInputAnswers([{ id: 'mode', selectedIndex: 0 }], createRequest());
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('expected error');
  }
  assert.equal(result.error, 'missing answer for question id: notes');
}

function runAll(): void {
  testAnswersMustBeArray();
  testAnswerItemMustBeObject();
  testDuplicateQuestionIdsRejected();
  testUnknownQuestionRejected();
  testSelectedLabelBackfillsCanonicalOptionAndOrder();
  testOptionQuestionAllowsFreeTextFallback();
  testOptionQuestionRequiresSelectionOrFreeText();
  testFreeTextQuestionRequiresFreeText();
  testMissingAnswerRejectedAfterNormalization();
  console.log('web-plan-input-normalization tests passed');
}

runAll();
