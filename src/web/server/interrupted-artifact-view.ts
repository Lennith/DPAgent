import type { InterruptedArtifact, RunTerminalState, SideEffectLedgerEntry } from '../../types.js';

function sanitizeSideEffectLedgerEntry(entry: SideEffectLedgerEntry): Omit<SideEffectLedgerEntry, 'args'> {
  return {
    id: entry.id,
    observedAt: entry.observedAt,
    toolName: entry.toolName,
    toolCallId: entry.toolCallId,
    resultSuccess: entry.resultSuccess,
    resultSummary: entry.resultSummary,
  };
}

export function toInterruptedArtifactView(artifact: InterruptedArtifact | null | undefined) {
  if (!artifact) {
    return null;
  }
  return {
    artifactId: artifact.artifactId,
    context: artifact.context,
    draftId: artifact.draftId,
    turnId: artifact.turnId,
    runId: artifact.runId,
    runFamilyId: artifact.runFamilyId,
    terminalCode: artifact.terminalCode,
    replayCutoffKind: artifact.replayCutoffKind,
    resumable: artifact.resumable,
    lastSafeStep: artifact.lastSafeStep,
    maxSteps: artifact.maxSteps,
    errorSummary: artifact.errorSummary,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    previewMessages: artifact.previewMessages,
    sideEffectLedger: artifact.sideEffectLedger.map((entry) => sanitizeSideEffectLedgerEntry(entry)),
    ...(artifact.checkpointTurnId ? { checkpointTurnId: artifact.checkpointTurnId } : {}),
    ...(artifact.dismissedAt ? { dismissedAt: artifact.dismissedAt } : {}),
  };
}

export function toRunTerminalStateView(state: RunTerminalState) {
  return {
    runId: state.runId,
    runFamilyId: state.runFamilyId,
    draftId: state.draftId,
    terminalCode: state.terminalCode,
    resumable: state.resumable,
    lastSafeStep: state.lastSafeStep,
    maxSteps: state.maxSteps,
    replayCutoffKind: state.replayCutoffKind,
    errorSummary: state.errorSummary,
    createdAt: state.createdAt,
    artifact: toInterruptedArtifactView(state.artifact ?? null),
  };
}
