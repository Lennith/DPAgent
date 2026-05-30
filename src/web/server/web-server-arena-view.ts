import type { ContextNamespaceMeta } from '../../types.js';

export interface SessionArenaRouteView {
  locked: boolean;
  runId?: string;
  branchId?: string;
  promoted?: boolean;
  mode?: 'answer' | 'implementation';
}

export function buildSessionArenaRouteView(
  meta: Pick<ContextNamespaceMeta, 'arenaLock' | 'arenaBranch' | 'arenaJudge'> | null | undefined
): SessionArenaRouteView | null {
  if (!meta) {
    return null;
  }
  if (meta.arenaLock) {
    return {
      locked: true,
      runId: meta.arenaLock.arenaId,
      mode: meta.arenaLock.mode,
    };
  }
  if (meta.arenaBranch) {
    return {
      locked: false,
      runId: meta.arenaBranch.arenaId,
      branchId: meta.arenaBranch.branchId,
      promoted: meta.arenaBranch.promoted === true,
    };
  }
  if (meta.arenaJudge) {
    return {
      locked: false,
      runId: meta.arenaJudge.arenaId,
    };
  }
  return null;
}

export function shouldHideArenaBranchSession(
  meta: Pick<ContextNamespaceMeta, 'arenaBranch' | 'arenaJudge'> | null | undefined
): boolean {
  return Boolean((meta?.arenaBranch && meta.arenaBranch.promoted !== true) || meta?.arenaJudge);
}
