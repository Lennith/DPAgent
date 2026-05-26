import * as crypto from 'node:crypto';
import type { IncomingMessage } from 'http';
import type { RemoteAccessAuthConfig } from '../../types.js';
import {
  DEFAULT_REMOTE_ACCESS_AUTH_SETTINGS,
  REMOTE_ACCESS_AUTH_DEFAULT_SESSION_TTL_MS,
} from '../../shared/remote-access-auth-defaults.js';

const LOOPBACK_IPS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);

const AUTH_COOKIE_NAME = 'dpagent_session';
const SERVER_SECRET_BYTES = 32;

export const DEFAULT_REMOTE_ACCESS_AUTH_CONFIG: RemoteAccessAuthConfig = {
  ...DEFAULT_REMOTE_ACCESS_AUTH_SETTINGS,
};

let serverSecret: Buffer | null = null;

export function getServerSecret(): Buffer {
  if (!serverSecret) {
    serverSecret = crypto.randomBytes(SERVER_SECRET_BYTES);
  }
  return serverSecret;
}

export function setServerSecret(secret: Buffer): void {
  serverSecret = secret;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function normalizeAddress(address: string | undefined): string | undefined {
  const value = String(address ?? '').trim();
  if (!value) return undefined;
  return value.startsWith('::ffff:') ? value : value.replace(/^\[(.*)\]$/, '$1');
}

function isLoopbackAddress(address: string | undefined): boolean {
  const value = normalizeAddress(address);
  if (!value) return false;
  return LOOPBACK_IPS.has(value);
}

function getForwardedRemoteAddress(
  forwardedFor: string | undefined,
  realIp: string | undefined
): string | undefined {
  const candidates = forwardedFor
    ?.split(',')
    .map((part) => normalizeAddress(part))
    .filter((part): part is string => !!part);
  const forwardedRemote = candidates?.find((candidate) => !isLoopbackAddress(candidate));
  if (forwardedRemote) return forwardedRemote;
  const normalizedRealIp = normalizeAddress(realIp);
  if (normalizedRealIp && !isLoopbackAddress(normalizedRealIp)) return normalizedRealIp;
  return undefined;
}

function getTrustedClientAddress(
  req: Pick<IncomingMessage, 'socket' | 'headers'>,
  authConfig: RemoteAccessAuthConfig
): string | undefined {
  if (authConfig.trustProxy === true) {
    const peerAddress = normalizeAddress(req.socket?.remoteAddress);
    if (isLoopbackAddress(peerAddress)) {
      const forwardedFor = headerValue(req.headers['x-forwarded-for']);
      const realIp = headerValue(req.headers['x-real-ip']);
      return getForwardedRemoteAddress(forwardedFor, realIp);
    }
  }
  return normalizeAddress(req.socket?.remoteAddress);
}

export function isSameOriginRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = headerValue(req.headers.origin);
  if (!origin) return true;
  const host = headerValue(req.headers.host);
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function isLoopbackRequest(
  req: Pick<IncomingMessage, 'socket' | 'headers'>,
  authConfig: RemoteAccessAuthConfig = DEFAULT_REMOTE_ACCESS_AUTH_CONFIG
): boolean {
  const socket = req.socket;
  if (!socket) return false;

  const remoteAddress = getTrustedClientAddress(req, authConfig);
  if (!remoteAddress) return false;

  if (LOOPBACK_IPS.has(remoteAddress)) return true;

  return false;
}

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const effectiveSalt = salt ?? crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, effectiveSalt, 32).toString('hex');
  return { hash, salt: effectiveSalt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  try {
    const computed = crypto.scryptSync(password, salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}

export function createSessionCookie(nowMs: number = Date.now()): string {
  const timestamp = nowMs.toString();
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = `${timestamp}:${nonce}`;
  const signature = crypto.createHmac('sha256', getServerSecret()).update(payload).digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

export function verifySessionCookie(
  cookie: string | undefined,
  maxAgeMs: number = REMOTE_ACCESS_AUTH_DEFAULT_SESSION_TTL_MS,
  nowMs: number = Date.now()
): boolean {
  if (!cookie || cookie.trim().length === 0) return false;
  try {
    const decoded = Buffer.from(cookie.trim(), 'base64url').toString('utf-8');
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon < 0) return false;
    const payload = decoded.slice(0, lastColon);
    const providedSig = decoded.slice(lastColon + 1);
    const timestampRaw = payload.slice(0, payload.indexOf(':'));
    const timestamp = Number(timestampRaw);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      return false;
    }
    if (timestamp > nowMs || nowMs - timestamp > maxAgeMs) {
      return false;
    }
    const expectedSig = crypto.createHmac('sha256', getServerSecret()).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(providedSig, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch {
    return false;
  }
}

export function getAuthCookie(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  for (const cookie of cookies) {
    const eqIdx = cookie.indexOf('=');
    if (eqIdx < 0) continue;
    const name = cookie.slice(0, eqIdx).trim();
    if (name === AUTH_COOKIE_NAME) {
      return cookie.slice(eqIdx + 1).trim();
    }
  }
  return undefined;
}

export function getCookieMaxAgeMs(authConfig: RemoteAccessAuthConfig): number {
  return authConfig.sessionTtlMs;
}

export function buildAuthCookieHeader(token: string, maxAgeMs: number): string {
  return [
    `${AUTH_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ].join('; ');
}

export function buildClearAuthCookieHeader(): string {
  return `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  local: boolean;
  configured: boolean;
}

export function getAuthStatus(
  req: Pick<IncomingMessage, 'socket' | 'headers'>,
  authConfig: RemoteAccessAuthConfig
): AuthStatus {
  const local = isLoopbackRequest(req, authConfig);
  if (local) {
    return { required: false, authenticated: true, local: true, configured: authConfig.enabled };
  }
  if (!authConfig.enabled) {
    return { required: false, authenticated: true, local: false, configured: false };
  }
  if (!authConfig.passwordHash || !authConfig.passwordSalt) {
    return { required: true, authenticated: false, local: false, configured: false };
  }
  const sessionCookie = getAuthCookie(req);
  const authenticated = verifySessionCookie(sessionCookie, authConfig.sessionTtlMs);
  return { required: true, authenticated, local: false, configured: true };
}

export function isAuthenticatedForRemoteAccess(
  req: Pick<IncomingMessage, 'socket' | 'headers'>,
  authConfig: RemoteAccessAuthConfig
): boolean {
  const status = getAuthStatus(req, authConfig);
  return !status.required || status.authenticated;
}
