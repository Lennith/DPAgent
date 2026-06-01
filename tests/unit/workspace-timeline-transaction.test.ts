import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import {
  TurnWorkspaceTransactionCoordinator,
  WorkspaceTimelineStore,
} from '../../src/workspace-timeline/index.js';
import type { TurnWorkspaceDelta } from '../../src/workspace-timeline/index.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-workspace-timeline-tx-'));
}

function createStore(root: string): WorkspaceTimelineStore {
  return new WorkspaceTimelineStore({
    runtimeDataDir: path.join(root, 'runtime'),
    config: {
      enabled: true,
      captureMode: 'advisory',
      retainedStageTurns: 5,
      gitPrivateRefs: false,
    },
  });
}

function createDisabledStore(root: string): WorkspaceTimelineStore {
  return new WorkspaceTimelineStore({
    runtimeDataDir: path.join(root, 'runtime'),
    config: {
      enabled: false,
      captureMode: 'advisory',
      retainedStageTurns: 5,
      gitPrivateRefs: false,
    },
  });
}

function createHarness(root: string, store: WorkspaceTimelineStore = createStore(root)) {
  const contextManager = new ContextManager(new ContextEventStore(path.join(root, 'contexts')));
  const coordinator = new TurnWorkspaceTransactionCoordinator({ contextManager, timelineStore: store });
  return { contextManager, coordinator, store };
}

function testPrepareFailureAbortsDeltaAndDoesNotCommitContext(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'base', 'utf-8');
    const { contextManager, coordinator, store } = createHarness(root);
    const context = { scope: 'session' as const, namespace: 'sess-prepare-fail' };
    const turn = contextManager.beginTurn(context, 'edit', workspace);
    const handle = coordinator.beginTurn({ context, turnId: turn.turnId, workspaceDir: workspace });
    assert.ok(handle);
    fs.rmSync(workspace, { recursive: true, force: true });

    assert.throws(() => coordinator.commitPreparedTurn(turn.turnId, handle, {
      messages: [{ role: 'assistant', content: 'done' }],
      finalOutputText: 'done',
    }));
    assert.equal(store.getDelta(handle.deltaId)?.status, 'aborted');
    assert.equal(contextManager.getEventStore().readEvents('session', context.namespace).some((event) => event.type === 'turn_committed'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testContextCommitFailureAbortsPreparedDelta(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'base', 'utf-8');
    const { contextManager, coordinator, store } = createHarness(root);
    const context = { scope: 'session' as const, namespace: 'sess-context-fail' };
    const turn = contextManager.beginTurn(context, 'edit', workspace);
    const handle = coordinator.beginTurn({ context, turnId: turn.turnId, workspaceDir: workspace });
    assert.ok(handle);
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'next', 'utf-8');

    assert.throws(() => coordinator.commitPreparedTurn('missing-turn', handle, {
      messages: [{ role: 'assistant', content: 'done' }],
      finalOutputText: 'done',
    }));
    assert.equal(store.getDelta(handle.deltaId)?.status, 'aborted');
    assert.equal(contextManager.getEventStore().readEvents('session', context.namespace).some((event) => event.type === 'turn_committed'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testFinalizeFailureAfterContextCommitRecoversPreparedDelta(): void {
  const root = tempRoot();
  class FailOnceMarkCommittedStore extends WorkspaceTimelineStore {
    private shouldFail = true;

    override markCommitted(deltaId: string): TurnWorkspaceDelta {
      if (this.shouldFail) {
        this.shouldFail = false;
        throw new Error('finalize failed');
      }
      return super.markCommitted(deltaId);
    }
  }
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'base', 'utf-8');
    const store = new FailOnceMarkCommittedStore({
      runtimeDataDir: path.join(root, 'runtime'),
      config: {
        enabled: true,
        captureMode: 'advisory',
        retainedStageTurns: 5,
        gitPrivateRefs: false,
      },
    });
    const { contextManager, coordinator } = createHarness(root, store);
    const context = { scope: 'session' as const, namespace: 'sess-recover-finalize' };
    const turn = contextManager.beginTurn(context, 'edit', workspace);
    const handle = coordinator.beginTurn({ context, turnId: turn.turnId, workspaceDir: workspace });
    assert.ok(handle);
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'after', 'utf-8');

    const result = coordinator.commitPreparedTurn(turn.turnId, handle, {
      messages: [{ role: 'assistant', content: 'done' }],
      finalOutputText: 'done',
      finishReason: 'completed',
    });
    assert.equal(result.contextVersion, 1);
    assert.equal(store.getDelta(handle.deltaId)?.status, 'prepared');
    const recovery = coordinator.recoverPreparedCommits();
    assert.deepEqual(recovery.recovered, [handle.deltaId]);
    assert.equal(store.getDelta(handle.deltaId)?.status, 'committed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPreparedDeltaWithoutContextCommitBecomesIncompleteOnRecovery(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'base', 'utf-8');
    const { coordinator, store } = createHarness(root);
    const context = { scope: 'session' as const, namespace: 'sess-incomplete' };
    const handle = store.beginTurn({ context, turnId: 'turn-orphan', workspaceDir: workspace });
    assert.ok(handle);
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'after', 'utf-8');
    store.prepareTurnDelta(handle);

    const recovery = coordinator.recoverPreparedCommits();
    assert.deepEqual(recovery.aborted, [handle.deltaId]);
    assert.equal(store.getDelta(handle.deltaId)?.status, 'incomplete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCancelledTurnAbortsDelta(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'base', 'utf-8');
    const { contextManager, coordinator, store } = createHarness(root);
    const context = { scope: 'session' as const, namespace: 'sess-cancel' };
    const turn = contextManager.beginTurn(context, 'edit', workspace);
    const handle = coordinator.beginTurn({ context, turnId: turn.turnId, workspaceDir: workspace });
    assert.ok(handle);

    coordinator.abortTurn(handle, 'cancelled');
    assert.equal(store.getDelta(handle.deltaId)?.status, 'aborted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testAbortTurnWithoutHandleIsNoop(): void {
  const root = tempRoot();
  try {
    const { coordinator } = createHarness(root);
    assert.doesNotThrow(() => coordinator.abortTurn(null, 'nothing to abort'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testDisabledTimelineCommitsWithoutMetadata(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const store = new WorkspaceTimelineStore({
      runtimeDataDir: path.join(root, 'runtime'),
      config: {
        enabled: false,
        captureMode: 'advisory',
        retainedStageTurns: 5,
        gitPrivateRefs: false,
      },
    });
    const { contextManager, coordinator } = createHarness(root, store);
    const context = { scope: 'session' as const, namespace: 'sess-disabled-commit' };
    const turn = contextManager.beginTurn(context, 'edit', workspace);
    const handle = coordinator.beginTurn({ context, turnId: turn.turnId, workspaceDir: workspace });
    assert.equal(handle, null);
    coordinator.commitPreparedTurn(turn.turnId, handle, {
      messages: [{ role: 'assistant', content: 'done' }],
      finalOutputText: 'done',
    });
    const committed = contextManager.getEventStore().readEvents('session', context.namespace).find((event) => event.type === 'turn_committed');
    assert.ok(committed);
    assert.equal((committed.data as { workspaceTimeline?: unknown }).workspaceTimeline, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testTimelineDisabledBeforeCommitDoesNotCaptureMetadata(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'base', 'utf-8');
    const contextManager = new ContextManager(new ContextEventStore(path.join(root, 'contexts')));
    const enabledStore = createStore(root);
    const enabledCoordinator = new TurnWorkspaceTransactionCoordinator({ contextManager, timelineStore: enabledStore });
    const context = { scope: 'session' as const, namespace: 'sess-disable-before-commit' };
    const turn = contextManager.beginTurn(context, 'edit', workspace);
    const handle = enabledCoordinator.beginTurn({ context, turnId: turn.turnId, workspaceDir: workspace });
    assert.ok(handle);
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'after', 'utf-8');

    const disabledCoordinator = new TurnWorkspaceTransactionCoordinator({
      contextManager,
      timelineStore: createDisabledStore(root),
    });
    disabledCoordinator.commitPreparedTurn(turn.turnId, handle, {
      messages: [{ role: 'assistant', content: 'done' }],
      finalOutputText: 'done',
    });

    const committed = contextManager.getEventStore().readEvents('session', context.namespace).find((event) => event.type === 'turn_committed');
    assert.ok(committed);
    assert.equal((committed.data as { workspaceTimeline?: unknown }).workspaceTimeline, undefined);
    assert.equal(enabledStore.getDelta(handle.deltaId)?.status, 'aborted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(): void {
  testPrepareFailureAbortsDeltaAndDoesNotCommitContext();
  testContextCommitFailureAbortsPreparedDelta();
  testFinalizeFailureAfterContextCommitRecoversPreparedDelta();
  testPreparedDeltaWithoutContextCommitBecomesIncompleteOnRecovery();
  testCancelledTurnAbortsDelta();
  testAbortTurnWithoutHandleIsNoop();
  testDisabledTimelineCommitsWithoutMetadata();
  testTimelineDisabledBeforeCommitDoesNotCaptureMetadata();
  console.log('workspace-timeline transaction tests passed');
}

run();
