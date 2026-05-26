import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseFlagArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      map.set(key, next);
      index += 1;
    } else {
      map.set(key, 'true');
    }
  }
  return map;
}

export function resolveOutputRoot(value: unknown, fallbackPath: string): string {
  return path.resolve(String(value || fallbackPath));
}

export function isDirectCliInvocation(metaUrl: string, argv: string[] = process.argv): boolean {
  const invokedPath = argv[1] ? path.resolve(argv[1]) : '';
  return Boolean(invokedPath && invokedPath === fileURLToPath(metaUrl));
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJsonArtifact(outputRoot: string, fileName: string, value: unknown): void {
  ensureDir(outputRoot);
  fs.writeFileSync(path.join(outputRoot, fileName), JSON.stringify(value, null, 2), 'utf8');
}

export function writeTextArtifact(outputRoot: string, fileName: string, value: string): void {
  ensureDir(outputRoot);
  fs.writeFileSync(path.join(outputRoot, fileName), value, 'utf8');
}

export function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}
