import * as assert from 'node:assert/strict';
import {
  buildCompressionChunks,
  collectCompressibleItems,
  type CompressibleTranscriptItem,
} from '../../src/runtime/compression-chunks.js';
import type { Message } from '../../src/types.js';

function makeMessage(role: Message['role'], content: string): Message {
  return { role, content } as Message;
}

function makeItem(index: number, chars: number): CompressibleTranscriptItem {
  return {
    messageIndex: index,
    role: 'user',
    charLength: chars,
    isToolBundle: false,
    isThinkingBlock: false,
    content: `message-${index}`,
    message: makeMessage('user', `message-${index}`),
  };
}

function testFirstContentMessageIsCompressible(): void {
  const messages = [
    makeMessage('user', 'first user message must be included'),
    makeMessage('assistant', 'assistant reply'),
  ];
  const items = collectCompressibleItems(messages);
  assert.equal(items[0]?.messageIndex, 0);
  assert.equal(items.length, 2);
}

function testSystemMessageOnlyIsSkipped(): void {
  const messages = [
    makeMessage('system', 'system prompt'),
    makeMessage('user', 'first content message'),
    makeMessage('assistant', 'assistant reply'),
  ];
  const items = collectCompressibleItems(messages);
  assert.deepEqual(
    items.map((item) => item.messageIndex),
    [1, 2]
  );
}

function testConfiguredChunkCharsControlsBoundaries(): void {
  const chunks = buildCompressionChunks({
    items: [makeItem(0, 100), makeItem(1, 100), makeItem(2, 100), makeItem(3, 100)],
    maxChunks: 3,
    maxChunkChars: 150,
  });
  assert.deepEqual(
    chunks.map((chunk) => chunk.items.map((item) => item.messageIndex)),
    [[0], [1], [2, 3]]
  );
}

testFirstContentMessageIsCompressible();
testSystemMessageOnlyIsSkipped();
testConfiguredChunkCharsControlsBoundaries();

console.log('compression-chunks test passed');
