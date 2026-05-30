import type { Request, Response } from 'express';
import type { ContextNamespaceMeta, ContextRef, SessionInteractionState } from '../../types.js';
import type { ActiveRunRouteView } from './web-server-route-contracts.js';

export interface ObserveOnlyGuardDependencies {
  contextServices: {
    getInteractionStateForContext: (context: ContextRef) => SessionInteractionState;
    getActiveRunState: (context: ContextRef) => ActiveRunRouteView | null;
    getContextNamespaceMetaSafe?: (context: ContextRef) => ContextNamespaceMeta | undefined;
  };
}

export interface ShareOnlyGuardDependencies {
  accessServices?: {
    getSharedAccessSessionId: (req: Request) => string | null;
    hasFullAccess: (req: Request) => boolean;
  };
}

function buildObserveOnlyConflict(deps: ObserveOnlyGuardDependencies, ref: ContextRef) {
  const interactionState = deps.contextServices.getInteractionStateForContext(ref);
  if (interactionState.mode !== 'observe_only') {
    return null;
  }
  return {
    success: false,
    error: 'observe_only',
    activeRun: deps.contextServices.getActiveRunState(ref),
    interactionState,
  };
}

export function rejectObserveOnlyIfNeeded(
  deps: ObserveOnlyGuardDependencies,
  ref: ContextRef,
  res: Response
): boolean {
  const conflict = buildObserveOnlyConflict(deps, ref);
  if (!conflict) {
    return false;
  }
  res.status(409).json(conflict);
  return true;
}

export function rejectArenaLockedIfNeeded(
  deps: ObserveOnlyGuardDependencies,
  ref: ContextRef,
  res: Response
): boolean {
  const meta = deps.contextServices.getContextNamespaceMetaSafe?.(ref);
  if (meta?.arenaJudge || (meta?.arenaBranch && meta.arenaBranch.promoted !== true)) {
    res.status(409).json({
      success: false,
      error: 'arena_hidden_session',
      arena: meta.arenaJudge
        ? {
            locked: false,
            runId: meta.arenaJudge.arenaId,
          }
        : {
            locked: false,
            runId: meta.arenaBranch?.arenaId,
            branchId: meta.arenaBranch?.branchId,
            promoted: false,
          },
    });
    return true;
  }
  if (meta?.arenaLock) {
    res.status(409).json({
      success: false,
      error: 'arena_locked',
      arena: {
        locked: true,
        runId: meta.arenaLock.arenaId,
        mode: meta.arenaLock.mode,
      },
    });
    return true;
  }
  return false;
}

export function rejectShareOnlyIfNeeded(
  deps: ShareOnlyGuardDependencies,
  req: Request,
  res: Response
): boolean {
  const sharedSessionId = deps.accessServices?.getSharedAccessSessionId(req) ?? null;
  if (!sharedSessionId || deps.accessServices?.hasFullAccess(req)) {
    return false;
  }
  res.status(403).json({
    error: 'Share link cannot access this resource',
    code: 'SHARE_SCOPE_FORBIDDEN',
  });
  return true;
}
