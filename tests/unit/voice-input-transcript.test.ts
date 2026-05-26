import * as assert from 'node:assert/strict';
import { applyVoiceTranscriptUpdate, isAsrClientDebugEnabled } from '../../src/web/client/components/chat/useVoiceInput.js';

function testAsrClientDebugDefaultsOffOutsideBrowser(): void {
  assert.equal(isAsrClientDebugEnabled(), false);
}

function testAsrClientDebugQueryRequiresExactOne(): void {
  const previousWindow = (globalThis as { window?: unknown }).window;
  try {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => null,
      },
      location: {
        search: '?asrClientDebug=10&x=asrClientDebug=1',
      },
    };
    assert.equal(isAsrClientDebugEnabled(), false);
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => null,
      },
      location: {
        search: '?asrClientDebug=1',
      },
    };
    assert.equal(isAsrClientDebugEnabled(), true);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
}

function testDraftUpdatesReplaceExistingDraft(): void {
  const first = applyVoiceTranscriptUpdate({
    input: '',
    transcript: 'draft',
    range: null,
    selectionStart: 0,
    selectionEnd: 0,
    isFinal: false,
  });
  assert.equal(first.value, 'draft');
  assert.deepEqual(first.range, { start: 0, end: 5, text: 'draft' });

  const second = applyVoiceTranscriptUpdate({
    input: first.value,
    transcript: 'draft updated',
    range: first.range,
    selectionStart: first.cursor,
    selectionEnd: first.cursor,
    isFinal: false,
  });
  assert.equal(second.value, 'draft updated');
  assert.deepEqual(second.range, { start: 0, end: 13, text: 'draft updated' });
}

function testExistingTextAppendsAtCursorEnd(): void {
  const result = applyVoiceTranscriptUpdate({
    input: 'existing text',
    transcript: 'voice input',
    range: null,
    selectionStart: 13,
    selectionEnd: 13,
    isFinal: false,
  });
  assert.equal(result.value, 'existing text voice input');
  assert.deepEqual(result.range, { start: 13, end: 25, text: ' voice input' });
}

function testExistingTextInsertsAtMiddleCursor(): void {
  const result = applyVoiceTranscriptUpdate({
    input: 'hello world',
    transcript: 'voice',
    range: null,
    selectionStart: 6,
    selectionEnd: 6,
    isFinal: false,
  });
  assert.equal(result.value, 'hello voice world');
  assert.deepEqual(result.range, { start: 6, end: 12, text: 'voice ' });
}

function testExistingSelectionIsReplacedByFirstDraft(): void {
  const result = applyVoiceTranscriptUpdate({
    input: 'replace this please',
    transcript: 'voice',
    range: null,
    selectionStart: 8,
    selectionEnd: 12,
    isFinal: false,
  });
  assert.equal(result.value, 'replace voice please');
  assert.deepEqual(result.range, { start: 8, end: 13, text: 'voice' });
}

function testFinalUpdateCommitsDraftAndClearsRange(): void {
  const draft = { start: 0, end: 5, text: 'draft' };
  const final = applyVoiceTranscriptUpdate({
    input: 'draft',
    transcript: 'final text',
    range: draft,
    selectionStart: 5,
    selectionEnd: 5,
    isFinal: true,
  });
  assert.equal(final.value, 'final text');
  assert.equal(final.range, null);

  const nextDraft = applyVoiceTranscriptUpdate({
    input: final.value,
    transcript: 'next',
    range: final.range,
    selectionStart: final.cursor,
    selectionEnd: final.cursor,
    isFinal: false,
  });
  assert.equal(nextDraft.value, 'final text next');
  assert.deepEqual(nextDraft.range, { start: 10, end: 15, text: ' next' });
}

function testFinalUpdateDoesNotRemoveManualTextAfterDraft(): void {
  const result = applyVoiceTranscriptUpdate({
    input: 'prefix draft manual',
    transcript: 'final',
    range: { start: 7, end: 12, text: 'draft' },
    selectionStart: 19,
    selectionEnd: 19,
    isFinal: true,
  });
  assert.equal(result.value, 'prefix final manual');
  assert.equal(result.range, null);
}

function testDraftRangeTracksUserInsertBeforeDraft(): void {
  const result = applyVoiceTranscriptUpdate({
    input: 'manual draft',
    transcript: 'draft updated',
    range: { start: 0, end: 5, text: 'draft' },
    selectionStart: 6,
    selectionEnd: 6,
    isFinal: false,
  });
  assert.equal(result.value, 'manual draft updated draft');
  assert.deepEqual(result.range, { start: 6, end: 20, text: ' draft updated' });
}

function testEditedDraftTextIsNotOverwrittenOrRelocated(): void {
  const result = applyVoiceTranscriptUpdate({
    input: 'draft manually edited old draft',
    transcript: 'fresh voice',
    range: { start: 0, end: 5, text: 'old draft' },
    selectionStart: 21,
    selectionEnd: 21,
    isFinal: false,
  });
  assert.equal(result.value, 'draft manually edited fresh voice old draft');
  assert.deepEqual(result.range, { start: 21, end: 33, text: ' fresh voice' });
}

function testStaleDraftDoesNotReplaceUserSelection(): void {
  const result = applyVoiceTranscriptUpdate({
    input: 'manual selected text',
    transcript: 'voice',
    range: { start: 0, end: 5, text: 'missing draft' },
    selectionStart: 7,
    selectionEnd: 15,
    isFinal: false,
  });
  assert.equal(result.value, 'manual selected voice text');
  assert.deepEqual(result.range, { start: 15, end: 21, text: ' voice' });
}

function testEmptyFinalTranscriptClearsDraftRange(): void {
  const result = applyVoiceTranscriptUpdate({
    input: 'existing draft',
    transcript: '   ',
    range: { start: 9, end: 14, text: 'draft' },
    selectionStart: 14,
    selectionEnd: 14,
    isFinal: true,
  });
  assert.equal(result.value, 'existing ');
  assert.equal(result.range, null);
}

function testEmptyDraftTranscriptIsNoop(): void {
  const result = applyVoiceTranscriptUpdate({
    input: 'existing input',
    transcript: '   ',
    range: { start: 9, end: 14, text: 'input' },
    selectionStart: 14,
    selectionEnd: 14,
    isFinal: false,
  });
  assert.equal(result.value, 'existing input');
  assert.deepEqual(result.range, { start: 9, end: 14, text: 'input' });
}

function runAll(): void {
  testAsrClientDebugDefaultsOffOutsideBrowser();
  testAsrClientDebugQueryRequiresExactOne();
  testDraftUpdatesReplaceExistingDraft();
  testExistingTextAppendsAtCursorEnd();
  testExistingTextInsertsAtMiddleCursor();
  testExistingSelectionIsReplacedByFirstDraft();
  testFinalUpdateCommitsDraftAndClearsRange();
  testFinalUpdateDoesNotRemoveManualTextAfterDraft();
  testDraftRangeTracksUserInsertBeforeDraft();
  testEditedDraftTextIsNotOverwrittenOrRelocated();
  testStaleDraftDoesNotReplaceUserSelection();
  testEmptyFinalTranscriptClearsDraftRange();
  testEmptyDraftTranscriptIsNoop();
  console.log('voice-input transcript tests passed');
}

runAll();
