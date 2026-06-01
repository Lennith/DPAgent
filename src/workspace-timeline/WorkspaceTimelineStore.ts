import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextRef } from '../types.js';
import type {
  PreparedWorkspaceDelta,
  TurnWorkspaceDelta,
  WorkspaceBlobIdentity,
  WorkspaceDeltaEntry,
  WorkspaceManifestEntry,
  WorkspaceRecoveryReport,
  WorkspaceRollbackApplyResult,
  WorkspaceRevision,
  WorkspaceTimelineConfig,
  WorkspaceTimelineSummary,
  WorkspaceTrustLevel,
} from './types.js';

const DEFAULT_EXCLUDED_ROOTS = new Set([
  '.git',
  '.dpagent',
  '.dpagent-arena',
  'node_modules',
  'dist',
  'logs',
  'runtime',
  'contexts',
  'workspace',
  'workspace-smoke-default',
  'ux-workspace',
  'outputs',
]);

export interface BeginWorkspaceTurnInput {
  context: ContextRef;
  turnId: string;
  workspaceDir?: string;
}

export interface AbortWorkspaceDeltaInput {
  deltaId: string;
  reason: string;
}

export interface WorkspaceTimelineStoreOptions {
  runtimeDataDir: string;
  config: WorkspaceTimelineConfig;
}

interface StoredHandle {
  id: string;
  context: ContextRef;
  sessionId: string;
  turnId: string;
  workspaceDir: string;
  workspaceId: string;
  baseRevisionId: string;
  deltaId: string;
  startedAt: string;
}

interface RollbackWriteOperation {
  relativePath: string;
  absolute: string;
  content: Buffer;
}

interface RollbackDeleteOperation {
  relativePath: string;
  absolute: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimString(value: unknown): string {
  return String(value ?? '').trim();
}

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeToken(value: string): string {
  return sha256(value).slice(0, 32);
}

function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isGitRepo(cwd: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
  } catch {
    return false;
  }
}

function hasGitHead(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function gitStatusPorcelainZ(cwd: string, args: string[] = []): string[] {
  try {
    const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.split('\0').filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

function gitLsFilesZ(cwd: string, args: string[]): string[] {
  try {
    const raw = execFileSync('git', ['ls-files', '-z', ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.split('\0').filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

export class WorkspaceTimelineStore {
  private readonly rootDir: string;

  constructor(private readonly options: WorkspaceTimelineStoreOptions) {
    this.rootDir = path.join(path.resolve(options.runtimeDataDir), 'workspace-timeline');
    for (const child of ['handles', 'revisions', 'deltas', 'manifests', path.join('blobs', 'sha256')]) {
      fs.mkdirSync(path.join(this.rootDir, child), { recursive: true });
    }
  }

  isEnabled(): boolean {
    return this.options.config.enabled === true;
  }

  beginTurn(input: BeginWorkspaceTurnInput): StoredHandle | null {
    if (!this.isEnabled()) {
      return null;
    }
    const workspaceDir = trimString(input.workspaceDir);
    if (!workspaceDir || !fs.existsSync(path.resolve(workspaceDir))) {
      return null;
    }
    const resolvedWorkspaceDir = path.resolve(workspaceDir);
    const workspaceId = this.createWorkspaceId(resolvedWorkspaceDir);
    const manifest = this.captureManifest(resolvedWorkspaceDir);
    const manifestId = this.writeManifest(manifest);
    const timestamp = nowIso();
    const revision: WorkspaceRevision = {
      id: `rev-${safeToken(`${workspaceId}:${input.turnId}:begin:${timestamp}`)}`,
      workspaceId,
      workspaceDir: resolvedWorkspaceDir,
      repoKind: this.resolveRepoKind(resolvedWorkspaceDir),
      manifestId,
      manifestTrust: 'complete',
      trustLevel: 'observed_partial',
      source: 'turn_begin',
      context: jsonClone(input.context),
      turnId: input.turnId,
      createdAt: timestamp,
    };
    this.writeRevision(revision);
    const delta: TurnWorkspaceDelta = {
      id: `delta-${safeToken(`${workspaceId}:${input.turnId}:${timestamp}`)}`,
      workspaceId,
      sessionId: input.context.namespace,
      turnId: input.turnId,
      baseRevisionId: revision.id,
      status: 'pending',
      trustLevel: 'observed_partial',
      entries: [],
      changedFiles: [],
      captureWarnings: [],
      createdAt: timestamp,
      retention: { protected: false, blobState: 'available' },
    };
    this.writeDelta(delta);
    const handle: StoredHandle = {
      id: `handle-${safeToken(delta.id)}`,
      context: jsonClone(input.context),
      sessionId: input.context.namespace,
      turnId: input.turnId,
      workspaceDir: resolvedWorkspaceDir,
      workspaceId,
      baseRevisionId: revision.id,
      deltaId: delta.id,
      startedAt: timestamp,
    };
    this.writeHandle(handle);
    return jsonClone(handle);
  }

  prepareTurnDelta(handle: StoredHandle): PreparedWorkspaceDelta {
    if (!this.isEnabled()) {
      throw new Error('Workspace Timeline is disabled');
    }
    const baseRevision = this.readRevision(handle.baseRevisionId);
    const pendingDelta = this.readDelta(handle.deltaId);
    if (!baseRevision || !pendingDelta) {
      throw new Error(`Workspace timeline handle is missing revision or delta: ${handle.id}`);
    }
    const baseManifest = this.readManifest(baseRevision.manifestId);
    const nextManifest = this.captureManifest(handle.workspaceDir);
    const resultManifestId = this.writeManifest(nextManifest);
    const entries = this.buildDeltaEntries(handle.workspaceDir, baseManifest, nextManifest);
    const trustLevel = this.resolveTrustLevel(handle.workspaceDir);
    const warnings = this.buildCaptureWarnings(handle.workspaceDir, trustLevel);
    const timestamp = nowIso();
    const resultRevision: WorkspaceRevision = {
      id: `rev-${safeToken(`${handle.workspaceId}:${handle.turnId}:result:${timestamp}`)}`,
      workspaceId: handle.workspaceId,
      workspaceDir: handle.workspaceDir,
      parentRevisionId: baseRevision.id,
      repoKind: this.resolveRepoKind(handle.workspaceDir),
      manifestId: resultManifestId,
      manifestTrust: 'complete',
      trustLevel,
      source: 'turn_commit',
      context: jsonClone(handle.context),
      turnId: handle.turnId,
      createdAt: timestamp,
    };
    this.writeRevision(resultRevision);
    const delta: TurnWorkspaceDelta = {
      ...pendingDelta,
      resultRevisionId: resultRevision.id,
      status: 'prepared',
      trustLevel,
      entries,
      changedFiles: entries.map((entry) => entry.path).sort(),
      captureWarnings: warnings,
      preparedAt: timestamp,
      auditOnly: trustLevel !== 'trusted' && trustLevel !== 'git_observed',
      retention: pendingDelta.retention ?? { protected: false, blobState: 'available' },
    };
    this.writeDelta(delta);
    return { delta: jsonClone(delta), resultRevision: jsonClone(resultRevision) };
  }

  markCommitted(deltaId: string): TurnWorkspaceDelta {
    const delta = this.requireDelta(deltaId);
    const next: TurnWorkspaceDelta = {
      ...delta,
      status: 'committed',
      committedAt: nowIso(),
    };
    this.writeDelta(next);
    this.enforceRetention(next.sessionId);
    return jsonClone(this.requireDelta(deltaId));
  }

  abortDelta(input: AbortWorkspaceDeltaInput): void {
    const delta = this.readDelta(input.deltaId);
    if (!delta || delta.status === 'committed') {
      return;
    }
    this.writeDelta({
      ...delta,
      status: 'aborted',
      captureWarnings: [...delta.captureWarnings, input.reason],
      abortedAt: nowIso(),
    });
  }

  recoverPreparedCommits(options: {
    isContextCommitted?: (delta: TurnWorkspaceDelta) => boolean;
  } = {}): WorkspaceRecoveryReport {
    const recovered: string[] = [];
    const aborted: string[] = [];
    for (const delta of this.listAllDeltas()) {
      if (delta.status !== 'prepared') {
        continue;
      }
      if (options.isContextCommitted?.(delta)) {
        this.markCommitted(delta.id);
        recovered.push(delta.id);
        continue;
      }
      this.writeDelta({
        ...delta,
        status: 'incomplete',
        captureWarnings: [...delta.captureWarnings, 'Prepared delta found without committed context event.'],
      });
      aborted.push(delta.id);
    }
    return { recovered, aborted };
  }

  getDelta(deltaId: string): TurnWorkspaceDelta | null {
    if (!this.isEnabled()) {
      return null;
    }
    return this.readDelta(deltaId);
  }

  getRevision(revisionId: string): WorkspaceRevision | null {
    if (!this.isEnabled()) {
      return null;
    }
    return this.readRevision(revisionId);
  }

  listSessionTimeline(sessionId: string): WorkspaceTimelineSummary {
    if (!this.isEnabled()) {
      return {
        sessionId,
        retainedStageTurns: this.options.config.retainedStageTurns,
        deltas: [],
      };
    }
    const deltas = this.listAllDeltas()
      .filter((delta) => delta.sessionId === sessionId && delta.status === 'committed')
      .sort((a, b) => (b.committedAt ?? b.createdAt).localeCompare(a.committedAt ?? a.createdAt));
    return {
      sessionId,
      retainedStageTurns: this.options.config.retainedStageTurns,
      deltas: deltas.map((delta) => ({
        id: delta.id,
        turnId: delta.turnId,
        status: delta.status,
        trustLevel: delta.trustLevel,
        changedFiles: [...delta.changedFiles],
        captureWarnings: [...delta.captureWarnings],
        auditOnly: delta.auditOnly ?? false,
        blobState: delta.retention?.blobState ?? 'available',
        createdAt: delta.createdAt,
        committedAt: delta.committedAt,
        resultRevisionId: delta.resultRevisionId,
      })),
    };
  }

  appendRollbackAudit(input: { sessionId: string; targetRevisionId: string; reason?: string }): void {
    if (!this.isEnabled()) {
      throw new Error('Workspace Timeline is disabled');
    }
    const auditPath = path.join(this.rootDir, 'rollback-audit.jsonl');
    const record = {
      sessionId: input.sessionId,
      targetRevisionId: input.targetRevisionId,
      reason: trimString(input.reason),
      createdAt: nowIso(),
    };
    fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  applyRollback(input: { sessionId: string; targetRevisionId: string; reason?: string }): WorkspaceRollbackApplyResult {
    if (!this.isEnabled()) {
      throw new Error('Workspace Timeline is disabled');
    }
    const target = this.requireRevision(input.targetRevisionId);
    if (target.context?.scope !== 'session' || target.context.namespace !== input.sessionId) {
      throw new Error('Workspace rollback target revision does not belong to the requested session');
    }
    const targetManifest = this.readManifest(target.manifestId);
    const currentManifest = this.captureManifest(target.workspaceDir);
    const targetByPath = new Map(targetManifest.map((entry) => [entry.path, entry]));
    const currentByPath = new Map(currentManifest.map((entry) => [entry.path, entry]));
    const changedFiles = Array.from(new Set([...targetByPath.keys(), ...currentByPath.keys()])).filter((relativePath) => {
      const targetEntry = targetByPath.get(relativePath);
      const currentEntry = currentByPath.get(relativePath);
      return targetEntry?.sha256 !== currentEntry?.sha256 || targetEntry?.size !== currentEntry?.size;
    }).sort();
    const writes: RollbackWriteOperation[] = [];
    const deletes: RollbackDeleteOperation[] = [];

    for (const relativePath of changedFiles) {
      const absolute = this.resolveSafeWorkspaceFile(target.workspaceDir, relativePath);
      const targetEntry = targetByPath.get(relativePath);
      if (!targetEntry) {
        this.validateRollbackExistingTarget(absolute, relativePath, false);
        deletes.push({ relativePath, absolute });
        continue;
      }
      this.validateRollbackExistingTarget(absolute, relativePath, true);
      writes.push({
        relativePath,
        absolute,
        content: this.readBlobContent(targetEntry.blobRef, targetEntry.sha256),
      });
    }

    const tempFiles: Array<{ tempPath: string; finalPath: string }> = [];
    try {
      for (const item of writes) {
        fs.mkdirSync(path.dirname(item.absolute), { recursive: true });
        const tempPath = path.join(path.dirname(item.absolute), `.dpagent-rollback-${process.pid}-${safeToken(`${item.absolute}:${Date.now()}`)}.tmp`);
        fs.writeFileSync(tempPath, item.content);
        tempFiles.push({ tempPath, finalPath: item.absolute });
      }
      for (const item of deletes) {
        if (fs.existsSync(item.absolute)) {
          fs.rmSync(item.absolute, { force: true });
        }
      }
      for (const item of tempFiles) {
        fs.renameSync(item.tempPath, item.finalPath);
      }
    } catch (error) {
      this.restoreManifest(target.workspaceDir, currentManifest);
      throw error;
    } finally {
      for (const item of tempFiles) {
        fs.rmSync(item.tempPath, { force: true });
      }
    }

    const appliedAt = nowIso();
    this.appendRollbackAudit({
      sessionId: input.sessionId,
      targetRevisionId: input.targetRevisionId,
      reason: input.reason,
    });
    return {
      sessionId: input.sessionId,
      targetRevisionId: input.targetRevisionId,
      workspaceDir: target.workspaceDir,
      changedFiles,
      appliedAt,
    };
  }

  private createWorkspaceId(workspaceDir: string): string {
    return `ws-${safeToken(path.resolve(workspaceDir).toLowerCase())}`;
  }

  private validateRollbackExistingTarget(absolute: string, relativePath: string, allowFile: boolean): void {
    const stat = fs.existsSync(absolute) ? fs.lstatSync(absolute) : null;
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Workspace rollback refuses target symlink path: ${relativePath}`);
    }
    if (allowFile && stat.isFile()) {
      return;
    }
    if (!allowFile && stat.isFile()) {
      return;
    }
    throw new Error(`Workspace rollback only supports regular files: ${relativePath}`);
  }

  private restoreManifest(workspaceDir: string, manifest: WorkspaceManifestEntry[]): void {
    const desiredByPath = new Map(manifest.map((entry) => [entry.path, entry]));
    const current = this.captureManifest(workspaceDir);
    for (const entry of current) {
      if (!desiredByPath.has(entry.path)) {
        const absolute = this.resolveSafeWorkspaceFile(workspaceDir, entry.path);
        if (fs.existsSync(absolute)) {
          fs.rmSync(absolute, { force: true });
        }
      }
    }
    for (const entry of manifest) {
      const absolute = this.resolveSafeWorkspaceFile(workspaceDir, entry.path);
      const content = this.readBlobContent(entry.blobRef, entry.sha256);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      this.validateRollbackExistingTarget(absolute, entry.path, true);
      fs.writeFileSync(absolute, content);
    }
  }

  private resolveRepoKind(workspaceDir: string): 'git' | 'git_unborn' | 'plain' {
    if (!isGitRepo(workspaceDir)) {
      return 'plain';
    }
    return hasGitHead(workspaceDir) ? 'git' : 'git_unborn';
  }

  private resolveTrustLevel(workspaceDir: string): WorkspaceTrustLevel {
    if (this.options.config.captureMode === 'git_observed' && isGitRepo(workspaceDir) && hasGitHead(workspaceDir)) {
      return 'git_observed';
    }
    return 'observed_partial';
  }

  private buildCaptureWarnings(workspaceDir: string, trustLevel: WorkspaceTrustLevel): string[] {
    const warnings: string[] = [];
    if (trustLevel === 'git_observed') {
      const ignoredChanged = gitStatusPorcelainZ(workspaceDir, ['--ignored']).filter((entry) => entry.startsWith('!! '));
      if (ignoredChanged.length > 0) {
        warnings.push('Ignored files are outside git_observed coverage unless written by trusted tools.');
      }
      return warnings;
    }
    warnings.push('Workspace delta is advisory; shell, MCP, or external writes may be incomplete.');
    return warnings;
  }

  private captureManifest(workspaceDir: string): WorkspaceManifestEntry[] {
    const root = path.resolve(workspaceDir);
    if (this.resolveTrustLevel(root) === 'git_observed') {
      return this.captureGitObservedManifest(root);
    }
    const out: WorkspaceManifestEntry[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (!this.shouldIncludePath(root, absolute)) {
          continue;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          visit(absolute);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const content = fs.readFileSync(absolute);
        const hash = sha256(content);
        this.ensureBlobContent(hash, content);
        out.push({
          path: toRelative(root, absolute),
          sha256: hash,
          size: content.length,
          blobRef: `sha256:${hash}`,
        });
      }
    };
    visit(root);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  private captureGitObservedManifest(workspaceDir: string): WorkspaceManifestEntry[] {
    const root = path.resolve(workspaceDir);
    const observedPaths = Array.from(new Set([
      ...gitLsFilesZ(root, []),
      ...gitLsFilesZ(root, ['--others', '--exclude-standard']),
    ])).sort();
    const out: WorkspaceManifestEntry[] = [];
    for (const relativePath of observedPaths) {
      const absolute = path.resolve(root, ...relativePath.split('/'));
      if (!this.shouldIncludePath(root, absolute)) {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const content = fs.readFileSync(absolute);
      const hash = sha256(content);
      this.ensureBlobContent(hash, content);
      out.push({
        path: toRelative(root, absolute),
        sha256: hash,
        size: content.length,
        blobRef: `sha256:${hash}`,
      });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  private buildDeltaEntries(
    workspaceDir: string,
    baseManifest: WorkspaceManifestEntry[],
    nextManifest: WorkspaceManifestEntry[]
  ): WorkspaceDeltaEntry[] {
    const root = path.resolve(workspaceDir);
    const base = new Map(baseManifest.map((entry) => [entry.path, entry]));
    const next = new Map(nextManifest.map((entry) => [entry.path, entry]));
    const allPaths = Array.from(new Set([...base.keys(), ...next.keys()])).sort();
    const entries: WorkspaceDeltaEntry[] = [];
    for (const relativePath of allPaths) {
      const before = base.get(relativePath);
      const after = next.get(relativePath);
      if (before && after && before.sha256 === after.sha256 && before.size === after.size) {
        continue;
      }
      const absolute = path.resolve(root, ...relativePath.split('/'));
      if (!isPathInside(root, absolute)) {
        continue;
      }
      const operation = before && after ? 'modify' : before ? 'delete' : 'add';
      entries.push({
        path: relativePath,
        operation,
        base: before ? this.manifestEntryToBlobIdentity(before) : undefined,
        next: after ? this.manifestEntryToBlobIdentity(after) : undefined,
      });
    }
    return entries;
  }

  private manifestEntryToBlobIdentity(entry: WorkspaceManifestEntry): WorkspaceBlobIdentity {
    return {
      sha256: entry.sha256,
      size: entry.size,
      blobRef: entry.blobRef,
    };
  }

  private ensureBlobContent(hash: string, content: Buffer): void {
    const blobPath = this.blobPath(hash);
    fs.mkdirSync(path.dirname(blobPath), { recursive: true });
    if (!fs.existsSync(blobPath)) {
      fs.writeFileSync(blobPath, content);
    }
  }

  private shouldIncludePath(root: string, absolute: string): boolean {
    if (!isPathInside(root, absolute)) {
      return false;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      return false;
    }
    const relative = path.relative(root, absolute);
    if (!relative) {
      return true;
    }
    const first = relative.split(path.sep)[0];
    return !DEFAULT_EXCLUDED_ROOTS.has(first);
  }

  private enforceRetention(sessionId: string): void {
    const keep = Math.max(1, Math.min(20, Math.floor(this.options.config.retainedStageTurns)));
    const committed = this.listAllDeltas()
      .filter((delta) => delta.sessionId === sessionId && delta.status === 'committed')
      .sort((a, b) => (b.committedAt ?? b.createdAt).localeCompare(a.committedAt ?? a.createdAt));
    const expired = committed.slice(keep);
    for (const delta of expired) {
      if (delta.retention?.protected) {
        continue;
      }
      this.writeDelta({
        ...delta,
        entries: delta.entries.map((entry) => ({
          path: entry.path,
          operation: entry.operation,
          fileMode: entry.fileMode,
          binary: entry.binary,
        })),
        retention: {
          protected: false,
          blobState: 'summary_only',
          prunedAt: nowIso(),
        },
      });
    }
  }

  private writeManifest(manifest: WorkspaceManifestEntry[]): string {
    const id = `manifest-${sha256(JSON.stringify(manifest))}`;
    fs.writeFileSync(path.join(this.rootDir, 'manifests', `${id}.json`), JSON.stringify(manifest, null, 2), 'utf-8');
    return id;
  }

  private readManifest(id: string): WorkspaceManifestEntry[] {
    const filePath = path.join(this.rootDir, 'manifests', `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WorkspaceManifestEntry[];
  }

  private writeRevision(revision: WorkspaceRevision): void {
    fs.writeFileSync(this.revisionPath(revision.id), JSON.stringify(revision, null, 2), 'utf-8');
  }

  private readRevision(id: string): WorkspaceRevision | null {
    const filePath = this.revisionPath(id);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WorkspaceRevision;
  }

  private requireRevision(id: string): WorkspaceRevision {
    const revision = this.readRevision(id);
    if (!revision) {
      throw new Error(`Workspace revision not found: ${id}`);
    }
    return revision;
  }

  private writeDelta(delta: TurnWorkspaceDelta): void {
    fs.writeFileSync(this.deltaPath(delta.id), JSON.stringify(delta, null, 2), 'utf-8');
  }

  private readDelta(id: string): TurnWorkspaceDelta | null {
    const filePath = this.deltaPath(id);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TurnWorkspaceDelta;
  }

  private requireDelta(id: string): TurnWorkspaceDelta {
    const delta = this.readDelta(id);
    if (!delta) {
      throw new Error(`Workspace delta not found: ${id}`);
    }
    return delta;
  }

  private listAllDeltas(): TurnWorkspaceDelta[] {
    const dir = path.join(this.rootDir, 'deltas');
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as TurnWorkspaceDelta);
  }

  private writeHandle(handle: StoredHandle): void {
    fs.writeFileSync(path.join(this.rootDir, 'handles', `${handle.id}.json`), JSON.stringify(handle, null, 2), 'utf-8');
  }

  private revisionPath(id: string): string {
    return path.join(this.rootDir, 'revisions', `${id}.json`);
  }

  private deltaPath(id: string): string {
    return path.join(this.rootDir, 'deltas', `${id}.json`);
  }

  private blobPath(hash: string): string {
    return path.join(this.rootDir, 'blobs', 'sha256', hash.slice(0, 2), hash);
  }

  private readBlobContent(blobRef: string, expectedHash: string): Buffer {
    const normalized = trimString(blobRef);
    const hash = normalized.startsWith('sha256:') ? normalized.slice('sha256:'.length) : normalized;
    if (!/^[0-9a-f]{64}$/i.test(hash)) {
      throw new Error(`Invalid workspace blob ref: ${blobRef}`);
    }
    const blobPath = this.blobPath(hash);
    const content = fs.readFileSync(blobPath);
    const actualHash = sha256(content);
    if (actualHash !== expectedHash || actualHash !== hash) {
      throw new Error(`Workspace blob hash mismatch: ${blobRef}`);
    }
    return content;
  }

  private resolveSafeWorkspaceFile(workspaceDir: string, relativePath: string): string {
    const root = path.resolve(workspaceDir);
    const absolute = path.resolve(root, ...relativePath.split('/'));
    if (!isPathInside(root, absolute)) {
      throw new Error(`Workspace rollback path escaped workspace: ${relativePath}`);
    }
    let cursor = root;
    for (const segment of relativePath.split('/').slice(0, -1)) {
      cursor = path.join(cursor, segment);
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`Workspace rollback refuses symlink ancestor: ${relativePath}`);
      }
    }
    return absolute;
  }
}
