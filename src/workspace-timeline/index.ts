import type { WorkspaceTimelineConfig } from './types.js';

export {
  WorkspaceTimelineStore,
  type BeginWorkspaceTurnInput,
  type AbortWorkspaceDeltaInput,
  type WorkspaceTimelineStoreOptions,
} from './WorkspaceTimelineStore.js';
export {
  TurnWorkspaceTransactionCoordinator,
  type BeginWorkspaceTransactionInput,
} from './TurnWorkspaceTransactionCoordinator.js';
export type {
  PreparedWorkspaceDelta,
  TurnWorkspaceDelta,
  WorkspaceBlobIdentity,
  WorkspaceDeltaEntry,
  WorkspaceDeltaOperation,
  WorkspaceDeltaStatus,
  WorkspaceManifestEntry,
  WorkspaceRecoveryReport,
  WorkspaceRepoKind,
  WorkspaceRevision,
  WorkspaceTimelineConfig,
  WorkspaceTimelineSummary,
  WorkspaceTrustLevel,
  WorkspaceTurnHandle,
} from './types.js';

export const DEFAULT_WORKSPACE_TIMELINE_CONFIG = {
  enabled: false,
  captureMode: 'advisory',
  retainedStageTurns: 5,
  gitPrivateRefs: false,
} as const;

export function normalizeWorkspaceTimelineConfig(value: unknown): WorkspaceTimelineConfig {
  const data = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const captureMode = data.captureMode === 'trusted_tools' || data.captureMode === 'git_observed'
    ? data.captureMode
    : 'advisory';
  const retainedRaw = Number(data.retainedStageTurns ?? DEFAULT_WORKSPACE_TIMELINE_CONFIG.retainedStageTurns);
  return {
    enabled: data.enabled === true,
    captureMode,
    retainedStageTurns: Math.max(1, Math.min(20, Number.isFinite(retainedRaw) ? Math.floor(retainedRaw) : 5)),
    gitPrivateRefs: data.gitPrivateRefs === true,
  };
}
