import { useEffect, useRef, useCallback, useState } from 'react';
import {
  ManagedInterval,
  ManagedTimeout,
  computeExponentialBackoffDelayMs,
} from '../../../runtime/async-primitives.js';
import {
  FAST_RECONNECT_ATTEMPTS,
  SLOW_RECONNECT_DELAY_MS,
  resolveReconnectPolicy,
} from '../websocket-reconnect-policy.js';

export interface WSMessage {
  type: string;
  data: unknown;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'reconnecting';

export interface ConnectionError {
  message: string;
  timestamp: string;
  recoverable: boolean;
}

export interface ConnectionToast {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: string;
  autoDismiss: boolean;
}

interface WebSocketLabels {
  reconnecting: (attempt: number, max: number) => string;
  connectionRestored: string;
  connectionFailedMax: (max: number) => string;
}

export function useWebSocket(
  url: string,
  options: {
    enabled?: boolean;
    labels: WebSocketLabels;
  }
) {
  const enabled = options.enabled !== false;
  const labelsRef = useRef<WebSocketLabels>(options.labels);
  const wsRef = useRef<WebSocket | null>(null);
  const socketGenerationRef = useRef(0);
  const hadConnectionErrorRef = useRef(false);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [lastError, setLastError] = useState<ConnectionError | null>(null);
  const [toasts, setToasts] = useState<ConnectionToast[]>([]);

  const listenersRef = useRef<Map<string, Set<(data: unknown) => void>>>(new Map());
  const reconnectTimeoutRef = useRef(new ManagedTimeout());
  const reconnectAttemptsRef = useRef(0);
  const isManualDisconnectRef = useRef(false);
  const connectRef = useRef<(() => void) | null>(null);
  const finalFailureToastShownRef = useRef(false);

  const heartbeatIntervalRef = useRef(new ManagedInterval());
  const heartbeatTimeoutRef = useRef(new ManagedTimeout());
  const lastHeartbeatRef = useRef<number>(Date.now());
  const missedHeartbeatsRef = useRef(0);

  const TOAST_AUTO_DISMISS_MS = 5000;
  const HEARTBEAT_INTERVAL_MS = 5000;
  const HEARTBEAT_TIMEOUT_MS = 3000;

  useEffect(() => {
    labelsRef.current = options.labels;
  }, [options.labels]);

  const addToast = useCallback((toast: Omit<ConnectionToast, 'id' | 'timestamp'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const nextToast: ConnectionToast = {
      ...toast,
      id,
      timestamp: new Date().toISOString(),
    };
    setToasts((prev) => [...prev, nextToast]);
    if (toast.autoDismiss) {
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, TOAST_AUTO_DISMISS_MS);
    }
    return id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const notifyFinalReconnectFailure = useCallback(() => {
    if (finalFailureToastShownRef.current) {
      return;
    }
    finalFailureToastShownRef.current = true;
    addToast({
      type: 'error',
      message: labelsRef.current.connectionFailedMax(FAST_RECONNECT_ATTEMPTS),
      autoDismiss: false,
    });
  }, [addToast]);

  const clearHeartbeat = useCallback(() => {
    heartbeatIntervalRef.current.clear();
    heartbeatTimeoutRef.current.clear();
    missedHeartbeatsRef.current = 0;
  }, []);

  const getReconnectDelay = useCallback((attempt: number): number => {
    return computeExponentialBackoffDelayMs(attempt, {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      minDelayMs: 250,
      jitterRatio: 0.25,
    });
  }, []);

  const scheduleReconnect = useCallback(
    (reason: 'close' | 'error' | 'heartbeat') => {
      if (isManualDisconnectRef.current) {
        return;
      }
      if (reconnectTimeoutRef.current.active) {
        return;
      }
      const nextAttempt = reconnectAttemptsRef.current + 1;
      const decision = resolveReconnectPolicy({
        nextAttempt,
        fastDelayMs: getReconnectDelay(nextAttempt),
        slowDelayMs: SLOW_RECONNECT_DELAY_MS,
      });
      reconnectAttemptsRef.current = decision.attempt;
      if (decision.slowMode) {
        notifyFinalReconnectFailure();
      }
      setConnectionStatus('reconnecting');
      console.log(
        `[WebSocket] ${reason}: reconnecting in ${decision.delayMs}ms (attempt ${decision.attempt}${
          decision.slowMode ? ', slow mode' : `/${FAST_RECONNECT_ATTEMPTS}`
        })`
      );
      if (!decision.slowMode) {
        addToast({
          type: 'info',
          message: labelsRef.current.reconnecting(decision.displayAttempt, decision.maxDisplayAttempts),
          autoDismiss: true,
        });
      }
      reconnectTimeoutRef.current.start(() => {
        if (isManualDisconnectRef.current) {
          return;
        }
        const state = wsRef.current?.readyState;
        if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
          return;
        }
        connectRef.current?.();
      }, decision.delayMs);
    },
    [addToast, getReconnectDelay, notifyFinalReconnectFailure]
  );

  const startHeartbeat = useCallback(() => {
    clearHeartbeat();

    const sendHeartbeat = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      heartbeatTimeoutRef.current.clear();

      try {
        const pingTimestamp = Date.now();
        ws.send(JSON.stringify({ type: 'ping', data: { timestamp: pingTimestamp } }));
        lastHeartbeatRef.current = pingTimestamp;
        heartbeatTimeoutRef.current.start(() => {
          missedHeartbeatsRef.current += 1;
          console.warn(`[WebSocket] Heartbeat timeout #${missedHeartbeatsRef.current}`);
          if (missedHeartbeatsRef.current >= 3) {
            console.error('[WebSocket] Multiple missed heartbeats, triggering reconnection');
            setConnectionStatus('error');
            scheduleReconnect('heartbeat');
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.close();
            }
          }
        }, HEARTBEAT_TIMEOUT_MS);
      } catch (error) {
        console.warn('[WebSocket] Failed to send heartbeat:', error);
      }
    };

    heartbeatIntervalRef.current.start(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    window.setTimeout(sendHeartbeat, 1000);
  }, [clearHeartbeat, scheduleReconnect]);

  const connect = useCallback(() => {
    if (!enabled) {
      return;
    }
    const current = wsRef.current;
    if (current?.readyState === WebSocket.OPEN || current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    isManualDisconnectRef.current = false;
    clearHeartbeat();
    setConnectionStatus(reconnectAttemptsRef.current > 0 ? 'reconnecting' : 'disconnected');

    socketGenerationRef.current += 1;
    const generation = socketGenerationRef.current;

    console.log('WebSocket connecting to:', url);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws || socketGenerationRef.current !== generation) {
        return;
      }
      console.log('WebSocket connected');
      const recovered = reconnectAttemptsRef.current > 0 || hadConnectionErrorRef.current;
      setIsConnected(true);
      setConnectionStatus('connected');
      reconnectAttemptsRef.current = 0;
      finalFailureToastShownRef.current = false;
      hadConnectionErrorRef.current = false;
      setLastError(null);
      startHeartbeat();
      reconnectTimeoutRef.current.clear();
      if (recovered) {
        addToast({
          type: 'success',
          message: labelsRef.current.connectionRestored,
          autoDismiss: true,
        });
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws || socketGenerationRef.current !== generation) {
        return;
      }
      console.log('WebSocket disconnected');
      setIsConnected(false);
      wsRef.current = null;
      clearHeartbeat();
      if (isManualDisconnectRef.current) {
        setConnectionStatus('disconnected');
        return;
      }
      scheduleReconnect('close');
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws || socketGenerationRef.current !== generation) {
        return;
      }
      try {
        const message: WSMessage = JSON.parse(event.data);
        const timestamp = new Date().toISOString();
        const dataPreview =
          typeof message.data === 'string'
            ? message.data.substring(0, 50)
            : JSON.stringify(message.data).substring(0, 50);
        console.log(`[${timestamp}] [WebSocket] Received type:`, message.type, '| data:', dataPreview);

        if (message.type === 'server_error') {
          const serverError = message.data as { error?: string; message?: string; timestamp?: string; recoverable?: boolean };
          const isRecoverable = serverError.recoverable ?? true;
          const error: ConnectionError = {
            message: serverError.message ?? serverError.error ?? 'Server error',
            timestamp: serverError.timestamp ?? new Date().toISOString(),
            recoverable: isRecoverable,
          };
          hadConnectionErrorRef.current = true;
          setLastError(error);
          if (!isRecoverable) {
            console.error('[WebSocket] Server error (non-recoverable):', error.message);
          }
        }

        if (message.type === 'connection_status') {
          const statusData = message.data as { status?: string; error?: string; timestamp?: string };
          if (statusData.status === 'error' && statusData.error) {
            hadConnectionErrorRef.current = true;
            setLastError({
              message: statusData.error,
              timestamp: statusData.timestamp ?? new Date().toISOString(),
              recoverable: true,
            });
          }
        }

        if (message.type === 'pong') {
          const pongData = message.data as { timestamp?: number; serverTime?: number };
          heartbeatTimeoutRef.current.clear();
          missedHeartbeatsRef.current = 0;
          lastHeartbeatRef.current = Date.now();
          console.log(
            `[WebSocket] Pong received: clientTs=${pongData.timestamp}, serverTs=${pongData.serverTime}, rtt=${
              Date.now() - (pongData.timestamp ?? Date.now())
            }ms`
          );
        }

        const listeners = listenersRef.current.get(message.type);
        if (listeners) {
          listeners.forEach((listener) => {
            try {
              listener(message.data);
            } catch (error) {
              console.error('Listener error:', error);
            }
          });
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onerror = (event) => {
      if (wsRef.current !== ws || socketGenerationRef.current !== generation) {
        return;
      }
      const timestamp = new Date().toISOString();
      const errorMessage =
        event instanceof ErrorEvent
          ? event.message || 'WebSocket connection error occurred'
          : 'WebSocket connection error occurred';
      const recoverable = true;
      const structuredError: ConnectionError = {
        message: errorMessage,
        timestamp,
        recoverable,
      };

      const errorLogEntry = {
        code: 'WS_CONNECTION_ERROR',
        message: errorMessage,
        timestamp,
        attempt: reconnectAttemptsRef.current,
        maxAttempts: FAST_RECONNECT_ATTEMPTS,
        recoverable,
      };

      if (!recoverable) {
        console.error(JSON.stringify(errorLogEntry));
        notifyFinalReconnectFailure();
      }

      hadConnectionErrorRef.current = true;
      setLastError(structuredError);
      setConnectionStatus('error');
      scheduleReconnect('error');
    };
  }, [clearHeartbeat, enabled, notifyFinalReconnectFailure, scheduleReconnect, startHeartbeat, url]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const disconnect = useCallback(() => {
    isManualDisconnectRef.current = true;
    socketGenerationRef.current += 1;
    reconnectTimeoutRef.current.clear();
    clearHeartbeat();
    reconnectAttemptsRef.current = 0;
    finalFailureToastShownRef.current = false;
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
    setConnectionStatus('disconnected');
  }, [clearHeartbeat]);

  const send = useCallback((message: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
      return true;
    }
    console.error('WebSocket not connected, cannot send message');
    return false;
  }, []);

  const subscribe = useCallback((type: string, listener: (data: unknown) => void) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type)?.add(listener);
    return () => {
      listenersRef.current.get(type)?.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      disconnect();
      return;
    }
    connect();
    return () => disconnect();
  }, [connect, disconnect, enabled]);

  return {
    isConnected,
    connectionStatus,
    lastError,
    send,
    subscribe,
    connect,
    disconnect,
    addToast,
    dismissToast,
    clearToasts,
    toasts,
    ws: wsRef,
  };
}
