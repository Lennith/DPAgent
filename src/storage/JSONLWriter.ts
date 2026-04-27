import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { PersistedMessage } from '../types.js';

// Simple file lock to prevent concurrent writes
const fileLocks = new Map<string, boolean>();

function acquireLock(filePath: string): boolean {
  if (fileLocks.get(filePath)) {
    return false;
  }
  fileLocks.set(filePath, true);
  return true;
}

function releaseLock(filePath: string): void {
  fileLocks.delete(filePath);
}

export class JSONLWriter {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(message: PersistedMessage): void {
    // Wait for lock if another operation is in progress
    while (!acquireLock(this.filePath)) {
      // Simple spinlock - in practice, contention should be rare
      // Consider using async/await with setTimeout for production
    }
    try {
      const line = JSON.stringify(message) + '\n';
      fs.appendFileSync(this.filePath, line, 'utf-8');
    } finally {
      releaseLock(this.filePath);
    }
  }

  appendAll(messages: PersistedMessage[]): void {
    // Wait for lock if another operation is in progress
    while (!acquireLock(this.filePath)) {
      // Simple spinlock - in practice, contention should be rare
    }
    try {
      const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
      fs.appendFileSync(this.filePath, lines, 'utf-8');
    } finally {
      releaseLock(this.filePath);
    }
  }

  readAll(): PersistedMessage[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    return lines.map(line => {
      try {
        return JSON.parse(line) as PersistedMessage;
      } catch {
        return null;
      }
    }).filter((m): m is PersistedMessage => m !== null);
  }

  readLast(count: number): PersistedMessage[] {
    const all = this.readAll();
    return all.slice(-count);
  }

  overwrite(messages: PersistedMessage[]): void {
    const lines = messages.map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(this.filePath, lines, 'utf-8');
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  getSize(): number {
    if (!this.exists()) {
      return 0;
    }
    const stats = fs.statSync(this.filePath);
    return stats.size;
  }

  getContentSize(): number {
    const messages = this.readAll();
    return messages.reduce((sum, m) => sum + m.content.length, 0);
  }

  count(): number {
    return this.readAll().length;
  }

  delete(): void {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
  }
}

export function generateMessageId(): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `msg-${timestamp}-${random}`;
}

export function createPersistedMessage(
  role: PersistedMessage['role'],
  content: string,
  options?: {
    thinking?: string;
    thinkingSignature?: string;
    toolCalls?: PersistedMessage['toolCalls'];
    toolCallId?: string;
    name?: string;
    metadata?: PersistedMessage['metadata'];
  }
): PersistedMessage {
  return {
    id: generateMessageId(),
    role,
    content,
    timestamp: new Date().toISOString(),
    ...options,
  };
}
