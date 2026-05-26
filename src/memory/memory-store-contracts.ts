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

export interface MemoryBucket {
  scope: MemoryScope;
  namespace: string;
  namespaceLabel: string;
  entries: MemoryEntry[];
}

export interface NormalizedMemoryInput {
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
