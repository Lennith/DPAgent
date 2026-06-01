import express, { Request, Response } from 'express';
import path from 'path';
import { registerStaticClient } from './web-server-static-client.js';
import { type WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';
import { registerAutoLoopRoutes } from './web-server-autoloop-routes.js';
import { registerAuthRoutes } from './web-server-auth-routes.js';
import { registerSkillRoutes } from './web-server-skill-routes.js';
import { registerSystemRoutes } from './web-server-system-routes.js';
import { registerSessionRoutes } from './web-server-session-routes.js';
import { registerLocalFileRoutes } from './web-server-local-file-routes.js';
import { registerDownloadRoutes } from './web-server-download-routes.js';
import { registerWorkspaceGovernanceRoutes } from './web-server-workspace-governance-routes.js';
import { registerAsrRoutes } from './web-server-asr-routes.js';
import { registerAgentAuthoringRoutes } from './web-server-agent-authoring-routes.js';
import { registerGuideRoutes } from './web-server-guide-routes.js';
import { registerWebServerAccessMiddleware } from './web-server-access-middleware.js';
import { registerSubagentAndToolsetRoutes } from './web-server-subagent-toolset-routes.js';
import { registerGovernanceRoutes } from './web-server-governance-routes.js';
import { registerAgentCatalogRoutes } from './web-server-agent-catalog-routes.js';
import { registerArenaRoutes } from './web-server-arena-routes.js';
import { registerWorkspaceTimelineRoutes } from './web-server-workspace-timeline-routes.js';

export function registerWebServerRoutes(
  deps: WebServerRouteRegistrationDependencies
): void {
  deps.app.use(express.json());

  registerWebServerAccessMiddleware(deps);

  registerAuthRoutes(deps);
  registerLocalFileRoutes(deps);
  registerDownloadRoutes(deps);
  registerSystemRoutes(deps);
  registerAgentAuthoringRoutes(deps);
  registerAsrRoutes(deps);
  registerGuideRoutes(deps.app);

  const clientPath = registerStaticClient(deps.app);
  registerSessionRoutes(deps);
  registerArenaRoutes(deps);
  registerWorkspaceTimelineRoutes(deps);
  registerSubagentAndToolsetRoutes(deps);
  registerSkillRoutes(deps);
  registerGovernanceRoutes(deps);
  registerAgentCatalogRoutes(deps);
  registerWorkspaceGovernanceRoutes(deps);
  registerAutoLoopRoutes(deps);

  if (clientPath) {
    deps.app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(clientPath, 'index.html'));
    });
  }
}
