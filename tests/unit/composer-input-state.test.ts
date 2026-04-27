import * as assert from 'node:assert/strict';
import {
  clearComposerInput,
  COMPOSER_DRAFT_KEY,
  getComposerInput,
  removeComposerInput,
  resolveComposerInputKey,
  setComposerInput,
  type ComposerInputBySession,
} from '../../src/web/client/composer-input-state.js';

function testResolveComposerInputKeyUsesDraftForEmptySession(): void {
  assert.equal(resolveComposerInputKey(undefined), COMPOSER_DRAFT_KEY);
  assert.equal(resolveComposerInputKey(null), COMPOSER_DRAFT_KEY);
  assert.equal(resolveComposerInputKey('   '), COMPOSER_DRAFT_KEY);
  assert.equal(resolveComposerInputKey('sess-a'), 'sess-a');
}

function testSessionInputsAreIsolated(): void {
  let state: ComposerInputBySession = {};
  state = setComposerInput(state, 'sess-a', 'prompt from A');
  state = setComposerInput(state, 'sess-b', 'prompt from B');

  assert.equal(getComposerInput(state, 'sess-a'), 'prompt from A');
  assert.equal(getComposerInput(state, 'sess-b'), 'prompt from B');
}

function testClearOneSessionDoesNotAffectAnother(): void {
  let state: ComposerInputBySession = {};
  state = setComposerInput(state, 'sess-a', 'A content');
  state = setComposerInput(state, 'sess-b', 'B content');

  const clearedA = clearComposerInput(state, 'sess-a');
  assert.equal(getComposerInput(clearedA, 'sess-a'), '');
  assert.equal(getComposerInput(clearedA, 'sess-b'), 'B content');
}

function testDraftInputIsIsolatedFromNamedSession(): void {
  let state: ComposerInputBySession = {};
  state = setComposerInput(state, null, 'draft text');
  state = setComposerInput(state, 'sess-a', 'session text');

  assert.equal(getComposerInput(state, null), 'draft text');
  assert.equal(getComposerInput(state, COMPOSER_DRAFT_KEY), 'draft text');
  assert.equal(getComposerInput(state, 'sess-a'), 'session text');
}

function testRemoveComposerInputDeletesOnlyTargetSession(): void {
  let state: ComposerInputBySession = {};
  state = setComposerInput(state, 'sess-a', 'A content');
  state = setComposerInput(state, 'sess-b', 'B content');

  const removedA = removeComposerInput(state, 'sess-a');
  assert.equal(getComposerInput(removedA, 'sess-a'), '');
  assert.equal(getComposerInput(removedA, 'sess-b'), 'B content');
}

function testAutoLoopLikeSessionEventsDoNotPolluteOtherSessionDraft(): void {
  let state: ComposerInputBySession = {};
  state = setComposerInput(state, 'sess-a', 'auto-loop running session A');
  state = setComposerInput(state, 'sess-b', 'I am typing in B');

  // Simulate A turn completion where composer for A is cleared after send.
  state = clearComposerInput(state, 'sess-a');
  assert.equal(getComposerInput(state, 'sess-a'), '');
  assert.equal(getComposerInput(state, 'sess-b'), 'I am typing in B');

  // Simulate switching between sessions keeps each isolated draft.
  assert.equal(getComposerInput(state, 'sess-b'), 'I am typing in B');
  state = setComposerInput(state, 'sess-a', 'new draft in A');
  assert.equal(getComposerInput(state, 'sess-a'), 'new draft in A');
  assert.equal(getComposerInput(state, 'sess-b'), 'I am typing in B');
}

function runAll(): void {
  testResolveComposerInputKeyUsesDraftForEmptySession();
  testSessionInputsAreIsolated();
  testClearOneSessionDoesNotAffectAnother();
  testDraftInputIsIsolatedFromNamedSession();
  testRemoveComposerInputDeletesOnlyTargetSession();
  testAutoLoopLikeSessionEventsDoNotPolluteOtherSessionDraft();
  console.log('composer-input-state tests passed');
}

runAll();
