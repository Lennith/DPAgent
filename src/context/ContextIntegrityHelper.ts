import * as crypto from 'crypto';
import type {
  ContextCheckpoint,
  ContextCheckpointResult,
  ContextValidationResult,
  ContextVersionChain,
} from './ContextManager.js';
import type { ContextEvent, ContextProjection, ContextRef } from '../types.js';
import { ContextEventStore } from './ContextEventStore.js';
import { ContextProjector } from './ContextProjector.js';

interface ComparableContextState {
  events: ContextEvent[];
  comparableEvents: ContextEvent[];
  projection: ContextProjection;
  messageCount: number;
  hash: string;
}

export interface ContextIntegrityHelperOptions {
  eventStore: ContextEventStore;
  projector: ContextProjector;
  createEvent: (
    ref: ContextRef,
    turnId: string,
    type: ContextEvent['type'],
    data: Record<string, unknown>
  ) => ContextEvent;
  generateTurnId: () => string;
  clearDerivedCompressedHistoryContext: (ref: ContextRef) => void;
}

export class ContextIntegrityHelper {
  private readonly eventStore: ContextEventStore;
  private readonly projector: ContextProjector;
  private readonly createEvent: ContextIntegrityHelperOptions['createEvent'];
  private readonly generateTurnId: ContextIntegrityHelperOptions['generateTurnId'];
  private readonly clearDerivedCompressedHistoryContext: ContextIntegrityHelperOptions['clearDerivedCompressedHistoryContext'];

  constructor(options: ContextIntegrityHelperOptions) {
    this.eventStore = options.eventStore;
    this.projector = options.projector;
    this.createEvent = options.createEvent;
    this.generateTurnId = options.generateTurnId;
    this.clearDerivedCompressedHistoryContext = options.clearDerivedCompressedHistoryContext;
  }

  validateVersionChain(ref: ContextRef): ContextVersionChain {
    const { events, projection } = this.readProjectedState(ref);
    return this.buildVersionChain(ref, events, projection);
  }

  checkContextIntegrity(ref: ContextRef): {
    valid: boolean;
    projection: ContextProjection;
    versionChain: ContextVersionChain;
    integrityHash: string;
  } {
    const { events, projection } = this.readProjectedState(ref);
    const versionChain = this.buildVersionChain(ref, events, projection);

    return {
      valid: versionChain.isValid,
      projection,
      versionChain,
      integrityHash: this.computeEventIntegrityHash(events),
    };
  }

  createCheckpoint(ref: ContextRef, reason: string): ContextCheckpointResult {
    const checkpointId = `cp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const turnId = this.generateTurnId();
    const createdAt = new Date().toISOString();
    const state = this.buildComparableContextState(ref);

    const checkpoint: ContextCheckpoint = {
      checkpointId,
      turnId,
      ref,
      createdAt,
      hash: state.hash,
      eventCount: state.events.length,
      semanticEventCount: state.comparableEvents.length,
      messageCount: state.messageCount,
    };

    const checkpointEvent = this.createEvent(ref, turnId, 'checkpoint_created', {
      checkpointId,
      reason,
      hash: state.hash,
      eventCount: state.events.length,
      semanticEventCount: state.comparableEvents.length,
      messageCount: state.messageCount,
    });
    this.eventStore.appendEvents(ref.scope, ref.namespace, [checkpointEvent]);

    return { checkpoint, projection: state.projection };
  }

  validateCheckpoint(
    ref: ContextRef,
    checkpoint: ContextCheckpoint,
    performRollback = false
  ): ContextValidationResult {
    const state = this.buildComparableContextState(ref);
    const eventCountMatch = state.comparableEvents.length === checkpoint.semanticEventCount;
    const valid = state.hash === checkpoint.hash && eventCountMatch;

    let rollbackPerformed = false;
    if (!valid && performRollback) {
      const removedCount = this.eventStore.truncateEvents(ref.scope, ref.namespace, checkpoint.eventCount);
      this.clearDerivedCompressedHistoryContext(ref);
      const rollbackEvent = this.createEvent(ref, checkpoint.turnId, 'checkpoint_rollback', {
        checkpointId: checkpoint.checkpointId,
        expectedHash: checkpoint.hash,
        actualHash: state.hash,
        expectedEventCount: checkpoint.eventCount,
        actualEventCount: state.events.length,
        removedEvents: removedCount,
        reason: 'context_jump_detected',
      });
      this.eventStore.appendEvents(ref.scope, ref.namespace, [rollbackEvent]);
      rollbackPerformed = true;
    }

    return {
      valid,
      checkpointId: checkpoint.checkpointId,
      expectedHash: checkpoint.hash,
      actualHash: state.hash,
      eventCountMatch,
      rollbackPerformed,
    };
  }

  computeContextHash(ref: ContextRef): string {
    return this.buildComparableContextState(ref).hash;
  }

  detectSummaryDrift(ref: ContextRef, expectedSummary: string): {
    hasDrift: boolean;
    projectedSummary: string;
    expectedSummary: string;
    driftScore: number;
    driftReason: string;
  } {
    const events = this.eventStore.readEvents(ref.scope, ref.namespace);
    const projection = this.projector.project(ref, events);
    const projectedSummary = projection.latestSummary || '(no summary)';

    const projectTokens = new Set(
      projectedSummary
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 3)
    );
    const expectTokens = new Set(
      expectedSummary
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 3)
    );

    let overlap = 0;
    for (const token of expectTokens) {
      if (projectTokens.has(token)) {
        overlap += 1;
      }
    }
    const unionSize = expectTokens.size + projectTokens.size - overlap;
    const driftScore = unionSize > 0 ? 1 - overlap / unionSize : 0;

    let driftReason = 'ok';
    if (driftScore > 0.6) {
      driftReason = 'significant_semantic_drift';
    } else if (driftScore > 0.3) {
      const hasRecentActivity = projection.recentTurns.length > 0;
      if (!hasRecentActivity && expectedSummary.length > projectedSummary.length * 1.5) {
        driftReason = 'summary_larger_than_actual_context';
      } else {
        driftReason = 'moderate_content_mismatch';
      }
    } else if (projectedSummary === '(no summary)' && expectedSummary.length > 50) {
      driftReason = 'expected_summary_but_none_projected';
    }

    const hasDrift = driftScore > 0.5 || driftReason !== 'ok';
    if (hasDrift) {
      console.warn(`[ContextManager] Summary drift detected: ${driftReason} (score=${driftScore.toFixed(2)})`);
    }

    return {
      hasDrift,
      projectedSummary,
      expectedSummary,
      driftScore,
      driftReason,
    };
  }

  private buildComparableContextState(ref: ContextRef): ComparableContextState {
    const events = this.eventStore.readEvents(ref.scope, ref.namespace);
    const comparableEvents = this.filterCheckpointNoiseEvents(events);
    const projection = this.projector.project(ref, comparableEvents);
    const messageCount = this.projector.toConversationMessages(comparableEvents).length;
    return {
      events,
      comparableEvents,
      projection,
      messageCount,
      hash: this.computeComparableStateHash(comparableEvents.length, messageCount, projection),
    };
  }

  private computeComparableStateHash(
    eventCount: number,
    messageCount: number,
    projection: ContextProjection
  ): string {
    const hashInput = {
      eventCount,
      messageCount,
      projectionVersion: projection.version,
      latestSummary: projection.latestSummary,
      keyValues: projection.keyValues,
    };
    return crypto.createHash('sha256').update(JSON.stringify(hashInput)).digest('hex').slice(0, 16);
  }

  private filterCheckpointNoiseEvents(events: ContextEvent[]): ContextEvent[] {
    return events.filter((event) => event.type !== 'checkpoint_created' && event.type !== 'checkpoint_rollback');
  }

  private readProjectedState(ref: ContextRef): {
    events: ContextEvent[];
    projection: ContextProjection;
  } {
    const events = this.eventStore.readEvents(ref.scope, ref.namespace);
    return {
      events,
      projection: this.projector.project(ref, events),
    };
  }

  private buildVersionChain(
    ref: ContextRef,
    events: ContextEvent[],
    projection: ContextProjection
  ): ContextVersionChain {
    let previousVersion = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'turn_committed') {
        previousVersion = projection.version - 1;
        break;
      }
    }

    const jumpSize = projection.version - previousVersion;
    const jumpDetected = jumpSize > 1;

    return {
      contextRef: ref,
      previousVersion,
      currentVersion: projection.version,
      gapSize: jumpDetected ? jumpSize : 0,
      turnId: events.length > 0 ? events[events.length - 1].turnId : 'unknown',
      isValid: !jumpDetected,
      jumpDetected,
      jumpSize: jumpDetected ? jumpSize : 0,
    };
  }

  private computeEventIntegrityHash(events: ContextEvent[]): string {
    const content = events.map((event) => `${event.id}:${event.type}:${event.timestamp}`).join('|');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}
