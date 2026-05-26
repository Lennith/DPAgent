import type { IncomingMessage } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  CancelRequest,
  ChatRequest,
  PlanInputResponseRequest,
  RunningInputCancelRequest,
  RunningInputEnqueueRequest,
  RunningInputInsertRequest,
  StopAutoLoopRequest,
  WSMessage,
} from './web-server-shared.js';

export interface WebServerSocketLifecycleOptions {
  wss: WebSocketServer;
  onMessage: (ws: WebSocket, message: WSMessage) => Promise<void>;
  onConnection?: (ws: WebSocket, request: IncomingMessage) => void;
  onClose: (ws: WebSocket, code: number, reason: Buffer) => void;
  onError: (ws: WebSocket, error: Error) => void;
  logConnect: () => void;
  logDisconnect: () => void;
  logMessageError: (error: unknown) => void;
}

export interface WebServerMessageDispatchHandlers {
  onChat: (ws: WebSocket, request: ChatRequest) => Promise<void>;
  onCancel: (ws: WebSocket, request: CancelRequest) => void;
  onPlanInputResponse: (ws: WebSocket, request: PlanInputResponseRequest) => void;
  onRunningInputEnqueue: (ws: WebSocket, request: RunningInputEnqueueRequest) => void;
  onRunningInputInsert: (ws: WebSocket, request: RunningInputInsertRequest) => void;
  onRunningInputCancel: (ws: WebSocket, request: RunningInputCancelRequest) => void;
  onStopAutoLoop: (ws: WebSocket, request: StopAutoLoopRequest) => void;
  onAsrStreamStart: (ws: WebSocket, request: unknown) => Promise<void>;
  onAsrStreamChunk: (ws: WebSocket, request: unknown) => Promise<void>;
  onAsrStreamStop: (ws: WebSocket, request: unknown) => Promise<void>;
  onAsrStreamCancel: (ws: WebSocket, request: unknown) => Promise<void>;
  onAsrClientDebug: (ws: WebSocket, request: unknown) => void;
  onPing: (ws: WebSocket, payload: unknown) => void;
}

export function setupWebServerSocketLifecycle(options: WebServerSocketLifecycleOptions): void {
  options.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    options.onConnection?.(ws, request);
    options.logConnect();

    ws.on('message', async (data: Buffer) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        await options.onMessage(ws, message);
      } catch (error) {
        options.logMessageError(error);
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      options.onClose(ws, code, reason);
      options.logDisconnect();
    });

    ws.on('error', (error: Error) => {
      options.onError(ws, error);
    });
  });
}

export async function dispatchWebServerMessage(
  ws: WebSocket,
  message: WSMessage,
  handlers: WebServerMessageDispatchHandlers
): Promise<void> {
  switch (message.type) {
    case 'chat':
      await handlers.onChat(ws, message.data as ChatRequest);
      return;
    case 'cancel':
      handlers.onCancel(ws, (message.data ?? {}) as CancelRequest);
      return;
    case 'plan_input_response':
      handlers.onPlanInputResponse(ws, (message.data ?? {}) as PlanInputResponseRequest);
      return;
    case 'running_input_enqueue':
      handlers.onRunningInputEnqueue(ws, (message.data ?? {}) as RunningInputEnqueueRequest);
      return;
    case 'running_input_insert':
      handlers.onRunningInputInsert(ws, (message.data ?? {}) as RunningInputInsertRequest);
      return;
    case 'running_input_cancel':
      handlers.onRunningInputCancel(ws, (message.data ?? {}) as RunningInputCancelRequest);
      return;
    case 'stop_auto_loop':
      handlers.onStopAutoLoop(ws, (message.data ?? {}) as StopAutoLoopRequest);
      return;
    case 'asr_stream_start':
      await handlers.onAsrStreamStart(ws, message.data ?? {});
      return;
    case 'asr_stream_chunk':
      await handlers.onAsrStreamChunk(ws, message.data ?? {});
      return;
    case 'asr_stream_stop':
      await handlers.onAsrStreamStop(ws, message.data ?? {});
      return;
    case 'asr_stream_cancel':
      await handlers.onAsrStreamCancel(ws, message.data ?? {});
      return;
    case 'asr_client_debug':
      handlers.onAsrClientDebug(ws, message.data ?? {});
      return;
    case 'ping': {
      const payload =
        message.timestamp !== undefined
          ? {
              data: message.data,
              timestamp: message.timestamp,
            }
          : message.data;
      handlers.onPing(ws, payload);
      return;
    }
    default:
      return;
  }
}
