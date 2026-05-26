import type { WebSocket } from 'ws';
import type { ShareTextSocketProtocol } from './share-text-socket-protocol.js';
import {
  dispatchWebServerMessage,
} from './web-server-websocket.js';
import type {
  AsrStreamChunkRequest,
  AsrStreamStartRequest,
  AsrStreamStopRequest,
  WebAsrStreamController,
} from './web-server-asr-stream.js';
import type {
  CancelRequest,
  ChatRequest,
  PlanInputResponseRequest,
  RunningInputCancelRequest,
  RunningInputEnqueueRequest,
  RunningInputInsertRequest,
  StopAutoLoopRequest,
  TextAskRequest,
  TextHistoryRequest,
  WSMessage,
} from './web-server-shared.js';
import type { WebSocketAccessScope } from './websocket-access-controller.js';
import { webServerLogger } from '../../utils/logger.js';

type TextShareScope = Extract<WebSocketAccessScope, { mode: 'shared_ls' }>;

export interface WebServerSocketMessageHost extends WebServerTextOnlyMessageHost {
  getTextShareScope(ws: WebSocket): TextShareScope | null;
  handleChatMessage(ws: WebSocket, request: ChatRequest): Promise<void>;
  handleCancelMessage(ws: WebSocket, request: CancelRequest): void;
  handlePlanInputResponse(ws: WebSocket, request: PlanInputResponseRequest): void;
  handleRunningInputEnqueueMessage(ws: WebSocket, request: RunningInputEnqueueRequest): void;
  handleRunningInputInsertMessage(ws: WebSocket, request: RunningInputInsertRequest): void;
  handleRunningInputCancelMessage(ws: WebSocket, request: RunningInputCancelRequest): void;
  handleStopAutoLoopMessage(ws: WebSocket, request: StopAutoLoopRequest): void;
  handleAsrStreamStart(ws: WebSocket, request: unknown): Promise<void>;
  handleAsrStreamChunk(ws: WebSocket, request: unknown): Promise<void>;
  handleAsrStreamStop(ws: WebSocket, request: unknown): Promise<void>;
  handleAsrStreamCancel(ws: WebSocket, request: unknown): Promise<void>;
  handleAsrClientDebug(request: unknown): void;
  handlePingMessage(ws: WebSocket, data: unknown): void;
  emitToClient(ws: WebSocket | undefined, message: WSMessage): void;
}

export interface WebServerTextOnlyMessageHost {
  handleTextHistoryMessage(ws: WebSocket, request: TextHistoryRequest): void;
  handleTextAskMessage(ws: WebSocket, request: TextAskRequest): Promise<void>;
  handlePingMessage(ws: WebSocket, data: unknown): void;
  emitToClient(ws: WebSocket | undefined, message: WSMessage): void;
}

export interface WebServerTextSocketHost {
  getTextShareScope(ws: WebSocket): TextShareScope | null;
  getShareTextSocketProtocol(): ShareTextSocketProtocol;
  emitToClient(ws: WebSocket | undefined, message: WSMessage): void;
}

export interface WebServerAsrMessageHost {
  getAsrStreamController(): WebAsrStreamController;
}

export interface WebServerPingHost {
  emitToClient(ws: WebSocket | undefined, message: WSMessage): void;
}

export async function handleWebServerSocketMessage(
  host: WebServerSocketMessageHost,
  ws: WebSocket,
  message: WSMessage
): Promise<void> {
  if (host.getTextShareScope(ws)) {
    await handleWebServerTextOnlySocketMessage(host, ws, message);
    return;
  }
  await dispatchWebServerMessage(ws, message, {
    onChat: (socket, request) => host.handleChatMessage(socket, request),
    onCancel: (socket, request) => host.handleCancelMessage(socket, request),
    onPlanInputResponse: (socket, request) => host.handlePlanInputResponse(socket, request),
    onRunningInputEnqueue: (socket, request) => host.handleRunningInputEnqueueMessage(socket, request),
    onRunningInputInsert: (socket, request) => host.handleRunningInputInsertMessage(socket, request),
    onRunningInputCancel: (socket, request) => host.handleRunningInputCancelMessage(socket, request),
    onStopAutoLoop: (socket, request) => host.handleStopAutoLoopMessage(socket, request),
    onAsrStreamStart: (socket, request) => host.handleAsrStreamStart(socket, request),
    onAsrStreamChunk: (socket, request) => host.handleAsrStreamChunk(socket, request),
    onAsrStreamStop: (socket, request) => host.handleAsrStreamStop(socket, request),
    onAsrStreamCancel: (socket, request) => host.handleAsrStreamCancel(socket, request),
    onAsrClientDebug: (_socket, request) => host.handleAsrClientDebug(request),
    onPing: (socket, payload) => host.handlePingMessage(socket, payload),
  });
}

export async function handleWebServerTextOnlySocketMessage(
  host: WebServerTextOnlyMessageHost,
  ws: WebSocket,
  message: WSMessage
): Promise<void> {
  if (message.type === 'ping') {
    const payload =
      message.timestamp !== undefined
        ? {
            data: message.data,
            timestamp: message.timestamp,
          }
        : message.data;
    host.handlePingMessage(ws, payload);
    return;
  }
  if (message.type === 'history_request') {
    host.handleTextHistoryMessage(ws, (message.data ?? {}) as TextHistoryRequest);
    return;
  }
  if (message.type === 'ask_text') {
    await host.handleTextAskMessage(ws, (message.data ?? {}) as TextAskRequest);
    return;
  }
  host.emitToClient(ws, {
    type: 'error',
    data: {
      code: 'TEXT_WS_UNSUPPORTED_MESSAGE',
      message: `Unsupported text share WebSocket message: ${message.type}`,
    },
  });
}

export function handleWebServerTextHistoryMessage(
  host: WebServerTextSocketHost,
  ws: WebSocket,
  request: TextHistoryRequest
): void {
  const scope = host.getTextShareScope(ws);
  if (!scope) {
    host.emitToClient(ws, {
      type: 'error',
      data: {
        code: 'TEXT_WS_FORBIDDEN',
        message: 'Text history requires a text share WebSocket.',
      },
    });
    return;
  }
  host.getShareTextSocketProtocol().handleHistory(ws, scope, request);
}

export async function handleWebServerTextAskMessage(
  host: WebServerTextSocketHost,
  ws: WebSocket,
  request: TextAskRequest
): Promise<void> {
  const scope = host.getTextShareScope(ws);
  const text = String(request.text ?? '').trim();
  if (!scope || !text) {
    host.emitToClient(ws, {
      type: 'error',
      data: {
        code: !scope ? 'TEXT_WS_FORBIDDEN' : 'TEXT_REQUIRED',
        message: !scope ? 'Text ask requires a text share WebSocket.' : 'Text ask requires non-empty text.',
      },
    });
    return;
  }
  await host.getShareTextSocketProtocol().handleAsk(ws, scope, request);
}

export async function handleWebServerAsrStreamStart(
  host: WebServerAsrMessageHost,
  ws: WebSocket,
  request: unknown
): Promise<void> {
  await host.getAsrStreamController().start(ws, (request ?? {}) as AsrStreamStartRequest);
}

export async function handleWebServerAsrStreamChunk(
  host: WebServerAsrMessageHost,
  ws: WebSocket,
  request: unknown
): Promise<void> {
  await host.getAsrStreamController().chunk(ws, (request ?? {}) as AsrStreamChunkRequest);
}

export async function handleWebServerAsrStreamStop(
  host: WebServerAsrMessageHost,
  ws: WebSocket,
  request: unknown
): Promise<void> {
  await host.getAsrStreamController().stop(ws, (request ?? {}) as AsrStreamStopRequest);
}

export async function handleWebServerAsrStreamCancel(
  host: WebServerAsrMessageHost,
  ws: WebSocket,
  request: unknown
): Promise<void> {
  await host.getAsrStreamController().cancel(ws, (request ?? {}) as AsrStreamStopRequest);
}

export function handleWebServerAsrClientDebug(request: unknown): void {
  const data = request && typeof request === 'object' ? (request as Record<string, unknown>) : {};
  const event = String(data.event ?? 'unknown');
  const streamId = typeof data.streamId === 'string' ? data.streamId : '';
  const compact = JSON.stringify(data).slice(0, 800);
  webServerLogger.info(`[ASR Client] event=${event}${streamId ? ` stream=${streamId}` : ''} ${compact}`);
}

export function handleWebServerPingMessage(host: WebServerPingHost, ws: WebSocket, data: unknown): void {
  const pingEnvelope =
    data && typeof data === 'object' ? (data as { data?: unknown; timestamp?: unknown }) : null;
  const pingData =
    pingEnvelope && 'data' in pingEnvelope
      ? (pingEnvelope.data as { timestamp?: number } | null)
      : (data as { timestamp?: number } | null);
  const timestamp =
    typeof pingData?.timestamp === 'number'
      ? pingData.timestamp
      : typeof pingEnvelope?.timestamp === 'number'
        ? pingEnvelope.timestamp
        : Date.now();
  host.emitToClient(ws, {
    type: 'pong',
    data: {
      timestamp,
      serverTime: Date.now(),
    },
  });
}
