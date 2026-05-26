import * as assert from 'node:assert/strict';
import {
  composePromptWithFileReferences,
  mergeFileReferences,
} from '../../src/web/client/components/chat/fileReferencePrompt.js';

function testMergeFileReferencesDedupesWindowsPathsCaseInsensitive(): void {
  const merged = mergeFileReferences(
    ['C:\\Work\\docs\\a.md'],
    ['c:\\work\\docs\\a.md', 'C:\\Work\\docs\\b.md']
  );
  assert.deepEqual(merged, ['C:\\Work\\docs\\a.md', 'C:\\Work\\docs\\b.md']);
}

function testMergeFileReferencesKeepsRecentWithinLimit(): void {
  const merged = mergeFileReferences(['a', 'b', 'c'], ['d', 'e'], 4);
  assert.deepEqual(merged, ['b', 'c', 'd', 'e']);
}

function testComposePromptWithFileReferencesWithUserText(): void {
  const prompt = composePromptWithFileReferences('请总结这些文件', [
    'D:\\repo\\README.md',
    'D:\\repo\\src\\index.ts',
  ]);
  assert.equal(
    prompt,
    '<refs_file_for_this_turn>\n  <file path="D:\\repo\\README.md" />\n  <file path="D:\\repo\\src\\index.ts" />\n</refs_file_for_this_turn>\n\n请总结这些文件'
  );
}

function testComposePromptWithFileReferencesWithoutUserText(): void {
  const prompt = composePromptWithFileReferences('   ', ['D:\\repo\\README.md']);
  assert.equal(prompt, '<refs_file_for_this_turn>\n  <file path="D:\\repo\\README.md" />\n</refs_file_for_this_turn>');
}

function testComposePromptWithFileReferencesEscapesXml(): void {
  const prompt = composePromptWithFileReferences('read', ['D:\\repo\\"quoted"&<tag>.md']);
  assert.equal(
    prompt,
    '<refs_file_for_this_turn>\n  <file path="D:\\repo\\&quot;quoted&quot;&amp;&lt;tag&gt;.md" />\n</refs_file_for_this_turn>\n\nread'
  );
}

function runAll(): void {
  testMergeFileReferencesDedupesWindowsPathsCaseInsensitive();
  testMergeFileReferencesKeepsRecentWithinLimit();
  testComposePromptWithFileReferencesWithUserText();
  testComposePromptWithFileReferencesWithoutUserText();
  testComposePromptWithFileReferencesEscapesXml();
  console.log('chat-file-reference-prompt tests passed');
}

runAll();
