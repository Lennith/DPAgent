import * as assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import { MessageItem } from '../../src/web/client/components/chat/MessageItem.js';
import type { Message } from '../../src/web/client/hooks/useAgent.js';

function renderAssistantMarkdown(content: string): string {
  const message: Message = {
    id: 'msg-1',
    role: 'assistant',
    content,
    timestamp: Date.now(),
  };
  return renderToStaticMarkup(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(MessageItem, {
        message,
      })
    )
  );
}

function testGfmTableAndCodeRendering(): void {
  const content = [
    '# Title',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '> quoted text',
    '',
    '[docs](https://example.com)',
  ].join('\n');

  const html = renderAssistantMarkdown(content);
  assert.match(html, /md-table/);
  assert.match(html, /md-code-block/);
  assert.match(html, /md-quote/);
  assert.match(html, /target="_blank"/);
}

function testInlineCodeRendering(): void {
  const html = renderAssistantMarkdown('Use `npm run build` to compile.');
  assert.match(html, /md-inline-code/);
}

function runAll(): void {
  testGfmTableAndCodeRendering();
  testInlineCodeRendering();
  console.log('markdown-rendering tests passed');
}

runAll();
