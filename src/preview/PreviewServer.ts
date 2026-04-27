import { EventEmitter } from 'events';
import type { AgentCallback, ToolResult } from '../types.js';

export interface PreviewEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'step' | 'error' | 'complete' | 'reset';
  timestamp: number;
  data: unknown;
}

export interface PreviewState {
  isRunning: boolean;
  currentStep: number;
  maxSteps: number;
  thinking: string | null;
  lastToolCall: { name: string; args: Record<string, unknown> } | null;
  lastToolResult: { name: string; result: ToolResult } | null;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  error: string | null;
  result: string | null;
}

export class PreviewServer extends EventEmitter {
  private state: PreviewState;
  private clients: Set<any> = new Set();

  constructor() {
    super();
    this.state = this.getInitialState();
  }

  private getInitialState(): PreviewState {
    return {
      isRunning: false,
      currentStep: 0,
      maxSteps: 100,
      thinking: null,
      lastToolCall: null,
      lastToolResult: null,
      messages: [],
      error: null,
      result: null,
    };
  }

  createCallback(): AgentCallback {
    return {
      onThinking: (thinking: string) => {
        this.state.thinking = thinking;
        this.broadcast({ type: 'thinking', timestamp: Date.now(), data: thinking });
      },

      onToolCall: (name: string, args: Record<string, unknown>) => {
        this.state.lastToolCall = { name, args };
        this.broadcast({ type: 'tool_call', timestamp: Date.now(), data: { name, args } });
      },

      onToolResult: (name: string, result: ToolResult) => {
        this.state.lastToolResult = { name, result };
        this.broadcast({ type: 'tool_result', timestamp: Date.now(), data: { name, result } });
      },

      onStep: (step: number, maxSteps: number) => {
        this.state.currentStep = step;
        this.state.maxSteps = maxSteps;
        this.state.isRunning = true;
        this.broadcast({ type: 'step', timestamp: Date.now(), data: { step, maxSteps } });
      },

      onMessage: (role: string, content: string) => {
        this.state.messages.push({ role, content, timestamp: Date.now() });
        this.broadcast({ type: 'message', timestamp: Date.now(), data: { role, content } });
      },

      onError: (error: Error) => {
        this.state.error = error.message;
        this.state.isRunning = false;
        this.broadcast({ type: 'error', timestamp: Date.now(), data: error.message });
      },

      onComplete: (result: string) => {
        this.state.result = result;
        this.state.isRunning = false;
        this.broadcast({ type: 'complete', timestamp: Date.now(), data: result });
      },
    };
  }

  broadcast(event: PreviewEvent): void {
    this.emit('event', event);
    for (const client of this.clients) {
      try {
        client(event);
      } catch {
        // Ignore client errors
      }
    }
  }

  subscribe(callback: (event: PreviewEvent) => void): () => void {
    this.clients.add(callback);
    return () => {
      this.clients.delete(callback);
    };
  }

  getState(): PreviewState {
    return { ...this.state };
  }

  reset(): void {
    this.state = this.getInitialState();
    this.broadcast({ type: 'reset', timestamp: Date.now(), data: null });
  }
}

export function createPreviewServer(): PreviewServer {
  return new PreviewServer();
}
