import { Request, Response } from 'express';
import type { WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';

const DOWNLOAD_ID_RE = /^[a-f0-9]{36}$/i;

export function registerDownloadRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const service = deps.downloadServices?.downloadLinks;
  if (!service) {
    return;
  }

  deps.app.get('/download/:id/:filename?', (req: Request, res: Response) => {
    const id = String(req.params.id ?? '').trim();
    if (!DOWNLOAD_ID_RE.test(id)) {
      res.status(404).send('Download link not found.');
      return;
    }

    const record = service.resolve(id);
    if (!record) {
      res.status(404).send('Download link not found or expired.');
      return;
    }

    res.download(record.absolutePath, record.filename);
  });
}
