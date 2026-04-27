import type { SkillCatalogEntry } from '../skills/SkillLoader.js';
import { SkillDraftStore, type SkillDraftRecord, type SkillDraftTarget } from '../skills/SkillDraftStore.js';
import type { SkillLoader } from '../skills/SkillLoader.js';
import { Tool, errorResult, successResult } from './Tool.js';

export interface SkillToolsOptions {
  skillLoader: SkillLoader;
  skillDraftStore: SkillDraftStore;
  resolveWorkspaceDir: () => string | undefined;
  resolveSessionId: () => string | undefined;
  resolveToolsetName: () => string | undefined;
  globalSkillsDir?: string;
  writeMode: 'confirm' | 'auto';
  approveSkillDraft?: (id: string) => SkillDraftRecord | null;
  rejectSkillDraft?: (id: string, reviewNote?: string) => SkillDraftRecord | null;
}

function normalizeTarget(value: unknown, fallback: SkillDraftTarget): SkillDraftTarget {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'workspace' || normalized === 'global') {
    return normalized;
  }
  return fallback;
}

class SkillsListTool extends Tool {
  constructor(
    private readonly skillLoader: SkillLoader,
    private readonly resolveWorkspaceDir: () => string | undefined,
    private readonly resolveToolsetName: () => string | undefined
  ) {
    super();
  }

  get name(): string {
    return 'skills_list';
  }

  get description(): string {
    return 'List approved skills available to the current workspace and toolset so you can check for relevant guidance before building a non-trivial, domain-specific, or repeated workflow from scratch.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional substring filter by skill name, description, or tags.',
        },
      },
    };
  }

  async execute(args: Record<string, unknown>) {
    const query = String(args.query ?? '').trim().toLowerCase();
    let items = this.skillLoader.getSkillCatalog({
      workspaceDir: this.resolveWorkspaceDir(),
      toolsetName: this.resolveToolsetName(),
    });
    if (query) {
      items = items.filter((entry) => {
        const haystack = `${entry.name}\n${entry.description}\n${entry.tags.join(' ')}`.toLowerCase();
        return haystack.includes(query);
      });
    }
    const payload = items.map((entry) => ({
      name: entry.name,
      description: entry.description,
      source: entry.source,
      path: entry.path,
      tags: entry.tags,
      triggers: entry.triggers,
      toolsets: entry.toolsets,
      platforms: entry.platforms,
      reviewStatus: entry.reviewStatus,
    }));
    return successResult(JSON.stringify({ ok: true, items: payload }, null, 2));
  }
}

class SkillsViewTool extends Tool {
  constructor(
    private readonly skillLoader: SkillLoader,
    private readonly resolveWorkspaceDir: () => string | undefined,
    private readonly resolveToolsetName: () => string | undefined
  ) {
    super();
  }

  get name(): string {
    return 'skills_view';
  }

  get description(): string {
    return "Read the full content of a candidate skill before relying on it. When a skill looks relevant, load it first and prefer its verified procedure over improvising unless the user's request, active toolset, or platform constraints require a different path.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name to load.',
        },
      },
      required: ['name'],
    };
  }

  async execute(args: Record<string, unknown>) {
    const name = String(args.name ?? '').trim();
    if (!name) {
      return errorResult('name is required');
    }
    const skill = this.skillLoader.getSkillByName(name, {
      workspaceDir: this.resolveWorkspaceDir(),
      toolsetName: this.resolveToolsetName(),
    });
    if (!skill) {
      return errorResult(`skill not found: ${name}`);
    }
    return successResult(
      JSON.stringify(
        {
          ok: true,
          item: {
            name: skill.name,
            description: skill.description,
            source: skill.source,
            path: skill.path,
            tags: skill.tags,
            triggers: skill.triggers,
            toolsets: skill.toolsets,
            platforms: skill.platforms,
            reviewStatus: skill.reviewStatus,
            content: skill.content,
          },
        },
        null,
        2
      )
    );
  }
}

export class SkillManageTool extends Tool {
  private readonly skillLoader: SkillLoader;
  private readonly skillDraftStore: SkillDraftStore;
  private readonly resolveWorkspaceDir: () => string | undefined;
  private readonly resolveSessionId: () => string | undefined;
  private readonly globalSkillsDir?: string;
  private readonly writeMode: 'confirm' | 'auto';
  private readonly approveSkillDraft?: SkillToolsOptions['approveSkillDraft'];
  private readonly rejectSkillDraft?: SkillToolsOptions['rejectSkillDraft'];

  constructor(options: SkillToolsOptions) {
    super();
    this.skillLoader = options.skillLoader;
    this.skillDraftStore = options.skillDraftStore;
    this.resolveWorkspaceDir = options.resolveWorkspaceDir;
    this.resolveSessionId = options.resolveSessionId;
    this.globalSkillsDir = options.globalSkillsDir;
    this.writeMode = options.writeMode;
    this.approveSkillDraft = options.approveSkillDraft;
    this.rejectSkillDraft = options.rejectSkillDraft;
  }

  get name(): string {
    return 'skill_manage';
  }

  get description(): string {
    return 'Submit create/update skill drafts for review and approval when a verified, reusable workflow should be captured or revised after user correction or new evidence. Use this for non-trivial methods worth reusing; skip simple one-off tasks, temporary workarounds, raw facts, and one-time outputs. This tool only manages draft submission and review workflow; it does not promise immediate activation or richer lifecycle edit verbs.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'list_pending', 'approve', 'reject'],
        },
        name: {
          type: 'string',
          description: 'Skill name for create or update.',
        },
        description: {
          type: 'string',
          description: 'Skill description for create or update.',
        },
        content: {
          type: 'string',
          description: 'Full skill markdown or body content.',
        },
        id: {
          type: 'string',
          description: 'Pending draft id for approve or reject.',
        },
        target: {
          type: 'string',
          enum: ['workspace', 'global'],
          description: 'Draft target location. Defaults to workspace when available.',
        },
        review_note: {
          type: 'string',
          description: 'Optional rejection note.',
        },
      },
      required: ['action'],
    };
  }

  async execute(args: Record<string, unknown>) {
    const action = String(args.action ?? '').trim().toLowerCase();
    const workspaceDir = this.resolveWorkspaceDir();
    const sessionId = this.resolveSessionId();
    const fallbackTarget: SkillDraftTarget = workspaceDir ? 'workspace' : 'global';

    switch (action) {
      case 'create':
      case 'update': {
        const name = String(args.name ?? '').trim();
        const description = String(args.description ?? '').trim();
        const content = String(args.content ?? '').trim();
        if (!name || !description || !content) {
          return errorResult('name, description, and content are required');
        }
        const target = normalizeTarget(args.target, fallbackTarget);
        if (this.writeMode === 'auto') {
          const draft = this.skillDraftStore.createDraft({
            name,
            description,
            content,
            target,
            workspaceDir,
            sourceSessionId: sessionId,
            globalSkillsDir: this.globalSkillsDir,
          });
          const approved = this.approveSkillDraft?.(draft.id) ?? this.skillDraftStore.approveDraft(draft.id);
          if (!approved) {
            return errorResult('failed to auto-approve skill draft');
          }
          if (!this.approveSkillDraft) {
            this.skillLoader.reload();
          }
          return successResult(JSON.stringify({ ok: true, action, mode: 'written', record: approved }, null, 2));
        }
        const draft = this.skillDraftStore.createDraft({
          name,
          description,
          content,
          target,
          workspaceDir,
          sourceSessionId: sessionId,
          globalSkillsDir: this.globalSkillsDir,
        });
        return successResult(JSON.stringify({ ok: true, action, mode: 'pending', record: draft }, null, 2));
      }
      case 'list_pending':
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              items: this.skillDraftStore.listPending({ sessionId, workspaceDir }),
            },
            null,
            2
          )
        );
      case 'approve': {
        const id = String(args.id ?? '').trim();
        if (!id) {
          return errorResult('id is required for approve');
        }
        const record = this.approveSkillDraft?.(id) ?? this.skillDraftStore.approveDraft(id);
        if (!record) {
          return errorResult(`pending skill draft not found: ${id}`);
        }
        if (!this.approveSkillDraft) {
          this.skillLoader.reload();
        }
        return successResult(JSON.stringify({ ok: true, action, record }, null, 2));
      }
      case 'reject': {
        const id = String(args.id ?? '').trim();
        if (!id) {
          return errorResult('id is required for reject');
        }
        const record =
          this.rejectSkillDraft?.(id, String(args.review_note ?? '').trim() || undefined) ??
          this.skillDraftStore.rejectDraft(id, String(args.review_note ?? '').trim() || undefined);
        if (!record) {
          return errorResult(`pending skill draft not found: ${id}`);
        }
        return successResult(JSON.stringify({ ok: true, action, record }, null, 2));
      }
      default:
        return errorResult(`unknown action: ${action}`);
    }
  }
}

export function createSkillTools(options: SkillToolsOptions): [SkillsListTool, SkillsViewTool, SkillManageTool] {
  return [
    new SkillsListTool(options.skillLoader, options.resolveWorkspaceDir, options.resolveToolsetName),
    new SkillsViewTool(options.skillLoader, options.resolveWorkspaceDir, options.resolveToolsetName),
    new SkillManageTool(options),
  ];
}

export type { SkillDraftRecord, SkillCatalogEntry };
