import * as assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../src/web/client/i18n/index.js';
import { ChatContainer } from '../../src/web/client/components/chat/ChatContainer.js';
import { MessageItem } from '../../src/web/client/components/chat/MessageItem.js';
import { PendingPlanInputBanner } from '../../src/web/client/components/chat/PendingPlanInputBanner.js';
import {
  PlanInputCard,
  resolvePlanInputAnswerPayload,
} from '../../src/web/client/components/chat/PlanInputCard.js';
import { TodoPanel } from '../../src/web/client/components/chat/TodoPanel.js';
import { Sidebar } from '../../src/web/client/components/sidebar/Sidebar.js';
import { SubAgentPanel } from '../../src/web/client/components/subagent/SubAgentPanel.js';
import { RightToolbar } from '../../src/web/client/components/toolbar/RightToolbar.js';
import AutoLoopControl from '../../src/web/client/components/auto-loop/AutoLoopControl.js';
import AutomationCenter from '../../src/web/client/components/automation/AutomationCenter.js';
import { resolveSessionLlmSelectionView } from '../../src/web/client/llm-session-state.js';
import {
  normalizeTextDeltaForDisplay,
  normalizeThinkingDeltaForDisplay,
} from '../../src/web/client/hooks/useAppSessionController.js';
import {
  addIgnoredRunId,
  appendLiveTextDelta,
  createRuntimeState,
  observeRunEvent,
  shouldApplyRunEvent,
  upsertRunStatusEvent,
  type LlmProfilesConfigView,
} from '../../src/web/client/app-shell-types.js';

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

  clear(): void {
    this.store.clear();
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

Object.defineProperty(globalThis, 'fetch', {
  value: async () => ({
    ok: true,
    async json() {
      return {
        config: {
          enabled: true,
          prompt: 'todo prompt',
          maxRounds: 20,
          maxDurationMinutes: 120,
          similarityThreshold: 0.85,
          compareRounds: 3,
          pausedByUser: false,
        },
        state: {
          isRunning: true,
          currentRound: 2,
        },
        todoDriven: true,
      };
    },
  }),
  configurable: true,
});

function renderNode(element: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ThemeProvider, null, element)
    )
  );
}

function renderNodeWithLocale(element: React.ReactElement, locale: string): string {
  globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  try {
    return renderNode(element);
  } finally {
    globalThis.localStorage.removeItem(LOCALE_STORAGE_KEY);
  }
}

function createLlmProfiles(): LlmProfilesConfigView {
  return {
    defaultProfileId: 'anthropic-default',
    profiles: [
      {
        id: 'anthropic-default',
        name: 'Anthropic Default',
        provider: 'anthropic',
        apiBase: 'https://api.minimaxi.com',
        defaultModel: 'MiniMax-M2.7',
        hasApiKey: true,
        capabilities: {
          modelDiscovery: true,
          reasoningEffort: false,
          thinkingBudget: true,
        },
      },
    ],
  };
}

function testTodoPanelShowsProtocolFields(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  const emptyHtml = renderNode(React.createElement(TodoPanel, { items: [] }));
  assert.doesNotMatch(emptyHtml, /TodoList/);

  const html = renderNode(
    React.createElement(TodoPanel, {
      items: [
        {
          id: 'todo-1',
          work: 'Investigate memory organize queue',
          detectionStandard: 'The queue is empty and organize audit is recorded.',
          status: 'in_progress',
          priority: 'high',
          createdAt: '2026-04-13T10:00:00.000Z',
          updatedAt: '2026-04-13T10:05:00.000Z',
        },
        {
          id: 'todo-2',
          work: 'Collect user blocker details',
          detectionStandard: 'The user has confirmed the missing credential.',
          status: 'blocked',
          priority: 'medium',
          blockedReason: 'Waiting for the user to provide credentials.',
          createdAt: '2026-04-13T10:06:00.000Z',
          updatedAt: '2026-04-13T10:07:00.000Z',
        },
        {
          id: 'todo-3',
          work: 'Completed todo remains visible',
          detectionStandard: 'The completed item keeps its completion badge.',
          status: 'completed',
          priority: 'low',
          createdAt: '2026-04-13T10:08:00.000Z',
          updatedAt: '2026-04-13T10:09:00.000Z',
        },
        {
          id: 'todo-4',
          work: 'Dismissed todo stays out of the active list',
          detectionStandard: 'Dismissed todos are audit-only.',
          status: 'dismissed',
          priority: 'low',
          createdAt: '2026-04-13T10:10:00.000Z',
          updatedAt: '2026-04-13T10:11:00.000Z',
        },
      ],
      onResumeTodo: () => undefined,
      onDismissTodo: () => undefined,
    })
  );

  assert.match(html, /TodoList/);
  assert.match(html, /Investigate memory organize queue/);
  assert.match(html, /The queue is empty and organize audit is recorded/);
  assert.match(html, /Waiting for the user to provide credentials/);
  assert.match(html, /Completed todo remains visible/);
  assert.match(html, /Resume|\u6062\u590d/);
  assert.match(html, /Dismiss|\u5ffd\u7565/);
  assert.doesNotMatch(html, /Dismissed todo stays out of the active list/);
  assert.match(html, /\u5df2\u5b8c\u6210|Completed/);
  assert.doesNotMatch(html, /Add a task/);
}

function testChatContainerDoesNotRenderTodoProtocolInMainChat(): void {
  const html = renderNode(
    React.createElement(ChatContainer, {
      messages: [],
      liveEvents: [],
      pendingPlanInput: null,
      pendingPlanInputError: null,
      onSubmitPlanInput: () => undefined,
      input: '',
      setInput: () => undefined,
      onSend: () => undefined,
      isRunning: false,
      error: null,
      sessionId: 'sess-1',
      contextUtilization: null,
      currentStep: 0,
      maxSteps: 0,
    })
  );

  assert.doesNotMatch(html, /data-testid="todo-panel"/);
  assert.doesNotMatch(html, /Memory Organize/i);
}

function testRightToolbarShowsSubAgentsAndTodoList(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  const html = renderNode(
    React.createElement(RightToolbar, {
      sessionId: 'sess-1',
      onHide: () => undefined,
      todoItems: [
        {
          id: 'todo-pending',
          work: 'Pending only',
          detectionStandard: 'Done when a pending todo is visible.',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-04-13T10:00:00.000Z',
          updatedAt: '2026-04-13T10:00:00.000Z',
        },
      ],
    })
  );

  assert.match(html, /data-testid="subagent-header"/);
  assert.match(html, /data-testid="right-toolbar-todo"/);
  assert.match(html, /data-testid="todo-panel"/);
  assert.match(html, /Pending only/);
  assert.doesNotMatch(html, /TodoList<\/p>/);
  assert.doesNotMatch(html, /Pending queue/);
  assert.doesNotMatch(html, /Sub Agents \+ Todo/);
}

function testRightToolbarShowsTodoCleanupAfterStop(): void {
  const html = renderNodeWithLocale(
    React.createElement(RightToolbar, {
      sessionId: 'sess-1',
      onHide: () => undefined,
      todoCleanupAvailable: true,
      onCleanupTodos: () => undefined,
      todoItems: [
        {
          id: 'todo-pending',
          work: 'Pending cleanup candidate',
          detectionStandard: 'Done when cleanup is visible.',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-04-13T10:00:00.000Z',
          updatedAt: '2026-04-13T10:00:00.000Z',
        },
      ],
    }),
    'en-US'
  );

  assert.match(html, /data-testid="todo-cleanup-button"/);
  assert.match(html, /Clean up/);
  assert.match(html, /Pending cleanup candidate/);
}

function testRightToolbarHidesTodoCleanupWithoutStopEligibility(): void {
  const html = renderNodeWithLocale(
    React.createElement(RightToolbar, {
      sessionId: 'sess-1',
      onHide: () => undefined,
      todoCleanupAvailable: false,
      onCleanupTodos: () => undefined,
      todoItems: [
        {
          id: 'todo-pending',
          work: 'Pending without cleanup',
          detectionStandard: 'Done when cleanup is hidden.',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-04-13T10:00:00.000Z',
          updatedAt: '2026-04-13T10:00:00.000Z',
        },
      ],
    }),
    'en-US'
  );

  assert.doesNotMatch(html, /data-testid="todo-cleanup-button"/);
  assert.match(html, /Pending without cleanup/);
}

function testRightToolbarClearsCompletedOnlyTodos(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  const html = renderNode(
    React.createElement(RightToolbar, {
      sessionId: 'sess-1',
      onHide: () => undefined,
      todoItems: [
        {
          id: 'todo-completed',
          work: 'Completed only',
          detectionStandard: 'Done when a completed todo remains visible.',
          status: 'completed',
          priority: 'medium',
          createdAt: '2026-04-13T10:00:00.000Z',
          updatedAt: '2026-04-13T10:00:00.000Z',
        },
      ],
    })
  );

  assert.doesNotMatch(html, /data-testid="right-toolbar-todo"/);
  assert.doesNotMatch(html, /Completed only/);
}

function testRightToolbarHidesTodoAreaWhenNoOpenTodos(): void {
  const html = renderNode(
    React.createElement(RightToolbar, {
      sessionId: 'sess-1',
      onHide: () => undefined,
      todoItems: [],
    })
  );

  assert.match(html, /data-testid="subagent-header"/);
  assert.doesNotMatch(html, /data-testid="right-toolbar-todo"/);
  assert.doesNotMatch(html, /data-testid="todo-panel"/);
}

function testChatContainerLocksComposerAndLlmBarDuringCancelWindow(): void {
  const llmProfiles = createLlmProfiles();
  const html = renderNode(
    React.createElement(ChatContainer, {
      messages: [],
      liveEvents: [],
      pendingPlanInput: null,
      pendingPlanInputError: null,
      onSubmitPlanInput: () => undefined,
      input: 'continue',
      setInput: () => undefined,
      onSend: () => undefined,
      isRunning: false,
      isCanceling: true,
      isInteractionLocked: true,
      error: null,
      sessionId: 'sess-1',
      llmProfiles,
      llmSelection: resolveSessionLlmSelectionView(llmProfiles, null),
      onChangeLlmSelection: () => undefined,
      contextUtilization: null,
      currentStep: 0,
      maxSteps: 0,
    })
  );

  assert.match(html, /composer-ralph-slot/);
  assert.match(html, /<textarea[^>]*disabled=""/);
  assert.match(html, /data-testid="composer-llm-slot"/);
  assert.match(html, /data-testid="session-llm-compact"/);
  assert.match(html, /composer-control-stack/);
  assert.match(html, /data-testid="composer-control-row"/);
  assert.match(html, /composer-settings-row/);
  assert.match(html, /composer-ralph-slot/);
  assert.match(html, /data-testid="chat-stop"/);
  assert.doesNotMatch(html, /data-testid="chat-send"/);
  assert.doesNotMatch(html, /只影响本会话/);
}

function testRightToolbarClearsDismissedOnlyTodos(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  const html = renderNode(
    React.createElement(RightToolbar, {
      sessionId: 'sess-1',
      onHide: () => undefined,
      todoItems: [
        {
          id: 'todo-dismissed',
          work: 'Dismissed only',
          detectionStandard: 'Dismissed audit rows are not active todos.',
          status: 'dismissed',
          priority: 'medium',
          createdAt: '2026-04-13T10:00:00.000Z',
          updatedAt: '2026-04-13T10:00:00.000Z',
        },
      ],
    })
  );

  assert.doesNotMatch(html, /data-testid="right-toolbar-todo"/);
  assert.doesNotMatch(html, /Dismissed only/);
}

function testChatContainerKeepsDraftAndSettingsEditableDuringActiveWebRun(): void {
  const llmProfiles = createLlmProfiles();
  const draftHtml = renderNode(
    React.createElement(ChatContainer, {
      messages: [],
      liveEvents: [],
      pendingPlanInput: null,
      pendingPlanInputError: null,
      onSubmitPlanInput: () => undefined,
      input: 'next draft',
      setInput: () => undefined,
      onSend: () => undefined,
      onCancel: () => undefined,
      planningState: 'normal',
      onPlanningStateChange: () => undefined,
      onPlanModeIntentChange: () => undefined,
      isRunning: true,
      isCanceling: false,
      isInteractionLocked: true,
      error: null,
      sessionId: 'sess-1',
      llmProfiles,
      llmSelection: resolveSessionLlmSelectionView(llmProfiles, null),
      onChangeLlmSelection: () => undefined,
      contextUtilization: null,
      currentStep: 1,
      maxSteps: 5,
    })
  );

  assert.doesNotMatch(draftHtml, /<textarea[^>]*disabled=""/);
  assert.match(draftHtml, /data-testid="composer-llm-slot"/);
  assert.match(draftHtml, /data-testid="composer-ralph-slot"/);
  assert.match(draftHtml, /data-testid="chat-send"/);
  assert.doesNotMatch(draftHtml, /data-testid="chat-stop"/);

  const emptyDraftHtml = renderNode(
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
      planningState: 'normal',
      onPlanningStateChange: () => undefined,
      onPlanModeIntentChange: () => undefined,
      isRunning: true,
      isCanceling: false,
      isInteractionLocked: true,
      error: null,
      sessionId: 'sess-1',
      llmProfiles,
      llmSelection: resolveSessionLlmSelectionView(llmProfiles, null),
      onChangeLlmSelection: () => undefined,
      contextUtilization: null,
      currentStep: 1,
      maxSteps: 5,
    })
  );
  assert.match(emptyDraftHtml, /data-testid="chat-stop"/);
}

function testResponsiveShellClassesRemainAvailable(): void {
  const toolbarHtml = renderNode(
    React.createElement(RightToolbar, {
      sessionId: 'sess-1',
      onHide: () => undefined,
      todoItems: [],
    })
  );
  assert.match(toolbarHtml, /right-toolbar-content/);
  assert.match(toolbarHtml, /data-testid="subagent-header"/);
  assert.match(toolbarHtml, /data-testid="right-toolbar-collapse-button"/);

  const sidebarHtml = renderNode(
    React.createElement(Sidebar, {
      sessions: [
        {
          id: 'sess-1',
          name: 'Long responsive session name',
          workspaceDir: 'D:/very/long/workspace/path',
        },
      ],
      currentSessionId: 'sess-1',
      onSelectSession: () => undefined,
      onNewSession: () => undefined,
      onOpenAutomations: () => undefined,
      onDeleteSession: () => undefined,
      onRenameSession: () => undefined,
      workspaceDir: 'D:/very/long/workspace/path',
      onChangeWorkspace: () => undefined,
      automationViewActive: false,
      isConnected: true,
      hasApiKey: true,
      onOpenSettings: () => undefined,
    })
  );
  assert.match(sidebarHtml, /app-sidebar/);
  assert.match(sidebarHtml, /data-testid="sidebar-collapse-button"/);
  assert.match(sidebarHtml, /data-testid="sidebar-status-lamps"/);
  assert.match(sidebarHtml, /data-testid="sidebar-new-chat"/);
  assert.match(sidebarHtml, /data-testid="sidebar-open-automations"/);
  assert.match(sidebarHtml, /data-testid="open-config"/);
  assert.match(sidebarHtml, /data-testid="sidebar-workspace-button"/);
}

function testThinkingDeltaPreservesEnglishSpacing(): void {
  const joined = ['Let', ' me', ' check']
    .map((chunk) => normalizeThinkingDeltaForDisplay(chunk))
    .join('');

  assert.equal(joined, 'Let me check');
  assert.equal(normalizeThinkingDeltaForDisplay(''), null);
  assert.equal(normalizeThinkingDeltaForDisplay(null), null);
}

function testTextDeltaPreservesEnglishSpacingAndCreatesLiveBubble(): void {
  const runtime = {
    profileId: 'profile-kimi',
    provider: 'anthropic' as const,
    model: 'kimi-for-coding',
    reasoningPreset: 'off' as const,
  };
  const liveEvents = ['Let', ' me', ' check'].reduce(
    (events, chunk, index) =>
      appendLiveTextDelta(events, normalizeTextDeltaForDisplay(chunk) ?? '', index + 1, () => `live-${index}`, runtime),
    [] as ReturnType<typeof appendLiveTextDelta>
  );

  assert.equal(liveEvents.length, 1);
  assert.equal(liveEvents[0]?.type, 'text');
  assert.equal(liveEvents[0]?.type === 'text' ? liveEvents[0].content : '', 'Let me check');
  assert.equal(liveEvents[0]?.type === 'text' ? liveEvents[0].llmRuntime?.model : '', 'kimi-for-coding');
  assert.equal(normalizeTextDeltaForDisplay(''), null);
  assert.equal(normalizeTextDeltaForDisplay(null), null);
}

function testMessageItemShowsAssistantModelName(): void {
  const html = renderNode(
    React.createElement(MessageItem, {
      message: {
        id: 'assistant-model',
        role: 'assistant',
        content: 'done',
        timestamp: Date.now(),
        metadata: {
          llmProviderProfileId: 'profile-kimi',
          llmProvider: 'anthropic',
          llmModel: 'kimi-for-coding',
        },
      },
    })
  );

  assert.match(html, /kimi-for-coding/);
  assert.doesNotMatch(html, />MiniMax</);
}

function testRuntimeEventRecoveryAcceptsMissingOrStoppedRunId(): void {
  const empty = createRuntimeState();
  assert.equal(shouldApplyRunEvent(empty, 'run-1'), true);
  const observed = observeRunEvent(empty, 'run-1', 123);
  assert.equal(observed.runId, 'run-1');
  assert.equal(observed.isRunning, true);
  assert.equal(shouldApplyRunEvent(observed, 'run-2'), false);
  assert.equal(shouldApplyRunEvent({ ...observed, isRunning: false }, 'run-2'), false);
  const pending = { ...empty, isRunning: true, runStartedAt: 123 };
  assert.equal(shouldApplyRunEvent(pending, 'run-stale'), false);
  const recovered = { ...observed, runId: null, isRunning: false, runStartedAt: 0 };
  assert.equal(shouldApplyRunEvent(recovered, 'run-2'), true);
  const ignored = addIgnoredRunId(recovered, 'run-2');
  assert.equal(shouldApplyRunEvent(ignored, 'run-2'), false);
}

function testRunStatusLiveEventIsCompactAndUpserted(): void {
  const events = upsertRunStatusEvent([], {
    title: 'Step 1/100',
    summary: 'Model: kimi-for-coding',
    timestamp: 1,
    createEventId: () => 'status-1',
  });
  const next = upsertRunStatusEvent(events, {
    title: 'Step 2/100',
    summary: 'Model: kimi-for-coding',
    timestamp: 2,
    createEventId: () => 'status-2',
  });

  assert.equal(next.length, 1);
  assert.equal(next[0]?.type, 'run_status');
  assert.equal(next[0]?.type === 'run_status' ? next[0].title : '', 'Step 2/100');
}

function testMessageItemShowsToolBlocksWithoutAssistantText(): void {
  const html = renderNode(
    React.createElement(MessageItem, {
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            name: 'memory_manage',
            args: {
              action: 'add',
              scope: 'workspace',
              title: 'Build workflow',
            },
          },
        ],
        toolResults: [
          {
            name: 'memory_manage',
            result: {
              success: true,
              content: JSON.stringify({ action: 'add', id: 'mem-1', success: true }),
            },
          },
        ],
      },
    })
  );

  assert.match(html, /Tool Call/);
  assert.match(html, /Tool Result/);
  assert.match(html, /memory_manage/);
  assert.match(html, /Build workflow/);
  assert.match(html, /mem-1/);
}

function testMessageItemDisplayFiltersHideProcessBlocksOnly(): void {
  const message = {
    id: 'assistant-filtered',
    role: 'assistant' as const,
    content: 'Final answer stays visible.',
    thinking: 'internal reasoning trace',
    timestamp: Date.now(),
    toolCalls: [
      {
        name: 'memory_manage',
        args: {
          action: 'add',
          scope: 'workspace',
          title: 'Hidden tool call',
        },
      },
    ],
    toolResults: [
      {
        name: 'memory_manage',
        result: {
          success: true,
          content: JSON.stringify({ id: 'hidden-result' }),
        },
      },
    ],
  };

  const html = renderNode(
    React.createElement(MessageItem, {
      message,
      displayFilters: {
        showThinking: false,
        showToolCall: false,
        showToolResult: false,
      },
    })
  );

  assert.match(html, /Final answer stays visible/);
  assert.doesNotMatch(html, /Thinking/);
  assert.doesNotMatch(html, /internal reasoning trace/);
  assert.doesNotMatch(html, /Tool Call/);
  assert.doesNotMatch(html, /Hidden tool call/);
  assert.doesNotMatch(html, /Tool Result/);
  assert.doesNotMatch(html, /hidden-result/);
}

function testMessageItemRedactsLargeWriteFileArgs(): void {
  const html = renderNode(
    React.createElement(MessageItem, {
      message: {
        id: 'assistant-write-file',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            name: 'write_file',
            args: {
              path: 'story.txt',
              content: 'x'.repeat(10000),
            },
          },
        ],
      },
    })
  );

  assert.match(html, /TOOL_ARGUMENT_REDACTED/);
  assert.match(html, /original_chars=10000/);
  assert.doesNotMatch(html, /x{5000}/);
}

function createPlanPreviewArgs(): Record<string, unknown> {
  return {
    title: 'Rendered Final Plan',
    summary: 'Show users the plan as a readable card.',
    steps: [
      {
        work: 'Build the finalized plan card.',
        detection_standard: 'The chat transcript displays the plan title and step.',
        priority: 'high',
        tags: ['plan-mode'],
      },
    ],
    test_plan: ['Render the plan card'],
    assumptions: ['Keep raw tool details available'],
    notes: 'Use the existing markdown renderer.',
  };
}

function testMessageItemRendersFinalizePlanAsPlanCard(): void {
  const html = renderNode(
    React.createElement(MessageItem, {
      message: {
        id: 'assistant-finalize-plan',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            name: 'finalize_plan',
            args: createPlanPreviewArgs(),
          },
        ],
      },
    })
  );

  assert.match(html, /data-testid="finalized-plan-card"/);
  assert.match(html, /Rendered Final Plan/);
  assert.match(html, /Build the finalized plan card/);
  assert.match(html, /The chat transcript displays the plan title and step/);
  assert.match(html, /Raw payload/);
}

function testPlanInputCardRendersFinalizePlanPreview(): void {
  const html = renderNode(
    React.createElement(PlanInputCard, {
      request: {
        requestId: 'req-plan-approval',
        planPreview: {
          ...createPlanPreviewArgs(),
          planId: 'plan-1',
          markdown: '### Rendered Final Plan\n\n### Summary\nShow users the plan as a readable card.\n\n### Test Plan\n- Render the plan card',
          testPlan: ['Render the plan card'],
        },
        questions: [
          {
            header: 'Execute Plan',
            id: 'plan_execution_approval',
            question: 'Approve execution?',
            options: [
              { label: 'Approve execution', description: 'Start execution.' },
              { label: 'Request changes', description: 'Revise the plan.' },
            ],
          },
        ],
      } as Parameters<typeof PlanInputCard>[0]['request'],
      error: null,
      onSubmit: () => undefined,
    })
  );

  assert.match(html, /data-testid="finalized-plan-card"/);
  assert.match(html, /Rendered Final Plan/);
  assert.match(html, /Render the plan card/);
}

function testPlanInputCardRendersCustomAnswerChoice(): void {
  const html = renderNode(
    React.createElement(PlanInputCard, {
      request: {
        requestId: 'req-custom-answer',
        questions: [
          {
            header: 'Mode',
            id: 'mode',
            question: 'Pick a mode',
            options: [
              { label: 'Fast', description: 'Speed first.' },
              { label: 'Safe', description: 'Risk first.' },
            ],
          },
        ],
      } as Parameters<typeof PlanInputCard>[0]['request'],
      error: null,
      onSubmit: () => undefined,
    })
  );

  assert.match(html, /Custom answer|自定义答案/);
  assert.match(html, /Optional extra details or your own answer|可选：补充说明或直接输入你的答案/);
}

function testPlanInputCardPreservesSelectedOptionWithSupplementalText(): void {
  const payload = resolvePlanInputAnswerPayload(
    {
      header: 'Execute Plan',
      id: 'plan_execution_approval',
      question: 'Approve execution?',
      options: [
        { label: 'Approve execution', description: 'Start execution.' },
        { label: 'Request changes', description: 'Revise the plan.' },
      ],
    },
    {
      selectedIndex: 0,
      customSelected: false,
      freeText: 'Keep the release note update in scope.',
    }
  );

  assert.deepEqual(payload, {
    id: 'plan_execution_approval',
    selectedIndex: 0,
    selectedLabel: 'Approve execution',
    freeText: 'Keep the release note update in scope.',
  });
}

function testAutomationCenterRendersIntervalControls(): void {
  const html = renderNode(
    React.createElement(AutomationCenter, {
      workspaceDir: 'D:\\repo',
      llmProfiles: createLlmProfiles(),
      onOpenSession: () => undefined,
    })
  );

  assert.match(html, /automation-frequency-option-interval/);
  assert.match(html, /automation-interval-seconds-input/);
  assert.match(html, /Next run|下次执行/);
}

function testSubAgentPanelOnlyShowsSubagentControls(): void {
  const subagentOnlyHtml = renderNode(React.createElement(SubAgentPanel, { sessionId: 'sess-1' }));
  assert.match(subagentOnlyHtml, /session: sess-1/);
  assert.match(subagentOnlyHtml, /Sub Agents/);
  assert.doesNotMatch(subagentOnlyHtml, /memory organize/i);
  assert.doesNotMatch(subagentOnlyHtml, /Governance Audit/i);
  assert.doesNotMatch(subagentOnlyHtml, /Ralph loop/);
}

function testSubAgentPanelRendersDashboardCardsWithoutPseudoPhase(): void {
  const html = renderNode(
    React.createElement(SubAgentPanel, {
      sessionId: 'sess-1',
      initialExpandedId: 'agent-failed',
      initialItems: [
        {
          subagentId: 'agent-done',
          status: 'succeeded',
          runSeq: 1,
          updatedAt: '2026-04-24T10:00:00.000Z',
          latestResult: {
            status: 'done',
            summary: 'Completed summary',
          },
        },
        {
          subagentId: 'agent-running',
          status: 'running',
          runSeq: 3,
          updatedAt: '2026-04-24T10:02:00.000Z',
          lifecycleDiagnostic: 'heartbeat_stale:180000',
          latestResult: {
            status: 'running',
            summary: 'Running summary',
          },
        },
        {
          subagentId: 'agent-failed',
          status: 'failed',
          runSeq: 2,
          updatedAt: '2026-04-24T10:01:00.000Z',
          lastError: 'Needs retry',
        },
      ],
    })
  );

  assert.match(html, /运行中/);
  assert.match(html, /需处理/);
  assert.match(html, /agent-running/);
  assert.match(html, /agent-failed/);
  assert.match(html, /heartbeat stale/);
  assert.match(html, /重试/);
  assert.match(html, /Needs retry/);
  assert.ok(html.indexOf('agent-running') < html.indexOf('agent-failed'));
  assert.ok(html.indexOf('agent-failed') < html.indexOf('agent-done'));
  assert.doesNotMatch(html, /分析<\/div>/);
  assert.doesNotMatch(html, /收尾/);
}

function testSubAgentPanelShowsForceStopDiagnosticsAndTerminalCleanup(): void {
  const html = renderNodeWithLocale(
    React.createElement(SubAgentPanel, {
      sessionId: 'sess-1',
      initialItems: [
        {
          subagentId: 'agent-running',
          status: 'running',
          runSeq: 3,
          updatedAt: '2026-04-24T10:02:00.000Z',
          lifecycleDiagnostic: 'heartbeat_stale:180000',
        },
        {
          subagentId: 'agent-done',
          status: 'succeeded',
          runSeq: 1,
          updatedAt: '2026-04-24T10:00:00.000Z',
          latestResult: {
            status: 'done',
            summary: 'Completed summary',
          },
        },
      ],
    }),
    'en-US'
  );

  assert.match(html, /Force Stop/);
  assert.match(html, /Clear finished items/);
  assert.match(html, /Heartbeat stale: diagnostic only/);
  assert.doesNotMatch(html, /Canceling/);
}

function testAutoLoopControlUsesTodoDrivenCopy(): void {
  const html = renderNode(
    React.createElement(AutoLoopControl, {
      sessionId: 'sess-1',
      disabled: false,
      sendMessage: () => true,
    })
  );

  assert.match(html, /Ralph 循环/);
  assert.match(html, /显示设置/);
  const englishHtml = renderNodeWithLocale(
    React.createElement(AutoLoopControl, {
      sessionId: 'sess-1',
      disabled: false,
      sendMessage: () => true,
    }),
    'en-US'
  );
  assert.match(englishHtml, /Ralph Loop/);
  assert.doesNotMatch(englishHtml, />Off</);
}

function testSidebarShowsPendingPlanInputMarker(): void {
  const html = renderNode(
    React.createElement(Sidebar, {
      sessions: [
        {
          id: 'sess-1',
          name: 'Pending Session',
          workspaceDir: 'D:/workspace',
        },
      ],
      currentSessionId: 'sess-1',
      onSelectSession: () => undefined,
      onNewSession: () => undefined,
      onOpenAutomations: () => undefined,
      onDeleteSession: () => undefined,
      onRenameSession: () => undefined,
      workspaceDir: 'D:/workspace',
      onChangeWorkspace: () => undefined,
      automationViewActive: false,
      isConnected: true,
      pendingPlanInputSessionIds: ['sess-1'],
      hasApiKey: true,
      onOpenSettings: () => undefined,
    })
  );

  assert.match(html, /sidebar-session-pending-sess-1/);
  assert.match(html, /data-testid="open-config"/);
}

function testPendingPlanInputBannerShowsSessionJumpAction(): void {
  const html = renderNode(
    React.createElement(PendingPlanInputBanner, {
      items: [
        {
          sessionId: 'sess-2',
          sessionName: 'Needs input',
          requestId: 'req-123',
        },
      ],
      onOpenSession: () => undefined,
    })
  );

  assert.match(html, /pending-plan-input-banner/);
  assert.match(html, /Needs input/);
  assert.match(html, /req-123/);
}

function runAll(): void {
  testTodoPanelShowsProtocolFields();
  testChatContainerDoesNotRenderTodoProtocolInMainChat();
  testRightToolbarShowsSubAgentsAndTodoList();
  testRightToolbarShowsTodoCleanupAfterStop();
  testRightToolbarHidesTodoCleanupWithoutStopEligibility();
  testRightToolbarClearsCompletedOnlyTodos();
  testRightToolbarClearsDismissedOnlyTodos();
  testRightToolbarHidesTodoAreaWhenNoOpenTodos();
testChatContainerLocksComposerAndLlmBarDuringCancelWindow();
testChatContainerKeepsDraftAndSettingsEditableDuringActiveWebRun();
testResponsiveShellClassesRemainAvailable();
  testThinkingDeltaPreservesEnglishSpacing();
  testTextDeltaPreservesEnglishSpacingAndCreatesLiveBubble();
  testMessageItemShowsAssistantModelName();
  testRuntimeEventRecoveryAcceptsMissingOrStoppedRunId();
  testRunStatusLiveEventIsCompactAndUpserted();
  testMessageItemShowsToolBlocksWithoutAssistantText();
  testMessageItemDisplayFiltersHideProcessBlocksOnly();
  testMessageItemRedactsLargeWriteFileArgs();
  testMessageItemRendersFinalizePlanAsPlanCard();
  testPlanInputCardRendersFinalizePlanPreview();
  testPlanInputCardRendersCustomAnswerChoice();
  testPlanInputCardPreservesSelectedOptionWithSupplementalText();
  testAutomationCenterRendersIntervalControls();
  testSubAgentPanelOnlyShowsSubagentControls();
  testSubAgentPanelRendersDashboardCardsWithoutPseudoPhase();
  testSubAgentPanelShowsForceStopDiagnosticsAndTerminalCleanup();
  testAutoLoopControlUsesTodoDrivenCopy();
  testSidebarShowsPendingPlanInputMarker();
  testPendingPlanInputBannerShowsSessionJumpAction();
  console.log('web-memory-organize-ui tests passed');
}

runAll();
