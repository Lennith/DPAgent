import * as path from 'path';
import * as fs from 'fs';
import type { PermissionCheckResult, DirectoryPermissions } from '../types.js';

export class PermissionManager {
  private workspaceDir: string;
  private writableDirs: Set<string>;
  private readableDirs: Set<string>;

  constructor(options: DirectoryPermissions) {
    this.workspaceDir = this.resolveRealPathIfPossible(options.workspaceDir);
    this.writableDirs = new Set([this.workspaceDir]);
    this.readableDirs = new Set([this.workspaceDir]);

    for (const dir of options.additionalWritableDirs) {
      const resolved = this.resolveRealPathIfPossible(dir);
      this.writableDirs.add(resolved);
      this.readableDirs.add(resolved);
    }
  }

  /**
   * 规范化并解析路径为绝对路径
   * 防止路径遍历攻击（如 ../../../etc/passwd）
   */
  private normalizeAndResolve(filePath: string): string {
    // 1. 解析为绝对路径
    const resolved = path.resolve(filePath);
    // 2. 规范化路径（移除 .. 和 . 序列）
    const normalized = path.normalize(resolved);
    return normalized;
  }

  private resolveRealPathIfPossible(filePath: string): string {
    const resolved = this.normalizeAndResolve(filePath);
    const missingParts: string[] = [];
    let current = resolved;
    while (true) {
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          try {
            return path.resolve(fs.realpathSync.native(current), ...missingParts);
          } catch {
            try {
              const linkTarget = fs.readlinkSync(current);
              const targetBase = path.isAbsolute(linkTarget)
                ? linkTarget
                : path.resolve(path.dirname(current), linkTarget);
              return path.resolve(targetBase, ...missingParts);
            } catch {
              return resolved;
            }
          }
        }
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          return resolved;
        }
        const parent = path.dirname(current);
        if (parent === current) {
          return resolved;
        }
        missingParts.unshift(path.basename(current));
        current = parent;
      }
    }
    try {
      const realBase = fs.realpathSync.native(current);
      return missingParts.length > 0 ? path.resolve(realBase, ...missingParts) : realBase;
    } catch {
      return resolved;
    }
  }

  /**
   * 检查路径是否在允许的目录内
   * 防止符号链接攻击和路径遍历
   */
  private isPathWithin(filePath: string, allowedDir: string): boolean {
    // 规范化两个路径
    const normalizedFilePath = path.normalize(filePath);
    const normalizedAllowedDir = path.normalize(allowedDir);

    // 确保路径以允许的目录开头，并且是一个子目录或文件
    // 添加 path.sep 确保是目录前缀而非字符串前缀
    const prefix = normalizedAllowedDir.endsWith(path.sep) 
      ? normalizedAllowedDir 
      : normalizedAllowedDir + path.sep;

    // 检查：路径等于目录，或是目录的直接子路径
    if (normalizedFilePath === normalizedAllowedDir) {
      return true;
    }

    // 防止部分路径匹配（如 /allowed/path 匹配 /allowed/path-traversal）
    if (normalizedFilePath.startsWith(prefix)) {
      return true;
    }

    return false;
  }

  checkPermission(filePath: string, operation: 'read' | 'write'): PermissionCheckResult {
    const resolved = this.resolveRealPathIfPossible(filePath);
    
    if (operation === 'read') {
      return this.checkRead(resolved);
    }
    
    return this.checkWrite(resolved);
  }

  private checkRead(filePath: string): PermissionCheckResult {
    for (const dir of this.readableDirs) {
      if (this.isPathWithin(filePath, dir)) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Path "${filePath}" is outside readable directories`,
    };
  }

  private checkWrite(filePath: string): PermissionCheckResult {
    for (const dir of this.writableDirs) {
      if (this.isPathWithin(filePath, dir)) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Path "${filePath}" is outside writable directories`,
    };
  }

  addWritableDir(dir: string): void {
    const resolved = this.resolveRealPathIfPossible(dir);
    this.writableDirs.add(resolved);
    this.readableDirs.add(resolved);
  }

  addReadableDir(dir: string): void {
    const resolved = this.resolveRealPathIfPossible(dir);
    this.readableDirs.add(resolved);
  }

  setAdditionalReadableDirs(dirs: string[]): void {
    this.readableDirs = new Set(this.writableDirs);
    for (const dir of dirs) {
      const resolved = this.resolveRealPathIfPossible(dir);
      this.readableDirs.add(resolved);
    }
  }

  removeWritableDir(dir: string): void {
    const resolved = this.resolveRealPathIfPossible(dir);
    this.writableDirs.delete(resolved);
  }

  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  getWritableDirs(): string[] {
    return Array.from(this.writableDirs);
  }

  getReadableDirs(): string[] {
    return Array.from(this.readableDirs);
  }

  isWritable(filePath: string): boolean {
    return this.checkPermission(filePath, 'write').allowed;
  }

  isReadable(filePath: string): boolean {
    return this.checkPermission(filePath, 'read').allowed;
  }

  createPermissionChecker(): (filePath: string, operation: 'read' | 'write') => PermissionCheckResult {
    return (filePath: string, operation: 'read' | 'write') => this.checkPermission(filePath, operation);
  }
}

export function createPermissionManager(options: DirectoryPermissions): PermissionManager {
  return new PermissionManager(options);
}
