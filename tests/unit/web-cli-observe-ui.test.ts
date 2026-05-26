import * as assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatContainer } from '../../src/web/client/components/chat/ChatContainer.js';
import { Sidebar } from '../../src/web/client/components/sidebar/Sidebar.js';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../src/web/client/i18n/index.js';

const PINNED_SESSION_STORAGE_KEY = 'minimax-ui-pinned-session-ids';

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

function renderWithProviders(element: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ThemeProvider, null, element)
    )
  );
}

function testCliRunningChatContainerIsObserveOnly(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderWithProviders(
    React.createElement(ChatContainer, {
      messages: [],
      liveEvents: [],
      pendingPlanInput: {
        requestId: 'req-cli-plan',
        questions: [
          {
            header: 'Approval',
            id: 'approval',
            question: 'Approve CLI plan execution?',
            options: [
              { label: 'Approve execution', description: 'Start execution from the approved plan.' },
              { label: 'Revise plan', description: 'Keep drafting.' },
            ],
          },
        ],
      },
      pendingPlanInputError: null,
      onSubmitPlanInput: () => undefined,
      input: '',
      setInput: () => undefined,
      onSend: () => undefined,
      onCancel: () => undefined,
      isRunning: true,
      canCancel: false,
      isInteractionLocked: true,
      interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
      error: null,
      interruptedArtifact: null,
      sessionId: 'sess-cli',
      planningState: 'plan_drafting',
      llmSelection: {
        profileId: 'kimi',
        model: 'kimi-coding',
        reasoningPreset: 'high',
        updatedAt: '2026-05-03T00:00:00.000Z',
      },
      currentLlmRuntime: {
        profileId: 'kimi',
        provider: 'anthropic',
        model: 'kimi-coding',
        reasoningPreset: 'high',
      },
    })
  );

  assert.match(html, /CLI is running/);
  assert.match(html, /Web can observe the transcript/);
  assert.match(html, /data-testid="cli-readonly-runtime"/);
  assert.match(html, /data-testid="plan-input-card"/);
  assert.match(html, /This session is running from CLI/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /kimi-coding/);
  assert.doesNotMatch(html, /data-testid="composer-llm-slot"/);
  assert.doesNotMatch(html, /data-testid="composer-ralph-slot"/);
  assert.doesNotMatch(html, /title="Stop current run"/);
}

function testSidebarGroupsWebAndCliSessions(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  localStorage.removeItem(PINNED_SESSION_STORAGE_KEY);
  const html = renderWithProviders(
    React.createElement(Sidebar, {
      sessions: [
        {
          id: 'sess-web',
          name: 'Web task',
          workspaceDir: 'D:\\web',
          origin: 'web',
          interactionState: { mode: 'normal' },
        },
        {
          id: 'sess-cli',
          name: 'CLI task',
          workspaceDir: 'D:\\cli',
          origin: 'cli',
          interactionState: { mode: 'observe_only' },
        },
      ],
      currentSessionId: 'sess-cli',
      onSelectSession: () => undefined,
      onNewSession: () => undefined,
      onOpenAutomations: () => undefined,
      onDeleteSession: () => undefined,
      onRenameSession: () => undefined,
      workspaceDir: 'D:\\web',
      onChangeWorkspace: () => undefined,
      isConnected: true,
      runningSessionIds: ['sess-cli'],
    })
  );

  assert.match(html, /Web Sessions \(1\)/);
  assert.match(html, /CLI Sessions \(1\)/);
  assert.match(html, /aria-label="Collapse section"/);
  assert.match(html, /data-testid="sidebar-pin-dropzone"/);
  assert.match(html, /data-testid="sidebar-session-list-dropzone"/);
  assert.match(html, /Web task/);
  assert.match(html, /CLI task/);
  assert.match(html, />CLI</);
  assert.match(html, /disabled=""/);
}

function testSidebarShowsPinnedSessionsWithoutRemovingOriginalGroupItem(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  localStorage.setItem(PINNED_SESSION_STORAGE_KEY, JSON.stringify(['sess-cli']));
  const html = renderWithProviders(
    React.createElement(Sidebar, {
      sessions: [
        {
          id: 'sess-web',
          name: 'Web task',
          workspaceDir: 'D:\\web',
          origin: 'web',
          interactionState: { mode: 'normal' },
        },
        {
          id: 'sess-cli',
          name: 'CLI task',
          workspaceDir: 'D:\\cli',
          origin: 'cli',
          interactionState: { mode: 'observe_only' },
        },
      ],
      currentSessionId: 'sess-cli',
      onSelectSession: () => undefined,
      onNewSession: () => undefined,
      onOpenAutomations: () => undefined,
      onDeleteSession: () => undefined,
      onRenameSession: () => undefined,
      workspaceDir: 'D:\\web',
      onChangeWorkspace: () => undefined,
      isConnected: true,
    })
  );

  assert.match(html, /Pinned \(1\)/);
  assert.match(html, /CLI Sessions \(1\)/);
  assert.match(html, /data-testid="sidebar-session-row-pinned-sess-cli"/);
  assert.match(html, /data-testid="sidebar-session-row-list-sess-cli"/);
  assert.match(html, /draggable="true"/);
}

function withMatchMedia(
  matches: boolean,
  callback: (queries: string[]) => void
): void {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const queries: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    value: {
      matchMedia(query: string) {
        queries.push(query);
        return {
          matches: query.includes('max-width') || query.includes('max-aspect-ratio') ? matches : false,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        };
      },
    },
    configurable: true,
  });
  try {
    callback(queries);
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        value: previousWindow,
        configurable: true,
      });
    }
  }
}

function testSidebarCollapsedStateUsesExpandTabOnly(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  localStorage.removeItem(PINNED_SESSION_STORAGE_KEY);
  const html = renderWithProviders(
    React.createElement(Sidebar, {
      sessions: [],
      currentSessionId: null,
      onSelectSession: () => undefined,
      onNewSession: () => undefined,
      onOpenAutomations: () => undefined,
      onDeleteSession: () => undefined,
      onRenameSession: () => undefined,
      workspaceDir: 'D:\\web',
      onChangeWorkspace: () => undefined,
      isConnected: true,
      defaultCollapsed: true,
    })
  );

  assert.match(html, /data-testid="sidebar-expand-tab"/);
  assert.match(html, /aria-label="Expand sidebar"/);
  assert.doesNotMatch(html, /data-testid="sidebar-brand-header"/);
  assert.doesNotMatch(html, /data-testid="sidebar-pin-dropzone"/);
}

function testSidebarAutoCollapseKeepsWideScaledDesktopExpanded(): void {
  withMatchMedia(true, (queries) => {
    const html = renderWithProviders(
      React.createElement(Sidebar, {
        sessions: [],
        currentSessionId: null,
        onSelectSession: () => undefined,
        onNewSession: () => undefined,
        onOpenAutomations: () => undefined,
        onDeleteSession: () => undefined,
        onRenameSession: () => undefined,
        workspaceDir: 'D:\\web',
        onChangeWorkspace: () => undefined,
        isConnected: true,
      })
    );

    const sidebarQueries = queries.filter((query) => query.includes('max-width') || query.includes('max-aspect-ratio'));
    assert.ok(sidebarQueries.length >= 1);
    for (const query of sidebarQueries) {
      assert.equal(query.includes('1279px'), false);
      assert.match(query, /max-width: 900px/);
      assert.match(query, /max-aspect-ratio: 11\/10/);
    }
    assert.match(html, /data-auto-rail="true"/);
    assert.match(html, /data-testid="sidebar-expand-tab"/);
  });
}

testCliRunningChatContainerIsObserveOnly();
testSidebarGroupsWebAndCliSessions();
testSidebarShowsPinnedSessionsWithoutRemovingOriginalGroupItem();
testSidebarCollapsedStateUsesExpandTabOnly();
testSidebarAutoCollapseKeepsWideScaledDesktopExpanded();
console.log('web-cli-observe-ui tests passed');
