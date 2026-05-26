import type {
  ContextRef,
  DraftTurnRecord,
  ReplayCheckpointSnapshot,
} from '../types.js';
import { InterruptedTurnStore } from './InterruptedTurnStore.js';
import type { PendingTurn } from './context-manager-contracts.js';

interface QueuedReplayCheckpoint {
  ref: ContextRef;
  draft: Omit<DraftTurnRecord, 'checkpoint'>;
  checkpoint: ReplayCheckpointSnapshot;
}

export interface ReplayCheckpointCoordinatorOptions {
  interruptedTurnStore: InterruptedTurnStore;
  getPendingTurn: (turnId: string) => PendingTurn | undefined;
  warn?: (message: string) => void;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class ReplayCheckpointCoordinator {
  private readonly interruptedTurnStore: InterruptedTurnStore;
  private readonly getPendingTurn: (turnId: string) => PendingTurn | undefined;
  private readonly warn: (message: string) => void;
  private readonly queue = new Map<string, QueuedReplayCheckpoint>();
  private readonly timers = new Map<string, ReturnType<typeof setImmediate>>();

  constructor(options: ReplayCheckpointCoordinatorOptions) {
    this.interruptedTurnStore = options.interruptedTurnStore;
    this.getPendingTurn = options.getPendingTurn;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  enqueue(
    turnId: string,
    ref: ContextRef,
    draft: Omit<DraftTurnRecord, 'checkpoint'>,
    checkpoint: ReplayCheckpointSnapshot
  ): void {
    this.queue.set(turnId, {
      ref,
      draft: cloneRecord(draft),
      checkpoint: cloneRecord(checkpoint),
    });
    if (this.timers.has(turnId)) {
      return;
    }
    const timer = setImmediate(() => {
      this.timers.delete(turnId);
      this.flushTurn(turnId, { mandatory: false });
    });
    this.timers.set(turnId, timer);
  }

  flush(turnId?: string): void {
    if (turnId) {
      this.flushTurn(turnId, { mandatory: true });
      return;
    }
    for (const queuedTurnId of Array.from(this.queue.keys())) {
      this.flushTurn(queuedTurnId, { mandatory: true });
    }
  }

  flushForRef(ref: ContextRef): void {
    for (const [turnId, queued] of Array.from(this.queue.entries())) {
      if (queued.ref.scope === ref.scope && queued.ref.namespace === ref.namespace) {
        this.flushTurn(turnId, { mandatory: true });
      }
    }
  }

  drop(turnId: string): void {
    const timer = this.timers.get(turnId);
    if (timer) {
      clearImmediate(timer);
      this.timers.delete(turnId);
    }
    this.queue.delete(turnId);
  }

  private flushTurn(turnId: string, options: { mandatory: boolean }): void {
    const timer = this.timers.get(turnId);
    if (timer) {
      clearImmediate(timer);
      this.timers.delete(turnId);
    }
    const queued = this.queue.get(turnId);
    if (!queued) {
      return;
    }
    const pending = this.getPendingTurn(turnId);
    if (!pending) {
      this.queue.delete(turnId);
      return;
    }
    if (!pending.draftId || pending.ref.scope !== queued.ref.scope || pending.ref.namespace !== queued.ref.namespace) {
      const message = `Replay checkpoint flush blocked by mismatched pending turn for ${turnId}`;
      if (options.mandatory) {
        throw new Error(message);
      }
      this.warn(`[ContextManager] ${message}`);
      return;
    }
    const currentDraft = this.interruptedTurnStore.loadDraft(queued.ref);
    if (!currentDraft || currentDraft.turnId !== turnId || currentDraft.draftId !== queued.draft.draftId) {
      const message = `Replay checkpoint flush blocked by unreadable or mismatched draft for ${turnId}`;
      if (options.mandatory) {
        throw new Error(message);
      }
      this.warn(`[ContextManager] ${message}`);
      return;
    }
    try {
      this.interruptedTurnStore.appendDraftCheckpoint(queued.ref, queued.draft, queued.checkpoint);
      this.queue.delete(turnId);
    } catch (error) {
      if (options.mandatory) {
        throw error;
      }
      this.warn(
        `[ContextManager] Failed to flush replay checkpoint for turn ${turnId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
