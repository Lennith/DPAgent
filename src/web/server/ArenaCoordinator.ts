import * as path from 'node:path';
import { ArenaStore } from '../../arena/ArenaStore.js';
import {
  ArenaWorkspaceService,
  applyArenaWorkspaceDiff,
  diffArenaWorkspaces,
} from '../../arena/ArenaWorkspaceService.js';
import { forkArenaBranchSession } from '../../arena/arena-session-fork.js';
import type { ArenaBranch, ArenaConfig, ArenaMode, ArenaRun } from '../../arena/types.js';
import type { ContextNamespaceMeta, ContextRef, SessionLlmSelection } from '../../types.js';
import { nowIso } from '../../storage/index.js';
import { createSessionNamespace } from './web-server-shared.js';
import type { WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';

export class ArenaRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ArenaRouteError';
  }
}

function trimString(value: unknown): string {
  return String(value ?? '').trim();
}

function getRuntimeArenaDir(deps: WebServerRouteRegistrationDependencies): string {
  const runtimeDataDir = trimString(deps.agent.getConfig().agent.runtimeDataDir) || path.resolve('./runtime');
  return path.join(runtimeDataDir, 'arena');
}

function getDefaultLlmSelection(deps: WebServerRouteRegistrationDependencies): SessionLlmSelection {
  const config = deps.agent.getConfig();
  const profiles = config.llmProfiles?.profiles ?? [];
  const profile =
    profiles.find((item) => item.id === config.llmProfiles?.defaultProfileId) ??
    profiles[0];
  if (!profile || !trimString(profile.id) || !trimString(profile.defaultModel)) {
    throw new ArenaRouteError(409, 'llm_profile_not_configured', 'LLM profile is not configured.');
  }
  return {
    profileId: profile.id,
    model: profile.defaultModel,
    reasoningPreset: 'off',
    updatedAt: nowIso(),
  };
}

function getCurrentLlmSelection(
  deps: WebServerRouteRegistrationDependencies,
  meta: ContextNamespaceMeta
): SessionLlmSelection {
  return meta.llmSelection ?? getDefaultLlmSelection(deps);
}

function getSourceEventCount(meta: ContextNamespaceMeta): number {
  const projection = (meta as ContextNamespaceMeta & { projection?: { version?: number } }).projection;
  return Math.max(0, Math.trunc(projection?.version ?? 0));
}

function isFinalizedPlanApprovalPending(meta: ContextNamespaceMeta): boolean {
  return meta.pendingPlanInput?.source === 'finalize_plan_approval' && meta.planningState?.state === 'plan_drafting';
}

function isJudgeReadyBranch(branch: ArenaBranch): boolean {
  return (
    branch.status === 'submitted' ||
    branch.status === 'blocked' ||
    branch.status === 'failed' ||
    branch.status === 'cancelled' ||
    branch.status === 'frozen' ||
    branch.status === 'promoted'
  );
}

function isWinnerEligibleBranch(branch: ArenaBranch): boolean {
  return branch.status === 'submitted' || branch.status === 'blocked' || branch.status === 'frozen' || branch.status === 'promoted';
}

function isTerminalArenaStatus(status: ArenaRun['status']): boolean {
  return status === 'applied' || status === 'closed';
}

export class ArenaCoordinator {
  readonly store: ArenaStore;

  constructor(private readonly deps: WebServerRouteRegistrationDependencies) {
    this.store = deps.agent.getArenaStore?.() ?? new ArenaStore(getRuntimeArenaDir(deps));
  }

  getRun(arenaId: string): ArenaRun {
    const run = this.store.getRun(arenaId);
    if (!run) {
      throw new ArenaRouteError(404, 'arena_not_found', 'Arena not found.');
    }
    return run;
  }

  getRunForSource(sessionId: string): ArenaRun | null {
    return this.store.getActiveRunForSource(sessionId) ?? null;
  }

  createArena(input: {
    sessionId: string;
    mode?: ArenaMode;
    prompt?: string;
    config?: Partial<ArenaConfig>;
  }): ArenaRun {
    const ref: ContextRef = { scope: 'session', namespace: input.sessionId };
    const meta = this.deps.contextServices.getContextNamespaceMetaSafe(ref);
    if (!meta) {
      throw new ArenaRouteError(404, 'session_not_found', 'Session not found.');
    }
    if (meta.arenaLock) {
      throw new ArenaRouteError(409, 'arena_locked', 'Session is already locked by Arena.');
    }
    if (meta.arenaBranch) {
      throw new ArenaRouteError(409, 'arena_branch_source', 'Arena branch sessions cannot start a nested Arena.');
    }
    if (this.store.getActiveRunForSource(input.sessionId)) {
      throw new ArenaRouteError(409, 'arena_exists', 'Session already has an active Arena.');
    }
    if (this.deps.contextServices.getActiveRunState(ref)) {
      throw new ArenaRouteError(409, 'active_run', 'Session has an active run and cannot enter Arena.');
    }
    if (this.deps.contextServices.getInterruptedArtifact(ref)) {
      throw new ArenaRouteError(409, 'interrupted_state', 'Session has interrupted state and cannot enter Arena.');
    }
    if (meta.pendingPlanInput && !isFinalizedPlanApprovalPending(meta)) {
      throw new ArenaRouteError(409, 'pending_input', 'Session is waiting for input and cannot enter Arena.');
    }
    if (meta.planningState?.state === 'plan_executing') {
      throw new ArenaRouteError(409, 'plan_executing', 'Session is executing a plan and cannot enter Arena.');
    }
    const todoState = this.deps.todoServices.getSessionTodoProtocolState(input.sessionId, meta.workspaceDir);
    if (todoState.hasUnfinished && !isFinalizedPlanApprovalPending(meta)) {
      throw new ArenaRouteError(409, 'unfinished_todos', 'Session has unfinished Todo items and cannot enter Arena.');
    }

    const mode = input.mode ?? 'implementation';
    const sourceWorkspaceDir = trimString(meta.workspaceDir);
    const run = this.store.createDraft({
      sourceSessionId: input.sessionId,
      sourceSessionName: meta.name,
      sourceEventCount: getSourceEventCount(meta),
      mode,
      entryType: isFinalizedPlanApprovalPending(meta) ? 'finalized_plan' : 'normal',
      prompt: input.prompt,
      frozenPlanId: isFinalizedPlanApprovalPending(meta) ? meta.planningState?.pendingPlanId : undefined,
      currentLlmSelection: getCurrentLlmSelection(this.deps, meta),
      config: input.config,
      workspaceSnapshot: {
        sourceWorkspaceDir: sourceWorkspaceDir || undefined,
        strategy: mode === 'answer' ? 'answer_only' : sourceWorkspaceDir ? undefined : 'session_only',
      },
    });
    this.lockSource(run);
    return run;
  }

  updateConfig(arenaId: string, config: Partial<ArenaConfig>): ArenaRun {
    return this.store.updateConfig(arenaId, config);
  }

  start(arenaId: string): ArenaRun {
    let run = this.store.setRunStatus(arenaId, 'preparing');
    const sourceMeta = this.deps.contextServices.getContextNamespaceMetaSafe({ scope: 'session', namespace: run.sourceSessionId });
    const workspaceService = new ArenaWorkspaceService({ sourceWorkspaceDir: sourceMeta?.workspaceDir });
    for (const branch of run.branches) {
      const workspace = workspaceService.prepareBranchWorkspace(run, branch);
      const meta = forkArenaBranchSession({
        host: this.deps.agent.getContextManager(),
        run,
        branch,
        workspaceDir: workspace.workspaceDir,
      });
      run = this.store.assignBranchSession({
        arenaId,
        branchId: branch.id,
        sessionId: meta.namespace,
        workspaceDir: workspace.workspaceDir,
        workspaceSnapshot: {
          ...workspace,
          capturedAt: nowIso(),
        },
      });
      run = this.store.setBranchStatus(arenaId, branch.id, 'preparing');
    }
    run = this.store.setRunStatus(arenaId, 'running');
    for (const branch of run.branches) {
      run = this.store.setBranchStatus(arenaId, branch.id, 'running');
      const currentBranch = run.branches.find((item) => item.id === branch.id);
      if (currentBranch?.sessionId) {
        this.startBranchRun(run, currentBranch);
      }
    }
    return this.store.appendTimeline(arenaId, { type: 'started', message: 'Arena started' });
  }

  pause(arenaId: string): ArenaRun {
    let run = this.store.setRunStatus(arenaId, 'paused');
    for (const branch of run.branches) {
      if (branch.status === 'running' || branch.status === 'preparing') {
        this.cancelBranchRun(branch);
        run = this.store.setBranchStatus(arenaId, branch.id, 'paused');
      }
    }
    return this.store.appendTimeline(arenaId, { type: 'paused', message: 'Arena paused' });
  }

  resume(arenaId: string): ArenaRun {
    let run = this.store.setRunStatus(arenaId, 'running');
    for (const branch of run.branches) {
      if (branch.status === 'paused') {
        run = this.store.setBranchStatus(arenaId, branch.id, 'running');
        const currentBranch = run.branches.find((item) => item.id === branch.id);
        if (currentBranch) {
          this.startBranchRun(run, currentBranch);
        }
      }
    }
    return this.store.appendTimeline(arenaId, { type: 'resumed', message: 'Arena resumed' });
  }

  close(arenaId: string): ArenaRun {
    let current = this.getRun(arenaId);
    for (const branch of current.branches) {
      if (branch.status === 'preparing' || branch.status === 'running' || branch.status === 'paused' || branch.status === 'reopened') {
        this.cancelBranchRun(branch);
        current = this.store.setBranchStatus(arenaId, branch.id, 'cancelled');
      }
    }
    const run = this.store.setRunStatus(arenaId, 'closed');
    this.unlockSource(run);
    return this.store.appendTimeline(arenaId, { type: 'closed', message: 'Arena closed' });
  }

  judge(arenaId: string): ArenaRun {
    const current = this.getRun(arenaId);
    if (!current.branches.every(isJudgeReadyBranch)) {
      throw new ArenaRouteError(409, 'branches_not_ready', 'All Arena branches must finish before judging.');
    }
    let run = current;
    if (current.status !== 'judging') {
      run = this.store.setRunStatus(arenaId, 'judging');
    }
    if (!run.judgeRunId) {
      const judgeSessionId = this.createJudgeSession(run);
      run = this.store.setJudgeRun(arenaId, judgeSessionId);
      this.startJudgeRun(run, judgeSessionId);
    }
    return this.store.appendTimeline(arenaId, { type: 'judging', message: 'Arena judge started' });
  }

  selectWinner(arenaId: string, input: { branchId: string; reason?: string }): ArenaRun {
    const current = this.getRun(arenaId);
    if (isTerminalArenaStatus(current.status)) {
      throw new ArenaRouteError(409, 'arena_terminal', 'Terminal Arena state cannot be changed.');
    }
    if (current.status === 'proposal_ready' || current.proposal) {
      throw new ArenaRouteError(409, 'proposal_ready', 'Winner cannot be changed after an Arena proposal is ready.');
    }
    const branch = current.branches.find((item) => item.id === trimString(input.branchId));
    if (!branch) {
      throw new ArenaRouteError(404, 'branch_not_found', 'Arena branch not found.');
    }
    if (!isWinnerEligibleBranch(branch)) {
      throw new ArenaRouteError(409, 'branch_not_selectable', 'Winner must be a submitted or blocked Arena branch.');
    }
    const run = this.store.selectWinner(arenaId, {
      branchId: input.branchId,
      mode: 'manual_winner',
      reason: input.reason,
    });
    return this.store.appendTimeline(arenaId, {
      type: 'winner_selected',
      message: `Winner selected: ${input.branchId}`,
      branchId: input.branchId,
    });
  }

  createProposal(arenaId: string): ArenaRun {
    const run = this.getRun(arenaId);
    if (isTerminalArenaStatus(run.status)) {
      throw new ArenaRouteError(409, 'arena_terminal', 'Terminal Arena state cannot be changed.');
    }
    if (!run.winner) {
      throw new ArenaRouteError(409, 'winner_required', 'Select a winner before creating a proposal.');
    }
    if (run.status !== 'running' && run.status !== 'paused' && run.status !== 'judging') {
      throw new ArenaRouteError(409, 'invalid_arena_state', 'Arena cannot create a proposal in its current state.');
    }
    const diff = this.resolveWinnerWorkspaceDiff(run);
    if (!diff.sourceHash || !diff.branchHash) {
      throw new ArenaRouteError(409, 'proposal_not_required', 'Arena proposal is not required without source and branch workspaces.');
    }
    const proposal = {
      id: `proposal-${run.id}`,
      branchId: run.winner.branchId,
      status: 'ready' as const,
      changedFiles: diff.changedFiles,
      sourceHash: diff.sourceHash,
      branchHash: diff.branchHash,
      summary: `Arena proposal includes ${diff.changedFiles.length} changed file(s).`,
      createdAt: nowIso(),
    };
    this.store.setRunStatus(arenaId, 'proposal_ready');
    this.store.setProposal(arenaId, proposal);
    return this.store.appendTimeline(arenaId, { type: 'proposal_ready', message: 'Arena proposal is ready' });
  }

  apply(arenaId: string): ArenaRun {
    const current = this.getRun(arenaId);
    if (isTerminalArenaStatus(current.status)) {
      throw new ArenaRouteError(409, 'arena_terminal', 'Terminal Arena state cannot be changed.');
    }
    if (!current.winner) {
      throw new ArenaRouteError(409, 'winner_required', 'Select a winner before applying Arena result.');
    }
    const diff = this.resolveWinnerWorkspaceDiff(current);
    if (!current.proposal && diff.changedFiles.length > 0) {
      throw new ArenaRouteError(409, 'proposal_required', 'Create a proposal before applying Arena workspace changes.');
    }
    if (current.proposal && current.proposal.status !== 'ready') {
      throw new ArenaRouteError(409, 'proposal_not_ready', 'Arena proposal is not ready to apply.');
    }
    if (current.proposal) {
      if (!current.proposal.sourceHash || !current.proposal.branchHash) {
        throw new ArenaRouteError(409, 'proposal_incomplete', 'Arena proposal is missing workspace safety data.');
      }
      this.applyImplementationWinner(current);
    }
    const run = this.store.setRunStatus(arenaId, 'applied');
    if (current.proposal) {
      this.store.setProposal(arenaId, {
        ...current.proposal,
        status: 'applied',
        appliedAt: nowIso(),
      });
    }
    this.recordSourceConvergence(run);
    this.unlockSource(run);
    return this.store.appendTimeline(arenaId, { type: 'applied', message: 'Arena result applied' });
  }

  reopenBranch(arenaId: string, branchId: string): ArenaRun {
    const run = this.store.setBranchStatus(arenaId, branchId, 'reopened');
    return this.store.appendTimeline(arenaId, { type: 'branch_reopened', message: `Branch reopened: ${branchId}`, branchId });
  }

  promoteBranch(arenaId: string, branchId: string): ArenaRun {
    const current = this.getRun(arenaId);
    const currentBranch = current.branches.find((item) => item.id === branchId);
    if (!currentBranch?.sessionId) {
      throw new ArenaRouteError(409, 'branch_session_required', 'Arena branch must have a session before it can be promoted.');
    }
    const run = this.store.setBranchStatus(arenaId, branchId, 'promoted');
    const branch = run.branches.find((item) => item.id === branchId);
    if (branch?.sessionId) {
      this.deps.contextServices.updateContextNamespaceMetaSafe(
        { scope: 'session', namespace: branch.sessionId },
        {
          arenaBranch: {
            arenaId,
            branchId,
            sourceSessionId: run.sourceSessionId,
            promoted: true,
          },
        }
      );
    }
    return this.store.appendTimeline(arenaId, { type: 'branch_promoted', message: `Branch promoted: ${branchId}`, branchId });
  }

  private lockSource(run: ArenaRun): void {
    this.deps.contextServices.updateContextNamespaceMetaSafe(
      { scope: 'session', namespace: run.sourceSessionId },
      {
        arenaLock: {
          arenaId: run.id,
          lockedAt: nowIso(),
          mode: run.mode,
        },
      }
    );
  }

  private unlockSource(run: ArenaRun): void {
    this.deps.contextServices.updateContextNamespaceMetaSafe(
      { scope: 'session', namespace: run.sourceSessionId },
      { arenaLock: undefined }
    );
  }

  private resolveWinnerWorkspaceDiff(run: ArenaRun): { sourceHash?: string; branchHash?: string; changedFiles: string[] } {
    const sourceWorkspaceDir = trimString(run.workspaceSnapshot?.sourceWorkspaceDir);
    const winnerBranch = run.branches.find((branch) => branch.id === run.winner?.branchId);
    if (!sourceWorkspaceDir || !winnerBranch?.workspaceDir) {
      return { changedFiles: [] };
    }
    return diffArenaWorkspaces(sourceWorkspaceDir, winnerBranch.workspaceDir);
  }

  private applyImplementationWinner(run: ArenaRun): void {
    const proposal = run.proposal;
    const branch = run.branches.find((item) => item.id === proposal?.branchId);
    const sourceWorkspaceDir = trimString(run.workspaceSnapshot?.sourceWorkspaceDir);
    if (!proposal || !proposal.sourceHash || !sourceWorkspaceDir || !branch?.workspaceDir) {
      throw new ArenaRouteError(409, 'proposal_incomplete', 'Arena proposal is missing workspace safety data.');
    }
    try {
      applyArenaWorkspaceDiff({
        sourceDir: sourceWorkspaceDir,
        branchDir: branch.workspaceDir,
        expectedSourceHash: proposal.sourceHash,
        expectedBranchHash: proposal.branchHash ?? '',
        changedFiles: proposal.changedFiles,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/source workspace changed since proposal/i.test(message)) {
        throw new ArenaRouteError(409, 'stale_source', message);
      }
      if (/branch workspace changed since proposal/i.test(message)) {
        throw new ArenaRouteError(409, 'stale_branch', message);
      }
      throw error;
    }
  }

  private recordSourceConvergence(run: ArenaRun): void {
    const sourceRef: ContextRef = { scope: 'session', namespace: run.sourceSessionId };
    const sourceMeta = this.deps.contextServices.getContextNamespaceMetaSafe(sourceRef);
    const workspaceDir = trimString(sourceMeta?.workspaceDir);
    const winnerBranch = run.winner?.branchId ?? 'none';
    const winner = run.branches.find((branch) => branch.id === run.winner?.branchId);
    const changedFiles = run.proposal?.changedFiles ?? [];
    const summary = changedFiles.length === 0
      ? [
          `Arena ${run.id} applied winner ${winnerBranch}.`,
          winner?.submission?.finalAnswer ? `Winning answer:\n${winner.submission.finalAnswer}` : undefined,
          winner?.submission?.summary ? `Winner summary:\n${winner.submission.summary}` : undefined,
          run.winner?.reason ? `Manual selection reason:\n${run.winner.reason}` : undefined,
          run.judgeResult?.rationale ? `Judge rationale:\n${run.judgeResult.rationale}` : undefined,
        ].filter(Boolean).join('\n\n')
      : [
          `Arena ${run.id} applied workspace changes from winner ${winnerBranch}.`,
          run.proposal?.summary,
          changedFiles.length
            ? `Changed files:\n${changedFiles.map((item) => `- ${item}`).join('\n')}`
            : undefined,
          run.winner?.reason ? `Manual selection reason:\n${run.winner.reason}` : undefined,
          run.judgeResult?.rationale ? `Judge rationale:\n${run.judgeResult.rationale}` : undefined,
        ].filter(Boolean).join('\n\n');
    try {
      const turn = this.deps.agent.getContextManager().beginTurn(sourceRef, '[arena.apply]', workspaceDir || undefined, {
        rawUserPrompt: '[arena.apply]',
        historyUserPrompt: '[arena.apply]',
        effectivePrompt: '[arena.apply]',
        promptInjected: true,
      });
      this.deps.agent.getContextManager().commitTurn(turn.turnId, {
        messages: [
          { role: 'assistant', content: summary },
        ],
        finalOutputText: summary,
        finishReason: 'arena_applied',
      });
    } catch {
      this.store.appendTimeline(run.id, {
        type: 'source_convergence_record_failed',
        message: 'Arena result applied, but source convergence event could not be recorded.',
      });
    }
  }

  private createJudgeSession(run: ArenaRun): string {
    const judgeSessionId = createSessionNamespace();
    const name = `${run.sourceSessionName || run.sourceSessionId}-arena-judge`;
    this.deps.agent.getContextManager().forkSessionNamespace({
      sourceNamespace: run.sourceSessionId,
      targetNamespace: judgeSessionId,
      name,
      origin: 'web',
    });
    this.deps.agent.getContextManager().updateNamespaceMeta(
      { scope: 'session', namespace: judgeSessionId },
      {
        name,
        arenaLock: undefined,
        workspaceDir: undefined,
        toolsetName: 'windows-safe',
        llmSelection: run.config.judge.llmSelection,
        arenaJudge: {
          arenaId: run.id,
          sourceSessionId: run.sourceSessionId,
        },
      }
    );
    return judgeSessionId;
  }

  private startJudgeRun(run: ArenaRun, judgeSessionId: string): void {
    const judgeContext: ContextRef = { scope: 'session', namespace: judgeSessionId };
    const agent = this.deps.contextServices.resolveAgentForContext(judgeContext);
    void agent.run({
      prompt: this.buildJudgePrompt(run),
      context: judgeContext,
      additionalSystemPrompt: [
        '[ARENA_JUDGE]',
        `Arena id: ${run.id}`,
        'You are the Arena judge. Rank the branch submissions and explain rationale and risks.',
        'Do not modify files. Do not choose or apply the winner; the user must manually choose.',
        '[/ARENA_JUDGE]',
      ].join('\n'),
      agentRuntimeOverrides: {
        llmProfileId: run.config.judge.llmSelection.profileId,
        llmModel: run.config.judge.llmSelection.model,
        reasoningPreset: run.config.judge.llmSelection.reasoningPreset,
        toolsetName: 'windows-safe',
      },
    }).then((output) => {
      this.store.setJudgeResult(run.id, this.parseJudgeOutput(run, output));
      this.store.appendTimeline(run.id, {
        type: 'judge_completed',
        message: 'Arena judge completed',
      });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setJudgeResult(run.id, {
        status: 'failed',
        ranking: [],
        rationale: message,
        risks: [message],
        updatedAt: nowIso(),
      });
      this.store.appendTimeline(run.id, {
        type: 'judge_failed',
        message: `Arena judge failed: ${message}`,
      });
    });
  }

  private parseJudgeOutput(run: ArenaRun, output: string): NonNullable<ArenaRun['judgeResult']> {
    const rawOutput = trimString(output);
    const parsed = this.tryParseJudgeJson(rawOutput);
    const fallbackRanking = run.branches.map((branch, index) => ({
      branchId: branch.id,
      rank: index + 1,
    }));
    return {
      status: 'completed',
      ranking: parsed?.ranking?.length ? parsed.ranking : fallbackRanking,
      rationale: parsed?.rationale || rawOutput || 'Judge completed without rationale.',
      risks: parsed?.risks ?? [],
      ...(rawOutput ? { rawOutput } : {}),
      updatedAt: nowIso(),
    };
  }

  private tryParseJudgeJson(output: string): Pick<NonNullable<ArenaRun['judgeResult']>, 'ranking' | 'rationale' | 'risks'> | null {
    const trimmed = trimString(output);
    if (!trimmed) {
      return null;
    }
    const jsonText = trimmed.startsWith('{')
      ? trimmed
      : trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? '';
    if (!jsonText) {
      return null;
    }
    try {
      const parsed = JSON.parse(jsonText) as {
        ranking?: Array<{ branchId?: unknown; rank?: unknown; rationale?: unknown }>;
        rationale?: unknown;
        risks?: unknown[];
      };
      const ranking = Array.isArray(parsed.ranking)
        ? parsed.ranking
            .map((item, index) => ({
              branchId: trimString(item.branchId),
              rank: Number.isFinite(Number(item.rank)) ? Math.max(1, Math.trunc(Number(item.rank))) : index + 1,
              ...(trimString(item.rationale) ? { rationale: trimString(item.rationale) } : {}),
            }))
            .filter((item) => item.branchId)
        : [];
      const risks = Array.isArray(parsed.risks)
        ? parsed.risks.map((item) => trimString(item)).filter(Boolean)
        : [];
      return {
        ranking,
        rationale: trimString(parsed.rationale),
        risks,
      };
    } catch {
      return null;
    }
  }

  private buildJudgePrompt(run: ArenaRun): string {
    const branches = run.branches.map((branch) => ({
      branchId: branch.id,
      label: branch.contestant.label,
      status: branch.status,
      submission: branch.submission ?? null,
      changedFiles: branch.submission?.changedFiles ?? [],
      risks: branch.submission?.risks ?? [],
    }));
    return [
      'Review these Arena branch submissions and return a ranking recommendation.',
      'Return JSON with fields: ranking [{ branchId, rank, rationale }], rationale, risks.',
      'Include rationale and risks. Do not select a final winner.',
      JSON.stringify({
        arenaId: run.id,
        mode: run.mode,
        prompt: run.prompt,
        branches,
      }, null, 2),
    ].join('\n\n');
  }

  private startBranchRun(run: ArenaRun, branch: ArenaBranch): void {
    const branchSessionId = branch.sessionId;
    if (!branchSessionId) {
      return;
    }
    const branchContext: ContextRef = { scope: 'session', namespace: branchSessionId };
    const agent = this.deps.contextServices.resolveAgentForContext(branchContext);
    void agent.run({
      prompt: run.prompt || 'Continue this Arena branch and submit the final result with arena_submit_result.',
      context: branchContext,
      additionalSystemPrompt: this.buildBranchSystemPrompt(run, branch),
      workspaceDir: branch.workspaceDir,
      agentRuntimeOverrides: {
        llmProfileId: branch.contestant.llmSelection.profileId,
        llmModel: branch.contestant.llmSelection.model,
        reasoningPreset: branch.contestant.llmSelection.reasoningPreset,
        toolsetName: trimString(branch.workspaceDir) ? 'arena-implementation' : 'windows-safe',
      },
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setBranchStatus(run.id, branch.id, 'failed');
      this.store.appendTimeline(run.id, {
        type: 'branch_failed',
        message: `Branch failed: ${message}`,
        branchId: branch.id,
      });
    });
  }

  private cancelBranchRun(branch: ArenaBranch): void {
    if (!branch.sessionId) {
      return;
    }
    const branchContext: ContextRef = { scope: 'session', namespace: branch.sessionId };
    try {
      this.deps.contextServices.resolveAgentForContext(branchContext).cancelContext(branchContext);
    } catch {
      // Branch cancellation is best-effort; state transition still records the Arena control action.
    }
  }

  private buildBranchSystemPrompt(run: ArenaRun, branch: ArenaBranch): string {
    const sourceWorkspace = trimString(run.workspaceSnapshot?.sourceWorkspaceDir) || '(none)';
    const branchWorkspace = trimString(branch.workspaceDir) || '(session-only)';
    return [
      '[ARENA_BRANCH]',
      `Arena id: ${run.id}`,
      `Branch id: ${branch.id}`,
      `Source session: ${run.sourceSessionId}`,
      `Source workspace is read-only: ${sourceWorkspace}`,
      `Branch workspace: ${branchWorkspace}`,
      'Do not modify the source workspace. If the task needs file changes, make them only inside the branch workspace.',
      'If the task only needs an answer, leave files unchanged and submit the answer.',
      'When your loop is complete, call arena_submit_result with status complete or blocked.',
      'Do not claim the Arena is complete without calling arena_submit_result.',
      '[/ARENA_BRANCH]',
    ].join('\n');
  }
}
