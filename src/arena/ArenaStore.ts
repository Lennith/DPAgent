import * as fs from 'node:fs';
import * as path from 'node:path';
import { createStateId, nowIso, readJsonStateFile, writeJsonStateFile } from '../storage/index.js';
import type {
  ArenaBranch,
  ArenaBranchStatus,
  ArenaConfig,
  ArenaContestantConfig,
  ArenaJudgeConfig,
  ArenaJudgeResult,
  ArenaMergeProposal,
  ArenaRun,
  ArenaRunStatus,
  ArenaStoreState,
  ArenaSubmission,
  ArenaWinnerSelection,
  CreateArenaDraftInput,
  UpdateArenaConfigInput,
} from './types.js';

const MAX_CONTESTANTS = 4;

function trimString(value: unknown): string {
  return String(value ?? '').trim();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createId(prefix: string): string {
  return createStateId(prefix, 5);
}

function normalizeContestants(contestants: ArenaContestantConfig[]): ArenaContestantConfig[] {
  if (contestants.length < 1 || contestants.length > MAX_CONTESTANTS) {
    throw new Error(`Arena requires 1-${MAX_CONTESTANTS} contestants`);
  }
  return contestants.map((item, index) => {
    const id = trimString(item.id) || `contestant-${index + 1}`;
    const label = trimString(item.label) || `Contestant ${index + 1}`;
    const profileId = trimString(item.llmSelection?.profileId);
    const model = trimString(item.llmSelection?.model);
    if (!profileId || !model) {
      throw new Error(`Arena contestant ${index + 1} requires llmSelection profileId and model`);
    }
    return {
      id,
      label,
      ...(trimString(item.agentName) ? { agentName: trimString(item.agentName) } : {}),
      llmSelection: {
        ...item.llmSelection,
        profileId,
        model,
        updatedAt: trimString(item.llmSelection.updatedAt) || nowIso(),
      },
    };
  });
}

function normalizeJudge(judge: ArenaJudgeConfig): ArenaJudgeConfig {
  const profileId = trimString(judge.llmSelection?.profileId);
  const model = trimString(judge.llmSelection?.model);
  if (!profileId || !model) {
    throw new Error('Arena judge requires llmSelection profileId and model');
  }
  return {
    ...(trimString(judge.agentName) ? { agentName: trimString(judge.agentName) } : {}),
    llmSelection: {
      ...judge.llmSelection,
      profileId,
      model,
      updatedAt: trimString(judge.llmSelection.updatedAt) || nowIso(),
    },
  };
}

function normalizeConfig(config: ArenaConfig): ArenaConfig {
  return {
    contestants: normalizeContestants(config.contestants),
    judge: normalizeJudge(config.judge),
  };
}

function createDefaultContestants(selection: ArenaContestantConfig['llmSelection']): ArenaContestantConfig[] {
  return [1, 2].map((index) => ({
    id: `contestant-${index}`,
    label: `Contestant ${index}`,
    llmSelection: {
      ...selection,
      updatedAt: selection.updatedAt || nowIso(),
    },
  }));
}

function toBranches(arenaId: string, contestants: ArenaContestantConfig[], createdAt: string): ArenaBranch[] {
  return contestants.map((contestant, index) => ({
    id: `branch-${index + 1}`,
    arenaId,
    index,
    status: 'draft',
    contestant: cloneJson(contestant),
    createdAt,
    updatedAt: createdAt,
  }));
}

function assertStatusTransition(current: ArenaRunStatus, next: ArenaRunStatus): void {
  const allowed: Record<ArenaRunStatus, ArenaRunStatus[]> = {
    draft: ['preparing', 'closed'],
    preparing: ['running', 'paused', 'closed'],
    running: ['paused', 'judging', 'proposal_ready', 'applied', 'closed'],
    paused: ['running', 'judging', 'proposal_ready', 'applied', 'closed'],
    judging: ['proposal_ready', 'applied', 'closed'],
    proposal_ready: ['applied', 'closed'],
    applied: [],
    closed: [],
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid Arena status transition: ${current} -> ${next}`);
  }
}

function assertBranchStatusTransition(current: ArenaBranchStatus, next: ArenaBranchStatus): void {
  const allowed: Record<ArenaBranchStatus, ArenaBranchStatus[]> = {
    draft: ['preparing', 'cancelled'],
    preparing: ['running', 'paused', 'failed', 'cancelled'],
    running: ['paused', 'submitted', 'blocked', 'failed', 'cancelled'],
    paused: ['running', 'cancelled'],
    submitted: ['reopened', 'frozen', 'promoted'],
    reopened: ['running', 'paused', 'submitted', 'blocked', 'failed', 'cancelled'],
    blocked: ['reopened', 'frozen', 'promoted'],
    failed: ['reopened', 'cancelled'],
    cancelled: ['reopened'],
    frozen: ['promoted'],
    promoted: [],
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid Arena branch status transition: ${current} -> ${next}`);
  }
}

export class ArenaStore {
  private readonly baseDir: string;
  private readonly statePath: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.statePath = path.join(this.baseDir, 'arena.json');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  listRuns(): ArenaRun[] {
    return this.readState().runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getRun(id: string): ArenaRun | undefined {
    const normalized = trimString(id);
    return this.listRuns().find((run) => run.id === normalized);
  }

  getActiveRunForSource(sourceSessionId: string): ArenaRun | undefined {
    const source = trimString(sourceSessionId);
    return this.listRuns().find(
      (run) => run.sourceSessionId === source && run.status !== 'applied' && run.status !== 'closed'
    );
  }

  getLastConfig(): ArenaConfig | undefined {
    const config = this.readState().lastConfig;
    return config ? cloneJson(config) : undefined;
  }

  createDraft(input: CreateArenaDraftInput): ArenaRun {
    const now = nowIso();
    const sourceSessionId = trimString(input.sourceSessionId);
    if (!sourceSessionId) {
      throw new Error('Arena sourceSessionId is required');
    }
    const inherited = this.getLastConfig();
    const config = normalizeConfig({
      contestants:
        input.config?.contestants ??
        inherited?.contestants ??
        createDefaultContestants(input.currentLlmSelection),
      judge: input.config?.judge ?? inherited?.judge ?? { llmSelection: input.currentLlmSelection },
    });
    const id = createId('arena');
    const sourceName = trimString(input.sourceSessionName) || input.sourceSessionId;
    const run: ArenaRun = {
      id,
      sourceSessionId,
      sourceSessionName: sourceName,
      sourceEventCount: Math.max(0, Math.trunc(input.sourceEventCount)),
      mode: input.mode ?? 'answer',
      entryType: input.entryType ?? 'normal',
      prompt: trimString(input.prompt),
      ...(trimString(input.frozenPlanId) ? { frozenPlanId: trimString(input.frozenPlanId) } : {}),
      status: 'draft',
      config,
      branches: toBranches(id, config.contestants, now),
      ...(input.workspaceSnapshot
        ? { workspaceSnapshot: { ...input.workspaceSnapshot, capturedAt: now } }
        : {}),
      timeline: [
        {
          id: createId('arena-event'),
          type: 'created',
          message: `Arena created for ${sourceName}`,
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    this.writeState({
      ...this.readState(),
      runs: [run, ...this.listRuns()],
      lastConfig: cloneJson(config),
    });
    return cloneJson(run);
  }

  updateConfig(arenaId: string, input: UpdateArenaConfigInput): ArenaRun {
    return this.updateRun(arenaId, (run) => {
      if (run.status !== 'draft') {
        throw new Error('Arena config can only be changed while draft');
      }
      const nextConfig = normalizeConfig({
        contestants: input.contestants ?? run.config.contestants,
        judge: input.judge ?? run.config.judge,
      });
      return {
        ...run,
        config: nextConfig,
        branches: toBranches(run.id, nextConfig.contestants, run.createdAt),
      };
    }, { updateLastConfig: true });
  }

  setRunStatus(arenaId: string, status: ArenaRunStatus): ArenaRun {
    return this.updateRun(arenaId, (run) => {
      assertStatusTransition(run.status, status);
      return {
        ...run,
        status,
        ...(status === 'closed' ? { closedAt: nowIso() } : {}),
      };
    });
  }

  setBranchStatus(arenaId: string, branchId: string, status: ArenaBranchStatus): ArenaRun {
    return this.updateBranch(arenaId, branchId, (branch, run) => {
      if (
        status === 'reopened' &&
        (run.status === 'judging' || run.status === 'proposal_ready' || run.status === 'applied' || run.status === 'closed')
      ) {
        throw new Error('Arena branch cannot reopen after judge has started');
      }
      assertBranchStatusTransition(branch.status, status);
      return {
        ...branch,
        status,
        promoted: status === 'promoted' ? true : branch.promoted,
      };
    });
  }

  assignBranchSession(input: {
    arenaId: string;
    branchId: string;
    sessionId: string;
    workspaceDir?: string;
    workspaceSnapshot?: ArenaBranch['workspaceSnapshot'];
  }): ArenaRun {
    const sessionId = trimString(input.sessionId);
    if (!sessionId) {
      throw new Error('Arena branch sessionId is required');
    }
    return this.updateBranch(input.arenaId, input.branchId, (branch) => ({
      ...branch,
      sessionId,
      ...(trimString(input.workspaceDir) ? { workspaceDir: trimString(input.workspaceDir) } : {}),
      ...(input.workspaceSnapshot ? { workspaceSnapshot: cloneJson(input.workspaceSnapshot) } : {}),
    }));
  }

  submitBranchResult(input: {
    arenaId: string;
    branchId: string;
    submission: Omit<ArenaSubmission, 'submittedAt'>;
  }): ArenaRun {
    const status = input.submission.status;
    return this.updateBranch(input.arenaId, input.branchId, (branch) => {
      if (branch.status !== 'running' && branch.status !== 'reopened') {
        throw new Error(`Arena branch cannot submit from status: ${branch.status}`);
      }
      return {
        ...branch,
        status: status === 'complete' ? 'submitted' : 'blocked',
        submission: {
          status,
          summary: trimString(input.submission.summary),
          ...(trimString(input.submission.finalAnswer) ? { finalAnswer: trimString(input.submission.finalAnswer) } : {}),
          evidence: input.submission.evidence.map((item) => trimString(item)).filter(Boolean),
          ...(input.submission.changedFiles
            ? { changedFiles: input.submission.changedFiles.map((item) => trimString(item)).filter(Boolean) }
            : {}),
          ...(input.submission.risks
            ? { risks: input.submission.risks.map((item) => trimString(item)).filter(Boolean) }
            : {}),
          submittedAt: nowIso(),
        },
      };
    });
  }

  selectWinner(
    arenaId: string,
    winner: Omit<ArenaWinnerSelection, 'selectedAt'>
  ): ArenaRun {
    const branchId = trimString(winner.branchId);
    if (!branchId) {
      throw new Error('Arena winner branchId is required');
    }
    return this.updateRun(arenaId, (run) => {
      if (!run.branches.some((branch) => branch.id === branchId)) {
        throw new Error(`Arena branch not found: ${branchId}`);
      }
      return {
        ...run,
        winner: {
          ...winner,
          branchId,
          selectedAt: nowIso(),
          ...(trimString(winner.reason) ? { reason: trimString(winner.reason) } : {}),
        },
      };
    });
  }

  setProposal(arenaId: string, proposal: ArenaMergeProposal): ArenaRun {
    return this.updateRun(arenaId, (run) => ({
      ...run,
      proposal: cloneJson(proposal),
    }));
  }

  setJudgeRun(arenaId: string, judgeRunId: string): ArenaRun {
    const normalized = trimString(judgeRunId);
    if (!normalized) {
      throw new Error('Arena judgeRunId is required');
    }
    return this.updateRun(arenaId, (run) => ({
      ...run,
      judgeRunId: normalized,
    }));
  }

  setJudgeResult(arenaId: string, result: ArenaJudgeResult): ArenaRun {
    return this.updateRun(arenaId, (run) => ({
      ...run,
      judgeResult: cloneJson(result),
    }));
  }

  appendTimeline(arenaId: string, input: { type: string; message: string; branchId?: string }): ArenaRun {
    return this.updateRun(arenaId, (run) => ({
      ...run,
      timeline: [
        ...run.timeline,
        {
          id: createId('arena-event'),
          type: trimString(input.type) || 'event',
          message: trimString(input.message) || 'Arena updated',
          createdAt: nowIso(),
          ...(trimString(input.branchId) ? { branchId: trimString(input.branchId) } : {}),
        },
      ],
    }));
  }

  private updateBranch(
    arenaId: string,
    branchId: string,
    mutator: (branch: ArenaBranch, run: ArenaRun) => ArenaBranch
  ): ArenaRun {
    return this.updateRun(arenaId, (run) => {
      const normalizedBranchId = trimString(branchId);
      let found = false;
      const branches = run.branches.map((branch) => {
        if (branch.id !== normalizedBranchId) {
          return branch;
        }
        found = true;
        const next = mutator(branch, run);
        return {
          ...next,
          id: branch.id,
          arenaId: run.id,
          updatedAt: nowIso(),
        };
      });
      if (!found) {
        throw new Error(`Arena branch not found: ${branchId}`);
      }
      return { ...run, branches };
    });
  }

  private updateRun(
    arenaId: string,
    mutator: (run: ArenaRun) => ArenaRun,
    options: { updateLastConfig?: boolean } = {}
  ): ArenaRun {
    const normalizedId = trimString(arenaId);
    const state = this.readState();
    const index = state.runs.findIndex((run) => run.id === normalizedId);
    if (index < 0) {
      throw new Error(`Arena not found: ${arenaId}`);
    }
    const current = state.runs[index];
    const updatedAt = nowIso();
    const nextRun = {
      ...mutator(cloneJson(current)),
      id: current.id,
      updatedAt,
    };
    const nextRuns = [...state.runs];
    nextRuns[index] = nextRun;
    const nextState: ArenaStoreState = {
      runs: nextRuns,
      lastConfig: options.updateLastConfig ? cloneJson(nextRun.config) : state.lastConfig,
    };
    this.writeState(nextState);
    return cloneJson(nextRun);
  }

  private readState(): ArenaStoreState {
    return readJsonStateFile<ArenaStoreState>(this.statePath, { runs: [] });
  }

  private writeState(state: ArenaStoreState): void {
    writeJsonStateFile(this.statePath, state);
  }
}
