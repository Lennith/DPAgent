import * as assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  listLocalDirectory,
  normalizeLocalBrowserPath,
} from '../../src/web/server/local-file-browser.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-file-browser-'));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function testListLocalDirectorySortsDirectoriesFirst(): Promise<void> {
  await withTempDir(async (dir) => {
    await fs.promises.mkdir(path.join(dir, 'z-dir'));
    await fs.promises.writeFile(path.join(dir, 'a-file.txt'), 'hello');
    await fs.promises.mkdir(path.join(dir, 'a-dir'));

    const result = await listLocalDirectory(dir);

    assert.equal(result.path, normalizeLocalBrowserPath(dir));
    assert.deepEqual(
      result.entries.map((entry) => `${entry.type}:${entry.name}`),
      ['directory:a-dir', 'directory:z-dir', 'file:a-file.txt']
    );
    assert.equal(result.entries.find((entry) => entry.name === 'a-file.txt')?.size, 5);
  });
}

async function testListLocalDirectoryRejectsFiles(): Promise<void> {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'file.txt');
    await fs.promises.writeFile(filePath, 'content');
    await assert.rejects(() => listLocalDirectory(filePath), /not a directory/);
  });
}

async function testListLocalDirectoryRejectsMissingPath(): Promise<void> {
  await assert.rejects(() => listLocalDirectory(''), /path is required/);
}

async function runAll(): Promise<void> {
  await testListLocalDirectorySortsDirectoriesFirst();
  await testListLocalDirectoryRejectsFiles();
  await testListLocalDirectoryRejectsMissingPath();
  console.log('local-file-browser tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
