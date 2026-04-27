import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type TodoScope = 'session' | 'workspace' | 'user';
export type TodoStatus = 'pending' | 'in_progress' | 'blocked' | 'completed';
export type TodoPriority = 'low' | 'medium' | 'high';
type TodoWritableStatus = Exclude<TodoStatus, 'completed'>;

export interface TodoItem {
  id: string;
  scope: TodoScope;
  namespace: string;
  namespaceLabel: string;
  work: string;
  detectionStandard: string;
  title: string;
  details?: string;
  status: TodoStatus;
  priority: TodoPriority;
  tags: string[];
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  completionTaskId?: string;
  evidence?: string[];
  blockedReason?: string;
}

export interface TodoProtocolState {
  items: TodoItem[];
  unfinishedItems: TodoItem[];
  activeItem: TodoItem | null;
  blockedItem: TodoItem | null;
  pendingItems: TodoItem[];
  completedItems: TodoItem[];
  hasUnfinished: boolean;
  allCompleted: boolean;
}

interface TodoBucket {
  scope: TodoScope;
  namespace: string;
  namespaceLabel: string;
  items: TodoItem[];
}

interface TodoDraftItemInput {
  work: string;
  detectionStandard: string;
  priority?: TodoPriority;
  tags?: string[];
  sourceSessionId?: string;
  status?: TodoWritableStatus;
  blockedReason?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashText(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/i)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
    )
  );
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
}

function compactPromptText(value: string, maxChars: number): string {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), maxChars);
}

function normalizeEvidence(value: string[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0)
    .slice(0, 8);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeWritableStatus(value: TodoStatus | undefined): TodoWritableStatus {
  if (value === 'in_progress' || value === 'blocked') {
    return value;
  }
  return 'pending';
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    value === 'pending' ||
    value === 'in_progress' ||
    value === 'blocked' ||
    value === 'completed'
  );
}

function normalizeTodoTags(
  work: string,
  detectionStandard: string,
  tags: string[] | undefined
): string[] {
  return Array.from(
    new Set([...(tags ?? []), ...tokenize(work), ...tokenize(detectionStandard)])
  ).slice(0, 12);
}

function isCompleted(item: TodoItem): boolean {
  return item.status === 'completed' && !!item.completionTaskId && Array.isArray(item.evidence) && item.evidence.length > 0;
}

function legacyTitle(item: Pick<TodoItem, 'work'>): string {
  return item.work;
}

function legacyDetails(item: Pick<TodoItem, 'detectionStandard'>): string {
  return item.detectionStandard;
}

export class TodoStore {
  private readonly baseDir: string;
  private readonly bucketsDir: string;
  private readonly defaultUserNamespace = 'default-user';

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.bucketsDir = path.join(this.baseDir, 'buckets');
    fs.mkdirSync(this.bucketsDir, { recursive: true });
  }

  resolveSessionNamespace(sessionId: string): { namespace: string; namespaceLabel: string } {
    const normalized = String(sessionId ?? '').trim();
    if (!normalized) {
      throw new Error('sessionId is required');
    }
    return {
      namespace: normalized,
      namespaceLabel: normalized,
    };
  }

  resolveWorkspaceNamespace(workspaceDir: string): { namespace: string; namespaceLabel: string } {
    const normalized = path.resolve(workspaceDir);
    return {
      namespace: hashText(normalized),
      namespaceLabel: normalized,
    };
  }

  resolveUserNamespace(): { namespace: string; namespaceLabel: string } {
    return {
      namespace: this.defaultUserNamespace,
      namespaceLabel: 'default user',
    };
  }

  listTodos(input: {
    scope?: TodoScope;
    sessionId?: string;
    workspaceDir?: string;
    includeCompleted?: boolean;
  } = {}): TodoItem[] {
    const target = this.resolveTarget(input);
    const bucket = this.loadBucket(target.scope, target.namespace, target.namespaceLabel);
    return this.sortItems(
      bucket.items.filter((item) => (input.includeCompleted === true ? true : !isCompleted(item)))
    );
  }

  getProtocolState(input: { scope?: TodoScope; sessionId?: string; workspaceDir?: string }): TodoProtocolState {
    const items = this.listTodos({ ...input, includeCompleted: true });
    const activeItem = items.find((item) => item.status === 'in_progress') ?? null;
    const blockedItem = items.find((item) => item.status === 'blocked') ?? null;
    const pendingItems = items.filter((item) => item.status === 'pending');
    const completedItems = items.filter((item) => isCompleted(item));
    const unfinishedItems = items.filter((item) => !isCompleted(item));
    return {
      items,
      unfinishedItems,
      activeItem,
      blockedItem,
      pendingItems,
      completedItems,
      hasUnfinished: unfinishedItems.length > 0,
      allCompleted: items.length > 0 && unfinishedItems.length === 0,
    };
  }

  createTodo(input: {
    scope?: TodoScope;
    sessionId?: string;
    workspaceDir?: string;
    work: string;
    detectionStandard: string;
    priority?: TodoPriority;
    tags?: string[];
    sourceSessionId?: string;
  }): TodoItem {
    const target = this.resolveTarget(input);
    const bucket = this.loadBucket(target.scope, target.namespace, target.namespaceLabel);
    if (bucket.items.length >= 128) {
      throw new Error('todo capacity reached; clear completed todos or replan before adding another todo');
    }
    const now = nowIso();
    const todo = this.createDraftTodoItem(target, {
      work: input.work,
      detectionStandard: input.detectionStandard,
      priority: input.priority,
      tags: input.tags,
      sourceSessionId: input.sourceSessionId,
      status: 'pending',
    }, now);
    bucket.items = [todo, ...bucket.items].slice(0, 128);
    this.saveBucket(bucket);
    return todo;
  }

  setTodoPlan(input: {
    scope?: TodoScope;
    sessionId?: string;
    workspaceDir?: string;
    items: Array<{
      work: string;
      detectionStandard: string;
      priority?: TodoPriority;
      tags?: string[];
      status?: TodoStatus;
      blockedReason?: string;
    }>;
    sourceSessionId?: string;
  }): TodoItem[] {
    const target = this.resolveTarget(input);
    const bucket = this.loadBucket(target.scope, target.namespace, target.namespaceLabel);
    const now = nowIso();
    const completedRows = bucket.items.filter((item) => item.status === 'completed');
    const completedArchive = completedRows.filter((item) => isCompleted(item));
    const incompleteCompletedRows = completedRows.filter((item) => !isCompleted(item));
    const unfinishedItems = bucket.items.filter((item) => item.status !== 'completed');
    if (incompleteCompletedRows.length > 0) {
      throw new Error('plan_set cannot rewrite completed todos that are missing completion evidence; repair them with set_status first');
    }
    const nextItems = (input.items ?? []).map((item) => {
      if (item.status !== undefined && !isTodoStatus(item.status)) {
        throw new Error('plan_set items must use pending, in_progress, or blocked status');
      }
      if (item.status === 'completed') {
        throw new Error('plan_set does not accept completed todos');
      }
      return this.createDraftTodoItem(
        target,
        {
          work: item.work,
          detectionStandard: item.detectionStandard,
          priority: item.priority,
          tags: item.tags,
          sourceSessionId: input.sourceSessionId,
          status: normalizeWritableStatus(item.status),
          blockedReason: item.blockedReason,
        },
        now
      );
    });
    const inProgressCount = nextItems.filter((item) => item.status === 'in_progress').length;
    if (inProgressCount > 1) {
      throw new Error('plan_set allows at most one in_progress todo');
    }
    if (nextItems.length === 0 && unfinishedItems.length > 0) {
      throw new Error('plan_set cannot clear unfinished todos');
    }
    if (nextItems.length + completedArchive.length > 128) {
      throw new Error('plan_set cannot evict completed history; clear completed todos before expanding the remaining plan');
    }
    bucket.items = [...nextItems, ...completedArchive];
    this.saveBucket(bucket);
    return this.sortItems(nextItems);
  }

  updateTodo(
    id: string,
    input: {
      scope?: TodoScope;
      sessionId?: string;
      workspaceDir?: string;
      work?: string;
      detectionStandard?: string;
      priority?: TodoPriority;
      status?: TodoStatus;
      tags?: string[];
      completionTaskId?: string;
      evidence?: string[];
      blockedReason?: string;
    }
  ): TodoItem | null {
    const target = this.resolveTarget(input);
    const bucket = this.loadBucket(target.scope, target.namespace, target.namespaceLabel);
    const existing = bucket.items.find((item) => item.id === id);
    if (!existing) {
      return null;
    }

    if (input.status !== undefined && !isTodoStatus(input.status)) {
      throw new Error('invalid todo status');
    }
    const nextStatus = input.status ?? existing.status;
    const mutatesPlanFields =
      input.work !== undefined ||
      input.detectionStandard !== undefined ||
      input.priority !== undefined ||
      input.tags !== undefined;
    const mutatesStatusFields =
      input.status !== undefined ||
      input.completionTaskId !== undefined ||
      input.evidence !== undefined ||
      input.blockedReason !== undefined;
    if (existing.status === 'completed' && isCompleted(existing) && (mutatesPlanFields || mutatesStatusFields)) {
      throw new Error('completed todos are immutable once completion evidence is recorded');
    }
    if (mutatesPlanFields && (existing.status === 'completed' || nextStatus === 'completed')) {
      throw new Error('completed todos cannot change work, detectionStandard, priority, or tags');
    }
    if (existing.status === 'completed' && nextStatus !== 'completed') {
      throw new Error('completed todos cannot be reopened');
    }
    const work =
      input.work !== undefined
        ? truncate(String(input.work).trim() || existing.work, 160)
        : existing.work;
    const detectionStandard =
      input.detectionStandard !== undefined
        ? truncate(String(input.detectionStandard).trim() || existing.detectionStandard, 220)
        : existing.detectionStandard;

    if (!work) {
      throw new Error('work is required');
    }
    if (!detectionStandard) {
      throw new Error('detectionStandard is required');
    }

    const completionTaskId =
      input.completionTaskId !== undefined
        ? String(input.completionTaskId).trim() || undefined
        : existing.completionTaskId;
    const evidence = input.evidence !== undefined ? normalizeEvidence(input.evidence) : existing.evidence;
    const blockedReason =
      input.blockedReason !== undefined
        ? String(input.blockedReason).trim() || undefined
        : existing.blockedReason;

    if (nextStatus === 'completed') {
      if (!completionTaskId || !evidence || evidence.length === 0) {
        throw new Error('completed todos require completionTaskId and evidence');
      }
    }
    if (nextStatus === 'blocked' && !blockedReason) {
      throw new Error('blocked todos require blockedReason');
    }

    const next: TodoItem = {
      ...existing,
      work,
      detectionStandard,
      title: legacyTitle({ work }),
      details: legacyDetails({ detectionStandard }),
      priority: input.priority ?? existing.priority,
      status: nextStatus,
      tags:
        input.tags !== undefined
          ? Array.from(new Set(input.tags.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0))).slice(0, 12)
          : existing.tags,
      updatedAt: nowIso(),
      completedAt: nextStatus === 'completed' ? existing.completedAt ?? nowIso() : undefined,
      completionTaskId: nextStatus === 'completed' ? completionTaskId : undefined,
      evidence: nextStatus === 'completed' ? evidence : undefined,
      blockedReason: nextStatus === 'blocked' ? blockedReason : undefined,
    };

    bucket.items = bucket.items.map((item) => (item.id === id ? next : item));
    if (next.status === 'in_progress') {
      bucket.items = bucket.items.map((item) => {
        if (item.id === id || item.status !== 'in_progress') {
          return item;
        }
        return {
          ...item,
          status: 'pending',
          updatedAt: next.updatedAt,
        };
      });
    }
    this.saveBucket(bucket);
    return next;
  }

  deleteTodo(id: string, input: { scope?: TodoScope; sessionId?: string; workspaceDir?: string }): boolean {
    const target = this.resolveTarget(input);
    const bucket = this.loadBucket(target.scope, target.namespace, target.namespaceLabel);
    const before = bucket.items.length;
    bucket.items = bucket.items.filter((item) => item.id !== id);
    if (bucket.items.length === before) {
      return false;
    }
    this.saveBucket(bucket);
    return true;
  }

  clearCompletedTodos(input: { scope?: TodoScope; sessionId?: string; workspaceDir?: string }): number {
    const target = this.resolveTarget(input);
    const bucket = this.loadBucket(target.scope, target.namespace, target.namespaceLabel);
    const completedRows = bucket.items.filter((item) => item.status === 'completed');
    const incompleteCompletedRows = completedRows.filter((item) => !isCompleted(item));
    if (incompleteCompletedRows.length > 0) {
      throw new Error(
        'clear_completed cannot delete completed todos that are missing completion evidence; repair them with set_status first'
      );
    }
    if (completedRows.length === 0) {
      return 0;
    }
    bucket.items = bucket.items.filter((item) => item.status !== 'completed');
    this.saveBucket(bucket);
    return completedRows.length;
  }

  getPromptSegment(input: { sessionId?: string; workspaceDir?: string }): string {
    const state = this.getProtocolState({
      sessionId: input.sessionId,
      workspaceDir: input.workspaceDir,
    });
    if (state.items.length === 0) {
      return '';
    }

    const lines = [
      '## Todo Snapshot',
      '- Session todos are an execution protocol, not a scratchpad.',
      '- If unfinished todos exist, keep aligning with them before claiming completion.',
      '- For completed todos, completion must already include task_id (the todo item id) and evidence.',
    ];

    if (state.activeItem) {
      lines.push(
        `- active task_id=${state.activeItem.id} work="${compactPromptText(state.activeItem.work, 120)}" detection_standard="${compactPromptText(state.activeItem.detectionStandard, 140)}" status=${state.activeItem.status}`
      );
    }

    if (state.blockedItem) {
      lines.push(
        `- blocked task_id=${state.blockedItem.id} work="${compactPromptText(state.blockedItem.work, 120)}" reason="${compactPromptText(state.blockedItem.blockedReason ?? '', 140)}"`
      );
    }

    for (const item of [...state.pendingItems, ...state.completedItems.slice(0, 2)].slice(0, 6)) {
      if (isCompleted(item)) {
        lines.push(
          `- completed task_id=${item.id} work="${compactPromptText(item.work, 100)}" evidence_record=${compactPromptText(item.completionTaskId ?? '', 80)}`
        );
        continue;
      }
      lines.push(
        `- pending task_id=${item.id} work="${compactPromptText(item.work, 120)}" detection_standard="${compactPromptText(item.detectionStandard, 140)}"`
      );
    }

    return lines.join('\n');
  }

  private sortItems(items: TodoItem[]): TodoItem[] {
    return [...items].sort((left, right) => {
      if (left.status !== right.status) {
        if (left.status === 'in_progress') return -1;
        if (right.status === 'in_progress') return 1;
        if (left.status === 'blocked') return -1;
        if (right.status === 'blocked') return 1;
        if (left.status === 'pending') return -1;
        if (right.status === 'pending') return 1;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  private createDraftTodoItem(
    target: { scope: TodoScope; namespace: string; namespaceLabel: string },
    input: TodoDraftItemInput,
    timestamp: string
  ): TodoItem {
    const work = truncate(String(input.work ?? '').trim(), 160);
    const detectionStandard = truncate(String(input.detectionStandard ?? '').trim(), 220);
    if (!work) {
      throw new Error('work is required');
    }
    if (!detectionStandard) {
      throw new Error('detectionStandard is required');
    }
    const status = normalizeWritableStatus(input.status);
    const blockedReason =
      status === 'blocked'
        ? truncate(String(input.blockedReason ?? '').trim(), 220) || undefined
        : undefined;
    if (status === 'blocked' && !blockedReason) {
      throw new Error('blocked todos require blockedReason');
    }
    return {
      id: `todo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      scope: target.scope,
      namespace: target.namespace,
      namespaceLabel: target.namespaceLabel,
      work,
      detectionStandard,
      title: legacyTitle({ work }),
      details: legacyDetails({ detectionStandard }),
      status,
      priority: input.priority ?? 'medium',
      tags: normalizeTodoTags(work, detectionStandard, input.tags),
      sourceSessionId: input.sourceSessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      blockedReason,
    };
  }

  private resolveTarget(input: {
    scope?: TodoScope;
    sessionId?: string;
    workspaceDir?: string;
  }): { scope: TodoScope; namespace: string; namespaceLabel: string } {
    const scope =
      input.scope ??
      (input.sessionId ? 'session' : input.workspaceDir ? 'workspace' : 'user');
    if (scope === 'session') {
      return {
        scope,
        ...this.resolveSessionNamespace(String(input.sessionId ?? '').trim()),
      };
    }
    if (scope === 'workspace') {
      if (!input.workspaceDir) {
        throw new Error('workspaceDir is required for workspace todos');
      }
      return {
        scope,
        ...this.resolveWorkspaceNamespace(input.workspaceDir),
      };
    }
    return {
      scope,
      ...this.resolveUserNamespace(),
    };
  }

  private bucketFilePath(scope: TodoScope, namespace: string): string {
    const dir = path.join(this.bucketsDir, scope);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${namespace}.json`);
  }

  private loadBucket(scope: TodoScope, namespace: string, namespaceLabel: string): TodoBucket {
    const filePath = this.bucketFilePath(scope, namespace);
    if (!fs.existsSync(filePath)) {
      return { scope, namespace, namespaceLabel, items: [] };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TodoBucket;
      const items = Array.isArray(parsed.items) ? parsed.items.map((item) => this.normalizeItem(scope, namespace, namespaceLabel, item)) : [];
      return {
        scope,
        namespace,
        namespaceLabel,
        items,
      };
    } catch {
      return { scope, namespace, namespaceLabel, items: [] };
    }
  }

  private normalizeItem(scope: TodoScope, namespace: string, namespaceLabel: string, raw: unknown): TodoItem {
    const item = (raw ?? {}) as Partial<TodoItem> & { title?: string; details?: string };
    const work = truncate(String(item.work ?? item.title ?? '').trim() || 'Untitled task', 160);
    const detectionStandard = truncate(String(item.detectionStandard ?? item.details ?? '').trim() || 'Verify the requested outcome is complete.', 220);
    const evidence = normalizeEvidence(item.evidence);
    return {
      id: String(item.id ?? `todo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`),
      scope,
      namespace,
      namespaceLabel,
      work,
      detectionStandard,
      title: legacyTitle({ work }),
      details: legacyDetails({ detectionStandard }),
      status:
        isTodoStatus(item.status)
          ? item.status
          : 'pending',
      priority: item.priority === 'low' || item.priority === 'medium' || item.priority === 'high' ? item.priority : 'medium',
      tags: Array.isArray(item.tags)
        ? item.tags.map((entry) => String(entry ?? '').trim()).filter((entry) => entry.length > 0).slice(0, 12)
        : [],
      sourceSessionId: item.sourceSessionId ? String(item.sourceSessionId) : undefined,
      createdAt: String(item.createdAt ?? nowIso()),
      updatedAt: String(item.updatedAt ?? item.createdAt ?? nowIso()),
      completedAt: item.completedAt ? String(item.completedAt) : undefined,
      completionTaskId: item.completionTaskId ? String(item.completionTaskId).trim() || undefined : undefined,
      evidence,
      blockedReason: item.blockedReason ? String(item.blockedReason).trim() || undefined : undefined,
    };
  }

  private saveBucket(bucket: TodoBucket): void {
    fs.writeFileSync(
      this.bucketFilePath(bucket.scope, bucket.namespace),
      JSON.stringify(bucket, null, 2),
      'utf-8'
    );
  }
}
