import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { Request } from 'express';
import type { WebSocket } from 'ws';
import type {
  ContextNamespaceMeta,
  ContextRef,
  SessionInteractionState,
  SessionOrigin,
} from '../../types.js';
import type { ActiveRunState } from './web-server-runtime-contracts.js';
import type { ResolvedSessionShare } from './session-share-service.js';

export type WebSocketAccessScope =
  | {
      mode: 'full';
      wssId: string;
      clientKind: 'web' | 'cli';
    }
  | {
      mode: 'shared_ls';
      wssId: string;
      clientKind: 'web';
      sessionId: string;
      tokenHash: string;
      shareToken?: string;
      shareVersion: number;
      transportMode?: 'runtime' | 'text';
    };

export interface WebSocketAccessControllerOptions {
  getScopeMap: () => WeakMap<WebSocket, WebSocketAccessScope>;
  getClientKindMap: () => WeakMap<WebSocket, 'web' | 'cli'>;
  getShareExpiryTimers: () => WeakMap<WebSocket, NodeJS.Timeout>;
  getSocketsByWssIdMap: () => Map<string, WebSocket>;
  getActiveRunControllerMap: () => Map<string, string>;
  getContextNamespaceMeta: (context: ContextRef) => ContextNamespaceMeta | undefined;
  getActiveRunState: (context: ContextRef) => ActiveRunState | null;
  notifySharedSessionInvalidated: (sessionId: string) => void;
}

export interface WebSocketConnectionBinding {
  clientKind: 'web' | 'cli';
  share: ResolvedSessionShare | null;
  shareToken: string;
  textMode: boolean;
}

export class WebSocketAccessController {
  private readonly options: WebSocketAccessControllerOptions;

  constructor(options: WebSocketAccessControllerOptions) {
    this.options = options;
  }

  bindConnection(ws: WebSocket, binding: WebSocketConnectionBinding): void {
    const wssId = this.createWebSocketSessionId();
    this.options.getClientKindMap().set(ws, binding.share ? 'web' : binding.clientKind);
    const scope: WebSocketAccessScope = binding.share
      ? {
          mode: 'shared_ls',
          wssId,
          clientKind: 'web',
          sessionId: binding.share.sessionId,
          tokenHash: binding.share.tokenHash,
          shareToken: binding.shareToken,
          shareVersion: binding.share.version,
          transportMode: binding.textMode ? 'text' : 'runtime',
        }
      : {
          mode: 'full',
          wssId,
          clientKind: binding.clientKind,
        };
    this.options.getScopeMap().set(ws, scope);
    this.options.getSocketsByWssIdMap().set(wssId, ws);
    if (binding.share) {
      this.scheduleSharedWebSocketExpiry(ws, binding.share);
    }
  }

  releaseScope(ws: WebSocket): void {
    const scope = this.options.getScopeMap().get(ws);
    if (!scope) {
      return;
    }
    const expiryTimer = this.options.getShareExpiryTimers().get(ws);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
    this.options.getSocketsByWssIdMap().delete(scope.wssId);
    for (const [contextKey, controllerWssId] of this.options.getActiveRunControllerMap().entries()) {
      if (controllerWssId === scope.wssId) {
        this.options.getActiveRunControllerMap().delete(contextKey);
      }
    }
  }

  resolveRunOrigin(ws: WebSocket): SessionOrigin {
    return this.options.getClientKindMap().get(ws) === 'cli' ? 'cli' : 'web';
  }

  canAccessContext(ws: WebSocket, context: ContextRef): boolean {
    const scope = this.options.getScopeMap().get(ws);
    if (!scope || scope.mode === 'full') {
      return true;
    }
    if (context.scope !== 'session' || context.namespace !== scope.sessionId) {
      return false;
    }
    const share = this.options.getContextNamespaceMeta(context)?.sessionShare;
    const expiresAtMs = Date.parse(String(share?.expiresAt ?? ''));
    return (
      !!share &&
      !share.revokedAt &&
      share.tokenHash === scope.tokenHash &&
      share.version === scope.shareVersion &&
      Number.isFinite(expiresAtMs) &&
      expiresAtMs > Date.now()
    );
  }

  hasFullAccess(ws: WebSocket): boolean {
    return this.options.getScopeMap().get(ws)?.mode !== 'shared_ls';
  }

  resolveSocketWssId(ws: WebSocket): string {
    let scope = this.options.getScopeMap().get(ws);
    if (!scope) {
      const wssId = this.createWebSocketSessionId();
      scope = {
        mode: 'full',
        wssId,
        clientKind: this.options.getClientKindMap().get(ws) ?? 'web',
      };
      this.options.getScopeMap().set(ws, scope);
      this.options.getSocketsByWssIdMap().set(wssId, ws);
    }
    return scope.wssId;
  }

  summarizeScope(scope: WebSocketAccessScope | undefined): Record<string, unknown> | undefined {
    if (!scope) {
      return undefined;
    }
    if (scope.mode === 'shared_ls') {
      return {
        mode: scope.mode,
        wssId: scope.wssId,
        clientKind: scope.clientKind,
        sessionId: scope.sessionId,
        shareVersion: scope.shareVersion,
        transportMode: scope.transportMode,
      };
    }
    return {
      mode: scope.mode,
      wssId: scope.wssId,
      clientKind: scope.clientKind,
    };
  }

  bindRunController(ws: WebSocket, context: ContextRef): void {
    if (context.scope !== 'session' || this.resolveRunOrigin(ws) !== 'web') {
      return;
    }
    this.options.getActiveRunControllerMap().set(this.makeRunContextStateKey(context), this.resolveSocketWssId(ws));
  }

  releaseRunController(context: ContextRef): void {
    this.options.getActiveRunControllerMap().delete(this.makeRunContextStateKey(context));
  }

  resolveInteractionStateForSocket(ws: WebSocket, context: ContextRef): SessionInteractionState {
    const active = this.options.getActiveRunState(context);
    if (!active) {
      return { mode: 'normal' };
    }
    if (active.owner !== 'web') {
      return active.interactionState;
    }
    if (this.options.getScopeMap().get(ws)?.mode !== 'shared_ls') {
      return {
        mode: 'normal',
        owner: 'web',
      };
    }
    const controllerWssId = this.options.getActiveRunControllerMap().get(this.makeRunContextStateKey(context));
    if (controllerWssId === this.resolveSocketWssId(ws)) {
      return {
        mode: 'normal',
        owner: 'web',
      };
    }
    return {
      mode: 'observe_only',
      reason: 'wss_controlled_active_run',
      owner: 'web',
    };
  }

  canControlWebActiveRun(ws: WebSocket, context: ContextRef): boolean {
    const active = this.options.getActiveRunState(context);
    if (!active) {
      return true;
    }
    if (active.owner !== 'web' || active.interactionState.mode === 'observe_only') {
      return false;
    }
    if (this.options.getScopeMap().get(ws)?.mode !== 'shared_ls') {
      return true;
    }
    const controllerWssId = this.options.getActiveRunControllerMap().get(this.makeRunContextStateKey(context));
    if (!controllerWssId) {
      return false;
    }
    return controllerWssId === this.resolveSocketWssId(ws);
  }

  getActiveRunStateForSocket(ws: WebSocket, context: ContextRef): ActiveRunState | null {
    const active = this.options.getActiveRunState(context);
    return active
      ? {
          ...active,
          interactionState: this.resolveInteractionStateForSocket(ws, context),
        }
      : null;
  }

  getTextShareScope(ws: WebSocket): Extract<WebSocketAccessScope, { mode: 'shared_ls' }> | null {
    const scope = this.options.getScopeMap().get(ws);
    return scope?.mode === 'shared_ls' && scope.transportMode === 'text' ? scope : null;
  }

  extractShareTokenFromRequest(request: IncomingMessage | Request): string {
    const headerToken = String(request.headers['x-dpagent-share-token'] ?? '').trim();
    if (headerToken) {
      return headerToken;
    }
    const rawUrl = 'url' in request ? request.url : undefined;
    const host = String(request.headers.host ?? 'localhost');
    if (!rawUrl) {
      return '';
    }
    try {
      const url = new URL(rawUrl, `http://${host}`);
      const queryToken = url.searchParams.get('shareToken') ?? '';
      if (queryToken.trim()) {
        return queryToken.trim();
      }
      if (url.pathname.startsWith('/dpagent-share/')) {
        return decodeURIComponent(url.pathname.slice('/dpagent-share/'.length)).trim();
      }
      return '';
    } catch {
      return '';
    }
  }

  isTextShareWebSocketRequest(request: IncomingMessage): boolean {
    const rawUrl = request.url;
    if (!rawUrl) {
      return false;
    }
    try {
      const url = new URL(rawUrl, `http://${String(request.headers.host ?? 'localhost')}`);
      return String(url.searchParams.get('mode') ?? '').trim().toLowerCase() === 'text';
    } catch {
      return false;
    }
  }

  private scheduleSharedWebSocketExpiry(ws: WebSocket, share: ResolvedSessionShare): void {
    const expiresAtMs = Date.parse(share.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }
    const timer = setTimeout(() => {
      const scope = this.options.getScopeMap().get(ws);
      if (
        scope?.mode === 'shared_ls' &&
        scope.sessionId === share.sessionId &&
        scope.tokenHash === share.tokenHash &&
        scope.shareVersion === share.version
      ) {
        this.options.notifySharedSessionInvalidated(share.sessionId);
      }
    }, Math.max(0, expiresAtMs - Date.now()));
    this.options.getShareExpiryTimers().set(ws, timer);
  }

  private makeRunContextStateKey(context: ContextRef): string {
    return `${context.scope}:${context.namespace}`;
  }

  private createWebSocketSessionId(): string {
    return `wss-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
  }
}
