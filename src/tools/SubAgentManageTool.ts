import { Tool, errorResult, successResult } from './Tool.js';
import type { ContextRef, ContextScope, SubAgentStatus, ToolResult } from '../types.js';
import type { SubAgentManager } from '../subagent/SubAgentManager.js';
import { intersectAllowedToolNames, normalizeAllowedToolNames } from './CapabilityCatalog.js';

const DEFAULT_WAIT_TIMEOUT_MS = 300000;
const AD_HOC_AGENT_HINT =
  'If no listed agent fits, call subagent_manage with action=create and prompt, and omit agent_name to create an ad-hoc sub-agent.';

export interface SubAgentManageToolOptions {
  manager: SubAgentManager;
  resolveActiveContext: () => ContextRef | null;
  resolveActiveTurnId?: () => string | null | undefined;
  resolveDefaultWorkspaceDir: () => string;
  resolveAllowedTools?: () => string[];
}

function normalizeScope(value: unknown): ContextScope | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'session' || text === 'workspace' || text === 'global') {
    return text;
  }
  return null;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') {
      return true;
    }
    if (lower === 'false') {
      return false;
    }
  }
  return fallback;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function formatToolError(input: { code: string; error: string }): string {
  const normalizedCode = input.code.trim();
  const normalizedError = input.error.trim();
  if (normalizedError.length === 0) {
    return normalizedCode;
  }
  if (normalizedError.startsWith(`${normalizedCode}:`)) {
    return normalizedError;
  }
  return `${normalizedCode}: ${normalizedError}`;
}

function isTerminalSubAgentStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'timeout';
}

function createHeartbeatPayload(status: SubAgentStatus): {
  lastHeartbeatAt: string | null;
  ageMs: number | null;
  stale: boolean;
} {
  const lastHeartbeatAt = String(status.lastHeartbeatAt ?? '').trim();
  const heartbeatMs = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : Number.NaN;
  const ageMs = Number.isFinite(heartbeatMs) ? Math.max(0, Date.now() - heartbeatMs) : null;
  return {
    lastHeartbeatAt: lastHeartbeatAt || null,
    ageMs,
    stale: String(status.lifecycleDiagnostic ?? '').startsWith('heartbeat_stale:'),
  };
}

function createStatusGuidance(status: SubAgentStatus, waitTimedOut = false): string {
  const terminal = isTerminalSubAgentStatus(status.status);
  if (waitTimedOut && !terminal) {
    return 'result(wait=true) wait timed out, but the sub-agent is still running or queued. Call status/result again later, or cancel if the task is no longer needed.';
  }
  if (!terminal) {
    if (status.status === 'queued') {
      return createQueuedHint(status);
    }
    return status.running
      ? 'Sub-agent is still running. Check heartbeat.lastHeartbeatAt and call result(wait=true) again if you need the final output.'
      : 'Sub-agent is queued or pending. Call status/result again later.';
  }
  return 'Sub-agent is terminal. Inspect result for final summary, artifacts, and errors.';
}

function createQueuedHint(status: SubAgentStatus): string {
  const position = status.queuePosition ?? 1;
  return `Sub-agent is queued because current concurrency is full or older queued work is ahead. queuePosition=${position}, queuedCount=${status.queuedCount}. It has not started yet; call status/result later or cancel if no longer needed.`;
}

function enrichStatusPayload(status: SubAgentStatus, waitTimedOut = false): {
  terminal: boolean;
  heartbeat: ReturnType<typeof createHeartbeatPayload>;
  lifecycleDiagnostic?: string;
  guidance: string;
  hint?: string;
} {
  const hint = status.status === 'queued' ? createQueuedHint(status) : undefined;
  return {
    terminal: isTerminalSubAgentStatus(status.status),
    heartbeat: createHeartbeatPayload(status),
    ...(status.lifecycleDiagnostic ? { lifecycleDiagnostic: status.lifecycleDiagnostic } : {}),
    guidance: createStatusGuidance(status, waitTimedOut),
    ...(hint ? { hint } : {}),
  };
}

export class SubAgentManageTool extends Tool {
  private readonly manager: SubAgentManager;
  private readonly resolveActiveContext: () => ContextRef | null;
  private readonly resolveActiveTurnId?: () => string | null | undefined;
  private readonly resolveDefaultWorkspaceDir: () => string;
  private readonly resolveAllowedTools?: () => string[];

  constructor(options: SubAgentManageToolOptions) {
    super();
    this.manager = options.manager;
    this.resolveActiveContext = options.resolveActiveContext;
    this.resolveActiveTurnId = options.resolveActiveTurnId;
    this.resolveDefaultWorkspaceDir = options.resolveDefaultWorkspaceDir;
    this.resolveAllowedTools = options.resolveAllowedTools;
  }

  get name(): string {
    return 'subagent_manage';
  }

  get description(): string {
    return 'Create and manage asynchronous sub-agents. Prefer list_agents first, then create/resume with agent_name and prompt. For result(wait=true), a wait timeout is not a sub-agent failure: inspect waitTimedOut, terminal, heartbeat, and guidance, then call status/result again or cancel explicitly.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'status', 'result', 'cancel', 'list', 'resume', 'list_agents'],
          description: 'Action to perform.',
        },
        subagent_id: {
          type: 'string',
          description: 'Sub-agent ID for status/result/cancel/resume.',
        },
        prompt: {
          type: 'string',
          description: 'Task prompt used by create or resume.',
        },
        agent_name: {
          type: 'string',
          description: 'Optional agent profile name from list_agents (case-insensitive).',
        },
        provider_id: {
          type: 'string',
          description: 'Optional provider override.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional requested whitelist for sub-agent execution. The effective set is still limited by the parent toolset, and protected tools such as context_manage and subagent_manage are stripped.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds. result(wait=true) defaults to 300000.',
        },
        wait: {
          type: 'boolean',
          description: 'For result action: wait for terminal status.',
        },
        scope: {
          type: 'string',
          enum: ['session', 'workspace', 'global'],
          description: 'Optional parent context scope override.',
        },
        namespace: {
          type: 'string',
          description: 'Optional parent context namespace override.',
        },
        workspace_dir: {
          type: 'string',
          description: 'Optional workspace directory for sub-agent execution and list_agents pool resolution.',
        },
      },
      required: ['action'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = String(args.action ?? '').trim().toLowerCase();
    const contextResult = this.resolveParentContext(args);
    if (!contextResult.ok) {
      return errorResult(contextResult.error);
    }
    const parentContext = contextResult.context;

    switch (action) {
      case 'create': {
        const prompt = String(args.prompt ?? '').trim();
        if (!prompt) {
          return errorResult('prompt is required for create');
        }
        const allowedToolsResult = this.resolveEffectiveAllowedTools(args.allowed_tools);
        if (!allowedToolsResult.ok) {
          return errorResult(allowedToolsResult.error);
        }
        const result = this.manager.create({
          parentContext,
          parentTurnId: this.resolveCurrentParentTurnId(),
          prompt,
          agentName: String(args.agent_name ?? '').trim() || undefined,
          providerId: String(args.provider_id ?? '').trim() || undefined,
          allowedTools: allowedToolsResult.allowedTools,
          timeoutMs: normalizeNumber(args.timeout_ms),
          workspaceDir: String(args.workspace_dir ?? '').trim() || this.resolveDefaultWorkspaceDir(),
        });
        if (!result.ok) {
          if (result.code === 'agent_not_found') {
            return successResult(
              JSON.stringify(
                {
                  ok: true,
                  action,
                  created: false,
                  agentName: String(args.agent_name ?? '').trim(),
                  warning: formatToolError(result),
                  hint: AD_HOC_AGENT_HINT,
                },
                null,
                2
              )
            );
          }
          return errorResult(formatToolError(result));
        }
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              status: result.status,
              ...enrichStatusPayload(result.status),
            },
            null,
            2
          )
        );
      }

      case 'resume': {
        const subagentId = String(args.subagent_id ?? '').trim();
        if (!subagentId) {
          return errorResult('subagent_id is required for resume');
        }
        const prompt = String(args.prompt ?? '').trim();
        if (!prompt) {
          return errorResult('prompt is required for resume');
        }
        const allowedToolsResult = this.resolveEffectiveAllowedTools(args.allowed_tools);
        if (!allowedToolsResult.ok) {
          return errorResult(allowedToolsResult.error);
        }

        const result = this.manager.resume({
          subagentId,
          parentContext,
          parentTurnId: this.resolveCurrentParentTurnId(),
          prompt,
          agentName: String(args.agent_name ?? '').trim() || undefined,
          providerId: String(args.provider_id ?? '').trim() || undefined,
          allowedTools: allowedToolsResult.allowedTools,
          timeoutMs: normalizeNumber(args.timeout_ms),
          workspaceDir: String(args.workspace_dir ?? '').trim() || this.resolveDefaultWorkspaceDir(),
        });
        if (!result.ok) {
          return errorResult(formatToolError(result));
        }
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              status: result.status,
              ...enrichStatusPayload(result.status),
            },
            null,
            2
          )
        );
      }

      case 'list_agents': {
        const workspaceDir = String(args.workspace_dir ?? '').trim() || this.resolveDefaultWorkspaceDir();
        const agents = this.manager.listAgents(workspaceDir);
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              workspaceDir,
              agents,
              hint: AD_HOC_AGENT_HINT,
            },
            null,
            2
          )
        );
      }

      case 'status': {
        const subagentId = String(args.subagent_id ?? '').trim();
        if (!subagentId) {
          return errorResult('subagent_id is required for status');
        }
        const status = this.manager.getStatus(parentContext, subagentId);
        if (!status) {
          return errorResult(`subagent_not_found: ${subagentId}`);
        }
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              status,
              ...enrichStatusPayload(status),
            },
            null,
            2
          )
        );
      }

      case 'list': {
        const list = this.manager.list(parentContext);
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              parentContext,
              items: list.map((status) => ({
                ...status,
                ...enrichStatusPayload(status),
              })),
            },
            null,
            2
          )
        );
      }

      case 'cancel': {
        const subagentId = String(args.subagent_id ?? '').trim();
        if (!subagentId) {
          return errorResult('subagent_id is required for cancel');
        }
        const status = this.manager.cancel(parentContext, subagentId);
        if (!status) {
          return errorResult(`subagent_not_found: ${subagentId}`);
        }
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              status,
              ...enrichStatusPayload(status),
            },
            null,
            2
          )
        );
      }

      case 'result': {
        const subagentId = String(args.subagent_id ?? '').trim();
        if (!subagentId) {
          return errorResult('subagent_id is required for result');
        }
        const wait = normalizeBoolean(args.wait, false);
        const timeoutMs = normalizeNumber(args.timeout_ms) ?? DEFAULT_WAIT_TIMEOUT_MS;
        const result = await this.manager.getResult(parentContext, subagentId, {
          wait,
          timeoutMs,
        });
        if (!result) {
          return errorResult(`subagent_not_found: ${subagentId}`);
        }
        return successResult(
          JSON.stringify(
            {
              ok: true,
              action,
              wait,
              timedOut: result.timedOut ?? false,
              waitTimedOut: result.timedOut ?? false,
              status: result.status,
              result: result.result ?? null,
              ...enrichStatusPayload(result.status, result.timedOut === true),
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

  private resolveParentContext(
    args: Record<string, unknown>
  ): { ok: true; context: ContextRef } | { ok: false; error: string } {
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
      context: {
        scope,
        namespace,
      },
    };
  }

  private resolveCurrentParentTurnId(): string | undefined {
    const turnId = String(this.resolveActiveTurnId?.() ?? '').trim();
    return turnId.length > 0 ? turnId : undefined;
  }

  private resolveEffectiveAllowedTools(
    rawAllowedTools: unknown
  ): { ok: true; allowedTools?: string[] } | { ok: false; error: string } {
    const requestedRaw = normalizeStringArray(rawAllowedTools);
    const requested = normalizeAllowedToolNames(requestedRaw, {
      preserveEmpty: requestedRaw !== undefined,
    });
    const inherited = normalizeAllowedToolNames(this.resolveAllowedTools?.());
    if (!inherited || inherited.length === 0) {
      return { ok: true, allowedTools: requested };
    }
    if (requestedRaw === undefined) {
      return { ok: true, allowedTools: inherited };
    }
    const intersection = intersectAllowedToolNames(requested, inherited, { preserveEmpty: true });
    if (!intersection || intersection.length === 0) {
      return { ok: false, error: 'allowed_tools must stay within the current toolset' };
    }
    return { ok: true, allowedTools: intersection };
  }
}

export function createSubAgentManageTool(options: SubAgentManageToolOptions): SubAgentManageTool {
  return new SubAgentManageTool(options);
}
