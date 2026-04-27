import type { Tool } from './Tool.js';
import type { ToolRegistry } from './ToolRegistry.js';

export type ToolSource = 'team' | 'core' | 'other';

interface CapabilityRegistration {
  toolName: string;
  source: ToolSource;
  priority: number;
}

export interface ToolRegistrationState {
  byCapability: Map<string, CapabilityRegistration>;
  byName: Set<string>;
}

export interface ToolRegistrationSkip {
  skipped: true;
  reason: 'duplicate_name' | 'capability_conflict';
  toolName: string;
  capability: string;
  keptToolName?: string;
  keptSource?: ToolSource;
}

export interface ToolRegistrationApplied {
  skipped: false;
  replaced?: {
    toolName: string;
    source: ToolSource;
  };
}

export type ToolRegistrationResult = ToolRegistrationSkip | ToolRegistrationApplied;

export function createToolRegistrationState(): ToolRegistrationState {
  return {
    byCapability: new Map<string, CapabilityRegistration>(),
    byName: new Set<string>(),
  };
}

function sourcePriority(source: ToolSource): number {
  if (source === 'team') {
    return 3;
  }
  if (source === 'core') {
    return 2;
  }
  return 1;
}

export function resolveToolCapabilityFamily(name: string): string {
  const normalized = name.trim().toLowerCase();
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
    case 'update_plan':
      return 'plan_update';
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
    keys.add(key.trim().toLowerCase());
  }
  return keys;
}

function hasAnyToken(text: string, tokens: string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

function inferCapabilityFromSchemaAndDescription(tool: Tool): string | null {
  const parameterKeys = readToolParameterKeys(tool.parameters);
  const description = String(tool.description ?? '').toLowerCase();
  const normalizedName = tool.name.trim().toLowerCase();

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

export function registerToolWithDedupe(
  registry: ToolRegistry,
  state: ToolRegistrationState,
  tool: Tool,
  source: ToolSource
): ToolRegistrationResult {
  const toolName = tool.name;
  const capability = resolveToolCapabilityFamilyForTool(tool);
  if (state.byName.has(toolName)) {
    return {
      skipped: true,
      reason: 'duplicate_name',
      toolName,
      capability,
      keptToolName: toolName,
      keptSource: state.byCapability.get(capability)?.source,
    };
  }

  const existing = state.byCapability.get(capability);
  const currentPriority = sourcePriority(source);
  if (existing && existing.priority >= currentPriority) {
    return {
      skipped: true,
      reason: 'capability_conflict',
      toolName,
      capability,
      keptToolName: existing.toolName,
      keptSource: existing.source,
    };
  }

  let replaced: ToolRegistrationApplied['replaced'];
  if (existing && existing.priority < currentPriority) {
    registry.unregister(existing.toolName);
    state.byName.delete(existing.toolName);
    replaced = { toolName: existing.toolName, source: existing.source };
  }

  registry.register(tool);
  state.byName.add(toolName);
  state.byCapability.set(capability, {
    toolName,
    source,
    priority: currentPriority,
  });
  return {
    skipped: false,
    replaced,
  };
}
