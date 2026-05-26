import * as assert from 'node:assert/strict';
import { hasFileLikeDragData } from '../../src/web/client/components/chat/composer-drop-detection.js';

function createTransfer(input: {
  fileCount?: number;
  types?: string[];
  data?: Record<string, string>;
}): Pick<DataTransfer, 'files' | 'types' | 'getData'> {
  const fileCount = input.fileCount ?? 0;
  const types = input.types ?? [];
  const data = input.data ?? {};
  return {
    files: { length: fileCount } as FileList,
    types: types as unknown as DataTransfer['types'],
    getData: (format: string) => data[format] ?? '',
  };
}

function testDetectsNativeFiles(): void {
  const transfer = createTransfer({ fileCount: 1 });
  assert.equal(hasFileLikeDragData(transfer), true);
}

function testDetectsUriListType(): void {
  const transfer = createTransfer({ types: ['text/uri-list'] });
  assert.equal(hasFileLikeDragData(transfer), true);
}

function testPlainTextTypeAloneDoesNotCountAsFileDrop(): void {
  const transfer = createTransfer({ types: ['text/plain'], data: { 'text/plain': 'just normal text' } });
  assert.equal(hasFileLikeDragData(transfer), false);
}

function testDetectsUriListContent(): void {
  const transfer = createTransfer({
    data: { 'text/uri-list': 'file:///C:/demo.txt' },
  });
  assert.equal(hasFileLikeDragData(transfer), true);
}

function testDetectsPlainTextPathContent(): void {
  const transfer = createTransfer({
    data: { 'text/plain': 'C:\\demo\\notes.md' },
  });
  assert.equal(hasFileLikeDragData(transfer), true);
}

function testRejectsPlainTextNonPathContent(): void {
  const transfer = createTransfer({
    data: { 'text/plain': 'hello world' },
  });
  assert.equal(hasFileLikeDragData(transfer), false);
}

function testRejectsUnsupportedDropData(): void {
  const transfer = createTransfer({ types: ['text/html'], data: { 'text/plain': '' } });
  assert.equal(hasFileLikeDragData(transfer), false);
}

function runAll(): void {
  testDetectsNativeFiles();
  testDetectsUriListType();
  testPlainTextTypeAloneDoesNotCountAsFileDrop();
  testDetectsUriListContent();
  testDetectsPlainTextPathContent();
  testRejectsPlainTextNonPathContent();
  testRejectsUnsupportedDropData();
  console.log('chat-input-drop-detection tests passed');
}

runAll();
