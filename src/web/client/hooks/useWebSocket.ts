import { useEffect, useRef, useCallback, useState } from 'react';

export interface WSMessage {
  type: string;
  data: unknown;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'reconnecting' | 'polling';

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

export function useWebSocket(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const socketGenerationRef = useRef(0);
  const hadConnectionErrorRef = useRef(false);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [lastError, setLastError] = useState<ConnectionError | null>(null);
  const [toasts, setToasts] = useState<ConnectionToast[]>([]);

  const listenersRef = useRef<Map<string, Set<(data: unknown) => void>>>(new Map());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isManualDisconnectRef = useRef(false);
  const connectRef = useRef<(() => void) | null>(null);

  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastHeartbeatRef = useRef<number>(Date.now());
  const missedHeartbeatsRef = useRef(0);

  const MAX_RECONNECT_ATTEMPTS = 8;
  const POLLING_INTERVAL_MS = 5000;
  const TOAST_AUTO_DISMISS_MS = 5000;
  const HEARTBEAT_INTERVAL_MS = 5000;
  const HEARTBEAT_TIMEOUT_MS = 3000;

  const addToast = useCallback((toast: Omit<ConnectionToast, 'id' | 'timestamp'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const nextToast: ConnectionToast = {
      ...toast,
      id,
      timestamp: new Date().toISOString(),
    };
    setToasts((prev) => [...prev, nextToast]);
    if (toast.autoDismiss) {
      setTimeout(() => {
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

  const clearPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
    missedHeartbeatsRef.current = 0;
  }, []);

  const persistContextBackup = useCallback((key: string, data: unknown) => {
    try {
      localStorage.setItem(
        `ws_context_backup_${key}`,
        JSON.stringify({
          data,
          timestamp: new Date().toISOString(),
        })
      );
    } catch (error) {
      console.warn('[WebSocket] Failed to persist context backup:', error);
    }
  }, []);

  const getContextBackup = useCallback((key: string): unknown | null => {
    try {
      const stored = localStorage.getItem(`ws_context_backup_${key}`);
      if (stored) {
        const parsed = JSON.parse(stored) as { data?: unknown };
        return parsed.data ?? null;
      }
    } catch (error) {
      console.warn('[WebSocket] Failed to retrieve context backup:', error);
    }
    return null;
  }, []);

  const clearContextBackup = useCallback((key: string) => {
    try {
      localStorage.removeItem(`ws_context_backup_${key}`);
    } catch (error) {
      console.warn('[WebSocket] Failed to clear context backup:', error);
    }
  }, []);

  const startPollingFallback = useCallback(() => {
    console.log('[WebSocket] Starting polling fallback mechanism');
    setConnectionStatus('polling');
    clearPolling();
    clearHeartbeat();
    pollingIntervalRef.current = setInterval(() => {
      console.log('[WebSocket] Polling fallback: checking connection status...');
    }, POLLING_INTERVAL_MS);
  }, [clearPolling, clearHeartbeat]);

  const getReconnectDelay = useCallback((attempt: number): number => {
    const baseDelay = Math.min(1000 * Math.pow(2, attempt), 10000);
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    return Math.max(250, Math.round(baseDelay + jitter));
  }, []);

  const scheduleReconnect = useCallback(
    (reason: 'close' | 'error' | 'heartbeat') => {
      if (isManualDisconnectRef.current) {
        return;
      }
      if (pollingIntervalRef.current) {
        return;
      }
      if (reconnectTimeoutRef.current) {
        return;
      }
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`[WebSocket] ${reason}: max reconnect attempts reached, using polling fallback`);
        startPollingFallback();
        addToast({
          type: 'error',
          message: 'Connection lost. Using offline mode.',
          autoDismiss: false,
        });
        return;
      }

      reconnectAttemptsRef.current += 1;
      const attempt = reconnectAttemptsRef.current;
      const delay = getReconnectDelay(attempt);
      setConnectionStatus('reconnecting');
      console.log(`[WebSocket] ${reason}: reconnecting in ${delay}ms (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`);
      addToast({
        type: 'info',
        message: `Reconnecting... (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`,
        autoDismiss: true,
      });
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        if (isManualDisconnectRef.current) {
          return;
        }
        const state = wsRef.current?.readyState;
        if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
          return;
        }
        connectRef.current?.();
      }, delay);
    },
    [addToast, getReconnectDelay, startPollingFallback]
  );

  const startHeartbeat = useCallback(() => {
    clearHeartbeat();

    const sendHeartbeat = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (heartbeatTimeoutRef.current) {
        clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }

      try {
        const pingTimestamp = Date.now();
        ws.send(JSON.stringify({ type: 'ping', data: { timestamp: pingTimestamp } }));
        lastHeartbeatRef.current = pingTimestamp;
        heartbeatTimeoutRef.current = setTimeout(() => {
          heartbeatTimeoutRef.current = null;
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

    heartbeatIntervalRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    setTimeout(sendHeartbeat, 1000);
  }, [clearHeartbeat, scheduleReconnect]);

  const connect = useCallback(() => {
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
      hadConnectionErrorRef.current = false;
      setLastError(null);
      clearPolling();
      startHeartbeat();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (recovered) {
        addToast({
          type: 'success',
          message: 'Connection restored',
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
          const isRecoverable = serverError.recoverable ?? (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS);
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
          if (heartbeatTimeoutRef.current) {
            clearTimeout(heartbeatTimeoutRef.current);
            heartbeatTimeoutRef.current = null;
          }
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
      const recoverable = reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS;
      const structuredError: ConnectionError = {
        message: errorMessage,
        timestamp,
        recoverable,
      };

      // REQ-0001: Log structured error for telemetry
      const errorLogEntry = {
        code: 'WS_CONNECTION_ERROR',
        message: errorMessage,
        timestamp,
        attempt: reconnectAttemptsRef.current,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        recoverable,
      };

      if (!recoverable) {
        console.error(JSON.stringify(errorLogEntry));
        // REQ-0001: Show non-dismissable error toast with retry option when max attempts reached
        addToast({
          type: 'error',
          message: `Connection failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Click to retry.`,
          autoDismiss: false,
        });
      }

      hadConnectionErrorRef.current = true;
      setLastError(structuredError);
      setConnectionStatus('error');
      scheduleReconnect('error');
    };
  }, [addToast, clearHeartbeat, clearPolling, scheduleReconnect, startHeartbeat, url]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const disconnect = useCallback(() => {
    isManualDisconnectRef.current = true;
    socketGenerationRef.current += 1;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    clearPolling();
    clearHeartbeat();
    reconnectAttemptsRef.current = 0;
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
  }, [clearHeartbeat, clearPolling]);

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
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    if (isConnected) {
      clearContextBackup('pending');
    }
  }, [isConnected, clearContextBackup]);

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
    persistContextBackup,
    getContextBackup,
    clearContextBackup,
  };
}
