import type { Request, Response } from 'express';
import type { ArenaConfig, ArenaMode } from '../../arena/types.js';
import { ArenaCoordinator, ArenaRouteError } from './ArenaCoordinator.js';
import { toSessionContext, type WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';
import { rejectObserveOnlyIfNeeded } from './web-server-route-guards.js';

function sendArenaError(res: Response, error: unknown): void {
  if (error instanceof ArenaRouteError) {
    res.status(error.status).json({ success: false, error: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /invalid|cannot|requires|required/i.test(message) ? 409 : 500;
  res.status(status).json({ success: false, error: status === 404 ? 'not_found' : 'arena_error', message });
}

function requireFullAccess(deps: WebServerRouteRegistrationDependencies, req: Request, res: Response): boolean {
  if (deps.accessServices?.hasFullAccess(req) ?? true) {
    return true;
  }
  res.status(403).json({ success: false, error: 'share_scope_forbidden', code: 'SHARE_SCOPE_FORBIDDEN' });
  return false;
}

function requireSessionAccess(
  deps: WebServerRouteRegistrationDependencies,
  req: Request,
  res: Response,
  sessionId: string
): boolean {
  if (deps.accessServices?.canAccessSession(req, sessionId) ?? true) {
    return true;
  }
  res.status(403).json({ success: false, error: 'share_scope_forbidden', code: 'SHARE_SCOPE_FORBIDDEN' });
  return false;
}

function normalizeArenaMode(value: unknown): ArenaMode | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'answer' || normalized === 'implementation') {
    return normalized;
  }
  return undefined;
}

function readConfigBody(body: unknown): Partial<ArenaConfig> {
  const input = (body ?? {}) as { config?: Partial<ArenaConfig>; contestants?: ArenaConfig['contestants']; judge?: ArenaConfig['judge'] };
  return input.config ?? {
    ...(input.contestants ? { contestants: input.contestants } : {}),
    ...(input.judge ? { judge: input.judge } : {}),
  };
}

export function registerArenaRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const coordinator = new ArenaCoordinator(deps);

  deps.app.post('/api/sessions/:id/arena', (req: Request, res: Response) => {
    if (!requireFullAccess(deps, req, res) || !requireSessionAccess(deps, req, res, req.params.id)) {
      return;
    }
    const context = toSessionContext(req.params.id);
    if (rejectObserveOnlyIfNeeded(deps, context, res)) {
      return;
    }
    try {
      const body = (req.body ?? {}) as { mode?: unknown; prompt?: unknown };
      const run = coordinator.createArena({
        sessionId: req.params.id,
        mode: normalizeArenaMode(body.mode),
        prompt: String(body.prompt ?? ''),
        config: readConfigBody(req.body),
      });
      res.json({ success: true, arena: run, lastConfig: coordinator.store.getLastConfig() });
    } catch (error) {
      sendArenaError(res, error);
    }
  });

  deps.app.get('/api/sessions/:id/arena', (req: Request, res: Response) => {
    if (!requireSessionAccess(deps, req, res, req.params.id)) {
      return;
    }
    try {
      const arena = coordinator.getRunForSource(req.params.id);
      res.json({ success: true, arena, lastConfig: coordinator.store.getLastConfig() });
    } catch (error) {
      sendArenaError(res, error);
    }
  });

  deps.app.patch('/api/arena/:arenaId/config', (req: Request, res: Response) => {
    if (!requireFullAccess(deps, req, res)) {
      return;
    }
    try {
      const arena = coordinator.updateConfig(req.params.arenaId, readConfigBody(req.body));
      res.json({ success: true, arena });
    } catch (error) {
      sendArenaError(res, error);
    }
  });

  const registerMutation = (path: string, handler: (coordinator: ArenaCoordinator, req: Request) => unknown): void => {
    deps.app.post(path, (req: Request, res: Response) => {
      if (!requireFullAccess(deps, req, res)) {
        return;
      }
      try {
        const arena = handler(coordinator, req);
        res.json({ success: true, arena });
      } catch (error) {
        sendArenaError(res, error);
      }
    });
  };

  registerMutation('/api/arena/:arenaId/start', (arena, req) => arena.start(req.params.arenaId));
  registerMutation('/api/arena/:arenaId/pause', (arena, req) => arena.pause(req.params.arenaId));
  registerMutation('/api/arena/:arenaId/resume', (arena, req) => arena.resume(req.params.arenaId));
  registerMutation('/api/arena/:arenaId/close', (arena, req) => arena.close(req.params.arenaId));
  registerMutation('/api/arena/:arenaId/judge', (arena, req) => arena.judge(req.params.arenaId));
  registerMutation('/api/arena/:arenaId/winner', (arena, req) => {
    const body = (req.body ?? {}) as { branchId?: unknown; reason?: unknown };
    return arena.selectWinner(req.params.arenaId, {
      branchId: String(body.branchId ?? ''),
      reason: String(body.reason ?? ''),
    });
  });
  registerMutation('/api/arena/:arenaId/proposal', (arena, req) => arena.createProposal(req.params.arenaId));
  registerMutation('/api/arena/:arenaId/apply', (arena, req) => arena.apply(req.params.arenaId));
  registerMutation('/api/arena/:arenaId/branches/:branchId/reopen', (arena, req) =>
    arena.reopenBranch(req.params.arenaId, req.params.branchId)
  );
  registerMutation('/api/arena/:arenaId/branches/:branchId/promote', (arena, req) =>
    arena.promoteBranch(req.params.arenaId, req.params.branchId)
  );
}
