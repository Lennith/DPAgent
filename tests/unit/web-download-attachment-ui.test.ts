import * as assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatContainer } from '../../src/web/client/components/chat/ChatContainer.js';
import { MessageItem } from '../../src/web/client/components/chat/MessageItem.js';
import { DEFAULT_CHAT_DISPLAY_FILTERS } from '../../src/web/client/components/chat/chat-display-filters.js';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../src/web/client/i18n/index.js';
import { collectDownloadAttachments } from '../../src/web/client/components/chat/downloadAttachment.js';
import type { Message, ToolResult } from '../../src/web/client/chat-types.js';

class MemoryStorageStub {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorageStub(),
  configurable: true,
});

Object.defineProperty(globalThis, 'sessionStorage', {
  value: new MemoryStorageStub(),
  configurable: true,
});

function createDownloadToolResult(
  filename: string,
  overrides: Partial<{ href: string; displayPath: string; size: number }> = {}
): ToolResult {
  const displayPath = overrides.displayPath ?? `D:\\test\\${filename}`;
  return {
    name: 'send_file_to_user',
    result: {
      success: true,
      content: JSON.stringify({
        success: true,
        href: overrides.href ?? `http://localhost:53721/download/abc/${filename}`,
        displayPath,
        filename,
        size: overrides.size ?? 2048,
        expiresAt: '2026-05-08T00:00:00.000Z',
      }),
    },
  };
}

function renderWithProviders(element: React.ReactElement): string {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ThemeProvider, null, element)
    )
  );
}

function renderMessage(message: Message, displayFilters = DEFAULT_CHAT_DISPLAY_FILTERS): string {
  return renderWithProviders(React.createElement(MessageItem, { message, displayFilters }));
}

function createAssistantMessage(toolResults: ToolResult[]): Message {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'The file is ready.',
    timestamp: Date.parse('2026-05-07T00:00:00.000Z'),
    toolResults,
  };
}

function testCollectsDownloadAttachment(): void {
  const attachments = collectDownloadAttachments([
    {
      name: 'send_file_to_user',
      result: {
        success: true,
        content: JSON.stringify({
          href: 'http://localhost:53721/download/id/file.md',
          displayPath: 'D:\\test\\file.md',
          filename: 'file.md',
        }),
      },
    },
  ]);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].href, 'http://localhost:53721/download/id/file.md');
  assert.equal(attachments[0].displayPath, 'D:\\test\\file.md');
}

function testMessageRendersDesignedDownloadLink(): void {
  const html = renderMessage(createAssistantMessage([createDownloadToolResult('report.md')]));
  assert.match(html, /data-download-attachments="true"/);
  assert.match(html, /data-download-attachment-link="true"/);
  assert.match(html, /href="http:\/\/localhost:53721\/download\/abc\/report\.md"/);
  assert.match(html, /D:\\test\\report\.md/);
  assert.match(html, /2\.0 KB/);
  assert.match(html, />Download</);
}

function testDownloadAttachmentsIgnoreToolResultFilter(): void {
  const html = renderMessage(
    createAssistantMessage([
      {
        name: 'shell_execute',
        result: {
          success: true,
          content: 'ordinary-tool-output',
        },
      },
      createDownloadToolResult('report.md'),
    ]),
    {
      showThinking: false,
      showToolCall: false,
      showToolResult: false,
    }
  );

  assert.match(html, /data-download-attachments="true"/);
  assert.match(html, /href="http:\/\/localhost:53721\/download\/abc\/report\.md"/);
  assert.doesNotMatch(html, /ordinary-tool-output/);
}

function testMultipleDownloadsRenderAsSingleList(): void {
  const html = renderMessage(
    createAssistantMessage([
      createDownloadToolResult('report.md'),
      createDownloadToolResult('summary.txt', {
        href: 'http://localhost:53721/download/def/summary.txt',
        displayPath: 'D:\\test\\summary.txt',
        size: 1024,
      }),
    ])
  );

  assert.equal((html.match(/data-download-attachments="true"/g) ?? []).length, 1);
  assert.equal((html.match(/data-download-attachment-link="true"/g) ?? []).length, 2);
  assert.match(html, /report\.md/);
  assert.match(html, /summary\.txt/);
}

function testFailedSendFileResultStillRendersAsToolResult(): void {
  const html = renderMessage(
    createAssistantMessage([
      {
        name: 'send_file_to_user',
        result: {
          success: false,
          content: '',
          error: 'file not found',
        },
      },
    ])
  );

  assert.doesNotMatch(html, /data-download-attachments="true"/);
  assert.match(html, /file not found/);
}

function testLiveSendFileToolResultIsNotRenderedMidTurn(): void {
  const html = renderWithProviders(
    React.createElement(ChatContainer, {
      messages: [],
      liveEvents: [
        {
          id: 'live-download-1',
          type: 'tool_result',
          name: 'send_file_to_user',
          result: createDownloadToolResult('live.md').result,
          timestamp: Date.parse('2026-05-07T00:00:00.000Z'),
        },
      ],
      pendingPlanInput: null,
      pendingPlanInputError: null,
      onSubmitPlanInput: () => undefined,
      input: '',
      setInput: () => undefined,
      onSend: () => false,
      isRunning: true,
      error: null,
    })
  );

  assert.doesNotMatch(html, /data-download-attachments="true"/);
  assert.doesNotMatch(html, /live\.md/);
  assert.doesNotMatch(html, /send_file_to_user/);
}

function runAll(): void {
  testCollectsDownloadAttachment();
  testMessageRendersDesignedDownloadLink();
  testDownloadAttachmentsIgnoreToolResultFilter();
  testMultipleDownloadsRenderAsSingleList();
  testFailedSendFileResultStillRendersAsToolResult();
  testLiveSendFileToolResultIsNotRenderedMidTurn();
  console.log('web-download-attachment-ui tests passed');
}

runAll();
