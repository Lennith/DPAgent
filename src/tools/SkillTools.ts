import type { SkillCatalogEntry } from '../skills/SkillLoader.js';
import { SkillWriteStore, type SkillWriteRecord, type SkillWriteTarget } from '../skills/SkillWriteStore.js';
import type { SkillLoader } from '../skills/SkillLoader.js';
import { Tool, errorResult, successResult } from './Tool.js';

export interface SkillToolsOptions {
  skillLoader: SkillLoader;
  writeSkill: (input: Parameters<SkillWriteStore['writeSkill']>[0]) => SkillWriteRecord;
  resolveWorkspaceDir: () => string | undefined;
  resolveAgentSkillDir?: () => string | undefined;
  resolveIncludeGlobalSkills?: () => boolean | undefined;
  resolveSessionId: () => string | undefined;
  resolveToolsetName: () => string | undefined;
  globalSkillsDir?: string;
}

function normalizeTarget(value: unknown, fallback: SkillWriteTarget): SkillWriteTarget {
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
    private readonly resolveAgentSkillDir: () => string | undefined,
    private readonly resolveIncludeGlobalSkills: () => boolean | undefined,
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
      agentSkillDir: this.resolveAgentSkillDir(),
      includeGlobalSkills: this.resolveIncludeGlobalSkills(),
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
    private readonly resolveAgentSkillDir: () => string | undefined,
    private readonly resolveIncludeGlobalSkills: () => boolean | undefined,
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
      agentSkillDir: this.resolveAgentSkillDir(),
      includeGlobalSkills: this.resolveIncludeGlobalSkills(),
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
  private readonly writeSkill: (input: Parameters<SkillWriteStore['writeSkill']>[0]) => SkillWriteRecord;
  private readonly resolveWorkspaceDir: () => string | undefined;
  private readonly resolveSessionId: () => string | undefined;
  private readonly globalSkillsDir?: string;

  constructor(options: SkillToolsOptions) {
    super();
    this.writeSkill = options.writeSkill;
    this.resolveWorkspaceDir = options.resolveWorkspaceDir;
    this.resolveSessionId = options.resolveSessionId;
    this.globalSkillsDir = options.globalSkillsDir;
  }

  get name(): string {
    return 'skill_manage';
  }

  get description(): string {
    return [
      'Create or update an approved skill immediately when a verified, reusable workflow should be captured or revised after user correction or new evidence.',
      'Workspace skills are project-local; agent skills are bundled with the selected agent profile and are read as approved references; global skills are shared runtime skills; native skills are package-bundled read-only baselines.',
      'Use target="workspace" for project-local skills and target="global" only for reusable skills that should become shared runtime skills.',
      'This tool does not edit selected-agent bundled skills or native skills directly.',
      'Use this for non-trivial methods worth reusing; skip simple one-off tasks, temporary workarounds, raw facts, and one-time outputs.',
      'This tool applies create/update writes directly; broader lifecycle actions such as removal, rollback, pack publication, and governance review are handled outside this runtime tool.',
    ].join(' ');
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update'],
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
        target: {
          type: 'string',
          enum: ['workspace', 'global'],
          description: 'Write target location. workspace means project-local; global means shared runtime skills. Defaults to workspace when available. Agent-bundled and native skills are not writable targets here.',
        },
      },
      required: ['action'],
    };
  }

  async execute(args: Record<string, unknown>) {
    const action = String(args.action ?? '').trim().toLowerCase();
    const workspaceDir = this.resolveWorkspaceDir();
    const sessionId = this.resolveSessionId();
    const fallbackTarget: SkillWriteTarget = workspaceDir ? 'workspace' : 'global';

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
        const record = this.writeSkill({
          name,
          description,
          content,
          target,
          workspaceDir,
          sourceSessionId: sessionId,
          globalSkillsDir: this.globalSkillsDir,
        });
        return successResult(
          JSON.stringify(
            { ok: true, action: record.action, requestedAction: action, mode: 'applied', record },
            null,
            2
          )
        );
      }
      default:
        return errorResult(`unknown action: ${action}`);
    }
  }
}

export function createSkillTools(options: SkillToolsOptions): [SkillsListTool, SkillsViewTool, SkillManageTool] {
  const resolveAgentSkillDir = options.resolveAgentSkillDir ?? (() => undefined);
  const resolveIncludeGlobalSkills = options.resolveIncludeGlobalSkills ?? (() => undefined);
  return [
    new SkillsListTool(
      options.skillLoader,
      options.resolveWorkspaceDir,
      resolveAgentSkillDir,
      resolveIncludeGlobalSkills,
      options.resolveToolsetName
    ),
    new SkillsViewTool(
      options.skillLoader,
      options.resolveWorkspaceDir,
      resolveAgentSkillDir,
      resolveIncludeGlobalSkills,
      options.resolveToolsetName
    ),
    new SkillManageTool(options),
  ];
}

export type { SkillWriteRecord, SkillCatalogEntry };
