import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorResult, successResult } from './Tool.js';
import { accessDeniedResult, ToolAccessBase, type ToolAccessBaseOptions } from './ToolAccessBase.js';
import type { ToolResult } from '../types.js';

export interface SendFileToUserLink {
  href: string;
  displayPath: string;
  filename: string;
  size: number;
  expiresAt: string;
}

export interface SendFileToUserLinkIssuer {
  createDownloadLink(input: {
    absolutePath: string;
    displayPath: string;
    filename: string;
    size: number;
  }): SendFileToUserLink;
}

export interface SendFileToUserToolOptions extends ToolAccessBaseOptions {
  linkIssuer: SendFileToUserLinkIssuer;
}

function getStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function displayPathFor(filePath: string): string {
  return path.normalize(filePath);
}

export class SendFileToUserTool extends ToolAccessBase {
  private readonly linkIssuer: SendFileToUserLinkIssuer;

  constructor(options: SendFileToUserToolOptions) {
    super(options);
    this.linkIssuer = options.linkIssuer;
  }

  get name(): string {
    return 'send_file_to_user';
  }

  get description(): string {
    return [
      'Create a direct download link for a local file so the remote user can download it from the chat UI.',
      'Use this when the user asks you to send, provide, attach, or share a generated file or a local file.',
      'Pass the local file path in `path`; the result JSON contains `href`, which is the download URL to use as the link target.',
      'The visible link text should use `displayPath`, which includes the path and filename.',
    ].join(' ');
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Local file path to expose as a user-downloadable link. Can be absolute or relative to the workspace.',
        },
        filename: {
          type: 'string',
          description: 'Optional download filename. If omitted, the basename of path is used.',
        },
      },
      required: ['path'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const rawPath = getStringArg(args, 'path');
    if (!rawPath) {
      return errorResult('path is required');
    }

    const filePath = this.resolveWorkspacePath(rawPath);
    const accessDenied = accessDeniedResult(this.checkAccessUnlessExempt(filePath, 'read'));
    if (accessDenied) {
      return accessDenied;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return errorResult(`File not found: ${filePath}`);
    }
    if (!stat.isFile()) {
      return errorResult(`Path is not a file: ${filePath}`);
    }
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
    } catch {
      return errorResult(`File is not readable: ${filePath}`);
    }

    const filename = path.basename(getStringArg(args, 'filename') || filePath) || 'download';
    try {
      const link = this.linkIssuer.createDownloadLink({
        absolutePath: filePath,
        displayPath: displayPathFor(filePath),
        filename,
        size: stat.size,
      });
      return successResult(JSON.stringify({ success: true, ...link }));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
}

export function createSendFileToUserTool(options: SendFileToUserToolOptions): SendFileToUserTool {
  return new SendFileToUserTool(options);
}
