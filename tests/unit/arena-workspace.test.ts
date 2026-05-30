import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ArenaStore,
  ArenaWorkspaceService,
  applyArenaWorkspaceDiff,
  diffArenaWorkspaces,
  forkArenaBranchSession,
  hashArenaWorkspace,
} from '../../src/arena/index.js';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import type { ContextRef } from '../../src/types.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-arena-workspace-'));
}

function seedRun(runtimeDir: string, mode: 'answer' | 'implementation' = 'implementation') {
  const store = new ArenaStore(path.join(runtimeDir, 'arena'));
  const run = store.createDraft({
    sourceSessionId: 'sess-source',
    sourceSessionName: 'aaa',
    sourceEventCount: 1,
    mode,
    currentLlmSelection: {
      profileId: 'default',
      model: 'MiniMax-M2.5',
      reasoningPreset: 'off',
      updatedAt: '2026-05-29T00:00:00.000Z',
    },
    config: {
      contestants: [
        {
          id: 'c1',
          label: 'Contestant 1',
          agentName: 'Agent One',
          llmSelection: {
            profileId: 'default',
            model: 'MiniMax-M2.5',
            reasoningPreset: 'off',
            updatedAt: '2026-05-29T00:00:00.000Z',
          },
        },
      ],
      judge: {
        llmSelection: {
          profileId: 'default',
          model: 'MiniMax-M2.5',
          reasoningPreset: 'off',
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      },
    },
  });
  return { store, run, branch: run.branches[0]! };
}

function seedSourceContext(manager: ContextManager, source: ContextRef, workspaceDir: string): void {
  const turn = manager.beginTurn(source, 'hello', workspaceDir);
  manager.commitTurn(turn.turnId, {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
    finalOutputText: 'hi',
    finishReason: 'completed',
  });
  manager.updateNamespaceMeta(source, { name: 'aaa', workspaceDir });
  manager.materializeToolResultArtifact(source, {
    toolCallId: 'tool-a',
    toolName: 'shell',
    content: 'x'.repeat(5000),
    thresholdChars: 100,
  });
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function testAnswerArenaDoesNotCreateWorkspace(): void {
  const root = tempRoot();
  try {
    const { run, branch } = seedRun(root, 'answer');
    const service = new ArenaWorkspaceService({ sourceWorkspaceDir: path.join(root, 'missing') });
    const result = service.prepareBranchWorkspace(run, branch);
    assert.deepEqual(result, { workspaceDir: '', strategy: 'answer_only', dirtyCopied: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testNoGitWorkspaceCopiesDirtySource(): void {
  const root = tempRoot();
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'base', 'utf-8');
    fs.writeFileSync(path.join(source, 'dirty.txt'), 'dirty', 'utf-8');
    fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(source, 'node_modules', 'skip.txt'), 'skip', 'utf-8');
    fs.mkdirSync(path.join(source, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(source, 'logs', 'skip.log'), 'skip', 'utf-8');
    const { run, branch } = seedRun(root);
    const service = new ArenaWorkspaceService({ sourceWorkspaceDir: source });
    const result = service.prepareBranchWorkspace(run, branch);

    assert.equal(result.strategy, 'directory_copy');
    assert.equal(result.dirtyCopied, true);
    assert.match(result.workspaceDir, /[\\/]\.dpagent-arena[\\/]/);
    assert.equal(fs.readFileSync(path.join(result.workspaceDir, 'dirty.txt'), 'utf-8'), 'dirty');
    assert.equal(fs.existsSync(path.join(result.workspaceDir, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(result.workspaceDir, 'logs')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testGitWorkspaceUsesArenaNamingAndCopiesDirtyChanges(): void {
  const root = tempRoot();
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source, { recursive: true });
    runGit(source, ['init']);
    runGit(source, ['config', 'user.email', 'test@example.com']);
    runGit(source, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'base', 'utf-8');
    fs.writeFileSync(path.join(source, 'deleted.txt'), 'delete me', 'utf-8');
    runGit(source, ['add', 'tracked.txt']);
    runGit(source, ['add', 'deleted.txt']);
    runGit(source, ['commit', '-m', 'initial']);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'modified', 'utf-8');
    fs.rmSync(path.join(source, 'deleted.txt'));
    fs.writeFileSync(path.join(source, 'dirty.txt'), 'dirty', 'utf-8');
    const { run, branch } = seedRun(root);
    const service = new ArenaWorkspaceService({ sourceWorkspaceDir: source });
    const result = service.prepareBranchWorkspace(run, branch);

    assert.equal(result.strategy, 'git_worktree');
    assert.equal(result.dirtyCopied, true);
    assert.match(result.workspaceDir, /[\\/]\.dpagent-arena[\\/]aaa-arena-/);
    assert.equal(fs.readFileSync(path.join(result.workspaceDir, 'tracked.txt'), 'utf-8'), 'modified');
    assert.equal(fs.existsSync(path.join(result.workspaceDir, 'deleted.txt')), false);
    assert.equal(fs.readFileSync(path.join(result.workspaceDir, 'dirty.txt'), 'utf-8'), 'dirty');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testImplementationWorkspaceRejectsMissingSourceWorkspace(): void {
  const root = tempRoot();
  try {
    const { run, branch } = seedRun(root);
    const service = new ArenaWorkspaceService({});
    assert.throws(
      () => service.prepareBranchWorkspace(run, branch),
      /source workspace is required/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testArenaBranchSessionForkCopiesContextAndWritesBranchMeta(): void {
  const root = tempRoot();
  try {
    const manager = new ContextManager(new ContextEventStore(path.join(root, 'contexts')));
    const source: ContextRef = { scope: 'session', namespace: 'sess-source' };
    seedSourceContext(manager, source, path.join(root, 'source'));
    const { run, branch } = seedRun(root);

    const meta = forkArenaBranchSession({
      host: manager,
      run,
      branch,
      targetNamespace: 'sess-branch',
      workspaceDir: path.join(root, 'branch-workspace'),
    });

    assert.equal(meta.namespace, 'sess-branch');
    assert.equal(meta.workspaceDir, path.join(root, 'branch-workspace'));
    assert.equal(meta.llmSelection?.model, 'MiniMax-M2.5');
    assert.deepEqual(meta.arenaBranch, {
      arenaId: run.id,
      branchId: branch.id,
      sourceSessionId: run.sourceSessionId,
    });
    const messages = manager.getConversationMessages({ scope: 'session', namespace: 'sess-branch' });
    assert.deepEqual(messages.map((message) => message.content), ['hello', 'hi']);
    const childPath = manager.getEventStore().getNamespacePath({ scope: 'session', namespace: 'sess-branch' });
    assert.equal(fs.existsSync(path.join(childPath, 'tool-results')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testWorkspaceProposalDiffAndApplyRejectsStaleSource(): void {
  const root = tempRoot();
  try {
    const source = path.join(root, 'source');
    const branch = path.join(root, 'branch');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(branch, { recursive: true });
    fs.writeFileSync(path.join(source, 'same.txt'), 'same', 'utf-8');
    fs.writeFileSync(path.join(source, 'edit.txt'), 'before', 'utf-8');
    fs.writeFileSync(path.join(source, 'delete.txt'), 'remove', 'utf-8');
    fs.writeFileSync(path.join(branch, 'same.txt'), 'same', 'utf-8');
    fs.writeFileSync(path.join(branch, 'edit.txt'), 'after', 'utf-8');
    fs.writeFileSync(path.join(branch, 'add.txt'), 'new', 'utf-8');

    const diff = diffArenaWorkspaces(source, branch);
    assert.deepEqual(diff.changedFiles, ['add.txt', 'delete.txt', 'edit.txt']);
    assert.equal(diff.sourceHash, hashArenaWorkspace(source));
    fs.writeFileSync(path.join(source, 'stale.txt'), 'changed after proposal', 'utf-8');
    assert.throws(
      () => applyArenaWorkspaceDiff({
        sourceDir: source,
        branchDir: branch,
        expectedSourceHash: diff.sourceHash,
        expectedBranchHash: diff.branchHash,
        changedFiles: diff.changedFiles,
      }),
      /changed since proposal/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testWorkspaceProposalDiffAndApplyCopiesWinnerFiles(): void {
  const root = tempRoot();
  try {
    const source = path.join(root, 'source');
    const branch = path.join(root, 'branch');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(branch, { recursive: true });
    fs.writeFileSync(path.join(source, 'edit.txt'), 'before', 'utf-8');
    fs.writeFileSync(path.join(source, 'delete.txt'), 'remove', 'utf-8');
    fs.writeFileSync(path.join(branch, 'edit.txt'), 'after', 'utf-8');
    fs.mkdirSync(path.join(branch, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(branch, 'nested', 'add.txt'), 'new', 'utf-8');

    const diff = diffArenaWorkspaces(source, branch);
    const result = applyArenaWorkspaceDiff({
      sourceDir: source,
      branchDir: branch,
      expectedSourceHash: diff.sourceHash,
      expectedBranchHash: diff.branchHash,
      changedFiles: diff.changedFiles,
    });

    assert.deepEqual(result.changedFiles, ['delete.txt', 'edit.txt', 'nested/add.txt']);
    assert.equal(fs.readFileSync(path.join(source, 'edit.txt'), 'utf-8'), 'after');
    assert.equal(fs.existsSync(path.join(source, 'delete.txt')), false);
    assert.equal(fs.readFileSync(path.join(source, 'nested', 'add.txt'), 'utf-8'), 'new');
    assert.equal(result.sourceHashAfter, hashArenaWorkspace(source));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testWorkspaceApplyRejectsStaleBranch(): void {
  const root = tempRoot();
  try {
    const source = path.join(root, 'source');
    const branch = path.join(root, 'branch');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(branch, { recursive: true });
    fs.writeFileSync(path.join(source, 'edit.txt'), 'before', 'utf-8');
    fs.writeFileSync(path.join(branch, 'edit.txt'), 'after', 'utf-8');
    const diff = diffArenaWorkspaces(source, branch);
    fs.writeFileSync(path.join(branch, 'late.txt'), 'changed after proposal', 'utf-8');
    assert.throws(
      () => applyArenaWorkspaceDiff({
        sourceDir: source,
        branchDir: branch,
        expectedSourceHash: diff.sourceHash,
        expectedBranchHash: diff.branchHash,
        changedFiles: diff.changedFiles,
      }),
      /branch workspace changed since proposal/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testWorkspaceApplyRejectsSourceSymlinkPath(): void {
  const root = tempRoot();
  try {
    const source = path.join(root, 'source');
    const branch = path.join(root, 'branch');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(branch, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'edit.txt'), 'outside', 'utf-8');
    try {
      fs.symlinkSync(outside, path.join(source, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }
    fs.mkdirSync(path.join(branch, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(branch, 'nested', 'edit.txt'), 'after', 'utf-8');
    const diff = diffArenaWorkspaces(source, branch);
    assert.throws(
      () => applyArenaWorkspaceDiff({
        sourceDir: source,
        branchDir: branch,
        expectedSourceHash: diff.sourceHash,
        expectedBranchHash: diff.branchHash,
        changedFiles: diff.changedFiles,
      }),
      /refuses source symlink path/i
    );
    assert.equal(fs.readFileSync(path.join(outside, 'edit.txt'), 'utf-8'), 'outside');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(): void {
  testAnswerArenaDoesNotCreateWorkspace();
  testNoGitWorkspaceCopiesDirtySource();
  testGitWorkspaceUsesArenaNamingAndCopiesDirtyChanges();
  testImplementationWorkspaceRejectsMissingSourceWorkspace();
  testArenaBranchSessionForkCopiesContextAndWritesBranchMeta();
  testWorkspaceProposalDiffAndApplyRejectsStaleSource();
  testWorkspaceProposalDiffAndApplyCopiesWinnerFiles();
  testWorkspaceApplyRejectsStaleBranch();
  testWorkspaceApplyRejectsSourceSymlinkPath();
  console.log('arena-workspace tests passed');
}

run();
