import * as assert from 'node:assert/strict';
import {
  buildDroppedPathInsertion,
  extractFirstFileUri,
  normalizeFileUriToNativePath,
} from '../../src/web/client/components/chat/dragPathUtils.js';

function testNormalizeWindowsFileUri(): void {
  const result = normalizeFileUriToNativePath('file:///C:/Users/pc/Desktop/demo.txt', true);
  assert.equal(result, 'C:\\Users\\pc\\Desktop\\demo.txt');
}

function testUseFilePathWhenUriMissing(): void {
  const result = buildDroppedPathInsertion({
    uriList: '',
    filePath: 'C:\\temp\\report.md',
    fileName: 'report.md',
    isWindows: true,
  });
  assert.equal(result.source, 'file_path');
  assert.equal(result.resolved, true);
  assert.equal(result.text, '@file C:\\temp\\report.md');
  assert.deepEqual(result.references, ['C:\\temp\\report.md']);
}

function testFallbackToFilenameWhenPathUnresolved(): void {
  const result = buildDroppedPathInsertion({
    uriList: '',
    filePath: '',
    fileName: 'notes.txt',
    isWindows: true,
  });
  assert.equal(result.source, 'filename');
  assert.equal(result.resolved, false);
  assert.equal(result.text, '');
  assert.deepEqual(result.references, []);
}

function testExtractFirstFileUri(): void {
  const uriList = ['file:///C:/first.txt', 'file:///C:/second.txt'].join('\n');
  const first = extractFirstFileUri(uriList);
  assert.equal(first, 'file:///C:/first.txt');
}

function testMultipleUrisInsertMultipleReferences(): void {
  const uriList = ['file:///C:/first.txt', 'file:///C:/second.txt'].join('\n');
  const result = buildDroppedPathInsertion({
    uriList,
    isWindows: true,
  });
  assert.equal(result.source, 'uri');
  assert.equal(result.text, '@file C:\\first.txt\n@file C:\\second.txt');
  assert.deepEqual(result.references, ['C:\\first.txt', 'C:\\second.txt']);
}

function testPlainTextAbsolutePath(): void {
  const result = buildDroppedPathInsertion({
    plainText: 'C:\\Users\\pc\\Desktop\\demo.txt',
    isWindows: true,
  });
  assert.equal(result.source, 'plain_text');
  assert.equal(result.resolved, true);
  assert.equal(result.text, '@file C:\\Users\\pc\\Desktop\\demo.txt');
}

function testPlainTextFileUri(): void {
  const result = buildDroppedPathInsertion({
    plainText: 'file:///C:/Users/pc/Desktop/demo.txt',
    isWindows: true,
  });
  assert.equal(result.source, 'plain_text');
  assert.equal(result.resolved, true);
  assert.equal(result.text, '@file C:\\Users\\pc\\Desktop\\demo.txt');
}

function runAll(): void {
  testNormalizeWindowsFileUri();
  testUseFilePathWhenUriMissing();
  testFallbackToFilenameWhenPathUnresolved();
  testExtractFirstFileUri();
  testMultipleUrisInsertMultipleReferences();
  testPlainTextAbsolutePath();
  testPlainTextFileUri();
  console.log('chat-input-drag-path-utils tests passed');
}

runAll();
