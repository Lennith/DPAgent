import * as fs from 'fs';
import * as path from 'path';
import { errorResult, Tool } from './Tool.js';
import type { PermissionCheckResult, ToolResult } from '../types.js';

export interface ToolAccessBaseOptions {
  workspaceDir: string;
  checkPermission?: (filePath: string, operation: 'read' | 'write') => PermissionCheckResult;
  exemptDirs?: string[];
}

function resolveRealPathForContainment(targetPath: string): string | null {
  const missingParts: string[] = [];
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(targetPath);
    }
    missingParts.unshift(path.basename(current));
    current = parent;
  }
  try {
    const realBase = fs.realpathSync.native(current);
    return missingParts.length > 0 ? path.resolve(realBase, ...missingParts) : realBase;
  } catch {
    return null;
  }
}

export function isPathWithinRealDir(filePath: string, dirPath: string): boolean {
  const resolvedFilePath = resolveRealPathForContainment(filePath);
  const resolvedDirPath = resolveRealPathForContainment(dirPath);
  if (!resolvedFilePath || !resolvedDirPath) {
    return false;
  }
  const relativePath = path.relative(resolvedDirPath, resolvedFilePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function accessDeniedResult(permission: PermissionCheckResult): ToolResult | null {
  return permission.allowed ? null : errorResult(permission.reason ?? 'Permission denied');
}

export abstract class ToolAccessBase extends Tool {
  protected readonly workspaceDir: string;
  protected readonly checkPermission?: (filePath: string, operation: 'read' | 'write') => PermissionCheckResult;
  private readonly exemptDirs: string[];

  constructor(options: ToolAccessBaseOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
    this.exemptDirs = options.exemptDirs?.map((dir) => path.resolve(dir)) ?? [];
  }

  protected resolveWorkspacePath(value: string): string {
    if (path.isAbsolute(value)) {
      return value;
    }
    return path.resolve(this.workspaceDir, value);
  }

  protected isExemptPath(filePath: string): boolean {
    return this.exemptDirs.some((exemptDir) => isPathWithinRealDir(filePath, exemptDir));
  }

  protected checkAccess(filePath: string, operation: 'read' | 'write'): PermissionCheckResult {
    if (!this.checkPermission) {
      return { allowed: true };
    }
    return this.checkPermission(filePath, operation);
  }

  protected checkAccessUnlessExempt(filePath: string, operation: 'read' | 'write'): PermissionCheckResult {
    if (this.isExemptPath(filePath)) {
      return { allowed: true };
    }
    return this.checkAccess(filePath, operation);
  }
}
