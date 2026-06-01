import type { Request, Response } from 'express';
import { toSessionContext, type WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';
import { rejectObserveOnlyIfNeeded } from './web-server-route-guards.js';
import { shouldHideArenaBranchSession } from './web-server-arena-view.js';

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

function getTimelineStore(deps: WebServerRouteRegistrationDependencies) {
  return deps.agent.getWorkspaceTimelineStore?.();
}

function requireTimelineFeature(
  deps: WebServerRouteRegistrationDependencies,
  res: Response
): ReturnType<typeof getTimelineStore> | null {
  const store = getTimelineStore(deps);
  if (!store?.isEnabled?.()) {
    res.status(404).json({ success: false, error: 'workspace_timeline_not_found' });
    return null;
  }
  return store;
}

function rejectHiddenArenaSessionIfNeeded(
  deps: WebServerRouteRegistrationDependencies,
  sessionId: string,
  res: Response
): boolean {
  const meta = deps.contextServices.getContextNamespaceMetaSafe(toSessionContext(sessionId));
  if (!shouldHideArenaBranchSession(meta)) {
    return false;
  }
  res.status(404).json({ success: false, error: 'session_not_found' });
  return true;
}

export function registerWorkspaceTimelineRoutes(deps: WebServerRouteRegistrationDependencies): void {
  deps.app.get('/api/sessions/:id/workspace-timeline', (req: Request, res: Response) => {
    if (!requireSessionAccess(deps, req, res, req.params.id)) {
      return;
    }
    if (rejectHiddenArenaSessionIfNeeded(deps, req.params.id, res)) {
      return;
    }
    const store = requireTimelineFeature(deps, res);
    if (!store) {
      return;
    }
    res.json({ success: true, timeline: store.listSessionTimeline(req.params.id) });
  });

  deps.app.get('/api/sessions/:id/workspace-deltas/:deltaId', (req: Request, res: Response) => {
    if (!requireSessionAccess(deps, req, res, req.params.id)) {
      return;
    }
    if (rejectHiddenArenaSessionIfNeeded(deps, req.params.id, res)) {
      return;
    }
    const store = requireTimelineFeature(deps, res);
    if (!store) {
      return;
    }
    const delta = store.getDelta(req.params.deltaId) ?? null;
    if (!delta || delta.sessionId !== req.params.id) {
      res.status(404).json({ success: false, error: 'workspace_delta_not_found' });
      return;
    }
    res.json({ success: true, delta });
  });

  deps.app.post('/api/sessions/:id/workspace-rollback', (req: Request, res: Response) => {
    if (!requireFullAccess(deps, req, res) || !requireSessionAccess(deps, req, res, req.params.id)) {
      return;
    }
    const store = requireTimelineFeature(deps, res);
    if (!store) {
      return;
    }
    const context = toSessionContext(req.params.id);
    if (rejectObserveOnlyIfNeeded(deps, context, res)) {
      return;
    }
    if (deps.contextServices.getActiveRunState(context)) {
      res.status(409).json({ success: false, error: 'active_run', message: 'Session has an active run.' });
      return;
    }
    const meta = deps.contextServices.getContextNamespaceMetaSafe(context);
    if (deps.contextServices.getPendingPlanInputView(context, meta)) {
      res.status(409).json({ success: false, error: 'pending_input', message: 'Session has pending input.' });
      return;
    }
    if (deps.contextServices.getInterruptedArtifact(context)) {
      res.status(409).json({ success: false, error: 'interrupted_state', message: 'Session has interrupted state.' });
      return;
    }
    if (meta?.arenaLock) {
      res.status(409).json({ success: false, error: 'arena_locked', message: 'Session is locked by Arena.' });
      return;
    }
    if (shouldHideArenaBranchSession(meta)) {
      res.status(404).json({ success: false, error: 'session_not_found' });
      return;
    }
    const targetRevisionId = String((req.body as { targetRevisionId?: unknown } | undefined)?.targetRevisionId ?? '').trim();
    if (!targetRevisionId) {
      res.status(400).json({ success: false, error: 'target_revision_required' });
      return;
    }
    const revision = store?.getRevision(targetRevisionId) ?? null;
    if (!store || !revision || revision.context?.scope !== 'session' || revision.context.namespace !== req.params.id) {
      res.status(404).json({ success: false, error: 'workspace_revision_not_found' });
      return;
    }
    const targetIsRetained = store.listSessionTimeline(req.params.id).deltas.some(
      (delta) => delta.resultRevisionId === targetRevisionId && delta.blobState === 'available'
    );
    if (!targetIsRetained) {
      res.status(409).json({ success: false, error: 'revision_not_rollback_capable' });
      return;
    }
    const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? '');
    let applied;
    try {
      applied = store.applyRollback({
        sessionId: req.params.id,
        targetRevisionId,
        reason,
      });
    } catch (error) {
      res.status(409).json({
        success: false,
        error: 'workspace_rollback_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    deps.agent.getContextManager().recordWorkspaceRollback({
      context,
      targetRevisionId,
      changedFiles: applied.changedFiles,
      reason,
      appliedAt: applied.appliedAt,
    });
    res.status(200).json({
      success: true,
      action: 'workspace_rollback_applied',
      applied: true,
      targetRevisionId,
      changedFiles: applied.changedFiles,
      appliedAt: applied.appliedAt,
    });
  });
}
