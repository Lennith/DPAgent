import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildPromptFingerprint,
  containsAnyPhrase,
  extractChecklistItems,
  extractCommandCandidates,
  looksLikeFailure,
  normalizeWorkflowText,
  slugifyWorkflowText,
  tokenizeWorkflowText,
} from '../utils/workflow-signal.js';

export type MemoryScope = 'workspace' | 'user';
export type MemoryEntryStatus = 'active' | 'superseded' | 'expired';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  namespace: string;
  namespaceLabel: string;
  title: string;
  content: string;
  keywords: string[];
  workspaceDir?: string;
  sourceSessionId?: string;
  lineageId: string;
  version: number;
  status: MemoryEntryStatus;
  supersededAt?: string;
  supersededById?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySuggestion {
  id: string;
  scope: MemoryScope;
  namespace: string;
  namespaceLabel: string;
  title: string;
  content: string;
  keywords: string[];
  workspaceDir?: string;
  sourceSessionId?: string;
  reason?: string;
  lineageId: string;
  versionHint: number;
  expiresAt?: string;
  triggerCount?: number;
  createdAt: string;
  updatedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedAt?: string;
  reviewNote?: string;
  approvedEntryId?: string;
}

interface MemoryBucket {
  scope: MemoryScope;
  namespace: string;
  namespaceLabel: string;
  entries: MemoryEntry[];
}

interface NormalizedMemoryInput {
  scope: MemoryScope;
  namespace: string;
  namespaceLabel: string;
  title: string;
  content: string;
  keywords: string[];
  workspaceDir?: string;
  sourceSessionId?: string;
  reason?: string;
  lineageKey?: string;
  lineageId: string;
  expiresAt?: string;
  triggerCount?: number;
}

export interface PendingMemoryFilters {
  sessionId?: string;
  workspaceDir?: string;
}

export interface MemorySearchResult {
  score: number;
  entry: MemoryEntry;
  excerpt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashText(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function normalizeWorkspacePathForIdentity(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\//g, path.sep);
  if (process.platform !== 'win32') {
    return resolved;
  }
  return resolved.toLowerCase();
}

export class MemoryStore {
  private readonly baseDir: string;
  private readonly entriesDir: string;
  private readonly pendingDir: string;
  private readonly defaultUserNamespace = 'default-user';

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.entriesDir = path.join(this.baseDir, 'entries');
    this.pendingDir = path.join(this.baseDir, 'pending');
    fs.mkdirSync(this.entriesDir, { recursive: true });
    fs.mkdirSync(this.pendingDir, { recursive: true });
  }

  resolveWorkspaceNamespace(workspaceDir: string): { namespace: string; namespaceLabel: string } {
    const normalized = normalizeWorkspacePathForIdentity(workspaceDir);
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

  listEntries(input: {
    workspaceDir?: string;
    includeUser?: boolean;
    includeExpired?: boolean;
    includeSuperseded?: boolean;
  } = {}): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    if (input.workspaceDir) {
      const workspace = this.resolveWorkspaceNamespace(input.workspaceDir);
      out.push(
        ...this.filterVisibleEntries(
          this.loadBucket('workspace', workspace.namespace, workspace.namespaceLabel).entries,
          input
        )
      );
    }
    if (input.includeUser !== false) {
      const user = this.resolveUserNamespace();
      out.push(
        ...this.filterVisibleEntries(
          this.loadBucket('user', user.namespace, user.namespaceLabel).entries,
          input
        )
      );
    }
    return out.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.version - left.version);
  }

  readEntry(
    id: string,
    input: {
      workspaceDir?: string;
      includeUser?: boolean;
      includeExpired?: boolean;
      includeSuperseded?: boolean;
    } = {}
  ): MemoryEntry | undefined {
    return this.listEntries({
      ...input,
      includeExpired: input.includeExpired ?? true,
      includeSuperseded: input.includeSuperseded ?? true,
    }).find((item) => item.id === id);
  }

  getHistory(input: {
    id?: string;
    title?: string;
    workspaceDir?: string;
    includeUser?: boolean;
  }): MemoryEntry[] {
    const title = input.title?.trim();
    const entries = this.listEntries({
      workspaceDir: input.workspaceDir,
      includeUser: input.includeUser,
      includeExpired: true,
      includeSuperseded: true,
    });
    const seed =
      (input.id ? entries.find((item) => item.id === input.id) : undefined) ??
      (title ? entries.find((item) => normalizeWorkflowText(item.title) === normalizeWorkflowText(title)) : undefined);
    if (!seed) {
      return [];
    }
    return entries
      .filter((item) => item.lineageId === seed.lineageId)
      .sort((left, right) => right.version - left.version || right.updatedAt.localeCompare(left.updatedAt));
  }

  getPromptSegment(workspaceDir?: string): string {
    const entries = this.listEntries({ workspaceDir, includeUser: true });
    if (entries.length === 0) {
      return '';
    }
    const userEntries = this.limitEntriesByBudget(
      entries.filter((item) => item.scope === 'user'),
      1_400
    );
    const workspaceEntries = this.limitEntriesByBudget(
      entries.filter((item) => item.scope === 'workspace'),
      2_200
    );
    const lines: string[] = ['## Persistent Memory'];
    if (userEntries.length > 0) {
      lines.push('', '### User Memory');
      for (const entry of userEntries) {
        lines.push(`- ${entry.title}: ${truncate(entry.content, 180)}`);
      }
    }
    if (workspaceEntries.length > 0) {
      lines.push('', '### Workspace Memory');
      for (const entry of workspaceEntries) {
        const suffix = entry.version > 1 ? ` (v${entry.version})` : '';
        lines.push(`- ${entry.title}${suffix}: ${truncate(entry.content, 180)}`);
      }
    }
    return lines.join('\n');
  }

  writeMemory(input: {
    scope: MemoryScope;
    title: string;
    content: string;
    workspaceDir?: string;
    sourceSessionId?: string;
    reason?: string;
    keywords?: string[];
    expiresAt?: string;
  }): MemoryEntry {
    const normalized = this.normalizeInput(input);
    const duplicate = this.findActiveDuplicate(normalized);
    if (duplicate) {
      return this.touchEntry(duplicate, normalized);
    }
    return this.upsertEntry(normalized);
  }

  deleteEntry(
    id: string,
    input: {
      workspaceDir?: string;
      includeUser?: boolean;
    } = {}
  ): boolean {
    const entries = this.listEntries({
      workspaceDir: input.workspaceDir,
      includeUser: input.includeUser,
      includeExpired: true,
      includeSuperseded: true,
    });
    const target = entries.find((item) => item.id === id);
    if (!target) {
      return false;
    }
    const bucket = this.loadBucket(target.scope, target.namespace, target.namespaceLabel);
    bucket.entries = bucket.entries.filter((item) => item.id !== id);
    this.saveBucket(bucket);
    return true;
  }

  replaceEntry(
    id: string,
    input: {
      title?: string;
      content: string;
      workspaceDir?: string;
      sourceSessionId?: string;
      reason?: string;
      expiresAt?: string;
    }
  ): MemoryEntry | null {
    const target = this.readEntry(id, {
      workspaceDir: input.workspaceDir,
      includeUser: true,
      includeExpired: true,
      includeSuperseded: true,
    });
    if (!target) {
      return null;
    }
    const normalized = this.normalizeInput({
      scope: target.scope,
      title: input.title?.trim() || target.title,
      content: input.content,
      workspaceDir: target.workspaceDir ?? input.workspaceDir,
      sourceSessionId: input.sourceSessionId ?? target.sourceSessionId,
      reason: input.reason,
      lineageKey: target.lineageId.split(':').slice(2).join(':') || target.title,
      expiresAt: input.expiresAt ?? target.expiresAt,
    });
    const bucket = this.loadBucket(target.scope, target.namespace, target.namespaceLabel);
    const nextVersion = bucket.entries
      .filter((entry) => entry.lineageId === target.lineageId)
      .reduce((max, entry) => Math.max(max, entry.version), 0) + 1;
    const now = nowIso();
    const entry: MemoryEntry = {
      id: `mem-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      scope: target.scope,
      namespace: target.namespace,
      namespaceLabel: target.namespaceLabel,
      title: normalized.title,
      content: normalized.content,
      keywords: normalized.keywords,
      workspaceDir: normalized.workspaceDir,
      sourceSessionId: normalized.sourceSessionId,
      lineageId: target.lineageId,
      version: nextVersion,
      status: 'active',
      expiresAt: normalized.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    bucket.entries = bucket.entries.map((item) => {
      if (item.lineageId !== target.lineageId || item.status !== 'active') {
        return item;
      }
      return {
        ...item,
        status: 'superseded' as const,
        supersededAt: now,
        supersededById: entry.id,
        updatedAt: now,
      };
    });
    bucket.entries = [entry, ...bucket.entries].slice(0, 192);
    this.saveBucket(bucket);
    return entry;
  }

  expireEntry(
    id: string,
    input: {
      workspaceDir?: string;
      includeUser?: boolean;
      expiresAt?: string;
    } = {}
  ): MemoryEntry | null {
    const target = this.readEntry(id, {
      workspaceDir: input.workspaceDir,
      includeUser: input.includeUser,
      includeExpired: true,
      includeSuperseded: true,
    });
    if (!target) {
      return null;
    }
    const bucket = this.loadBucket(target.scope, target.namespace, target.namespaceLabel);
    const expiresAt = normalizeTimestamp(input.expiresAt) ?? nowIso();
    let updated: MemoryEntry | null = null;
    bucket.entries = bucket.entries.map((item) => {
      if (item.id !== id) {
        return item;
      }
      updated = {
        ...item,
        status: 'expired',
        expiresAt,
        updatedAt: nowIso(),
      };
      return updated;
    });
    this.saveBucket(bucket);
    return updated;
  }

  listPending(filters: PendingMemoryFilters = {}): MemorySuggestion[] {
    const out: MemorySuggestion[] = [];
    for (const entry of fs.readdirSync(this.pendingDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(this.pendingDir, entry.name);
      try {
        const suggestion = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MemorySuggestion;
        if (suggestion.status !== 'pending') {
          continue;
        }
        if (filters.sessionId && suggestion.sourceSessionId !== filters.sessionId) {
          continue;
        }
        if (filters.workspaceDir) {
          const normalized = path.resolve(filters.workspaceDir);
          if (path.resolve(suggestion.workspaceDir ?? '') !== normalized) {
            continue;
          }
        }
        out.push(suggestion);
      } catch {
        // ignore malformed pending records
      }
    }
    return out.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  approveSuggestion(id: string): MemorySuggestion | null {
    const suggestion = this.loadSuggestion(id);
    if (!suggestion || suggestion.status !== 'pending') {
      return null;
    }
    const entry = this.upsertEntry({
      scope: suggestion.scope,
      namespace: suggestion.namespace,
      namespaceLabel: suggestion.namespaceLabel,
      title: suggestion.title,
      content: suggestion.content,
      keywords: suggestion.keywords,
      workspaceDir: suggestion.workspaceDir,
      sourceSessionId: suggestion.sourceSessionId,
      reason: suggestion.reason,
      lineageId: suggestion.lineageId,
      expiresAt: suggestion.expiresAt,
      triggerCount: suggestion.triggerCount,
    });
    const next: MemorySuggestion = {
      ...suggestion,
      status: 'approved',
      reviewedAt: nowIso(),
      updatedAt: nowIso(),
      approvedEntryId: entry.id,
    };
    this.saveSuggestion(next);
    return next;
  }

  rejectSuggestion(id: string, reviewNote?: string): MemorySuggestion | null {
    const suggestion = this.loadSuggestion(id);
    if (!suggestion || suggestion.status !== 'pending') {
      return null;
    }
    const next: MemorySuggestion = {
      ...suggestion,
      status: 'rejected',
      reviewedAt: nowIso(),
      updatedAt: nowIso(),
      reviewNote: reviewNote?.trim() || undefined,
    };
    this.saveSuggestion(next);
    return next;
  }

  search(query: string, input: { workspaceDir?: string; maxResults?: number } = {}): MemorySearchResult[] {
    const tokens = tokenizeWorkflowText(query);
    if (tokens.length === 0) {
      return [];
    }
    const rows = this.listEntries({ workspaceDir: input.workspaceDir, includeUser: true })
      .map((entry) => {
        const haystack = `${entry.title}\n${entry.content}\n${entry.keywords.join(' ')}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (haystack.includes(token)) {
            score += token.length >= 4 ? 3 : 1;
          }
        }
        if (score === 0) {
          return null;
        }
        return {
          score,
          entry,
          excerpt: truncate(entry.content, 240),
        };
      })
      .filter((item): item is MemorySearchResult => item !== null)
      .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt));
    const maxResults = Math.max(1, Math.min(20, Math.floor(input.maxResults ?? 5)));
    return rows.slice(0, maxResults);
  }

  maybeSuggestFromTurn(input: {
    sessionId: string;
    workspaceDir?: string;
    prompt: string;
    finalOutput: string;
  }): MemorySuggestion | null {
    const combined = `${input.prompt}\n${input.finalOutput}`;
    if (looksLikeFailure(combined)) {
      return null;
    }
    const userSignals = [
      'remember',
      'prefer',
      'default',
      'always',
      '\u8bb0\u4f4f',
      '\u504f\u597d',
      '\u9ed8\u8ba4',
      '\u603b\u662f',
      '\u4ee5\u540e',
    ];
    const workspaceSignals = [
      'workspace',
      'project',
      'repo',
      'directory',
      'path',
      'command',
      'workflow',
      'publish',
      'release',
      'deploy',
      'build',
      'powershell',
      'shell',
      '\u5de5\u4f5c\u533a',
      '\u9879\u76ee',
      '\u76ee\u5f55',
      '\u8def\u5f84',
      '\u547d\u4ee4',
      '\u6d41\u7a0b',
      '\u53d1\u5e03',
      '\u90e8\u7f72',
      '\u6784\u5efa',
    ];
    const hasUserSignal = containsAnyPhrase(combined, userSignals);
    const hasWorkspaceSignal = containsAnyPhrase(combined, workspaceSignals) || extractCommandCandidates(combined).length > 0;
    if (!hasUserSignal && !hasWorkspaceSignal) {
      return null;
    }

    const scope: MemoryScope = hasUserSignal && !hasWorkspaceSignal ? 'user' : input.workspaceDir ? 'workspace' : 'user';
    const commands = extractCommandCandidates(combined);
    const checklist = extractChecklistItems(combined);
    const title =
      scope === 'user'
        ? 'User preference'
        : commands.length > 0
          ? `Workflow: ${truncate(commands[0], 80)}`
          : checklist.length > 0
            ? `Workflow: ${truncate(checklist[0], 80)}`
            : 'Workspace memory';
    const summarySource =
      commands.length > 0
        ? `Commands: ${commands.join('; ')}`
        : checklist.length > 0
          ? `Checklist: ${checklist.join('; ')}`
          : input.finalOutput || input.prompt;
    const lineageSeed =
      scope === 'user'
        ? buildPromptFingerprint(`${input.prompt}\n${input.finalOutput}`, commands)
        : commands.length > 0
          ? buildPromptFingerprint(commands.join('\n'), commands)
          : checklist.length > 0
            ? buildPromptFingerprint(checklist.join('\n'), commands)
            : buildPromptFingerprint(`${input.prompt}\n${input.finalOutput}`, commands);
    const expiresAt = this.inferExpiryFromText(combined);
    const normalized = this.normalizeInput({
      scope,
      title,
      content: truncate(`${truncate(input.prompt, 120)} :: ${summarySource}`.replace(/\s+/g, ' '), 320),
      workspaceDir: input.workspaceDir,
      sourceSessionId: input.sessionId,
      reason: scope === 'user' ? 'session_preference_promotion' : 'session_workflow_promotion',
      keywords: commands,
      lineageKey: `${scope}:${lineageSeed}`,
      expiresAt,
      triggerCount: 1,
    });
    return this.createSuggestion(normalized);
  }

  private inferExpiryFromText(value: string): string | undefined {
    if (
      containsAnyPhrase(value, [
        'temporary',
        'for now',
        'today',
        'this week',
        'this sprint',
        '\u4e34\u65f6',
        '\u4eca\u5929',
        '\u672c\u5468',
      ])
    ) {
      const expires = new Date();
      expires.setDate(expires.getDate() + 14);
      return expires.toISOString();
    }
    return undefined;
  }

  private normalizeInput(input: {
    scope: MemoryScope;
    title: string;
    content: string;
    workspaceDir?: string;
    sourceSessionId?: string;
    reason?: string;
    keywords?: string[];
    lineageKey?: string;
    expiresAt?: string;
    triggerCount?: number;
  }): NormalizedMemoryInput {
    const scope = input.scope;
    const resolved =
      scope === 'workspace' && input.workspaceDir
        ? this.resolveWorkspaceNamespace(input.workspaceDir)
        : this.resolveUserNamespace();
    const title = truncate(input.title.trim() || 'Memory', 120);
    const content = truncate(input.content.trim(), 600);
    const keywords = Array.from(
      new Set([...(input.keywords ?? []), ...tokenizeWorkflowText(title), ...tokenizeWorkflowText(content)])
    ).slice(0, 16);
    return {
      scope,
      namespace: resolved.namespace,
      namespaceLabel: resolved.namespaceLabel,
      title,
      content,
      keywords,
      workspaceDir: input.workspaceDir ? path.resolve(input.workspaceDir) : undefined,
      sourceSessionId: input.sourceSessionId,
      reason: input.reason?.trim() || undefined,
      lineageKey: input.lineageKey?.trim() || undefined,
      lineageId: this.buildLineageId(scope, resolved.namespace, input.lineageKey?.trim() || title),
      expiresAt: normalizeTimestamp(input.expiresAt),
      triggerCount: input.triggerCount,
    };
  }

  private buildLineageId(scope: MemoryScope, namespace: string, title: string): string {
    return `${scope}:${namespace}:${slugifyWorkflowText(title, 'memory', 64)}`;
  }

  private bucketFilePath(scope: MemoryScope, namespace: string): string {
    const dir = path.join(this.entriesDir, scope);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${namespace}.json`);
  }

  private limitEntriesByBudget(entries: MemoryEntry[], charBudget: number): MemoryEntry[] {
    const selected: MemoryEntry[] = [];
    let remaining = Math.max(180, charBudget);
    for (const entry of entries) {
      const nextCost = entry.title.length + entry.content.length + 12;
      if (selected.length > 0 && nextCost > remaining) {
        continue;
      }
      selected.push(entry);
      remaining -= nextCost;
    }
    return selected;
  }

  private loadBucket(scope: MemoryScope, namespace: string, namespaceLabel: string): MemoryBucket {
    const filePath = this.bucketFilePath(scope, namespace);
    if (!fs.existsSync(filePath)) {
      return { scope, namespace, namespaceLabel, entries: [] };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MemoryBucket;
      const bucket: MemoryBucket = {
        scope,
        namespace,
        namespaceLabel,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
      const nextEntries = this.pruneExpiredEntries(bucket.entries);
      if (nextEntries !== bucket.entries) {
        bucket.entries = nextEntries;
        this.saveBucket(bucket);
      }
      return bucket;
    } catch {
      return { scope, namespace, namespaceLabel, entries: [] };
    }
  }

  private saveBucket(bucket: MemoryBucket): void {
    fs.writeFileSync(
      this.bucketFilePath(bucket.scope, bucket.namespace),
      JSON.stringify(bucket, null, 2),
      'utf-8'
    );
  }

  private filterVisibleEntries(
    entries: MemoryEntry[],
    input: {
      includeExpired?: boolean;
      includeSuperseded?: boolean;
    }
  ): MemoryEntry[] {
    return this.pruneExpiredEntries(entries).filter((entry) => {
      if (entry.status === 'expired' && input.includeExpired !== true) {
        return false;
      }
      if (entry.status === 'superseded' && input.includeSuperseded !== true) {
        return false;
      }
      return true;
    });
  }

  private pruneExpiredEntries(entries: MemoryEntry[]): MemoryEntry[] {
    const now = Date.now();
    let mutated = false;
    const nextEntries = entries.map((entry) => {
      if (entry.status !== 'active' || !entry.expiresAt) {
        return entry;
      }
      const expiresAt = new Date(entry.expiresAt).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt > now) {
        return entry;
      }
      mutated = true;
      return {
        ...entry,
        status: 'expired' as const,
        updatedAt: nowIso(),
      };
    });
    return mutated ? nextEntries : entries;
  }

  private findLatestLineageEntry(
    normalized: NormalizedMemoryInput,
    input: { includeExpired?: boolean; includeSuperseded?: boolean } = {}
  ): MemoryEntry | undefined {
    const bucket = this.loadBucket(normalized.scope, normalized.namespace, normalized.namespaceLabel);
    return this.filterVisibleEntries(bucket.entries, input)
      .filter((entry) => entry.lineageId === normalized.lineageId)
      .sort((left, right) => right.version - left.version || right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  private findActiveDuplicate(normalized: NormalizedMemoryInput): MemoryEntry | undefined {
    const latest = this.findLatestLineageEntry(normalized);
    if (!latest) {
      return undefined;
    }
    return normalizeWorkflowText(latest.content) === normalizeWorkflowText(normalized.content) ? latest : undefined;
  }

  private touchEntry(entry: MemoryEntry, normalized: NormalizedMemoryInput): MemoryEntry {
    const bucket = this.loadBucket(entry.scope, entry.namespace, entry.namespaceLabel);
    let updated = entry;
    bucket.entries = bucket.entries.map((item) => {
      if (item.id !== entry.id) {
        return item;
      }
      updated = {
        ...item,
        title: normalized.title,
        content: normalized.content,
        keywords: normalized.keywords,
        workspaceDir: normalized.workspaceDir,
        sourceSessionId: normalized.sourceSessionId,
        expiresAt: normalized.expiresAt ?? item.expiresAt,
        updatedAt: nowIso(),
      };
      return updated;
    });
    this.saveBucket(bucket);
    return updated;
  }

  private upsertEntry(normalized: NormalizedMemoryInput): MemoryEntry {
    const bucket = this.loadBucket(normalized.scope, normalized.namespace, normalized.namespaceLabel);
    const lineageEntries = bucket.entries.filter((entry) => entry.lineageId === normalized.lineageId);
    const latestActive = lineageEntries
      .filter((entry) => entry.status === 'active')
      .sort((left, right) => right.version - left.version || right.updatedAt.localeCompare(left.updatedAt))[0];
    if (latestActive && normalizeWorkflowText(latestActive.content) === normalizeWorkflowText(normalized.content)) {
      return this.touchEntry(latestActive, normalized);
    }

    const nextVersion = lineageEntries.reduce((max, entry) => Math.max(max, entry.version), 0) + 1;
    const now = nowIso();
    const entry: MemoryEntry = {
      id: `mem-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      scope: normalized.scope,
      namespace: normalized.namespace,
      namespaceLabel: normalized.namespaceLabel,
      title: normalized.title,
      content: normalized.content,
      keywords: normalized.keywords,
      workspaceDir: normalized.workspaceDir,
      sourceSessionId: normalized.sourceSessionId,
      lineageId: normalized.lineageId,
      version: nextVersion,
      status: 'active',
      expiresAt: normalized.expiresAt,
      createdAt: now,
      updatedAt: now,
    };

    bucket.entries = bucket.entries.map((item) => {
      if (item.lineageId !== normalized.lineageId || item.status !== 'active') {
        return item;
      }
      return {
        ...item,
        status: 'superseded' as const,
        supersededAt: now,
        supersededById: entry.id,
        updatedAt: now,
      };
    });
    bucket.entries = [entry, ...bucket.entries].slice(0, 192);
    this.saveBucket(bucket);
    return entry;
  }

  private createSuggestion(normalized: NormalizedMemoryInput): MemorySuggestion | null {
    const duplicate = this.findActiveDuplicate(normalized);
    if (duplicate) {
      return null;
    }
    const existing = this.listPending({
      sessionId: normalized.sourceSessionId,
      workspaceDir: normalized.workspaceDir,
    }).find(
      (item) =>
        item.lineageId === normalized.lineageId &&
        normalizeWorkflowText(item.content) === normalizeWorkflowText(normalized.content)
    );
    if (existing) {
      return existing;
    }
    const latest = this.findLatestLineageEntry(normalized, { includeExpired: true, includeSuperseded: true });
    const suggestion: MemorySuggestion = {
      id: `mem-pending-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      scope: normalized.scope,
      namespace: normalized.namespace,
      namespaceLabel: normalized.namespaceLabel,
      title: normalized.title,
      content: normalized.content,
      keywords: normalized.keywords,
      workspaceDir: normalized.workspaceDir,
      sourceSessionId: normalized.sourceSessionId,
      reason: normalized.reason,
      lineageId: normalized.lineageId,
      versionHint: (latest?.version ?? 0) + 1,
      expiresAt: normalized.expiresAt,
      triggerCount: normalized.triggerCount,
      status: 'pending',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.saveSuggestion(suggestion);
    return suggestion;
  }

  private suggestionFilePath(id: string): string {
    return path.join(this.pendingDir, `${id}.json`);
  }

  private loadSuggestion(id: string): MemorySuggestion | null {
    const filePath = this.suggestionFilePath(id);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MemorySuggestion;
    } catch {
      return null;
    }
  }

  private saveSuggestion(suggestion: MemorySuggestion): void {
    fs.writeFileSync(this.suggestionFilePath(suggestion.id), JSON.stringify(suggestion, null, 2), 'utf-8');
  }
}
