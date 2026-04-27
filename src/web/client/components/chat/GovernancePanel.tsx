import React, { useEffect, useMemo, useState } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';

interface ToolsetView {
  name: string;
  description: string;
}

interface ToolsetPresetView {
  scope: 'team' | 'workspace';
  toolsetName: string;
  workspaceDir?: string;
  updatedAt: string;
}

interface PendingSkillItem {
  id: string;
  name: string;
  description: string;
  action: 'create' | 'update';
  target: 'workspace' | 'global';
  baseVersion?: string;
  nextVersion?: string;
  createdAt: string;
}

interface SkillPackItem {
  name: string;
  slug: string;
  scope: 'team' | 'workspace';
  workspaceDir?: string;
  description?: string;
  activeVersion?: string;
  updatedAt: string;
  versions: Array<{
    version: string;
    skillCount: number;
    createdAt: string;
  }>;
}

interface GovernanceAuditItem {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  status: 'info' | 'success' | 'warning';
  createdAt: string;
  metadata?: Record<string, unknown>;
}

interface GovernancePanelProps {
  sessionId: string | null;
  toolsets: ToolsetView[];
  activeToolset: string | null;
  activeToolsetSource: string | null;
  teamPreset: ToolsetPresetView | null;
  workspacePreset: ToolsetPresetView | null;
  skillCount: number;
  memoryCount: number;
  pendingSkills: PendingSkillItem[];
  memoryBacklogCount: number;
  todoItems: Array<{
    id: string;
    title: string;
    details?: string;
    status: 'pending' | 'in_progress' | 'blocked' | 'completed';
    priority: 'low' | 'medium' | 'high';
    createdAt: string;
    updatedAt: string;
  }>;
  skillPacks: SkillPackItem[];
  auditItems: GovernanceAuditItem[];
  memoryTriggerStatus: string;
  skillUpdateStatus: string;
  onChangeToolset: (toolsetName: string) => void;
  onSetToolsetPreset: (scope: 'team' | 'workspace', toolsetName: string) => void;
  onClearToolsetPreset: (scope: 'team' | 'workspace') => void;
  onApproveSkill: (id: string) => void;
  onRejectSkill: (id: string) => void;
  onAddTodo: (title: string) => void;
  onSetTodoStatus: (id: string, status: 'pending' | 'in_progress' | 'blocked' | 'completed') => void;
  onDeleteTodo: (id: string) => void;
  onPublishSkillPack: (payload: { name: string; version: string; scope: 'team' | 'workspace' }) => void;
  onActivateSkillPack: (name: string, scope: 'team' | 'workspace', version: string) => void;
  onRollbackSkillPack: (name: string, scope: 'team' | 'workspace') => void;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
}

function formatWhen(value: string): string {
  return new Date(value).toLocaleString();
}

export function GovernancePanel({
  sessionId,
  toolsets,
  activeToolset,
  activeToolsetSource,
  teamPreset,
  workspacePreset,
  skillCount,
  memoryCount,
  pendingSkills,
  memoryBacklogCount,
  todoItems,
  skillPacks,
  auditItems,
  memoryTriggerStatus,
  skillUpdateStatus,
  onChangeToolset,
  onSetToolsetPreset,
  onClearToolsetPreset,
  onApproveSkill,
  onRejectSkill,
  onAddTodo,
  onSetTodoStatus,
  onDeleteTodo,
  onPublishSkillPack,
  onActivateSkillPack,
  onRollbackSkillPack,
}: GovernancePanelProps) {
  const theme = useThemeConfig();
  const [todoDraft, setTodoDraft] = useState('');
  const [presetDraftToolset, setPresetDraftToolset] = useState(activeToolset ?? '');
  const [packName, setPackName] = useState('shared-governance-pack');
  const [packVersion, setPackVersion] = useState('1');
  const [packScope, setPackScope] = useState<'team' | 'workspace'>('workspace');
  const [packVersionSelection, setPackVersionSelection] = useState<Record<string, string>>({});

  useEffect(() => {
    if (activeToolset) {
      setPresetDraftToolset(activeToolset);
    }
  }, [activeToolset]);

  const activeTodoCount = useMemo(
    () => todoItems.filter((item) => item.status !== 'completed').length,
    [todoItems]
  );
  const focusRingClassName =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2';
  const inputControlClassName = `rounded-xl px-3 py-2 text-sm border outline-none ${focusRingClassName}`;
  const compactControlClassName = `rounded-lg px-2 py-1 text-xs border outline-none ${focusRingClassName}`;
  const outlinedButtonClassName = `px-3 py-2 rounded-xl text-xs font-medium border ${focusRingClassName}`;
  const primaryButtonClassName = `px-3 py-2 rounded-xl text-xs font-medium ${focusRingClassName}`;
  const compactOutlinedButtonClassName = `px-3 py-1.5 rounded-lg text-xs font-medium border ${focusRingClassName}`;
  const compactPrimaryButtonClassName = `px-3 py-1.5 rounded-lg text-xs font-medium ${focusRingClassName}`;
  const todoDeleteButtonClassName = `px-2 py-1 rounded-lg text-xs font-medium border ${focusRingClassName}`;
  const sessionOverrideId = `governance-session-override-${sessionId}`;
  const presetTargetId = `governance-preset-target-${sessionId}`;

  if (!sessionId) {
    return null;
  }

  return (
    <div
      className="border-t px-4 py-3 space-y-4"
      style={{
        backgroundColor: theme.colors.bg.secondary,
        borderColor: theme.colors.border.DEFAULT,
      }}
    >
      <div className="grid gap-3 md:grid-cols-4">
        <div
          className="rounded-2xl border px-3 py-3"
          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.primary }}
        >
          <div className="text-[11px] uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
            Active Toolset
          </div>
          <div className="text-sm font-medium mt-1" style={{ color: theme.colors.text.primary }}>
            {activeToolset ?? 'n/a'}
          </div>
          <div className="text-[11px] mt-1" style={{ color: theme.colors.text.secondary }}>
            source: {activeToolsetSource ?? 'default'}
          </div>
        </div>
        <div
          className="rounded-2xl border px-3 py-3"
          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.primary }}
        >
          <div className="text-[11px] uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
            Memory Trigger
          </div>
          <div className="text-sm font-medium mt-1" style={{ color: theme.colors.text.primary }}>
            {memoryTriggerStatus}
          </div>
          <div className="text-[11px] mt-1" style={{ color: theme.colors.text.secondary }}>
            durable memory: {memoryCount}
          </div>
        </div>
        <div
          className="rounded-2xl border px-3 py-3"
          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.primary }}
        >
          <div className="text-[11px] uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
            Skill Update Trigger
          </div>
          <div className="text-sm font-medium mt-1" style={{ color: theme.colors.text.primary }}>
            {skillUpdateStatus}
          </div>
          <div className="text-[11px] mt-1" style={{ color: theme.colors.text.secondary }}>
            approved skills: {skillCount}
          </div>
        </div>
        <div
          className="rounded-2xl border px-3 py-3"
          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.primary }}
        >
          <div className="text-[11px] uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
            Queue
          </div>
          <div className="text-sm font-medium mt-1" style={{ color: theme.colors.text.primary }}>
            todo {activeTodoCount} / skill {pendingSkills.length} / backlog {memoryBacklogCount}
          </div>
          <div className="text-[11px] mt-1" style={{ color: theme.colors.text.secondary }}>
            packs: {skillPacks.length}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border px-3 py-3 space-y-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
        <div className="flex flex-wrap items-end gap-3 justify-between">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label
                htmlFor={sessionOverrideId}
                className="block text-[11px] uppercase tracking-wider mb-1"
                style={{ color: theme.colors.text.muted }}
              >
                Session Override
              </label>
              <select
                id={sessionOverrideId}
                value={activeToolset ?? ''}
                onChange={(event) => onChangeToolset(event.target.value)}
                className={inputControlClassName}
                style={{
                  backgroundColor: theme.colors.bg.tertiary,
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.primary,
                }}
              >
                {toolsets.map((toolset) => (
                  <option key={toolset.name} value={toolset.name}>
                    {toolset.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor={presetTargetId}
                className="block text-[11px] uppercase tracking-wider mb-1"
                style={{ color: theme.colors.text.muted }}
              >
                Preset Target
              </label>
              <select
                id={presetTargetId}
                value={presetDraftToolset}
                onChange={(event) => setPresetDraftToolset(event.target.value)}
                className={inputControlClassName}
                style={{
                  backgroundColor: theme.colors.bg.tertiary,
                  borderColor: theme.colors.border.DEFAULT,
                  color: theme.colors.text.primary,
                }}
              >
                {toolsets.map((toolset) => (
                  <option key={`preset-${toolset.name}`} value={toolset.name}>
                    {toolset.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onSetToolsetPreset('team', presetDraftToolset)}
              className={primaryButtonClassName}
              style={{ backgroundColor: theme.colors.primary.DEFAULT, color: theme.colors.text.inverse }}
            >
              Set Team Preset
            </button>
            <button
              type="button"
              onClick={() => onSetToolsetPreset('workspace', presetDraftToolset)}
              className={outlinedButtonClassName}
              style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
            >
              Set Workspace Preset
            </button>
            <button
              type="button"
              onClick={() => onClearToolsetPreset('team')}
              className={outlinedButtonClassName}
              style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
            >
              Clear Team
            </button>
            <button
              type="button"
              onClick={() => onClearToolsetPreset('workspace')}
              className={outlinedButtonClassName}
              style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
            >
              Clear Workspace
            </button>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded-xl px-3 py-2" style={{ backgroundColor: theme.colors.bg.primary }}>
            <div className="text-[11px] uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
              Team Preset
            </div>
            <div className="text-sm mt-1" style={{ color: theme.colors.text.primary }}>
              {teamPreset ? `${teamPreset.toolsetName} • ${formatWhen(teamPreset.updatedAt)}` : 'not set'}
            </div>
          </div>
          <div className="rounded-xl px-3 py-2" style={{ backgroundColor: theme.colors.bg.primary }}>
            <div className="text-[11px] uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
              Workspace Preset
            </div>
            <div className="text-sm mt-1" style={{ color: theme.colors.text.primary }}>
              {workspacePreset ? `${workspacePreset.toolsetName} • ${formatWhen(workspacePreset.updatedAt)}` : 'not set'}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
          Todo
        </div>
        <div className="flex gap-2">
          <input
            aria-label="Add persistent task"
            value={todoDraft}
            onChange={(event) => setTodoDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && todoDraft.trim()) {
                onAddTodo(todoDraft.trim());
                setTodoDraft('');
              }
            }}
            placeholder="Add a persistent task"
            className={`flex-1 ${inputControlClassName}`}
            style={{
              backgroundColor: theme.colors.bg.tertiary,
              borderColor: theme.colors.border.DEFAULT,
              color: theme.colors.text.primary,
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (!todoDraft.trim()) {
                return;
              }
              onAddTodo(todoDraft.trim());
              setTodoDraft('');
            }}
            className={`px-3 py-2 rounded-xl text-sm font-medium ${focusRingClassName}`}
            style={{ backgroundColor: theme.colors.primary.DEFAULT, color: theme.colors.text.inverse }}
          >
            Add
          </button>
        </div>
        {todoItems.length > 0 && (
          <div className="space-y-2">
            {todoItems.slice(0, 6).map((item) => (
              <div
                key={item.id}
                className="rounded-2xl border px-3 py-3 flex items-start gap-3"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  backgroundColor: theme.colors.bg.primary,
                }}
              >
                <select
                  aria-label={`Todo status for ${item.title}`}
                  value={item.status}
                  onChange={(event) =>
                    onSetTodoStatus(
                      item.id,
                      event.target.value as 'pending' | 'in_progress' | 'blocked' | 'completed'
                    )
                  }
                  className={compactControlClassName}
                  style={{
                    backgroundColor: theme.colors.bg.tertiary,
                    borderColor: theme.colors.border.DEFAULT,
                    color: theme.colors.text.primary,
                  }}
                >
                  <option value="pending">pending</option>
                  <option value="in_progress">in progress</option>
                  <option value="blocked">blocked</option>
                  <option value="completed">completed</option>
                </select>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium" style={{ color: theme.colors.text.primary }}>
                    {item.title}
                  </div>
                  {item.details && (
                    <div className="text-xs mt-1" style={{ color: theme.colors.text.secondary }}>
                      {truncate(item.details, 180)}
                    </div>
                  )}
                  <div className="text-[11px] mt-1" style={{ color: theme.colors.text.muted }}>
                    {item.priority} • {formatWhen(item.updatedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onDeleteTodo(item.id)}
                  className={todoDeleteButtonClassName}
                  style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {memoryBacklogCount > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
              Memory Organize Backlog
            </div>
            <div
              className="rounded-2xl border px-3 py-3 text-xs"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.primary,
                color: theme.colors.text.secondary,
              }}
            >
              {memoryBacklogCount === 1
                ? '1 committed turn is waiting for the next memory organize pass.'
                : `${memoryBacklogCount} committed turns are waiting for the next memory organize pass.`}
            </div>
          </div>
        )}

        {pendingSkills.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
              Pending Skill Drafts
            </div>
            {pendingSkills.map((item) => (
              <div
                key={item.id}
                className="rounded-2xl border px-3 py-3"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  backgroundColor: theme.colors.bg.primary,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium" style={{ color: theme.colors.text.primary }}>
                    {item.name}{' '}
                    <span className="text-xs opacity-60">
                      [{item.action}] [{item.target}]
                    </span>
                  </div>
                  <div className="text-[11px]" style={{ color: theme.colors.text.muted }}>
                    {formatWhen(item.createdAt)}
                  </div>
                </div>
                <div className="text-xs mt-2" style={{ color: theme.colors.text.secondary }}>
                  {truncate(item.description, 220)}
                </div>
                {(item.baseVersion || item.nextVersion) && (
                  <div className="text-[11px] mt-2" style={{ color: theme.colors.text.muted }}>
                    {`version ${item.baseVersion ?? 'new'} -> ${item.nextVersion ?? 'pending'}`}
                  </div>
                )}
                <div className="flex gap-2 mt-3">
                  <button
                    type="button"
                    onClick={() => onApproveSkill(item.id)}
                    className={compactPrimaryButtonClassName}
                    style={{ backgroundColor: theme.colors.primary.DEFAULT, color: theme.colors.text.inverse }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => onRejectSkill(item.id)}
                    className={compactOutlinedButtonClassName}
                    style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border px-3 py-3 space-y-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
        <div className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
          Skill Packs
        </div>
        <div className="grid gap-2 md:grid-cols-[1.5fr_0.8fr_0.9fr_auto]">
          <input
            aria-label="Skill pack name"
            value={packName}
            onChange={(event) => setPackName(event.target.value)}
            placeholder="pack name"
            className={inputControlClassName}
            style={{
              backgroundColor: theme.colors.bg.tertiary,
              borderColor: theme.colors.border.DEFAULT,
              color: theme.colors.text.primary,
            }}
          />
          <input
            aria-label="Skill pack version"
            value={packVersion}
            onChange={(event) => setPackVersion(event.target.value)}
            placeholder="version"
            className={inputControlClassName}
            style={{
              backgroundColor: theme.colors.bg.tertiary,
              borderColor: theme.colors.border.DEFAULT,
              color: theme.colors.text.primary,
            }}
          />
          <select
            aria-label="Skill pack scope"
            value={packScope}
            onChange={(event) => setPackScope(event.target.value as 'team' | 'workspace')}
            className={inputControlClassName}
            style={{
              backgroundColor: theme.colors.bg.tertiary,
              borderColor: theme.colors.border.DEFAULT,
              color: theme.colors.text.primary,
            }}
          >
            <option value="workspace">workspace</option>
            <option value="team">team</option>
          </select>
          <button
            type="button"
            onClick={() => {
              if (!packName.trim() || !packVersion.trim()) {
                return;
              }
              onPublishSkillPack({
                name: packName.trim(),
                version: packVersion.trim(),
                scope: packScope,
              });
            }}
            className={primaryButtonClassName}
            style={{ backgroundColor: theme.colors.primary.DEFAULT, color: theme.colors.text.inverse }}
          >
            Publish
          </button>
        </div>
        {skillPacks.length > 0 && (
          <div className="space-y-2">
            {skillPacks.map((pack) => {
              const selection = packVersionSelection[pack.slug] ?? pack.activeVersion ?? pack.versions[0]?.version ?? '';
              return (
                <div
                  key={`${pack.scope}:${pack.slug}`}
                  className="rounded-2xl border px-3 py-3"
                  style={{
                    borderColor: theme.colors.border.DEFAULT,
                    backgroundColor: theme.colors.bg.primary,
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium" style={{ color: theme.colors.text.primary }}>
                        {pack.name} <span className="text-xs opacity-60">[{pack.scope}]</span>
                      </div>
                      <div className="text-[11px] mt-1" style={{ color: theme.colors.text.secondary }}>
                        active {pack.activeVersion ?? 'n/a'} • updated {formatWhen(pack.updatedAt)}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 items-center">
                      <select
                        aria-label={`Active version for ${pack.name}`}
                        value={selection}
                        onChange={(event) =>
                          setPackVersionSelection((prev) => ({
                            ...prev,
                            [pack.slug]: event.target.value,
                          }))
                        }
                        className={compactControlClassName}
                        style={{
                          backgroundColor: theme.colors.bg.tertiary,
                          borderColor: theme.colors.border.DEFAULT,
                          color: theme.colors.text.primary,
                        }}
                      >
                        {pack.versions.map((version) => (
                          <option key={`${pack.slug}:${version.version}`} value={version.version}>
                            {version.version} ({version.skillCount})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => onActivateSkillPack(pack.name, pack.scope, selection)}
                        className={compactOutlinedButtonClassName}
                        style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
                      >
                        Activate
                      </button>
                      <button
                        type="button"
                        onClick={() => onRollbackSkillPack(pack.name, pack.scope)}
                        className={compactOutlinedButtonClassName}
                        style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
                      >
                        Rollback
                      </button>
                    </div>
                  </div>
                  {pack.description && (
                    <div className="text-xs mt-2" style={{ color: theme.colors.text.secondary }}>
                      {truncate(pack.description, 180)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-2xl border px-3 py-3 space-y-2" style={{ borderColor: theme.colors.border.DEFAULT }}>
        <div className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
          Governance Audit
        </div>
        {auditItems.length === 0 ? (
          <div className="text-xs" style={{ color: theme.colors.text.secondary }}>
            No audit events yet.
          </div>
        ) : (
          <div className="space-y-2">
            {auditItems.slice(0, 8).map((item) => (
              <div
                key={item.id}
                className="rounded-xl px-3 py-2 border"
                style={{
                  backgroundColor: theme.colors.bg.primary,
                  borderColor: theme.colors.border.DEFAULT,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium" style={{ color: theme.colors.text.primary }}>
                    {item.title}
                  </div>
                  <div className="text-[11px]" style={{ color: theme.colors.text.muted }}>
                    {formatWhen(item.createdAt)}
                  </div>
                </div>
                <div className="text-[11px] mt-1 uppercase tracking-wider" style={{ color: theme.colors.text.muted }}>
                  {item.kind} • {item.status}
                </div>
                {item.detail && (
                  <div className="text-xs mt-2" style={{ color: theme.colors.text.secondary }}>
                    {truncate(item.detail, 220)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
