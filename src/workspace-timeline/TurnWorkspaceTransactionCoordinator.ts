import type { ContextManager } from '../context/ContextManager.js';
import type {
  CommitTurnInput,
  CommitTurnResult,
} from '../context/context-manager-contracts.js';
import type { ContextRef } from '../types.js';
import { WorkspaceTimelineStore } from './WorkspaceTimelineStore.js';
import type {
  PreparedWorkspaceDelta,
  WorkspaceRecoveryReport,
  WorkspaceTurnHandle,
} from './types.js';

export interface BeginWorkspaceTransactionInput {
  context: ContextRef;
  turnId: string;
  workspaceDir?: string;
}

export class TurnWorkspaceTransactionCoordinator {
  constructor(
    private readonly options: {
      contextManager: ContextManager;
      timelineStore: WorkspaceTimelineStore;
    }
  ) {}

  beginTurn(input: BeginWorkspaceTransactionInput): WorkspaceTurnHandle | null {
    return this.options.timelineStore.beginTurn(input);
  }

  prepareTurnDelta(handle: WorkspaceTurnHandle | null): PreparedWorkspaceDelta | null {
    if (!handle) {
      return null;
    }
    if (!this.options.timelineStore.isEnabled()) {
      this.options.timelineStore.abortDelta({
        deltaId: handle.deltaId,
        reason: 'Workspace Timeline was disabled before turn commit.',
      });
      return null;
    }
    return this.options.timelineStore.prepareTurnDelta(handle);
  }

  commitPreparedTurn(
    turnId: string,
    handle: WorkspaceTurnHandle | null,
    commit: CommitTurnInput
  ): CommitTurnResult {
    let prepared: PreparedWorkspaceDelta | null = null;
    let contextCommitted = false;
    try {
      prepared = this.prepareTurnDelta(handle);
      const commitResult = this.options.contextManager.commitTurn(turnId, {
        ...commit,
        workspaceTimeline: prepared
          ? {
              deltaId: prepared.delta.id,
              revisionId: prepared.resultRevision.id,
              trustLevel: prepared.delta.trustLevel,
              changedFiles: prepared.delta.changedFiles,
              captureWarnings: prepared.delta.captureWarnings,
              auditOnly: prepared.delta.auditOnly ?? false,
            }
          : undefined,
      } as CommitTurnInput);
      contextCommitted = true;
      if (prepared) {
        try {
          this.options.timelineStore.markCommitted(prepared.delta.id);
        } catch {
          // The context event is the source of truth once committed. Leave the
          // prepared delta for startup recovery instead of turning the whole run
          // into an interrupted turn after the user-visible answer was saved.
        }
      }
      return commitResult;
    } catch (error) {
      if (prepared && !contextCommitted) {
        this.options.timelineStore.abortDelta({
          deltaId: prepared.delta.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      } else if (handle && !contextCommitted) {
        this.options.timelineStore.abortDelta({
          deltaId: handle.deltaId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  recoverPreparedCommits(): WorkspaceRecoveryReport {
    return this.options.timelineStore.recoverPreparedCommits({
      isContextCommitted: (delta) => {
        const revision = (delta.resultRevisionId ? this.options.timelineStore.getRevision(delta.resultRevisionId) : null)
          ?? this.options.timelineStore.getRevision(delta.baseRevisionId);
        const context = revision?.context ?? { scope: 'session' as const, namespace: delta.sessionId };
        return this.options.contextManager
          .getEventStore()
          .readEvents(context.scope, context.namespace)
          .some((event) => {
            const metadata = (event.data as { workspaceTimeline?: { deltaId?: string } } | undefined)?.workspaceTimeline;
            return event.type === 'turn_committed' && metadata?.deltaId === delta.id;
          });
      },
    });
  }

  abortTurn(handle: WorkspaceTurnHandle | null, reason: string): void {
    if (!handle) {
      return;
    }
    this.options.timelineStore.abortDelta({
      deltaId: handle.deltaId,
      reason,
    });
  }
}
