import * as fs from 'fs';
import * as path from 'path';
import { acquireInMemoryLockOrThrow, releaseInMemoryLock } from '../storage/in-memory-lock.js';
import type {
  ContextEvent,
  ContextNamespaceMeta,
  ContextRef,
  ContextScope,
} from '../types.js';

interface AppendEventOptions {
  workspaceDir?: string;
  expectedEventCount?: number;
}

interface CopyNamespaceInput {
  source: ContextRef;
  target: ContextRef;
  meta: ContextNamespaceMeta;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cloneMeta(meta: ContextNamespaceMeta): ContextNamespaceMeta {
  return JSON.parse(JSON.stringify(meta)) as ContextNamespaceMeta;
}

export class ContextEventStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * Truncates events to a specific count, keeping only the first `keepCount` events.
   * Used for rollback when context validation fails.
   */
  truncateEvents(scope: ContextScope, namespace: string, keepCount: number): number {
    const filePath = this.eventsFilePath(scope, namespace);
    if (!fs.existsSync(filePath)) {
      return 0;
    }
    acquireInMemoryLockOrThrow(filePath);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) {
        return 0;
      }
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);
      if (keepCount >= lines.length) {
        return lines.length; // Nothing to truncate
      }
      const kept = lines.slice(0, keepCount);
      fs.writeFileSync(filePath, kept.join('\n') + '\n', 'utf-8');
      return lines.length - keepCount;
    } finally {
      releaseInMemoryLock(filePath);
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getNamespacePath(ref: ContextRef): string {
    return this.resolveNamespacePath(ref.scope, ref.namespace);
  }

  readEvents(scope: ContextScope, namespace: string): ContextEvent[] {
    const filePath = this.eventsFilePath(scope, namespace);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) {
      return [];
    }
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const out: ContextEvent[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as ContextEvent);
      } catch {
        // ignore malformed lines
      }
    }
    return out;
  }

  appendEvents(scope: ContextScope, namespace: string, events: ContextEvent[], options: AppendEventOptions = {}): void {
    if (events.length === 0) {
      return;
    }
    this.ensureNamespace(scope, namespace, options.workspaceDir);
    const filePath = this.eventsFilePath(scope, namespace);
    acquireInMemoryLockOrThrow(filePath);
    try {
      if (typeof options.expectedEventCount === 'number') {
        const actualEventCount = this.countEventsFromFile(filePath);
        if (actualEventCount !== options.expectedEventCount) {
          throw new Error(
            `Context event version conflict for ${scope}:${namespace}: expected ${options.expectedEventCount}, found ${actualEventCount}`
          );
        }
      }
      const content = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
      fs.appendFileSync(filePath, content, 'utf-8');
    } finally {
      releaseInMemoryLock(filePath);
    }

    const meta = this.loadMeta(scope, namespace) ?? this.createMeta(scope, namespace, options.workspaceDir);
    meta.updatedAt = nowIso();
    if (options.workspaceDir) {
      meta.workspaceDir = options.workspaceDir;
    }
    this.saveMeta(scope, namespace, meta);
  }

  private countEventsFromFile(filePath: string): number {
    if (!fs.existsSync(filePath)) {
      return 0;
    }
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) {
      return 0;
    }
    return raw.split('\n').filter((line) => line.trim().length > 0).length;
  }

  loadMeta(scope: ContextScope, namespace: string): ContextNamespaceMeta | undefined {
    const filePath = this.metaFilePath(scope, namespace);
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ContextNamespaceMeta;
      return cloneMeta(data);
    } catch {
      return undefined;
    }
  }

  saveMeta(scope: ContextScope, namespace: string, meta: ContextNamespaceMeta): void {
    this.ensureNamespace(scope, namespace, meta.workspaceDir);
    const filePath = this.metaFilePath(scope, namespace);
    const next: ContextNamespaceMeta = {
      ...meta,
      scope,
      namespace,
      updatedAt: nowIso(),
      createdAt: meta.createdAt || nowIso(),
    };
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
  }

  listNamespaces(scope: ContextScope): ContextNamespaceMeta[] {
    const dir = this.scopeDir(scope);
    if (!fs.existsSync(dir)) {
      return [];
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory());
    const out: ContextNamespaceMeta[] = [];
    for (const entry of entries) {
      const namespace = this.tokenToNamespace(entry.name);
      const meta = this.loadMeta(scope, namespace);
      if (meta) {
        out.push(meta);
      } else {
        out.push(this.createMeta(scope, namespace));
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  deleteNamespace(scope: ContextScope, namespace: string): boolean {
    const target = this.resolveNamespacePath(scope, namespace);
    if (!fs.existsSync(target)) {
      return false;
    }
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  }

  copyCommittedNamespace(input: CopyNamespaceInput): void {
    const sourcePath = this.resolveNamespacePath(input.source.scope, input.source.namespace);
    const targetPath = this.resolveNamespacePath(input.target.scope, input.target.namespace);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Context namespace not found: ${input.source.scope}:${input.source.namespace}`);
    }
    if (fs.existsSync(targetPath)) {
      throw new Error(`Context namespace already exists: ${input.target.scope}:${input.target.namespace}`);
    }
    fs.mkdirSync(targetPath, { recursive: true });

    const sourceEventsPath = this.eventsFilePath(input.source.scope, input.source.namespace);
    const targetEventsPath = this.eventsFilePath(input.target.scope, input.target.namespace);
    fs.copyFileSync(sourceEventsPath, targetEventsPath);

    const sourceToolResultsPath = path.join(sourcePath, 'tool-results');
    if (fs.existsSync(sourceToolResultsPath)) {
      fs.cpSync(sourceToolResultsPath, path.join(targetPath, 'tool-results'), {
        recursive: true,
        force: false,
      });
    }

    this.saveMeta(input.target.scope, input.target.namespace, input.meta);
  }

  private ensureNamespace(scope: ContextScope, namespace: string, workspaceDir?: string): void {
    const scopePath = this.scopeDir(scope);
    if (!fs.existsSync(scopePath)) {
      fs.mkdirSync(scopePath, { recursive: true });
    }
    const namespacePath = this.resolveNamespacePath(scope, namespace);
    if (!fs.existsSync(namespacePath)) {
      fs.mkdirSync(namespacePath, { recursive: true });
    }
    const eventsPath = this.eventsFilePath(scope, namespace);
    if (!fs.existsSync(eventsPath)) {
      fs.writeFileSync(eventsPath, '', 'utf-8');
    }
    const metaPath = this.metaFilePath(scope, namespace);
    if (!fs.existsSync(metaPath)) {
      const meta = this.createMeta(scope, namespace, workspaceDir);
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    }
  }

  private createMeta(scope: ContextScope, namespace: string, workspaceDir?: string): ContextNamespaceMeta {
    const current = nowIso();
    return {
      scope,
      namespace,
      createdAt: current,
      updatedAt: current,
      workspaceDir,
    };
  }

  private scopeDir(scope: ContextScope): string {
    return path.join(this.baseDir, scope);
  }

  private resolveNamespacePath(scope: ContextScope, namespace: string): string {
    return path.join(this.scopeDir(scope), this.namespaceToToken(namespace));
  }

  private eventsFilePath(scope: ContextScope, namespace: string): string {
    return path.join(this.resolveNamespacePath(scope, namespace), 'events.jsonl');
  }

  private metaFilePath(scope: ContextScope, namespace: string): string {
    return path.join(this.resolveNamespacePath(scope, namespace), 'meta.json');
  }

  private namespaceToToken(namespace: string): string {
    const token = encodeURIComponent(namespace.trim());
    if (token === '.') {
      return '%2E';
    }
    if (token === '..') {
      return '%2E%2E';
    }
    return token;
  }

  private tokenToNamespace(token: string): string {
    try {
      return decodeURIComponent(token);
    } catch {
      return token;
    }
  }
}
