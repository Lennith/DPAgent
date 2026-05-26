import type { TodoItem, TodoPriority, TodoProtocolState, TodoScope, TodoStatus, TodoStore } from '../todo/index.js';
import { Tool, errorResult, successResult } from './Tool.js';

export interface TodoToolOptions {
  todoStore: TodoStore;
  resolveSessionId: () => string | undefined;
  resolveWorkspaceDir: () => string | undefined;
  resolveActivePlanId?: () => string | undefined;
}

function normalizeScope(value: unknown, fallback: TodoScope): TodoScope {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'session' || normalized === 'workspace' || normalized === 'user') {
    return normalized;
  }
  return fallback;
}

function normalizeStatus(value: unknown): TodoStatus | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'pending' ||
    normalized === 'in_progress' ||
    normalized === 'blocked' ||
    normalized === 'completed'
  ) {
    return normalized;
  }
  return undefined;
}

function normalizePriority(value: unknown): TodoPriority | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : [];
}

function normalizeEvidence(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeProtocolForTool(protocol: TodoProtocolState): Omit<TodoProtocolState, 'dismissedItems'> {
  const keepVisible = (item: TodoItem) => item.status !== 'dismissed';
  const visibleItems = protocol.items.filter(keepVisible);
  const visibleUnfinishedItems = protocol.unfinishedItems.filter(keepVisible);
  const visibleCompletedItems = protocol.completedItems.filter(keepVisible);
  return {
    items: visibleItems,
    unfinishedItems: visibleUnfinishedItems,
    activeItem: protocol.activeItem?.status === 'dismissed' ? null : protocol.activeItem,
    blockedItem: protocol.blockedItem?.status === 'dismissed' ? null : protocol.blockedItem,
    pendingItems: protocol.pendingItems.filter(keepVisible),
    completedItems: visibleCompletedItems,
    hasUnfinished: visibleUnfinishedItems.length > 0,
    allCompleted: visibleItems.length > 0 && visibleUnfinishedItems.length === 0 && visibleCompletedItems.length === visibleItems.length,
  };
}

function parsePlanItems(value: unknown):
  | {
      items: Array<{
        work: string;
        detectionStandard: string;
        priority?: TodoPriority;
        tags?: string[];
        status?: TodoStatus;
        blockedReason?: string;
        planStepId?: string;
      }>;
    }
  | { error: string } {
  if (!Array.isArray(value)) {
    return { error: 'items must be an array of todo plan entries for plan_set' };
  }
  const items: Array<{
    work: string;
    detectionStandard: string;
    priority?: TodoPriority;
    tags?: string[];
    planStepId?: string;
    status?: TodoStatus;
    blockedReason?: string;
  }> = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: `items[${index}] must be an object` };
    }
    const record = entry as Record<string, unknown>;
    const rawStatus = record.status;
    const normalizedStatus = normalizeStatus(rawStatus);
    if (rawStatus !== undefined && normalizedStatus === undefined) {
      return { error: `items[${index}].status must be pending, in_progress, or blocked` };
    }
    items.push({
      work: String(record.work ?? '').trim(),
      detectionStandard: String(record.detection_standard ?? '').trim(),
      priority: normalizePriority(record.priority),
      tags: normalizeTags(record.tags),
      status: normalizedStatus,
      blockedReason: String(record.blocked_reason ?? '').trim() || undefined,
      planStepId: String(record.plan_step_id ?? '').trim() || undefined,
    });
  }
  return { items };
}

export class TodoTool extends Tool {
  private readonly todoStore: TodoStore;
  private readonly resolveSessionId: () => string | undefined;
  private readonly resolveWorkspaceDir: () => string | undefined;
  private readonly resolveActivePlanId: () => string | undefined;

  constructor(options: TodoToolOptions) {
    super();
    this.todoStore = options.todoStore;
    this.resolveSessionId = options.resolveSessionId;
    this.resolveWorkspaceDir = options.resolveWorkspaceDir;
    this.resolveActivePlanId = options.resolveActivePlanId ?? (() => undefined);
  }

  get name(): string {
    return 'todo';
  }

  get description(): string {
    return 'Manage the todo execution protocol across session, workspace, or user scope. For multi-step work, use plan_set first to write the full remaining session plan in one call. Use add and update only for small manual corrections after the plan exists. Todo items are identified by task_id. Marking a todo completed requires task_id and evidence. If unfinished todos remain, continue execution or mark the active todo blocked with blocked_reason before stopping.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'plan_set', 'add', 'update', 'set_status', 'delete', 'clear_completed'],
          description: 'Action to perform. plan_set is the primary multi-step planning path and replaces the current unfinished plan in one call. add creates a single protocol todo, update revises work or detection standard, while set_status is the narrow status-change path used to report progress, blocking, or completion.',
        },
        scope: {
          type: 'string',
          enum: ['session', 'workspace', 'user'],
          description: 'Todo scope to read or mutate. Defaults to session when a session is active, otherwise workspace, otherwise user.',
        },
        work: {
          type: 'string',
          description: 'Required for add. The actual unit of work to perform. update can also replace it. Multi-step planning should prefer items with plan_set.',
        },
        detection_standard: {
          type: 'string',
          description: 'Required for add. Defines how the task is verified as complete. update can also replace it. Multi-step planning should prefer items with plan_set.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Optional priority for add or update.',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'blocked', 'completed'],
          description: 'Status for set_status only. Use set_status instead of update when changing execution state.',
        },
        task_id: {
          type: 'string',
          description: 'Todo item id for update, set_status, or delete. Required when changing or deleting an existing todo.',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Required when setting status=completed through set_status. Provide concise evidence lines proving the detection standard was met.',
        },
        blocked_reason: {
          type: 'string',
          description: 'Required when setting status=blocked through set_status. Explain what is missing, why it blocks progress, and what was already tried.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for add or update.',
        },
        items: {
          type: 'array',
          description: 'Required for plan_set. Replaces the current unfinished todo plan with this provided list while keeping completed evidence in history. Use this instead of a single umbrella todo when multiple milestones remain.',
          items: {
            type: 'object',
            properties: {
              work: {
                type: 'string',
                description: 'Required for each plan_set item. The actual unit of work to perform.',
              },
              detection_standard: {
                type: 'string',
                description: 'Required for each plan_set item. Defines how the item is verified as complete.',
              },
              priority: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: 'Optional priority for each plan_set item.',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'blocked'],
                description: 'Optional initial status for each plan_set item. completed is not allowed here.',
              },
              blocked_reason: {
                type: 'string',
                description: 'Required when a plan_set item starts as blocked.',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tags for each plan_set item.',
              },
              plan_step_id: {
                type: 'string',
                description: 'Optional approved plan step id for this todo item.',
              },
            },
            required: ['work', 'detection_standard'],
          },
        },
        include_completed: {
          type: 'boolean',
          description: 'For list only: include completed items in the response.',
        },
      },
      required: ['action'],
    };
  }

  async execute(args: Record<string, unknown>) {
    const action = String(args.action ?? '').trim().toLowerCase();
    const sessionId = this.resolveSessionId();
    const workspaceDir = this.resolveWorkspaceDir();
    const activePlanId = this.resolveActivePlanId();
    const defaultScope: TodoScope = sessionId ? 'session' : workspaceDir ? 'workspace' : 'user';
    const scope = normalizeScope(args.scope, defaultScope);

    try {
      if (args.id !== undefined) {
        return errorResult('todo uses task_id; id is not accepted');
      }
      switch (action) {
        case 'list':
          const protocol = this.todoStore.getProtocolState({
            scope,
            sessionId,
            workspaceDir,
          });
          return successResult(
            JSON.stringify(
              {
                ok: true,
                action,
                scope,
                protocol: sanitizeProtocolForTool(protocol),
              },
              null,
              2
            )
          );
        case 'plan_set': {
          const parsedPlanItems = parsePlanItems(args.items);
          if ('error' in parsedPlanItems) {
            return errorResult(parsedPlanItems.error);
          }
          const nextItems = this.todoStore.setTodoPlan({
            scope,
            sessionId,
            workspaceDir,
            items: parsedPlanItems.items,
            sourceSessionId: sessionId,
            planId: activePlanId,
          });
          return successResult(JSON.stringify({ ok: true, action, items: nextItems }, null, 2));
        }
        case 'add': {
          const work = String(args.work ?? '').trim();
          const detectionStandard = String(args.detection_standard ?? '').trim();
          if (!work) {
            return errorResult('work is required for add');
          }
          if (!detectionStandard) {
            return errorResult('detection_standard is required for add');
          }
          const item = this.todoStore.createTodo({
            scope,
            sessionId,
            workspaceDir,
            work,
            detectionStandard,
            priority: normalizePriority(args.priority),
            tags: normalizeTags(args.tags),
            sourceSessionId: sessionId,
            planId: activePlanId,
            planStepId: String(args.plan_step_id ?? '').trim() || undefined,
          });
          return successResult(JSON.stringify({ ok: true, action, item }, null, 2));
        }
        case 'update':
        case 'set_status': {
          const taskId = String(args.task_id ?? '').trim();
          if (!taskId) {
            return errorResult('task_id is required');
          }
          const status = normalizeStatus(args.status);
          if (action === 'set_status' && !status) {
            return errorResult('status is required for set_status');
          }
          if (
            action === 'set_status' &&
            (args.work !== undefined ||
              args.detection_standard !== undefined ||
              args.priority !== undefined ||
              args.tags !== undefined ||
              args.items !== undefined)
          ) {
            return errorResult('set_status only changes status, task_id, evidence, or blocked_reason');
          }
          if (
            action === 'update' &&
            (status !== undefined ||
              args.evidence !== undefined ||
              args.blocked_reason !== undefined)
          ) {
            return errorResult('update only revises work, detection_standard, priority, or tags; use set_status for execution state changes');
          }
          if (status === 'completed') {
            const evidence = normalizeEvidence(args.evidence);
            if (!evidence || evidence.length === 0) {
              return errorResult('status=completed requires task_id and evidence');
            }
          }
          if (status === 'blocked' && !String(args.blocked_reason ?? '').trim()) {
            return errorResult('status=blocked requires blocked_reason');
          }
          const item = this.todoStore.updateTodo(taskId, {
            scope,
            sessionId,
            workspaceDir,
            work: action === 'update' ? String(args.work ?? '').trim() || undefined : undefined,
            detectionStandard:
              action === 'update' ? String(args.detection_standard ?? '').trim() || undefined : undefined,
            priority: action === 'update' ? normalizePriority(args.priority) : undefined,
            status,
            tags: action === 'update' ? normalizeTags(args.tags) : undefined,
            completionTaskId: status === 'completed' ? taskId : undefined,
            evidence: status === 'completed' ? normalizeEvidence(args.evidence) : undefined,
            blockedReason: status === 'blocked' ? String(args.blocked_reason ?? '').trim() || undefined : undefined,
          });
          if (!item) {
            return errorResult(`todo not found: ${taskId}`);
          }
          return successResult(JSON.stringify({ ok: true, action, item }, null, 2));
        }
        case 'delete': {
          const taskId = String(args.task_id ?? '').trim();
          if (!taskId) {
            return errorResult('task_id is required for delete');
          }
          const success = this.todoStore.deleteTodo(taskId, { scope, sessionId, workspaceDir });
          return successResult(JSON.stringify({ ok: true, action, success }, null, 2));
        }
        case 'clear_completed': {
          const removed = this.todoStore.clearCompletedTodos({
            scope,
            sessionId,
            workspaceDir,
          });
          return successResult(JSON.stringify({ ok: true, action, removed }, null, 2));
        }
        default:
          return errorResult(`unknown action: ${action}`);
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
}

export function createTodoTool(options: TodoToolOptions): TodoTool {
  return new TodoTool(options);
}
