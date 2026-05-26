import type { ContextRef } from '../types.js';

export function normalizeSubAgentContextRef(ref: ContextRef): ContextRef {
  const scope = ref.scope;
  if (scope !== 'session' && scope !== 'workspace' && scope !== 'global') {
    throw new Error(`Invalid context scope: ${String(scope)}`);
  }
  const namespace = String(ref.namespace ?? '').trim();
  if (!namespace) {
    throw new Error('context.namespace cannot be empty');
  }
  return { scope, namespace };
}

export function subAgentContextKey(ref: ContextRef): string {
  const normalized = normalizeSubAgentContextRef(ref);
  return `${normalized.scope}:${normalized.namespace}`;
}

export function createSubAgentContextRef(parentContext: ContextRef, subagentId: string): ContextRef {
  const normalizedParent = normalizeSubAgentContextRef(parentContext);
  return {
    scope: 'global',
    namespace: `sub:${normalizedParent.namespace}:${subagentId}`,
  };
}
