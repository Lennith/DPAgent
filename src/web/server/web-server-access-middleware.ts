import express, { type Request, type Response } from 'express';
import { type WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';

function extractSessionIdFromApiPath(pathname: string, routePrefix: string): string | null {
  if (!pathname.startsWith(routePrefix)) {
    return null;
  }
  const rest = pathname.slice(routePrefix.length);
  const [sessionId] = rest.split('/');
  return sessionId ? decodeURIComponent(sessionId) : null;
}

function isSharedAccessRouteAllowed(req: Request, pathname: string, sessionId: string): boolean {
  const method = req.method.toUpperCase();
  if (pathname === '/api/agents') {
    return method === 'GET' || method === 'HEAD';
  }
  if (
    pathname === '/api/auth/status' ||
    pathname.startsWith('/api/share/') ||
    pathname.startsWith('/dpagent-share/') ||
    pathname === '/guide' ||
    pathname.startsWith('/guide/') ||
    pathname.startsWith('/download/') ||
    pathname.startsWith('/assets') ||
    pathname.startsWith('/favicon')
  ) {
    if (pathname.startsWith('/download/')) {
      return method === 'GET' || method === 'HEAD';
    }
    return true;
  }
  if (pathname === '/api/sessions') {
    return method === 'GET';
  }
  const routeSessionId = extractSessionIdFromApiPath(pathname, '/api/sessions/');
  if (!routeSessionId || routeSessionId !== sessionId) {
    return false;
  }
  if (pathname === `/api/sessions/${encodeURIComponent(sessionId)}` || pathname === `/api/sessions/${sessionId}`) {
    return method === 'GET';
  }
  const llmSelectionPath = `/api/sessions/${sessionId}/llm-selection`;
  const encodedLlmSelectionPath = `/api/sessions/${encodeURIComponent(sessionId)}/llm-selection`;
  return (
    (pathname === llmSelectionPath || pathname === encodedLlmSelectionPath) &&
    (method === 'GET' || method === 'PATCH')
  );
}

export function registerWebServerAccessMiddleware(deps: WebServerRouteRegistrationDependencies): void {
  deps.app.use((req: Request, res: Response, next: express.NextFunction) => {
    if (deps.authServices.isLoopback(req)) return next();
    const pathname = req.path;
    const normalizedPathname = pathname.toLowerCase();
    if (
      normalizedPathname === '/api/auth/status' ||
      normalizedPathname === '/api/auth/login' ||
      normalizedPathname === '/api/auth/logout' ||
      normalizedPathname === '/login' ||
      normalizedPathname.startsWith('/api/share/') ||
      normalizedPathname.startsWith('/dpagent-share/') ||
      normalizedPathname === '/guide' ||
      normalizedPathname.startsWith('/guide/') ||
      normalizedPathname.startsWith('/assets') ||
      normalizedPathname.startsWith('/favicon')
    ) {
      return next();
    }
    const sharedSessionId = deps.accessServices?.getSharedAccessSessionId(req) ?? null;
    if (sharedSessionId) {
      const sharedAccessToken = deps.accessServices?.getSharedAccessToken?.(req) ?? null;
      if (isSharedAccessRouteAllowed(req, pathname, sharedSessionId)) {
        return next();
      }
      if (normalizedPathname.startsWith('/api/')) {
        return res.status(403).json({ error: 'Share link cannot access this resource', code: 'SHARE_SCOPE_FORBIDDEN' });
      }
      return res.redirect(sharedAccessToken ? `/dpagent-share/${encodeURIComponent(sharedAccessToken)}` : '/dpagent-share/');
    }
    if (!deps.authServices.isAuthenticatedForRemoteAccess(req)) {
      if (normalizedPathname.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required', code: 'REMOTE_AUTH_REQUIRED' });
      }
      return res.redirect('/login');
    }
    next();
  });
}
