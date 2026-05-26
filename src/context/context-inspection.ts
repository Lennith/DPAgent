import type {
  ContextEvent,
  ContextInspectKeyState,
  ContextInspectableMeta,
  ContextInspectState,
  ContextNamespaceMeta,
  ContextPendingOverlay,
  ContextPendingPatchView,
  ContextProjection,
  ContextRef,
} from '../types.js';

export interface PendingOverlaySource {
  ref: ContextRef;
  bufferedEvents: ContextEvent[];
}

export interface CreateContextInspectStateInput {
  context: ContextRef;
  projection: ContextProjection;
  pendingOverlay?: ContextPendingOverlay;
  meta?: ContextInspectableMeta;
}

export function buildPendingOverlay(
  ref: ContextRef,
  turnId: string | undefined,
  pending?: PendingOverlaySource
): ContextPendingOverlay | undefined {
  if (!turnId || !pending) {
    return undefined;
  }
  if (pending.ref.scope !== ref.scope || pending.ref.namespace !== ref.namespace) {
    return undefined;
  }
  const patches: ContextPendingPatchView[] = pending.bufferedEvents
    .filter((event) => event.type === 'context_patch')
    .map((event) => {
      const op: ContextPendingPatchView['op'] = event.data.op === 'delete' ? 'delete' : 'set';
      return {
        key: String(event.data.key ?? '').trim(),
        op,
        value: typeof event.data.value === 'string' ? event.data.value : undefined,
        source: typeof event.data.source === 'string' ? event.data.source : undefined,
      };
    })
    .filter((patch) => patch.key.length > 0);
  if (patches.length === 0) {
    return undefined;
  }
  return {
    turnId,
    patchCount: patches.length,
    patches,
  };
}

export function applyPendingOverlayToKeyValues(
  committedKeyValues: Record<string, string>,
  patches: ContextPendingPatchView[]
): Record<string, string> {
  const effective = { ...committedKeyValues };
  for (const patch of patches) {
    if (patch.op === 'delete') {
      delete effective[patch.key];
      continue;
    }
    effective[patch.key] = patch.value ?? '';
  }
  return effective;
}

export function toInspectableMeta(meta?: ContextNamespaceMeta): ContextInspectableMeta | undefined {
  if (!meta) {
    return undefined;
  }
  return {
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    workspaceDir: meta.workspaceDir,
    toolsetName: meta.toolsetName,
    memoryPromotionState: meta.memoryPromotionState,
    compressedHistoryContext: meta.compressedHistoryContext,
    autoLoopConfig: meta.autoLoopConfig,
    agentInjectionState: meta.agentInjectionState,
    planningState: meta.planningState,
    automationRun: meta.automationRun,
    completionMarkerStats: meta.completionMarkerStats,
    pendingPlanInput: meta.pendingPlanInput,
    runtimeErrors: meta.runtimeErrors,
  };
}

export function buildInspectableSummary(input: {
  effectiveKeyValues: Record<string, string>;
  pendingOverlay?: ContextPendingOverlay;
  meta?: ContextInspectableMeta;
}): string {
  const lines: string[] = [];
  const pairs = Object.entries(input.effectiveKeyValues);
  if (pairs.length > 0) {
    lines.push(
      `Structured context: ${pairs
        .slice(0, 8)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ')}`
    );
    if (pairs.length > 8) {
      lines.push(`Structured context has ${pairs.length - 8} additional keys not shown here.`);
    }
  } else {
    lines.push('Structured context is empty.');
  }

  if (input.pendingOverlay && input.pendingOverlay.patchCount > 0) {
    const changes = input.pendingOverlay.patches
      .slice(0, 6)
      .map((patch) => (patch.op === 'delete' ? `delete ${patch.key}` : `set ${patch.key}=${patch.value ?? ''}`))
      .join('; ');
    lines.push(`Pending overlay: ${changes}`);
    if (input.pendingOverlay.patchCount > 6) {
      lines.push(`Pending overlay has ${input.pendingOverlay.patchCount - 6} additional patches.`);
    }
  }

  if (input.meta?.workspaceDir) {
    lines.push(`Workspace: ${input.meta.workspaceDir}`);
  }
  if (input.meta?.toolsetName) {
    lines.push(`Toolset: ${input.meta.toolsetName}`);
  }
  if (input.meta?.compressedHistoryContext) {
    lines.push(
      `Compressed older-session context is available for ${input.meta.compressedHistoryContext.sealedRoundCount} sealed rounds.`
    );
  }
  if (input.meta?.agentInjectionState?.lastProfileName) {
    const source = input.meta.agentInjectionState.lastProfileSource ?? 'unknown';
    lines.push(`Active agent: ${input.meta.agentInjectionState.lastProfileName} (${source})`);
  }
  if (input.meta?.memoryPromotionState) {
    const status = input.meta.memoryPromotionState.status ?? 'idle';
    lines.push(
      `Memory organize status: ${status}; pending_turns=${input.meta.memoryPromotionState.pendingTurnCount}`
    );
  }
  if (input.meta?.autoLoopConfig) {
    const status = input.meta.autoLoopConfig.enabled ? 'enabled' : 'disabled';
    const suffix = input.meta.autoLoopConfig.pausedByUser ? ' (paused by user)' : '';
    lines.push(`Auto-loop: ${status}${suffix}`);
  }
  if (input.meta?.automationRun?.jobId) {
    lines.push(`Automation run: job=${input.meta.automationRun.jobId} status=${input.meta.automationRun.status}`);
  }
  if (input.meta?.completionMarkerStats?.repairCount) {
    const stats = input.meta.completionMarkerStats;
    lines.push(
      `Completion marker repairs: ${stats.repairCount}${stats.lastIssue ? `; last_issue=${stats.lastIssue}` : ''}`
    );
  }
  if (input.meta?.pendingPlanInput?.requestId) {
    lines.push(`Pending user input: request=${input.meta.pendingPlanInput.requestId}`);
  }

  return lines.join('\n');
}

export function createContextInspectState(input: CreateContextInspectStateInput): ContextInspectState {
  const effectiveKeyValues = applyPendingOverlayToKeyValues(
    input.projection.keyValues,
    input.pendingOverlay?.patches ?? []
  );
  const summary = buildInspectableSummary({
    effectiveKeyValues,
    pendingOverlay: input.pendingOverlay,
    meta: input.meta,
  });
  return {
    context: input.context,
    projection: input.projection,
    effectiveKeyValues,
    summary,
    pendingOverlay: input.pendingOverlay,
    meta: input.meta,
  };
}

export function inspectContextKeyState(
  inspection: ContextInspectState,
  key: string
): ContextInspectKeyState {
  const normalizedKey = key.trim();
  const committedValue = inspection.projection.keyValues[normalizedKey];
  const lastPendingPatch = [...(inspection.pendingOverlay?.patches ?? [])]
    .reverse()
    .find((patch) => patch.key === normalizedKey);

  if (lastPendingPatch?.op === 'delete') {
    return {
      key: normalizedKey,
      found: false,
      value: null,
      sourceStatus: 'pending_delete',
      committedValue: committedValue ?? null,
    };
  }

  if (lastPendingPatch?.op === 'set') {
    return {
      key: normalizedKey,
      found: true,
      value: lastPendingPatch.value ?? '',
      sourceStatus: 'pending_override',
      committedValue: committedValue ?? null,
    };
  }

  if (committedValue !== undefined) {
    return {
      key: normalizedKey,
      found: true,
      value: committedValue,
      sourceStatus: 'committed',
    };
  }

  return {
    key: normalizedKey,
    found: false,
    value: null,
    sourceStatus: 'missing',
  };
}
