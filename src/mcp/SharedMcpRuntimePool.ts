import type { MCPRuntimeConfig } from '../config/ConfigManager.js';
import { mcpLogger } from '../utils/logger.js';
import { MCPConnector, type MCPStatusSnapshot, type MCPTool } from './MCPConnector.js';

const SHARED_MCP_HEALTH_CHECK_INTERVAL_MS = 30_000;

interface SharedMcpRuntimeEntry {
  key: string;
  connector: MCPConnector;
  tools: MCPTool[];
  refCount: number;
  connectPromise: Promise<void> | null;
}

export interface SharedMcpRuntimeLease {
  connector: MCPConnector;
  tools: MCPTool[];
  reused: boolean;
  release(): Promise<void>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildRuntimeKey(runtime: MCPRuntimeConfig): string {
  return stableStringify({
    enabled: runtime.enabled,
    connectTimeout: runtime.connectTimeout,
    executeTimeout: runtime.executeTimeout,
    servers: runtime.servers,
  });
}

export class SharedMcpRuntimePool {
  private static entries = new Map<string, SharedMcpRuntimeEntry>();

  static async acquire(runtime: MCPRuntimeConfig): Promise<SharedMcpRuntimeLease | null> {
    if (!runtime.enabled || runtime.servers.length === 0) {
      return null;
    }

    const key = buildRuntimeKey(runtime);
    const existing = this.entries.get(key);
    if (existing) {
      existing.refCount += 1;
      try {
        await existing.connectPromise;
      } catch (error) {
        await this.releaseKey(key);
        throw error;
      }
      return {
        connector: existing.connector,
        tools: existing.tools,
        reused: true,
        release: async () => this.releaseKey(key),
      };
    }

    const connector = new MCPConnector(runtime.executeTimeout * 1000, {
      connectTimeoutMs: runtime.connectTimeout * 1000,
      healthCheckIntervalMs: SHARED_MCP_HEALTH_CHECK_INTERVAL_MS,
    });
    const created: SharedMcpRuntimeEntry = {
      key,
      connector,
      tools: [],
      refCount: 1,
      connectPromise: null,
    };
    created.connectPromise = (async () => {
      created.tools = await connector.connectAll(runtime.servers);
    })();
    this.entries.set(key, created);

    try {
      await created.connectPromise;
      return {
        connector: created.connector,
        tools: created.tools,
        reused: false,
        release: async () => this.releaseKey(key),
      };
    } catch (error) {
      this.entries.delete(key);
      try {
        await connector.disconnectAll();
      } catch (disconnectError) {
        mcpLogger.warn(`Failed to clean up shared MCP runtime after connect error: ${String(disconnectError)}`);
      }
      throw error;
    } finally {
      created.connectPromise = null;
    }
  }

  static getSnapshot(runtime: MCPRuntimeConfig): MCPStatusSnapshot | null {
    if (!runtime.enabled || runtime.servers.length === 0) {
      return null;
    }
    const key = buildRuntimeKey(runtime);
    return this.entries.get(key)?.connector.getStatusSnapshot() ?? null;
  }

  static async resetForTests(): Promise<void> {
    const keys = [...this.entries.keys()];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) {
        entry.refCount = 1;
      }
      await this.releaseKey(key);
    }
  }

  private static async releaseKey(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0) {
      return;
    }
    this.entries.delete(key);
    try {
      await entry.connectPromise;
    } catch {
      // Connection establishment already failed; nothing else to do here.
    }
    await entry.connector.disconnectAll();
  }
}
