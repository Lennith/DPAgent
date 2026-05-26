import express from 'express';
import path from 'path';
import * as fs from 'fs';
import { webServerLogger } from '../../utils/logger.js';

function resolveStaticClientPath(): string | null {
  const packagedClientPath = path.resolve(__dirname, '../client');
  const workspaceClientPath = path.join(process.cwd(), 'dist/web/client');

  const isLikelySourceClientPath = (candidate: string): boolean => {
    const indexPath = path.join(candidate, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return false;
    }
    const html = fs.readFileSync(indexPath, 'utf8');
    return html.includes('main.tsx') || fs.existsSync(path.join(candidate, 'main.tsx'));
  };

  const isRunnableStaticClientPath = (candidate: string): boolean => {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      return false;
    }
    const indexPath = path.join(candidate, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return false;
    }
    return !isLikelySourceClientPath(candidate);
  };

  if (isRunnableStaticClientPath(packagedClientPath)) {
    return packagedClientPath;
  }
  if (isRunnableStaticClientPath(workspaceClientPath)) {
    return workspaceClientPath;
  }
  return null;
}

export function registerStaticClient(app: express.Express): string | null {
  const clientPath = resolveStaticClientPath();
  if (!clientPath) {
    webServerLogger.info('Static files not found, running in API-only mode (dev mode)');
    return null;
  }

  webServerLogger.info(`Serving static client from: ${clientPath}`);

  const mimeOverride: Record<string, string> = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.map': 'application/json',
  };

  const serveStaticWithMimeFix = express.static(clientPath, {
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = mimeOverride[ext];
      if (mimeType) {
        res.setHeader('Content-Type', mimeType);
      }
    },
  });

  app.use(serveStaticWithMimeFix);
  return clientPath;
}
