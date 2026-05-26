import type { Tool } from './Tool.js';
import { ToolRegistry } from './ToolRegistry.js';

export interface ToolsetDefinition {
  name: string;
  description: string;
  capabilities: string[];
  allowUnknownTools?: boolean;
  hidden?: boolean;
}

export const SUBAGENT_PROTECTED_TOOL_NAMES = new Set(['context_manage', 'subagent_manage', 'todo', 'schedule_task']);

export const DEFAULT_TOOLSETS: ToolsetDefinition[] = [
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
      'file_download',
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
      'automation_manage',
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
      'file_download',
      'shell_exec',
      'note',
      'context_manage',
      'subagent_manage',
      'skills_catalog',
      'skill_manage',
      'memory_manage',
      'session_search',
      'todo_manage',
      'automation_manage',
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
      'file_download',
      'shell_exec',
      'note',
      'context_manage',
      'subagent_manage',
      'skills_catalog',
      'skill_manage',
      'memory_manage',
      'session_search',
      'todo_manage',
      'automation_manage',
      'web_search',
      'web_fetch',
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
      'plan_request_user_input',
      'plan_finalize',
      'auto_loop_exit',
    ],
    allowUnknownTools: false,
  },
];

export function normalizeToolName(name: unknown): string {
  return String(name ?? '').trim().toLowerCase();
}

export function isSubAgentProtectedTool(name: unknown): boolean {
  return SUBAGENT_PROTECTED_TOOL_NAMES.has(normalizeToolName(name));
}

export function normalizeAllowedToolNames(
  allowedTools?: readonly unknown[],
  options: { stripSubAgentProtected?: boolean; preserveEmpty?: boolean } = {}
): string[] | undefined {
  if (!allowedTools || allowedTools.length === 0) {
    return options.preserveEmpty ? [] : undefined;
  }
  const stripProtected = options.stripSubAgentProtected !== false;
  const normalized = Array.from(
    new Set(
      allowedTools
        .map((value) => normalizeToolName(value))
        .filter((value) => value.length > 0 && (!stripProtected || !isSubAgentProtectedTool(value)))
    )
  );
  if (normalized.length === 0 && !options.preserveEmpty) {
    return undefined;
  }
  return normalized;
}

export function intersectAllowedToolNames(
  requested?: readonly unknown[],
  inherited?: readonly unknown[],
  options: { preserveEmpty?: boolean } = {}
): string[] | undefined {
  const hasRequestedInput = requested !== undefined;
  const hasInheritedInput = inherited !== undefined;
  const normalizedRequested = normalizeAllowedToolNames(requested, {
    preserveEmpty: options.preserveEmpty,
  });
  const normalizedInherited = normalizeAllowedToolNames(inherited, {
    preserveEmpty: options.preserveEmpty,
  });
  if (!hasInheritedInput) {
    return normalizedRequested;
  }
  if (!hasRequestedInput) {
    return normalizedInherited;
  }
  if (!normalizedRequested || normalizedRequested.length === 0 || !normalizedInherited || normalizedInherited.length === 0) {
    return options.preserveEmpty ? [] : undefined;
  }
  const inheritedSet = new Set(normalizedInherited);
  const intersection = normalizedRequested.filter((name) => inheritedSet.has(name));
  if (intersection.length === 0 && !options.preserveEmpty) {
    return undefined;
  }
  return intersection;
}

export function resolveToolCapabilityFamily(name: string): string {
  const normalized = normalizeToolName(name);
  switch (normalized) {
    case 'read_file':
      return 'file_read';
    case 'read_tool_result':
      return 'tool_result_read';
    case 'write_file':
      return 'file_write';
    case 'edit_file':
      return 'file_edit';
    case 'glob':
      return 'file_glob';
    case 'grep':
      return 'file_grep';
    case 'send_file_to_user':
      return 'file_download';
    case 'web_fetch':
      return 'web_fetch';
    case 'web_search':
      return 'web_search';
    case 'shell_execute':
      return 'shell_exec';
    case 'context_manage':
      return 'context_manage';
    case 'subagent_manage':
      return 'subagent_manage';
    case 'skills_list':
    case 'skills_view':
      return 'skills_catalog';
    case 'skill_manage':
      return 'skill_manage';
    case 'memory_manage':
      return 'memory_manage';
    case 'session_search':
      return 'session_search';
    case 'todo':
      return 'todo_manage';
    case 'schedule_task':
      return 'automation_manage';
    case 'request_user_input':
      return 'plan_request_user_input';
    case 'finalize_plan':
      return 'plan_finalize';
    case 'exit_auto_loop':
      return 'auto_loop_exit';
    default:
      return `tool:${normalized}`;
  }
}

function readToolParameterKeys(parameters: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const maybeObject = parameters as { properties?: unknown };
  const properties = maybeObject.properties;
  if (!properties || typeof properties !== 'object') {
    return keys;
  }
  for (const key of Object.keys(properties as Record<string, unknown>)) {
    keys.add(normalizeToolName(key));
  }
  return keys;
}

function hasAnyToken(text: string, tokens: string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

function inferCapabilityFromSchemaAndDescription(tool: Tool): string | null {
  const parameterKeys = readToolParameterKeys(tool.parameters);
  const description = String(tool.description ?? '').toLowerCase();
  const normalizedName = normalizeToolName(tool.name);

  const hasSearchParam = parameterKeys.has('query') || parameterKeys.has('q') || parameterKeys.has('text_query');
  const searchSemantics =
    hasAnyToken(normalizedName, ['search', 'lookup']) ||
    hasAnyToken(description, ['search', 'internet', 'web', 'find', 'query']);
  if (hasSearchParam && searchSemantics) {
    return 'web_search';
  }

  const hasUrlParam = parameterKeys.has('url');
  const fetchSemantics =
    hasAnyToken(normalizedName, ['fetch', 'crawl']) ||
    hasAnyToken(description, ['fetch', 'crawl', 'web page', 'webpage', 'extract', 'url to fetch']);
  if (hasUrlParam && fetchSemantics) {
    return 'web_fetch';
  }

  return null;
}

export function resolveToolCapabilityFamilyForTool(tool: Tool): string {
  const fromName = resolveToolCapabilityFamily(tool.name);
  if (!fromName.startsWith('tool:')) {
    return fromName;
  }
  const inferred = inferCapabilityFromSchemaAndDescription(tool);
  if (inferred) {
    return inferred;
  }
  return fromName;
}

export function filterSubAgentToolRegistry(sourceRegistry: ToolRegistry, allowedTools?: readonly unknown[]): ToolRegistry {
  const normalizedAllowSet = allowedTools
    ? new Set(normalizeAllowedToolNames(allowedTools, { preserveEmpty: true }) ?? [])
    : null;
  const registry = new ToolRegistry();
  for (const tool of sourceRegistry.getAll()) {
    const normalizedName = normalizeToolName(tool.name);
    if (isSubAgentProtectedTool(normalizedName)) {
      continue;
    }
    if (normalizedAllowSet && !normalizedAllowSet.has(normalizedName)) {
      continue;
    }
    registry.register(tool);
  }
  return registry;
}
