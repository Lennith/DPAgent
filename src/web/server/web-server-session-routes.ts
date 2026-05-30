import express, { Request, Response } from 'express';
import * as path from 'node:path';
import {
  applySessionLlmSelectionInput,
  resolveSessionLlmSelection,
} from '../../llm/provider-profiles.js';
import { autoLoopManager, DEFAULT_AUTO_LOOP_CONFIG, type AutoLoopConfig } from '../../auto-loop/index.js';
import type { SessionLlmSelectionInput } from '../../types.js';
import { buildPublicSettingsView, serializeLlmProfile } from './config-mutation-service.js';
import { findLlmProfile } from './web-server-settings-route-utils.js';
import { buildShareTextHistory, normalizeShareTextTurns } from './share-text-protocol.js';
import type { ResolvedSessionShare } from './session-share-service.js';
import { saveDroppedSessionFile } from './session-dropped-file-store.js';
import { resolveShareUrlForRequest } from './session-share-url-resolver.js';
import {
  toSessionContext,
  type WebServerRouteRegistrationDependencies,
} from './web-server-route-contracts.js';
import { createSessionNamespace } from './web-server-shared.js';
import { rejectArenaLockedIfNeeded, rejectObserveOnlyIfNeeded } from './web-server-route-guards.js';
import { buildSessionArenaRouteView, shouldHideArenaBranchSession } from './web-server-arena-view.js';
import { webServerLogger } from '../../utils/logger.js';

const DROPPED_FILE_UPLOAD_LIMIT = '64mb';

function resolveSessionOrigin(item: { origin?: 'web' | 'cli' | 'automation'; automationRun?: { jobId?: string } | null }): 'web' | 'cli' | 'automation' {
  if (item.automationRun?.jobId) {
    return 'automation';
  }
  return item.origin ?? 'web';
}

function isReasoningPresetValue(value: unknown): boolean {
  return value === 'off' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max';
}

function buildAbsoluteShareUrl(req: Request, url: string, configuredPublicBaseUrl?: string): string {
  const protocol = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http')
    .split(',')[0]
    .trim() || 'http';
  const resolved = resolveShareUrlForRequest({
    url,
    requestHost: String(req.headers.host ?? ''),
    protocol,
    configuredPublicBaseUrl,
    localPort: req.socket.localPort,
  });
  webServerLogger.info(
    `[WebServer] Share URL resolved requestHost=${resolved.diagnostics.requestHost || '(none)'} chosenHost=${resolved.diagnostics.chosenHost || '(none)'} reason=${resolved.diagnostics.reason}`
  );
  return resolved.url;
}

function resolveExitAutoLoopConfig(
  currentConfig: Partial<AutoLoopConfig> | undefined,
  mode: 'normal' | 'force'
): AutoLoopConfig {
  const merged = {
    ...DEFAULT_AUTO_LOOP_CONFIG,
    ...currentConfig,
  };
  const ralphEnabled = merged.ralphEnabled ?? (merged.mode === 'ralph' ? merged.enabled : false);
  if (mode === 'normal') {
    return {
      ...merged,
      enabled: ralphEnabled,
      mode: 'ralph',
      ralphEnabled,
      pendingPlanConfirmation: false,
      pausedByUser: false,
    };
  }
  return {
    ...merged,
    enabled: false,
    mode: 'todo',
    ralphEnabled,
    pendingPlanConfirmation: false,
    pausedByUser: true,
  };
}

function resolveShareRouteToken(
  deps: WebServerRouteRegistrationDependencies,
  token: string,
  res: Response
): ResolvedSessionShare | null {
  const resolved = deps.shareServices?.resolveShareToken(token);
  if (!resolved) {
    res.status(401).json({ error: 'Share link is invalid or expired', code: 'SHARE_TOKEN_INVALID' });
    return null;
  }
  return resolved;
}

function rejectFullAccessIfNeeded(
  accessServices: { hasFullAccess: (req: Request) => boolean },
  req: Request,
  res: Response,
  error: string
): boolean {
  if (accessServices.hasFullAccess(req)) {
    return false;
  }
  res.status(403).json({ error, code: 'SHARE_SCOPE_FORBIDDEN' });
  return true;
}

function rejectSessionAccessIfNeeded(
  accessServices: { canAccessSession: (req: Request, sessionId: string) => boolean },
  req: Request,
  res: Response,
  sessionId: string
): boolean {
  if (accessServices.canAccessSession(req, sessionId)) {
    return false;
  }
  res.status(403).json({ error: 'Share link cannot access this session', code: 'SHARE_SCOPE_FORBIDDEN' });
  return true;
}

export function registerSessionRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { contextServices } = deps;
  const accessServices = deps.accessServices ?? {
    canAccessSession: () => true,
    hasFullAccess: () => true,
    getSharedAccessSessionId: () => null,
  };

  deps.app.get('/api/share/:token', (req: Request, res: Response) => {
    const resolved = resolveShareRouteToken(deps, req.params.token, res);
    if (!resolved) {
      return;
    }
    res.json({
      mode: 'shared_ls',
      sessionId: resolved.sessionId,
      expiresAt: resolved.expiresAt,
    });
  });

  deps.app.get('/api/share/:token/settings', (req: Request, res: Response) => {
    const resolved = resolveShareRouteToken(deps, req.params.token, res);
    if (!resolved) {
      return;
    }
    const settings = buildPublicSettingsView(
      deps.agent.getConfig(),
      deps.configServices.hasUsableApiKey()
    );
    res.json({
      hasApiKey: settings.hasApiKey,
      llmProfiles: settings.llmProfiles,
    });
  });

  deps.app.get('/api/share/:token/text-history', (req: Request, res: Response) => {
    const resolved = resolveShareRouteToken(deps, req.params.token, res);
    if (!resolved) {
      return;
    }
    const meta = contextServices.getContextNamespaceMetaSafe(toSessionContext(resolved.sessionId));
    if (meta && shouldHideArenaBranchSession(meta)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const turns = normalizeShareTextTurns(req.query.turns, 3);
    const messages = deps.agent.getContextMessages(toSessionContext(resolved.sessionId), {
      includeInterruptedCheckpoints: false,
    });
    res.json({
      sessionId: resolved.sessionId,
      turns,
      messages: buildShareTextHistory(messages, turns),
    });
  });

  deps.app.get('/api/sessions', (req: Request, res: Response) => {
    try {
      const includeAutomation =
        String(req.query.includeAutomation ?? '').trim().toLowerCase() === 'true';
      const config = deps.agent.getConfig();
      const activeRunsBySession = new Map(
        deps.contextServices
          .listActiveSessionRunStates()
          .map((activeRun) => [activeRun.context.namespace, activeRun])
      );
      const persistedSessionMetas = deps.agent
        .getContextManager()
        .listNamespaces('session')
        .filter((item) => accessServices.canAccessSession(req, item.namespace))
        .filter((item) => includeAutomation || !item.automationRun?.jobId);
      const persistedIds = new Set(persistedSessionMetas.map((session) => session.namespace));
      const persistedSessions = persistedSessionMetas
        .filter((item) => !shouldHideArenaBranchSession(item))
        .map((item) => ({
          id: item.namespace,
          name: item.name || item.namespace,
          workspaceDir: item.workspaceDir,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          contextVersion: item.projection.version,
          toolsetName:
            item.toolsetName ||
            deps.agent.resolveToolsetName({ scope: 'session', namespace: item.namespace }),
          memoryPromotionState: item.memoryPromotionState ?? null,
          automationRun: item.automationRun ?? null,
          completionMarkerStats: item.completionMarkerStats ?? null,
          origin: resolveSessionOrigin(item),
          llmSelection: resolveSessionLlmSelection(config, item.llmSelection),
          planningState: item.planningState ?? null,
          arena: buildSessionArenaRouteView(item),
          activeRun: activeRunsBySession.get(item.namespace) ?? null,
          interactionState: deps.contextServices.getInteractionStateForContext({
            scope: 'session',
            namespace: item.namespace,
          }),
        }));
      const activeOnlySessions = [...activeRunsBySession.values()]
        .filter((activeRun) => !persistedIds.has(activeRun.context.namespace))
        .filter((activeRun) => accessServices.canAccessSession(req, activeRun.context.namespace))
        .map((activeRun) => ({
          id: activeRun.context.namespace,
          name: activeRun.context.namespace,
          workspaceDir: contextServices.resolveWorkspaceDirForContext(activeRun.context),
          createdAt: activeRun.startedAt,
          updatedAt: activeRun.lastActivityAt,
          contextVersion: 0,
          toolsetName: deps.agent.resolveToolsetName(activeRun.context),
          memoryPromotionState: null,
          automationRun: null,
          completionMarkerStats: null,
          origin: activeRun.origin,
          llmSelection: resolveSessionLlmSelection(config, undefined),
          planningState: null,
          activeRun,
          interactionState: activeRun.interactionState,
        }));
      const sessions = [...persistedSessions, ...activeOnlySessions];
      res.json({ sessions });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  deps.app.get('/api/sessions/:id', (req: Request, res: Response) => {
    if (rejectSessionAccessIfNeeded(accessServices, req, res, req.params.id)) {
      return;
    }
    const ref = toSessionContext(req.params.id);
    const meta = contextServices.getContextNamespaceMetaSafe(ref);
    const activeRun = contextServices.getActiveRunState(ref);
    const interruptedArtifact = contextServices.getInterruptedArtifact(ref);
    if (!meta && !activeRun && !interruptedArtifact) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (meta && shouldHideArenaBranchSession(meta)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const preserveAgentProfileRefs =
      String(req.query.preserveAgentProfileRefs ?? '').trim().toLowerCase() === 'true';
    const messages = deps.agent.getContextWebMessages(ref, {
      preserveAgentProfileRefs,
      includeInterruptedCheckpoints: true,
    });
    const config = deps.agent.getConfig();
    res.json({
      id: req.params.id,
      name: meta?.name || req.params.id,
      workspaceDir: meta?.workspaceDir ?? contextServices.resolveWorkspaceDirForContext(ref),
      toolsetName: meta?.toolsetName || deps.agent.resolveToolsetName(ref),
      createdAt: meta?.createdAt ?? activeRun?.startedAt ?? interruptedArtifact?.createdAt,
      updatedAt: meta?.updatedAt ?? interruptedArtifact?.updatedAt ?? activeRun?.lastActivityAt ?? activeRun?.startedAt,
      memoryPromotionState: meta?.memoryPromotionState ?? null,
      automationRun: meta?.automationRun ?? null,
      completionMarkerStats: meta?.completionMarkerStats ?? null,
      origin: resolveSessionOrigin({
        origin: meta?.origin ?? activeRun?.origin,
        automationRun: meta?.automationRun ?? null,
      }),
      llmSelection: resolveSessionLlmSelection(config, meta?.llmSelection),
      planningState: meta?.planningState ?? null,
      arena: buildSessionArenaRouteView(meta),
      interactionState: contextServices.getInteractionStateForContext(ref),
      contextUtilization: meta?.latestContextUtilization ?? null,
      activeRun,
      interruptedArtifact,
      pendingPlanInput: contextServices.getPendingPlanInputView(ref, meta),
      runtimeErrors: meta?.runtimeErrors ?? [],
      messages,
    });
  });

  deps.app.post(
    '/api/sessions/:id/dropped-files',
    express.raw({ type: 'application/octet-stream', limit: DROPPED_FILE_UPLOAD_LIMIT }),
    (req: Request, res: Response) => {
      if (!accessServices.hasFullAccess(req)) {
        res.status(403).json({ error: 'Share link cannot upload dropped files', code: 'SHARE_SCOPE_FORBIDDEN' });
        return;
      }
      if (!accessServices.canAccessSession(req, req.params.id)) {
        res.status(403).json({ error: 'Share link cannot access this session', code: 'SHARE_SCOPE_FORBIDDEN' });
        return;
      }
      const ref = toSessionContext(req.params.id);
      if (rejectArenaLockedIfNeeded(deps, ref, res)) {
        return;
      }
      try {
        const filename = String(req.query.filename ?? '').trim();
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const runtimeDataDir =
          String(deps.agent.getConfig().agent.runtimeDataDir ?? '').trim() ||
          path.resolve('./runtime');
        const saved = saveDroppedSessionFile({
          runtimeDataDir,
          sessionId: req.params.id,
          filename,
          body,
        });
        res.json(saved);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  );

  deps.app.post('/api/sessions/:id/fork', (req: Request, res: Response) => {
    if (rejectFullAccessIfNeeded(accessServices, req, res, 'Share link cannot fork sessions')) {
      return;
    }
    if (!accessServices.canAccessSession(req, req.params.id)) {
      res.status(403).json({ error: 'Share link cannot access this session', code: 'SHARE_SCOPE_FORBIDDEN' });
      return;
    }
    const ref = toSessionContext(req.params.id);
    const meta = contextServices.getContextNamespaceMetaSafe(ref);
    if (!meta) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (rejectObserveOnlyIfNeeded(deps, ref, res)) {
      return;
    }
    if (rejectArenaLockedIfNeeded(deps, ref, res)) {
      return;
    }
    if (contextServices.getActiveRunState(ref)) {
      res.status(409).json({ error: 'Session has an active run and cannot be forked yet.' });
      return;
    }
    if (meta.pendingPlanInput) {
      res.status(409).json({ error: 'Session is waiting for plan input and cannot be forked yet.' });
      return;
    }
    if (deps.agent.getContextManager().hasInterruptedState(ref)) {
      res.status(409).json({ error: 'Session has interrupted state and cannot be forked yet.' });
      return;
    }

    try {
      const body = (req.body ?? {}) as { name?: unknown };
      const nextNamespace = createSessionNamespace();
      const nextMeta = deps.agent.getContextManager().forkSessionNamespace({
        sourceNamespace: req.params.id,
        targetNamespace: nextNamespace,
        name: typeof body.name === 'string' ? body.name.trim() : undefined,
        origin: 'web',
      });
      const config = deps.agent.getConfig();
      const projection = deps.agent.getContextManager().getProjection({
        scope: 'session',
        namespace: nextNamespace,
      });
      const session = {
        id: nextNamespace,
        name: nextMeta.name || nextNamespace,
        workspaceDir: nextMeta.workspaceDir,
        createdAt: nextMeta.createdAt,
        updatedAt: nextMeta.updatedAt,
        contextVersion: projection.version,
        toolsetName:
          nextMeta.toolsetName ||
          deps.agent.resolveToolsetName({ scope: 'session', namespace: nextNamespace }),
        memoryPromotionState: nextMeta.memoryPromotionState ?? null,
        automationRun: null,
        completionMarkerStats: null,
        origin: resolveSessionOrigin(nextMeta),
        llmSelection: resolveSessionLlmSelection(config, nextMeta.llmSelection),
        planningState: null,
        activeRun: null,
        interactionState: contextServices.getInteractionStateForContext({
          scope: 'session',
          namespace: nextNamespace,
        }),
      };
      res.json({ success: true, session, meta: nextMeta });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.get('/api/sessions/:id/llm-selection', (req: Request, res: Response) => {
    if (rejectSessionAccessIfNeeded(accessServices, req, res, req.params.id)) {
      return;
    }
    const ref = toSessionContext(req.params.id);
    const meta = contextServices.getContextNamespaceMetaSafe(ref);
    if (!meta) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (shouldHideArenaBranchSession(meta)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const config = deps.agent.getConfig();
    const llmSelection = resolveSessionLlmSelection(config, meta.llmSelection);
    const profile = findLlmProfile(config, llmSelection.profileId);
    res.json({
      llmSelection,
      profile: profile ? serializeLlmProfile(profile) : null,
    });
  });

  deps.app.put('/api/sessions/:id', (req: Request, res: Response) => {
    if (rejectFullAccessIfNeeded(accessServices, req, res, 'Share link cannot rename sessions')) {
      return;
    }
    const { name } = req.body as { name?: string };
    const ref = toSessionContext(req.params.id);
    const meta = deps.agent.getContextNamespaceMeta(ref);
    if (!meta) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (rejectObserveOnlyIfNeeded(deps, ref, res)) {
      return;
    }
    if (rejectArenaLockedIfNeeded(deps, ref, res)) {
      return;
    }
    const nextMeta = deps.agent.updateContextNamespaceMeta(ref, {
      name: typeof name === 'string' ? name.trim() : meta.name,
    });
    res.json({ success: true, meta: nextMeta });
  });

  deps.app.patch('/api/sessions/:id/llm-selection', (req: Request, res: Response) => {
    if (rejectSessionAccessIfNeeded(accessServices, req, res, req.params.id)) {
      return;
    }
    const ref = toSessionContext(req.params.id);
    const meta = deps.agent.getContextNamespaceMeta(ref);
    if (!meta) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (rejectObserveOnlyIfNeeded(deps, ref, res)) {
      return;
    }
    if (rejectArenaLockedIfNeeded(deps, ref, res)) {
      return;
    }

    const patch = req.body as SessionLlmSelectionInput;
    if (patch.reasoningPreset !== undefined && !isReasoningPresetValue(patch.reasoningPreset)) {
      res.status(400).json({ error: 'Invalid reasoningPreset' });
      return;
    }

    const config = deps.agent.getConfig();
    const currentSelection = resolveSessionLlmSelection(config, meta.llmSelection);
    const requestedUpdatedAt = typeof patch.updatedAt === 'string' ? patch.updatedAt.trim() : '';
    const requestedUpdatedAtMs = Date.parse(requestedUpdatedAt);
    if (!requestedUpdatedAt || !Number.isFinite(requestedUpdatedAtMs)) {
      res.status(400).json({ error: 'updatedAt is required and must be a valid ISO timestamp' });
      return;
    }
    if (
      patch.profileId !== undefined &&
      !findLlmProfile(config, patch.profileId)
    ) {
      res.status(400).json({ error: 'Unknown profileId' });
      return;
    }
    const currentUpdatedAtMs = Date.parse(currentSelection.updatedAt);
    if (Number.isFinite(currentUpdatedAtMs) && requestedUpdatedAtMs < currentUpdatedAtMs) {
      res.status(409).json({
        error: 'LLM selection update is stale',
        llmSelection: currentSelection,
      });
      return;
    }

    const nextSelection = applySessionLlmSelectionInput(config, meta.llmSelection, patch);

    const nextMeta = deps.agent.updateContextNamespaceMeta(ref, {
      llmSelection: nextSelection,
    });
    res.json({
      success: true,
      llmSelection: nextSelection,
      meta: nextMeta,
    });
  });

  deps.app.post('/api/sessions/:id/plan-draft/exit', (req: Request, res: Response) => {
    if (rejectFullAccessIfNeeded(accessServices, req, res, 'Share link cannot change plan state')) {
      return;
    }
    const ref = toSessionContext(req.params.id);
    const meta = contextServices.getContextNamespaceMetaSafe(ref);
    if (rejectObserveOnlyIfNeeded(deps, ref, res)) {
      return;
    }
    if (rejectArenaLockedIfNeeded(deps, ref, res)) {
      return;
    }
    if (!meta?.planningState || meta.planningState.state !== 'plan_drafting') {
      res.status(409).json({ success: false, error: 'Session is not in plan drafting.' });
      return;
    }

    const body = (req.body ?? {}) as { reason?: unknown };
    const exitedAt = new Date().toISOString();
    const nextAutoLoopConfig = resolveExitAutoLoopConfig(meta.autoLoopConfig, 'normal');
    const controller = autoLoopManager.get(req.params.id);
    controller?.updateConfig(nextAutoLoopConfig);
    contextServices.updateContextNamespaceMetaSafe(ref, {
      planningState: {
        ...meta.planningState,
        state: 'normal',
        pendingPlanId: undefined,
        activeExecutionPlanId: undefined,
        updatedAt: exitedAt,
      },
      pendingPlanInput: undefined,
      autoLoopConfig: nextAutoLoopConfig,
      lastPlanExecutionExit: {
        mode: 'normal',
        reason: String(body.reason ?? '').trim() || undefined,
        planId: meta.planningState.pendingPlanId,
        unfinishedTodoCount: 0,
        exitedAt,
      },
    });
    res.json({
      success: true,
      planningState: 'normal',
      autoLoopConfig: nextAutoLoopConfig,
    });
  });

  deps.app.post('/api/sessions/:id/plan-execution/exit', (req: Request, res: Response) => {
    if (rejectFullAccessIfNeeded(accessServices, req, res, 'Share link cannot change plan state')) {
      return;
    }
    const ref = toSessionContext(req.params.id);
    const meta = contextServices.getContextNamespaceMetaSafe(ref);
    if (rejectObserveOnlyIfNeeded(deps, ref, res)) {
      return;
    }
    if (rejectArenaLockedIfNeeded(deps, ref, res)) {
      return;
    }
    if (!meta?.planningState || meta.planningState.state !== 'plan_executing') {
      res.status(409).json({ success: false, error: 'Session is not in plan execution.' });
      return;
    }

    const body = (req.body ?? {}) as { mode?: unknown; reason?: unknown };
    const mode = String(body.mode ?? '').trim().toLowerCase();
    if (mode !== 'normal' && mode !== 'force') {
      res.status(400).json({ success: false, error: 'mode must be normal or force.' });
      return;
    }

    const workspaceDir = contextServices.resolveWorkspaceDirForContext(ref);
    const todoState = deps.todoServices.getSessionTodoProtocolState(req.params.id, workspaceDir);
    if (mode === 'normal' && todoState.hasUnfinished) {
      res.status(409).json({
        success: false,
        error: 'Cannot normally exit plan execution while unfinished todos remain.',
        unfinishedTodoCount: todoState.unfinishedItems.length,
      });
      return;
    }

    if (mode === 'force') {
      contextServices.resolveAgentForContext(ref).cancelContext(ref);
    }

    const controller = autoLoopManager.get(req.params.id);
    controller?.stop('user_stop');
    const exitedAt = new Date().toISOString();
    const nextAutoLoopConfig = resolveExitAutoLoopConfig(meta.autoLoopConfig, mode);
    controller?.updateConfig(nextAutoLoopConfig);
    contextServices.updateContextNamespaceMetaSafe(ref, {
      planningState: {
        ...meta.planningState,
        state: 'normal',
        pendingPlanId: undefined,
        activeExecutionPlanId: undefined,
        updatedAt: exitedAt,
      },
      autoLoopConfig: nextAutoLoopConfig,
      lastPlanExecutionExit: {
        mode,
        reason: String(body.reason ?? '').trim() || undefined,
        planId: meta.planningState.activeExecutionPlanId,
        unfinishedTodoCount: todoState.unfinishedItems.length,
        exitedAt,
      },
    });
    res.json({
      success: true,
      mode,
      planningState: 'normal',
      unfinishedTodoCount: todoState.unfinishedItems.length,
      autoLoopConfig: nextAutoLoopConfig,
    });
  });

  deps.app.delete('/api/sessions/:id', async (req: Request, res: Response) => {
    try {
      if (!accessServices.hasFullAccess(req)) {
        res.status(403).json({ success: false, error: 'Share link cannot delete sessions', code: 'SHARE_SCOPE_FORBIDDEN' });
        return;
      }
      const ref = toSessionContext(req.params.id);
      if (rejectObserveOnlyIfNeeded(deps, ref, res)) {
        return;
      }
      if (rejectArenaLockedIfNeeded(deps, ref, res)) {
        return;
      }
      await contextServices.cleanupSessionRuntime(req.params.id);
      const success = deps.agent.deleteSessionContext(req.params.id);
      res.json({ success });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  deps.app.get('/api/sessions/:id/share', (req: Request, res: Response) => {
    if (rejectFullAccessIfNeeded(accessServices, req, res, 'Share link cannot manage shares')) {
      return;
    }
    const meta = contextServices.getContextNamespaceMetaSafe(toSessionContext(req.params.id));
    if (meta && shouldHideArenaBranchSession(meta)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(deps.shareServices?.getSessionShareStatus(req.params.id) ?? { active: false });
  });

  deps.app.post('/api/sessions/:id/share', (req: Request, res: Response) => {
    if (rejectFullAccessIfNeeded(accessServices, req, res, 'Share link cannot manage shares')) {
      return;
    }
    try {
      if (!deps.shareServices) {
        res.status(500).json({ error: 'Share service is unavailable' });
        return;
      }
      const meta = contextServices.getContextNamespaceMetaSafe(toSessionContext(req.params.id));
      if (meta && shouldHideArenaBranchSession(meta)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const created = deps.shareServices.createSessionShare(req.params.id);
      const config = deps.agent.getConfig();
      res.json({
        ...created,
        url: buildAbsoluteShareUrl(req, created.url, config.web?.publicBaseUrl),
      });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.delete('/api/sessions/:id/share', (req: Request, res: Response) => {
    if (rejectFullAccessIfNeeded(accessServices, req, res, 'Share link cannot manage shares')) {
      return;
    }
    const meta = contextServices.getContextNamespaceMetaSafe(toSessionContext(req.params.id));
    if (meta && shouldHideArenaBranchSession(meta)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(deps.shareServices?.revokeSessionShare(req.params.id) ?? { active: false });
  });

  deps.automationRoutes.register(deps.app);
}
