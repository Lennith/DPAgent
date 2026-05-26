import * as fs from 'fs';
import * as path from 'path';
import type {
  DraftTurnRecord,
  InterruptedArtifact,
  ContextRef,
  ReplayCheckpointSnapshot,
  SideEffectLedgerEntry,
} from '../types.js';
import { ContextEventStore } from './ContextEventStore.js';

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InterruptedTurnStore {
  private static readonly DRAFT_FILE = 'interrupted-draft.json';
  private static readonly DRAFT_CHECKPOINTS_FILE = 'interrupted-draft-checkpoints.jsonl';
  private static readonly ARTIFACT_FILE = 'interrupted-artifact.json';
  private static readonly SIDE_EFFECT_LEDGER_FILE = 'interrupted-side-effects.json';
  private static readonly MAX_LEDGER_ENTRIES = 100;
  private readonly eventStore: ContextEventStore;

  constructor(eventStore: ContextEventStore) {
    this.eventStore = eventStore;
  }

  loadDraft(ref: ContextRef): DraftTurnRecord | undefined {
    const header = this.readJson<DraftTurnRecord>(this.draftPath(ref));
    if (!header) {
      return undefined;
    }
    const checkpoint = this.readLatestDraftCheckpoint(ref, header) ?? header.checkpoint;
    const draft: DraftTurnRecord = {
      ...header,
      updatedAt: checkpoint?.observedAt ?? header.updatedAt,
      checkpoint,
    };
    if (!checkpoint) {
      delete draft.checkpoint;
    }
    return cloneRecord(draft);
  }

  saveDraft(ref: ContextRef, draft: DraftTurnRecord): DraftTurnRecord {
    const checkpoint = draft.checkpoint;
    const header = { ...draft };
    delete header.checkpoint;
    this.writeJson(this.draftPath(ref), header);
    if (checkpoint) {
      this.appendDraftCheckpoint(ref, header, checkpoint);
    }
    return cloneRecord(draft);
  }

  appendDraftCheckpoint(
    ref: ContextRef,
    draft: Omit<DraftTurnRecord, 'checkpoint'>,
    checkpoint: ReplayCheckpointSnapshot
  ): DraftTurnRecord {
    const checkpointPath = this.draftCheckpointPath(ref);
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    this.ensureAppendStartsOnFreshJsonlLine(checkpointPath);
    fs.appendFileSync(
      checkpointPath,
      `${JSON.stringify({
        draftId: draft.draftId,
        turnId: draft.turnId,
        runId: draft.runId,
        runFamilyId: draft.runFamilyId,
        observedAt: checkpoint.observedAt,
        checkpoint,
      })}\n`,
      'utf-8'
    );
    return cloneRecord({ ...draft, checkpoint });
  }

  clearDraft(ref: ContextRef): void {
    this.removeFile(this.draftPath(ref));
    this.removeFile(this.draftCheckpointPath(ref));
  }

  loadArtifact(ref: ContextRef): InterruptedArtifact | undefined {
    return this.readJson<InterruptedArtifact>(this.artifactPath(ref));
  }

  saveArtifact(ref: ContextRef, artifact: InterruptedArtifact): InterruptedArtifact {
    return this.writeJson(this.artifactPath(ref), artifact);
  }

  clearArtifact(ref: ContextRef): void {
    this.removeFile(this.artifactPath(ref));
  }

  loadSideEffectLedger(ref: ContextRef): SideEffectLedgerEntry[] {
    return this.readJson<SideEffectLedgerEntry[]>(this.sideEffectLedgerPath(ref)) ?? [];
  }

  saveSideEffectLedger(ref: ContextRef, entries: SideEffectLedgerEntry[]): SideEffectLedgerEntry[] {
    return this.writeJson(this.sideEffectLedgerPath(ref), this.normalizeSideEffectLedger(entries));
  }

  mergeSideEffectLedger(ref: ContextRef, entries: SideEffectLedgerEntry[]): SideEffectLedgerEntry[] {
    const existing = this.loadSideEffectLedger(ref);
    return this.saveSideEffectLedger(ref, [...existing, ...entries]);
  }

  clearSideEffectLedger(ref: ContextRef): void {
    this.removeFile(this.sideEffectLedgerPath(ref));
  }

  private draftPath(ref: ContextRef): string {
    return path.join(this.eventStore.getNamespacePath(ref), InterruptedTurnStore.DRAFT_FILE);
  }

  private draftCheckpointPath(ref: ContextRef): string {
    return path.join(this.eventStore.getNamespacePath(ref), InterruptedTurnStore.DRAFT_CHECKPOINTS_FILE);
  }

  private artifactPath(ref: ContextRef): string {
    return path.join(this.eventStore.getNamespacePath(ref), InterruptedTurnStore.ARTIFACT_FILE);
  }

  private sideEffectLedgerPath(ref: ContextRef): string {
    return path.join(this.eventStore.getNamespacePath(ref), InterruptedTurnStore.SIDE_EFFECT_LEDGER_FILE);
  }

  private readJson<T>(filePath: string): T | undefined {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    try {
      return cloneRecord(JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T);
    } catch {
      return undefined;
    }
  }

  private ensureAppendStartsOnFreshJsonlLine(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      return;
    }
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(1);
    try {
      fs.readSync(fd, buffer, 0, 1, stat.size - 1);
    } finally {
      fs.closeSync(fd);
    }
    if (buffer[0] !== 0x0a) {
      fs.appendFileSync(filePath, '\n', 'utf-8');
    }
  }

  private readLatestDraftCheckpoint(
    ref: ContextRef,
    draft: DraftTurnRecord
  ): ReplayCheckpointSnapshot | undefined {
    const filePath = this.draftCheckpointPath(ref);
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    let latest: ReplayCheckpointSnapshot | undefined;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as {
          draftId?: unknown;
          turnId?: unknown;
          runId?: unknown;
          runFamilyId?: unknown;
          checkpoint?: unknown;
        };
        if (
          parsed.draftId !== draft.draftId ||
          parsed.turnId !== draft.turnId ||
          parsed.runId !== draft.runId ||
          parsed.runFamilyId !== draft.runFamilyId ||
          !this.isReplayCheckpointSnapshot(parsed.checkpoint)
        ) {
          continue;
        }
        latest = parsed.checkpoint;
      } catch {
        // Keep the latest complete delta if the JSONL tail is corrupted.
      }
    }
    return latest ? cloneRecord(latest) : undefined;
  }

  private isReplayCheckpointSnapshot(value: unknown): value is ReplayCheckpointSnapshot {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const checkpoint = value as ReplayCheckpointSnapshot;
    return (
      typeof checkpoint.observedAt === 'string' &&
      typeof checkpoint.step === 'number' &&
      Array.isArray(checkpoint.messages) &&
      typeof checkpoint.bufferedEventCount === 'number'
    );
  }

  private writeJson<T>(filePath: string, value: T): T {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
    return cloneRecord(value);
  }

  private removeFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      return;
    }
    fs.rmSync(filePath, { force: true });
  }

  private normalizeSideEffectLedger(entries: SideEffectLedgerEntry[]): SideEffectLedgerEntry[] {
    const deduped = new Map<string, SideEffectLedgerEntry>();
    for (const entry of entries) {
      deduped.set(this.sideEffectLedgerFingerprint(entry), {
        ...entry,
        args: entry.args ? { ...entry.args } : undefined,
      });
    }
    return Array.from(deduped.values()).slice(-InterruptedTurnStore.MAX_LEDGER_ENTRIES);
  }

  private sideEffectLedgerFingerprint(entry: SideEffectLedgerEntry): string {
    return JSON.stringify({
      toolName: entry.toolName,
      toolCallId: entry.toolCallId ?? '',
      args: entry.args ?? null,
      resultSuccess: entry.resultSuccess ?? null,
      resultSummary: entry.resultSummary,
    });
  }
}
