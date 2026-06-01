import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceTimelineStore } from '../../src/workspace-timeline/index.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-workspace-timeline-git-'));
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryRunGit(cwd: string, args: string[]): string {
  try {
    return runGit(cwd, args);
  } catch {
    return '';
  }
}

function createStore(root: string, captureMode: 'advisory' | 'git_observed' = 'git_observed'): WorkspaceTimelineStore {
  return new WorkspaceTimelineStore({
    runtimeDataDir: path.join(root, 'runtime'),
    config: {
      enabled: true,
      captureMode,
      retainedStageTurns: 5,
      gitPrivateRefs: false,
    },
  });
}

function initCommittedRepo(workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
  runGit(workspace, ['init']);
  runGit(workspace, ['config', 'user.email', 'test@example.com']);
  runGit(workspace, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.gitignore'), 'ignored.txt\nignored-dir/\n', 'utf-8');
  fs.writeFileSync(path.join(workspace, 'src', 'edit.txt'), 'base', 'utf-8');
  fs.writeFileSync(path.join(workspace, 'src', 'delete.txt'), 'delete', 'utf-8');
  runGit(workspace, ['add', '.gitignore', 'src/edit.txt', 'src/delete.txt']);
  runGit(workspace, ['commit', '-m', 'initial']);
}

function captureTurn(store: WorkspaceTimelineStore, workspace: string, sessionId = 'sess-git') {
  const handle = store.beginTurn({
    context: { scope: 'session', namespace: sessionId },
    turnId: `turn-${sessionId}`,
    workspaceDir: workspace,
  });
  assert.ok(handle);
  return handle;
}

function testGitObservedCoversTrackedDeleteAndUntrackedButNotIgnored(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'repo');
    initCommittedRepo(workspace);
    const headBefore = runGit(workspace, ['rev-parse', 'HEAD']);
    const branchBefore = runGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const stashBefore = runGit(workspace, ['stash', 'list']);
    const store = createStore(root);
    const handle = captureTurn(store, workspace);

    fs.writeFileSync(path.join(workspace, 'src', 'edit.txt'), 'changed', 'utf-8');
    fs.rmSync(path.join(workspace, 'src', 'delete.txt'));
    fs.writeFileSync(path.join(workspace, 'src', 'new.txt'), 'new', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'ignored.txt'), 'ignored', 'utf-8');
    fs.mkdirSync(path.join(workspace, 'ignored-dir'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'ignored-dir', 'nested.txt'), 'ignored', 'utf-8');

    const prepared = store.prepareTurnDelta(handle);
    store.markCommitted(prepared.delta.id);

    assert.equal(prepared.delta.trustLevel, 'git_observed');
    assert.deepEqual(prepared.delta.changedFiles, ['src/delete.txt', 'src/edit.txt', 'src/new.txt']);
    assert.deepEqual(prepared.delta.entries.map((entry) => entry.operation).sort(), ['add', 'delete', 'modify']);
    assert.match(prepared.delta.captureWarnings.join('\n'), /Ignored files/);
    assert.equal(runGit(workspace, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(runGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']), branchBefore);
    assert.equal(runGit(workspace, ['diff', '--cached', '--name-only']), '');
    assert.equal(runGit(workspace, ['stash', 'list']), stashBefore);
    assert.equal(tryRunGit(workspace, ['show-ref']).includes('refs/dpagent/'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testUnbornGitRepoFallsBackWithoutCommitOrRefs(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'repo');
    fs.mkdirSync(workspace, { recursive: true });
    runGit(workspace, ['init']);
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'base', 'utf-8');
    const store = createStore(root);
    const handle = captureTurn(store, workspace, 'sess-unborn');
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'next', 'utf-8');
    const prepared = store.prepareTurnDelta(handle);

    assert.equal(prepared.resultRevision.repoKind, 'git_unborn');
    assert.equal(prepared.delta.trustLevel, 'observed_partial');
    assert.throws(() => runGit(workspace, ['rev-parse', '--verify', 'HEAD']));
    assert.equal(tryRunGit(workspace, ['show-ref']).includes('refs/dpagent/'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testAdvisoryCaptureSkipsExcludedRuntimeRoots(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'file.txt'), 'base', 'utf-8');
    const store = createStore(root, 'advisory');
    const handle = captureTurn(store, workspace, 'sess-advisory');

    fs.writeFileSync(path.join(workspace, 'src', 'file.txt'), 'next', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'node_modules', 'pkg', 'index.js'), 'ignored', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'logs', 'run.log'), 'ignored', 'utf-8');

    const prepared = store.prepareTurnDelta(handle);
    assert.equal(prepared.delta.trustLevel, 'observed_partial');
    assert.deepEqual(prepared.delta.changedFiles, ['src/file.txt']);
    assert.match(prepared.delta.captureWarnings.join('\n'), /advisory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testDefaultDisabledReturnsNoHandle(): void {
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
    const handle = store.beginTurn({
      context: { scope: 'session', namespace: 'sess-disabled' },
      turnId: 'turn-disabled',
      workspaceDir: workspace,
    });
    assert.equal(handle, null);
    assert.equal(store.listSessionTimeline('sess-disabled').deltas.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(): void {
  testGitObservedCoversTrackedDeleteAndUntrackedButNotIgnored();
  testUnbornGitRepoFallsBackWithoutCommitOrRefs();
  testAdvisoryCaptureSkipsExcludedRuntimeRoots();
  testDefaultDisabledReturnsNoHandle();
  console.log('workspace-timeline git tests passed');
}

run();
