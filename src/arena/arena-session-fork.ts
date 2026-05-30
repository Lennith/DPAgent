import { createStateId, nowIso } from '../storage/index.js';
import type { ContextNamespaceMeta, ContextRef } from '../types.js';
import type { ArenaBranch, ArenaRun } from './types.js';

export interface ArenaBranchSessionForkHost {
  forkSessionNamespace(input: {
    sourceNamespace: string;
    targetNamespace: string;
    name?: string;
    origin?: ContextNamespaceMeta['origin'];
  }): ContextNamespaceMeta;
  updateNamespaceMeta(ref: ContextRef, updates: Partial<ContextNamespaceMeta>): ContextNamespaceMeta;
}

function trimString(value: unknown): string {
  return String(value ?? '').trim();
}

export function createArenaBranchSessionNamespace(branch: ArenaBranch): string {
  return createStateId(`arena-${branch.index + 1}`, 5);
}

export function forkArenaBranchSession(input: {
  host: ArenaBranchSessionForkHost;
  run: ArenaRun;
  branch: ArenaBranch;
  targetNamespace?: string;
  workspaceDir?: string;
}): ContextNamespaceMeta {
  const targetNamespace = trimString(input.targetNamespace) || createArenaBranchSessionNamespace(input.branch);
  const name = `${input.run.sourceSessionName || input.run.sourceSessionId}-arena-${input.branch.index + 1}`;
  input.host.forkSessionNamespace({
    sourceNamespace: input.run.sourceSessionId,
    targetNamespace,
    name,
    origin: 'web',
  });
  return input.host.updateNamespaceMeta(
    { scope: 'session', namespace: targetNamespace },
    {
      name,
      arenaLock: undefined,
      workspaceDir: trimString(input.workspaceDir) || undefined,
      toolsetName: input.run.mode === 'implementation' ? 'arena-implementation' : 'windows-safe',
      llmSelection: input.branch.contestant.llmSelection,
      agentInjectionState: input.branch.contestant.agentName
        ? {
            lastExplicitAgentName: input.branch.contestant.agentName,
            updatedAt: nowIso(),
          }
        : undefined,
      arenaBranch: {
        arenaId: input.run.id,
        branchId: input.branch.id,
        sourceSessionId: input.run.sourceSessionId,
      },
    }
  );
}
