import * as assert from 'node:assert/strict';
import type { SessionInfo } from '../../src/web/client/app-shell-types.js';
import {
  collectRecentWorkspaceDirsFromSessions,
  deriveWorkspaceDirFromFilePath,
  deriveWorkspaceDirFromRelativeFilePath,
  resolveWorkspaceDirFromPickerFiles,
} from '../../src/web/client/workspace-modal-utils.js';

function testCollectRecentWorkspaceDirsSortedDedupedLimited(): void {
  const sessions: SessionInfo[] = [
    { id: 's1', name: 'one', workspaceDir: 'D:\\ws\\alpha', updatedAt: '2026-05-01T09:00:00.000Z' },
    { id: 's2', name: 'two', workspaceDir: 'D:\\ws\\beta', updatedAt: '2026-05-01T10:00:00.000Z' },
    { id: 's3', name: 'three', workspaceDir: 'D:\\ws\\alpha', updatedAt: '2026-05-01T11:00:00.000Z' },
    { id: 's4', name: 'four', workspaceDir: 'D:\\ws\\gamma', updatedAt: '2026-05-01T12:00:00.000Z' },
    { id: 's5', name: 'five', workspaceDir: 'D:\\ws\\delta', updatedAt: '2026-05-01T13:00:00.000Z' },
  ];
  const recent = collectRecentWorkspaceDirsFromSessions(sessions, 3);
  assert.deepEqual(recent, ['D:\\ws\\delta', 'D:\\ws\\gamma', 'D:\\ws\\alpha']);
}

function testCollectRecentWorkspaceDirsSkipsEmptyValues(): void {
  const sessions: SessionInfo[] = [
    { id: 's1', name: 'one', workspaceDir: '', updatedAt: '2026-05-01T09:00:00.000Z' },
    { id: 's2', name: 'two', updatedAt: '2026-05-01T10:00:00.000Z' },
    { id: 's3', name: 'three', workspaceDir: 'D:\\ws\\active', updatedAt: '2026-05-01T11:00:00.000Z' },
  ];
  const recent = collectRecentWorkspaceDirsFromSessions(sessions, 3);
  assert.deepEqual(recent, ['D:\\ws\\active']);
}

function testDeriveWorkspaceDirFromFilePath(): void {
  assert.equal(deriveWorkspaceDirFromFilePath('D:\\ws\\demo\\notes.md'), 'D:\\ws\\demo');
}

function testResolveWorkspaceDirFromPickerFiles(): void {
  const files = {
    0: {
      path: 'D:\\ws\\demo\\notes.md',
    } as unknown as File,
    length: 1,
  } as ArrayLike<File>;
  assert.equal(resolveWorkspaceDirFromPickerFiles(files), 'D:\\ws\\demo');
}

function testDeriveWorkspaceDirFromRelativeFilePath(): void {
  assert.equal(deriveWorkspaceDirFromRelativeFilePath('workspace-demo\\notes.md'), 'workspace-demo');
}

function testResolveWorkspaceDirFromPickerFilesWithRelativePathOnly(): void {
  const files = {
    0: {
      name: 'notes.md',
      webkitRelativePath: 'workspace-demo\\notes.md',
    } as unknown as File,
    length: 1,
  } as ArrayLike<File>;
  assert.equal(resolveWorkspaceDirFromPickerFiles(files), 'workspace-demo');
}

function testResolveWorkspaceDirFromPickerFilesWithDirectorySelectionRoot(): void {
  const files = {
    0: {
      path: 'D:\\ws\\demo\\nested\\notes.md',
      webkitRelativePath: 'nested\\notes.md',
    } as unknown as File,
    length: 1,
  } as ArrayLike<File>;
  assert.equal(resolveWorkspaceDirFromPickerFiles(files), 'D:\\ws\\demo');
}

function testResolveWorkspaceDirFromPickerFilesWithoutPath(): void {
  const files = {
    0: {
      name: 'notes.md',
    } as unknown as File,
    length: 1,
  } as ArrayLike<File>;
  assert.equal(resolveWorkspaceDirFromPickerFiles(files), null);
}

function runAll(): void {
  testCollectRecentWorkspaceDirsSortedDedupedLimited();
  testCollectRecentWorkspaceDirsSkipsEmptyValues();
  testDeriveWorkspaceDirFromFilePath();
  testDeriveWorkspaceDirFromRelativeFilePath();
  testResolveWorkspaceDirFromPickerFiles();
  testResolveWorkspaceDirFromPickerFilesWithRelativePathOnly();
  testResolveWorkspaceDirFromPickerFilesWithDirectorySelectionRoot();
  testResolveWorkspaceDirFromPickerFilesWithoutPath();
  console.log('workspace-modal-utils tests passed');
}

runAll();
