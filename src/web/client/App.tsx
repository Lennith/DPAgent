import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatContainer } from './components/chat/ChatContainer';
import { PendingPlanInputBanner } from './components/chat/PendingPlanInputBanner.js';
import { MemoryOrganizeControl } from './components/chat/MemoryOrganizeControl.js';
import { ConfigModal } from './components/ConfigModal';
import { RightToolbar } from './components/toolbar/RightToolbar.js';
import { GovernanceAuditList } from './components/subagent/GovernanceAuditList.js';
import AutomationCenter from './components/automation/AutomationCenter.js';
import { useThemeConfig } from './components/providers/ThemeProvider.js';
import { COMPOSER_DRAFT_KEY } from './composer-input-state.js';
import { resolveMcpIndicatorState } from './mcp-status.js';
import { useI18n } from './i18n/index.js';
import { FALLBACK_WORKSPACE_DIR, normalizeWorkspaceDir } from './workspace-preferences.js';
import { useAppWorkspaceState } from './hooks/useAppWorkspaceState.js';
import { useAppSessionController } from './hooks/useAppSessionController.js';
import { useAppGovernanceState } from './hooks/useAppGovernanceState.js';

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

const WS_URL = (() => {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${window.location.host}/ws`;
})();

export default function App() {
  const { t } = useI18n();
  const { isConnected, send, connect, subscribe, toasts, addToast, dismissToast } = useWebSocket(WS_URL);
  const theme = useThemeConfig();
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'chat' | 'automations'>('chat');
  const [showSubAgentPanel, setShowSubAgentPanel] = useState(true);
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
    const query = window.matchMedia('(max-width: 1279px), (max-aspect-ratio: 11/10)');
    const collapseToolbarForNarrowLayout = (): void => {
      if (query.matches) {
        setShowSubAgentPanel(false);
      }
    };
    collapseToolbarForNarrowLayout();
    query.addEventListener('change', collapseToolbarForNarrowLayout);
    return () => query.removeEventListener('change', collapseToolbarForNarrowLayout);
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

  return (
    <AppErrorBoundary
      labels={{
        title: t('app.initFailed.title'),
        fallbackMessage: t('app.initFailed.fallbackMessage'),
        reload: t('app.initFailed.reload'),
        goHome: t('app.initFailed.goHome'),
      }}
    >
      <div className="app-shell flex h-screen" style={{ background: theme.colors.bg.gradient }}>
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

        <div className="app-main flex-1 flex flex-col min-w-0 relative">
          <PendingPlanInputBanner
            items={hiddenPendingPlanInputSessions}
            onOpenSession={(sessionId) => {
              void sessionController.handleSelectSession(sessionId);
            }}
          />
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
                    input={sessionController.activeComposerInput}
                    setInput={sessionController.setActiveComposerInput}
                    onSend={sessionController.handleSend}
                    onCancel={sessionController.handleCancelCurrentRun}
                    onResumeInterruptedRun={sessionController.handleResumeInterruptedRun}
                    onDismissInterruptedArtifact={sessionController.handleDismissInterruptedArtifact}
                    isRunning={sessionController.currentRuntime.isRunning}
                    isCanceling={sessionController.currentCanceling}
                    canCancel={Boolean(sessionController.currentRuntime.runId)}
                    isInteractionLocked={sessionController.currentInteractionLocked}
                    error={sessionController.currentRuntime.error}
                    interruptedArtifact={sessionController.currentRuntime.interruptedArtifact}
                    sessionId={currentSessionId}
                    llmProfiles={workspaceState.llmProfiles}
                    llmSelection={sessionController.currentLlmSelection}
                    onChangeLlmSelection={sessionController.setCurrentSessionLlmSelection}
                    contextUtilization={
                      currentSessionId
                        ? sessionController.contextUtilization[currentSessionId] ?? null
                        : null
                    }
                    compressionStatus={sessionController.currentRuntime.compressionStatus}
                    currentStep={sessionController.currentRuntime.currentStep}
                    maxSteps={sessionController.currentRuntime.maxSteps}
                  />
                </div>

                {showSubAgentPanel && (
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
                      onHide={() => setShowSubAgentPanel(false)}
                    />
                  </div>
                )}
              </div>

              {!showSubAgentPanel && (
                <div className="toolbar-reopen-button absolute top-3 right-3 z-20">
                  <button
                    type="button"
                    onClick={() => setShowSubAgentPanel(true)}
                    className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
                    style={{
                      borderColor: theme.colors.border.DEFAULT,
                      color: theme.colors.text.secondary,
                      backgroundColor: theme.colors.bg.secondary,
                      boxShadow: theme.shadows.md,
                    }}
                  >
                    {t('app.subagent.showPanel')}
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

        <ConfigModal
          isOpen={workspaceState.showConfigModal}
          onClose={() => workspaceState.setShowConfigModal(false)}
          llmProfiles={workspaceState.llmProfiles}
          onSaved={async () => {
            await workspaceState.refreshConfig();
            await sessionController.fetchSessions();
          }}
          governanceSlot={
            <div className="space-y-4">
              <MemoryOrganizeControl
                sessionId={currentSessionId}
                pendingCount={governanceState.memoryPendingCount}
                isLoading={governanceState.memoryOrganizeLoading}
                error={governanceState.memoryOrganizeError}
                onOrganize={governanceState.handleOrganizeMemory}
              />
              <div
                className="rounded-2xl border overflow-hidden"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  backgroundColor: theme.colors.bg.secondary,
                }}
              >
                <GovernanceAuditList items={governanceState.auditItems} />
              </div>
            </div>
          }
        />

        {workspaceState.showWorkspaceModal && (
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
                <p className="mt-2 text-xs" style={{ color: theme.colors.text.muted }}>
                  {t('app.workspace.directoryHint')}
                </p>
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
      </div>
    </AppErrorBoundary>
  );
}
