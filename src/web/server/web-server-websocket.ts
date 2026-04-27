import { WebSocketServer, type WebSocket } from 'ws';
import type {
  CancelRequest,
  ChatRequest,
  DismissInterruptedArtifactRequest,
  PlanInputResponseRequest,
  ResumeFailedTurnRequest,
  StopAutoLoopRequest,
  WSMessage,
} from './web-server-shared.js';

export interface WebServerSocketLifecycleOptions {
  wss: WebSocketServer;
  onMessage: (ws: WebSocket, message: WSMessage) => Promise<void>;
  onClose: (ws: WebSocket) => void;
  onError: (ws: WebSocket, error: Error) => void;
  logConnect: () => void;
  logDisconnect: () => void;
  logMessageError: (error: unknown) => void;
}

export interface WebServerMessageDispatchHandlers {
  onChat: (ws: WebSocket, request: ChatRequest) => Promise<void>;
  onChatResume: (ws: WebSocket) => void;
  onCancel: (ws: WebSocket, request: CancelRequest) => void;
  onResumeFailedTurn: (ws: WebSocket, request: ResumeFailedTurnRequest) => Promise<void>;
  onDismissInterruptedArtifact: (ws: WebSocket, request: DismissInterruptedArtifactRequest) => void;
  onPlanInputResponse: (ws: WebSocket, request: PlanInputResponseRequest) => void;
  onStopAutoLoop: (ws: WebSocket, request: StopAutoLoopRequest) => void;
  onPing: (ws: WebSocket, payload: unknown) => void;
}

export function setupWebServerSocketLifecycle(options: WebServerSocketLifecycleOptions): void {
  options.wss.on('connection', (ws: WebSocket) => {
    options.logConnect();

    ws.on('message', async (data: Buffer) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        await options.onMessage(ws, message);
      } catch (error) {
        options.logMessageError(error);
      }
    });

    ws.on('close', () => {
      options.onClose(ws);
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
    case 'chat_resume':
      handlers.onChatResume(ws);
      return;
    case 'cancel':
      handlers.onCancel(ws, (message.data ?? {}) as CancelRequest);
      return;
    case 'resume_failed_turn':
      await handlers.onResumeFailedTurn(ws, (message.data ?? {}) as ResumeFailedTurnRequest);
      return;
    case 'dismiss_interrupted_artifact':
      handlers.onDismissInterruptedArtifact(ws, (message.data ?? {}) as DismissInterruptedArtifactRequest);
      return;
    case 'plan_input_response':
      handlers.onPlanInputResponse(ws, (message.data ?? {}) as PlanInputResponseRequest);
      return;
    case 'stop_auto_loop':
      handlers.onStopAutoLoop(ws, (message.data ?? {}) as StopAutoLoopRequest);
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
