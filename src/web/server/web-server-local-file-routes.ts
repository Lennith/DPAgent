import { Request, Response } from 'express';
import { getLocalFileRoots, listLocalDirectory } from './local-file-browser.js';
import type { WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';

export function registerLocalFileRoutes(deps: WebServerRouteRegistrationDependencies): void {
  deps.app.get('/api/local-files/roots', (_req: Request, res: Response) => {
    try {
      res.json({ roots: getLocalFileRoots() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.get('/api/local-files/list', async (req: Request, res: Response) => {
    try {
      const result = await listLocalDirectory(String(req.query.path ?? ''));
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
