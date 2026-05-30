import React, { useEffect, useMemo, useState } from 'react';
import type {
  ArenaBranchDetailView,
  ArenaConfigView,
  ArenaRunView,
  ArenaBranchView,
  LlmProfilesConfigView,
  SessionDetail,
  SessionLlmSelectionView,
} from '../../app-shell-types.js';
import type { Message } from '../../chat-types.js';
import { projectSessionMessages } from '../../chat-message-projection.js';
import { fetchArenaBranchDetail } from '../../session-rest-api.js';
import { useI18n } from '../../i18n/index.js';
import { MessageItem } from '../chat/MessageItem.js';
import type { ChatDisplayFilters } from '../chat/chat-display-filters.js';
import type { RequestConfirm } from '../common/ConfirmDialog.js';
import { useThemeConfig } from '../providers/ThemeProvider.js';

interface ArenaPanelProps {
  arena: ArenaRunView | null;
  loading?: boolean;
  onRefresh: () => void | Promise<void>;
  onStart: () => void | Promise<void>;
  onPause: () => void | Promise<void>;
  onResume: () => void | Promise<void>;
  onClose: () => void | Promise<void>;
  onJudge: () => void | Promise<void>;
  onCreateProposal: () => void | Promise<void>;
  onApply: () => void | Promise<void>;
  onSelectWinner: (branchId: string) => void | Promise<void>;
  onPromoteBranch: (branchId: string) => void | Promise<void>;
  requestConfirm?: RequestConfirm;
  sourceMessages?: Message[];
}

interface ArenaConfigDialogProps {
  open: boolean;
  llmProfiles: LlmProfilesConfigView | null;
  currentSelection?: SessionLlmSelectionView;
  inheritedConfig?: ArenaConfigView | null;
  onCancel: () => void;
  onCreate: (input: { prompt: string; config: ArenaConfigView }) => void | Promise<void>;
}

type MobileArenaTab = 'branches' | 'detail' | 'judge' | 'proposal' | 'timeline';
type BranchDetailTab = 'log' | 'submission' | 'files';

const REASONING_PRESETS: Array<SessionLlmSelectionView['reasoningPreset']> = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const ARENA_TRANSCRIPT_FILTERS: ChatDisplayFilters = {
  showThinking: false,
  showToolCall: false,
  showToolResult: false,
};

function cloneSelection(selection: SessionLlmSelectionView): SessionLlmSelectionView {
  return { ...selection, updatedAt: new Date().toISOString() };
}

function defaultSelection(
  llmProfiles: LlmProfilesConfigView | null,
  currentSelection?: SessionLlmSelectionView
): SessionLlmSelectionView | null {
  if (currentSelection?.profileId && currentSelection.model) {
    return cloneSelection(currentSelection);
  }
  const profile = llmProfiles?.profiles?.find((item) => item.id === llmProfiles.defaultProfileId) ?? llmProfiles?.profiles?.[0];
  if (!profile?.id || !profile.defaultModel) {
    return null;
  }
  return {
    profileId: profile.id,
    model: profile.defaultModel,
    reasoningPreset: 'off',
    updatedAt: new Date().toISOString(),
  };
}

function defaultContestants(selection: SessionLlmSelectionView): ArenaConfigView['contestants'] {
  return [1, 2].map((index) => ({
    id: `contestant-${index}`,
    label: `Contestant ${index}`,
    llmSelection: cloneSelection(selection),
  }));
}

export function ArenaConfigDialog({
  open,
  llmProfiles,
  currentSelection,
  inheritedConfig,
  onCancel,
  onCreate,
}: ArenaConfigDialogProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const initialSelection = useMemo(() => defaultSelection(llmProfiles, currentSelection), [currentSelection, llmProfiles]);
  const [prompt, setPrompt] = useState('');
  const [contestants, setContestants] = useState<ArenaConfigView['contestants']>([]);
  const [judge, setJudge] = useState<ArenaConfigView['judge'] | null>(null);

  useEffect(() => {
    if (!open || !initialSelection) {
      return;
    }
    setContestants(
      inheritedConfig?.contestants?.length
        ? inheritedConfig.contestants.slice(0, 4).map((item) => ({ ...item, llmSelection: cloneSelection(item.llmSelection) }))
        : defaultContestants(initialSelection)
    );
    setJudge(
      inheritedConfig?.judge
        ? { ...inheritedConfig.judge, llmSelection: cloneSelection(inheritedConfig.judge.llmSelection) }
        : { llmSelection: cloneSelection(initialSelection) }
    );
    setPrompt('');
  }, [inheritedConfig, initialSelection, open]);

  if (!open || !initialSelection) {
    return null;
  }

  const profileOptions = llmProfiles?.profiles ?? [];
  const inheritedContestants = inheritedConfig?.contestants?.length
    ? inheritedConfig.contestants.slice(0, 4).map((item) => ({ ...item, llmSelection: cloneSelection(item.llmSelection) }))
    : null;
  const effectiveContestants = contestants.length > 0 ? contestants : inheritedContestants ?? defaultContestants(initialSelection);
  const effectiveJudge = judge ??
    (inheritedConfig?.judge
      ? { ...inheritedConfig.judge, llmSelection: cloneSelection(inheritedConfig.judge.llmSelection) }
      : { llmSelection: cloneSelection(initialSelection) });
  const updateContestant = (index: number, patch: Partial<ArenaConfigView['contestants'][number]>): void => {
    setContestants((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };
  const updateContestantSelection = (index: number, patch: Partial<SessionLlmSelectionView>): void => {
    setContestants((prev) => prev.map((item, itemIndex) =>
      itemIndex === index
        ? { ...item, llmSelection: { ...item.llmSelection, ...patch, updatedAt: new Date().toISOString() } }
        : item
    ));
  };
  const updateJudgeSelection = (patch: Partial<SessionLlmSelectionView>): void => {
    setJudge((prev) => (prev ? { ...prev, llmSelection: { ...prev.llmSelection, ...patch, updatedAt: new Date().toISOString() } } : prev));
  };
  const profileDefaultModel = (profileId: string): string | undefined =>
    profileOptions.find((profile) => profile.id === profileId)?.defaultModel;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 px-3" data-testid="arena-config-dialog">
      <div
        className="max-h-[92vh] w-full max-w-3xl overflow-auto rounded-2xl border p-4"
        style={{
          borderColor: theme.colors.border.DEFAULT,
          backgroundColor: theme.colors.bg.primary,
          color: theme.colors.text.primary,
          boxShadow: theme.shadows.xl,
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{t('app.arena.configTitle')}</h2>
          <button className="rounded-full border px-3 py-1 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={onCancel}>
            {t('common.cancel')}
          </button>
        </div>
        <textarea
          className="mb-4 min-h-[92px] w-full rounded-xl border bg-transparent p-3 text-sm outline-none"
          style={{ borderColor: theme.colors.border.DEFAULT }}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t('app.arena.promptPlaceholder')}
        />
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('app.arena.contestants')}</h3>
          <button
            type="button"
            className="rounded-full border px-3 py-1 text-xs disabled:opacity-50"
            style={{ borderColor: theme.colors.border.DEFAULT }}
            disabled={effectiveContestants.length >= 4}
            onClick={() => setContestants((prev) => {
              const base = prev.length > 0 ? prev : effectiveContestants;
              return [...base, {
              id: `contestant-${base.length + 1}`,
              label: `Contestant ${base.length + 1}`,
              llmSelection: cloneSelection(initialSelection),
            }];
            })}
          >
            {t('app.arena.addContestant')}
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {effectiveContestants.map((contestant, index) => (
            <div key={contestant.id} className="rounded-xl border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <input
                  className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
                  value={contestant.label}
                  onChange={(event) => updateContestant(index, { label: event.target.value })}
                />
                {effectiveContestants.length > 1 && (
                  <button className="text-xs" onClick={() => setContestants((prev) => (prev.length > 0 ? prev : effectiveContestants).filter((_, itemIndex) => itemIndex !== index))}>
                    {t('common.remove')}
                  </button>
                )}
              </div>
              <input
                className="mb-2 w-full rounded-lg border bg-transparent px-2 py-1 text-xs"
                style={{ borderColor: theme.colors.border.DEFAULT }}
                value={contestant.agentName ?? ''}
                onChange={(event) => updateContestant(index, { agentName: event.target.value })}
                placeholder={t('app.arena.agentPlaceholder')}
              />
              <select
                className="mb-2 w-full rounded-lg border bg-transparent px-2 py-1 text-xs"
                style={{ borderColor: theme.colors.border.DEFAULT }}
                value={contestant.llmSelection.profileId}
                onChange={(event) => {
                  const nextProfileId = event.target.value;
                  updateContestantSelection(index, {
                    profileId: nextProfileId,
                    model: profileDefaultModel(nextProfileId) ?? contestant.llmSelection.model,
                  });
                }}
              >
                {profileOptions.map((profile) => <option key={profile.id} value={profile.id}>{profile.name || profile.id}</option>)}
              </select>
              <input
                className="mb-2 w-full rounded-lg border bg-transparent px-2 py-1 text-xs"
                style={{ borderColor: theme.colors.border.DEFAULT }}
                value={contestant.llmSelection.model}
                onChange={(event) => updateContestantSelection(index, { model: event.target.value })}
              />
              <select
                className="w-full rounded-lg border bg-transparent px-2 py-1 text-xs"
                style={{ borderColor: theme.colors.border.DEFAULT }}
                value={contestant.llmSelection.reasoningPreset}
                aria-label={t('app.llm.reasoning')}
                onChange={(event) =>
                  updateContestantSelection(index, { reasoningPreset: event.target.value as SessionLlmSelectionView['reasoningPreset'] })
                }
              >
                {REASONING_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>{t(`app.llm.reasoningPreset.${preset}` as never)}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
          <h3 className="mb-2 text-sm font-semibold">{t('app.arena.judge')}</h3>
          <select
            className="mb-2 w-full rounded-lg border bg-transparent px-2 py-1 text-xs"
            style={{ borderColor: theme.colors.border.DEFAULT }}
            value={effectiveJudge.llmSelection.profileId}
            onChange={(event) => {
              const nextProfileId = event.target.value;
              updateJudgeSelection({
                profileId: nextProfileId,
                model: profileDefaultModel(nextProfileId) ?? effectiveJudge.llmSelection.model,
              });
            }}
          >
            {profileOptions.map((profile) => <option key={profile.id} value={profile.id}>{profile.name || profile.id}</option>)}
          </select>
          <input
            className="mb-2 w-full rounded-lg border bg-transparent px-2 py-1 text-xs"
            style={{ borderColor: theme.colors.border.DEFAULT }}
            value={effectiveJudge.llmSelection.model}
            onChange={(event) => updateJudgeSelection({ model: event.target.value })}
          />
          <select
            className="w-full rounded-lg border bg-transparent px-2 py-1 text-xs"
            style={{ borderColor: theme.colors.border.DEFAULT }}
            value={effectiveJudge.llmSelection.reasoningPreset}
            aria-label={t('app.llm.reasoning')}
            onChange={(event) =>
              updateJudgeSelection({ reasoningPreset: event.target.value as SessionLlmSelectionView['reasoningPreset'] })
            }
          >
            {REASONING_PRESETS.map((preset) => (
              <option key={preset} value={preset}>{t(`app.llm.reasoningPreset.${preset}` as never)}</option>
            ))}
          </select>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded-full border px-4 py-2 text-sm" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            className="rounded-full px-4 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: theme.colors.primary.DEFAULT }}
            onClick={() => onCreate({ prompt, config: { contestants: effectiveContestants, judge: effectiveJudge } })}
          >
            {t('app.arena.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function branchStatusTone(
  theme: ReturnType<typeof useThemeConfig>,
  status: ArenaBranchView['status']
): { bg: string; color: string; border: string } {
  if (status === 'submitted' || status === 'promoted') {
    return {
      bg: `${theme.colors.toolResult.success.bg}`,
      color: theme.colors.toolResult.success.text,
      border: theme.colors.toolResult.success.border,
    };
  }
  if (status === 'failed' || status === 'blocked' || status === 'cancelled') {
    return {
      bg: theme.colors.toolResult.error.bg,
      color: theme.colors.toolResult.error.text,
      border: theme.colors.toolResult.error.border,
    };
  }
  return {
    bg: `${theme.colors.primary.DEFAULT}18`,
    color: theme.colors.primary.DEFAULT,
    border: theme.colors.border.DEFAULT,
  };
}

function formatShortTimestamp(value: string | undefined): string {
  if (!value) {
    return '';
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function projectArenaBranchMessages(detail: ArenaBranchDetailView | undefined): Message[] {
  if (!detail?.messages?.length) {
    return [];
  }
  return projectSessionMessages(detail.branch.sessionId ?? detail.branch.id, {
    messages: detail.messages,
    runtimeErrors: detail.runtimeErrors ?? [],
  } as SessionDetail);
}

function ReadOnlyTranscript({ messages, emptyLabel }: { messages: Message[]; emptyLabel: string }) {
  const theme = useThemeConfig();
  if (!messages.length) {
    return (
      <div className="rounded-lg border p-3 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }}>
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} displayFilters={ARENA_TRANSCRIPT_FILTERS} />
      ))}
    </div>
  );
}

export function ArenaPanel({
  arena,
  loading = false,
  onRefresh,
  onStart,
  onPause,
  onResume,
  onClose,
  onJudge,
  onCreateProposal,
  onApply,
  onSelectWinner,
  onPromoteBranch,
  requestConfirm,
  sourceMessages = [],
}: ArenaPanelProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const [mobileTab, setMobileTab] = useState<MobileArenaTab>('branches');
  const [branchDetailTab, setBranchDetailTab] = useState<BranchDetailTab>('log');
  const [selectedByArena, setSelectedByArena] = useState<Record<string, string>>({});
  const [sourceHistoryOpen, setSourceHistoryOpen] = useState(false);
  const [branchDetails, setBranchDetails] = useState<Record<string, ArenaBranchDetailView>>({});
  const [branchDetailLoadingKey, setBranchDetailLoadingKey] = useState<string | null>(null);
  const [branchDetailErrorByKey, setBranchDetailErrorByKey] = useState<Record<string, string>>({});
  const selectedBranchId = arena ? selectedByArena[arena.id] : undefined;
  const fallbackBranch =
    arena?.branches.find((branch) => branch.id === arena.winner?.branchId) ??
    arena?.branches.find((branch) => branch.status === 'running' || branch.status === 'preparing') ??
    arena?.branches[0] ??
    null;
  const selectedBranch = arena?.branches.find((branch) => branch.id === selectedBranchId) ?? fallbackBranch;
  const selectedBranchTimeline = arena && selectedBranch
    ? arena.timeline.filter((item) => item.branchId === selectedBranch.id)
    : [];
  const selectedBranchDetailKey = arena && selectedBranch ? `${arena.id}:${selectedBranch.id}` : '';
  const selectedBranchDetail = selectedBranchDetailKey ? branchDetails[selectedBranchDetailKey] : undefined;
  const selectedBranchMessages = useMemo(() => projectArenaBranchMessages(selectedBranchDetail), [selectedBranchDetail]);

  useEffect(() => {
    if (!arena || !fallbackBranch) {
      return;
    }
    if (arena.branches.some((branch) => branch.id === selectedBranchId)) {
      return;
    }
    setSelectedByArena((prev) => ({ ...prev, [arena.id]: fallbackBranch.id }));
  }, [arena, fallbackBranch, selectedBranchId]);

  useEffect(() => {
    if (!arena || !selectedBranch) {
      return;
    }
    const detailKey = `${arena.id}:${selectedBranch.id}`;
    let cancelled = false;
    setBranchDetailLoadingKey(detailKey);
    setBranchDetailErrorByKey((prev) => {
      const next = { ...prev };
      delete next[detailKey];
      return next;
    });
    void fetchArenaBranchDetail(arena.id, selectedBranch.id)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setBranchDetails((prev) => ({ ...prev, [detailKey]: result.detail }));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setBranchDetailErrorByKey((prev) => ({
          ...prev,
          [detailKey]: error instanceof Error ? error.message : String(error),
        }));
      })
      .finally(() => {
        if (!cancelled) {
          setBranchDetailLoadingKey((current) => (current === detailKey ? null : current));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [arena, selectedBranch]);

  const selectBranch = (branchId: string): void => {
    if (!arena) {
      return;
    }
    setSelectedByArena((prev) => ({ ...prev, [arena.id]: branchId }));
    setMobileTab('detail');
  };

  const arenaTerminal = !arena || arena.status === 'applied' || arena.status === 'closed';
  const canStart = arena?.status === 'draft';
  const canPause = arena?.status === 'running';
  const canResume = arena?.status === 'paused';
  const canJudge = Boolean(arena && (arena.status === 'running' || arena.status === 'paused') && arena.branches.every((branch) =>
    ['submitted', 'blocked', 'failed', 'cancelled', 'frozen', 'promoted'].includes(branch.status)
  ));
  const winnerBranch = arena?.branches.find((branch) => branch.id === arena.winner?.branchId);
  const winnerHasWorkspace = Boolean(winnerBranch?.workspaceDir);
  const canProposal = Boolean(arena?.winner && winnerHasWorkspace) && !arena?.proposal && Boolean(arena && ['running', 'paused', 'judging'].includes(arena.status));
  const canApply = Boolean(!arenaTerminal && arena?.winner && (!winnerHasWorkspace || arena.proposal?.status === 'ready'));

  const confirmAndRun = async (title: string, body: string, action: () => void | Promise<void>): Promise<void> => {
    if (requestConfirm) {
      const ok = await requestConfirm({ title, body, confirmLabel: t('common.confirm'), cancelLabel: t('common.cancel'), variant: 'danger' });
      if (!ok) {
        return;
      }
    }
    await action();
  };

  const actionButtons = (
    <>
      {canStart && <button className="rounded-full px-3 py-1.5 text-xs font-semibold text-white" style={{ backgroundColor: theme.colors.primary.DEFAULT }} onClick={() => void onStart()}>{t('app.arena.start')}</button>}
      {canPause && <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void confirmAndRun(t('app.arena.pauseConfirmTitle'), t('app.arena.pauseConfirmBody'), onPause)}>{t('app.arena.pause')}</button>}
      {canResume && <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void onResume()}>{t('app.arena.resume')}</button>}
      {canJudge && <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void onJudge()}>{t('app.arena.judgeAction')}</button>}
      {canProposal && <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void onCreateProposal()}>{t('app.arena.proposal')}</button>}
      {canApply && <button className="rounded-full px-3 py-1.5 text-xs font-semibold text-white" style={{ backgroundColor: theme.colors.primary.DEFAULT }} onClick={() => void confirmAndRun(t('app.arena.applyConfirmTitle'), t('app.arena.applyConfirmBody'), onApply)}>{t('app.arena.apply')}</button>}
      {arena && !['applied', 'closed'].includes(arena.status) && (
        <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.toolResult.error.border }} onClick={() => void confirmAndRun(t('app.arena.closeConfirmTitle'), t('app.arena.closeConfirmBody'), onClose)}>
          {t('app.arena.close')}
        </button>
      )}
    </>
  );

  const branchList = arena ? (
    <div className="grid gap-2" data-testid="arena-branches">
      {arena.branches.map((branch) => (
        <button
          key={branch.id}
          type="button"
          className="w-full rounded-xl border p-3 text-left transition"
          style={{
            borderColor: selectedBranch?.id === branch.id ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
            backgroundColor: selectedBranch?.id === branch.id ? `${theme.colors.primary.DEFAULT}10` : theme.colors.bg.tertiary,
          }}
          onClick={() => selectBranch(branch.id)}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">#{branch.index + 1} {branch.contestant.label}</div>
              <div className="truncate text-xs" style={{ color: theme.colors.text.muted }}>{branch.contestant.llmSelection.model}</div>
            </div>
            <span
              className="rounded-full border px-2 py-1 text-[11px]"
              style={{
                background: branchStatusTone(theme, branch.status).bg,
                color: branchStatusTone(theme, branch.status).color,
                borderColor: branchStatusTone(theme, branch.status).border,
              }}
            >
              {branch.status}
            </span>
          </div>
          <div className="mb-2 flex flex-wrap gap-2 text-[11px]" style={{ color: theme.colors.text.muted }}>
            <span>{branch.contestant.agentName || t('app.arena.defaultAgent')}</span>
            {arena.winner?.branchId === branch.id && <span>{t('app.arena.winner')}</span>}
            {branch.submission?.changedFiles?.length ? <span>{branch.submission.changedFiles.length} files</span> : null}
            {branch.submission?.submittedAt ? <span>{formatShortTimestamp(branch.submission.submittedAt)}</span> : null}
          </div>
          {branch.submission && (
            <p className="line-clamp-2 text-xs leading-relaxed" style={{ color: theme.colors.text.secondary }}>{branch.submission.summary}</p>
          )}
        </button>
      ))}
    </div>
  ) : null;

  const selectedBranchActions = arena && selectedBranch ? (
    <div className="flex flex-wrap gap-2">
      {['submitted', 'blocked', 'frozen', 'promoted'].includes(selectedBranch.status) && (
        <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void confirmAndRun(t('app.arena.winnerConfirmTitle'), t('app.arena.winnerConfirmBody'), () => onSelectWinner(selectedBranch.id))}>
          {arena.winner?.branchId === selectedBranch.id ? t('app.arena.winner') : t('app.arena.selectWinner')}
        </button>
      )}
      {selectedBranch.sessionId && !selectedBranch.promoted && (
        <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void confirmAndRun(t('app.arena.promoteConfirmTitle'), t('app.arena.promoteConfirmBody'), () => onPromoteBranch(selectedBranch.id))}>
          {t('app.arena.promote')}
        </button>
      )}
    </div>
  ) : null;

  const branchDetailPanel = arena && selectedBranch ? (
    <section
      key={`${arena.id}-${selectedBranch.id}`}
      className="flex min-h-[360px] flex-col rounded-xl border"
      style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
      data-testid="arena-branch-detail"
    >
      <div className="border-b p-4" style={{ borderColor: theme.colors.border.DEFAULT }}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">#{selectedBranch.index + 1} {selectedBranch.contestant.label}</h3>
            <div className="mt-1 truncate text-xs" style={{ color: theme.colors.text.muted }}>
              {selectedBranch.contestant.llmSelection.profileId} / {selectedBranch.contestant.llmSelection.model}
            </div>
          </div>
          <span
            className="rounded-full border px-2 py-1 text-[11px]"
            style={{
              background: branchStatusTone(theme, selectedBranch.status).bg,
              color: branchStatusTone(theme, selectedBranch.status).color,
              borderColor: branchStatusTone(theme, selectedBranch.status).border,
            }}
          >
            {selectedBranch.status}
          </span>
        </div>
        <div className="mb-3 flex gap-2 overflow-x-auto">
          {(['log', 'submission', 'files'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              className="rounded-full border px-3 py-1.5 text-xs"
              style={{
                borderColor: branchDetailTab === tab ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
                color: branchDetailTab === tab ? theme.colors.primary.DEFAULT : theme.colors.text.secondary,
              }}
              onClick={() => setBranchDetailTab(tab)}
            >
              {t(`app.arena.branchTab.${tab}` as never)}
            </button>
          ))}
        </div>
        {selectedBranchActions}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {branchDetailTab === 'log' && (
          <div className="grid gap-3 text-xs" style={{ color: theme.colors.text.secondary }}>
            <div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.tertiary }}>
              <div>{selectedBranch.sessionId ? `${t('app.arena.session')}: ${selectedBranch.sessionId}` : t('app.arena.sessionPending')}</div>
              {selectedBranch.workspaceDir && <div className="mt-1 truncate">{selectedBranch.workspaceDir}</div>}
            </div>
            {branchDetailLoadingKey === selectedBranchDetailKey && (
              <div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>{t('common.loading')}</div>
            )}
            {branchDetailErrorByKey[selectedBranchDetailKey] && (
              <div className="rounded-lg border p-3" style={{ borderColor: theme.colors.toolResult.error.border }}>
                {branchDetailErrorByKey[selectedBranchDetailKey]}
              </div>
            )}
            {selectedBranchMessages.length ? (
              <ReadOnlyTranscript messages={selectedBranchMessages} emptyLabel={t('app.arena.noBranchLog')} />
            ) : selectedBranchTimeline.length ? (
              selectedBranchTimeline.slice(-8).reverse().map((item) => (
                <div key={item.id} className="rounded-lg border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
                  <div className="mb-1 text-[11px]" style={{ color: theme.colors.text.muted }}>{formatShortTimestamp(item.createdAt)} / {item.type}</div>
                  <div>{item.message}</div>
                </div>
              ))
            ) : (
              <ReadOnlyTranscript messages={[]} emptyLabel={t('app.arena.noBranchLog')} />
            )}
          </div>
        )}
        {branchDetailTab === 'submission' && (
          <div className="grid gap-3 text-xs" style={{ color: theme.colors.text.secondary }}>
            {selectedBranch.submission ? (
              <>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
                  <div className="mb-1 font-semibold" style={{ color: theme.colors.text.primary }}>{selectedBranch.submission.status}</div>
                  <div className="whitespace-pre-wrap">{selectedBranch.submission.finalAnswer || selectedBranch.submission.summary}</div>
                </div>
                {selectedBranch.submission.evidence.length ? (
                  <div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
                    <div className="mb-2 font-semibold" style={{ color: theme.colors.text.primary }}>{t('app.arena.evidence')}</div>
                    <ul className="grid gap-1">
                      {selectedBranch.submission.evidence.map((item) => <li key={item}>- {item}</li>)}
                    </ul>
                  </div>
                ) : null}
                {selectedBranch.submission.risks?.length ? (
                  <div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
                    <div className="mb-2 font-semibold" style={{ color: theme.colors.text.primary }}>{t('app.arena.risks')}</div>
                    <ul className="grid gap-1">
                      {selectedBranch.submission.risks.map((item) => <li key={item}>- {item}</li>)}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>{t('app.arena.noSubmission')}</div>
            )}
          </div>
        )}
        {branchDetailTab === 'files' && (
          <div className="grid gap-2 text-xs" style={{ color: theme.colors.text.secondary }}>
            {selectedBranch.submission?.changedFiles?.length ? selectedBranch.submission.changedFiles.map((file) => (
              <div key={file} className="truncate rounded-lg border px-3 py-2" style={{ borderColor: theme.colors.border.DEFAULT }}>
                {file}
              </div>
            )) : (
              <div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>{t('app.arena.noChangedFiles')}</div>
            )}
          </div>
        )}
      </div>
    </section>
  ) : null;

  const judgePanel = arena ? (
    <section className="rounded-xl border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
      <h3 className="mb-2 text-sm font-semibold">{t('app.arena.judge')}</h3>
      <div className="text-xs" style={{ color: theme.colors.text.secondary }}>
        {arena.judgeResult?.status ? `${arena.judgeResult.status}: ${arena.judgeResult.rationale}` : arena.config.judge.llmSelection.model}
      </div>
      {arena.judgeResult?.ranking?.length ? (
        <ol className="mt-2 grid gap-1 text-xs" style={{ color: theme.colors.text.secondary }}>
          {arena.judgeResult.ranking.map((item) => <li key={`${item.rank}-${item.branchId}`}>{item.rank}. {item.branchId}{item.rationale ? ` - ${item.rationale}` : ''}</li>)}
        </ol>
      ) : null}
    </section>
  ) : null;

  const proposalPanel = arena ? (
    <section className="rounded-xl border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
      <h3 className="mb-2 text-sm font-semibold">{t('app.arena.proposal')}</h3>
      <div className="text-xs" style={{ color: theme.colors.text.secondary }}>
        {arena.proposal ? `${arena.proposal.status} - ${arena.proposal.changedFiles.length} files` : t('app.arena.noProposal')}
      </div>
      {arena.proposal?.changedFiles?.length ? (
        <div className="mt-2 grid gap-1 text-xs" style={{ color: theme.colors.text.muted }}>
          {arena.proposal.changedFiles.slice(0, 8).map((file) => <div key={file} className="truncate">{file}</div>)}
        </div>
      ) : null}
    </section>
  ) : null;

  const timelinePanel = arena ? (
    <section className="rounded-xl border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
      <h3 className="mb-2 text-sm font-semibold">{t('app.arena.timeline')}</h3>
      <div className="grid gap-2">
        {arena.timeline.slice(-8).reverse().map((item) => (
          <div key={item.id} className="text-xs" style={{ color: theme.colors.text.secondary }}>{item.message}</div>
        ))}
      </div>
    </section>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="arena-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
        <div>
          <div className="text-xs font-semibold uppercase" style={{ color: theme.colors.text.muted }}>{t('app.arena.title')}</div>
          <div className="text-lg font-semibold" style={{ color: theme.colors.text.primary }}>
            {arena ? `${arena.sourceSessionName} - ${arena.status}` : t('app.arena.noActive')}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-full border px-3 py-1.5 text-xs"
            style={{ borderColor: theme.colors.border.DEFAULT }}
            onClick={() => setSourceHistoryOpen(true)}
            aria-label={t('app.arena.sourceHistory')}
          >
            {t('app.arena.sourceHistory')}
          </button>
        </div>
        <div className="hidden flex-wrap gap-2 sm:flex">
          <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void onRefresh()}>
            {t('common.refresh')}
          </button>
          {actionButtons}
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto border-b px-4 py-2 lg:hidden" style={{ borderColor: theme.colors.border.DEFAULT }}>
        {(['branches', 'detail', 'judge', 'proposal', 'timeline'] as const).map((tab) => (
          <button
            key={tab}
            className="rounded-full border px-3 py-1.5 text-xs"
            style={{
              borderColor: mobileTab === tab ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
              color: mobileTab === tab ? theme.colors.primary.DEFAULT : theme.colors.text.secondary,
            }}
            onClick={() => setMobileTab(tab)}
          >
            {t(`app.arena.tab.${tab}` as never)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 pb-24 sm:pb-4">
        {loading && <div className="text-sm" style={{ color: theme.colors.text.secondary }}>{t('common.loading')}</div>}
        {arena && (
          <div className="grid min-h-0 gap-4 lg:grid-cols-[300px_minmax(360px,1fr)] 2xl:grid-cols-[300px_minmax(0,1fr)_340px]">
            <div className={mobileTab === 'branches' ? 'block' : 'hidden lg:block'}>
              {branchList}
            </div>
            <div className={mobileTab === 'detail' ? 'block' : 'hidden lg:block'}>
              {branchDetailPanel}
            </div>
            <div className="grid gap-3 lg:col-span-2 2xl:col-span-1">
              <div className={mobileTab === 'judge' ? 'block' : 'hidden lg:block'}>{judgePanel}</div>
              <div className={mobileTab === 'proposal' ? 'block' : 'hidden lg:block'}>{proposalPanel}</div>
              <div className={mobileTab === 'timeline' ? 'block' : 'hidden lg:block'}>{timelinePanel}</div>
            </div>
          </div>
        )}
      </div>
      {sourceHistoryOpen && (
        <div className="fixed inset-0 z-[95]" data-testid="arena-source-history">
          <button
            type="button"
            className="absolute inset-0 bg-black/45"
            aria-label={t('common.close')}
            onClick={() => setSourceHistoryOpen(false)}
          />
          <section
            className="absolute inset-y-2 right-2 left-2 flex flex-col overflow-hidden rounded-2xl border shadow-xl sm:inset-y-3 sm:left-auto sm:w-[560px]"
            style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
              <h3 className="text-sm font-semibold" style={{ color: theme.colors.text.primary }}>{t('app.arena.sourceHistory')}</h3>
              <button
                className="rounded-full border px-3 py-1.5 text-xs"
                style={{ borderColor: theme.colors.border.DEFAULT }}
                onClick={() => setSourceHistoryOpen(false)}
              >
                {t('common.close')}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <ReadOnlyTranscript messages={sourceMessages} emptyLabel={t('app.arena.noSourceHistory')} />
            </div>
          </section>
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto border-t px-4 py-3 sm:hidden" style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}>
        <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void onRefresh()}>
          {t('common.refresh')}
        </button>
        {actionButtons}
      </div>
    </div>
  );
}
