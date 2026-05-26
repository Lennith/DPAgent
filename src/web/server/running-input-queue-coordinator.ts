import type { ContextRef, RunningInputInsertion, RunningInputQueueItem } from '../../types.js';
import { isSameContextRef } from './web-server-shared.js';

export class RunningInputQueueCoordinator {
  private readonly itemsByContext = new Map<string, RunningInputQueueItem[]>();
  private sequence = 0;

  enqueue(input: {
    context: ContextRef;
    runId: string;
    prompt: string;
    clientRequestId?: string;
    selectedAgentName?: string;
    fileReferences?: string[];
  }): RunningInputQueueItem {
    const now = new Date().toISOString();
    const item: RunningInputQueueItem = {
      id: this.nextId(),
      runId: input.runId,
      context: input.context,
      prompt: input.prompt,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      ...(input.selectedAgentName ? { selectedAgentName: input.selectedAgentName } : {}),
      ...(input.fileReferences && input.fileReferences.length > 0 ? { fileReferences: [...input.fileReferences] } : {}),
      createdAt: now,
      updatedAt: now,
      status: 'queued_next',
    };
    const key = this.contextKey(input.context);
    const current = this.itemsByContext.get(key) ?? [];
    current.push(item);
    this.itemsByContext.set(key, current);
    return this.cloneItem(item);
  }

  requeueFront(context: ContextRef, item: RunningInputQueueItem): RunningInputQueueItem {
    const key = this.contextKey(context);
    const current = this.itemsByContext.get(key) ?? [];
    const restored: RunningInputQueueItem = {
      ...this.cloneItem(item),
      context,
      status: 'queued_next',
      updatedAt: new Date().toISOString(),
    };
    delete restored.insertRequestedAt;
    current.unshift(restored);
    this.itemsByContext.set(key, current);
    return this.cloneItem(restored);
  }

  list(context: ContextRef): RunningInputQueueItem[] {
    return (this.itemsByContext.get(this.contextKey(context)) ?? []).map((item) => this.cloneItem(item));
  }

  requestInsert(input: { context: ContextRef; runId: string; itemId: string }): RunningInputQueueItem | null {
    const item = this.findItem(input.context, input.itemId);
    if (!item || item.status === 'insert_requested') {
      return null;
    }
    const now = new Date().toISOString();
    item.runId = input.runId;
    item.status = 'insert_requested';
    item.insertRequestedAt = now;
    item.updatedAt = now;
    return this.cloneItem(item);
  }

  consumeInsert(context: ContextRef, runId: string): RunningInputInsertion | null {
    const key = this.contextKey(context);
    const current = this.itemsByContext.get(key) ?? [];
    const index = current.findIndex((item) => item.runId === runId && item.status === 'insert_requested');
    if (index < 0) {
      return null;
    }
    const [item] = current.splice(index, 1);
    this.pruneIfEmpty(key, current);
    return item
      ? {
          itemId: item.id,
          prompt: item.prompt,
          ...(item.selectedAgentName ? { selectedAgentName: item.selectedAgentName } : {}),
          ...(item.fileReferences && item.fileReferences.length > 0 ? { fileReferences: [...item.fileReferences] } : {}),
        }
      : null;
  }

  dequeueNext(context: ContextRef): RunningInputQueueItem | null {
    const item = this.peekNext(context);
    if (!item) {
      return null;
    }
    return this.remove(context, item.id);
  }

  peekNext(context: ContextRef): RunningInputQueueItem | null {
    const item = (this.itemsByContext.get(this.contextKey(context)) ?? []).find((candidate) => candidate.status === 'queued_next');
    return item ? this.cloneItem(item) : null;
  }

  remove(context: ContextRef, itemId: string): RunningInputQueueItem | null {
    const key = this.contextKey(context);
    const current = this.itemsByContext.get(key) ?? [];
    const index = current.findIndex((item) => item.id === itemId);
    if (index < 0) {
      return null;
    }
    const [item] = current.splice(index, 1);
    this.pruneIfEmpty(key, current);
    return item ? this.cloneItem(item) : null;
  }

  releaseInsertRequestsForRun(context: ContextRef, runId: string): boolean {
    let changed = false;
    for (const item of this.itemsByContext.get(this.contextKey(context)) ?? []) {
      if (item.runId !== runId || item.status !== 'insert_requested') {
        continue;
      }
      item.status = 'queued_next';
      delete item.insertRequestedAt;
      item.updatedAt = new Date().toISOString();
      changed = true;
    }
    return changed;
  }

  hasQueued(context: ContextRef): boolean {
    return this.list(context).some((item) => item.status === 'queued_next');
  }

  private findItem(context: ContextRef, itemId: string): RunningInputQueueItem | undefined {
    return (this.itemsByContext.get(this.contextKey(context)) ?? []).find(
      (item) => item.id === itemId && isSameContextRef(item.context, context)
    );
  }

  private pruneIfEmpty(key: string, items: RunningInputQueueItem[]): void {
    if (items.length === 0) {
      this.itemsByContext.delete(key);
      return;
    }
    this.itemsByContext.set(key, items);
  }

  private nextId(): string {
    this.sequence += 1;
    return `rin-${Date.now().toString(36)}-${this.sequence.toString(36)}`;
  }

  private contextKey(context: ContextRef): string {
    return `${context.scope}:${context.namespace}`;
  }

  private cloneItem(item: RunningInputQueueItem): RunningInputQueueItem {
    return {
      ...item,
      context: { ...item.context },
      ...(item.selectedAgentName ? { selectedAgentName: item.selectedAgentName } : {}),
      ...(item.fileReferences ? { fileReferences: [...item.fileReferences] } : {}),
    };
  }
}
