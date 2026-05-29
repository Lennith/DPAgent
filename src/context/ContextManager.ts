import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ContextEvent,
  ContextInspectKeyState,
  ContextInspectState,
  ContextNamespaceInfo,
  ContextNamespaceMeta,
  ContextProjection,
  ContextRef,
  ContextScope,
  DraftTurnRecord,
  InterruptedArtifact,
  Message,
  ReplayCheckpointSnapshot,
  ReplayCutoffKind,
  SideEffectLedgerEntry,
  ToolResult,
  ToolResultArtifactRef,
  TokenUsage,
} from '../types.js';
import { ContextEventStore } from './ContextEventStore.js';
import { InterruptedTurnStore } from './InterruptedTurnStore.js';
import { ContextProjector, type TimestampedConversationMessage } from './ContextProjector.js';
import {
  buildPendingOverlay,
  createContextInspectState,
  inspectContextKeyState,
  toInspectableMeta,
} from './context-inspection.js';
import { ContextIntegrityHelper } from './ContextIntegrityHelper.js';
import { ContextTransactionCoordinator } from './ContextTransactionCoordinator.js';
import { ReplayCheckpointCoordinator } from './ReplayCheckpointCoordinator.js';
import { buildToolProtocolFrames } from '../llm/tool-protocol.js';
import {
  ARTIFACT_READ_MAX_SCAN_BYTES,
  TOOL_RESULT_PAYLOAD_MARKERS,
  buildReadToolResultArtifactContent,
  buildStoredToolResultContent,
  redactToolCallMessagesForCheckpoint,
  resolveArtifactReadLineLimit,
  resolveArtifactReadMaxChars,
  resolveToolResultArtifactPreviewChars,
  resolveToolResultArtifactThreshold,
} from '../runtime/tool-result-payload-policy.js';
import type {
  BeginTurnInput,
  BeginTurnResult,
  CommitTurnInput,
  CommitTurnResult,
  ContextCheckpoint,
  ContextCheckpointResult,
  ContextTransaction,
  ContextValidationResult,
  ContextVersionChain,
  FinalizeInterruptedTurnInput,
  LoadForTurnResult,
  PendingTurn,
  ToolResultArtifactMaterialization,
  TurnPromptState,
} from './context-manager-contracts.js';

export type {
  BeginTurnInput,
  BeginTurnResult,
  CommitTurnInput,
  CommitTurnResult,
  ContextCheckpoint,
  ContextCheckpointResult,
  ContextTransaction,
  ContextValidationResult,
  ContextVersionChain,
  FinalizeInterruptedTurnInput,
  LoadForTurnResult,
  ToolResultArtifactMaterialization,
} from './context-manager-contracts.js';

export class ContextManager {
  private readonly eventStore: ContextEventStore;
  private readonly projector: ContextProjector;
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly interruptedTurnStore: InterruptedTurnStore;
  private readonly integrityHelper: ContextIntegrityHelper;
  private readonly transactionCoordinator: ContextTransactionCoordinator;
  private readonly replayCheckpointCoordinator: ReplayCheckpointCoordinator;

  constructor(eventStore: ContextEventStore, projector?: ContextProjector) {
    this.eventStore = eventStore;
    this.projector = projector ?? new ContextProjector();
    this.interruptedTurnStore = new InterruptedTurnStore(this.eventStore);
    this.replayCheckpointCoordinator = new ReplayCheckpointCoordinator({
      interruptedTurnStore: this.interruptedTurnStore,
      getPendingTurn: (turnId) => this.pendingTurns.get(turnId),
    });
    this.integrityHelper = new ContextIntegrityHelper({
      eventStore: this.eventStore,
      projector: this.projector,
      createEvent: (ref, turnId, type, data) => this.createEvent(ref, turnId, type, data),
      generateTurnId: () => this.generateTurnId(),
      clearDerivedCompressedHistoryContext: (ref) => this.clearDerivedCompressedHistoryContext(ref),
    });
    this.transactionCoordinator = new ContextTransactionCoordinator({
      eventStore: this.eventStore,
      getProjection: (ref) => this.getProjection(ref),
      checkContextIntegrity: (ref) => this.integrityHelper.checkContextIntegrity(ref),
      validateVersionChain: (ref) => this.integrityHelper.validateVersionChain(ref),
      createEvent: (ref, turnId, type, data) => this.createEvent(ref, turnId, type, data),
      generateTurnId: () => this.generateTurnId(),
      clearDerivedCompressedHistoryContext: (ref) => this.clearDerivedCompressedHistoryContext(ref),
    });
  }

  getEventStore(): ContextEventStore {
    return this.eventStore;
  }

  hasPendingTurn(turnId: string | null | undefined): boolean {
    const normalized = String(turnId ?? '').trim();
    return normalized.length > 0 && this.pendingTurns.has(normalized);
  }

  loadForTurn(ref: ContextRef): LoadForTurnResult {
    const normalized = this.normalizeRef(ref);
    const events = this.eventStore.readEvents(normalized.scope, normalized.namespace);
    const projection = this.projector.project(normalized, events);
    const meta = this.eventStore.loadMeta(normalized.scope, normalized.namespace);
    const systemSegment = this.projector.buildSystemSegment(projection, meta);
    return { context: normalized, projection, systemSegment, meta };
  }

  beginTurn(ref: ContextRef, prompt: string, workspaceDir?: string, input?: BeginTurnInput): BeginTurnResult {
    const normalized = this.normalizeRef(ref);
    const turnId = this.generateTurnId();
    const startedAt = new Date().toISOString();
    const promptState = this.resolveTurnPromptState({
      prompt,
      rawUserPrompt: input?.rawUserPrompt,
      historyUserPrompt: input?.historyUserPrompt,
      effectivePrompt: input?.effectivePrompt,
      promptRef: input?.promptRef,
      promptInjected: input?.promptInjected,
    });
    // REQ-0005: Get current event count as sequence base for continuity tracking
    const events = this.eventStore.readEvents(normalized.scope, normalized.namespace);
    const eventSequenceBase = events.length;
    const startedEvent = this.createEvent(normalized, turnId, 'turn_started', {
      prompt: promptState.rawUserPrompt,
      rawUserPrompt: promptState.rawUserPrompt,
      historyUserPrompt: promptState.historyUserPrompt,
      effectivePrompt: promptState.effectivePrompt,
      promptRef: promptState.promptRef,
      promptInjected: promptState.promptInjected,
      workspaceDir,
      eventSequence: eventSequenceBase,
    });
    this.pendingTurns.set(turnId, {
      turnId,
      ref: normalized,
      startedAt,
      prompt: promptState.rawUserPrompt,
      rawUserPrompt: promptState.rawUserPrompt,
      historyUserPrompt: promptState.historyUserPrompt,
      effectivePrompt: promptState.effectivePrompt,
      promptRef: promptState.promptRef,
      promptInjected: promptState.promptInjected,
      workspaceDir,
      bufferedEvents: [startedEvent],
      eventSequenceBase,
      draftId: input?.draftId,
      runId: input?.runId,
      runFamilyId: input?.runFamilyId,
      maxSteps: input?.maxSteps,
    });
    if (input?.draftId && input?.runId && input?.runFamilyId && typeof input?.maxSteps === 'number') {
      const baselineEventCount = events.length;
      this.interruptedTurnStore.saveDraft(normalized, {
        draftId: input.draftId,
        context: normalized,
        turnId,
        runId: input.runId,
        runFamilyId: input.runFamilyId,
        workspaceDir,
        createdAt: startedAt,
        updatedAt: startedAt,
        maxSteps: Math.max(0, Math.floor(input.maxSteps)),
        baselineEventCount,
      });
    }
    return {
      turnId,
      context: normalized,
      startedAt,
    };
  }

  record(turnId: string, type: ContextEvent['type'], data: Record<string, unknown>): boolean {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      return false;
    }
    // REQ-0005: Include sequence number for continuity tracking
    const eventSequence = pending.eventSequenceBase + pending.bufferedEvents.length;
    pending.bufferedEvents.push(this.createEvent(pending.ref, turnId, type, { ...data, eventSequence }));
    return true;
  }

  recordContextPatch(
    turnId: string,
    patch: {
      op: 'set' | 'delete';
      key: string;
      value?: string;
      source?: string;
    }
  ): boolean {
    return this.record(turnId, 'context_patch', {
      op: patch.op,
      key: patch.key,
      value: patch.value ?? '',
      source: patch.source ?? 'tool',
    });
  }

  writeNow(ref: ContextRef, key: string, value: string): ContextProjection {
    const normalized = this.normalizeRef(ref);
    const turnId = this.generateTurnId();
    const events: ContextEvent[] = [
      this.createEvent(normalized, turnId, 'turn_started', {
        prompt: '[context_manage.write]',
      }),
      this.createEvent(normalized, turnId, 'context_patch', {
        op: 'set',
        key,
        value,
        source: 'context_manage',
      }),
      this.createEvent(normalized, turnId, 'turn_summary', {
        summary: `Updated context key '${key}'.`,
        highlights: [`${key} updated`],
        toolCalls: 0,
      }),
      this.createEvent(normalized, turnId, 'turn_committed', {
        messageCount: 0,
        finishReason: 'context_manage',
      }),
    ];
    this.eventStore.appendEvents(normalized.scope, normalized.namespace, events);
    return this.getProjection(normalized);
  }

  deleteNow(ref: ContextRef, key: string): ContextProjection {
    const normalized = this.normalizeRef(ref);
    const turnId = this.generateTurnId();
    const events: ContextEvent[] = [
      this.createEvent(normalized, turnId, 'turn_started', {
        prompt: '[context_manage.delete]',
      }),
      this.createEvent(normalized, turnId, 'context_patch', {
        op: 'delete',
        key,
        source: 'context_manage',
      }),
      this.createEvent(normalized, turnId, 'turn_summary', {
        summary: `Deleted context key '${key}'.`,
        highlights: [`${key} deleted`],
        toolCalls: 0,
      }),
      this.createEvent(normalized, turnId, 'turn_committed', {
        messageCount: 0,
        finishReason: 'context_manage',
      }),
    ];
    this.eventStore.appendEvents(normalized.scope, normalized.namespace, events);
    return this.getProjection(normalized);
  }

  commitTurn(turnId: string, input: CommitTurnInput): CommitTurnResult {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      throw new Error(`Unknown pending turn: ${turnId}`);
    }
    this.flushReplayCheckpoints(turnId);
    return this.commitPendingTurn(pending, turnId, input);
  }

  saveReplayCheckpoint(turnId: string, input: { observedAt: string; step: number; messages: Message[] }): boolean {
    const pending = this.pendingTurns.get(turnId);
    if (!pending?.draftId || !pending.runId || !pending.runFamilyId || typeof pending.maxSteps !== 'number') {
      return false;
    }
    const replaySafeMessages = redactToolCallMessagesForCheckpoint(
      this.trimMessagesToReplaySafeBoundary(this.cloneMessages(input.messages))
    );
    const checkpoint: ReplayCheckpointSnapshot = {
      observedAt: input.observedAt,
      step: Math.max(0, Math.floor(input.step)),
      messages: replaySafeMessages,
      bufferedEventCount: pending.bufferedEvents.length,
    };
    const currentDraft = this.interruptedTurnStore.loadDraft(pending.ref);
    const existingDraft: DraftTurnRecord = currentDraft ?? {
      draftId: pending.draftId,
      context: pending.ref,
      turnId,
      runId: pending.runId,
      runFamilyId: pending.runFamilyId,
      workspaceDir: pending.workspaceDir,
      createdAt: pending.startedAt,
      updatedAt: input.observedAt,
      maxSteps: pending.maxSteps,
      baselineEventCount: pending.eventSequenceBase,
    };
    const nextDraft: DraftTurnRecord = {
      ...existingDraft,
      turnId,
      runId: pending.runId,
      runFamilyId: pending.runFamilyId,
      maxSteps: pending.maxSteps,
      updatedAt: input.observedAt,
    };
    const baseDraft: Omit<DraftTurnRecord, 'checkpoint'> = {
      draftId: nextDraft.draftId,
      context: nextDraft.context,
      turnId: nextDraft.turnId,
      runId: nextDraft.runId,
      runFamilyId: nextDraft.runFamilyId,
      workspaceDir: nextDraft.workspaceDir,
      createdAt: nextDraft.createdAt,
      updatedAt: nextDraft.updatedAt,
      maxSteps: nextDraft.maxSteps,
      baselineEventCount: nextDraft.baselineEventCount,
    };
    this.replayCheckpointCoordinator.enqueue(turnId, pending.ref, baseDraft, checkpoint);
    return true;
  }

  finalizeInterruptedTurn(turnId: string, input: FinalizeInterruptedTurnInput): InterruptedArtifact | null {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      throw new Error(`Unknown pending turn: ${turnId}`);
    }
    this.flushReplayCheckpoints(turnId);
    const draft = this.interruptedTurnStore.loadDraft(pending.ref);
    const checkpoint = draft?.turnId === turnId ? draft.checkpoint : undefined;
    const checkpointBufferedEventCount = checkpoint?.bufferedEventCount ?? 1;
    const carryForwardContextPatchEvents = this.collectCarryForwardContextPatchEvents(
      pending,
      checkpointBufferedEventCount
    );
    const artifactId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    let checkpointTurnId: string | undefined;
    let replayCutoffKind: ReplayCutoffKind = 'none';
    if (checkpoint && checkpoint.messages.length > 0) {
      replayCutoffKind = 'checkpoint';
      checkpointTurnId = this.commitPendingTurn(
        pending,
        turnId,
        {
          messages: checkpoint.messages,
          rawUserPrompt: pending.rawUserPrompt,
          historyUserPrompt: pending.historyUserPrompt,
          effectivePrompt: pending.effectivePrompt,
          promptRef: pending.promptRef,
          promptInjected: pending.promptInjected,
          finalOutputText: this.resolveReplayCheckpointFinalOutputText(checkpoint.messages),
          finishReason: 'interrupted_checkpoint',
        },
        {
          bufferedEventCount: checkpoint.bufferedEventCount,
          keepPendingTurn: false,
          extraBufferedEvents: carryForwardContextPatchEvents,
        }
      ).turnId;
    } else if (carryForwardContextPatchEvents.length > 0) {
      checkpointTurnId = this.commitPendingTurn(
        pending,
        turnId,
        {
          messages: [],
          rawUserPrompt: pending.rawUserPrompt,
          historyUserPrompt: pending.historyUserPrompt,
          effectivePrompt: pending.effectivePrompt,
          promptRef: pending.promptRef,
          promptInjected: pending.promptInjected,
          finishReason: 'interrupted_checkpoint',
        },
        {
          bufferedEventCount: checkpointBufferedEventCount,
          keepPendingTurn: false,
          extraBufferedEvents: carryForwardContextPatchEvents,
        }
      ).turnId;
    } else {
      this.abortTurn(turnId);
    }
    const artifact: InterruptedArtifact = {
      artifactId,
      context: pending.ref,
      draftId: draft?.draftId ?? pending.draftId ?? turnId,
      turnId,
      runId: draft?.runId ?? pending.runId ?? turnId,
      runFamilyId: draft?.runFamilyId ?? pending.runFamilyId ?? (draft?.runId ?? pending.runId ?? turnId),
      workspaceDir: draft?.workspaceDir ?? pending.workspaceDir,
      terminalCode: input.terminalCode,
      replayCutoffKind: replayCutoffKind === 'checkpoint' ? 'checkpoint' : 'none',
      lastSafeStep: Math.max(0, Math.floor(input.lastSafeStep)),
      maxSteps: Math.max(0, Math.floor(input.maxSteps)),
      errorSummary: input.errorSummary?.trim() || undefined,
      createdAt,
      updatedAt: createdAt,
      previewMessages: redactToolCallMessagesForCheckpoint(this.cloneMessages(input.previewMessages)),
      sideEffectLedger: input.sideEffectLedger.map((entry) => ({
        ...entry,
        args: entry.args ? { ...entry.args } : undefined,
      })),
      checkpointTurnId,
    };
    this.interruptedTurnStore.saveArtifact(pending.ref, artifact);
    if (artifact.sideEffectLedger.length > 0) {
      this.interruptedTurnStore.mergeSideEffectLedger(pending.ref, artifact.sideEffectLedger);
    }
    this.interruptedTurnStore.clearDraft(pending.ref);
    return artifact;
  }

  getInterruptedArtifact(ref: ContextRef): InterruptedArtifact | undefined {
    return this.interruptedTurnStore.loadArtifact(this.normalizeRef(ref));
  }

  getDraftRecord(ref: ContextRef): DraftTurnRecord | undefined {
    const normalized = this.normalizeRef(ref);
    this.replayCheckpointCoordinator.flushForRef(normalized);
    return this.interruptedTurnStore.loadDraft(normalized);
  }

  flushReplayCheckpoints(turnId?: string): void {
    this.replayCheckpointCoordinator.flush(turnId);
  }

  clearInterruptedArtifact(ref: ContextRef): void {
    this.interruptedTurnStore.clearArtifact(this.normalizeRef(ref));
  }

  getInterruptedSideEffectLedger(ref: ContextRef): SideEffectLedgerEntry[] {
    return this.interruptedTurnStore.loadSideEffectLedger(this.normalizeRef(ref));
  }

  hasInterruptedState(ref: ContextRef): boolean {
    const normalized = this.normalizeRef(ref);
    return (
      this.getDraftRecord(normalized) !== undefined ||
      this.getInterruptedArtifact(normalized) !== undefined ||
      this.getInterruptedSideEffectLedger(normalized).length > 0
    );
  }

  clearInterruptedSideEffectLedger(ref: ContextRef): void {
    this.interruptedTurnStore.clearSideEffectLedger(this.normalizeRef(ref));
  }

  hasCarryForwardContextPatchEvents(turnId: string, bufferedEventCount = 1): boolean {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      return false;
    }
    return this.collectCarryForwardContextPatchEvents(pending, bufferedEventCount).length > 0;
  }

  abortTurn(turnId: string): boolean {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      return false;
    }
    this.replayCheckpointCoordinator.drop(turnId);
    this.pendingTurns.delete(turnId);
    this.interruptedTurnStore.clearDraft(pending.ref);
    return true;
  }

  listNamespaces(scope: ContextScope): ContextNamespaceInfo[] {
    const metas = this.eventStore.listNamespaces(scope);
    return metas.map((meta) => ({
      ...meta,
      projection: this.getProjection({
        scope: meta.scope,
        namespace: meta.namespace,
      }),
    }));
  }

  getNamespaceInfo(ref: ContextRef): ContextNamespaceInfo {
    const normalized = this.normalizeRef(ref);
    const meta = this.eventStore.loadMeta(normalized.scope, normalized.namespace);
    const projection = this.getProjection(normalized);
    return {
      scope: normalized.scope,
      namespace: normalized.namespace,
      name: meta?.name,
      createdAt: meta?.createdAt ?? new Date().toISOString(),
      updatedAt: meta?.updatedAt ?? new Date().toISOString(),
      workspaceDir: meta?.workspaceDir,
      toolsetName: meta?.toolsetName,
      memoryPromotionState: meta?.memoryPromotionState,
      compressedHistoryContext: meta?.compressedHistoryContext,
      autoLoopConfig: meta?.autoLoopConfig,
      agentInjectionState: meta?.agentInjectionState,
      planningState: meta?.planningState,
      automationRun: meta?.automationRun,
      projection,
    };
  }

  updateNamespaceMeta(ref: ContextRef, updates: Partial<ContextNamespaceMeta>): ContextNamespaceMeta {
    const normalized = this.normalizeRef(ref);
    const current =
      this.eventStore.loadMeta(normalized.scope, normalized.namespace) ??
      ({
        scope: normalized.scope,
        namespace: normalized.namespace,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as ContextNamespaceMeta);
    const next: ContextNamespaceMeta = {
      ...current,
      ...updates,
      scope: normalized.scope,
      namespace: normalized.namespace,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.eventStore.saveMeta(normalized.scope, normalized.namespace, next);
    return next;
  }

  forkSessionNamespace(input: {
    sourceNamespace: string;
    targetNamespace: string;
    name?: string;
    origin?: ContextNamespaceMeta['origin'];
  }): ContextNamespaceMeta {
    const source: ContextRef = { scope: 'session', namespace: input.sourceNamespace };
    const target: ContextRef = { scope: 'session', namespace: input.targetNamespace };
    const sourceMeta = this.eventStore.loadMeta(source.scope, source.namespace);
    if (!sourceMeta) {
      throw new Error(`Session not found: ${input.sourceNamespace}`);
    }
    if (this.hasInterruptedState(source)) {
      throw new Error(`Session is not stable enough to fork: ${input.sourceNamespace}`);
    }
    const sourceEvents = this.eventStore.readEvents(source.scope, source.namespace);
    const forkedAt = new Date().toISOString();
    const targetName = String(input.name ?? '').trim() || `${sourceMeta.name || input.sourceNamespace}-fork`;
    const targetMeta: ContextNamespaceMeta = {
      scope: target.scope,
      namespace: target.namespace,
      name: targetName,
      createdAt: forkedAt,
      updatedAt: forkedAt,
      workspaceDir: sourceMeta.workspaceDir,
      ...(sourceMeta.toolsetName ? { toolsetName: sourceMeta.toolsetName } : {}),
      ...((input.origin ?? sourceMeta.origin) ? { origin: input.origin ?? sourceMeta.origin } : {}),
      ...(sourceMeta.llmSelection ? { llmSelection: sourceMeta.llmSelection } : {}),
      ...(sourceMeta.memoryPromotionState ? { memoryPromotionState: sourceMeta.memoryPromotionState } : {}),
      ...(sourceMeta.compressedHistoryContext ? { compressedHistoryContext: sourceMeta.compressedHistoryContext } : {}),
      ...(sourceMeta.agentInjectionState ? { agentInjectionState: sourceMeta.agentInjectionState } : {}),
      forkedFrom: {
        scope: 'session',
        namespace: source.namespace,
        sourceEventCount: sourceEvents.length,
        forkedAt,
      },
    };
    this.eventStore.copyCommittedNamespace({
      source,
      target,
      meta: targetMeta,
    });
    return this.eventStore.loadMeta(target.scope, target.namespace) ?? targetMeta;
  }

  deleteNamespace(ref: ContextRef): boolean {
    const normalized = this.normalizeRef(ref);
    return this.eventStore.deleteNamespace(normalized.scope, normalized.namespace);
  }

  getProjection(ref: ContextRef): ContextProjection {
    const normalized = this.normalizeRef(ref);
    const events = this.eventStore.readEvents(normalized.scope, normalized.namespace);
    return this.projector.project(normalized, events);
  }

  inspect(
    ref: ContextRef,
    options?: {
      turnId?: string;
      includePending?: boolean;
      includeMeta?: boolean;
    }
  ): ContextInspectState {
    const normalized = this.normalizeRef(ref);
    const projection = this.getProjection(normalized);
    const pendingOverlay =
      options?.includePending === false
        ? undefined
        : buildPendingOverlay(normalized, options?.turnId, this.getPendingOverlaySource(options?.turnId));
    const meta =
      options?.includeMeta === false
        ? undefined
        : toInspectableMeta(this.eventStore.loadMeta(normalized.scope, normalized.namespace));
    return createContextInspectState({
      context: normalized,
      projection,
      pendingOverlay,
      meta,
    });
  }

  inspectKey(
    ref: ContextRef,
    key: string,
    options?: {
      turnId?: string;
      includePending?: boolean;
    }
  ): ContextInspectKeyState {
    const inspection = this.inspect(ref, {
      turnId: options?.turnId,
      includePending: options?.includePending,
      includeMeta: false,
    });
    return inspectContextKeyState(inspection, key);
  }

  getConversationMessages(
    ref: ContextRef,
    options?: {
      preserveAgentProfileRefs?: boolean;
      includeInterruptedCheckpoints?: boolean;
    }
  ): Message[] {
    const normalized = this.normalizeRef(ref);
    const events = this.eventStore.readEvents(normalized.scope, normalized.namespace);
    return this.projector.toConversationMessages(events, options);
  }

  getConversationMessagesWithTimestamps(
    ref: ContextRef,
    options?: {
      preserveAgentProfileRefs?: boolean;
      includeInterruptedCheckpoints?: boolean;
    }
  ): TimestampedConversationMessage[] {
    const normalized = this.normalizeRef(ref);
    const events = this.eventStore.readEvents(normalized.scope, normalized.namespace);
    return this.projector.toConversationMessagesWithTimestamps(events, options);
  }

  materializeToolResultArtifact(
    ref: ContextRef,
    input: {
      toolCallId: string;
      toolName: string;
      content: string;
      thresholdChars?: number;
      previewChars?: number;
    }
  ): ToolResultArtifactMaterialization {
    const thresholdChars = resolveToolResultArtifactThreshold(input.thresholdChars);
    if (input.content.length <= thresholdChars) {
      return { content: input.content };
    }
    const normalized = this.normalizeRef(ref);
    const createdAt = new Date().toISOString();
    const safeToolCallId = this.sanitizeArtifactToken(input.toolCallId || crypto.randomUUID());
    const artifactId = this.sanitizeArtifactToken(`${safeToolCallId.slice(0, 64)}-${crypto.randomUUID()}`);
    const relativePath = path.join('tool-results', `${artifactId}.txt`);
    const namespacePath = path.resolve(this.eventStore.getNamespacePath(normalized));
    const artifactRoot = this.ensureToolResultArtifactRoot(namespacePath);
    const artifactPath = path.resolve(namespacePath, relativePath);
    if (!this.isPathWithinDir(artifactPath, namespacePath)) {
      throw new Error('Tool result artifact path is outside the current context namespace.');
    }
    this.assertSafeArtifactFilePath(artifactPath, artifactRoot);
    fs.writeFileSync(artifactPath, input.content, { encoding: 'utf-8', flag: 'wx' });
    this.assertSafeArtifactFilePath(artifactPath, artifactRoot);

    const previewChars = resolveToolResultArtifactPreviewChars(input.previewChars);
    const preview = input.content.slice(0, previewChars);
    const artifact: ToolResultArtifactRef = {
      artifactId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      relativePath: relativePath.replace(/\\/g, '/'),
      originalChars: input.content.length,
      previewChars: preview.length,
      createdAt,
    };
    return {
      artifact,
      content: buildStoredToolResultContent(artifact, preview),
    };
  }

  readToolResultArtifact(
    ref: ContextRef,
    input: { artifactId: string; offset?: number; limit?: number; maxChars?: number }
  ): ToolResult {
    const normalized = this.normalizeRef(ref);
    const artifactId = this.sanitizeArtifactToken(input.artifactId);
    if (!artifactId) {
      return { success: false, content: '', error: 'artifact_id is required.' };
    }
    const namespacePath = path.resolve(this.eventStore.getNamespacePath(normalized));
    const artifactPath = path.resolve(namespacePath, 'tool-results', `${artifactId}.txt`);
    let artifactRoot: string;
    try {
      artifactRoot = this.ensureToolResultArtifactRoot(namespacePath);
    } catch (error) {
      return { success: false, content: '', error: error instanceof Error ? error.message : String(error) };
    }
    if (!this.isPathWithinDir(artifactPath, artifactRoot)) {
      return { success: false, content: '', error: 'Artifact path is outside the session artifact directory.' };
    }
    if (!fs.existsSync(artifactPath)) {
      return { success: false, content: '', error: `Tool result artifact not found: ${artifactId}` };
    }
    try {
      this.assertSafeArtifactFilePath(artifactPath, artifactRoot);
    } catch (error) {
      return { success: false, content: '', error: error instanceof Error ? error.message : String(error) };
    }
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = resolveArtifactReadLineLimit(input.limit);
    const maxChars = resolveArtifactReadMaxChars(input.maxChars);
    const maxScanBytes = ARTIFACT_READ_MAX_SCAN_BYTES;
    try {
      const content = this.readTextLineWindow(artifactPath, offset, limit, maxChars, maxScanBytes);
      return {
        success: true,
        content: buildReadToolResultArtifactContent({
          artifactId,
          offset,
          limit,
          maxChars,
          maxScanBytes,
          content,
        }),
      };
    } catch (error) {
      return {
        success: false,
        content: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  summarize(
    ref: ContextRef,
    options?: {
      turnId?: string;
      includePending?: boolean;
      includeMeta?: boolean;
    }
  ): string {
    return this.inspect(ref, options).summary;
  }

  /**
   * REQ-0012: Validate context version chain - detects jumps >1 increment
   */
  validateVersionChain(ref: ContextRef): ContextVersionChain {
    return this.integrityHelper.validateVersionChain(this.normalizeRef(ref));
  }

  /**
   * REQ-0009: Context integrity check before subagent spawn
   * Returns the current projection with integrity metadata
   */
  checkContextIntegrity(ref: ContextRef): {
    valid: boolean;
    projection: ContextProjection;
    versionChain: ContextVersionChain;
    integrityHash: string;
  } {
    return this.integrityHelper.checkContextIntegrity(this.normalizeRef(ref));
  }

  /**
   * REQ-0009: Begin an atomic context-write transaction.
   * All events added via addTransactionEvent are buffered until commit.
   */
  beginTransaction(ref: ContextRef): ContextTransaction {
    return this.transactionCoordinator.beginTransaction(this.normalizeRef(ref));
  }

  /**
   * REQ-0009: Add an event to a pending transaction.
   */
  addTransactionEvent(transactionId: string, event: ContextEvent): boolean {
    return this.transactionCoordinator.addTransactionEvent(transactionId, event);
  }

  /**
   * REQ-0009: Commit a transaction atomically - all buffered events are written together.
   */
  commitTransaction(transactionId: string): boolean {
    return this.transactionCoordinator.commitTransaction(transactionId);
  }

  /**
   * REQ-0009: Rollback a transaction - discard all buffered events.
   */
  rollbackTransaction(transactionId: string): boolean {
    return this.transactionCoordinator.rollbackTransaction(transactionId);
  }

  /**
   * REQ-0012: Automatic rollback to last known good state when version jump detected.
   * Returns the validation result indicating if rollback was performed.
   */
  autoRollbackOnJump(ref: ContextRef): ContextValidationResult | null {
    return this.transactionCoordinator.autoRollbackOnJump(this.normalizeRef(ref));
  }

  private commitPendingTurn(
    pending: PendingTurn,
    turnId: string,
    input: CommitTurnInput,
    options?: {
      bufferedEventCount?: number;
      keepPendingTurn?: boolean;
      extraBufferedEvents?: ContextEvent[];
    }
  ): CommitTurnResult {
    const promptState = this.resolveTurnPromptState({
      prompt: pending.prompt,
      rawUserPrompt: input.rawUserPrompt ?? pending.rawUserPrompt,
      historyUserPrompt: input.historyUserPrompt ?? pending.historyUserPrompt,
      effectivePrompt: input.effectivePrompt ?? pending.effectivePrompt,
      promptRef: input.promptRef ?? pending.promptRef,
      promptInjected: input.promptInjected,
      inheritedPromptInjected: pending.promptInjected,
    });

    const structuredEvents = this.messagesToEvents(pending.ref, turnId, input.messages, {
      primaryUserPromptOverride: promptState.rawUserPrompt,
    });
    const toolCalls = structuredEvents.filter((event) => event.type === 'tool_call').length;
    const finalOutput = this.resolveFinalOutputText(input.finalOutputText, input.messages);
    const summaryEventData = this.buildTurnSummaryEventData({
      promptState,
      toolCalls,
      finalOutput,
      finishReason: input.finishReason,
      usage: input.usage,
    });
    const summary = String(summaryEventData.summary ?? '');
    const summaryEvent = this.createEvent(pending.ref, turnId, 'turn_summary', summaryEventData);
    const committedEvent = this.createEvent(pending.ref, turnId, 'turn_committed', {
      messageCount: input.messages.length,
      finishReason: input.finishReason ?? '',
      usage: input.usage ? { ...input.usage } : undefined,
    });
    const requestedBufferedCount =
      typeof options?.bufferedEventCount === 'number' && Number.isFinite(options.bufferedEventCount)
        ? Math.floor(options.bufferedEventCount)
        : pending.bufferedEvents.length;
    const bufferedCount = Math.max(1, Math.min(pending.bufferedEvents.length, requestedBufferedCount));
    const bufferedEvents = pending.bufferedEvents.slice(0, bufferedCount);
    const allEvents = [
      ...bufferedEvents,
      ...(options?.extraBufferedEvents ?? []),
      ...structuredEvents,
      summaryEvent,
      committedEvent,
    ];
    this.eventStore.appendEvents(pending.ref.scope, pending.ref.namespace, allEvents, {
      workspaceDir: pending.workspaceDir,
      expectedEventCount: pending.eventSequenceBase,
    });
    if (structuredEvents.some((event) => event.type === 'context_compaction')) {
      this.clearDerivedCompressedHistoryContext(pending.ref);
    }

    if (options?.keepPendingTurn !== true) {
      this.replayCheckpointCoordinator.drop(turnId);
      this.pendingTurns.delete(turnId);
      this.interruptedTurnStore.clearDraft(pending.ref);
    }
    const projection = this.getProjection(pending.ref);
    return {
      turnId,
      context: pending.ref,
      contextVersion: projection.version,
      summary,
    };
  }

  private generateTurnId(): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `turn-${timestamp}-${random}`;
  }

  private sanitizeArtifactToken(value: string): string {
    return String(value ?? '')
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 120);
  }

  private isPathWithinDir(filePath: string, dirPath: string): boolean {
    const relativePath = path.relative(path.resolve(dirPath), path.resolve(filePath));
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  }

  private ensureToolResultArtifactRoot(namespacePath: string): string {
    const artifactRoot = path.resolve(namespacePath, 'tool-results');
    if (!this.isPathWithinDir(artifactRoot, namespacePath)) {
      throw new Error('Tool result artifact root is outside the current context namespace.');
    }
    if (fs.existsSync(namespacePath)) {
      const namespaceStat = fs.lstatSync(namespacePath);
      if (namespaceStat.isSymbolicLink()) {
        throw new Error('Context namespace path must not be a symbolic link.');
      }
      if (!namespaceStat.isDirectory()) {
        throw new Error('Context namespace path is not a directory.');
      }
    } else {
      fs.mkdirSync(namespacePath, { recursive: true });
    }
    const realNamespacePath = fs.realpathSync.native(namespacePath);
    if (fs.existsSync(artifactRoot)) {
      const rootStat = fs.lstatSync(artifactRoot);
      if (rootStat.isSymbolicLink()) {
        throw new Error('Tool result artifact root must not be a symbolic link.');
      }
    } else {
      fs.mkdirSync(artifactRoot, { recursive: true });
    }
    const postCreateStat = fs.lstatSync(artifactRoot);
    if (postCreateStat.isSymbolicLink()) {
      throw new Error('Tool result artifact root must not be a symbolic link.');
    }
    if (!postCreateStat.isDirectory()) {
      throw new Error('Tool result artifact root is not a directory.');
    }
    const realArtifactRoot = fs.realpathSync.native(artifactRoot);
    if (!this.isPathWithinDir(realArtifactRoot, realNamespacePath)) {
      throw new Error('Tool result artifact root resolves outside the current context namespace.');
    }
    return artifactRoot;
  }

  private assertSafeArtifactFilePath(artifactPath: string, artifactRoot: string): void {
    if (!this.isPathWithinDir(artifactPath, artifactRoot)) {
      throw new Error('Tool result artifact path is outside the session artifact directory.');
    }
    const realArtifactRoot = fs.realpathSync.native(artifactRoot);
    if (!this.isPathWithinDir(path.dirname(artifactPath), artifactRoot)) {
      throw new Error('Tool result artifact parent is outside the session artifact directory.');
    }
    if (!fs.existsSync(artifactPath)) {
      return;
    }
    const stat = fs.lstatSync(artifactPath);
    if (stat.isSymbolicLink()) {
      throw new Error('Tool result artifact file must not be a symbolic link.');
    }
    if (!stat.isFile()) {
      throw new Error('Tool result artifact path is not a file.');
    }
    const realArtifactPath = fs.realpathSync.native(artifactPath);
    if (!this.isPathWithinDir(realArtifactPath, realArtifactRoot)) {
      throw new Error('Tool result artifact file resolves outside the session artifact directory.');
    }
  }

  private readTextLineWindow(
    filePath: string,
    offset: number,
    limit: number,
    maxChars: number,
    maxScanBytes: number
  ): string {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    let carry = '';
    let skipped = 0;
    let emitted = 0;
    let out = '';
    let position = 0;
    try {
      while (emitted < limit && out.length < maxChars && position < maxScanBytes) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
        if (bytesRead <= 0) {
          break;
        }
        position += bytesRead;
        const chunk = carry + buffer.toString('utf-8', 0, bytesRead).replace(/\r\n/g, '\n');
        const lines = chunk.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          if (skipped < offset) {
            skipped += 1;
            continue;
          }
          if (emitted >= limit || out.length >= maxChars) {
            break;
          }
          out += (out.length > 0 ? '\n' : '') + line;
          emitted += 1;
        }
      }
      if (carry.length > 0 && emitted < limit && out.length < maxChars && skipped >= offset) {
        out += (out.length > 0 ? '\n' : '') + carry;
      }
      if (out.length > maxChars) {
        return `${out.slice(0, maxChars)}\n[${TOOL_RESULT_PAYLOAD_MARKERS.artifactTruncated} max_chars=${maxChars}]`;
      }
      if (position >= maxScanBytes && emitted < limit) {
        const suffix = `[${TOOL_RESULT_PAYLOAD_MARKERS.artifactScanLimitReached} max_scan_bytes=${maxScanBytes} next_offset=${offset + emitted}]`;
        return out.length > 0 ? `${out}\n${suffix}` : suffix;
      }
      return out;
    } finally {
      fs.closeSync(fd);
    }
  }

  private collectCarryForwardContextPatchEvents(pending: PendingTurn, bufferedEventCount: number): ContextEvent[] {
    const startIndex = Math.max(1, Math.floor(bufferedEventCount));
    return pending.bufferedEvents
      .slice(startIndex)
      .filter((event) => event.type === 'context_patch')
      .map((event) => ({
        ...event,
        data: { ...event.data },
      }));
  }

  private isContextCompactionMessage(message: Message): boolean {
    return message.role === 'assistant' && this.messageText(message.content).trim().startsWith('[CONTEXT_PRECOMPRESSED');
  }

  private normalizeRef(ref: ContextRef): ContextRef {
    const scope = ref.scope;
    if (scope !== 'session' && scope !== 'workspace' && scope !== 'global') {
      throw new Error(`Invalid context scope: ${String(scope)}`);
    }
    const namespace = (ref.namespace ?? '').trim();
    if (!namespace) {
      throw new Error('context.namespace cannot be empty');
    }
    return { scope, namespace };
  }

  private createEvent(
    ref: ContextRef,
    turnId: string,
    type: ContextEvent['type'],
    data: Record<string, unknown>
  ): ContextEvent {
    const timestamp = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      scope: ref.scope,
      namespace: ref.namespace,
      turnId,
      type,
      timestamp,
      data,
    };
  }

  private messagesToEvents(
    ref: ContextRef,
    turnId: string,
    messages: Message[],
    options?: { primaryUserPromptOverride?: string }
  ): ContextEvent[] {
    const events: ContextEvent[] = [];
    let primaryUserPromptUsed = false;
    for (const message of messages) {
      if (message.role === 'system') {
        continue;
      }
      if (message.role === 'user') {
        let content = this.messageText(message.content);
        if (!primaryUserPromptUsed && options?.primaryUserPromptOverride !== undefined) {
          content = options.primaryUserPromptOverride;
          primaryUserPromptUsed = true;
        }
        events.push(this.createEvent(ref, turnId, 'user_message', { content }));
        continue;
      }
      if (message.role === 'assistant') {
        if (this.isContextCompactionMessage(message)) {
          const content = this.messageText(message.content);
          events.push(
            this.createEvent(ref, turnId, 'context_compaction', {
              summary: content,
              totalCharsBefore: message.metadata?.originalSize ?? undefined,
              totalCharsAfter: message.metadata?.compressedSize ?? undefined,
              sourceRange: message.metadata?.contextCompaction?.sourceRange,
              sourceCoverage: message.metadata?.contextCompaction?.sourceCoverage,
              sealedBoundary: message.metadata?.contextCompaction?.sealedBoundary,
              payloadMetrics: message.metadata?.contextCompaction?.payloadMetrics,
              configFingerprint: message.metadata?.contextCompaction?.configFingerprint,
              formatVersion: 1,
            })
          );
          continue;
        }
        events.push(
          this.createEvent(ref, turnId, 'assistant_message', {
            content: this.messageText(message.content),
            thinking: message.thinking ?? '',
            thinkingSignature: message.thinkingSignature ?? '',
            llmProviderProfileId: message.metadata?.llmProviderProfileId ?? '',
            llmProvider: message.metadata?.llmProvider ?? '',
            llmModel: message.metadata?.llmModel ?? '',
            thinkingComplete: message.metadata?.thinkingComplete ?? false,
          })
        );
        if (message.toolCalls && message.toolCalls.length > 0) {
          for (const toolCall of message.toolCalls) {
            events.push(
              this.createEvent(ref, turnId, 'tool_call', {
                name: toolCall.function.name,
                args: toolCall.function.arguments,
                toolCallId: toolCall.id,
              })
            );
          }
        }
        continue;
      }
      if (message.role === 'tool') {
        const artifact = message.metadata?.toolResultArtifact;
        events.push(
          this.createEvent(ref, turnId, 'tool_result', {
            name: message.name ?? '',
            content: this.messageText(message.content),
            toolCallId: message.toolCallId ?? '',
            artifact,
          })
        );
      }
    }
    return events;
  }

  private messageText(content: Message['content']): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .map((block) => {
        if (block.type === 'text') {
          return block.text ?? '';
        }
        if (block.type === 'tool_result') {
          return block.content ?? '';
        }
        if (block.type === 'tool_use') {
          return JSON.stringify(block.input ?? {});
        }
        return '';
      })
      .join('\n');
  }

  private normalizeTurnText(value: string | undefined): string {
    return typeof value === 'string' ? value : '';
  }

  private cloneMessages(messages: Message[]): Message[] {
    return JSON.parse(JSON.stringify(messages)) as Message[];
  }

  private normalizePromptRef(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private resolveTurnPromptState(input: {
    prompt: string;
    rawUserPrompt?: string;
    historyUserPrompt?: string;
    effectivePrompt?: string;
    promptRef?: string;
    promptInjected?: boolean;
    inheritedPromptInjected?: boolean;
  }): TurnPromptState {
    const rawUserPrompt = this.normalizeTurnText(input.rawUserPrompt ?? input.prompt);
    const historyUserPrompt = this.normalizeTurnText(input.historyUserPrompt ?? rawUserPrompt);
    const effectivePrompt = this.normalizeTurnText(input.effectivePrompt ?? input.prompt);
    const promptRef = this.normalizePromptRef(input.promptRef);
    const promptInjected =
      input.promptInjected === true ||
      input.inheritedPromptInjected === true ||
      Boolean(promptRef) ||
      effectivePrompt !== rawUserPrompt ||
      historyUserPrompt !== rawUserPrompt;
    return {
      rawUserPrompt,
      historyUserPrompt,
      effectivePrompt,
      promptRef,
      promptInjected,
    };
  }

  private buildTurnSummaryEventData(input: {
    promptState: TurnPromptState;
    toolCalls: number;
    finalOutput: string;
    finishReason?: string;
    usage?: TokenUsage;
  }): Record<string, unknown> {
    const { promptState } = input;
    const finalOutput = input.finishReason === 'cancelled' ? '' : input.finalOutput;
    return {
      summary: this.buildTurnSummaryV2(promptState.promptInjected, input.toolCalls),
      prompt: promptState.promptInjected ? undefined : promptState.rawUserPrompt,
      promptRef: promptState.promptInjected
        ? this.resolveTurnSummaryPromptRef(promptState.promptRef)
        : undefined,
      finalOutput,
      toolCalls: input.toolCalls,
      finishReason: input.finishReason ?? '',
      usage: input.usage ? { ...input.usage } : undefined,
    };
  }

  private resolveTurnSummaryPromptRef(promptRef: string | undefined): string {
    return promptRef ?? '[PROMPT_REF reason=system_injection source=system]';
  }

  private resolveFinalOutputText(finalOutputText: string | undefined, messages: Message[]): string {
    if (typeof finalOutputText === 'string') {
      return finalOutputText;
    }
    const assistantMessages = messages.filter((item) => item.role === 'assistant');
    if (assistantMessages.length === 0) {
      return '';
    }
    return this.messageText(assistantMessages[assistantMessages.length - 1].content);
  }

  private resolveReplayCheckpointFinalOutputText(messages: Message[]): string {
    if (messages.length === 0) {
      return '';
    }
    const lastMessage = messages[messages.length - 1];
    if (
      lastMessage.role === 'assistant' &&
      (!lastMessage.toolCalls || lastMessage.toolCalls.length === 0)
    ) {
      return this.messageText(lastMessage.content);
    }
    return '';
  }

  private trimMessagesToReplaySafeBoundary(messages: Message[]): Message[] {
    const { frames } = buildToolProtocolFrames(messages);
    const out: Message[] = [];
    for (const frame of frames) {
      if (frame.kind === 'assistant_tool_bundle') {
        out.push(...this.cloneMessages([frame.assistant]));
        out.push(...this.cloneMessages(frame.toolResults));
        continue;
      }
      const message = frame.message;
      if (message.role === 'tool') {
        break;
      }
      if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
        break;
      }
      out.push(this.cloneMessages([message])[0]!);
    }
    return out;
  }

  private buildTurnSummaryV2(promptInjected: boolean, toolCalls: number): string {
    const promptMode = promptInjected ? 'reference' : 'inline';
    return `turn_summary_v2 prompt=${promptMode} final_output=recorded tool_calls=${toolCalls}`;
  }

  /**
   * Creates a context checkpoint before sub-agent invocation or sensitive operations.
   * Returns a checkpoint containing the hash of current state for later validation.
   */
  createCheckpoint(ref: ContextRef, reason: string): ContextCheckpointResult {
    return this.integrityHelper.createCheckpoint(this.normalizeRef(ref), reason);
  }

  /**
   * Validates that context state matches the checkpoint.
   * If validation fails and rollback is requested, restores from the checkpoint.
   */
  validateCheckpoint(ref: ContextRef, checkpoint: ContextCheckpoint, performRollback = false): ContextValidationResult {
    return this.integrityHelper.validateCheckpoint(this.normalizeRef(ref), checkpoint, performRollback);
  }

  /**
   * Computes current context hash for monitoring purposes.
   */
  computeContextHash(ref: ContextRef): string {
    return this.integrityHelper.computeContextHash(this.normalizeRef(ref));
  }

  private clearDerivedCompressedHistoryContext(ref: ContextRef): void {
    const meta = this.eventStore.loadMeta(ref.scope, ref.namespace);
    if (!meta || !meta.compressedHistoryContext) {
      return;
    }
    this.eventStore.saveMeta(ref.scope, ref.namespace, {
      ...meta,
      compressedHistoryContext: undefined,
    });
  }

  /**
   * REQ-0018: Detects summary drift between expected summary and actual context state.
   * Compares projected summary with LLM-provided summary and flags inconsistencies.
   */
  detectSummaryDrift(ref: ContextRef, expectedSummary: string): {
    hasDrift: boolean;
    projectedSummary: string;
    expectedSummary: string;
    driftScore: number; // 0.0 = identical, 1.0 = completely different
    driftReason: string;
  } {
    return this.integrityHelper.detectSummaryDrift(this.normalizeRef(ref), expectedSummary);
  }

  private getPendingOverlaySource(turnId?: string): PendingTurn | undefined {
    if (!turnId) {
      return undefined;
    }
    return this.pendingTurns.get(turnId);
  }
}
