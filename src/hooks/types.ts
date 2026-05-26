import type { Message, ToolCall, ToolResult, TokenUsage, LLMResponse } from '../types.js';

// ── Hook Events ──────────────────────────────────────────────
export type HookEvent =
  | 'onTurnStart'
  | 'onInputToLLM'
  | 'onLLMResponse'
  | 'onBeforeToolCall'
  | 'onAfterToolCall'
  | 'onTurnEnd';

export const HOOK_EVENTS: readonly HookEvent[] = [
  'onTurnStart',
  'onInputToLLM',
  'onLLMResponse',
  'onBeforeToolCall',
  'onAfterToolCall',
  'onTurnEnd',
] as const;

// ── Hook Contexts ────────────────────────────────────────────

export interface TurnStartHookContext {
  event: 'onTurnStart';
  sessionId: string;
  step: number;
  messages: Message[];
  systemPrompt?: string;
}

export interface InputToLLMHookContext {
  event: 'onInputToLLM';
  sessionId: string;
  step: number;
  systemPrompt?: string;
  contentMessages: Message[];
  precompressApplied: boolean;
}

export interface LLMResponseHookContext {
  event: 'onLLMResponse';
  sessionId: string;
  step: number;
  response: LLMResponse;
}

export interface BeforeToolCallHookContext {
  event: 'onBeforeToolCall';
  sessionId: string;
  step: number;
  toolCall: ToolCall;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

export interface AfterToolCallHookContext {
  event: 'onAfterToolCall';
  sessionId: string;
  step: number;
  toolCall: ToolCall;
  toolName: string;
  result: ToolResult;
}

export interface TurnEndHookContext {
  event: 'onTurnEnd';
  sessionId: string;
  step: number;
  finishReason: string;
  content: string;
  usage?: TokenUsage;
}

export type HookContext =
  | TurnStartHookContext
  | InputToLLMHookContext
  | LLMResponseHookContext
  | BeforeToolCallHookContext
  | AfterToolCallHookContext
  | TurnEndHookContext;

// ── Hook Result ──────────────────────────────────────────────

export interface HookResult {
  /** Whether processing should continue or be blocked. */
  action: 'continue' | 'block';
  /**
   * Optional modified data to pass forward. Interpretation depends on the
   * hook event type. The runner applies type-appropriate merging.
   */
  modified?: unknown;
  /** Error message when blocked. Used for tool_error or assistant response. */
  error?: string;
}

// ── Hook Handler Interface ────────────────────────────────────

export interface HookHandler {
  onTurnStart?(ctx: TurnStartHookContext): HookResult | Promise<HookResult>;
  onInputToLLM?(ctx: InputToLLMHookContext): HookResult | Promise<HookResult>;
  onLLMResponse?(ctx: LLMResponseHookContext): HookResult | Promise<HookResult>;
  onBeforeToolCall?(ctx: BeforeToolCallHookContext): HookResult | Promise<HookResult>;
  onAfterToolCall?(ctx: AfterToolCallHookContext): HookResult | Promise<HookResult>;
  onTurnEnd?(ctx: TurnEndHookContext): HookResult | Promise<HookResult>;
}

// ── Hook Config ──────────────────────────────────────────────

export interface HookConfigEntry {
  /** Unique identifier for this hook. */
  id: string;
  /** Hook events this handler subscribes to. */
  events: HookEvent[];
  /** Path to the hook module, relative to the workspace root. */
  module: string;
  /** Execution priority (lower runs first). Default 100. */
  priority?: number;
  /** Whether this hook is active. Default true. */
  enabled?: boolean;
}

export interface HookConfigFile {
  hooks: HookConfigEntry[];
}

export const DEFAULT_HOOK_PRIORITY = 100;

// ── Loaded Hook Instance ─────────────────────────────────────

export interface LoadedHook {
  entry: HookConfigEntry;
  handler: HookHandler;
  /** When the module was last loaded (for cache invalidation). */
  loadedAt: number;
}
