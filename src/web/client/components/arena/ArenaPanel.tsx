import React, { useEffect, useMemo, useState } from 'react';
import type {
  ArenaConfigView,
  ArenaModeView,
  ArenaRunView,
  LlmProfilesConfigView,
  SessionLlmSelectionView,
} from '../../app-shell-types.js';
import { useI18n } from '../../i18n/index.js';
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
}

interface ArenaConfigDialogProps {
  open: boolean;
  llmProfiles: LlmProfilesConfigView | null;
  currentSelection?: SessionLlmSelectionView;
  inheritedConfig?: ArenaConfigView | null;
  onCancel: () => void;
  onCreate: (input: { mode: ArenaModeView; prompt: string; config: ArenaConfigView }) => void | Promise<void>;
}

type MobileArenaTab = 'branches' | 'judge' | 'proposal' | 'timeline';

const REASONING_PRESETS: Array<SessionLlmSelectionView['reasoningPreset']> = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

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
  const [mode, setMode] = useState<ArenaModeView>('answer');
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
    setMode('answer');
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
        <div className="mb-4 flex flex-wrap gap-2">
          {(['answer', 'implementation'] as ArenaModeView[]).map((item) => (
            <button
              key={item}
              type="button"
              className="rounded-full border px-3 py-1.5 text-xs font-semibold"
              style={{
                borderColor: mode === item ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
                color: mode === item ? theme.colors.primary.DEFAULT : theme.colors.text.secondary,
              }}
              onClick={() => setMode(item)}
            >
              {t(`app.arena.mode.${item}` as never)}
            </button>
          ))}
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
            onClick={() => onCreate({ mode, prompt, config: { contestants: effectiveContestants, judge: effectiveJudge } })}
          >
            {t('app.arena.create')}
          </button>
        </div>
      </div>
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
}: ArenaPanelProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const [mobileTab, setMobileTab] = useState<MobileArenaTab>('branches');
  const canStart = arena?.status === 'draft';
  const canPause = arena?.status === 'running';
  const canResume = arena?.status === 'paused';
  const canJudge = Boolean(arena && (arena.status === 'running' || arena.status === 'paused') && arena.branches.every((branch) =>
    ['submitted', 'blocked', 'failed', 'cancelled', 'frozen', 'promoted'].includes(branch.status)
  ));
  const canProposal = arena?.mode === 'implementation' && Boolean(arena.winner) && !arena.proposal && ['running', 'paused', 'judging'].includes(arena.status);
  const canApply = Boolean(arena?.winner && (arena.mode === 'answer' || arena.proposal?.status === 'ready'));

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

  const branchGrid = arena ? (
    <div className="grid gap-3 md:grid-cols-2" data-testid="arena-branches">
      {arena.branches.map((branch) => (
        <div key={branch.id} className="rounded-xl border p-3" style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.tertiary }}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{branch.contestant.label}</div>
              <div className="truncate text-xs" style={{ color: theme.colors.text.muted }}>{branch.contestant.llmSelection.model}</div>
            </div>
            <span className="rounded-full px-2 py-1 text-[11px]" style={{ backgroundColor: `${theme.colors.primary.DEFAULT}18`, color: theme.colors.primary.DEFAULT }}>
              {branch.status}
            </span>
          </div>
          {branch.submission && (
            <p className="mb-2 line-clamp-3 text-xs" style={{ color: theme.colors.text.secondary }}>{branch.submission.summary}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {['submitted', 'blocked', 'frozen', 'promoted'].includes(branch.status) && (
              <button className="rounded-full border px-2 py-1 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void confirmAndRun(t('app.arena.winnerConfirmTitle'), t('app.arena.winnerConfirmBody'), () => onSelectWinner(branch.id))}>
                {arena.winner?.branchId === branch.id ? t('app.arena.winner') : t('app.arena.selectWinner')}
              </button>
            )}
            {branch.sessionId && !branch.promoted && (
              <button className="rounded-full border px-2 py-1 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void confirmAndRun(t('app.arena.promoteConfirmTitle'), t('app.arena.promoteConfirmBody'), () => onPromoteBranch(branch.id))}>
                {t('app.arena.promote')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
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
        <div className="hidden flex-wrap gap-2 sm:flex">
          <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void onRefresh()}>
            {t('common.refresh')}
          </button>
          {actionButtons}
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto border-b px-4 py-2 lg:hidden" style={{ borderColor: theme.colors.border.DEFAULT }}>
        {(['branches', 'judge', 'proposal', 'timeline'] as const).map((tab) => (
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
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className={mobileTab === 'branches' ? 'block' : 'hidden lg:block'}>
              {branchGrid}
            </div>
            <div className="grid gap-3">
              <div className={mobileTab === 'judge' ? 'block' : 'hidden lg:block'}>{judgePanel}</div>
              <div className={mobileTab === 'proposal' ? 'block' : 'hidden lg:block'}>{proposalPanel}</div>
              <div className={mobileTab === 'timeline' ? 'block' : 'hidden lg:block'}>{timelinePanel}</div>
            </div>
          </div>
        )}
      </div>
      <div className="flex gap-2 overflow-x-auto border-t px-4 py-3 sm:hidden" style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}>
        <button className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: theme.colors.border.DEFAULT }} onClick={() => void onRefresh()}>
          {t('common.refresh')}
        </button>
        {actionButtons}
      </div>
    </div>
  );
}
