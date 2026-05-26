import { WebSocket } from 'ws';
import { WebServer } from '../../../src/web/server/WebServer.js';
import type { ContextRef } from '../../../src/types.js';
import type { PendingPlanInput } from '../../../src/web/server/web-server-runtime-contracts.js';

export interface CapturedWebMessage {
  ws: object;
  type: string;
  data: unknown;
}

export function createWebServerDouble(): any {
  const server = Object.create(WebServer.prototype) as any;
  server.sessionRuntimes = new Map();
  return server;
}

export function createOpenSocket(label: string): { readyState: number; socket: string } {
  return { readyState: WebSocket.OPEN, socket: label };
}

export function createSessionContext(namespace = 'sess-1'): ContextRef {
  return { scope: 'session', namespace };
}

export function getPendingPlanInputs(server: any): Map<string, PendingPlanInput> {
  return server.getPendingPlanInputCoordinator().pendingInputsForInspection;
}

export function replacePendingPlanInputs(server: any, pending: Map<string, PendingPlanInput>): void {
  server.getPendingPlanInputCoordinator().replacePendingInputs(pending);
}

export function attachEmitCapture(
  server: any,
  options: {
    lifecycle?: string[];
    labelForSocket?: (ws: object) => string;
  } = {}
): { emitted: CapturedWebMessage[]; lifecycle: string[] } {
  const emitted: CapturedWebMessage[] = [];
  const lifecycle = options.lifecycle ?? [];
  server.emitToClient = (ws: object, message: Omit<CapturedWebMessage, 'ws'>) => {
    const label = options.labelForSocket?.(ws);
    lifecycle.push(label ? `emit:${message.type}:${label}` : `emit:${message.type}`);
    emitted.push({ ws, ...message });
  };
  return { emitted, lifecycle };
}

export class RecordingMap<K, V> extends Map<K, V> {
  constructor(
    private readonly lifecycle: string[],
    entries?: ReadonlyArray<readonly [K, V]>
  ) {
    super(entries);
  }

  override delete(key: K): boolean {
    this.lifecycle.push(`delete:${String(key)}`);
    return super.delete(key);
  }
}
