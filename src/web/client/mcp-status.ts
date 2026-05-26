export type MCPIndicatorState = 'connected' | 'degraded' | 'idle' | 'disabled';

export interface MCPStatusServerView {
  name: string;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disabled';
  toolCount: number;
  retryCount: number;
  lastError?: string;
  updatedAt: string;
  disabled: boolean;
}

export interface MCPStatusView {
  enabled: boolean;
  summary: {
    state: MCPIndicatorState;
    connectedCount: number;
    totalEnabled: number;
  };
  servers: MCPStatusServerView[];
}

const EMPTY_STATUS: MCPStatusView = {
  enabled: false,
  summary: {
    state: 'idle',
    connectedCount: 0,
    totalEnabled: 0,
  },
  servers: [],
};

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function normalizeMcpStatus(input: unknown): MCPStatusView {
  if (!input || typeof input !== 'object') {
    return EMPTY_STATUS;
  }

  const source = input as Record<string, unknown>;
  const summarySource = source.summary && typeof source.summary === 'object'
    ? (source.summary as Record<string, unknown>)
    : {};
  const normalizedState = (() => {
    const state = asString(summarySource.state, 'idle');
    if (state === 'connected' || state === 'degraded' || state === 'disabled' || state === 'idle') {
      return state;
    }
    return 'idle';
  })();

  const servers = Array.isArray(source.servers)
    ? source.servers
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map((server) => {
          const statusRaw = asString(server.status, 'idle');
          const status =
            statusRaw === 'idle' ||
            statusRaw === 'connecting' ||
            statusRaw === 'connected' ||
            statusRaw === 'reconnecting' ||
            statusRaw === 'failed' ||
            statusRaw === 'disabled'
              ? statusRaw
              : 'idle';
          const normalizedStatus = status as MCPStatusServerView['status'];
          return {
            name: asString(server.name, 'unknown'),
            status: normalizedStatus,
            toolCount: asNumber(server.toolCount, 0),
            retryCount: asNumber(server.retryCount, 0),
            lastError: asString(server.lastError, ''),
            updatedAt: asString(server.updatedAt, ''),
            disabled: asBoolean(server.disabled, false),
          };
        })
    : [];

  return {
    enabled: asBoolean(source.enabled, false),
    summary: {
      state: normalizedState,
      connectedCount: asNumber(summarySource.connectedCount, 0),
      totalEnabled: asNumber(summarySource.totalEnabled, 0),
    },
    servers,
  };
}

export function resolveMcpIndicatorState(status: MCPStatusView | null): MCPIndicatorState {
  if (!status) {
    return 'idle';
  }
  if (!status.enabled || status.summary.state === 'disabled') {
    return 'disabled';
  }
  if (status.summary.state === 'connected') {
    return 'connected';
  }
  if (status.summary.state === 'degraded') {
    return 'degraded';
  }
  return 'idle';
}
