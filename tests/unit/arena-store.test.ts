import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArenaStore } from '../../src/arena/index.js';
import type { SessionLlmSelection } from '../../src/types.js';

function createSelection(model = 'model-a'): SessionLlmSelection {
  return {
    profileId: 'profile-a',
    model,
    reasoningPreset: 'high',
    updatedAt: '2026-05-29T00:00:00.000Z',
  };
}

function createHarness(): { tempDir: string; store: ArenaStore } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-store-'));
  return {
    tempDir,
    store: new ArenaStore(path.join(tempDir, 'arena')),
  };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function testCreateDraftUsesDefaultTwoContestants(): void {
  const { tempDir, store } = createHarness();
  try {
    const run = store.createDraft({
      sourceSessionId: 'sess-source',
      sourceSessionName: 'aaa',
      sourceEventCount: 3,
      prompt: 'compare answers',
      currentLlmSelection: createSelection(),
    });

    assert.equal(run.status, 'draft');
    assert.equal(run.mode, 'answer');
    assert.equal(run.config.contestants.length, 2);
    assert.equal(run.branches.length, 2);
    assert.equal(run.branches[0]?.status, 'draft');
    assert.equal(run.config.judge.llmSelection.model, 'model-a');
    assert.equal(store.getActiveRunForSource('sess-source')?.id, run.id);
  } finally {
    cleanup(tempDir);
  }
}

function testConfigInheritanceAndMaxContestants(): void {
  const { tempDir, store } = createHarness();
  try {
    const contestants = [1, 2, 3, 4].map((index) => ({
      id: `c-${index}`,
      label: `C${index}`,
      agentName: `agent-${index}`,
      llmSelection: createSelection(`model-${index}`),
    }));
    const first = store.createDraft({
      sourceSessionId: 'sess-a',
      sourceEventCount: 1,
      currentLlmSelection: createSelection(),
      config: {
        contestants,
        judge: { agentName: 'judge', llmSelection: createSelection('judge-model') },
      },
    });
    assert.equal(first.config.contestants.length, 4);

    const inherited = store.createDraft({
      sourceSessionId: 'sess-b',
      sourceEventCount: 1,
      currentLlmSelection: createSelection('fallback-model'),
    });
    assert.equal(inherited.config.contestants.length, 4);
    assert.equal(inherited.config.contestants[3]?.llmSelection.model, 'model-4');
    assert.equal(inherited.config.judge.llmSelection.model, 'judge-model');
    const reloadedInherited = new ArenaStore(path.join(tempDir, 'arena')).createDraft({
      sourceSessionId: 'sess-c',
      sourceEventCount: 1,
      currentLlmSelection: createSelection('fallback-model'),
    });
    assert.equal(reloadedInherited.config.contestants[0]?.llmSelection.model, 'model-1');

    assert.throws(
      () =>
        store.updateConfig(inherited.id, {
          contestants: [1, 2, 3, 4, 5].map((index) => ({
            id: `too-many-${index}`,
            label: `Too many ${index}`,
            llmSelection: createSelection(`m-${index}`),
          })),
        }),
      /1-4 contestants/
    );
  } finally {
    cleanup(tempDir);
  }
}

function testRunAndBranchTransitionsPersist(): void {
  const { tempDir, store } = createHarness();
  try {
    const run = store.createDraft({
      sourceSessionId: 'sess-source',
      sourceEventCount: 1,
      currentLlmSelection: createSelection(),
    });
    const preparing = store.setRunStatus(run.id, 'preparing');
    assert.equal(preparing.status, 'preparing');
    const running = store.setRunStatus(run.id, 'running');
    assert.equal(running.status, 'running');

    const branchId = running.branches[0]?.id ?? '';
    store.setBranchStatus(run.id, branchId, 'preparing');
    store.assignBranchSession({
      arenaId: run.id,
      branchId,
      sessionId: 'arena-branch-session',
      workspaceDir: 'D:/arena/workspace',
    });
    const updated = store.setBranchStatus(run.id, branchId, 'running');
    const branch = updated.branches.find((item) => item.id === branchId);
    assert.equal(branch?.status, 'running');
    assert.equal(branch?.sessionId, 'arena-branch-session');
    assert.equal(branch?.workspaceDir, 'D:/arena/workspace');

    const reloaded = new ArenaStore(path.join(tempDir, 'arena')).getRun(run.id);
    assert.equal(reloaded?.branches[0]?.sessionId, 'arena-branch-session');
  } finally {
    cleanup(tempDir);
  }
}

function testPausedArenaCanProceedToJudging(): void {
  const { tempDir, store } = createHarness();
  try {
    const run = store.createDraft({
      sourceSessionId: 'sess-source',
      sourceEventCount: 1,
      currentLlmSelection: createSelection(),
    });
    store.setRunStatus(run.id, 'preparing');
    store.setRunStatus(run.id, 'running');
    store.setRunStatus(run.id, 'paused');
    const judging = store.setRunStatus(run.id, 'judging');
    assert.equal(judging.status, 'judging');
  } finally {
    cleanup(tempDir);
  }
}

function testReopenRejectedAfterJudging(): void {
  const { tempDir, store } = createHarness();
  try {
    const run = store.createDraft({
      sourceSessionId: 'sess-source',
      sourceEventCount: 1,
      currentLlmSelection: createSelection(),
    });
    const branchId = run.branches[0]?.id ?? '';
    store.setRunStatus(run.id, 'preparing');
    store.setRunStatus(run.id, 'running');
    store.setBranchStatus(run.id, branchId, 'preparing');
    store.setBranchStatus(run.id, branchId, 'running');
    store.setBranchStatus(run.id, branchId, 'submitted');
    store.setRunStatus(run.id, 'judging');
    assert.throws(
      () => store.setBranchStatus(run.id, branchId, 'reopened'),
      /cannot reopen after judge has started/
    );
  } finally {
    cleanup(tempDir);
  }
}

function testFailedOrCancelledCannotReopenAfterJudging(): void {
  const { tempDir, store } = createHarness();
  try {
    const run = store.createDraft({
      sourceSessionId: 'sess-source',
      sourceEventCount: 1,
      currentLlmSelection: createSelection(),
    });
    const failedBranchId = run.branches[0]?.id ?? '';
    const cancelledBranchId = run.branches[1]?.id ?? '';
    store.setRunStatus(run.id, 'preparing');
    store.setRunStatus(run.id, 'running');
    store.setBranchStatus(run.id, failedBranchId, 'preparing');
    store.setBranchStatus(run.id, failedBranchId, 'failed');
    store.setBranchStatus(run.id, cancelledBranchId, 'cancelled');
    store.setRunStatus(run.id, 'judging');

    assert.throws(
      () => store.setBranchStatus(run.id, failedBranchId, 'reopened'),
      /cannot reopen after judge has started/
    );
    assert.throws(
      () => store.setBranchStatus(run.id, cancelledBranchId, 'reopened'),
      /cannot reopen after judge has started/
    );
  } finally {
    cleanup(tempDir);
  }
}

function testEmptyDurableIdsRejectedAndTerminalNotActive(): void {
  const { tempDir, store } = createHarness();
  try {
    assert.throws(
      () =>
        store.createDraft({
          sourceSessionId: ' ',
          sourceEventCount: 1,
          currentLlmSelection: createSelection(),
        }),
      /sourceSessionId is required/
    );
    const run = store.createDraft({
      sourceSessionId: 'sess-source',
      sourceEventCount: 1,
      currentLlmSelection: createSelection(),
    });
    assert.throws(
      () =>
        store.assignBranchSession({
          arenaId: run.id,
          branchId: run.branches[0]?.id ?? '',
          sessionId: ' ',
        }),
      /branch sessionId is required/
    );
    store.setRunStatus(run.id, 'closed');
    assert.equal(store.getActiveRunForSource('sess-source'), undefined);
  } finally {
    cleanup(tempDir);
  }
}

function testInvalidTransitionsRejected(): void {
  const { tempDir, store } = createHarness();
  try {
    const run = store.createDraft({
      sourceSessionId: 'sess-source',
      sourceEventCount: 1,
      currentLlmSelection: createSelection(),
    });
    assert.throws(() => store.setRunStatus(run.id, 'applied'), /Invalid Arena status transition/);
    assert.throws(
      () => store.setBranchStatus(run.id, run.branches[0]?.id ?? '', 'submitted'),
      /Invalid Arena branch status transition/
    );
  } finally {
    cleanup(tempDir);
  }
}

testCreateDraftUsesDefaultTwoContestants();
testConfigInheritanceAndMaxContestants();
testRunAndBranchTransitionsPersist();
testPausedArenaCanProceedToJudging();
testReopenRejectedAfterJudging();
testFailedOrCancelledCannotReopenAfterJudging();
testEmptyDurableIdsRejectedAndTerminalNotActive();
testInvalidTransitionsRejected();
console.log('arena-store tests passed');
