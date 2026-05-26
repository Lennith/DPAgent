import type { MCPRuntimeConfig } from '../config/ConfigManager.js';
import type { MCPStatusSnapshot } from '../mcp/index.js';
import type {
  MCPServerRuntimeStatus,
  MCPStatusResponse,
} from '../types.js';

export function summarizeMcpServers(servers: MCPStatusResponse['servers']): MCPStatusResponse['summary'] {
  const enabledServers = servers.filter((server) => !server.disabled);
  const connectedCount = enabledServers.filter((server) => server.status === 'connected').length;
  const totalEnabled = enabledServers.length;

  if (totalEnabled === 0) {
    return {
      state: 'disabled',
      connectedCount,
      totalEnabled,
    };
  }
  if (connectedCount > 0) {
    return {
      state: 'connected',
      connectedCount,
      totalEnabled,
    };
  }
  const hasNonIdle = enabledServers.some((server) =>
    server.status === 'failed' ||
    server.status === 'connecting' ||
    server.status === 'reconnecting'
  );
  return {
    state: hasNonIdle ? 'degraded' : 'idle',
    connectedCount,
    totalEnabled,
  };
}

export function buildMcpStatusResponse(input: {
  runtime: MCPRuntimeConfig;
  snapshot?: MCPStatusSnapshot | null;
  nowIso?: string;
}): MCPStatusResponse {
  const { runtime, snapshot } = input;
  const defaultServerStatus: MCPServerRuntimeStatus = runtime.enabled ? 'idle' : 'disabled';
  const nowIso = input.nowIso ?? new Date().toISOString();
  const statusByName = new Map(snapshot?.servers.map((server) => [server.name, server]) ?? []);
  const servers = runtime.servers.map((server) => {
    const status = statusByName.get(server.name);
    if (!status) {
      return {
        name: server.name,
        status: server.disabled ? 'disabled' : defaultServerStatus,
        toolCount: 0,
        retryCount: 0,
        lastError: undefined,
        updatedAt: nowIso,
        disabled: server.disabled === true || !runtime.enabled,
      };
    }
    return {
      name: status.name,
      status: server.disabled || !runtime.enabled ? 'disabled' : status.status,
      toolCount: status.toolCount,
      retryCount: status.retryCount,
      lastError: status.lastError,
      updatedAt: status.updatedAt,
      disabled: server.disabled === true || !runtime.enabled,
    };
  });

  return {
    enabled: runtime.enabled,
    summary: summarizeMcpServers(servers),
    servers,
  };
}
