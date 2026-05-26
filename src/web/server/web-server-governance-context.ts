import type { ContextRef } from '../../types.js';
import { toSessionContext, type WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';

export interface ResolvedGovernanceRouteSession {
  sessionId?: string;
  context?: ContextRef;
}

export interface ResolvedGovernanceRouteContext extends ResolvedGovernanceRouteSession {
  workspaceDir: string;
}

export function normalizeGovernanceRouteSessionId(sessionIdRaw: unknown): string {
  return String(sessionIdRaw ?? '').trim();
}

export function resolveGovernanceRouteSession(sessionIdRaw: unknown): ResolvedGovernanceRouteSession {
  const sessionId = normalizeGovernanceRouteSessionId(sessionIdRaw);
  if (!sessionId) {
    return {};
  }
  return {
    sessionId,
    context: toSessionContext(sessionId),
  };
}

export function resolveGovernanceRouteWorkspace(
  deps: WebServerRouteRegistrationDependencies,
  resolved: ResolvedGovernanceRouteSession
): string {
  return resolved.context
    ? deps.contextServices.resolveWorkspaceDirForContext(resolved.context)
    : deps.agent.getConfig().agent.workspaceDir;
}

export function resolveGovernanceRouteContext(
  deps: WebServerRouteRegistrationDependencies,
  sessionIdRaw: unknown
): ResolvedGovernanceRouteContext {
  const resolved = resolveGovernanceRouteSession(sessionIdRaw);
  return {
    ...resolved,
    workspaceDir: resolveGovernanceRouteWorkspace(deps, resolved),
  };
}
