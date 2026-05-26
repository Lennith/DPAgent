import * as assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatContainer } from '../../src/web/client/components/chat/ChatContainer.js';
import { MessageItem } from '../../src/web/client/components/chat/MessageItem.js';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import {
  I18nProvider,
  LOCALE_STORAGE_KEY,
} from '../../src/web/client/i18n/index.js';
import { projectSessionMessages } from '../../src/web/client/chat-message-projection.js';
import type { InterruptedArtifactView } from '../../src/web/client/app-shell-types.js';
import { toInterruptedArtifactView } from '../../src/web/server/interrupted-artifact-view.js';
import type { InterruptedArtifact } from '../../src/types.js';

class MemoryStorageStub {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key) ?? null : null;
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

function createInterruptedArtifact(
  overrides: Partial<InterruptedArtifactView> = {}
): InterruptedArtifactView {
  return {
    artifactId: 'artifact-1',
    context: { scope: 'session', namespace: 'sess-1' },
    draftId: 'draft-1',
    turnId: 'turn-1',
    runId: 'run-1',
    runFamilyId: 'family-1',
    terminalCode: 'error',
    replayCutoffKind: 'checkpoint',
    lastSafeStep: 55,
    maxSteps: 100,
    errorSummary: 'read ECONNRESET',
    createdAt: '2026-04-26T10:00:00.000Z',
    updatedAt: '2026-04-26T10:01:00.000Z',
    previewMessages: [
      {
        role: 'assistant',
        content: 'I already updated the API route and verified the import.',
      },
      {
        role: 'tool',
        content: '{"success":true,"content":"Patched app_service.py"}',
        name: 'read_file',
      },
    ],
    sideEffectLedger: [],
    ...overrides,
  };
}

function renderChatContainer(
  interruptedArtifact: InterruptedArtifactView | null,
  overrides: Partial<React.ComponentProps<typeof ChatContainer>> = {}
): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(ChatContainer, {
          messages: [],
          liveEvents: [],
          pendingPlanInput: null,
          pendingPlanInputError: null,
          onSubmitPlanInput: () => undefined,
          input: '',
          setInput: () => undefined,
          onSend: () => undefined,
          onCancel: () => undefined,
          isRunning: false,
          canCancel: false,
          isInteractionLocked: false,
          error: null,
          interruptedArtifact,
          sessionId: 'sess-1',
          ...overrides,
        })
      )
    )
  );
}

function renderMessageItem(message: React.ComponentProps<typeof MessageItem>['message']): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(MessageItem, {
          message,
        })
      )
    )
  );
}

function testRuntimeRunErrorRendersAsTranscriptErrorCard(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderMessageItem({
    id: 'run-error-run-1',
    role: 'system',
    content: 'The run stopped before a replay-safe checkpoint was saved.\n\nConnection error.',
    timestamp: Date.parse('2026-05-03T10:00:00.000Z'),
    metadata: {
      runtimeEvent: 'run_error',
      runId: 'run-1',
    },
  });

  assert.match(html, /data-runtime-error-message="true"/);
  assert.match(html, />Error</);
  assert.match(html, /The run stopped before a replay-safe checkpoint was saved\./);
  assert.match(html, /Connection error\./);
  assert.doesNotMatch(html, /LLM/);
}

function testCancelledRuntimeErrorDoesNotRenderAsTranscriptErrorCard(): void {
  const messages = projectSessionMessages('sess-1', {
    messages: [],
    runtimeErrors: [
      {
        id: 'run-error-run-cancel',
        runId: 'run-cancel',
        message: 'run_canceled',
        createdAt: '2026-05-03T10:00:00.000Z',
        terminalCode: 'cancelled',
      },
    ],
  } as Parameters<typeof projectSessionMessages>[1]);

  assert.equal(messages.length, 0);
}

function testContextVersionConflictRuntimeErrorDoesNotRenderAsTranscriptErrorCard(): void {
  const messages = projectSessionMessages('sess-1', {
    messages: [],
    runtimeErrors: [
      {
        id: 'run-error-run-conflict',
        runId: 'run-conflict',
        message: 'Context event version conflict for session:sess-1: expected 71, found 115',
        createdAt: '2026-05-03T10:00:00.000Z',
        terminalCode: 'error',
      },
      {
        id: 'run-error-run-generic',
        runId: 'run-generic',
        message: 'generic failure',
        createdAt: '2026-05-03T10:01:00.000Z',
        terminalCode: 'error',
      },
    ],
  } as Parameters<typeof projectSessionMessages>[1]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.metadata?.runtimeEvent, 'run_error');
  assert.equal(messages[0]?.metadata?.runId, 'run-generic');
  assert.match(messages[0]?.content ?? '', /generic failure/);
  assert.doesNotMatch(messages[0]?.content ?? '', /Context event version conflict/);
}

function testSessionProjectionUsesServerMessageCreatedAt(): void {
  const messages = projectSessionMessages('sess-time', {
    messages: [
      {
        role: 'user',
        content: 'What time is this message?',
        createdAt: '2026-05-10T02:00:00.000Z',
      },
      {
        role: 'assistant',
        content: 'It should render at the event time.',
        createdAt: '2026-05-10T02:00:10.000Z',
      },
    ],
  } as Parameters<typeof projectSessionMessages>[1]);

  assert.equal(messages[0]?.timestamp, Date.parse('2026-05-10T02:00:00.000Z'));
  assert.equal(messages[1]?.timestamp, Date.parse('2026-05-10T02:00:10.000Z'));
}

function testInterruptedArtifactRendersSummaryWithoutEmbeddingPreviewMessages(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderChatContainer(createInterruptedArtifact());

  assert.match(html, />Error</);
  assert.match(html, /Saved through step 55\/100/);
  assert.match(html, /read ECONNRESET/);
  assert.doesNotMatch(html, />Resume</);
  assert.doesNotMatch(html, />Hide</);
  assert.doesNotMatch(html, /I already updated the API route and verified the import\./);
  assert.doesNotMatch(html, /read_file/);
}

function testInterruptedArtifactRendersSessionResyncAction(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderChatContainer(createInterruptedArtifact(), {
    onResyncSession: () => undefined,
  });

  assert.match(html, /data-testid="session-resync-button"/);
  assert.match(html, />Sync session</);
}

function testInterruptedArtifactUsesLocalizedFutureContextCopy(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');
  const html = renderChatContainer(createInterruptedArtifact(), {
    onResyncSession: () => undefined,
  });

  assert.match(html, /\u5df2\u4fdd\u5b58\u5230\u7b2c 55\/100 \u6b65/);
  assert.match(html, /\u8fd9\u90e8\u5206\u8fdb\u5ea6\u5df2\u7ecf\u5728\u672a\u6765\u4e0a\u4e0b\u6587\u4e2d/);
  assert.match(html, />\u540c\u6b65\u4f1a\u8bdd</);
  assert.doesNotMatch(html, /Saved through step/);
  assert.doesNotMatch(html, /future context/);
}

function testInterruptedArtifactUsesLocalizedNoCheckpointCopy(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');
  const html = renderChatContainer(createInterruptedArtifact({
    replayCutoffKind: 'none',
    lastSafeStep: 0,
  }));

  assert.match(html, /\u8fd0\u884c\u5728\u4fdd\u5b58\u53ef\u56de\u653e\u68c0\u67e5\u70b9\u524d\u505c\u6b62/);
  assert.doesNotMatch(html, /replay-safe checkpoint/);
}

function testReplayPrepareCompressionStatusRendersWhileNotRunning(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderChatContainer(null, {
    isRunning: false,
    compressionStatus: {
      source: 'replay_prepare',
      phase: 'started',
      observedAt: '2026-05-11T00:00:00.000Z',
      progressPercent: 35,
      ratio: 0.92,
    },
  });

  assert.match(html, /Preparing history context for the selected model/);
  assert.match(html, /Context compression progress 35%/);
}

function testMissingInterruptedArtifactDoesNotRender(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderChatContainer(null);

  assert.doesNotMatch(html, /Saved through step 55\/100/);
  assert.doesNotMatch(html, />Resume</);
  assert.doesNotMatch(html, /read ECONNRESET/);
}

function testCancelledInterruptedArtifactUsesCancelledLabel(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderChatContainer(
    createInterruptedArtifact({
      terminalCode: 'cancelled',
      errorSummary: undefined,
      lastSafeStep: 12,
      maxSteps: 40,
    })
  );

  assert.match(html, />Canceled</);
  assert.match(html, /Saved through step 12\/40/);
}

function testInterruptedArtifactDoesNotRenderToolPreviewRows(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderChatContainer(
    createInterruptedArtifact({
      previewMessages: [
        {
          role: 'tool',
          content: '{"success":false,"error":"Patch failed"}',
          name: 'write_file',
          toolCallId: 'tool-write-1',
        },
      ],
      sideEffectLedger: [
        {
          id: 'ledger-1',
          observedAt: '2026-04-26T10:01:00.000Z',
          toolName: 'write_file',
          toolCallId: 'tool-write-1',
          resultSuccess: false,
          resultSummary: 'Patch failed',
        },
      ],
    })
  );

  assert.doesNotMatch(html, /Tool Error/);
  assert.doesNotMatch(html, /write_file/);
}

function testInterruptedArtifactViewRedactsWriteFilePreview(): void {
  const view = toInterruptedArtifactView({
    artifactId: 'artifact-redacted',
    context: { scope: 'session', namespace: 'sess-redacted' },
    draftId: 'draft-redacted',
    turnId: 'turn-redacted',
    runId: 'run-redacted',
    runFamilyId: 'family-redacted',
    terminalCode: 'error',
    replayCutoffKind: 'none',
    lastSafeStep: 0,
    maxSteps: 100,
    createdAt: '2026-04-26T10:00:00.000Z',
    updatedAt: '2026-04-26T10:00:00.000Z',
    previewMessages: [
      {
        role: 'assistant',
        content: 'Writing file.',
        toolCalls: [
          {
            id: 'call-write-redacted',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: { path: 'large.txt', content: 'x'.repeat(7000) },
            },
          },
        ],
      },
    ],
    sideEffectLedger: [],
  } satisfies InterruptedArtifact);

  assert.equal(
    view?.previewMessages[0]?.toolCalls?.[0]?.function.arguments.content,
    '[TOOL_ARGUMENT_REDACTED field=content original_chars=7000]'
  );
}

function runAll(): void {
  testRuntimeRunErrorRendersAsTranscriptErrorCard();
  testCancelledRuntimeErrorDoesNotRenderAsTranscriptErrorCard();
  testContextVersionConflictRuntimeErrorDoesNotRenderAsTranscriptErrorCard();
  testSessionProjectionUsesServerMessageCreatedAt();
  testInterruptedArtifactRendersSummaryWithoutEmbeddingPreviewMessages();
  testInterruptedArtifactRendersSessionResyncAction();
  testInterruptedArtifactUsesLocalizedFutureContextCopy();
  testInterruptedArtifactUsesLocalizedNoCheckpointCopy();
  testReplayPrepareCompressionStatusRendersWhileNotRunning();
  testMissingInterruptedArtifactDoesNotRender();
  testCancelledInterruptedArtifactUsesCancelledLabel();
  testInterruptedArtifactDoesNotRenderToolPreviewRows();
  testInterruptedArtifactViewRedactsWriteFilePreview();
  console.log('web-interrupted-artifact-ui tests passed');
}

runAll();
