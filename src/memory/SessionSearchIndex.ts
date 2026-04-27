import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextNamespaceMeta, ContextRef, Message } from '../types.js';

export interface SessionSearchDocument {
  sessionId: string;
  scope: ContextRef['scope'];
  namespace: string;
  workspaceDir?: string;
  updatedAt: string;
  turnExcerpts: string[];
}

export interface SessionSearchHit {
  kind: 'session';
  score: number;
  title: string;
  excerpt: string;
  sessionId: string;
  workspaceDir?: string;
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
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

function messageToText(content: Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === 'text') {
        return block.text ?? '';
      }
      if (block.type === 'tool_result') {
        return block.content ?? '';
      }
      if (block.type === 'tool_use') {
        return JSON.stringify(block.input ?? {});
      }
      return '';
    })
    .join('\n');
}

export class SessionSearchIndex {
  private readonly baseDir: string;
  private readonly sessionsDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.sessionsDir = path.join(this.baseDir, 'sessions');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  upsertSession(ref: ContextRef, meta: ContextNamespaceMeta | undefined, transcriptMessages: Message[]): void {
    if (ref.scope !== 'session') {
      return;
    }
    const doc: SessionSearchDocument = {
      sessionId: ref.namespace,
      scope: ref.scope,
      namespace: ref.namespace,
      workspaceDir: meta?.workspaceDir,
      updatedAt: meta?.updatedAt ?? new Date().toISOString(),
      turnExcerpts: this.buildTurnExcerpts(transcriptMessages),
    };
    fs.writeFileSync(this.documentPath(ref.namespace), JSON.stringify(doc, null, 2), 'utf-8');
  }

  removeSession(sessionId: string): void {
    const docPath = this.documentPath(sessionId);
    if (fs.existsSync(docPath)) {
      fs.rmSync(docPath, { force: true });
    }
  }

  pruneSessions(activeSessionIds: string[]): void {
    const active = new Set(activeSessionIds.map((item) => item.trim()).filter((item) => item.length > 0));
    for (const entry of this.readSessionFiles()) {
      const sessionId = decodeURIComponent(entry.name.slice(0, -'.json'.length));
      if (!active.has(sessionId)) {
        fs.rmSync(path.join(this.sessionsDir, entry.name), { force: true });
      }
    }
  }

  search(query: string, options: { workspaceDir?: string; maxResults?: number } = {}): SessionSearchHit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }
    const maxResults = Math.max(1, Math.min(20, Math.floor(options.maxResults ?? 5)));
    const workspaceDir = String(options.workspaceDir ?? '').trim();
    const hits: SessionSearchHit[] = [];

    for (const entry of this.readDocuments()) {
      if (workspaceDir && entry.workspaceDir && entry.workspaceDir !== workspaceDir) {
        continue;
      }
      const rankedExcerpt = this.rankExcerpts(entry.turnExcerpts, tokens);
      if (!rankedExcerpt) {
        continue;
      }
      hits.push({
        kind: 'session',
        score: rankedExcerpt.score,
        title: entry.sessionId,
        excerpt: truncate(rankedExcerpt.excerpt, 260),
        sessionId: entry.sessionId,
        workspaceDir: entry.workspaceDir,
      });
    }

    return hits.sort((left, right) => right.score - left.score).slice(0, maxResults);
  }

  private buildTurnExcerpts(transcriptMessages: Message[]): string[] {
    const excerpts: string[] = [];
    let currentUser = '';
    let assistantParts: string[] = [];

    const flush = (): void => {
      const prompt = currentUser.trim();
      const assistant = assistantParts.join('\n').trim();
      if (!prompt && !assistant) {
        return;
      }
      const parts: string[] = [];
      if (prompt) {
        parts.push(`User: ${truncate(prompt, 220)}`);
      }
      if (assistant) {
        parts.push(`Assistant: ${truncate(assistant, 260)}`);
      }
      excerpts.push(parts.join('\n'));
      currentUser = '';
      assistantParts = [];
    };

    for (const message of transcriptMessages) {
      if (message.role === 'user') {
        flush();
        currentUser = messageToText(message.content);
        continue;
      }
      if (message.role === 'assistant') {
        const text = messageToText(message.content).trim();
        if (text.length > 0) {
          assistantParts.push(text);
        }
      }
    }

    flush();
    return excerpts;
  }

  private rankExcerpts(
    excerpts: string[],
    tokens: string[]
  ): {
    score: number;
    excerpt: string;
  } | null {
    let best:
      | {
          score: number;
          excerpt: string;
        }
      | null = null;

    for (const excerpt of excerpts) {
      const haystack = excerpt.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += token.length >= 4 ? 3 : 1;
        }
      }
      if (score === 0) {
        continue;
      }
      if (!best || score > best.score) {
        best = { score, excerpt };
      }
    }

    return best;
  }

  private readDocuments(): SessionSearchDocument[] {
    const out: SessionSearchDocument[] = [];
    for (const entry of this.readSessionFiles()) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(this.sessionsDir, entry.name), 'utf-8')) as SessionSearchDocument);
      } catch {
        // ignore malformed documents
      }
    }
    return out;
  }

  private readSessionFiles(): fs.Dirent[] {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }
    return fs
      .readdirSync(this.sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  }

  private documentPath(sessionId: string): string {
    const safe = encodeURIComponent(sessionId);
    return path.join(this.sessionsDir, `${safe}.json`);
  }
}
