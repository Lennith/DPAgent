import * as assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatContainer } from '../../src/web/client/components/chat/ChatContainer.js';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import {
  I18nProvider,
  LOCALE_STORAGE_KEY,
} from '../../src/web/client/i18n/index.js';
import type { InterruptedArtifactView } from '../../src/web/client/app-shell-types.js';

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
    resumable: true,
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

function renderChatContainer(interruptedArtifact: InterruptedArtifactView | null): string {
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
          onResumeInterruptedRun: () => undefined,
          onDismissInterruptedArtifact: () => undefined,
          isRunning: false,
          canCancel: false,
          isInteractionLocked: false,
          error: null,
          interruptedArtifact,
          sessionId: 'sess-1',
        })
      )
    )
  );
}

function testInterruptedArtifactRendersResumeHideAndPreview(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderChatContainer(createInterruptedArtifact());

  assert.match(html, />Error</);
  assert.match(html, /Saved through step 55\/100/);
  assert.match(html, /read ECONNRESET/);
  assert.match(html, />Resume</);
  assert.match(html, />Hide</);
  assert.match(html, /I already updated the API route and verified the import\./);
  assert.match(html, /read_file/);
}

function testDismissedInterruptedArtifactDoesNotRender(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderChatContainer(
    createInterruptedArtifact({
      dismissedAt: '2026-04-26T10:02:00.000Z',
    })
  );

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

function testInterruptedArtifactToolPreviewUsesFailureState(): void {
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

  assert.match(html, /Tool Error/);
  assert.match(html, /write_file/);
}

function runAll(): void {
  testInterruptedArtifactRendersResumeHideAndPreview();
  testDismissedInterruptedArtifactDoesNotRender();
  testCancelledInterruptedArtifactUsesCancelledLabel();
  testInterruptedArtifactToolPreviewUsesFailureState();
  console.log('web-interrupted-artifact-ui tests passed');
}

runAll();
