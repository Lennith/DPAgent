import type {
  MemoryEntry,
  MemoryScope,
  MemoryStore,
} from '../memory/index.js';
import { Tool, errorResult, successResult } from './Tool.js';

export interface MemoryToolOptions {
  memoryStore: MemoryStore;
  resolveWorkspaceDir: () => string | undefined;
  resolveSessionId: () => string | undefined;
  mutateMemory: (input: {
    action: 'add' | 'replace' | 'remove';
    id?: string;
    scope?: MemoryScope;
    title?: string;
    content?: string;
    workspaceDir?: string;
    sessionId?: string;
    reason?: string;
    expiresAt?: string;
  }) => Promise<{ action: 'add' | 'replace' | 'remove'; entry?: MemoryEntry | null; removed?: boolean }>;
}

function normalizeScope(value: unknown, fallback: MemoryScope): MemoryScope {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'workspace' || normalized === 'user') {
    return normalized;
  }
  return fallback;
}

export class MemoryTool extends Tool {
  private readonly memoryStore: MemoryStore;
  private readonly resolveWorkspaceDir: () => string | undefined;
  private readonly resolveSessionId: () => string | undefined;
  private readonly mutateMemory: MemoryToolOptions['mutateMemory'];

  constructor(options: MemoryToolOptions) {
    super();
    this.memoryStore = options.memoryStore;
    this.resolveWorkspaceDir = options.resolveWorkspaceDir;
    this.resolveSessionId = options.resolveSessionId;
    this.mutateMemory = options.mutateMemory;
  }

  get name(): string {
    return 'memory_manage';
  }

  get description(): string {
    return 'Manage durable workspace/user memory. Use add only for stable preferences, workspace conventions, validated commands, or long-lived facts worth carrying across sessions; do not store raw logs, temporary workarounds, one-off outputs, or details already captured in current structured context. Inspect current structured context via context_manage, and use session_search separately for raw prior-session transcript recall. scope selects the write target for add/replace/remove; list/read/history currently inspect combined workspace+user durable memory when a workspace is active, so scope is not a strict inspection filter.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'add', 'replace', 'remove', 'history'],
          description: 'Action to perform. add/replace/remove mutate memory; list/read/history inspect existing durable memory.',
        },
        scope: {
          type: 'string',
          enum: ['workspace', 'user'],
          description: 'Write target for add/replace/remove. Defaults to workspace when a workspace directory is active, otherwise user. list/read/history do not currently use this as a strict filter.',
        },
        id: {
          type: 'string',
          description: 'Memory entry id for read, replace, remove, or history lookup.',
        },
        title: {
          type: 'string',
          description: 'Memory title for add or replace. history can also use title to look up lineage when id is omitted.',
        },
        content: {
          type: 'string',
          description: 'Memory content for add or replace.',
        },
        reason: {
          type: 'string',
          description: 'Optional rationale for why this memory should exist.',
        },
        expires_at: {
          type: 'string',
          description: 'Optional ISO timestamp for expiry.',
        },
      },
      required: ['action'],
    };
  }

  async execute(args: Record<string, unknown>) {
    const action = String(args.action ?? '').trim().toLowerCase();
    const workspaceDir = this.resolveWorkspaceDir();
    const sessionId = this.resolveSessionId();
    const defaultScope: MemoryScope = workspaceDir ? 'workspace' : 'user';
    const scope = normalizeScope(args.scope, defaultScope);
    switch (action) {
      case 'list':
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              scope,
              items: this.memoryStore.listEntries({ workspaceDir, includeUser: true }),
            },
            null,
            2
          )
        );
      case 'read': {
        const id = String(args.id ?? '').trim();
        if (!id) {
          return errorResult('id is required for read');
        }
        const entry = this.memoryStore.readEntry(id, { workspaceDir, includeUser: true });
        if (!entry) {
          return errorResult(`memory not found: ${id}`);
        }
        return successResult(JSON.stringify({ ok: true, action, entry }, null, 2));
      }
      case 'add': {
        const title = String(args.title ?? '').trim();
        const content = String(args.content ?? '').trim();
        if (!title || !content) {
          return errorResult('title and content are required for add');
        }
        const result = await this.mutateMemory({
          action: 'add',
          scope,
          title,
          content,
          workspaceDir,
          sessionId,
          reason: String(args.reason ?? '').trim() || undefined,
          expiresAt: String(args.expires_at ?? '').trim() || undefined,
        });
        return successResult(JSON.stringify({ ok: true, action, result }, null, 2));
      }
      case 'replace': {
        const id = String(args.id ?? '').trim();
        const content = String(args.content ?? '').trim();
        if (!id || !content) {
          return errorResult('id and content are required for replace');
        }
        const result = await this.mutateMemory({
          action: 'replace',
          id,
          scope,
          title: String(args.title ?? '').trim() || undefined,
          content,
          workspaceDir,
          sessionId,
          reason: String(args.reason ?? '').trim() || undefined,
          expiresAt: String(args.expires_at ?? '').trim() || undefined,
        });
        if (!result.entry) {
          return errorResult(`memory not found: ${id}`);
        }
        return successResult(JSON.stringify({ ok: true, action, result }, null, 2));
      }
      case 'remove': {
        const id = String(args.id ?? '').trim();
        if (!id) {
          return errorResult('id is required for remove');
        }
        const result = await this.mutateMemory({
          action: 'remove',
          id,
          workspaceDir,
          sessionId,
        });
        return successResult(JSON.stringify({ ok: true, action, result }, null, 2));
      }
      case 'history': {
        const id = String(args.id ?? '').trim();
        const title = String(args.title ?? '').trim();
        if (!id && !title) {
          return errorResult('id or title is required for history');
        }
        const items = this.memoryStore.getHistory({
          id: id || undefined,
          title: title || undefined,
          workspaceDir,
          includeUser: true,
        });
        return successResult(JSON.stringify({ ok: true, action, items }, null, 2));
      }
      default:
        return errorResult(`unknown action: ${action}`);
    }
  }
}

export function createMemoryTool(options: MemoryToolOptions): MemoryTool {
  return new MemoryTool(options);
}
