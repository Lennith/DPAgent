import type { Tool } from './Tool.js';
import {
  DEFAULT_TOOLSETS,
  resolveToolCapabilityFamilyForTool,
  type ToolsetDefinition,
} from './CapabilityCatalog.js';
export type { ToolsetDefinition } from './CapabilityCatalog.js';

export interface ResolvedToolset {
  definition: ToolsetDefinition;
  toolNames: string[];
  capabilities: string[];
}

export class ToolsetRegistry {
  private readonly definitions = new Map<string, ToolsetDefinition>();
  private readonly defaultToolsetName: string;

  constructor(defaultToolsetName = 'windows-safe', customDefinitions: ToolsetDefinition[] = []) {
    const builtinNames = new Set(DEFAULT_TOOLSETS.map((definition) => definition.name.trim().toLowerCase()));
    for (const definition of DEFAULT_TOOLSETS) {
      this.definitions.set(definition.name.trim().toLowerCase(), {
        ...definition,
        name: definition.name.trim(),
        capabilities: Array.from(
          new Set(definition.capabilities.map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0))
        ),
      });
    }
    for (const definition of customDefinitions) {
      const normalizedName = definition.name.trim().toLowerCase();
      if (!normalizedName) {
        continue;
      }
      if (builtinNames.has(normalizedName)) {
        throw new Error(`Custom toolset cannot override built-in toolset: ${definition.name}`);
      }
      this.definitions.set(normalizedName, {
        ...definition,
        name: definition.name.trim(),
        capabilities: Array.from(
          new Set(definition.capabilities.map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0))
        ),
      });
    }
    this.defaultToolsetName = defaultToolsetName.trim().toLowerCase() || 'windows-safe';
  }

  list(): ToolsetDefinition[] {
    return Array.from(this.definitions.values())
      .filter((definition) => definition.hidden !== true)
      .map((definition) => ({ ...definition }));
  }

  find(name: string | undefined | null): ToolsetDefinition | undefined {
    const normalized = String(name ?? '').trim().toLowerCase();
    const matched = this.definitions.get(normalized);
    return matched ? { ...matched, capabilities: [...matched.capabilities] } : undefined;
  }

  has(name: string | undefined | null): boolean {
    return this.find(name) !== undefined;
  }

  requireToolset(name: string | undefined | null, source = 'toolset'): ToolsetDefinition {
    const matched = this.find(name);
    if (matched) {
      return matched;
    }
    const normalized = String(name ?? '').trim();
    throw new Error(`Unknown ${source}: ${normalized || '(empty)'}`);
  }

  get(name: string | undefined | null): ToolsetDefinition {
    const matched = this.find(name);
    if (matched) {
      return matched;
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

export function createToolsetRegistry(defaultToolsetName?: string, customDefinitions: ToolsetDefinition[] = []): ToolsetRegistry {
  return new ToolsetRegistry(defaultToolsetName, customDefinitions);
}
