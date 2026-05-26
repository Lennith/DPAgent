import * as fs from 'fs';
import * as path from 'path';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp', '.svg', '.ico',
  '.mp3', '.mp4', '.wav', '.flac', '.avi', '.mkv', '.mov', '.webm',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.db', '.sqlite', '.ttf', '.otf', '.woff', '.woff2', '.eot',
]);

export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  let fd: number | undefined;
  try {
    const stats = fs.statSync(filePath);
    const sampleSize = Math.min(4096, stats.size);
    if (sampleSize === 0) {
      return false;
    }
    const buffer = Buffer.alloc(sampleSize);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, sampleSize, 0);
    let nullCount = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0) {
        nullCount++;
      }
    }
    return nullCount / buffer.length > 0.1;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function readInteger(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return fallback;
}

export function readLineWindow(
  filePath: string,
  encoding: BufferEncoding,
  offset: number,
  limit: number,
  maxChars: number,
  maxScanBytes: number
): { content: string; outputTruncated: boolean; scanLimitReached: boolean } {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let carry = '';
  let skipped = 0;
  let emitted = 0;
  let out = '';
  let position = 0;
  let outputTruncated = false;
  let scanLimitReached = false;
  try {
    while (emitted < limit && out.length < maxChars && position < maxScanBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) {
        break;
      }
      position += bytesRead;
      const chunk = carry + buffer.toString(encoding, 0, bytesRead).replace(/\r\n/g, '\n');
      const lines = chunk.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (skipped < offset) {
          skipped += 1;
          continue;
        }
        if (emitted >= limit || out.length >= maxChars) {
          break;
        }
        out += (out.length > 0 ? '\n' : '') + line;
        emitted += 1;
      }
    }
    if (carry.length > 0 && emitted < limit && out.length < maxChars && skipped >= offset) {
      out += (out.length > 0 ? '\n' : '') + carry;
    }
    if (out.length > maxChars) {
      out = out.slice(0, maxChars);
      outputTruncated = true;
    }
    if (position >= maxScanBytes && emitted < limit) {
      scanLimitReached = true;
    }
    if (out.length >= maxChars) {
      outputTruncated = true;
    }
    return { content: out, outputTruncated, scanLimitReached };
  } finally {
    fs.closeSync(fd);
  }
}
