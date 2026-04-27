import type { SessionSearchIndex } from '../memory/index.js';
import { Tool, errorResult, successResult } from './Tool.js';

export interface SessionSearchToolOptions {
  sessionSearchIndex: SessionSearchIndex;
  resolveWorkspaceDir: () => string | undefined;
}

export class SessionSearchTool extends Tool {
  private readonly sessionSearchIndex: SessionSearchIndex;
  private readonly resolveWorkspaceDir: () => string | undefined;

  constructor(options: SessionSearchToolOptions) {
    super();
    this.sessionSearchIndex = options.sessionSearchIndex;
    this.resolveWorkspaceDir = options.resolveWorkspaceDir;
  }

  get name(): string {
    return 'session_search';
  }

  get description(): string {
    return 'Search raw indexed session transcript excerpts to recall prior task context before repeating work or asking for already-known details. Use context_manage for current structured context state and memory_manage separately for durable memory; session_search is only for prior session transcript recall.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language query describing what prior context to recall.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return. Default 5.',
          default: 5,
        },
      },
      required: ['query'],
    };
  }

  async execute(args: Record<string, unknown>) {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return errorResult('query is required');
    }
    const maxResultsRaw = Number(args.max_results ?? 5);
    const maxResults = Number.isFinite(maxResultsRaw) ? Math.max(1, Math.min(20, Math.floor(maxResultsRaw))) : 5;
    const hits = this.sessionSearchIndex.search(query, {
      workspaceDir: this.resolveWorkspaceDir(),
      maxResults,
    });
    return successResult(
      JSON.stringify(
        {
          ok: true,
          query,
          maxResults,
          hits,
        },
        null,
        2
      )
    );
  }
}

export function createSessionSearchTool(options: SessionSearchToolOptions): SessionSearchTool {
  return new SessionSearchTool(options);
}
