import * as fs from 'fs';
import * as path from 'path';
import { Tool, successResult, errorResult } from './Tool.js';
import type { ToolResult, PermissionCheckResult } from '../types.js';

export interface FileToolsOptions {
  workspaceDir: string;
  additionalWritableDirs?: string[];
  checkPermission?: (filePath: string, operation: 'read' | 'write') => PermissionCheckResult;
  exemptDirs?: string[]; // Directories exempt from permission checks (e.g., skills directory)
}

function isPathWithinDir(filePath: string, dirPath: string): boolean {
  const resolvedFilePath = resolveRealPathForContainment(filePath);
  const resolvedDirPath = resolveRealPathForContainment(dirPath);
  if (!resolvedFilePath || !resolvedDirPath) {
    return false;
  }
  const relativePath = path.relative(resolvedDirPath, resolvedFilePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
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

export class ReadFileTool extends Tool {
  private static readonly DEFAULT_LINE_LIMIT = 200;
  private static readonly MAX_LINE_LIMIT = 2000;
  private static readonly MAX_OUTPUT_CHARS = 240000;
  private static readonly MAX_SCAN_BYTES = 16 * 1024 * 1024;
  private static readonly DEFAULT_LIMIT_NOTICE = '[READ_FILE_DEFAULT_LIMIT_APPLIED limit=200]';
  private static readonly BINARY_EXTENSIONS = new Set([
    // Images
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp', '.svg', '.ico',
    // Audio/Video
    '.mp3', '.mp4', '.wav', '.flac', '.avi', '.mkv', '.mov', '.webm',
    // Archives
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
    // Executables/Binaries
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
    // Documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    // Others
    '.db', '.sqlite', '.ttf', '.otf', '.woff', '.woff2', '.eot',
  ]);
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: 'read' | 'write') => PermissionCheckResult;
  private exemptDirs: string[];

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
    this.exemptDirs = options.exemptDirs?.map(d => path.resolve(d)) ?? [];
  }

  private isExempt(filePath: string): boolean {
    return this.exemptDirs.some((exemptDir) => isPathWithinDir(filePath, exemptDir));
  }

  private isBinaryFile(filePath: string): boolean {
    // 1. Check file extension
    const ext = path.extname(filePath).toLowerCase();
    if (ReadFileTool.BINARY_EXTENSIONS.has(ext)) {
      return true;
    }

    // 2. Check file content for null bytes
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
      // If more than 10% null bytes, consider it binary
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

  get name(): string {
    return 'read_file';
  }

  get description(): string {
    return 'Read a text file. By default this returns only the first 200 lines unless limit is provided, supports offset/limit windowing, and rejects binary files.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the text file to read. Can be absolute or relative to the workspace.',
        },
        offset: {
          type: 'number',
          description: 'Optional 0-based line offset. Skip this many lines before returning content.',
          default: 0,
        },
        limit: {
          type: 'number',
          description: 'Optional maximum number of lines to return after offset. If omitted, the default 200-line cap is applied.',
        },
        encoding: {
          type: 'string',
          description: 'Text encoding to use. Default is utf-8.',
          default: 'utf-8',
        },
      },
      required: ['path'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.resolvePath(args.path as string);
    const encoding = (args.encoding as BufferEncoding) ?? 'utf-8';
    const offset = this.readInteger(args.offset, 0);
    const explicitLimit = this.readInteger(args.limit, undefined);
    const defaultLimitApplied = explicitLimit === undefined;
    const requestedLimit = defaultLimitApplied ? ReadFileTool.DEFAULT_LINE_LIMIT : explicitLimit;
    const effectiveLimit =
      requestedLimit === undefined
        ? ReadFileTool.MAX_LINE_LIMIT
        : Math.min(ReadFileTool.MAX_LINE_LIMIT, Math.max(0, requestedLimit));

    // Check permission unless path is exempt
    if (this.checkPermission && !this.isExempt(filePath)) {
      const perm = this.checkPermission(filePath, 'read');
      if (!perm.allowed) {
        return errorResult(perm.reason ?? 'Permission denied');
      }
    }

    if (!fs.existsSync(filePath)) {
      return errorResult(`File not found: ${filePath}`);
    }

    // Check if file is binary
    if (this.isBinaryFile(filePath)) {
      return errorResult(
        `Cannot read binary file: ${filePath}. ` +
        `This appears to be a binary file (based on extension or content). ` +
        `ReadFileTool only supports text files.`
      );
    }

    try {
      const start = Math.max(0, offset ?? 0);
      const window = this.readLineWindow(
        filePath,
        encoding,
        start,
        effectiveLimit,
        ReadFileTool.MAX_OUTPUT_CHARS,
        ReadFileTool.MAX_SCAN_BYTES
      );
      const notices: string[] = [];
      if (defaultLimitApplied) {
        notices.push(ReadFileTool.DEFAULT_LIMIT_NOTICE);
      }
      if (!defaultLimitApplied && requestedLimit !== undefined && requestedLimit > ReadFileTool.MAX_LINE_LIMIT) {
        notices.push(`[READ_FILE_LIMIT_CAPPED requested=${requestedLimit} max=${ReadFileTool.MAX_LINE_LIMIT}]`);
      }
      if (window.outputTruncated) {
        notices.push(`[READ_FILE_OUTPUT_TRUNCATED max_chars=${ReadFileTool.MAX_OUTPUT_CHARS}]`);
      }
      if (window.scanLimitReached) {
        notices.push(`[READ_FILE_SCAN_LIMIT_REACHED max_scan_bytes=${ReadFileTool.MAX_SCAN_BYTES}]`);
      }
      return successResult([...notices, window.content].filter((part) => part.length > 0).join('\n'));
    } catch (err) {
      return errorResult(`Failed to read file: ${err}`);
    }
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }

  private readInteger(value: unknown, fallback: number | undefined): number | undefined {
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

  private readLineWindow(
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
}

export class WriteFileTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: 'read' | 'write') => PermissionCheckResult;

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
  }

  get name(): string {
    return 'write_file';
  }

  get description(): string {
    return 'Write content to a file. Creates the file if it does not exist, overwrites if it does.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to write. Can be absolute or relative to workspace.',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file.',
        },
        encoding: {
          type: 'string',
          description: 'The encoding to use. Default is utf-8.',
          default: 'utf-8',
        },
      },
      required: ['path', 'content'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.resolvePath(args.path as string);
    const content = args.content as string;
    const encoding = (args.encoding as BufferEncoding) ?? 'utf-8';

    if (this.checkPermission) {
      const perm = this.checkPermission(filePath, 'write');
      if (!perm.allowed) {
        return errorResult(perm.reason ?? 'Permission denied');
      }
    }

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, content, encoding);
      return successResult(`Successfully wrote ${content.length} characters to ${filePath}`);
    } catch (err) {
      return errorResult(`Failed to write file: ${err}`);
    }
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }
}

export class EditFileTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: 'read' | 'write') => PermissionCheckResult;

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
  }

  get name(): string {
    return 'edit_file';
  }

  get description(): string {
    return 'Edit a text file by replacing the first occurrence of oldStr with newStr. Use a unique or highly specific oldStr snippet; this tool does not replace every match.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the text file to edit.',
        },
        oldStr: {
          type: 'string',
          description: 'Exact text to replace. It must already exist in the file. Only the first matching occurrence is replaced, so provide a unique or highly specific snippet.',
        },
        newStr: {
          type: 'string',
          description: 'Replacement text for the first matched oldStr occurrence.',
        },
      },
      required: ['path', 'oldStr', 'newStr'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.resolvePath(args.path as string);
    const oldStr = args.oldStr as string;
    const newStr = args.newStr as string;

    if (this.checkPermission) {
      const perm = this.checkPermission(filePath, 'write');
      if (!perm.allowed) {
        return errorResult(perm.reason ?? 'Permission denied');
      }
    }

    if (!fs.existsSync(filePath)) {
      return errorResult(`File not found: ${filePath}`);
    }

    try {
      let content = fs.readFileSync(filePath, 'utf-8');

      if (!content.includes(oldStr)) {
        return errorResult(`Text not found in file: "${oldStr.substring(0, 100)}..."`);
      }

      const newContent = content.replace(oldStr, newStr);
      fs.writeFileSync(filePath, newContent, 'utf-8');

      return successResult(`Successfully edited ${filePath}`);
    } catch (err) {
      return errorResult(`Failed to edit file: ${err}`);
    }
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }
}

export class ListDirectoryTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: 'read' | 'write') => PermissionCheckResult;
  private exemptDirs: string[];

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
    this.exemptDirs = options.exemptDirs?.map(d => path.resolve(d)) ?? [];
  }

  private isExempt(filePath: string): boolean {
    return this.exemptDirs.some((exemptDir) => isPathWithinDir(filePath, exemptDir));
  }

  get name(): string {
    return 'list_directory';
  }

  get description(): string {
    return 'List the contents of a directory.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the directory to list. Default is workspace root.',
        },
      },
      required: [],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const dirPath = this.resolvePath((args.path as string) ?? '.');

    // Check permission unless path is exempt
    if (this.checkPermission && !this.isExempt(dirPath)) {
      const perm = this.checkPermission(dirPath, 'read');
      if (!perm.allowed) {
        return errorResult(perm.reason ?? 'Permission denied');
      }
    }

    if (!fs.existsSync(dirPath)) {
      return errorResult(`Directory not found: ${dirPath}`);
    }

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries.map((entry) => {
        const type = entry.isDirectory() ? 'DIR' : 'FILE';
        return `${type}\t${entry.name}`;
      });

      return successResult(items.join('\n') || '(empty directory)');
    } catch (err) {
      return errorResult(`Failed to list directory: ${err}`);
    }
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }
}

export class GlobTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: 'read' | 'write') => PermissionCheckResult;

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
  }

  get name(): string {
    return 'glob';
  }

  get description(): string {
    return 'Find relative paths matching a glob pattern under a base directory. Matches may include directories as well as files.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match against relative paths. Example: "**/*.ts".',
        },
        path: {
          type: 'string',
          description: 'Base directory to search from. Returned matches are relative to this directory. Default is workspace root.',
        },
      },
      required: ['pattern'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const basePath = this.resolvePath((args.path as string) ?? '.');

    if (this.checkPermission) {
      const perm = this.checkPermission(basePath, 'read');
      if (!perm.allowed) {
        return errorResult(perm.reason ?? 'Permission denied');
      }
    }

    try {
      const matches = this.globSearch(basePath, pattern);
      return successResult(matches.join('\n') || 'No matches found');
    } catch (err) {
      return errorResult(`Failed to search: ${err}`);
    }
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }

  private globSearch(basePath: string, pattern: string): string[] {
    const results: string[] = [];
    const regex = this.globToRegex(pattern);

    const search = (dir: string) => {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(basePath, fullPath);

        if (entry.isDirectory()) {
          search(fullPath);
        }

        if (regex.test(relativePath.replace(/\\/g, '/'))) {
          results.push(relativePath);
        }
      }
    };

    search(basePath);
    return results;
  }

  private globToRegex(pattern: string): RegExp {
    let regex = pattern
      .replace(/\*\*/g, '<<DOUBLESTAR>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<DOUBLESTAR>>/g, '.*')
      .replace(/\?/g, '[^/]')
      .replace(/\./g, '\\.');

    return new RegExp(`^${regex}$`, 'i');
  }
}

export class GrepTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: 'read' | 'write') => PermissionCheckResult;

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
  }

  get name(): string {
    return 'grep';
  }

  get description(): string {
    return 'Search text content across files and return matching lines with file path and line number.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search pattern. Interpreted as JavaScript regular expression.',
        },
        path: {
          type: 'string',
          description: 'Base directory to search from. Default is workspace root.',
        },
        include: {
          type: ['array', 'string'],
          description: 'Optional glob-like include filters (example: "*.ts" or ["*.ts","*.md"]).',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of matched lines to return. Default 200.',
          default: 200,
        },
      },
      required: ['pattern'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const patternRaw = String(args.pattern ?? '').trim();
    if (!patternRaw) {
      return errorResult('pattern is required');
    }
    let regex: RegExp;
    try {
      regex = new RegExp(patternRaw, 'i');
    } catch (err) {
      return errorResult(`Invalid regex pattern: ${err}`);
    }
    const basePath = this.resolvePath((args.path as string) ?? '.');
    if (this.checkPermission) {
      const perm = this.checkPermission(basePath, 'read');
      if (!perm.allowed) {
        return errorResult(perm.reason ?? 'Permission denied');
      }
    }
    const includePatterns = this.normalizeIncludePatterns(args.include);
    const maxResults = this.readInteger(args.max_results, 200);
    const rows: string[] = [];
    const files = this.collectFiles(basePath);

    for (const filePath of files) {
      if (rows.length >= maxResults) {
        break;
      }
      const relativePath = path.relative(basePath, filePath).replace(/\\/g, '/');
      if (!this.matchesInclude(relativePath, includePatterns)) {
        continue;
      }
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.replace(/\r\n/g, '\n').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i])) {
          rows.push(`${relativePath}:${i + 1}:${lines[i]}`);
          if (rows.length >= maxResults) {
            break;
          }
        }
      }
    }

    return successResult(rows.join('\n') || 'No matches found');
  }

  private normalizeIncludePatterns(input: unknown): string[] {
    if (Array.isArray(input)) {
      return input.map((item) => String(item).trim()).filter((item) => item.length > 0);
    }
    if (typeof input === 'string' && input.trim().length > 0) {
      return input
        .split(/[,\n\r|]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    return [];
  }

  private matchesInclude(relativePath: string, includePatterns: string[]): boolean {
    if (includePatterns.length === 0) {
      return true;
    }
    return includePatterns.some((pattern) => this.globToRegex(pattern).test(relativePath));
  }

  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '<<DOUBLESTAR>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<DOUBLESTAR>>/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`^${escaped}$`, 'i');
  }

  private collectFiles(basePath: string): string[] {
    const files: string[] = [];
    const stack = [basePath];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || !fs.existsSync(current)) {
        continue;
      }
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.git' || entry.name === 'node_modules') {
            continue;
          }
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }
    return files;
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }

  private readInteger(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(1, Math.floor(value));
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.max(1, Math.floor(parsed));
      }
    }
    return fallback;
  }
}

export function createFileTools(options: FileToolsOptions): Tool[] {
  return [
    new ReadFileTool(options),
    new WriteFileTool(options),
    new EditFileTool(options),
    new ListDirectoryTool(options),
    new GlobTool(options),
    new GrepTool(options),
  ];
}
