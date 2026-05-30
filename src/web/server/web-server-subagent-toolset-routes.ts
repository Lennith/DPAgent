import type { Request, Response } from 'express';
import { toSessionContext, type WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';
import { rejectArenaLockedIfNeeded, rejectObserveOnlyIfNeeded } from './web-server-route-guards.js';
import type { ContextRef, SubAgentStatus } from '../../types.js';

function resolveToolsetRouteWorkspace(
  deps: WebServerRouteRegistrationDependencies,
  input: {
    sessionId: string;
    explicitWorkspaceDir?: unknown;
    defaultWorkspaceDir?: string;
  }
): { context: ContextRef | null; workspaceDir: string | undefined } {
  const context = input.sessionId ? toSessionContext(input.sessionId) : null;
  const explicitWorkspaceDir = String(input.explicitWorkspaceDir ?? '').trim();
  return {
    context,
    workspaceDir:
      explicitWorkspaceDir ||
      (context ? deps.contextServices.resolveWorkspaceDirForContext(context) : input.defaultWorkspaceDir),
  };
}

function resolveSubagentRouteItem(
  subAgentManager: { list: (parentContext: ContextRef) => SubAgentStatus[] },
  context: ContextRef,
  subagentId: string,
  res: Response
): SubAgentStatus | null {
  const existingItem = subAgentManager
    .list(context)
    .find((item) => item.subagentId === subagentId);
  if (!existingItem) {
    res.status(404).json({ error: 'Subagent not found' });
    return null;
  }
  return existingItem;
}

function resolveSubagentRoutePrompt(
  existingItem: SubAgentStatus,
  action: 'retry' | 'resume',
  res: Response
): string | null {
  const prompt = String(existingItem.prompt ?? '').trim();
  if (!prompt) {
    res.status(400).json({ error: `Cannot ${action} subagent: original prompt is unavailable` });
    return null;
  }
  return prompt;
}

export function registerSubagentAndToolsetRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { contextServices } = deps;

  deps.app.get('/api/sessions/:id/subagents', (req: Request, res: Response) => {
    try {
      const context = toSessionContext(req.params.id);
      const items = contextServices.resolveAgentForContext(context).getSubAgentManager().list(context);
      res.json({ items });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  deps.app.post('/api/sessions/:id/subagents/:subagentId/cancel', (req: Request, res: Response) => {
    try {
      const context = toSessionContext(req.params.id);
      if (rejectObserveOnlyIfNeeded(deps, context, res)) {
        return;
      }
      if (rejectArenaLockedIfNeeded(deps, context, res)) {
        return;
      }
      const status = contextServices
        .resolveAgentForContext(context)
        .getSubAgentManager()
        .cancel(context, req.params.subagentId);
      if (!status) {
        res.status(404).json({ error: 'Subagent not found' });
        return;
      }
      res.json({ success: true, status });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  deps.app.post('/api/sessions/:id/subagents/:subagentId/retry', (req: Request, res: Response) => {
    try {
      const context = toSessionContext(req.params.id);
      if (rejectObserveOnlyIfNeeded(deps, context, res)) {
        return;
      }
      if (rejectArenaLockedIfNeeded(deps, context, res)) {
        return;
      }
      const subAgentManager = contextServices.resolveAgentForContext(context).getSubAgentManager();
      const existingItem = resolveSubagentRouteItem(subAgentManager, context, req.params.subagentId, res);
      if (!existingItem) {
        return;
      }
      if (existingItem.status !== 'failed' && existingItem.status !== 'timeout') {
        res.status(400).json({ error: `Cannot retry subagent with status: ${existingItem.status}` });
        return;
      }
      const prompt = resolveSubagentRoutePrompt(existingItem, 'retry', res);
      if (!prompt) {
        return;
      }

      const result = subAgentManager.create({
        parentContext: context,
        prompt,
        providerId: existingItem.providerId,
        agentName: existingItem.agent?.name,
        allowedTools: existingItem.allowedTools,
        workspaceDir: existingItem.workspaceDir,
      });

      if (!result.ok) {
        res.status(400).json({ error: result.error, code: result.code });
        return;
      }
      res.json({ success: true, status: result.status });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  deps.app.post('/api/sessions/:id/subagents/:subagentId/resume', (req: Request, res: Response) => {
    try {
      const context = toSessionContext(req.params.id);
      if (rejectObserveOnlyIfNeeded(deps, context, res)) {
        return;
      }
      if (rejectArenaLockedIfNeeded(deps, context, res)) {
        return;
      }
      const subAgentManager = contextServices.resolveAgentForContext(context).getSubAgentManager();
      const existingItem = resolveSubagentRouteItem(subAgentManager, context, req.params.subagentId, res);
      if (!existingItem) {
        return;
      }
      if (existingItem.status !== 'canceled') {
        res.status(400).json({ error: `Cannot resume subagent with status: ${existingItem.status}` });
        return;
      }
      const prompt = resolveSubagentRoutePrompt(existingItem, 'resume', res);
      if (!prompt) {
        return;
      }

      const result = subAgentManager.resume({
        parentContext: context,
        subagentId: req.params.subagentId,
        prompt,
        providerId: existingItem.providerId,
        agentName: existingItem.agent?.name,
        allowedTools: existingItem.allowedTools,
        workspaceDir: existingItem.workspaceDir,
      });

      if (!result.ok) {
        res.status(400).json({ error: result.error, code: result.code });
        return;
      }
      res.json({ success: true, status: result.status });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  deps.app.get('/api/toolsets', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const resolvedWorkspace = resolveToolsetRouteWorkspace(deps, {
      sessionId,
      defaultWorkspaceDir: deps.agent.getConfig().agent.workspaceDir,
    });
    const { context } = resolvedWorkspace;
    const workspaceDir = resolvedWorkspace.workspaceDir as string;
    const meta = context ? deps.agent.getContextNamespaceMeta(context) : undefined;
    const workspacePreset = deps.agent.getToolsetPresetStore().getWorkspacePreset(workspaceDir);
    const teamPreset = deps.agent.getToolsetPresetStore().getTeamPreset();
    const activeToolset = context
      ? deps.agent.resolveToolsetName(context)
      : deps.agent.getConfig().agent.defaultToolset;
    const activeSource = meta?.toolsetName
      ? 'session'
      : workspacePreset
        ? 'workspace'
        : teamPreset
          ? 'team'
          : 'default';
    res.json({
      toolsets: deps.agent.listToolsets(),
      activeToolset,
      activeSource,
      defaultToolset: deps.agent.getConfig().agent.defaultToolset,
      presets: {
        teamPreset,
        workspacePreset,
      },
      workspaceDir,
    });
  });

  deps.app.get('/api/toolsets/presets', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const { workspaceDir } = resolveToolsetRouteWorkspace(deps, {
      sessionId,
      explicitWorkspaceDir: req.query.workspaceDir,
    });
    res.json({
      ...deps.agent.listToolsetPresets(),
      workspacePreset: workspaceDir
        ? deps.agent.getToolsetPresetStore().getWorkspacePreset(workspaceDir)
        : undefined,
    });
  });

  deps.app.post('/api/toolsets/presets', (req: Request, res: Response) => {
    try {
      const body = req.body as {
        sessionId?: string;
        scope?: 'team' | 'workspace';
        toolsetName?: string;
        workspaceDir?: string;
      };
      const scope = String(body.scope ?? '').trim().toLowerCase();
      const toolsetName = String(body.toolsetName ?? '').trim();
      if ((scope !== 'team' && scope !== 'workspace') || !toolsetName) {
        res.status(400).json({ error: 'scope and toolsetName are required' });
        return;
      }
      const sessionId = String(body.sessionId ?? '').trim();
      const { context, workspaceDir } = resolveToolsetRouteWorkspace(deps, {
        sessionId,
        explicitWorkspaceDir: body.workspaceDir,
      });
      if (context && rejectObserveOnlyIfNeeded(deps, context, res)) {
        return;
      }
      if (context && rejectArenaLockedIfNeeded(deps, context, res)) {
        return;
      }
      const record = deps.agent.setToolsetPreset({
        scope,
        toolsetName,
        workspaceDir,
        sessionId: sessionId || undefined,
      });
      res.json({ success: true, record });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.delete('/api/toolsets/presets', (req: Request, res: Response) => {
    const scope = String(req.query.scope ?? '').trim().toLowerCase();
    if (scope !== 'team' && scope !== 'workspace') {
      res.status(400).json({ error: 'scope must be team or workspace' });
      return;
    }
    const sessionId = String(req.query.sessionId ?? '').trim();
    const { context, workspaceDir } = resolveToolsetRouteWorkspace(deps, {
      sessionId,
      explicitWorkspaceDir: req.query.workspaceDir,
    });
    if (context && rejectObserveOnlyIfNeeded(deps, context, res)) {
      return;
    }
    if (context && rejectArenaLockedIfNeeded(deps, context, res)) {
      return;
    }
    const success = deps.agent.clearToolsetPreset({
      scope,
      workspaceDir,
      sessionId: sessionId || undefined,
    });
    if (!success) {
      res.status(404).json({ error: 'Preset not found' });
      return;
    }
    res.json({ success: true });
  });

  deps.app.post('/api/sessions/:id/toolset', (req: Request, res: Response) => {
    const toolsetName = String((req.body as { toolsetName?: string }).toolsetName ?? '').trim();
    if (!toolsetName) {
      res.status(400).json({ error: 'toolsetName is required' });
      return;
    }
    const context = toSessionContext(req.params.id);
    if (rejectObserveOnlyIfNeeded(deps, context, res)) {
      return;
    }
    if (rejectArenaLockedIfNeeded(deps, context, res)) {
      return;
    }
    try {
      const resolved = deps.agent.getToolsetRegistry().get(toolsetName);
      const nextMeta = deps.agent.updateContextNamespaceMeta(context, {
        toolsetName: resolved.name,
      });
      deps.agent.getGovernanceAuditStore().append({
        kind: 'session_toolset_overridden',
        title: `Session toolset override set to ${resolved.name}`,
        sessionId: req.params.id,
        workspaceDir: contextServices.resolveWorkspaceDirForContext(context),
        entityType: 'toolset',
        entityId: resolved.name,
        status: 'success',
      });
      res.json({ success: true, toolsetName: resolved.name, meta: nextMeta });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
