import * as crypto from 'node:crypto';
import type { DPAgent } from '../../dpagent-runtime.js';
import type { ContextNamespaceMeta, ContextRef } from '../../types.js';

export const DEFAULT_SESSION_SHARE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SessionShareRecordView {
  active: boolean;
  createdAt?: string;
  expiresAt?: string;
  version?: number;
}

export interface CreatedSessionShare {
  token: string;
  url: string;
  share: Required<Pick<SessionShareRecordView, 'active' | 'createdAt' | 'expiresAt' | 'version'>>;
}

export interface ResolvedSessionShare {
  sessionId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  version: number;
}

interface SessionShareServiceOptions {
  agent: DPAgent;
  ttlMs?: number | (() => number);
  now?: () => Date;
  publicBaseUrl?: () => string;
  randomToken?: () => string;
}

function toSessionContext(sessionId: string): ContextRef {
  return {
    scope: 'session',
    namespace: sessionId,
  };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isActiveShare(
  share: ContextNamespaceMeta['sessionShare'] | undefined,
  nowMs: number
): share is NonNullable<ContextNamespaceMeta['sessionShare']> {
  if (!share || share.revokedAt) {
    return false;
  }
  const expiresAtMs = Date.parse(share.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

export class SessionShareService {
  private readonly agent: DPAgent;
  private readonly ttlMs: () => number;
  private readonly now: () => Date;
  private readonly publicBaseUrl: () => string;
  private readonly randomToken: () => string;

  constructor(options: SessionShareServiceOptions) {
    this.agent = options.agent;
    const ttlMs = options.ttlMs;
    this.ttlMs =
      typeof ttlMs === 'function'
        ? ttlMs
        : () => ttlMs ?? DEFAULT_SESSION_SHARE_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.publicBaseUrl = options.publicBaseUrl ?? (() => '');
    this.randomToken = options.randomToken ?? (() => crypto.randomBytes(32).toString('base64url'));
  }

  getStatus(sessionId: string): SessionShareRecordView {
    const meta = this.agent.getContextNamespaceMeta(toSessionContext(sessionId));
    const share = meta?.sessionShare;
    if (!isActiveShare(share, this.now().getTime())) {
      return { active: false };
    }
    return {
      active: true,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      version: share.version,
    };
  }

  create(sessionId: string): CreatedSessionShare {
    const context = toSessionContext(sessionId);
    const meta = this.agent.getContextNamespaceMeta(context);
    if (!meta) {
      throw new Error('Session not found');
    }
    const now = this.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.resolveTtlMs()).toISOString();
    const token = this.randomToken();
    const version = (meta.sessionShare?.version ?? 0) + 1;
    const share = {
      tokenHash: hashToken(token),
      createdAt,
      expiresAt,
      version,
    };
    this.agent.updateContextNamespaceMeta(context, {
      sessionShare: share,
    });
    return {
      token,
      url: this.buildShareUrl(token),
      share: {
        active: true,
        createdAt,
        expiresAt,
        version,
      },
    };
  }

  revoke(sessionId: string): SessionShareRecordView {
    const context = toSessionContext(sessionId);
    const meta = this.agent.getContextNamespaceMeta(context);
    if (!meta?.sessionShare || !isActiveShare(meta.sessionShare, this.now().getTime())) {
      return { active: false };
    }
    const revokedAt = this.now().toISOString();
    this.agent.updateContextNamespaceMeta(context, {
      sessionShare: {
        ...meta.sessionShare,
        revokedAt,
        version: meta.sessionShare.version + 1,
      },
    });
    return {
      active: false,
      createdAt: meta.sessionShare.createdAt,
      expiresAt: meta.sessionShare.expiresAt,
      version: meta.sessionShare.version + 1,
    };
  }

  resolveToken(token: string | null | undefined): ResolvedSessionShare | null {
    const normalizedToken = String(token ?? '').trim();
    if (!normalizedToken) {
      return null;
    }
    const tokenHash = hashToken(normalizedToken);
    const nowMs = this.now().getTime();
    for (const meta of this.agent.getContextManager().listNamespaces('session')) {
      const share = meta.sessionShare;
      if (!isActiveShare(share, nowMs) || share.tokenHash !== tokenHash) {
        continue;
      }
      return {
        sessionId: meta.namespace,
        tokenHash,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        version: share.version,
      };
    }
    return null;
  }

  buildShareUrl(token: string): string {
    const baseUrl = this.publicBaseUrl().replace(/\/+$/, '');
    return `${baseUrl}/dpagent-share/${encodeURIComponent(token)}`;
  }

  private resolveTtlMs(): number {
    const ttlMs = Number(this.ttlMs());
    return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_SESSION_SHARE_TTL_MS;
  }
}
