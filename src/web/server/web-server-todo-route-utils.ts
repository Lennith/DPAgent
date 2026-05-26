import type { TodoPriority, TodoScope, TodoStatus } from '../../todo/index.js';

export function normalizeTodoScope(value: unknown, fallback: TodoScope): TodoScope {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'session' || normalized === 'workspace' || normalized === 'user') {
    return normalized;
  }
  return fallback;
}

export function normalizeTodoStatus(value: unknown): TodoStatus | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'pending' ||
    normalized === 'in_progress' ||
    normalized === 'completed' ||
    normalized === 'blocked'
  ) {
    return normalized;
  }
  return undefined;
}

export function normalizeTodoPriority(value: unknown): TodoPriority | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return undefined;
}

export function normalizeTodoTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : [];
}

export function listUnexpectedTodoKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): string[] {
  return Object.keys(record).filter((key) => !allowedKeys.has(key));
}
