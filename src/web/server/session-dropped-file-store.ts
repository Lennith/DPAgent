import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function sanitizeDroppedFileName(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }
  const basename = path.basename(raw.replace(/\\/g, '/'));
  const safe = basename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  if (!safe || safe === '.' || safe === '..') {
    return null;
  }
  return safe;
}

function sanitizePathToken(value: unknown, fallback: string): string {
  const safe = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '_');
  return safe || fallback;
}

function assertPathInside(child: string, parent: string): void {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Dropped file target path escapes runtimeDataDir.');
  }
}

export function saveDroppedSessionFile(input: {
  runtimeDataDir: string;
  sessionId: string;
  filename: string;
  body: Buffer;
  uploadId?: string;
}): { path: string; filename: string; size: number } {
  const runtimeDataDir = String(input.runtimeDataDir ?? '').trim();
  if (!runtimeDataDir) {
    throw new Error('runtimeDataDir is required for dropped file uploads.');
  }
  const filename = sanitizeDroppedFileName(input.filename);
  if (!filename) {
    throw new Error('filename is required for dropped file uploads.');
  }
  if (!Buffer.isBuffer(input.body)) {
    throw new Error('Dropped file body must be a Buffer.');
  }
  const droppedRoot = path.resolve(runtimeDataDir, 'dropped-files');
  const safeSessionId = sanitizePathToken(input.sessionId, 'session');
  const uploadId = sanitizePathToken(input.uploadId, crypto.randomUUID());
  const targetDir = path.resolve(droppedRoot, safeSessionId, uploadId);
  const targetPath = path.resolve(targetDir, filename);
  assertPathInside(targetPath, droppedRoot);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, input.body, { flag: 'wx' });
  assertPathInside(targetPath, droppedRoot);
  return {
    path: targetPath,
    filename,
    size: input.body.length,
  };
}
