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
  assert.equal(result.text, '`C:\\temp\\report.md`');
}

function testFallbackToFilenameWithUnresolvedTag(): void {
  const result = buildDroppedPathInsertion({
    uriList: '',
    filePath: '',
    fileName: 'notes.txt',
    isWindows: true,
  });
  assert.equal(result.source, 'filename');
  assert.equal(result.resolved, false);
  assert.equal(result.text, '`notes.txt` [unresolved_path]');
}

function testSingleFileModeUsesFirstUriOnly(): void {
  const uriList = ['file:///C:/first.txt', 'file:///C:/second.txt'].join('\n');
  const first = extractFirstFileUri(uriList);
  assert.equal(first, 'file:///C:/first.txt');

  const result = buildDroppedPathInsertion({
    uriList,
    filePath: '',
    fileName: 'second.txt',
    isWindows: true,
  });
  assert.equal(result.source, 'uri');
  assert.equal(result.text, '`C:\\first.txt`');
}

function runAll(): void {
  testNormalizeWindowsFileUri();
  testUseFilePathWhenUriMissing();
  testFallbackToFilenameWithUnresolvedTag();
  testSingleFileModeUsesFirstUriOnly();
  console.log('chat-input-drag-path-utils tests passed');
}

runAll();
