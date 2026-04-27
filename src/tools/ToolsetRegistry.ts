import type { Tool } from './Tool.js';
import { resolveToolCapabilityFamilyForTool } from './tool-registration.js';

export interface ToolsetDefinition {
  name: string;
  description: string;
  capabilities: string[];
  allowUnknownTools?: boolean;
  hidden?: boolean;
}

export interface ResolvedToolset {
  definition: ToolsetDefinition;
  toolNames: string[];
  capabilities: string[];
}

const DEFAULT_TOOLSETS: ToolsetDefinition[] = [
  {
    name: 'full-access',
    description: 'Hidden internal default toolset that allows all built-in capabilities plus unknown MCP tools.',
    capabilities: [
      'file_read',
      'tool_result_read',
      'file_write',
      'file_edit',
      'file_glob',
      'file_grep',
      'web_search',
      'web_fetch',
      'shell_exec',
      'note',
      'context_manage',
      'subagent_manage',
      'skills_catalog',
      'skill_manage',
      'memory_manage',
      'session_search',
      'todo_manage',
      'plan_update',
      'plan_request_user_input',
      'plan_finalize',
      'auto_loop_exit',
    ],
    allowUnknownTools: true,
    hidden: true,
  },
  {
    name: 'windows-dev',
    description: 'Default Windows development toolset with file, shell, memory, skill, and delegation support.',
    capabilities: [
      'file_read',
      'tool_result_read',
      'file_write',
      'file_edit',
      'file_glob',
      'file_grep',
      'shell_exec',
      'note',
      'context_manage',
      'subagent_manage',
      'skills_catalog',
      'skill_manage',
      'memory_manage',
      'session_search',
      'todo_manage',
      'plan_update',
      'plan_request_user_input',
      'plan_finalize',
      'auto_loop_exit',
    ],
    allowUnknownTools: false,
  },
  {
    name: 'research',
    description: 'Windows development toolset plus web search and fetch.',
    capabilities: [
      'file_read',
      'tool_result_read',
      'file_write',
      'file_edit',
      'file_glob',
      'file_grep',
      'shell_exec',
      'note',
      'context_manage',
      'subagent_manage',
      'skills_catalog',
      'skill_manage',
      'memory_manage',
      'session_search',
      'todo_manage',
      'web_search',
      'web_fetch',
      'plan_update',
      'plan_request_user_input',
      'plan_finalize',
      'auto_loop_exit',
    ],
    allowUnknownTools: false,
  },
  {
    name: 'windows-safe',
    description: 'Read-heavy Windows toolset with context, memory, skills, and structured user input; no shell or write tools.',
    capabilities: [
      'file_read',
      'tool_result_read',
      'file_glob',
      'file_grep',
      'note',
      'context_manage',
      'skills_catalog',
      'memory_manage',
      'session_search',
      'todo_manage',
      'plan_update',
      'plan_request_user_input',
      'plan_finalize',
      'auto_loop_exit',
    ],
    allowUnknownTools: false,
  },
];

export class ToolsetRegistry {
  private readonly definitions = new Map<string, ToolsetDefinition>();
  private readonly defaultToolsetName: string;

  constructor(defaultToolsetName = 'full-access', definitions: ToolsetDefinition[] = DEFAULT_TOOLSETS) {
    for (const definition of definitions) {
      this.definitions.set(definition.name.trim().toLowerCase(), {
        ...definition,
        name: definition.name.trim(),
        capabilities: Array.from(
          new Set(definition.capabilities.map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0))
        ),
      });
    }
    this.defaultToolsetName = defaultToolsetName.trim().toLowerCase() || 'full-access';
  }

  list(): ToolsetDefinition[] {
    return Array.from(this.definitions.values())
      .filter((definition) => definition.hidden !== true)
      .map((definition) => ({ ...definition }));
  }

  get(name: string | undefined | null): ToolsetDefinition {
    const normalized = String(name ?? '').trim().toLowerCase();
    const matched = this.definitions.get(normalized);
    if (matched) {
      return { ...matched, capabilities: [...matched.capabilities] };
    }
    const fallback = this.definitions.get(this.defaultToolsetName) ?? DEFAULT_TOOLSETS[0];
    return { ...fallback, capabilities: [...fallback.capabilities] };
  }

  getDefaultName(): string {
    return this.get(this.defaultToolsetName).name;
  }

  filterTools(toolsetName: string | undefined | null, tools: Tool[]): ResolvedToolset {
    const definition = this.get(toolsetName);
    const allowedCapabilities = new Set(definition.capabilities.map((item) => item.toLowerCase()));
    const selectedTools: Tool[] = [];
    for (const tool of tools) {
      const capability = resolveToolCapabilityFamilyForTool(tool);
      if (allowedCapabilities.has(capability)) {
        selectedTools.push(tool);
        continue;
      }
      if (capability.startsWith('tool:') && definition.allowUnknownTools) {
        selectedTools.push(tool);
      }
    }
    return {
      definition,
      toolNames: selectedTools.map((tool) => tool.name),
      capabilities: [...allowedCapabilities],
    };
  }

  allowsTool(toolsetName: string | undefined | null, tool: Tool): boolean {
    const definition = this.get(toolsetName);
    const capability = resolveToolCapabilityFamilyForTool(tool);
    if (definition.capabilities.includes(capability)) {
      return true;
    }
    return definition.allowUnknownTools === true && capability.startsWith('tool:');
  }
}

export function createToolsetRegistry(defaultToolsetName?: string): ToolsetRegistry {
  return new ToolsetRegistry(defaultToolsetName);
}
