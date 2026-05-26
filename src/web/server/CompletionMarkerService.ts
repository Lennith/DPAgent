import {
  classifyCompletionMarkerIssue,
  hasRequiredCompletionMarker,
  isCompletionMarkerEnforcementEnabled,
} from '../../completion-marker-policy.js';
import type {
  AgentConfig,
  CompletionMarkerStats,
  ContextNamespaceMeta,
  ContextRef,
} from '../../types.js';

export interface CompletionMarkerServiceOptions {
  getAgentConfig: () => AgentConfig['agent'];
  getContextNamespaceMeta: (context: ContextRef) => ContextNamespaceMeta | undefined;
  updateContextNamespaceMeta: (context: ContextRef, patch: Partial<ContextNamespaceMeta>) => void;
  logger?: {
    info?: (message: string) => void;
  };
}

export interface ResolveCompletionMarkerStatsInput {
  context: ContextRef;
  result: string;
  repairRequired: boolean;
}

export class CompletionMarkerService {
  constructor(private readonly options: CompletionMarkerServiceOptions) {}

  isEnforcementEnabled(): boolean {
    return isCompletionMarkerEnforcementEnabled(this.options.getAgentConfig());
  }

  hasRequiredMarker(result: string): boolean {
    return hasRequiredCompletionMarker(result);
  }

  classifyIssue(result: string): CompletionMarkerStats['lastIssue'] {
    return classifyCompletionMarkerIssue(result);
  }

  readStats(context: ContextRef): CompletionMarkerStats {
    const existing = this.options.getContextNamespaceMeta(context)?.completionMarkerStats;
    const repairCount = Number.isFinite(existing?.repairCount)
      ? Math.max(0, Number(existing?.repairCount))
      : 0;
    return {
      repairCount,
      ...(existing?.lastTriggeredAt ? { lastTriggeredAt: existing.lastTriggeredAt } : {}),
      ...(existing?.lastResolvedAt ? { lastResolvedAt: existing.lastResolvedAt } : {}),
      ...(existing?.lastIssue ? { lastIssue: existing.lastIssue } : {}),
    };
  }

  recordRepair(
    context: ContextRef,
    issue: CompletionMarkerStats['lastIssue']
  ): CompletionMarkerStats {
    const current = this.readStats(context);
    const next: CompletionMarkerStats = {
      ...current,
      repairCount: current.repairCount + 1,
      lastTriggeredAt: new Date().toISOString(),
      lastIssue: issue,
    };
    this.options.updateContextNamespaceMeta(context, { completionMarkerStats: next });
    this.options.logger?.info?.(
      `[CompletionMarker] repair scheduled: context=${context.scope}/${context.namespace} count=${next.repairCount} issue=${issue}`
    );
    return next;
  }

  markRepairResolved(context: ContextRef): CompletionMarkerStats {
    const current = this.readStats(context);
    if (current.repairCount === 0) {
      return current;
    }
    const next: CompletionMarkerStats = {
      ...current,
      lastResolvedAt: new Date().toISOString(),
    };
    this.options.updateContextNamespaceMeta(context, { completionMarkerStats: next });
    return next;
  }

  resolveStatsForCompletion(input: ResolveCompletionMarkerStatsInput): CompletionMarkerStats | null {
    if (!this.isEnforcementEnabled()) {
      return null;
    }
    if (input.repairRequired) {
      return this.recordRepair(input.context, this.classifyIssue(input.result));
    }
    if (this.hasRequiredMarker(input.result)) {
      return this.markRepairResolved(input.context);
    }
    return this.readStats(input.context);
  }
}
