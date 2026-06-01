import type { ContextRef } from '../types.js';

export type WorkspaceTrustLevel = 'trusted' | 'git_observed' | 'observed_partial' | 'untrusted';
export type WorkspaceRepoKind = 'git' | 'git_unborn' | 'plain';
export type WorkspaceDeltaStatus = 'pending' | 'prepared' | 'committed' | 'aborted' | 'incomplete';
export type WorkspaceDeltaOperation = 'add' | 'modify' | 'delete';

export interface WorkspaceTimelineConfig {
  enabled: boolean;
  captureMode: 'advisory' | 'trusted_tools' | 'git_observed';
  retainedStageTurns: number;
  gitPrivateRefs: boolean;
}

export interface WorkspaceBlobIdentity {
  sha256: string;
  size: number;
  blobRef: string;
}

export interface WorkspaceManifestEntry {
  path: string;
  sha256: string;
  size: number;
  blobRef: string;
}

export interface WorkspaceRevision {
  id: string;
  workspaceId: string;
  workspaceDir: string;
  parentRevisionId?: string;
  repoKind: WorkspaceRepoKind;
  manifestId: string;
  manifestTrust: 'complete' | 'partial';
  trustLevel: WorkspaceTrustLevel;
  source: 'turn_begin' | 'turn_commit' | 'arena_branch' | 'rollback' | 'external_wip';
  context?: ContextRef;
  turnId?: string;
  createdAt: string;
}

export interface WorkspaceDeltaEntry {
  path: string;
  operation: WorkspaceDeltaOperation;
  base?: WorkspaceBlobIdentity;
  next?: WorkspaceBlobIdentity;
  fileMode?: string;
  binary?: boolean;
  diffPreviewBlobId?: string;
}

export interface TurnWorkspaceDelta {
  id: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  baseRevisionId: string;
  resultRevisionId?: string;
  status: WorkspaceDeltaStatus;
  trustLevel: WorkspaceTrustLevel;
  entries: WorkspaceDeltaEntry[];
  changedFiles: string[];
  captureWarnings: string[];
  auditOnly?: boolean;
  createdAt: string;
  preparedAt?: string;
  committedAt?: string;
  abortedAt?: string;
  retention?: {
    protected: boolean;
    blobState: 'available' | 'summary_only';
    prunedAt?: string;
  };
}

export interface WorkspaceTurnHandle {
  id: string;
  context: ContextRef;
  sessionId: string;
  turnId: string;
  workspaceDir: string;
  workspaceId: string;
  baseRevisionId: string;
  deltaId: string;
  startedAt: string;
}

export interface PreparedWorkspaceDelta {
  delta: TurnWorkspaceDelta;
  resultRevision: WorkspaceRevision;
}

export interface WorkspaceTimelineSummary {
  sessionId: string;
  retainedStageTurns: number;
  deltas: Array<{
    id: string;
    turnId: string;
    status: WorkspaceDeltaStatus;
    trustLevel: WorkspaceTrustLevel;
    changedFiles: string[];
    captureWarnings: string[];
    auditOnly: boolean;
    blobState: 'available' | 'summary_only';
    createdAt: string;
    committedAt?: string;
    resultRevisionId?: string;
  }>;
}

export interface WorkspaceRecoveryReport {
  recovered: string[];
  aborted: string[];
}

export interface WorkspaceRollbackApplyResult {
  sessionId: string;
  targetRevisionId: string;
  workspaceDir: string;
  changedFiles: string[];
  appliedAt: string;
}
