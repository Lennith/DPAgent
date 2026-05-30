import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArenaConfigDialog, ArenaPanel } from '../../src/web/client/components/arena/ArenaPanel.js';
import { SessionLlmBar } from '../../src/web/client/components/chat/SessionLlmBar.js';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../src/web/client/i18n/index.js';
import type { ArenaRunView, LlmProfilesConfigView, SessionLlmSelectionView } from '../../src/web/client/app-shell-types.js';

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

const profiles: LlmProfilesConfigView = {
  defaultProfileId: 'minimax',
  profiles: [
    {
      id: 'minimax',
      name: 'MiniMax',
      provider: 'anthropic',
      apiBase: 'https://api.example.test',
      defaultModel: 'minimax',
      enabled: true,
      hasApiKey: true,
      capabilities: {},
    },
  ],
};

const selection: SessionLlmSelectionView = {
  profileId: 'minimax',
  model: 'minimax',
  reasoningPreset: 'off',
  updatedAt: '2026-05-30T00:00:00.000Z',
};

const arena: ArenaRunView = {
  id: 'arena-1',
  sourceSessionId: 'sess-source',
  sourceSessionName: 'aaa',
  mode: 'implementation',
  status: 'running',
  prompt: 'implement',
  config: {
    contestants: [],
    judge: { llmSelection: selection },
  },
  branches: [1, 2, 3, 4].map((index) => ({
    id: `branch-${index}`,
    index: index - 1,
    status: index === 1 ? 'submitted' : 'running',
    contestant: {
      id: `contestant-${index}`,
      label: `Contestant ${index}`,
      llmSelection: { ...selection, model: `model-${index}` },
    },
    sessionId: `sess-branch-${index}`,
    workspaceDir: `D:/arena/${index}`,
    ...(index === 1
      ? { submission: { status: 'complete' as const, summary: 'done', evidence: ['test'], submittedAt: '2026-05-30T00:00:00.000Z' } }
      : {}),
  })),
  timeline: [
    { id: 'event-1', type: 'created', message: 'Arena created', createdAt: '2026-05-30T00:00:00.000Z' },
  ],
  createdAt: '2026-05-30T00:00:00.000Z',
  updatedAt: '2026-05-30T00:00:00.000Z',
};

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

function testSessionBarPlacesArenaAfterFork(): void {
  const html = renderWithProviders(
    React.createElement(SessionLlmBar, {
      sessionId: 'sess-source',
      llmProfiles: profiles,
      selection,
      disabled: false,
      onChange: () => undefined,
      onToggleShare: () => undefined,
      onForkSession: () => undefined,
      onOpenArena: () => undefined,
    })
  );

  assert.ok(html.indexOf('data-testid="session-share-button"') < html.indexOf('data-testid="session-fork-button"'));
  assert.ok(html.indexOf('data-testid="session-fork-button"') < html.indexOf('data-testid="session-arena-button"'));
  assert.match(html, /title="Arena"/);
}

function testSessionBarShowsDisabledArenaInShareMode(): void {
  const html = renderWithProviders(
    React.createElement(SessionLlmBar, {
      sessionId: 'sess-source',
      llmProfiles: profiles,
      selection,
      disabled: false,
      onChange: () => undefined,
      onOpenArena: () => undefined,
      arenaDisabled: true,
    })
  );

  assert.match(html, /data-testid="session-arena-button"/);
  assert.match(html, /disabled=""/);
}

function testArenaPanelShowsLockedBranchBoardAndActions(): void {
  const html = renderWithProviders(
    React.createElement(ArenaPanel, {
      arena,
      onRefresh: () => undefined,
      onStart: () => undefined,
      onPause: () => undefined,
      onResume: () => undefined,
      onClose: () => undefined,
      onJudge: () => undefined,
      onCreateProposal: () => undefined,
      onApply: () => undefined,
      onSelectWinner: () => undefined,
      onPromoteBranch: () => undefined,
    })
  );

  assert.match(html, /data-testid="arena-panel"/);
  assert.match(html, /data-testid="arena-branches"/);
  assert.match(html, /data-testid="arena-branch-detail"/);
  assert.match(html, /Contestant 4/);
  assert.match(html, /Branches/);
  assert.match(html, /Detail/);
  assert.match(html, /Source/);
  assert.match(html, /No log/);
  assert.match(html, /Proposal/);
  assert.match(html, /Interrupt Arena/);
  assert.doesNotMatch(html, /chat-composer-card/);
}

function testArenaPanelRequiresProposalForWorkspaceWinner(): void {
  const html = renderWithProviders(
    React.createElement(ArenaPanel, {
      arena: {
        ...arena,
        winner: {
          branchId: 'branch-1',
          mode: 'manual_winner',
          selectedAt: '2026-05-30T00:00:00.000Z',
        },
      },
      onRefresh: () => undefined,
      onStart: () => undefined,
      onPause: () => undefined,
      onResume: () => undefined,
      onClose: () => undefined,
      onJudge: () => undefined,
      onCreateProposal: () => undefined,
      onApply: () => undefined,
      onSelectWinner: () => undefined,
      onPromoteBranch: () => undefined,
    })
  );

  assert.match(html, />Proposal</);
  assert.doesNotMatch(html, />Apply winner</);
}

function testArenaConfigDialogHasContestantsJudgeAndNoToolset(): void {
  const html = renderWithProviders(
    React.createElement(ArenaConfigDialog, {
      open: true,
      llmProfiles: profiles,
      currentSelection: selection,
      inheritedConfig: {
        contestants: [
          { id: 'last-1', label: 'MiniMax last', llmSelection: { ...selection, model: 'minimax-last' } },
          { id: 'last-2', label: 'DeepSeek last', llmSelection: { ...selection, model: 'deepseek-last' } },
          { id: 'last-3', label: 'Kimi last', llmSelection: { ...selection, model: 'kimi-last' } },
          { id: 'last-4', label: 'Mimo last', llmSelection: { ...selection, model: 'mimo-last' } },
        ],
        judge: { llmSelection: { ...selection, model: 'judge-last' } },
      },
      onCancel: () => undefined,
      onCreate: () => undefined,
    })
  );

  assert.match(html, /data-testid="arena-config-dialog"/);
  assert.match(html, /MiniMax last/);
  assert.match(html, /Mimo last/);
  assert.match(html, /judge-last/);
  assert.match(html, /Judge/);
  assert.match(html, /Reasoning/);
  assert.match(html, />Extra high</);
  assert.match(html, /Add contestant/);
  assert.doesNotMatch(html, />Toolset</);
  assert.doesNotMatch(html, />Answer</);
  assert.doesNotMatch(html, />Implementation</);
}

function testArenaDangerActionsUseConfirmDialog(): void {
  const source = fs.readFileSync('src/web/client/components/arena/ArenaPanel.tsx', 'utf-8');
  assert.match(source, /pauseConfirmTitle/);
  assert.match(source, /winnerConfirmTitle/);
  assert.match(source, /promoteConfirmTitle/);
  assert.match(source, /applyConfirmTitle/);
  assert.match(source, /closeConfirmTitle/);
}

function testArenaPanelHasReadOnlyHistoryAndBranchDetailApi(): void {
  const panelSource = fs.readFileSync('src/web/client/components/arena/ArenaPanel.tsx', 'utf-8');
  const apiSource = fs.readFileSync('src/web/client/session-rest-api.ts', 'utf-8');
  assert.match(panelSource, /data-testid="arena-source-history"/);
  assert.match(panelSource, /sourceMessages/);
  assert.match(panelSource, /fetchArenaBranchDetail/);
  assert.match(panelSource, /MessageItem/);
  assert.match(panelSource, /ARENA_TRANSCRIPT_FILTERS/);
  assert.match(panelSource, /showToolResult: false/);
  assert.equal(apiSource.includes('branches/${branchId}/detail'), true);
}

testSessionBarPlacesArenaAfterFork();
testSessionBarShowsDisabledArenaInShareMode();
testArenaPanelShowsLockedBranchBoardAndActions();
testArenaPanelRequiresProposalForWorkspaceWinner();
testArenaConfigDialogHasContestantsJudgeAndNoToolset();
testArenaDangerActionsUseConfirmDialog();
testArenaPanelHasReadOnlyHistoryAndBranchDetailApi();
console.log('web-arena-ui tests passed');
