import * as crypto from 'crypto';
import type {
  ContextTransaction,
  ContextValidationResult,
  ContextVersionChain,
} from './ContextManager.js';
import type { ContextEvent, ContextProjection, ContextRef } from '../types.js';
import { ContextEventStore } from './ContextEventStore.js';

interface PendingTransaction {
  transaction: ContextTransaction;
  bufferedEvents: ContextEvent[];
}

export interface ContextTransactionCoordinatorOptions {
  eventStore: ContextEventStore;
  getProjection: (ref: ContextRef) => ContextProjection;
  checkContextIntegrity: (ref: ContextRef) => {
    valid: boolean;
    projection: ContextProjection;
    versionChain: ContextVersionChain;
    integrityHash: string;
  };
  validateVersionChain: (ref: ContextRef) => ContextVersionChain;
  createEvent: (
    ref: ContextRef,
    turnId: string,
    type: ContextEvent['type'],
    data: Record<string, unknown>
  ) => ContextEvent;
  generateTurnId: () => string;
  clearDerivedCompressedHistoryContext: (ref: ContextRef) => void;
}

export class ContextTransactionCoordinator {
  private readonly pendingTransactions = new Map<string, PendingTransaction>();
  private readonly eventStore: ContextEventStore;
  private readonly getProjection: ContextTransactionCoordinatorOptions['getProjection'];
  private readonly checkContextIntegrity: ContextTransactionCoordinatorOptions['checkContextIntegrity'];
  private readonly validateVersionChain: ContextTransactionCoordinatorOptions['validateVersionChain'];
  private readonly createEvent: ContextTransactionCoordinatorOptions['createEvent'];
  private readonly generateTurnId: ContextTransactionCoordinatorOptions['generateTurnId'];
  private readonly clearDerivedCompressedHistoryContext: ContextTransactionCoordinatorOptions['clearDerivedCompressedHistoryContext'];

  constructor(options: ContextTransactionCoordinatorOptions) {
    this.eventStore = options.eventStore;
    this.getProjection = options.getProjection;
    this.checkContextIntegrity = options.checkContextIntegrity;
    this.validateVersionChain = options.validateVersionChain;
    this.createEvent = options.createEvent;
    this.generateTurnId = options.generateTurnId;
    this.clearDerivedCompressedHistoryContext = options.clearDerivedCompressedHistoryContext;
  }

  beginTransaction(ref: ContextRef): ContextTransaction {
    const projection = this.getProjection(ref);
    const transactionId = `txn-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const transaction: ContextTransaction = {
      transactionId,
      ref,
      versionStamp: projection.version,
      events: [],
      committed: false,
      createdAt: new Date().toISOString(),
    };

    this.pendingTransactions.set(transactionId, {
      transaction,
      bufferedEvents: [],
    });

    return transaction;
  }

  addTransactionEvent(transactionId: string, event: ContextEvent): boolean {
    const pending = this.pendingTransactions.get(transactionId);
    if (!pending || pending.transaction.committed) {
      return false;
    }
    pending.bufferedEvents.push(event);
    pending.transaction.events.push(event);
    return true;
  }

  commitTransaction(transactionId: string): boolean {
    const pending = this.pendingTransactions.get(transactionId);
    if (!pending || pending.transaction.committed) {
      return false;
    }

    if (pending.bufferedEvents.length === 0) {
      this.pendingTransactions.delete(transactionId);
      return true;
    }

    const currentIntegrity = this.checkContextIntegrity(pending.transaction.ref);
    const expectedVersion = pending.transaction.versionStamp;
    if (currentIntegrity.projection.version !== expectedVersion) {
      console.warn(
        `[ContextManager] Version changed during transaction ${transactionId}: expected ${expectedVersion}, got ${currentIntegrity.projection.version}`
      );
      pending.bufferedEvents = [];
      pending.transaction.events = [];
      this.pendingTransactions.delete(transactionId);
      return false;
    }

    this.eventStore.appendEvents(
      pending.transaction.ref.scope,
      pending.transaction.ref.namespace,
      pending.bufferedEvents
    );

    pending.transaction.committed = true;
    pending.bufferedEvents = [];
    this.pendingTransactions.delete(transactionId);
    return true;
  }

  rollbackTransaction(transactionId: string): boolean {
    const pending = this.pendingTransactions.get(transactionId);
    if (!pending || pending.transaction.committed) {
      return false;
    }
    pending.bufferedEvents = [];
    pending.transaction.events = [];
    this.pendingTransactions.delete(transactionId);
    return true;
  }

  autoRollbackOnJump(ref: ContextRef): ContextValidationResult | null {
    const versionChain = this.validateVersionChain(ref);
    if (!versionChain.jumpDetected) {
      return null;
    }

    const events = this.eventStore.readEvents(ref.scope, ref.namespace);
    let lastGoodEventCount = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'turn_committed' || events[i].type === 'checkpoint_created') {
        break;
      }
      lastGoodEventCount++;
    }

    const keepCount = events.length - lastGoodEventCount;
    if (keepCount >= events.length) {
      return null;
    }

    const removedCount = this.eventStore.truncateEvents(ref.scope, ref.namespace, keepCount);
    this.clearDerivedCompressedHistoryContext(ref);

    const rollbackEvent = this.createEvent(ref, this.generateTurnId(), 'context_rollback', {
      reason: 'version_jump_detected',
      previousVersion: versionChain.previousVersion,
      detectedVersion: versionChain.currentVersion,
      gapSize: versionChain.gapSize,
      removedEvents: removedCount,
    });
    this.eventStore.appendEvents(ref.scope, ref.namespace, [rollbackEvent]);

    return {
      valid: false,
      checkpointId: 'auto_rollback',
      expectedHash: 'unknown',
      actualHash: 'unknown',
      eventCountMatch: false,
      rollbackPerformed: true,
    };
  }
}
