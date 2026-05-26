import { useCallback, useEffect, useMemo, useState } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { MemoryOrganizeControl } from '../chat/MemoryOrganizeControl.js';
import { GovernanceAuditList } from '../subagent/GovernanceAuditList.js';
import type {
  GovernanceAuditItem,
  WorkspaceGovernanceMemoryItem,
  WorkspaceGovernanceSkillItem,
  WorkspaceSkillGovernanceReport,
} from '../../app-shell-types.js';

interface WorkspaceGovernanceState {
  workspaceDir: string;
  memoryItems: WorkspaceGovernanceMemoryItem[];
  skillItems: WorkspaceGovernanceSkillItem[];
  auditItems: GovernanceAuditItem[];
  latestSkillGovernanceReport: WorkspaceSkillGovernanceReport | null;
}

interface WorkspaceGovernanceSettingsProps {
  sessionId: string | null;
  memoryPendingCount: number;
  memoryOrganizeLoading: boolean;
  memoryOrganizeError: string | null;
  onOrganizeMemory: () => Promise<void> | void;
}

const emptyState: WorkspaceGovernanceState = {
  workspaceDir: '',
  memoryItems: [],
  skillItems: [],
  auditItems: [],
  latestSkillGovernanceReport: null,
};

function summarizeReport(report: WorkspaceSkillGovernanceReport | null): string {
  if (!report) {
    return 'No workspace skill governance run yet.';
  }
  return [
    `scanned ${report.summary.scannedSkills}`,
    `archived ${report.summary.autoArchived}`,
    `conflicts ${report.summary.conflicts}`,
    report.fallback ? `fallback ${report.fallbackReason ?? 'yes'}` : 'reviewed',
  ].join(' · ');
}

function formatUpdatedAt(value: string | undefined): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function WorkspaceGovernanceSettings({
  sessionId,
  memoryPendingCount,
  memoryOrganizeLoading,
  memoryOrganizeError,
  onOrganizeMemory,
}: WorkspaceGovernanceSettingsProps) {
  const theme = useThemeConfig();
  const [state, setState] = useState<WorkspaceGovernanceState>(emptyState);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>('');
  const [selectedSkillName, setSelectedSkillName] = useState<string>('');
  const [memoryDrafts, setMemoryDrafts] = useState<Record<string, { title: string; content: string }>>({});
  const [skillDrafts, setSkillDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      const response = await fetch(`/api/governance/workspace${query}`);
      const payload = (await response.json().catch(() => ({}))) as Partial<WorkspaceGovernanceState> & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || `status=${response.status}`);
      }
      const nextState: WorkspaceGovernanceState = {
        workspaceDir: payload.workspaceDir ?? '',
        memoryItems: Array.isArray(payload.memoryItems) ? payload.memoryItems : [],
        skillItems: Array.isArray(payload.skillItems) ? payload.skillItems : [],
        auditItems: Array.isArray(payload.auditItems) ? payload.auditItems : [],
        latestSkillGovernanceReport: payload.latestSkillGovernanceReport ?? null,
      };
      setState(nextState);
      setMemoryDrafts(
        Object.fromEntries(
          nextState.memoryItems.map((item) => [item.id, { title: item.title, content: item.content }])
        )
      );
      setSkillDrafts(Object.fromEntries(nextState.skillItems.map((item) => [item.name, item.content])));
      setSelectedMemoryId((current) =>
        nextState.memoryItems.some((item) => item.id === current) ? current : nextState.memoryItems[0]?.id ?? ''
      );
      setSelectedSkillName((current) =>
        nextState.skillItems.some((item) => item.name === current) ? current : nextState.skillItems[0]?.name ?? ''
      );
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const selectedMemory = useMemo(
    () => state.memoryItems.find((item) => item.id === selectedMemoryId) ?? null,
    [selectedMemoryId, state.memoryItems]
  );
  const selectedSkill = useMemo(
    () => state.skillItems.find((item) => item.name === selectedSkillName) ?? null,
    [selectedSkillName, state.skillItems]
  );

  const inputClassName = 'w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2';
  const textareaClassName = 'w-full rounded-xl border px-3 py-2 text-sm font-mono outline-none focus:ring-2';
  const buttonClassName = 'rounded-xl border px-3 py-2 text-xs font-medium disabled:opacity-50';
  const primaryButtonClassName = 'rounded-xl px-3 py-2 text-xs font-medium disabled:opacity-50';

  const runAction = useCallback(
    async (actionId: string, action: () => Promise<void>) => {
      setBusyAction(actionId);
      setError(null);
      try {
        await action();
        await loadState();
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : String(actionError));
      } finally {
        setBusyAction(null);
      }
    },
    [loadState]
  );

  const saveMemory = useCallback(async () => {
    if (!selectedMemory) {
      return;
    }
    const draft = memoryDrafts[selectedMemory.id];
    await runAction(`memory:${selectedMemory.id}`, async () => {
      const response = await fetch(`/api/memory/${encodeURIComponent(selectedMemory.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId ?? undefined,
          title: draft?.title ?? selectedMemory.title,
          content: draft?.content ?? selectedMemory.content,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `status=${response.status}`);
      }
    });
  }, [memoryDrafts, runAction, selectedMemory, sessionId]);

  const saveSkill = useCallback(async () => {
    if (!selectedSkill) {
      return;
    }
    await runAction(`skill:${selectedSkill.name}`, async () => {
      const response = await fetch(`/api/skills/workspace/${encodeURIComponent(selectedSkill.name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId ?? undefined,
          content: skillDrafts[selectedSkill.name] ?? selectedSkill.content,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `status=${response.status}`);
      }
    });
  }, [runAction, selectedSkill, sessionId, skillDrafts]);

  const runSkillGovernance = useCallback(async () => {
    await runAction('skill-governance', async () => {
      const response = await fetch('/api/governance/skills/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId ?? undefined }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `status=${response.status}`);
      }
    });
  }, [runAction, sessionId]);

  return (
    <div className="space-y-4">
      <div
        className="rounded-2xl border p-4"
        style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: theme.colors.text.primary }}>
              Workspace governance
            </div>
            <div className="mt-1 break-all text-xs" style={{ color: theme.colors.text.muted }}>
              {state.workspaceDir || 'Loading workspace...'}
            </div>
            <div className="mt-2 text-xs" style={{ color: theme.colors.text.secondary }}>
              {summarizeReport(state.latestSkillGovernanceReport)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void loadState()}
              disabled={loading || Boolean(busyAction)}
              className={buttonClassName}
              style={{
                borderColor: theme.colors.border.DEFAULT,
                color: theme.colors.text.primary,
                backgroundColor: theme.colors.bg.primary,
              }}
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void runSkillGovernance()}
              disabled={loading || Boolean(busyAction)}
              className={primaryButtonClassName}
              style={{
                color: '#111827',
                backgroundColor: theme.colors.primary.DEFAULT,
              }}
            >
              {busyAction === 'skill-governance' ? 'Running...' : 'Run skill governance'}
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-3 rounded-xl border px-3 py-2 text-xs" style={{ borderColor: '#ef4444', color: '#ef4444' }}>
            {error}
          </div>
        )}
      </div>

      <MemoryOrganizeControl
        sessionId={sessionId}
        pendingCount={memoryPendingCount}
        isLoading={memoryOrganizeLoading}
        error={memoryOrganizeError}
        onOrganize={() => {
          void Promise.resolve(onOrganizeMemory()).then(() => loadState());
        }}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section
          className="rounded-2xl border p-4"
          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold" style={{ color: theme.colors.text.primary }}>
                Memory
              </div>
              <div className="text-xs" style={{ color: theme.colors.text.muted }}>
                {state.memoryItems.length} entries
              </div>
            </div>
            <button
              type="button"
              onClick={() => void saveMemory()}
              disabled={!selectedMemory || Boolean(busyAction)}
              className={buttonClassName}
              style={{
                borderColor: theme.colors.border.DEFAULT,
                color: theme.colors.text.primary,
                backgroundColor: theme.colors.bg.primary,
              }}
            >
              {busyAction?.startsWith('memory:') ? 'Saving...' : 'Save memory'}
            </button>
          </div>
          <select
            value={selectedMemoryId}
            onChange={(event) => setSelectedMemoryId(event.target.value)}
            className={inputClassName}
            style={{
              backgroundColor: theme.colors.bg.tertiary,
              borderColor: theme.colors.border.DEFAULT,
              color: theme.colors.text.primary,
            }}
          >
            {state.memoryItems.length === 0 ? (
              <option value="">No memory entries</option>
            ) : (
              state.memoryItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.scope} · v{item.version}
                </option>
              ))
            )}
          </select>
          {selectedMemory && (
            <div className="mt-3 space-y-2">
              <input
                value={memoryDrafts[selectedMemory.id]?.title ?? selectedMemory.title}
                onChange={(event) =>
                  setMemoryDrafts((current) => ({
                    ...current,
                    [selectedMemory.id]: {
                      title: event.target.value,
                      content: current[selectedMemory.id]?.content ?? selectedMemory.content,
                    },
                  }))
                }
                className={inputClassName}
                style={{
                  backgroundColor: theme.colors.bg.tertiary,
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.primary,
                }}
              />
              <textarea
                value={memoryDrafts[selectedMemory.id]?.content ?? selectedMemory.content}
                onChange={(event) =>
                  setMemoryDrafts((current) => ({
                    ...current,
                    [selectedMemory.id]: {
                      title: current[selectedMemory.id]?.title ?? selectedMemory.title,
                      content: event.target.value,
                    },
                  }))
                }
                rows={8}
                className={textareaClassName}
                style={{
                  backgroundColor: theme.colors.bg.tertiary,
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.primary,
                }}
              />
              <div className="text-[11px]" style={{ color: theme.colors.text.muted }}>
                {selectedMemory.status} · {formatUpdatedAt(selectedMemory.updatedAt)}
              </div>
            </div>
          )}
        </section>

        <section
          className="rounded-2xl border p-4"
          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold" style={{ color: theme.colors.text.primary }}>
                Workspace skills
              </div>
              <div className="text-xs" style={{ color: theme.colors.text.muted }}>
                {state.skillItems.length} editable workspace skills
              </div>
            </div>
            <button
              type="button"
              onClick={() => void saveSkill()}
              disabled={!selectedSkill || Boolean(busyAction)}
              className={buttonClassName}
              style={{
                borderColor: theme.colors.border.DEFAULT,
                color: theme.colors.text.primary,
                backgroundColor: theme.colors.bg.primary,
              }}
            >
              {busyAction?.startsWith('skill:') ? 'Saving...' : 'Save skill'}
            </button>
          </div>
          <select
            value={selectedSkillName}
            onChange={(event) => setSelectedSkillName(event.target.value)}
            className={inputClassName}
            style={{
              backgroundColor: theme.colors.bg.tertiary,
              borderColor: theme.colors.border.DEFAULT,
              color: theme.colors.text.primary,
            }}
          >
            {state.skillItems.length === 0 ? (
              <option value="">No workspace skills</option>
            ) : (
              state.skillItems.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}{item.isAutoGenerated ? ' · generated' : ''}
                </option>
              ))
            )}
          </select>
          {selectedSkill && (
            <div className="mt-3 space-y-2">
              <textarea
                value={skillDrafts[selectedSkill.name] ?? selectedSkill.content}
                onChange={(event) =>
                  setSkillDrafts((current) => ({
                    ...current,
                    [selectedSkill.name]: event.target.value,
                  }))
                }
                rows={12}
                className={textareaClassName}
                style={{
                  backgroundColor: theme.colors.bg.tertiary,
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.primary,
                }}
              />
              <div className="break-all text-[11px]" style={{ color: theme.colors.text.muted }}>
                {selectedSkill.path}
              </div>
            </div>
          )}
        </section>
      </div>


      <div
        className="rounded-2xl border overflow-hidden"
        style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
      >
        <GovernanceAuditList items={state.auditItems} />
      </div>
    </div>
  );
}
