import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatContainer } from './components/chat/ChatContainer';
import { PendingPlanInputBanner } from './components/chat/PendingPlanInputBanner.js';
import { ConfigModal } from './components/ConfigModal';
import { RightToolbar } from './components/toolbar/RightToolbar.js';
import { WorkspaceGovernanceSettings } from './components/settings/WorkspaceGovernanceSettings.js';
import { LocalFilePickerModal } from './components/common/LocalFilePickerModal.js';
import AutomationCenter from './components/automation/AutomationCenter.js';
import { useThemeConfig } from './components/providers/ThemeProvider.js';
import { COMPOSER_DRAFT_KEY } from './composer-input-state.js';
import { resolveMcpIndicatorState } from './mcp-status.js';
import { useI18n } from './i18n/index.js';
import { FALLBACK_WORKSPACE_DIR, normalizeWorkspaceDir } from './workspace-preferences.js';
import {
  collectRecentWorkspaceDirsFromSessions,
} from './workspace-modal-utils.js';
import LoginPage from './components/LoginPage.js';
import { useAppWorkspaceState } from './hooks/useAppWorkspaceState.js';
import { useAppSessionController } from './hooks/useAppSessionController.js';
import { useAppGovernanceState } from './hooks/useAppGovernanceState.js';
import { useRemoteAuthBootstrap } from './hooks/useRemoteAuthBootstrap.js';
import { appendShareToken, getShareTokenFromLocation } from './shared-access.js';
import { copyShareUrlToClipboard } from './share-copy-feedback.js';
import {
  createSessionShare,
  fetchSessionShareStatus,
  revokeSessionShare,
} from './session-rest-api.js';

const NARROW_TOOLBAR_MEDIA = '(max-width: 1279px), (max-aspect-ratio: 11/10)';

function isNarrowToolbarLayout(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.matchMedia(NARROW_TOOLBAR_MEDIA).matches;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface AppErrorBoundaryLabels {
  title: string;
  fallbackMessage: string;
  reload: string;
  goHome: string;
}

interface AppErrorBoundaryProps {
  labels: AppErrorBoundaryLabels;
}

function ToolbarExpandIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

class AppErrorBoundary extends React.Component<React.PropsWithChildren<AppErrorBoundaryProps>, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren<AppErrorBoundaryProps>) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('App initialization error:', error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center" style={{ backgroundColor: '#1a1a2e' }}>
          <div
            className="text-center p-8 rounded-2xl border max-w-md"
            style={{ backgroundColor: '#16213e', borderColor: '#e94560' }}
          >
            <div className="text-4xl mb-4">!</div>
            <h1 className="text-xl font-bold mb-2" style={{ color: '#e94560' }}>
              {this.props.labels.title}
            </h1>
            <p className="text-sm mb-4" style={{ color: '#a0a0a0' }}>
              {this.state.error?.message || this.props.labels.fallbackMessage}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all hover:scale-105"
                style={{ backgroundColor: '#e94560', color: '#ffffff' }}
              >
                {this.props.labels.reload}
              </button>
              <button
                type="button"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.href = '/';
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all border"
                style={{ borderColor: '#4a4a6a', color: '#a0a0a0', backgroundColor: 'transparent' }}
              >
                {this.props.labels.goHome}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function buildWsUrl(shareToken: string | null = null): string {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return appendShareToken(`${wsProtocol}//${window.location.host}/ws`, shareToken);
}

export default function App() {
  const { t } = useI18n();
  const shareToken = getShareTokenFromLocation();
  const auth = useRemoteAuthBootstrap();
  if (shareToken) {
    return (
      <AppErrorBoundary
        labels={{
          title: t('app.initFailed.title'),
          fallbackMessage: t('app.initFailed.fallbackMessage'),
          reload: t('app.initFailed.reload'),
          goHome: t('app.initFailed.goHome'),
        }}
      >
        <AuthenticatedApp shareToken={shareToken} />
      </AppErrorBoundary>
    );
  }

  if (!auth.checked) {
    return null;
  }

  if (auth.required && !auth.authenticated) {
    return <LoginPage onLoginSuccess={auth.markAuthenticated} />;
  }

  return (
    <AppErrorBoundary
      labels={{
        title: t('app.initFailed.title'),
        fallbackMessage: t('app.initFailed.fallbackMessage'),
        reload: t('app.initFailed.reload'),
        goHome: t('app.initFailed.goHome'),
      }}
    >
      <AuthenticatedApp shareToken={null} />
    </AppErrorBoundary>
  );
}

function AuthenticatedApp({ shareToken }: { shareToken: string | null }) {
  const { t } = useI18n();
  const isSharedMode = Boolean(shareToken);
  const websocketLabels = useMemo(
    () => ({
      reconnecting: (attempt: number, max: number) =>
        t('app.websocket.reconnecting', { attempt, max }),
      connectionRestored: t('app.websocket.connectionRestored'),
      connectionFailedMax: (max: number) => t('app.websocket.connectionFailedMax', { max }),
    }),
    [t]
  );
  const { isConnected, send, connect, subscribe, toasts, addToast, dismissToast } = useWebSocket(
    buildWsUrl(shareToken),
    { labels: websocketLabels }
  );
  const theme = useThemeConfig();
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'chat' | 'automations'>('chat');
  const [showSubAgentPanel, setShowSubAgentPanel] = useState(() => {
    return !isNarrowToolbarLayout();
  });
  const [workspaceBrowserOpen, setWorkspaceBrowserOpen] = useState(false);
  const [shareStatusBySession, setShareStatusBySession] = useState<Record<string, { active: boolean; expiresAt?: string }>>({});
  const [shareModalUrl, setShareModalUrl] = useState<string | null>(null);
  const [shareInvalidated, setShareInvalidated] = useState(false);
  const [shareBootstrapChecked, setShareBootstrapChecked] = useState(!shareToken);
  const hasConnectedOnceRef = useRef(false);
  const needsReconnectHydrationRef = useRef(false);

  const workspaceState = useAppWorkspaceState();
  const refreshSessionsRef = useRef<() => Promise<void>>(async () => undefined);
  const governanceRefreshRef = useRef<(sessionId: string | null) => void | Promise<void>>(() => undefined);

  const handleGovernanceRefresh = useCallback(
    (sessionId: string | null) => governanceRefreshRef.current(sessionId),
    []
  );
  const translate = useCallback(
    (key: string, vars?: Record<string, string | number>) => t(key as never, vars),
    [t]
  );

  const sessionController = useAppSessionController({
    currentSessionId,
    setCurrentSessionId,
    setActiveView,
    workspaceDir: workspaceState.workspaceDir,
    defaultWorkspaceDir: workspaceState.defaultWorkspaceDir,
    setWorkspaceDir: workspaceState.setWorkspaceDir,
    llmProfiles: workspaceState.llmProfiles,
    send,
    connect,
    subscribe,
    addToast,
    t: translate,
    onRefreshGovernance: handleGovernanceRefresh,
  });

  const governanceState = useAppGovernanceState({
    currentSessionId,
    refreshSessions: () => refreshSessionsRef.current(),
  });

  refreshSessionsRef.current = sessionController.fetchSessions;
  governanceRefreshRef.current = governanceState.fetchGovernanceState;

  const mcpIndicatorState = useMemo(
    () => resolveMcpIndicatorState(sessionController.mcpStatus),
    [sessionController.mcpStatus]
  );
  const hiddenPendingPlanInputSessions = useMemo(
    () =>
      sessionController.pendingPlanInputSessions.filter(
        (item) => activeView !== 'chat' || item.sessionId !== currentSessionId
      ),
    [activeView, currentSessionId, sessionController.pendingPlanInputSessions]
  );
  const recentWorkspaceDirs = useMemo(
    () => collectRecentWorkspaceDirsFromSessions(sessionController.sessions, 3),
    [sessionController.sessions]
  );

  const handleNewSession = useCallback(() => {
    setActiveView('chat');
    setCurrentSessionId(null);
    sessionController.clearComposerInputForSession(COMPOSER_DRAFT_KEY);
    governanceState.resetGovernanceState();
    workspaceState.setWorkspaceDir(normalizeWorkspaceDir(workspaceState.defaultWorkspaceDir) ?? FALLBACK_WORKSPACE_DIR);
    workspaceState.setSaveAsDefaultWorkspace(false);
    workspaceState.setShowWorkspaceModal(true);
  }, [
    governanceState.resetGovernanceState,
    sessionController.clearComposerInputForSession,
    workspaceState.defaultWorkspaceDir,
    workspaceState.setSaveAsDefaultWorkspace,
    workspaceState.setShowWorkspaceModal,
    workspaceState.setWorkspaceDir,
  ]);

  const handleOpenAutomations = useCallback(() => {
    setActiveView('automations');
  }, []);

  useEffect(() => {
    if (!shareToken) {
      return;
    }
    let canceled = false;
    let expiryTimer: number | undefined;
    void fetch(`/api/share/${encodeURIComponent(shareToken)}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('share_invalid');
        }
        return (await response.json()) as { sessionId?: string; expiresAt?: string };
      })
      .then((payload) => {
        if (canceled) {
          return;
        }
        const sessionId = String(payload.sessionId ?? '').trim();
        if (!sessionId) {
          throw new Error('share_invalid');
        }
        setCurrentSessionId(sessionId);
        setShareBootstrapChecked(true);
        void sessionController.fetchSessions();
        void sessionController.loadSessionMessages(sessionId);
        const expiresAtMs = Date.parse(String(payload.expiresAt ?? ''));
        if (Number.isFinite(expiresAtMs)) {
          expiryTimer = window.setTimeout(
            () => setShareInvalidated(true),
            Math.max(0, expiresAtMs - Date.now())
          );
        }
      })
      .catch(() => {
        if (!canceled) {
          setShareInvalidated(true);
          setShareBootstrapChecked(true);
        }
      });
    return () => {
      canceled = true;
      if (expiryTimer !== undefined) {
        window.clearTimeout(expiryTimer);
      }
    };
  }, [sessionController.fetchSessions, sessionController.loadSessionMessages, shareToken]);

  useEffect(() => {
    if (isSharedMode || !currentSessionId) {
      return;
    }
    let canceled = false;
    void fetchSessionShareStatus(currentSessionId)
      .then((status) => {
        if (!canceled) {
          setShareStatusBySession((prev) => ({
            ...prev,
            [currentSessionId]: status,
          }));
        }
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [currentSessionId, isSharedMode]);

  useEffect(() => {
    if (!isSharedMode) {
      return undefined;
    }
    return subscribe('share_invalidated', () => {
      setShareInvalidated(true);
      addToast({
        type: 'error',
        message: 'Shared session access has expired.',
        autoDismiss: false,
      });
    });
  }, [addToast, isSharedMode, subscribe]);

  const handleToggleShare = useCallback(async () => {
    if (!currentSessionId || isSharedMode) {
      return;
    }
    const current = shareStatusBySession[currentSessionId];
    try {
      if (current?.active) {
        await revokeSessionShare(currentSessionId);
        setShareStatusBySession((prev) => ({
          ...prev,
          [currentSessionId]: { active: false },
        }));
        return;
      }
      const created = await createSessionShare(currentSessionId);
      setShareStatusBySession((prev) => ({
        ...prev,
        [currentSessionId]: created.share,
      }));
      setShareModalUrl(created.url);
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        autoDismiss: true,
      });
    }
  }, [addToast, currentSessionId, isSharedMode, shareStatusBySession]);

  const handleResyncCurrentSession = useCallback(async () => {
    if (!currentSessionId) {
      return;
    }
    try {
      await sessionController.fetchSessions();
      await sessionController.loadSessionMessages(currentSessionId);
      addToast({
        type: 'success',
        message: t('app.session.syncSucceeded'),
        autoDismiss: true,
      });
    } catch (error) {
      addToast({
        type: 'error',
        message: t('app.session.syncFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
        autoDismiss: true,
      });
    }
  }, [addToast, currentSessionId, sessionController, t]);

  const handleChatPanelClick = useCallback(() => {
    if (!isSharedMode && showSubAgentPanel && isNarrowToolbarLayout()) {
      setShowSubAgentPanel(false);
    }
  }, [isSharedMode, showSubAgentPanel]);

  useEffect(() => {
    const query = window.matchMedia(NARROW_TOOLBAR_MEDIA);
    const syncToolbarForLayout = (): void => {
      setShowSubAgentPanel(!query.matches);
    };
    syncToolbarForLayout();
    query.addEventListener('change', syncToolbarForLayout);
    return () => query.removeEventListener('change', syncToolbarForLayout);
  }, []);

  useEffect(() => {
    if (isConnected) {
      if (needsReconnectHydrationRef.current) {
        needsReconnectHydrationRef.current = false;
        void sessionController.fetchSessions();
        if (currentSessionId) {
          void sessionController.loadSessionMessages(currentSessionId);
        }
      }
      hasConnectedOnceRef.current = true;
      return;
    }
    if (hasConnectedOnceRef.current) {
      needsReconnectHydrationRef.current = true;
    }
  }, [currentSessionId, isConnected, sessionController.fetchSessions, sessionController.loadSessionMessages]);

  const handleConfirmWorkspace = useCallback(() => {
    workspaceState.confirmWorkspaceSelection();
    setCurrentSessionId(null);
    sessionController.clearComposerInputForSession(COMPOSER_DRAFT_KEY);
    governanceState.resetGovernanceState();
  }, [
    governanceState.resetGovernanceState,
    sessionController.clearComposerInputForSession,
    workspaceState.confirmWorkspaceSelection,
  ]);

  const handleWorkspaceBrowse = useCallback(() => {
    setWorkspaceBrowserOpen(true);
  }, []);

  if (isSharedMode && (!shareBootstrapChecked || shareInvalidated)) {
    return (
      <div className="flex h-screen items-center justify-center" style={{ background: theme.colors.bg.gradient }}>
        <div
          className="rounded-2xl border px-6 py-5 text-center"
          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
        >
          <h1 className="mb-2 text-lg font-semibold" style={{ color: theme.colors.text.primary }}>
            {shareInvalidated ? '控制已失效' : 'Loading shared session'}
          </h1>
          <p className="text-sm" style={{ color: theme.colors.text.secondary }}>
            {shareInvalidated ? 'This shared link has been revoked or expired.' : 'Connecting to the shared session.'}
          </p>
        </div>
      </div>
    );
  }

  const currentShareStatus = currentSessionId ? shareStatusBySession[currentSessionId] : undefined;

  return (
    <div className="app-shell flex h-screen" style={{ background: theme.colors.bg.gradient }}>
      {!isSharedMode && (
        <Sidebar
          sessions={sessionController.sessions}
          currentSessionId={currentSessionId}
          onSelectSession={sessionController.handleSelectSession}
          onNewSession={handleNewSession}
          onOpenAutomations={handleOpenAutomations}
          onDeleteSession={sessionController.handleDeleteSession}
          onRenameSession={sessionController.handleRenameSession}
          workspaceDir={workspaceState.workspaceDir}
          onChangeWorkspace={workspaceState.openWorkspaceModal}
          automationViewActive={activeView === 'automations'}
          isConnected={isConnected}
          mcpState={mcpIndicatorState}
          mcpConnectedCount={sessionController.mcpStatus?.summary.connectedCount}
          mcpTotalEnabled={sessionController.mcpStatus?.summary.totalEnabled}
          runningSessionIds={sessionController.runningSessionIds}
          pendingPlanInputSessionIds={sessionController.pendingPlanInputSessionIds}
          hasApiKey={workspaceState.hasApiKey}
          onOpenSettings={() => workspaceState.setShowConfigModal(true)}
        />
      )}

        <div className="app-main flex-1 flex flex-col min-w-0 relative">
          {!isSharedMode && <PendingPlanInputBanner
            items={hiddenPendingPlanInputSessions}
            onOpenSession={(sessionId) => {
              void sessionController.handleSelectSession(sessionId);
            }}
          />}
          {activeView === 'automations' ? (
            <AutomationCenter
              workspaceDir={workspaceState.workspaceDir}
              llmProfiles={workspaceState.llmProfiles}
              onOpenSession={(sessionId) => {
                void sessionController.handleOpenAutomationSession(sessionId);
              }}
            />
          ) : (
            <>
              <div className="app-content-frame flex-1 min-h-0 flex overflow-hidden">
                <div
                  className="chat-panel-shell min-w-0 min-h-0 flex flex-1 flex-col rounded-[1.65rem] border"
                  onClick={handleChatPanelClick}
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    backgroundColor: theme.colors.bg.secondary,
                    boxShadow: theme.shadows.lg,
                  }}
                >
                  <ChatContainer
                    messages={sessionController.currentMessages}
                    liveEvents={sessionController.currentRuntime.liveEvents}
                    pendingPlanInput={sessionController.currentRuntime.pendingPlanInput}
                    pendingPlanInputError={sessionController.currentRuntime.pendingPlanInputError}
                    onSubmitPlanInput={sessionController.handleSubmitPlanInput}
                    runningInputQueue={sessionController.currentRuntime.runningInputQueue}
                    onInsertRunningInput={sessionController.handleInsertRunningInput}
                    onEditRunningInput={sessionController.handleEditRunningInput}
                    onCancelRunningInput={sessionController.handleCancelRunningInput}
                    input={sessionController.activeComposerInput}
                    setInput={sessionController.setActiveComposerInput}
                    onSend={sessionController.handleSend}
                    planningState={sessionController.currentPlanningState}
                    planModeIntent={sessionController.currentPlanModeIntent}
                    onPlanModeIntentChange={sessionController.setCurrentPlanModeIntent}
                    onPlanningStateChange={sessionController.setCurrentPlanningState}
                    onExitPlanDraft={sessionController.handleExitCurrentPlanDraft}
                    onExitPlanExecution={sessionController.handleExitCurrentPlanExecution}
                    onCancel={sessionController.handleCancelCurrentRun}
                    isRunning={sessionController.currentRuntime.isRunning}
                    isCanceling={sessionController.currentCanceling}
                    isHydrating={sessionController.currentRuntime.hydrating}
                    canCancel={Boolean(sessionController.currentRuntime.runId) && sessionController.currentRuntime.interactionState.mode !== 'observe_only'}
                    isInteractionLocked={sessionController.currentInteractionLocked}
                    interactionState={sessionController.currentRuntime.interactionState}
                    runningInputAckId={sessionController.currentRunningInputAckId}
                    runningInputEditRestore={sessionController.currentRunningInputEditRestore}
                    error={sessionController.currentRuntime.error}
                    interruptedArtifact={sessionController.currentRuntime.interruptedArtifact}
                    sessionId={currentSessionId}
                    llmProfiles={workspaceState.llmProfiles}
                    llmSelection={sessionController.currentLlmSelection}
                    currentLlmRuntime={sessionController.currentRuntime.currentLlmRuntime}
                    onChangeLlmSelection={sessionController.setCurrentSessionLlmSelection}
                    contextUtilization={
                      currentSessionId
                        ? sessionController.contextUtilization[currentSessionId] ?? null
                        : null
                    }
                    compressionStatus={sessionController.currentRuntime.compressionStatus}
                    currentStep={sessionController.currentRuntime.currentStep}
                    maxSteps={sessionController.currentRuntime.maxSteps}
                    shareActive={Boolean(currentShareStatus?.active)}
                    shareDisabled={isSharedMode || !currentSessionId}
                    onToggleShare={isSharedMode ? undefined : handleToggleShare}
                    onResyncSession={currentSessionId ? handleResyncCurrentSession : undefined}
                    websocketConnected={isConnected}
                    sendWebSocket={send}
                    subscribeWebSocket={subscribe}
                    showAutoLoopControl={!isSharedMode}
                  />
                </div>

                {!isSharedMode && showSubAgentPanel && (
                  <div
                    className="right-toolbar-shell min-w-0 flex flex-col overflow-hidden rounded-[1.65rem] border"
                    style={{
                      borderColor: theme.colors.border.DEFAULT,
                      background: theme.colors.bg.gradient,
                      boxShadow: theme.shadows.lg,
                      backdropFilter: 'blur(18px)',
                    }}
                  >
                    <RightToolbar
                      sessionId={currentSessionId}
                      todoItems={governanceState.todoItems}
                      onResumeTodo={
                        sessionController.currentRuntime.interactionState?.mode === 'observe_only'
                          ? undefined
                          : governanceState.handleResumeTodo
                      }
                      onDismissTodo={
                        sessionController.currentRuntime.interactionState?.mode === 'observe_only'
                          ? undefined
                          : governanceState.handleDismissTodo
                      }
                      onHide={() => setShowSubAgentPanel(false)}
                    />
                  </div>
                )}
              </div>

              {!isSharedMode && !showSubAgentPanel && (
                <div className="toolbar-reopen-button">
                  <button
                    type="button"
                    onClick={() => setShowSubAgentPanel(true)}
                    className="toolbar-reopen-tab"
                    style={{
                      borderColor: theme.colors.border.DEFAULT,
                      color: theme.colors.text.secondary,
                      backgroundColor: theme.colors.bg.secondary,
                      boxShadow: theme.shadows.md,
                    }}
                    title={t('app.subagent.showPanel')}
                    aria-label={t('app.subagent.showPanel')}
                    data-testid="toolbar-expand-tab"
                  >
                    <ToolbarExpandIcon />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="px-3 py-2 rounded-lg border shadow-md flex items-start justify-between gap-2"
              style={{
                borderColor:
                  toast.type === 'error'
                    ? theme.colors.toolResult.error.border
                    : toast.type === 'warning'
                      ? theme.colors.toolCall.border
                      : theme.colors.border.DEFAULT,
                backgroundColor:
                  toast.type === 'error'
                    ? theme.colors.toolResult.error.bg
                    : toast.type === 'warning'
                      ? theme.colors.toolCall.bg
                      : theme.colors.bg.secondary,
                color: theme.colors.text.primary,
              }}
            >
              <span className="text-xs leading-relaxed">{toast.message}</span>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                className="text-xs opacity-80 hover:opacity-100"
                style={{ color: theme.colors.text.muted }}
              >
                x
              </button>
            </div>
          ))}
        </div>

        {!isSharedMode && <ConfigModal
          isOpen={workspaceState.showConfigModal}
          onClose={() => workspaceState.setShowConfigModal(false)}
          llmProfiles={workspaceState.llmProfiles}
          onSaved={async () => {
            await workspaceState.refreshConfig();
            await sessionController.fetchSessions();
          }}
          governanceSlot={
            <WorkspaceGovernanceSettings
              sessionId={currentSessionId}
              memoryPendingCount={governanceState.memoryPendingCount}
              memoryOrganizeLoading={governanceState.memoryOrganizeLoading}
              memoryOrganizeError={governanceState.memoryOrganizeError}
              onOrganizeMemory={governanceState.handleOrganizeMemory}
            />
          }
        />}

        {!isSharedMode && workspaceState.showWorkspaceModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div
              className="w-[420px] max-w-[92%] rounded-2xl border p-6 shadow-2xl"
              style={{
                backgroundColor: theme.colors.bg.secondary,
                borderColor: theme.colors.border.DEFAULT,
              }}
            >
              <h3 className="mb-4 text-lg font-bold" style={{ color: theme.colors.text.primary }}>
                {t('app.workspace.selectTitle')}
              </h3>
              <div className="mb-4">
                <label className="mb-2 block text-sm" style={{ color: theme.colors.text.secondary }}>
                  {t('app.workspace.directoryLabel')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    data-testid="workspace-dir-input"
                    type="text"
                    value={workspaceState.workspaceDir}
                    onChange={(event) => workspaceState.setWorkspaceDir(event.target.value)}
                    placeholder="./workspace"
                    className="w-full rounded-xl border px-4 py-2 focus:outline-none"
                    style={{
                      backgroundColor: theme.colors.bg.tertiary,
                      borderColor: theme.colors.border.DEFAULT,
                      color: theme.colors.text.primary,
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleWorkspaceBrowse}
                    className="shrink-0 rounded-xl border px-3 py-2 text-sm transition-colors"
                    style={{
                      borderColor: theme.colors.border.DEFAULT,
                      backgroundColor: theme.colors.bg.tertiary,
                      color: theme.colors.text.secondary,
                    }}
                    data-testid="workspace-dir-browse"
                  >
                    {t('app.workspace.browseButton')}
                  </button>
                </div>
                <p className="mt-2 text-xs" style={{ color: theme.colors.text.muted }}>
                  {t('app.workspace.directoryHint')}
                </p>
                <div className="mt-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: theme.colors.text.muted }}>
                    {t('app.workspace.recentTitle')}
                  </p>
                  {recentWorkspaceDirs.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {recentWorkspaceDirs.map((workspaceDir) => (
                        <button
                          key={workspaceDir}
                          type="button"
                          onClick={() => workspaceState.setWorkspaceDir(workspaceDir)}
                          className="max-w-full truncate rounded-full border px-3 py-1 text-xs transition-colors"
                          style={{
                            borderColor: theme.colors.border.DEFAULT,
                            backgroundColor: theme.colors.bg.tertiary,
                            color: theme.colors.text.secondary,
                          }}
                          title={workspaceDir}
                          data-testid="workspace-recent-item"
                        >
                          {workspaceDir}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs" style={{ color: theme.colors.text.muted }}>
                      {t('app.workspace.recentEmpty')}
                    </p>
                  )}
                </div>
                <label
                  htmlFor="workspace-default-toggle"
                  className="mt-3 flex cursor-pointer items-center gap-2 text-sm"
                  style={{ color: theme.colors.text.secondary }}
                >
                  <input
                    id="workspace-default-toggle"
                    data-testid="workspace-default-toggle"
                    type="checkbox"
                    checked={workspaceState.saveAsDefaultWorkspace}
                    onChange={(event) => workspaceState.setSaveAsDefaultWorkspace(event.target.checked)}
                  />
                  <span>{t('app.workspace.setAsDefault')}</span>
                </label>
                <p className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
                  {t('app.workspace.defaultHint')}
                </p>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  data-testid="workspace-cancel"
                  onClick={() => {
                    workspaceState.setShowWorkspaceModal(false);
                    workspaceState.setSaveAsDefaultWorkspace(false);
                  }}
                  className="rounded-xl px-4 py-2 transition-colors"
                  style={{
                    backgroundColor: theme.colors.bg.tertiary,
                    color: theme.colors.text.primary,
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  data-testid="workspace-confirm"
                  onClick={handleConfirmWorkspace}
                  className="rounded-xl px-4 py-2 text-white transition-colors"
                  style={{ background: theme.colors.primary.gradient }}
                >
                  {t('common.confirm')}
                </button>
              </div>
            </div>
          </div>
        )}

        {!isSharedMode && <LocalFilePickerModal
          isOpen={workspaceBrowserOpen}
          mode="directory"
          title={t('app.workspace.selectTitle')}
          confirmLabel={t('app.workspace.useSelected')}
          initialPath={workspaceState.workspaceDir}
          onClose={() => setWorkspaceBrowserOpen(false)}
          onConfirm={(paths) => {
            const nextPath = paths[0];
            if (nextPath) {
              workspaceState.setWorkspaceDir(nextPath);
              addToast({
                type: 'success',
                message: t('app.workspace.browseResolved'),
                autoDismiss: true,
              });
            }
            setWorkspaceBrowserOpen(false);
          }}
        />}

        {shareModalUrl && (
          <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50">
            <div
              className="w-[520px] max-w-[92%] rounded-2xl border p-5 shadow-2xl"
              style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
            >
              <h3 className="mb-3 text-lg font-semibold" style={{ color: theme.colors.text.primary }}>
                {t('app.share.modalTitle')}
              </h3>
              <input
                readOnly
                value={shareModalUrl}
                className="mb-4 w-full rounded-xl border px-3 py-2 text-sm"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  backgroundColor: theme.colors.bg.tertiary,
                  color: theme.colors.text.primary,
                }}
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShareModalUrl(null)}
                  className="rounded-xl border px-4 py-2 text-sm"
                  style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
                >
                  {t('common.close')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void copyShareUrlToClipboard({
                      url: shareModalUrl,
                      clipboard: navigator.clipboard,
                      addToast,
                      t,
                    });
                  }}
                  className="rounded-xl px-4 py-2 text-sm font-semibold text-white"
                  style={{ background: theme.colors.primary.gradient }}
                >
                  {t('app.share.copy')}
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
