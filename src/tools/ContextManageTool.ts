import { Tool, errorResult, successResult } from './Tool.js';
import { ContextManager } from '../context/index.js';
import type { ContextRef, ContextScope, ToolResult } from '../types.js';

export interface ContextManageToolOptions {
  contextManager: ContextManager;
  resolveActiveContext: () => ContextRef | null;
  resolveActiveTurnId: () => string | null;
  readOnly?: boolean;
}

function normalizeScope(value: unknown): ContextScope | null {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text === 'session' || text === 'workspace' || text === 'global') {
    return text;
  }
  return null;
}

function normalizeBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return defaultValue;
}

const READ_ONLY_CONTEXT_STATE_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'workspaceDir',
  'toolsetName',
  'memoryPromotionState',
  'compressedHistoryContext',
  'autoLoopConfig',
  'agentInjectionState',
  'planningState',
]);

function isReservedContextStateKey(key: string): boolean {
  const normalized = key.trim();
  return (
    READ_ONLY_CONTEXT_STATE_KEYS.has(normalized) ||
    normalized.startsWith('meta.') ||
    normalized.startsWith('runtime.') ||
    normalized.startsWith('projection.') ||
    normalized.startsWith('pending.')
  );
}

export class ContextManageTool extends Tool {
  private readonly contextManager: ContextManager;
  private readonly resolveActiveContext: () => ContextRef | null;
  private readonly resolveActiveTurnId: () => string | null;
  private readonly readOnly: boolean;

  constructor(options: ContextManageToolOptions) {
    super();
    this.contextManager = options.contextManager;
    this.resolveActiveContext = options.resolveActiveContext;
    this.resolveActiveTurnId = options.resolveActiveTurnId;
    this.readOnly = options.readOnly === true;
  }

  get name(): string {
    return 'context_manage';
  }

  get description(): string {
    return 'Inspect current structured context state, active-turn pending overlays, and selected runtime context state for the active namespace or an explicitly targeted scope+namespace. write/delete only mutate structured context keys; runtime/meta fields such as compressedHistoryContext, autoLoopConfig, and agentInjectionState are read-only. Writes and deletes against the active turn context may be buffered until turn commit; other targets commit immediately.';
  }

  get parameters(): Record<string, unknown> {
    const actionEnum = this.readOnly ? ['read', 'list', 'summarize'] : ['read', 'write', 'delete', 'list', 'summarize'];
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: actionEnum,
          description: 'Action to perform. read/list/summarize inspect the current context state, while write/delete mutate structured context keys only.',
        },
        scope: {
          type: 'string',
          enum: ['session', 'workspace', 'global'],
          description: 'Optional context scope override. If omitted, the active context scope is used. For list, scope alone is sufficient. For read/write/delete/summarize without an active context, you must provide both scope and namespace.',
        },
        namespace: {
          type: 'string',
          description: 'Optional namespace override. If omitted, the active context namespace is used for read/write/delete/summarize. list ignores namespace.',
        },
        key: {
          type: 'string',
          description: 'Structured context key for read/write/delete. Optional for read to inspect the whole namespace state. summarize ignores this field.',
        },
        value: {
          type: 'string',
          description: 'Structured context value for write. Required for write and ignored for other actions.',
        },
        include_meta: {
          type: 'boolean',
          description: 'For read/summarize only. Defaults to true. When enabled, selected runtime context state such as compressedHistoryContext and autoLoopConfig is included.',
        },
        include_pending: {
          type: 'boolean',
          description: 'For read/summarize only. Defaults to true. When enabled, active-turn pending context patches are overlaid on the committed state.',
        },
      },
      required: ['action'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = String(args.action ?? '')
      .trim()
      .toLowerCase();

    switch (action) {
      case 'list': {
        const scopeResult = this.resolveListScope(args);
        if (!scopeResult.ok) {
          return errorResult(scopeResult.error);
        }
        const scope = scopeResult.scope;
        const namespaces = this.contextManager.listNamespaces(scope).map((item) => ({
          scope: item.scope,
          namespace: item.namespace,
          name: item.name,
          updatedAt: item.updatedAt,
          version: item.projection.version,
          toolsetName: item.toolsetName ?? null,
          memoryPromotionStatus: item.memoryPromotionState?.status ?? null,
          hasCompressedHistoryContext: Boolean(item.compressedHistoryContext),
        }));
        return successResult(JSON.stringify({ ok: true, action, scope, namespaces }, null, 2));
      }
      case 'read': {
        const targetResult = this.resolveContext(args);
        if (!targetResult.ok) {
          return errorResult(targetResult.error);
        }
        const target = targetResult.ref;
        const includeMeta = normalizeBoolean(args.include_meta, true);
        const includePending = normalizeBoolean(args.include_pending, true);
        const turnId = includePending ? this.resolveTurnIdForTarget(target) : undefined;
        const keyRaw = String(args.key ?? '').trim();
        if (keyRaw) {
          const keyState = this.contextManager.inspectKey(target, keyRaw, {
            turnId,
            includePending,
          });
          return successResult(
            JSON.stringify(
              {
                ok: true,
                action,
                context: target,
                key: keyRaw,
                found: keyState.found,
                value: keyState.value,
                sourceStatus: keyState.sourceStatus,
                committedValue: keyState.committedValue ?? null,
                version: this.contextManager.getProjection(target).version,
              },
              null,
              2
            )
          );
        }
        const inspection = this.contextManager.inspect(target, {
          turnId,
          includePending,
          includeMeta,
        });
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              context: target,
              version: inspection.projection.version,
              structuredContext: inspection.effectiveKeyValues,
              committedStructuredContext: inspection.projection.keyValues,
              pendingOverlay: includePending ? inspection.pendingOverlay ?? null : null,
              meta: includeMeta ? inspection.meta ?? null : null,
              summary: inspection.summary,
            },
            null,
            2
          )
        );
      }
      case 'write': {
        if (this.readOnly) {
          return errorResult('context_manage is read-only in the current planning phase');
        }
        const targetResult = this.resolveContext(args);
        if (!targetResult.ok) {
          return errorResult(targetResult.error);
        }
        const target = targetResult.ref;
        const key = String(args.key ?? '').trim();
        const value = String(args.value ?? '').trim();
        if (!key) {
          return errorResult('key is required for write');
        }
        if (isReservedContextStateKey(key)) {
          return errorResult(
            `key '${key}' targets read-only runtime context state; context_manage only writes structured context keys`
          );
        }
        const turnId = this.resolveActiveTurnId();
        const activeContext = this.resolveActiveContext();
        if (
          turnId &&
          activeContext &&
          activeContext.scope === target.scope &&
          activeContext.namespace === target.namespace
        ) {
          this.contextManager.recordContextPatch(turnId, {
            op: 'set',
            key,
            value,
            source: 'context_manage',
          });
          return successResult(
            JSON.stringify(
              {
                ok: true,
                action,
                mode: 'buffered',
                context: target,
                key,
                value,
              },
              null,
              2
            )
          );
        }

        const projection = this.contextManager.writeNow(target, key, value);
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              mode: 'committed',
              context: target,
              key,
              value,
              version: projection.version,
            },
            null,
            2
          )
        );
      }
      case 'delete': {
        if (this.readOnly) {
          return errorResult('context_manage is read-only in the current planning phase');
        }
        const targetResult = this.resolveContext(args);
        if (!targetResult.ok) {
          return errorResult(targetResult.error);
        }
        const target = targetResult.ref;
        const key = String(args.key ?? '').trim();
        if (!key) {
          return errorResult('key is required for delete');
        }
        if (isReservedContextStateKey(key)) {
          return errorResult(
            `key '${key}' targets read-only runtime context state; context_manage only deletes structured context keys`
          );
        }
        const turnId = this.resolveActiveTurnId();
        const activeContext = this.resolveActiveContext();
        if (
          turnId &&
          activeContext &&
          activeContext.scope === target.scope &&
          activeContext.namespace === target.namespace
        ) {
          this.contextManager.recordContextPatch(turnId, {
            op: 'delete',
            key,
            source: 'context_manage',
          });
          return successResult(
            JSON.stringify(
              {
                ok: true,
                action,
                mode: 'buffered',
                context: target,
                key,
              },
              null,
              2
            )
          );
        }
        const projection = this.contextManager.deleteNow(target, key);
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              mode: 'committed',
              context: target,
              key,
              version: projection.version,
            },
            null,
            2
          )
        );
      }
      case 'summarize': {
        const targetResult = this.resolveContext(args);
        if (!targetResult.ok) {
          return errorResult(targetResult.error);
        }
        const target = targetResult.ref;
        const includeMeta = normalizeBoolean(args.include_meta, true);
        const includePending = normalizeBoolean(args.include_pending, true);
        const turnId = includePending ? this.resolveTurnIdForTarget(target) : undefined;
        const inspection = this.contextManager.inspect(target, {
          turnId,
          includePending,
          includeMeta,
        });
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              context: target,
              version: inspection.projection.version,
              summary: inspection.summary,
              pendingOverlay: includePending ? inspection.pendingOverlay ?? null : null,
              meta: includeMeta ? inspection.meta ?? null : null,
            },
            null,
            2
          )
        );
      }
      default:
        return errorResult(`Unknown action: ${action}`);
    }
  }

  private resolveListScope(
    args: Record<string, unknown>
  ): { ok: true; scope: ContextScope } | { ok: false; error: string } {
    const active = this.resolveActiveContext();
    const scope = normalizeScope(args.scope) ?? active?.scope;
    if (!scope) {
      return { ok: false, error: 'context scope is required for list when no active context is available' };
    }
    return { ok: true, scope };
  }

  private resolveContext(args: Record<string, unknown>): { ok: true; ref: ContextRef } | { ok: false; error: string } {
    const active = this.resolveActiveContext();
    const scope = normalizeScope(args.scope) ?? active?.scope;
    const namespace = String(args.namespace ?? active?.namespace ?? '').trim();
    if (!scope) {
      return { ok: false, error: 'context scope is required (no active context found)' };
    }
    if (!namespace) {
      return { ok: false, error: 'context namespace is required (no active context found)' };
    }
    return {
      ok: true,
      ref: {
        scope,
        namespace,
      },
    };
  }

  private resolveTurnIdForTarget(target: ContextRef): string | undefined {
    const activeContext = this.resolveActiveContext();
    const turnId = this.resolveActiveTurnId();
    if (!turnId || !activeContext) {
      return undefined;
    }
    if (activeContext.scope !== target.scope || activeContext.namespace !== target.namespace) {
      return undefined;
    }
    return turnId;
  }
}

export function createContextManageTool(options: ContextManageToolOptions): ContextManageTool {
  return new ContextManageTool(options);
}
