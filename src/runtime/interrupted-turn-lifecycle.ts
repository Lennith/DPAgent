import * as crypto from 'crypto';
import type { ContextManager } from '../context/index.js';
import {
  buildSideEffectLedgerFromPreview,
  hasCheckpointProgress,
  slicePreviewMessages,
} from '../interrupted-turn-recovery.js';
import type { ContextRef, InterruptedArtifact, Message, RunTerminalState } from '../types.js';

export interface InterruptedTurnStartState {
  artifact?: InterruptedArtifact;
  draftId: string;
  runFamilyId: string;
}

export interface PrepareInterruptedTurnStartInput {
  runId: string;
  runFamilyId?: string;
}

export function prepareInterruptedContextForTurnStart(
  contextManager: ContextManager,
  context: ContextRef,
  input: PrepareInterruptedTurnStartInput
): InterruptedTurnStartState {
  const artifact = contextManager.getInterruptedArtifact(context);
  if (!artifact) {
    return {
      artifact: undefined,
      draftId: createDraftId(),
      runFamilyId: input.runFamilyId?.trim() || input.runId,
    };
  }
  return {
    artifact,
    draftId: artifact.draftId,
    runFamilyId: artifact.runFamilyId,
  };
}

export interface BuildRunTerminalStateInput {
  runId: string;
  runFamilyId: string;
  draftId: string;
  terminalCode: RunTerminalState['terminalCode'];
  replayCutoffKind: RunTerminalState['replayCutoffKind'];
  lastSafeStep: number;
  maxSteps: number;
  errorSummary?: string | null;
  artifact?: InterruptedArtifact | null;
}

export function buildRunTerminalState(input: BuildRunTerminalStateInput): RunTerminalState {
  return {
    runId: input.runId,
    runFamilyId: input.runFamilyId,
    draftId: input.draftId,
    terminalCode: input.terminalCode,
    lastSafeStep: Math.max(0, Math.floor(input.lastSafeStep)),
    maxSteps: Math.max(0, Math.floor(input.maxSteps)),
    replayCutoffKind: input.replayCutoffKind,
    errorSummary: input.errorSummary ?? null,
    createdAt: new Date().toISOString(),
    artifact: input.artifact ?? null,
  };
}

export interface FinalizeInterruptedRunInput {
  context: ContextRef;
  turnId: string;
  runId: string;
  runFamilyId: string;
  draftId: string;
  maxSteps: number;
  step: number;
  terminalCode: 'cancelled' | 'error';
  turnMessages: Message[];
  errorSummary?: string;
}

export interface FinalizeInterruptedRunResult {
  artifact: InterruptedArtifact | null;
  terminalState: RunTerminalState;
  contextVersion: number;
}

export function finalizeInterruptedRun(
  contextManager: ContextManager,
  input: FinalizeInterruptedRunInput
): FinalizeInterruptedRunResult {
  const draftRecord = contextManager.getDraftRecord(input.context);
  const checkpoint = draftRecord?.checkpoint;
  const safeMessages = checkpoint?.messages ?? [];
  const previewMessages = slicePreviewMessages(input.turnMessages, safeMessages);
  const sideEffectLedger = buildSideEffectLedgerFromPreview(previewMessages);
  const hasCarryForwardContextPatches = contextManager.hasCarryForwardContextPatchEvents(
    input.turnId,
    checkpoint?.bufferedEventCount ?? 1
  );
  const artifact =
    hasCheckpointProgress(safeMessages) ||
    hasCarryForwardContextPatches ||
    sideEffectLedger.length > 0 ||
    previewMessages.length > 0
      ? contextManager.finalizeInterruptedTurn(input.turnId, {
          terminalCode: input.terminalCode,
          maxSteps: input.maxSteps,
          lastSafeStep: checkpoint?.step ?? 0,
          errorSummary: input.errorSummary,
          previewMessages,
          sideEffectLedger,
        })
      : (contextManager.abortTurn(input.turnId), null);
  const projection = contextManager.getProjection(input.context);
  return {
    artifact,
    terminalState: buildRunTerminalState({
      runId: input.runId,
      runFamilyId: input.runFamilyId,
      draftId: input.draftId,
      terminalCode: input.terminalCode,
      replayCutoffKind: artifact?.replayCutoffKind ?? 'none',
      lastSafeStep: artifact?.lastSafeStep ?? 0,
      maxSteps: input.maxSteps,
      errorSummary: artifact?.errorSummary ?? input.errorSummary ?? null,
      artifact,
    }),
    contextVersion: projection.version,
  };
}

function createDraftId(): string {
  return `draft-${crypto.randomUUID()}`;
}
