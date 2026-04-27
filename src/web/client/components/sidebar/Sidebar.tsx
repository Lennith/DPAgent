import React, { useEffect, useState } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { useI18n, type TranslationKey } from '../../i18n/index.js';

interface Session {
  id: string;
  name: string;
  workspaceDir?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onOpenAutomations: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  workspaceDir: string;
  onChangeWorkspace: () => void;
  automationViewActive?: boolean;
  isConnected: boolean;
  mcpState?: 'connected' | 'degraded' | 'idle' | 'disabled';
  mcpConnectedCount?: number;
  mcpTotalEnabled?: number;
  runningSessionIds?: string[];
  pendingPlanInputSessionIds?: string[];
  hasApiKey?: boolean;
  onOpenSettings?: () => void;
}

type LampStyle = {
  dotClassName: string;
  shadow: string;
  key: TranslationKey;
  params?: Record<string, string | number>;
};

function resolveWsLampStyle(isConnected: boolean): LampStyle {
  return {
    dotClassName: isConnected ? 'bg-green-500' : 'bg-red-500',
    shadow: isConnected ? '0 0 8px rgba(34, 197, 94, 0.5)' : '0 0 8px rgba(239, 68, 68, 0.5)',
    key: isConnected ? 'sidebar.ws.connected' : 'sidebar.ws.disconnected',
  };
}

function resolveMcpLampStyle(
  state: 'connected' | 'degraded' | 'idle' | 'disabled',
  connectedCount = 0,
  totalEnabled = 0
): LampStyle {
  if (state === 'connected') {
    const hasCount = totalEnabled > 0;
    return {
      dotClassName: 'bg-green-500',
      shadow: '0 0 8px rgba(34, 197, 94, 0.5)',
      key: hasCount ? 'sidebar.mcp.connectedWithCount' : 'sidebar.mcp.connected',
      params: hasCount ? { connected: connectedCount, total: totalEnabled } : undefined,
    };
  }
  if (state === 'degraded') {
    return {
      dotClassName: 'bg-red-500',
      shadow: '0 0 8px rgba(239, 68, 68, 0.5)',
      key: 'sidebar.mcp.degraded',
    };
  }
  return {
    dotClassName: 'bg-gray-500',
    shadow: '0 0 8px rgba(107, 114, 128, 0.45)',
    key: state === 'disabled' ? 'sidebar.mcp.disabled' : 'sidebar.mcp.idle',
  };
}

function EditIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6l-.1.1a2 2 0 0 1-3.4-1.42v-.08A1.7 1.7 0 0 0 9 17.9a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 13a1.7 1.7 0 0 0-.6-1l-.1-.1A2 2 0 0 1 5.32 8.5h.08A1.7 1.7 0 0 0 6.1 7a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 11 2.6a1.7 1.7 0 0 0 1-.6l.1-.1a2 2 0 0 1 3.4 1.42v.08A1.7 1.7 0 0 0 17 4.1a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.38.42.7.72.98l.1.1a2 2 0 0 1-1.42 3.4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
    </svg>
  );
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      {collapsed ? <path d="m9 6 6 6-6 6" /> : <path d="m15 6-6 6 6 6" />}
      <path d="M4 4v16" />
    </svg>
  );
}

export function Sidebar({
  sessions,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onOpenAutomations,
  onDeleteSession,
  onRenameSession,
  workspaceDir,
  onChangeWorkspace,
  automationViewActive = false,
  isConnected,
  mcpState = 'idle',
  mcpConnectedCount = 0,
  mcpTotalEnabled = 0,
  runningSessionIds = [],
  pendingPlanInputSessionIds = [],
  hasApiKey = false,
  onOpenSettings,
}: SidebarProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isAutoRail, setIsAutoRail] = useState(false);
  const effectiveCollapsed = isCollapsed || isAutoRail;
  const runningSet = new Set(runningSessionIds);
  const pendingPlanInputSet = new Set(pendingPlanInputSessionIds);
  const wsLampStyle = resolveWsLampStyle(isConnected);
  const mcpLampStyle = resolveMcpLampStyle(mcpState, mcpConnectedCount, mcpTotalEnabled);

  const startRename = (session: Session) => {
    setEditingId(session.id);
    setEditingName(session.name);
  };

  const saveRename = (id: string) => {
    if (editingName.trim()) {
      onRenameSession(id, editingName.trim());
    }
    setEditingId(null);
    setEditingName('');
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditingName('');
  };

  const handleSelectSession = (sessionId: string) => {
    onSelectSession(sessionId);
    setMobileSessionsOpen(false);
  };

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1279px), (max-aspect-ratio: 11/10)');
    const update = (): void => setIsAutoRail(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return (
    <div
      className={`app-sidebar flex h-full flex-col overflow-hidden rounded-[1.65rem] border transition-[width] duration-200 ${
        effectiveCollapsed ? 'w-[var(--sidebar-rail-width)]' : 'w-[var(--sidebar-expanded-width)]'
      }`}
      data-collapsed={effectiveCollapsed ? 'true' : 'false'}
      data-auto-rail={isAutoRail ? 'true' : 'false'}
      style={{
        background: theme.colors.bg.gradient,
        borderColor: theme.colors.border.DEFAULT,
        boxShadow: theme.shadows.md,
      }}
    >
      <div
        className={`relative flex h-[var(--app-chrome-header-height)] shrink-0 flex-col justify-center border-b ${
          effectiveCollapsed ? 'px-3' : 'px-4'
        }`}
        data-testid="sidebar-brand-header"
        style={{ borderColor: theme.colors.border.DEFAULT }}
      >
        <div className={`flex items-center gap-2 ${effectiveCollapsed ? 'justify-center' : ''}`}>
          <h1
            className={`sidebar-brand-title ${effectiveCollapsed ? 'text-xl' : 'text-2xl'} font-black tracking-tight`}
            style={{
              color: theme.colors.primary.DEFAULT,
              textShadow: `0 12px 28px ${theme.colors.primary.DEFAULT}2e`,
            }}
          >
            {effectiveCollapsed ? 'DP' : 'DPAgent'}
          </h1>
        </div>

        {!isAutoRail && <button
          type="button"
          onClick={() => setIsCollapsed((value) => !value)}
          className="absolute right-3 top-3 rounded-full border p-1.5 transition-all hover:-translate-y-0.5"
          style={{
            borderColor: theme.colors.border.DEFAULT,
            backgroundColor: theme.colors.bg.tertiary,
            color: theme.colors.text.secondary,
          }}
          title={isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-label={isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        >
          <CollapseIcon collapsed={effectiveCollapsed} />
        </button>}

        <div
          className={`flex gap-1 text-xs ${
            effectiveCollapsed
              ? 'absolute bottom-3 left-3 flex-col items-center'
              : 'mt-2 max-w-[calc(100%-48px)] flex-col'
          }`}
          data-testid="sidebar-status-lamps"
        >
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${wsLampStyle.dotClassName}`} style={{ boxShadow: wsLampStyle.shadow }} />
            {!effectiveCollapsed && <span className="truncate" style={{ color: theme.colors.text.muted }}>{t(wsLampStyle.key, wsLampStyle.params)}</span>}
          </div>
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${mcpLampStyle.dotClassName}`} style={{ boxShadow: mcpLampStyle.shadow }} />
            {!effectiveCollapsed && <span className="truncate" style={{ color: theme.colors.text.muted }}>{t(mcpLampStyle.key, mcpLampStyle.params)}</span>}
          </div>
        </div>
        <button
          data-testid="open-config"
          type="button"
          onClick={onOpenSettings}
          className={`absolute rounded-full border transition-all hover:-translate-y-0.5 ${
            effectiveCollapsed ? 'bottom-2 right-2 p-1.5' : 'bottom-3 right-3 p-2'
          }`}
          style={{
            borderColor: hasApiKey ? '#22c55e' : '#ef4444',
            backgroundColor: hasApiKey ? 'rgba(34, 197, 94, 0.14)' : 'rgba(239, 68, 68, 0.14)',
            color: hasApiKey ? '#22c55e' : '#ef4444',
          }}
          title={t('app.settings.buttonTitle')}
          aria-label={t('app.settings.buttonTitle')}
        >
          <SettingsIcon />
        </button>
      </div>

      <div className={effectiveCollapsed ? 'p-2' : 'p-3'}>
        <div className="space-y-2">
          <button
            data-testid="sidebar-new-chat"
            onClick={onNewSession}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold"
            style={{
              background: theme.colors.primary.gradient,
              color: theme.colors.text.inverse,
              boxShadow: theme.shadows.md,
            }}
          >
            <span>+</span>
            {!effectiveCollapsed && t('sidebar.newChat')}
          </button>
          <button
            data-testid="sidebar-open-automations"
            onClick={onOpenAutomations}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border text-sm font-semibold"
            style={{
              borderColor: automationViewActive ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
              backgroundColor: automationViewActive
                ? 'rgba(249, 115, 22, 0.15)'
                : theme.colors.bg.tertiary,
              color: automationViewActive ? theme.colors.primary.DEFAULT : theme.colors.text.secondary,
            }}
          >
            {effectiveCollapsed ? 'A' : t('sidebar.automations')}
          </button>
        </div>
      </div>

      <div className="flex flex-col md:min-h-0 md:flex-1">
        <div className={`flex items-center justify-between py-2 ${effectiveCollapsed ? 'px-2' : 'px-4'}`}>
          <div className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
            {effectiveCollapsed ? sessions.length : t('sidebar.sessions', { count: sessions.length })}
          </div>
          <button
            type="button"
            onClick={() => setMobileSessionsOpen((prev) => !prev)}
            className="rounded-lg px-2 py-1 text-xs md:hidden"
            style={{
              backgroundColor: theme.colors.bg.tertiary,
              color: theme.colors.text.secondary,
            }}
          >
            {mobileSessionsOpen ? t('sidebar.sessionsToggle.hide') : t('sidebar.sessionsToggle.show')}
          </button>
        </div>

        <div className={`${mobileSessionsOpen ? 'block max-h-[38vh]' : 'hidden'} overflow-y-auto ${effectiveCollapsed ? 'px-2' : 'px-3'} pb-2 space-y-1 md:block md:max-h-none md:flex-1`}>
          {sessions.map((session) => {
            const isRunning = runningSet.has(session.id);
            const hasPendingPlanInput = pendingPlanInputSet.has(session.id);
            return (
              <div
                key={session.id}
                className={`group flex items-center rounded-xl border ${
                  currentSessionId === session.id ? 'border-orange-500/30 bg-orange-500/20' : 'border-transparent hover:bg-white/5'
                }`}
              >
                {editingId === session.id ? (
                  <div className="flex flex-1 items-center gap-2 px-3 py-2">
                    <input
                      type="text"
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveRename(session.id);
                        if (event.key === 'Escape') cancelRename();
                      }}
                      onBlur={() => saveRename(session.id)}
                      className="flex-1 bg-transparent text-sm outline-none"
                      style={{ color: theme.colors.text.primary }}
                      autoFocus
                    />
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => handleSelectSession(session.id)}
                      className={`flex min-w-0 flex-1 flex-col text-left text-sm ${effectiveCollapsed ? 'items-center px-2 py-3' : 'px-3 py-2'}`}
                      style={{ color: theme.colors.text.secondary }}
                      title={session.name}
                    >
                      <div className={`flex min-w-0 items-center gap-2 ${effectiveCollapsed ? 'justify-center' : ''}`}>
                        <span
                          className="h-2 w-2 flex-shrink-0 rounded-full"
                          style={{
                            backgroundColor: currentSessionId === session.id ? theme.colors.primary.DEFAULT : theme.colors.text.muted,
                          }}
                        />
                        {isRunning && (
                          <span
                            className="inline-block h-2 w-2 flex-shrink-0 animate-pulse rounded-full"
                            style={{ backgroundColor: '#22c55e' }}
                            title={t('sidebar.running')}
                          />
                        )}
                        {hasPendingPlanInput && !effectiveCollapsed && (
                          <span
                            data-testid={`sidebar-session-pending-${session.id}`}
                            className="inline-flex flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                            style={{
                              color: theme.colors.primary.DEFAULT,
                              backgroundColor: `${theme.colors.primary.DEFAULT}1f`,
                            }}
                            title={t('sidebar.pendingPlanInput')}
                          >
                            {t('sidebar.pendingPlanInput')}
                          </span>
                        )}
                        {!effectiveCollapsed && <span className="flex-1 truncate font-medium">{session.name}</span>}
                      </div>
                      {session.workspaceDir && !effectiveCollapsed && (
                        <span className="ml-4 mt-0.5 truncate text-xs" style={{ color: theme.colors.text.muted }}>
                          {session.workspaceDir}
                        </span>
                      )}
                    </button>

                    {!effectiveCollapsed && <div className="flex items-center gap-0.5 pr-1 md:hidden">
                      <button
                        onClick={() => startRename(session)}
                        className="rounded-lg p-1.5"
                        style={{ color: theme.colors.primary.DEFAULT }}
                        title={t('sidebar.rename')}
                        aria-label={t('sidebar.rename')}
                      >
                        <EditIcon />
                      </button>
                      <button
                        onClick={() => onDeleteSession(session.id)}
                        className="rounded-lg p-1.5"
                        style={{ color: '#f43f5e' }}
                        title={t('sidebar.delete')}
                        aria-label={t('sidebar.delete')}
                      >
                        <DeleteIcon />
                      </button>
                    </div>}
                    {!effectiveCollapsed && <div className="hidden items-center gap-0.5 pr-1 opacity-0 group-hover:opacity-100 md:flex">
                      <button
                        onClick={() => startRename(session)}
                        className="rounded-lg p-1.5"
                        style={{ color: theme.colors.primary.DEFAULT }}
                        title={t('sidebar.rename')}
                        aria-label={t('sidebar.rename')}
                      >
                        <EditIcon />
                      </button>
                      <button
                        onClick={() => onDeleteSession(session.id)}
                        className="rounded-lg p-1.5"
                        style={{ color: '#f43f5e' }}
                        title={t('sidebar.delete')}
                        aria-label={t('sidebar.delete')}
                      >
                        <DeleteIcon />
                      </button>
                    </div>}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className={`border-t ${effectiveCollapsed ? 'p-2' : 'p-4'}`} style={{ borderColor: theme.colors.border.DEFAULT }}>
        {!effectiveCollapsed && <label className="mb-1 block text-xs uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
          {t('sidebar.workspace')}
        </label>}
        <button
          data-testid="sidebar-workspace-button"
          type="button"
          onClick={onChangeWorkspace}
          className={`w-full truncate rounded-xl px-3 py-2 text-xs ${effectiveCollapsed ? 'text-center' : 'text-left'}`}
          style={{
            backgroundColor: theme.colors.bg.tertiary,
            color: theme.colors.text.secondary,
          }}
          title={t('app.workspace.selectTitle')}
        >
          {effectiveCollapsed ? 'W' : workspaceDir}
        </button>
      </div>
    </div>
  );
}
