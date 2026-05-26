import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveDroppedSessionFile,
  sanitizeDroppedFileName,
} from '../../src/web/server/session-dropped-file-store.js';

function testSanitizeDroppedFilenameRejectsEmptyNames(): void {
  assert.equal(sanitizeDroppedFileName(''), null);
  assert.equal(sanitizeDroppedFileName('   '), null);
}

function testSanitizeDroppedFilenameDropsPathAndUnsafeChars(): void {
  assert.equal(sanitizeDroppedFileName('C:\\Users\\pc\\secret<demo>.txt'), 'secret_demo_.txt');
  assert.equal(sanitizeDroppedFileName('../nested/report?.md'), 'report_.md');
}

function testSaveDroppedSessionFileWritesInsideRuntimeDroppedFiles(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-dropped-file-'));
  const runtimeDataDir = path.join(tempDir, 'runtime');
  const result = saveDroppedSessionFile({
    runtimeDataDir,
    sessionId: 'sess-1',
    filename: '../report?.md',
    body: Buffer.from('hello dropped file', 'utf-8'),
    uploadId: 'upload-1',
  });

  assert.equal(result.filename, 'report_.md');
  assert.equal(result.size, Buffer.byteLength('hello dropped file'));
  assert.equal(result.path, path.join(runtimeDataDir, 'dropped-files', 'sess-1', 'upload-1', 'report_.md'));
  assert.equal(fs.readFileSync(result.path, 'utf-8'), 'hello dropped file');
}

function testSaveDroppedSessionFileRejectsInvalidInput(): void {
  assert.throws(
    () => saveDroppedSessionFile({
      runtimeDataDir: '',
      sessionId: 'sess-1',
      filename: 'file.txt',
      body: Buffer.from('x'),
    }),
    /runtimeDataDir/
  );
  assert.throws(
    () => saveDroppedSessionFile({
      runtimeDataDir: path.join(os.tmpdir(), 'runtime'),
      sessionId: 'sess-1',
      filename: '',
      body: Buffer.from('x'),
    }),
    /filename/
  );
}

function runAll(): void {
  testSanitizeDroppedFilenameRejectsEmptyNames();
  testSanitizeDroppedFilenameDropsPathAndUnsafeChars();
  testSaveDroppedSessionFileWritesInsideRuntimeDroppedFiles();
  testSaveDroppedSessionFileRejectsInvalidInput();
  console.log('web-dropped-file-upload-route tests passed');
}

runAll();
