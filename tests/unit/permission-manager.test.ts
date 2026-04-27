import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PermissionManager, createPermissionManager } from '../../src/tools/PermissionManager.js';
import { ReadFileTool, WriteFileTool } from '../../src/tools/FileTools.js';

function createTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `permission-manager-${prefix}-`));
}

function cleanupWorkspace(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function testWorkspaceAndAdditionalWritableAccess(): void {
  const workspaceDir = createTempWorkspace('base');
  try {
    const extraDir = path.join(workspaceDir, 'extra');
    fs.mkdirSync(extraDir, { recursive: true });
    const manager = createPermissionManager({
      workspaceDir,
      additionalWritableDirs: [extraDir],
    });

    const workspaceFile = path.join(workspaceDir, 'notes', 'log.txt');
    assert.equal(manager.isReadable(workspaceFile), true);
    assert.equal(manager.isWritable(workspaceFile), true);

    const extraFile = path.join(extraDir, 'cache.json');
    assert.equal(manager.isReadable(extraFile), true);
    assert.equal(manager.isWritable(extraFile), true);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

function testOutsidePathIsDenied(): void {
  const workspaceDir = createTempWorkspace('outside');
  try {
    const manager = new PermissionManager({
      workspaceDir,
      additionalWritableDirs: [],
    });
    const outsideFile = path.resolve(workspaceDir, '..', 'not-allowed.txt');
    const readResult = manager.checkPermission(outsideFile, 'read');
    const writeResult = manager.checkPermission(outsideFile, 'write');

    assert.equal(readResult.allowed, false);
    assert.match(String(readResult.reason ?? ''), /outside readable directories/);
    assert.equal(writeResult.allowed, false);
    assert.match(String(writeResult.reason ?? ''), /outside writable directories/);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

function testAddReadableAndRemoveWritable(): void {
  const workspaceDir = createTempWorkspace('readable');
  const externalReadableDir = createTempWorkspace('external-readable');
  const externalWritableDir = createTempWorkspace('external-writable');
  try {
    const manager = new PermissionManager({
      workspaceDir,
      additionalWritableDirs: [],
    });
    const readOnlyDir = externalReadableDir;
    const readOnlyFile = path.join(readOnlyDir, 'data.txt');

    assert.equal(manager.isReadable(readOnlyFile), false);
    assert.equal(manager.isWritable(readOnlyFile), false);

    manager.addReadableDir(readOnlyDir);
    assert.equal(manager.isReadable(readOnlyFile), true);
    assert.equal(manager.isWritable(readOnlyFile), false);

    const writableDir = externalWritableDir;
    const writableFile = path.join(writableDir, 'write.txt');

    manager.addWritableDir(writableDir);
    assert.equal(manager.isWritable(writableFile), true);
    assert.equal(manager.isReadable(writableFile), true);

    manager.removeWritableDir(writableDir);
    assert.equal(manager.isWritable(writableFile), false);
    assert.equal(manager.isReadable(writableFile), true);
  } finally {
    cleanupWorkspace(workspaceDir);
    cleanupWorkspace(externalReadableDir);
    cleanupWorkspace(externalWritableDir);
  }
}

function testPermissionCheckerAndDirectorySnapshots(): void {
  const workspaceDir = createTempWorkspace('checker');
  try {
    const manager = createPermissionManager({
      workspaceDir,
      additionalWritableDirs: [],
    });
    const checker = manager.createPermissionChecker();
    const filePath = path.join(workspaceDir, 'ok.txt');
    const outsideFilePath = path.resolve(workspaceDir, '..', 'outside.txt');

    assert.equal(checker(filePath, 'read').allowed, true);
    assert.equal(checker(filePath, 'write').allowed, true);
    assert.equal(checker(outsideFilePath, 'read').allowed, false);
    assert.equal(manager.getWorkspaceDir(), path.resolve(workspaceDir));
    assert.equal(manager.getWritableDirs().includes(path.resolve(workspaceDir)), true);
    assert.equal(manager.getReadableDirs().includes(path.resolve(workspaceDir)), true);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

function testSymlinkEscapeIsDeniedWhenSupported(): void {
  const workspaceDir = createTempWorkspace('symlink-workspace');
  const outsideDir = createTempWorkspace('symlink-outside');
  try {
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret', 'utf-8');
    const linkPath = path.join(workspaceDir, 'linked-secret.txt');
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch {
      return;
    }

    const manager = createPermissionManager({
      workspaceDir,
      additionalWritableDirs: [],
    });
    assert.equal(manager.checkPermission(linkPath, 'read').allowed, false);
  } finally {
    cleanupWorkspace(workspaceDir);
    cleanupWorkspace(outsideDir);
  }
}

async function testReadFileExemptDirDoesNotFollowSymlinkEscape(): Promise<void> {
  const workspaceDir = createTempWorkspace('readfile-exempt');
  const outsideDir = createTempWorkspace('readfile-exempt-outside');
  try {
    const skillsDir = path.join(workspaceDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret', 'utf-8');
    const linkPath = path.join(skillsDir, 'linked-secret.txt');
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch {
      return;
    }

    const manager = createPermissionManager({
      workspaceDir,
      additionalWritableDirs: [],
    });
    const readFile = new ReadFileTool({
      workspaceDir,
      exemptDirs: [skillsDir],
      checkPermission: manager.createPermissionChecker(),
    });
    const result = await readFile.execute({ path: linkPath });
    assert.equal(result.success, false);
  } finally {
    cleanupWorkspace(workspaceDir);
    cleanupWorkspace(outsideDir);
  }
}

async function testWriteFileDeniedThroughSymlinkAncestorWithMissingChild(): Promise<void> {
  const workspaceDir = createTempWorkspace('write-symlink-workspace');
  const outsideDir = createTempWorkspace('write-symlink-outside');
  try {
    const linkPath = path.join(workspaceDir, 'outside-link');
    try {
      fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const manager = createPermissionManager({
      workspaceDir,
      additionalWritableDirs: [],
    });
    const escapedTarget = path.join(linkPath, 'missing-child', 'secret.txt');
    assert.equal(manager.checkPermission(escapedTarget, 'write').allowed, false);

    const writeFile = new WriteFileTool({
      workspaceDir,
      checkPermission: manager.createPermissionChecker(),
    });
    const result = await writeFile.execute({
      path: escapedTarget,
      content: 'secret',
    });
    assert.equal(result.success, false);
    assert.equal(fs.existsSync(path.join(outsideDir, 'missing-child', 'secret.txt')), false);
  } finally {
    cleanupWorkspace(workspaceDir);
    cleanupWorkspace(outsideDir);
  }
}

async function testWriteFileDeniedThroughDanglingSymlink(): Promise<void> {
  const workspaceDir = createTempWorkspace('write-dangling-symlink-workspace');
  const outsideDir = createTempWorkspace('write-dangling-symlink-outside');
  try {
    const outsideFile = path.join(outsideDir, 'created-through-link.txt');
    const linkPath = path.join(workspaceDir, 'dangling-link.txt');
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch {
      return;
    }

    const manager = createPermissionManager({
      workspaceDir,
      additionalWritableDirs: [],
    });
    assert.equal(manager.checkPermission(linkPath, 'write').allowed, false);

    const writeFile = new WriteFileTool({
      workspaceDir,
      checkPermission: manager.createPermissionChecker(),
    });
    const result = await writeFile.execute({
      path: linkPath,
      content: 'secret',
    });
    assert.equal(result.success, false);
    assert.equal(fs.existsSync(outsideFile), false);
  } finally {
    cleanupWorkspace(workspaceDir);
    cleanupWorkspace(outsideDir);
  }
}

async function runAll(): Promise<void> {
  testWorkspaceAndAdditionalWritableAccess();
  testOutsidePathIsDenied();
  testAddReadableAndRemoveWritable();
  testPermissionCheckerAndDirectorySnapshots();
  testSymlinkEscapeIsDeniedWhenSupported();
  await testReadFileExemptDirDoesNotFollowSymlinkEscape();
  await testWriteFileDeniedThroughSymlinkAncestorWithMissingChild();
  await testWriteFileDeniedThroughDanglingSymlink();
  console.log('permission-manager tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
