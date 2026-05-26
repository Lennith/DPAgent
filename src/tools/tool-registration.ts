import type { Tool } from './Tool.js';
import type { ToolRegistry } from './ToolRegistry.js';
import { resolveToolCapabilityFamilyForTool } from './CapabilityCatalog.js';
export { resolveToolCapabilityFamily, resolveToolCapabilityFamilyForTool } from './CapabilityCatalog.js';

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

export function registerToolWithDedupe(
  registry: ToolRegistry,
  state: ToolRegistrationState,
  tool: Tool,
  source: ToolSource
): ToolRegistrationResult {
  const toolName = tool.name;
  const capability = resolveToolCapabilityFamilyForTool(tool);
  const existing = state.byCapability.get(capability);
  const currentPriority = sourcePriority(source);
  if (state.byName.has(toolName)) {
    if (existing?.toolName === toolName && existing.priority < currentPriority) {
      registry.unregister(toolName);
      state.byName.delete(toolName);
    } else {
      return {
        skipped: true,
        reason: 'duplicate_name',
        toolName,
        capability,
        keptToolName: toolName,
        keptSource: existing?.source,
      };
    }
  }

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
    if (state.byName.has(existing.toolName)) {
      registry.unregister(existing.toolName);
      state.byName.delete(existing.toolName);
    }
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
