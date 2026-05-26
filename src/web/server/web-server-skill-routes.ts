import type { Request, Response } from 'express';
import type { ContextRef } from '../../types.js';
import type { SkillCatalogEntry } from '../../skills/SkillLoader.js';
import { toSessionContext } from './web-server-route-contracts.js';

interface SkillRouteDependencies {
  app: import('express').Express;
  agent: {
    getConfig: () => { agent: { workspaceDir: string; defaultToolset?: string; skillsDir?: string } };
    resolveToolsetName: (context: ContextRef) => string;
    getSkillLoader: () => { getSkillCatalog: (input: { workspaceDir?: string; toolsetName?: string }) => SkillCatalogEntry[] };
    listSkillHistory: (input: { name: string; workspaceDir?: string }) => unknown[];
    rollbackSkill: (input: { name: string; workspaceDir?: string; version?: string; sessionId?: string }) => unknown;
    getSkillPackStore: () => { listPacks: (input: { workspaceDir?: string }) => unknown[] };
    publishSkillPack: (input: { name: string; version: string; scope: 'team' | 'workspace'; workspaceDir?: string; description?: string; skillNames?: string[]; sessionId?: string }) => unknown;
    activateSkillPack: (input: { name: string; scope: 'team' | 'workspace'; version: string; workspaceDir?: string; sessionId?: string }) => unknown;
    rollbackSkillPack: (input: { name: string; scope: 'team' | 'workspace'; workspaceDir?: string; sessionId?: string }) => unknown;
    reloadSkills: () => void;
  };
  contextServices: {
    resolveWorkspaceDirForContext: (context: ContextRef) => string;
  };
}
function resolveSkillRouteWorkspace(
  deps: SkillRouteDependencies,
  sessionId: string
): { context: ContextRef | null; workspaceDir: string } {
  const context = sessionId ? toSessionContext(sessionId) : null;
  return {
    context,
    workspaceDir: context
      ? deps.contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir,
  };
}

export function registerSkillRoutes(deps: SkillRouteDependencies): void {
  deps.app.post('/api/skills/reload', (_req: Request, res: Response) => {
    try {
      const config = deps.agent.getConfig();
      if (config.agent.skillsDir) {
        deps.agent.reloadSkills();
        res.json({ success: true });
        return;
      }
      res.json({ success: false, error: 'No skills directory configured' });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  deps.app.get('/api/skills', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const { context, workspaceDir } = resolveSkillRouteWorkspace(deps, sessionId);
    const toolsetName = context
      ? deps.agent.resolveToolsetName(context)
      : deps.agent.getConfig().agent.defaultToolset;
    const skills = deps.agent.getSkillLoader().getSkillCatalog({
      workspaceDir,
      toolsetName,
    });
    res.json({
      skills: skills.map((item) => ({
        name: item.name,
        description: item.description,
        source: item.source,
        path: item.path,
        version: item.version,
        skillSource: item.skillSource,
        packName: item.packName,
        packVersion: item.packVersion,
        tags: item.tags,
        triggers: item.triggers,
        platforms: item.platforms,
        toolsets: item.toolsets,
        reviewStatus: item.reviewStatus,
      })),
      workspaceDir,
      toolsetName,
    });
  });

  deps.app.get('/api/skills/history', (req: Request, res: Response) => {
    const name = String(req.query.name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const sessionId = String(req.query.sessionId ?? '').trim();
    const { workspaceDir } = resolveSkillRouteWorkspace(deps, sessionId);
    res.json({ items: deps.agent.listSkillHistory({ name, workspaceDir }) });
  });

  deps.app.post('/api/skills/rollback', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string; name?: string; version?: string };
    const name = String(body.name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const sessionId = String(body.sessionId ?? '').trim();
    const { workspaceDir } = resolveSkillRouteWorkspace(deps, sessionId);
    const result = deps.agent.rollbackSkill({
      name,
      workspaceDir,
      version: String(body.version ?? '').trim() || undefined,
      sessionId: sessionId || undefined,
    });
    if (!result) {
      res.status(404).json({ error: 'Skill history not found' });
      return;
    }
    res.json({ success: true, result });
  });

  deps.app.get('/api/skills/packs', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const { workspaceDir } = resolveSkillRouteWorkspace(deps, sessionId);
    res.json({
      items: deps.agent.getSkillPackStore().listPacks({ workspaceDir }),
      workspaceDir,
    });
  });

  deps.app.post('/api/skills/packs', (req: Request, res: Response) => {
    try {
      const body = req.body as {
        sessionId?: string;
        name?: string;
        version?: string;
        scope?: 'team' | 'workspace';
        description?: string;
        skillNames?: string[];
      };
      const name = String(body.name ?? '').trim();
      const version = String(body.version ?? '').trim();
      const scope = String(body.scope ?? '').trim().toLowerCase();
      if (!name || !version || (scope !== 'team' && scope !== 'workspace')) {
        res.status(400).json({ error: 'name, version, and scope are required' });
        return;
      }
      const sessionId = String(body.sessionId ?? '').trim();
      const { workspaceDir } = resolveSkillRouteWorkspace(deps, sessionId);
      const record = deps.agent.publishSkillPack({
        name,
        version,
        scope,
        workspaceDir,
        description: String(body.description ?? '').trim() || undefined,
        skillNames: Array.isArray(body.skillNames)
          ? body.skillNames.map((item) => String(item))
          : undefined,
        sessionId: sessionId || undefined,
      });
      res.json({ success: true, record });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.post('/api/skills/packs/:name/activate', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string; scope?: 'team' | 'workspace'; version?: string };
    const version = String(body.version ?? '').trim();
    const scope = String(body.scope ?? '').trim().toLowerCase();
    if (!version || (scope !== 'team' && scope !== 'workspace')) {
      res.status(400).json({ error: 'scope and version are required' });
      return;
    }
    const sessionId = String(body.sessionId ?? '').trim();
    const { workspaceDir } = resolveSkillRouteWorkspace(deps, sessionId);
    const record = deps.agent.activateSkillPack({
      name: req.params.name,
      scope,
      version,
      workspaceDir,
      sessionId: sessionId || undefined,
    });
    if (!record) {
      res.status(404).json({ error: 'Skill pack not found' });
      return;
    }
    res.json({ success: true, record });
  });

  deps.app.post('/api/skills/packs/:name/rollback', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string; scope?: 'team' | 'workspace' };
    const scope = String(body.scope ?? '').trim().toLowerCase();
    if (scope !== 'team' && scope !== 'workspace') {
      res.status(400).json({ error: 'scope is required' });
      return;
    }
    const sessionId = String(body.sessionId ?? '').trim();
    const { workspaceDir } = resolveSkillRouteWorkspace(deps, sessionId);
    const record = deps.agent.rollbackSkillPack({
      name: req.params.name,
      scope,
      workspaceDir,
      sessionId: sessionId || undefined,
    });
    if (!record) {
      res.status(404).json({ error: 'No prior pack version available' });
      return;
    }
    res.json({ success: true, record });
  });
}
