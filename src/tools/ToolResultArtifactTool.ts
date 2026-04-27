import { Tool } from './Tool.js';
import type { ContextManager } from '../context/index.js';
import type { ContextRef, ToolResult } from '../types.js';

export interface ToolResultArtifactToolOptions {
  contextManager: ContextManager;
  resolveActiveContext: () => ContextRef;
}

export class ToolResultArtifactTool extends Tool {
  private readonly contextManager: ContextManager;
  private readonly resolveActiveContext: () => ContextRef;

  constructor(options: ToolResultArtifactToolOptions) {
    super();
    this.contextManager = options.contextManager;
    this.resolveActiveContext = options.resolveActiveContext;
  }

  get name(): string {
    return 'read_tool_result';
  }

  get description(): string {
    return 'Read a bounded line window from a stored tool result artifact in the current session.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        artifact_id: {
          type: 'string',
          description: 'The artifact_id shown in a TOOL_RESULT_STORED message.',
        },
        offset: {
          type: 'number',
          description: 'Optional 0-based line offset.',
          default: 0,
        },
        limit: {
          type: 'number',
          description: 'Optional maximum lines to return. Default 200, maximum 400.',
          default: 200,
        },
      },
      required: ['artifact_id'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    return this.contextManager.readToolResultArtifact(this.resolveActiveContext(), {
      artifactId: String(args.artifact_id ?? ''),
      offset: this.readNumber(args.offset),
      limit: this.readNumber(args.limit),
    });
  }

  private readNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.floor(parsed));
      }
    }
    return undefined;
  }
}

export function createToolResultArtifactTool(options: ToolResultArtifactToolOptions): ToolResultArtifactTool {
  return new ToolResultArtifactTool(options);
}
