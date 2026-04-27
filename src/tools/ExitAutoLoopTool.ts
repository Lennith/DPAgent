import type { ToolResult } from '../types.js';
import { Tool, errorResult, successResult } from './Tool.js';

export interface ExitAutoLoopToolOptions {
  isInAutoLoop: () => boolean;
  requestAutoLoopExit: (reason?: string) => { accepted: boolean; message?: string };
}

export class ExitAutoLoopTool extends Tool {
  private readonly options: ExitAutoLoopToolOptions;

  constructor(options: ExitAutoLoopToolOptions) {
    super();
    this.options = options;
  }

  get name(): string {
    return 'exit_auto_loop';
  }

  get description(): string {
    return 'Request exit from the current auto-loop. Only valid when this session is actively running in auto-loop mode; this queues loop shutdown instead of force-stopping execution immediately.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional short reason for requesting loop exit.',
        },
      },
      additionalProperties: false,
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.options.isInAutoLoop()) {
      return errorResult('exit_auto_loop can only be called during auto-loop');
    }

    const reasonRaw = String(args.reason ?? '').trim();
    const reason = reasonRaw.length > 0 ? reasonRaw.slice(0, 500) : undefined;
    const requested = this.options.requestAutoLoopExit(reason);
    if (!requested.accepted) {
      return errorResult(requested.message ?? 'failed to request auto-loop exit');
    }

    return successResult(requested.message ?? 'auto-loop exit requested');
  }
}

export function createExitAutoLoopTool(options: ExitAutoLoopToolOptions): ExitAutoLoopTool {
  return new ExitAutoLoopTool(options);
}
