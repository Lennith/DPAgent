import * as fs from 'fs';
import * as path from 'path';
import type { DraftTurnRecord, InterruptedArtifact, ContextRef, SideEffectLedgerEntry } from '../types.js';
import { ContextEventStore } from './ContextEventStore.js';

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InterruptedTurnStore {
  private static readonly DRAFT_FILE = 'interrupted-draft.json';
  private static readonly ARTIFACT_FILE = 'interrupted-artifact.json';
  private static readonly SIDE_EFFECT_LEDGER_FILE = 'interrupted-side-effects.json';
  private static readonly MAX_LEDGER_ENTRIES = 100;
  private readonly eventStore: ContextEventStore;

  constructor(eventStore: ContextEventStore) {
    this.eventStore = eventStore;
  }

  loadDraft(ref: ContextRef): DraftTurnRecord | undefined {
    return this.readJson<DraftTurnRecord>(this.draftPath(ref));
  }

  saveDraft(ref: ContextRef, draft: DraftTurnRecord): DraftTurnRecord {
    return this.writeJson(this.draftPath(ref), draft);
  }

  clearDraft(ref: ContextRef): void {
    this.removeFile(this.draftPath(ref));
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
