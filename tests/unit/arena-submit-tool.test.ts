import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArenaStore, ArenaSubmitResultTool } from '../../src/arena/index.js';
import { TodoStore } from '../../src/todo/index.js';
import type { ContextNamespaceMeta, ContextRef } from '../../src/types.js';

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-arena-submit-'));
  const arenaStore = new ArenaStore(path.join(tempDir, 'arena'));
  const todoStore = new TodoStore(path.join(tempDir, 'todos'));
  const run = arenaStore.createDraft({
    sourceSessionId: 'sess-source',
    sourceSessionName: 'source',
    sourceEventCount: 1,
    mode: 'answer',
    currentLlmSelection: {
      profileId: 'default',
      model: 'MiniMax-M2.5',
      reasoningPreset: 'off',
      updatedAt: '2026-05-29T00:00:00.000Z',
    },
  });
  arenaStore.setRunStatus(run.id, 'preparing');
  arenaStore.setBranchStatus(run.id, 'branch-1', 'preparing');
  arenaStore.setRunStatus(run.id, 'running');
  arenaStore.setBranchStatus(run.id, 'branch-1', 'running');
  const context: ContextRef = { scope: 'session', namespace: 'sess-branch' };
  const meta: ContextNamespaceMeta = {
    scope: 'session',
    namespace: 'sess-branch',
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    workspaceDir: path.join(tempDir, 'workspace'),
    arenaBranch: {
      arenaId: run.id,
      branchId: 'branch-1',
      sourceSessionId: 'sess-source',
    },
  };
  const tool = new ArenaSubmitResultTool({ context, meta, arenaStore, todoStore });
  return { tempDir, arenaStore, todoStore, run, context, meta, tool };
}

async function testCompleteRequiresNoUnfinishedTodo(): Promise<void> {
  const harness = createHarness();
  try {
    harness.todoStore.createTodo({
      sessionId: harness.context.namespace,
      workspaceDir: harness.meta.workspaceDir,
      scope: 'session',
      work: 'Finish work',
      detectionStandard: 'Work is complete',
    });
    const result = await harness.tool.execute({
      status: 'complete',
      summary: 'done',
      evidence: ['checked'],
    });
    assert.equal(result.success, false);
    assert.match(String(result.error ?? ''), /unfinished Todo count to be 0/i);
  } finally {
    fs.rmSync(harness.tempDir, { recursive: true, force: true });
  }
}

async function testBlockedRequiresEvidence(): Promise<void> {
  const harness = createHarness();
  try {
    const result = await harness.tool.execute({
      status: 'blocked',
      summary: 'blocked',
      evidence: [],
    });
    assert.equal(result.success, false);
    assert.match(String(result.error ?? ''), /blocked submissions require evidence/i);
  } finally {
    fs.rmSync(harness.tempDir, { recursive: true, force: true });
  }
}

async function testCompleteSubmitsBranch(): Promise<void> {
  const harness = createHarness();
  try {
    const result = await harness.tool.execute({
      status: 'complete',
      summary: 'done',
      final_answer: 'final',
      evidence: ['checked'],
      changed_files: ['README.md'],
      risks: ['none'],
    });
    assert.equal(result.success, true);
    const branch = harness.arenaStore.getRun(harness.run.id)?.branches[0];
    assert.equal(branch?.status, 'submitted');
    assert.equal(branch?.submission?.finalAnswer, 'final');
    assert.deepEqual(branch?.submission?.changedFiles, ['README.md']);
  } finally {
    fs.rmSync(harness.tempDir, { recursive: true, force: true });
  }
}

async function testNonArenaSessionCannotSubmit(): Promise<void> {
  const harness = createHarness();
  try {
    const tool = new ArenaSubmitResultTool({
      context: harness.context,
      meta: {
        scope: 'session',
        namespace: 'sess-branch',
        createdAt: '2026-05-29T00:00:00.000Z',
        updatedAt: '2026-05-29T00:00:00.000Z',
      },
      arenaStore: harness.arenaStore,
      todoStore: harness.todoStore,
    });
    const result = await tool.execute({
      status: 'complete',
      summary: 'done',
      evidence: ['checked'],
    });
    assert.equal(result.success, false);
    assert.match(String(result.error ?? ''), /only available inside an Arena branch/i);
  } finally {
    fs.rmSync(harness.tempDir, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  await testCompleteRequiresNoUnfinishedTodo();
  await testBlockedRequiresEvidence();
  await testCompleteSubmitsBranch();
  await testNonArenaSessionCannotSubmit();
  console.log('arena-submit-tool tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
