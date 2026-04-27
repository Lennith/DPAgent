import * as fs from 'node:fs';
import * as path from 'node:path';

export type GovernanceAuditKind =
  | 'memory_written'
  | 'memory_triggered'
  | 'memory_replaced'
  | 'memory_removed'
  | 'memory_organize_queued'
  | 'memory_organized'
  | 'memory_organize_failed'
  | 'memory_conflict_skipped'
  | 'skill_triggered'
  | 'skill_approved'
  | 'skill_rejected'
  | 'skill_rolled_back'
  | 'skill_pack_published'
  | 'skill_pack_activated'
  | 'skill_pack_rolled_back'
  | 'toolset_preset_updated'
  | 'toolset_preset_cleared'
  | 'session_toolset_overridden';

export interface GovernanceAuditEvent {
  id: string;
  kind: GovernanceAuditKind;
  title: string;
  detail?: string;
  sessionId?: string;
  workspaceDir?: string;
  entityType?: 'memory' | 'skill' | 'skill_pack' | 'toolset';
  entityId?: string;
  status: 'info' | 'success' | 'warning';
  createdAt: string;
  metadata?: Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class GovernanceAuditStore {
  private readonly filePath: string;
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.filePath = path.join(this.baseDir, 'events.jsonl');
    this.ensureStorageReady();
  }

  private ensureStorageReady(): void {
    fs.mkdirSync(this.baseDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '', 'utf-8');
    }
  }

  append(input: {
    kind: GovernanceAuditKind;
    title: string;
    detail?: string;
    sessionId?: string;
    workspaceDir?: string;
    entityType?: GovernanceAuditEvent['entityType'];
    entityId?: string;
    status?: GovernanceAuditEvent['status'];
    metadata?: Record<string, unknown>;
  }): GovernanceAuditEvent {
    this.ensureStorageReady();
    const event: GovernanceAuditEvent = {
      id: `audit-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      kind: input.kind,
      title: input.title.trim(),
      detail: input.detail?.trim() || undefined,
      sessionId: input.sessionId?.trim() || undefined,
      workspaceDir: input.workspaceDir ? path.resolve(input.workspaceDir) : undefined,
      entityType: input.entityType,
      entityId: input.entityId?.trim() || undefined,
      status: input.status ?? 'info',
      createdAt: nowIso(),
      metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined,
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
    return event;
  }

  list(filters: {
    sessionId?: string;
    workspaceDir?: string;
    limit?: number;
    kinds?: GovernanceAuditKind[];
  } = {}): GovernanceAuditEvent[] {
    this.ensureStorageReady();
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const limit = Math.max(1, Math.min(200, Math.floor(filters.limit ?? 40)));
    const kindSet = filters.kinds && filters.kinds.length > 0 ? new Set(filters.kinds) : null;
    const workspaceDir = filters.workspaceDir ? path.resolve(filters.workspaceDir) : undefined;
    const lines = fs
      .readFileSync(this.filePath, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const out: GovernanceAuditEvent[] = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const item = JSON.parse(lines[index]) as GovernanceAuditEvent;
        if (filters.sessionId && item.sessionId !== filters.sessionId) {
          continue;
        }
        if (workspaceDir && path.resolve(item.workspaceDir ?? '') !== workspaceDir) {
          continue;
        }
        if (kindSet && !kindSet.has(item.kind)) {
          continue;
        }
        out.push(item);
        if (out.length >= limit) {
          break;
        }
      } catch {
        // ignore malformed lines
      }
    }
    return out;
  }
}
