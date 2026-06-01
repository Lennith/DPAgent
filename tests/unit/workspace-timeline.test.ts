import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import {
  TurnWorkspaceTransactionCoordinator,
  WorkspaceTimelineStore,
  normalizeWorkspaceTimelineConfig,
} from '../../src/workspace-timeline/index.js';
import type { TurnWorkspaceDelta } from '../../src/workspace-timeline/index.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-workspace-timeline-'));
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createEnabledStore(root: string, retainedStageTurns = 5, captureMode: 'advisory' | 'git_observed' = 'advisory') {
  return new WorkspaceTimelineStore({
    runtimeDataDir: path.join(root, 'runtime'),
    config: {
      enabled: true,
      captureMode,
      retainedStageTurns,
      gitPrivateRefs: false,
    },
  });
}

function testConfigDefaultsAndNormalization(): void {
  const config = new ConfigManager().get();
  assert.deepEqual(config.workspaceTimeline, {
    enabled: false,
    captureMode: 'advisory',
    retainedStageTurns: 5,
    gitPrivateRefs: false,
  });
  assert.deepEqual(normalizeWorkspaceTimelineConfig({ enabled: true, captureMode: 'git_observed', retainedStageTurns: 99, gitPrivateRefs: true }), {
    enabled: true,
    captureMode: 'git_observed',
    retainedStageTurns: 20,
    gitPrivateRefs: true,
  });
  assert.deepEqual(normalizeWorkspaceTimelineConfig('bad-config'), {
    enabled: false,
    captureMode: 'advisory',
    retainedStageTurns: 5,
    gitPrivateRefs: false,
  });
  assert.equal(normalizeWorkspaceTimelineConfig({ retainedStageTurns: 0 }).retainedStageTurns, 1);
}

function testStoreCapturesAddModifyDelete(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'edit.txt'), 'before', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'delete.txt'), 'remove', 'utf-8');
    const store = createEnabledStore(root);
    const handle = store.beginTurn({
      context: { scope: 'session', namespace: 'sess-a' },
      turnId: 'turn-a',
      workspaceDir: workspace,
    });
    assert.ok(handle);
    fs.writeFileSync(path.join(workspace, 'edit.txt'), 'after', 'utf-8');
    fs.rmSync(path.join(workspace, 'delete.txt'));
    fs.writeFileSync(path.join(workspace, 'add.txt'), 'new', 'utf-8');
    const prepared = store.prepareTurnDelta(handle);
    assert.deepEqual(prepared.delta.changedFiles, ['add.txt', 'delete.txt', 'edit.txt']);
    assert.deepEqual(prepared.delta.entries.map((entry) => entry.operation).sort(), ['add', 'delete', 'modify']);
    store.markCommitted(prepared.delta.id);
    const timeline = store.listSessionTimeline('sess-a');
    assert.equal(timeline.deltas.length, 1);
    assert.equal(timeline.deltas[0]?.blobState, 'available');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function commitFileValue(
  store: WorkspaceTimelineStore,
  workspace: string,
  sessionId: string,
  turnId: string,
  value: string
): string {
  const handle = store.beginTurn({
    context: { scope: 'session', namespace: sessionId },
    turnId,
    workspaceDir: workspace,
  });
  assert.ok(handle);
  fs.writeFileSync(path.join(workspace, 'file.txt'), value, 'utf-8');
  const prepared = store.prepareTurnDelta(handle);
  store.markCommitted(prepared.delta.id);
  assert.ok(prepared.resultRevision.id);
  return prepared.resultRevision.id;
}

function testRollbackCanMoveBackwardTwiceAndForwardAgain(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'file.txt'), '0', 'utf-8');
    const store = createEnabledStore(root);
    const sessionId = 'sess-rollback';
    const r1 = commitFileValue(store, workspace, sessionId, 'turn-1', '1');
    const r2 = commitFileValue(store, workspace, sessionId, 'turn-2', '2');
    const r3 = commitFileValue(store, workspace, sessionId, 'turn-3', '3');

    fs.writeFileSync(path.join(workspace, 'file.txt'), 'winner', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'winner-only.txt'), 'arena', 'utf-8');

    const toR2 = store.applyRollback({ sessionId, targetRevisionId: r2, reason: 'to r2' });
    assert.deepEqual(toR2.changedFiles, ['file.txt', 'winner-only.txt']);
    assert.equal(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf-8'), '2');
    assert.equal(fs.existsSync(path.join(workspace, 'winner-only.txt')), false);

    const toR1 = store.applyRollback({ sessionId, targetRevisionId: r1, reason: 'to r1' });
    assert.deepEqual(toR1.changedFiles, ['file.txt']);
    assert.equal(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf-8'), '1');

    const backToR3 = store.applyRollback({ sessionId, targetRevisionId: r3, reason: 'back to r3' });
    assert.deepEqual(backToR3.changedFiles, ['file.txt']);
    assert.equal(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf-8'), '3');

    const audit = fs.readFileSync(path.join(root, 'runtime', 'workspace-timeline', 'rollback-audit.jsonl'), 'utf-8');
    assert.match(audit, /to r2/);
    assert.match(audit, /to r1/);
    assert.match(audit, /back to r3/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testRollbackFailureRestoresPreRollbackWorkspace(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'file.txt'), '0', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'blocked.txt'), 'file', 'utf-8');
    const store = createEnabledStore(root);
    const sessionId = 'sess-rollback-failure';
    const targetRevisionId = commitFileValue(store, workspace, sessionId, 'turn-1', '1');
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'current', 'utf-8');
    fs.rmSync(path.join(workspace, 'blocked.txt'));
    fs.mkdirSync(path.join(workspace, 'blocked.txt'));

    assert.throws(
      () => store.applyRollback({ sessionId, targetRevisionId, reason: 'expected failure' }),
      /regular files/
    );
    assert.equal(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf-8'), 'current');
    assert.equal(fs.lstatSync(path.join(workspace, 'blocked.txt')).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(root, 'runtime', 'workspace-timeline', 'rollback-audit.jsonl')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testRetentionKeepsOnlyFiveBlobBackedStages(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'file.txt'), '0', 'utf-8');
    const store = createEnabledStore(root, 5);
    for (let i = 1; i <= 6; i += 1) {
      const handle = store.beginTurn({
        context: { scope: 'session', namespace: 'sess-retain' },
        turnId: `turn-${i}`,
        workspaceDir: workspace,
      });
      assert.ok(handle);
      fs.writeFileSync(path.join(workspace, 'file.txt'), String(i), 'utf-8');
      const prepared = store.prepareTurnDelta(handle);
      store.markCommitted(prepared.delta.id);
    }
    const timeline = store.listSessionTimeline('sess-retain');
    assert.equal(timeline.deltas.length, 6);
    assert.equal(timeline.deltas.filter((delta) => delta.blobState === 'available').length, 5);
    assert.equal(timeline.deltas[timeline.deltas.length - 1]?.blobState, 'summary_only');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testGitObservedDoesNotCreateUserVisibleGitState(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'repo');
    fs.mkdirSync(workspace, { recursive: true });
    runGit(workspace, ['init']);
    runGit(workspace, ['config', 'user.email', 'test@example.com']);
    runGit(workspace, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(workspace, '.gitignore'), 'ignored.txt\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'base', 'utf-8');
    runGit(workspace, ['add', '.gitignore', 'tracked.txt']);
    runGit(workspace, ['commit', '-m', 'initial']);
    const headBefore = runGit(workspace, ['rev-parse', 'HEAD']);
    const branchBefore = runGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const indexBefore = runGit(workspace, ['status', '--porcelain=v1', '-z']);
    const stashBefore = runGit(workspace, ['stash', 'list']);
    const store = createEnabledStore(root, 5, 'git_observed');
    const handle = store.beginTurn({
      context: { scope: 'session', namespace: 'sess-git' },
      turnId: 'turn-git',
      workspaceDir: workspace,
    });
    assert.ok(handle);
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'changed', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'new.txt'), 'new', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'ignored.txt'), 'ignored', 'utf-8');
    const prepared = store.prepareTurnDelta(handle);
    store.markCommitted(prepared.delta.id);
    assert.equal(prepared.delta.trustLevel, 'git_observed');
    assert.deepEqual(prepared.delta.changedFiles, ['new.txt', 'tracked.txt']);
    assert.match(prepared.delta.captureWarnings.join('\n'), /Ignored files/);
    assert.equal(runGit(workspace, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(runGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']), branchBefore);
    assert.equal(indexBefore, '');
    assert.equal(runGit(workspace, ['diff', '--cached', '--name-only']), '');
    assert.equal(runGit(workspace, ['stash', 'list']), stashBefore);
    assert.equal(runGit(workspace, ['show-ref']).includes('refs/dpagent/'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testUnbornGitRepoUsesCasWithoutCommit(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'repo');
    fs.mkdirSync(workspace, { recursive: true });
    runGit(workspace, ['init']);
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'base', 'utf-8');
    const store = createEnabledStore(root, 5, 'git_observed');
    const handle = store.beginTurn({
      context: { scope: 'session', namespace: 'sess-unborn' },
      turnId: 'turn-unborn',
      workspaceDir: workspace,
    });
    assert.ok(handle);
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'next', 'utf-8');
    const prepared = store.prepareTurnDelta(handle);
    assert.equal(prepared.resultRevision.repoKind, 'git_unborn');
    assert.equal(prepared.delta.trustLevel, 'observed_partial');
    assert.throws(() => runGit(workspace, ['rev-parse', '--verify', 'HEAD']), /HEAD|returned non-zero|Command failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCoordinatorCommitsWorkspaceTimelineMetadata(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'base', 'utf-8');
    const contextManager = new ContextManager(new ContextEventStore(path.join(root, 'contexts')));
    const store = createEnabledStore(root);
    const coordinator = new TurnWorkspaceTransactionCoordinator({ contextManager, timelineStore: store });
    const context = { scope: 'session' as const, namespace: 'sess-context' };
    const turn = contextManager.beginTurn(context, 'edit', workspace);
    const handle = coordinator.beginTurn({ context, turnId: turn.turnId, workspaceDir: workspace });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'after', 'utf-8');
    const result = coordinator.commitPreparedTurn(turn.turnId, handle, {
      messages: [{ role: 'assistant', content: 'done' }],
      finalOutputText: 'done',
      finishReason: 'completed',
    });
    assert.equal(result.contextVersion, 1);
    const committed = contextManager.getEventStore().readEvents('session', 'sess-context').find((event) => event.type === 'turn_committed');
    assert.ok(committed);
    const metadata = committed.data.workspaceTimeline as { deltaId?: string; changedFiles?: string[]; auditOnly?: boolean };
    assert.ok(metadata.deltaId);
    assert.deepEqual(metadata.changedFiles, ['file.txt']);
    assert.equal(metadata.auditOnly, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCoordinatorRecoversFinalizeFailureAfterContextCommit(): void {
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
    const contextManager = new ContextManager(new ContextEventStore(path.join(root, 'contexts')));
    const store = new FailOnceMarkCommittedStore({
      runtimeDataDir: path.join(root, 'runtime'),
      config: {
        enabled: true,
        captureMode: 'advisory',
        retainedStageTurns: 5,
        gitPrivateRefs: false,
      },
    });
    const coordinator = new TurnWorkspaceTransactionCoordinator({ contextManager, timelineStore: store });
    const context = { scope: 'session' as const, namespace: 'sess-recover' };
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

function run(): void {
  testConfigDefaultsAndNormalization();
  testStoreCapturesAddModifyDelete();
  testRollbackCanMoveBackwardTwiceAndForwardAgain();
  testRollbackFailureRestoresPreRollbackWorkspace();
  testRetentionKeepsOnlyFiveBlobBackedStages();
  testGitObservedDoesNotCreateUserVisibleGitState();
  testUnbornGitRepoUsesCasWithoutCommit();
  testCoordinatorCommitsWorkspaceTimelineMetadata();
  testCoordinatorRecoversFinalizeFailureAfterContextCommit();
  console.log('workspace-timeline tests passed');
}

run();
