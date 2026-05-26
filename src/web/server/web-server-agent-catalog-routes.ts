import type { Request, Response } from 'express';
import path from 'path';
import {
  isAgentProfileVisibleToSubagentManager,
  normalizeAgentProfileConfig,
  resolveAgentPool,
  toAgentProfileConfigView,
  writeAgentProfileConfig,
  type AgentProfile,
} from '../../agents/AgentProfiles.js';
import { findResolvedLlmProfile } from '../../llm/provider-profiles.js';
import { type WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';

function resolveGlobalAgentConfigTarget(
  deps: WebServerRouteRegistrationDependencies,
  name: string | undefined
): { profile: AgentProfile; configPath: string } | null {
  deps.agentCatalogServices.refreshGlobalAgentCatalog();
  const normalizedName = String(name ?? '').trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }
  const profile = deps.agentCatalogServices
    .getGlobalAgentProfiles()
    .find((item) => item.source === 'global' && item.name.trim().toLowerCase() === normalizedName);
  if (!profile) {
    return null;
  }
  const globalAgentsDir = path.resolve(String(deps.agent.getConfig().agent.globalAgentsDir ?? ''));
  const profileDir = path.resolve(path.dirname(profile.path));
  const relative = path.relative(globalAgentsDir, profileDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return {
    profile,
    configPath: path.join(profileDir, 'agent.yaml'),
  };
}

function validateAgentProfileConfig(
  deps: WebServerRouteRegistrationDependencies,
  config: ReturnType<typeof normalizeAgentProfileConfig>['config']
): string | null {
  const llmProfileId = String(config.llmProfileId ?? '').trim();
  if (llmProfileId && !findResolvedLlmProfile(deps.agent.getConfig(), llmProfileId)) {
    return `Unknown LLM profile: ${llmProfileId}`;
  }
  const toolsetName = String(config.toolsetName ?? '').trim();
  if (toolsetName && !deps.agent.getToolsetRegistry().has(toolsetName)) {
    return `Unknown toolset: ${toolsetName}`;
  }
  return null;
}


export function registerAgentCatalogRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { agentCatalogServices } = deps;

  deps.app.get('/api/agents', (req: Request, res: Response) => {
    const mode = String(req.query.mode ?? '').trim().toLowerCase();
    const query = String(req.query.query ?? '').trim().toLowerCase();
    const sharedAccessSessionId = deps.accessServices?.getSharedAccessSessionId(req) ?? null;
    const shareOnlyAgentCatalog = Boolean(sharedAccessSessionId && deps.accessServices?.hasFullAccess(req) === false);
    if (shareOnlyAgentCatalog) {
      if (mode === 'subagent') {
        res.status(403).json({ error: 'Share link cannot access this agent catalog mode', code: 'SHARE_SCOPE_FORBIDDEN' });
        return;
      }
      agentCatalogServices.refreshGlobalAgentCatalog();
      const agents = agentCatalogServices
        .getGlobalAgentProfiles()
        .filter((item) => (query.length > 0 ? item.name.toLowerCase().includes(query) : true))
        .map((item) => ({
          name: item.name,
          description: item.description,
        }));
      res.json({ agents });
      return;
    }
    if (mode !== 'subagent') {
      agentCatalogServices.refreshGlobalAgentCatalog();
    }
    const profiles =
      mode === 'subagent'
        ? resolveAgentPool({
            globalAgentsDir: deps.agent.getConfig().agent.globalAgentsDir,
            workspaceDir:
              String(req.query.workspaceDir ?? '').trim() ||
              deps.agent.getConfig().agent.workspaceDir,
            includeWorkspace: true,
        }).filter(isAgentProfileVisibleToSubagentManager)
        : agentCatalogServices.getGlobalAgentProfiles();

    const agents = profiles
      .filter((item) => (query.length > 0 ? item.name.toLowerCase().includes(query) : true))
      .map((item) => ({
        name: item.name,
        source: item.source,
        description: item.description,
        path: item.path,
        mtime: item.mtime,
        config: toAgentProfileConfigView(item.config, item.configWarnings, item.configPath),
      }));
    res.json({ agents });
  });

  deps.app.get('/api/agents/:name/config', (req: Request, res: Response) => {
    const target = resolveGlobalAgentConfigTarget(deps, req.params.name);
    if (!target) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({
      name: target.profile.name,
      config: toAgentProfileConfigView(
        target.profile.config,
        target.profile.configWarnings,
        target.profile.configPath ?? target.configPath
      ),
    });
  });

  deps.app.put('/api/agents/:name/config', (req: Request, res: Response) => {
    const target = resolveGlobalAgentConfigTarget(deps, req.params.name);
    if (!target) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const normalized = normalizeAgentProfileConfig(req.body?.config ?? req.body);
    if (normalized.warnings.length > 0) {
      res.status(400).json({ error: normalized.warnings.join('; '), warnings: normalized.warnings });
      return;
    }
    const validationError = validateAgentProfileConfig(deps, normalized.config);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    try {
      writeAgentProfileConfig(target.configPath, {
        version: 1,
        ...normalized.config,
      });
      agentCatalogServices.refreshGlobalAgentCatalog();
      const refreshed = resolveGlobalAgentConfigTarget(deps, target.profile.name)?.profile ?? target.profile;
      res.json({
        success: true,
        name: refreshed.name,
        config: toAgentProfileConfigView(refreshed.config, refreshed.configWarnings, refreshed.configPath),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
