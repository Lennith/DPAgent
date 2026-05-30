import type { SessionLlmSelection } from '../types.js';

export type ArenaMode = 'answer' | 'implementation';
export type ArenaEntryType = 'normal' | 'finalized_plan';

export type ArenaRunStatus =
  | 'draft'
  | 'preparing'
  | 'running'
  | 'paused'
  | 'judging'
  | 'proposal_ready'
  | 'applied'
  | 'closed';

export type ArenaBranchStatus =
  | 'draft'
  | 'preparing'
  | 'running'
  | 'paused'
  | 'submitted'
  | 'reopened'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'frozen'
  | 'promoted';

export interface ArenaContestantConfig {
  id: string;
  label: string;
  agentName?: string;
  llmSelection: SessionLlmSelection;
}

export interface ArenaJudgeConfig {
  agentName?: string;
  llmSelection: SessionLlmSelection;
}

export interface ArenaConfig {
  contestants: ArenaContestantConfig[];
  judge: ArenaJudgeConfig;
}

export interface ArenaWorkspaceSnapshot {
  sourceWorkspaceDir?: string;
  strategy?: 'git_worktree' | 'directory_copy' | 'answer_only';
  dirtyCopied?: boolean;
  capturedAt: string;
}

export interface ArenaBranchWorkspaceSnapshot {
  workspaceDir: string;
  strategy: 'git_worktree' | 'directory_copy' | 'answer_only';
  dirtyCopied: boolean;
  capturedAt: string;
}

export interface ArenaSubmission {
  status: 'complete' | 'blocked';
  summary: string;
  finalAnswer?: string;
  evidence: string[];
  changedFiles?: string[];
  risks?: string[];
  submittedAt: string;
}

export interface ArenaBranch {
  id: string;
  arenaId: string;
  index: number;
  status: ArenaBranchStatus;
  contestant: ArenaContestantConfig;
  sessionId?: string;
  workspaceDir?: string;
  workspaceSnapshot?: ArenaBranchWorkspaceSnapshot;
  promoted?: boolean;
  submission?: ArenaSubmission;
  createdAt: string;
  updatedAt: string;
}

export interface ArenaTimelineEntry {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  branchId?: string;
}

export interface ArenaWinnerSelection {
  branchId: string;
  mode: 'manual_winner' | 'judge_recommended';
  selectedAt: string;
  reason?: string;
}

export interface ArenaMergeProposal {
  id: string;
  branchId: string;
  status: 'draft' | 'ready' | 'applied' | 'stale' | 'conflict';
  changedFiles: string[];
  sourceHash?: string;
  branchHash?: string;
  summary: string;
  createdAt: string;
  appliedAt?: string;
}

export interface ArenaJudgeResult {
  status: 'completed' | 'failed';
  ranking: Array<{
    branchId: string;
    rank: number;
    rationale?: string;
  }>;
  rationale: string;
  risks: string[];
  rawOutput?: string;
  updatedAt: string;
}

export interface ArenaRun {
  id: string;
  sourceSessionId: string;
  sourceSessionName: string;
  sourceEventCount: number;
  mode: ArenaMode;
  entryType: ArenaEntryType;
  prompt: string;
  frozenPlanId?: string;
  status: ArenaRunStatus;
  config: ArenaConfig;
  branches: ArenaBranch[];
  workspaceSnapshot?: ArenaWorkspaceSnapshot;
  winner?: ArenaWinnerSelection;
  proposal?: ArenaMergeProposal;
  judgeRunId?: string;
  judgeResult?: ArenaJudgeResult;
  timeline: ArenaTimelineEntry[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface CreateArenaDraftInput {
  sourceSessionId: string;
  sourceSessionName?: string;
  sourceEventCount: number;
  mode?: ArenaMode;
  entryType?: ArenaEntryType;
  prompt?: string;
  frozenPlanId?: string;
  currentLlmSelection: SessionLlmSelection;
  config?: Partial<ArenaConfig>;
  workspaceSnapshot?: Omit<ArenaWorkspaceSnapshot, 'capturedAt'>;
}

export interface UpdateArenaConfigInput {
  contestants?: ArenaContestantConfig[];
  judge?: ArenaJudgeConfig;
}

export interface ArenaStoreState {
  runs: ArenaRun[];
  lastConfig?: ArenaConfig;
}
