import fs from 'fs';
import path from 'path';

export interface LocalFileBrowserRoot {
  path: string;
  label: string;
}

export interface LocalFileBrowserEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
}

export function normalizeLocalBrowserPath(input: string): string {
  const normalized = String(input ?? '').trim().replace(/^["']|["']$/g, '');
  if (!normalized) {
    return '';
  }
  return path.resolve(normalized);
}

export function getLocalFileRoots(): LocalFileBrowserRoot[] {
  if (process.platform === 'win32') {
    const roots: LocalFileBrowserRoot[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const letter = String.fromCharCode(code);
      const root = `${letter}:\\`;
      try {
        if (fs.existsSync(root)) {
          roots.push({ path: root, label: root });
        }
      } catch {
        // Ignore inaccessible drives.
      }
    }
    return roots;
  }
  return [{ path: '/', label: '/' }];
}

export async function listLocalDirectory(inputPath: string): Promise<{
  path: string;
  parentPath: string | null;
  entries: LocalFileBrowserEntry[];
}> {
  const normalizedPath = normalizeLocalBrowserPath(inputPath);
  if (!normalizedPath) {
    throw new Error('path is required');
  }

  const stat = await fs.promises.stat(normalizedPath);
  if (!stat.isDirectory()) {
    throw new Error('path is not a directory');
  }

  const dirents = await fs.promises.readdir(normalizedPath, { withFileTypes: true });
  const entries: LocalFileBrowserEntry[] = [];
  for (const dirent of dirents) {
    const entryPath = path.join(normalizedPath, dirent.name);
    try {
      const entryStat = await fs.promises.stat(entryPath);
      if (!entryStat.isDirectory() && !entryStat.isFile()) {
        continue;
      }
      entries.push({
        name: dirent.name,
        path: entryPath,
        type: entryStat.isDirectory() ? 'directory' : 'file',
        ...(entryStat.isFile() ? { size: entryStat.size } : {}),
        modifiedAt: entryStat.mtime.toISOString(),
      });
    } catch {
      // Ignore entries the current process cannot stat.
    }
  }

  entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });

  const parentPath = path.dirname(normalizedPath);
  return {
    path: normalizedPath,
    parentPath: parentPath !== normalizedPath ? parentPath : null,
    entries,
  };
}
