import type {
  HookContext,
  HookEvent,
  HookHandler,
  HookResult,
  LoadedHook,
  BeforeToolCallHookContext,
} from './types.js';
import { agentLogger } from '../utils/logger.js';

// ── Hook Execution Result ────────────────────────────────────

export interface HookExecutionResult {
  /** Whether the pipeline was blocked by any hook. */
  blocked: boolean;
  /** The hook id that triggered the block, if any. */
  blockHookId?: string;
  /** Human-readable block reason. */
  blockError?: string;
  /**
   * Accumulated modifications from hooks (last-write-wins per hook).
   * Callers should cast based on the hook event type.
   */
  modified?: unknown;
}

export interface HookPipelineEntry {
  /** Label for logging — "user" or "system". */
  kind: 'user' | 'system';
  hooks: LoadedHook[];
}

// ── HookRunner ───────────────────────────────────────────────

export class HookRunner {
  /**
   * Execute a hook pipeline: user hooks first (sorted by priority asc,
   * then registration order), then system hooks. User hooks can block;
   * system hooks always run regardless of prior blocks (they represent
   * default processing).
   *
   * Error isolation: any hook that throws is caught, logged, and skipped.
   * Hook exceptions never propagate to the caller.
   */
  async executeHook(
    event: HookEvent,
    ctx: HookContext,
    userHooks: LoadedHook[],
    systemHooks: LoadedHook[]
  ): Promise<HookExecutionResult> {
    const sortedUser = [...userHooks]
      .filter((h) => h.entry.enabled !== false)
      .sort((a, b) => (a.entry.priority ?? 100) - (b.entry.priority ?? 100));

    const result: HookExecutionResult = { blocked: false };

    // ── Phase 1: User hooks (can block) ──
    for (const hook of sortedUser) {
      if (!hook.entry.events.includes(event)) {
        continue;
      }
      const handler = this.getHandlerForEvent(hook.handler, event);
      if (!handler) {
        continue;
      }
      try {
        const hookResult = await Promise.resolve(handler(ctx as never));
        if (hookResult.action === 'block') {
          result.blocked = true;
          result.blockHookId = hook.entry.id;
          result.blockError = hookResult.error ?? `Blocked by hook '${hook.entry.id}'`;
          agentLogger.warn(
            `[HookRunner] event=${event} blocked by user hook id=${hook.entry.id} error=${result.blockError}`
          );
          break; // first user block wins, stop user hooks
        }
        // Collect modifications (last-write-wins)
        if (hookResult.modified !== undefined) {
          result.modified = this.mergeModified(result.modified, hookResult.modified);
        }
      } catch (err) {
        agentLogger.warn(
          `[HookRunner] event=${event} user hook id=${hook.entry.id} threw: ${String(err)} — skipping`
        );
        // Continue — user hooks must not break the pipeline
      }
    }

    // ── Phase 2: System hooks (always run, never blocked) ──
    for (const hook of systemHooks) {
      if (!hook.entry.events.includes(event)) {
        continue;
      }
      const handler = this.getHandlerForEvent(hook.handler, event);
      if (!handler) {
        continue;
      }
      try {
        const hookResult = await Promise.resolve(handler(ctx as never));
        if (hookResult.modified !== undefined) {
          result.modified = this.mergeModified(result.modified, hookResult.modified);
        }
      } catch (err) {
        agentLogger.error(
          `[HookRunner] event=${event} system hook id=${hook.entry.id} threw: ${String(err)}`
        );
        // System hooks shouldn't fail, but if they do, log and continue
      }
    }

    return result;
  }

  /**
   * Build a tool_error message from a blocked BeforeToolCall hook.
   */
  buildToolError(hookResult: HookExecutionResult, ctx: BeforeToolCallHookContext): string {
    const toolCallId = ctx.toolCall.id;
    const toolName = ctx.toolName;
    const reason = hookResult.blockError ?? 'Tool call blocked by hook';
    return JSON.stringify({
      type: 'tool_error',
      tool_call_id: toolCallId,
      tool_name: toolName,
      error: reason,
    });
  }

  /**
   * Build an assistant error response from a blocked InputToLLM / TurnStart hook.
   */
  buildBlockedResponse(hookResult: HookExecutionResult, event: HookEvent): string {
    return hookResult.blockError ?? `Processing blocked by hook at ${event}`;
  }

  // ── Internals ──────────────────────────────────────────────

  private getHandlerForEvent(
    handler: HookHandler,
    event: HookEvent
  ): ((ctx: unknown) => HookResult | Promise<HookResult>) | undefined {
    switch (event) {
      case 'onTurnStart':
        return handler.onTurnStart?.bind(handler) as
          | ((ctx: unknown) => HookResult | Promise<HookResult>)
          | undefined;
      case 'onInputToLLM':
        return handler.onInputToLLM?.bind(handler) as
          | ((ctx: unknown) => HookResult | Promise<HookResult>)
          | undefined;
      case 'onLLMResponse':
        return handler.onLLMResponse?.bind(handler) as
          | ((ctx: unknown) => HookResult | Promise<HookResult>)
          | undefined;
      case 'onBeforeToolCall':
        return handler.onBeforeToolCall?.bind(handler) as
          | ((ctx: unknown) => HookResult | Promise<HookResult>)
          | undefined;
      case 'onAfterToolCall':
        return handler.onAfterToolCall?.bind(handler) as
          | ((ctx: unknown) => HookResult | Promise<HookResult>)
          | undefined;
      case 'onTurnEnd':
        return handler.onTurnEnd?.bind(handler) as
          | ((ctx: unknown) => HookResult | Promise<HookResult>)
          | undefined;
      default:
        return undefined;
    }
  }

  private mergeModified(current: unknown, incoming: unknown): unknown {
    if (current === undefined) {
      return incoming;
    }
    if (incoming === undefined) {
      return current;
    }
    // Shallow merge for plain objects; otherwise last-write-wins
    if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      incoming !== null &&
      typeof incoming === 'object' &&
      !Array.isArray(incoming)
    ) {
      return { ...(current as Record<string, unknown>), ...(incoming as Record<string, unknown>) };
    }
    return incoming;
  }
}
