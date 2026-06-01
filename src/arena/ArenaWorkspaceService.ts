import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArenaBranch, ArenaRun } from './types.js';

export interface ArenaBranchWorkspaceResult {
  workspaceDir: string;
  strategy: 'git_worktree' | 'directory_copy' | 'answer_only' | 'session_only';
  dirtyCopied: boolean;
}

export interface ArenaWorkspaceServiceOptions {
  sourceWorkspaceDir?: string;
  arenaRootDir?: string;
}

export interface ArenaWorkspaceDiff {
  sourceHash: string;
  branchHash: string;
  changedFiles: string[];
}

export interface ArenaWorkspaceApplyResult {
  sourceHashBefore: string;
  sourceHashAfter: string;
  changedFiles: string[];
}

function trimString(value: unknown): string {
  return String(value ?? '').trim();
}

function slug(value: unknown, fallback: string): string {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

function shortId(value: string): string {
  return slug(value, 'arena').replace(/^arena-/, '').slice(0, 8) || 'arena';
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function isGitRepo(cwd: string): boolean {
  try {
    return runGit(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

function hasDirtyWorktree(cwd: string): boolean {
  try {
    return runGit(cwd, ['status', '--porcelain']).length > 0;
  } catch {
    return false;
  }
}

const EXCLUDED_ROOTS = new Set([
  '.git',
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

function shouldCopyPath(sourceRoot: string, sourcePath: string): boolean {
  const relative = path.relative(sourceRoot, sourcePath);
  if (!relative) {
    return true;
  }
  try {
    if (fs.lstatSync(sourcePath).isSymbolicLink()) {
      return false;
    }
  } catch {
    return false;
  }
  const firstSegment = relative.split(path.sep)[0];
  return !EXCLUDED_ROOTS.has(firstSegment);
}

function assertExistingDirectory(dir: string, label: string): string {
  const resolved = path.resolve(trimString(dir));
  if (!trimString(dir) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} does not exist`);
  }
  return resolved;
}

function assertSafeRelativePath(relativePath: string): string {
  const normalized = relativePath.split(/[\\/]+/).filter(Boolean).join('/');
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe Arena changed file path: ${relativePath}`);
  }
  return normalized;
}

function listWorkspaceFiles(rootDir: string): string[] {
  const root = path.resolve(rootDir);
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (!shouldCopyPath(root, absolute)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (entry.isFile()) {
        out.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  visit(root);
  out.sort();
  return out;
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function hashArenaWorkspace(rootDir: string): string {
  const root = assertExistingDirectory(rootDir, 'Arena workspace');
  const payload = listWorkspaceFiles(root)
    .map((relativePath) => `${relativePath}\0${hashFile(path.join(root, relativePath))}`)
    .join('\n');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function diffArenaWorkspaces(sourceDir: string, branchDir: string): ArenaWorkspaceDiff {
  const sourceRoot = assertExistingDirectory(sourceDir, 'Arena source workspace');
  const branchRoot = assertExistingDirectory(branchDir, 'Arena branch workspace');
  const sourceFiles = new Set(listWorkspaceFiles(sourceRoot));
  const branchFiles = new Set(listWorkspaceFiles(branchRoot));
  const changedFiles = Array.from(new Set([...sourceFiles, ...branchFiles]))
    .filter((relativePath) => {
      if (!sourceFiles.has(relativePath) || !branchFiles.has(relativePath)) {
        return true;
      }
      return hashFile(path.join(sourceRoot, relativePath)) !== hashFile(path.join(branchRoot, relativePath));
    })
    .sort();
  return {
    sourceHash: hashArenaWorkspace(sourceRoot),
    branchHash: hashArenaWorkspace(branchRoot),
    changedFiles,
  };
}

export function applyArenaWorkspaceDiff(input: {
  sourceDir: string;
  branchDir: string;
  expectedSourceHash: string;
  expectedBranchHash: string;
  changedFiles: string[];
}): ArenaWorkspaceApplyResult {
  const sourceRoot = assertExistingDirectory(input.sourceDir, 'Arena source workspace');
  const branchRoot = assertExistingDirectory(input.branchDir, 'Arena branch workspace');
  const sourceHashBefore = hashArenaWorkspace(sourceRoot);
  if (sourceHashBefore !== trimString(input.expectedSourceHash)) {
    throw new Error('Arena source workspace changed since proposal was created');
  }
  if (hashArenaWorkspace(branchRoot) !== trimString(input.expectedBranchHash)) {
    throw new Error('Arena branch workspace changed since proposal was created');
  }
  const changedFiles = input.changedFiles.map(assertSafeRelativePath);
  for (const relativePath of changedFiles) {
    const pathSegments = relativePath.split('/');
    const sourcePath = path.resolve(sourceRoot, ...pathSegments);
    const branchPath = path.resolve(branchRoot, ...pathSegments);
    if (!isPathInside(sourceRoot, sourcePath) || !isPathInside(branchRoot, branchPath)) {
      throw new Error(`Arena apply path escaped workspace: ${relativePath}`);
    }
    if (fs.existsSync(branchPath)) {
      const stat = fs.lstatSync(branchPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Arena apply only supports regular files: ${relativePath}`);
      }
      assertNoSourceSymlinkPath(sourceRoot, relativePath);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.copyFileSync(branchPath, sourcePath);
      continue;
    }
    if (fs.existsSync(sourcePath)) {
      fs.rmSync(sourcePath, { force: true });
    }
  }
  return {
    sourceHashBefore,
    sourceHashAfter: hashArenaWorkspace(sourceRoot),
    changedFiles,
  };
}

function assertNoSourceSymlinkPath(sourceRoot: string, relativePath: string): void {
  const segments = relativePath.split('/');
  let current = sourceRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      continue;
    }
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Arena apply refuses source symlink path: ${relativePath}`);
    }
  }
}

function copyWorkspace(source: string, target: string, options: { force: boolean }): void {
  const sourceRoot = path.resolve(source);
  fs.cpSync(source, target, {
    recursive: true,
    force: options.force,
    filter: (sourcePath) => shouldCopyPath(sourceRoot, sourcePath),
  });
}

function removeDeletedTrackedFiles(source: string, target: string): void {
  const deleted = runGit(source, ['ls-files', '--deleted'])
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const relativePath of deleted) {
    const targetPath = path.resolve(target, relativePath);
    if (isPathInside(target, targetPath) && fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { force: true });
    }
  }
}

export class ArenaWorkspaceService {
  constructor(private readonly options: ArenaWorkspaceServiceOptions) {}

  prepareBranchWorkspace(run: ArenaRun, branch: ArenaBranch): ArenaBranchWorkspaceResult {
    if (run.mode === 'answer') {
      return {
        workspaceDir: '',
        strategy: 'answer_only',
        dirtyCopied: false,
      };
    }
    const rawSourceWorkspaceDir = trimString(this.options.sourceWorkspaceDir);
    if (!rawSourceWorkspaceDir) {
      return {
        workspaceDir: '',
        strategy: 'session_only',
        dirtyCopied: false,
      };
    }
    const sourceWorkspaceDir = path.resolve(rawSourceWorkspaceDir);
    if (!fs.existsSync(sourceWorkspaceDir)) {
      return {
        workspaceDir: '',
        strategy: 'session_only',
        dirtyCopied: false,
      };
    }
    const rootDir = this.resolveArenaRoot(sourceWorkspaceDir, run);
    const branchDir = path.join(
      rootDir,
      `${branch.index + 1}-${slug(branch.contestant.agentName, 'agent')}-${slug(branch.contestant.llmSelection.model, 'model')}`
    );
    const resolvedBranchDir = path.resolve(branchDir);
    if (!isPathInside(rootDir, resolvedBranchDir)) {
      throw new Error('Arena branch workspace path escaped arena root');
    }
    if (fs.existsSync(resolvedBranchDir)) {
      throw new Error(`Arena branch workspace already exists: ${resolvedBranchDir}`);
    }
    fs.mkdirSync(rootDir, { recursive: true });
    const dirtyCopied = hasDirtyWorktree(sourceWorkspaceDir);
    if (isGitRepo(sourceWorkspaceDir)) {
      try {
        const head = runGit(sourceWorkspaceDir, ['rev-parse', '--verify', 'HEAD']);
        runGit(sourceWorkspaceDir, ['worktree', 'add', '--detach', resolvedBranchDir, head]);
        copyWorkspace(sourceWorkspaceDir, resolvedBranchDir, { force: true });
        removeDeletedTrackedFiles(sourceWorkspaceDir, resolvedBranchDir);
        return {
          workspaceDir: resolvedBranchDir,
          strategy: 'git_worktree',
          dirtyCopied,
        };
      } catch {
        if (fs.existsSync(resolvedBranchDir)) {
          fs.rmSync(resolvedBranchDir, { recursive: true, force: true });
        }
      }
    }
    copyWorkspace(sourceWorkspaceDir, resolvedBranchDir, { force: false });
    return {
      workspaceDir: resolvedBranchDir,
      strategy: 'directory_copy',
      dirtyCopied: true,
    };
  }

  private resolveArenaRoot(sourceWorkspaceDir: string, run: ArenaRun): string {
    if (this.options.arenaRootDir) {
      return path.resolve(this.options.arenaRootDir);
    }
    const parent = path.dirname(sourceWorkspaceDir);
    return path.join(
      parent,
      '.dpagent-arena',
      `${slug(run.sourceSessionName || run.sourceSessionId, 'session')}-arena-${shortId(run.id)}`
    );
  }
}
