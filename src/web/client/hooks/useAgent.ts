import { useState, useCallback } from 'react';

export interface ToolCall {
  toolCallId?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  result: {
    success: boolean;
    content: string;
    error?: string;
  };
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  metadata?: {
    llmProviderProfileId?: string;
    llmProvider?: string;
    llmModel?: string;
    thinkingComplete?: boolean;
  };
}

export interface AgentState {
  isRunning: boolean;
  currentStep: number;
  maxSteps: number;
  thinking: string | null;
  currentToolCall: ToolCall | null;
  currentToolResult: ToolResult | null;
  messages: Message[];
  error: string | null;
  result: string | null;
}

export function useAgent() {
  const [state, setState] = useState<AgentState>({
    isRunning: false,
    currentStep: 0,
    maxSteps: 100,
    thinking: null,
    currentToolCall: null,
    currentToolResult: null,
    messages: [],
    error: null,
    result: null,
  });

  const setRunning = useCallback((isRunning: boolean) => {
    setState((prev) => ({ ...prev, isRunning }));
  }, []);

  const setStep = useCallback((step: number, maxSteps: number) => {
    setState((prev) => ({ ...prev, currentStep: step, maxSteps, isRunning: true }));
  }, []);

  const setThinking = useCallback((thinking: string | null) => {
    setState((prev) => ({ 
      ...prev, 
      thinking,
      // 确保在设置 thinking 时 isRunning 为 true
      isRunning: thinking ? true : prev.isRunning 
    }));
  }, []);

  const setToolCall = useCallback((toolCall: ToolCall | null) => {
    setState((prev) => ({ 
      ...prev, 
      currentToolCall: toolCall,
      // 确保在设置 toolCall 时 isRunning 为 true
      isRunning: toolCall ? true : prev.isRunning
    }));
  }, []);

  const setToolResult = useCallback((toolResult: ToolResult | null) => {
    setState((prev) => ({ 
      ...prev, 
      currentToolResult: toolResult,
      // 确保在设置 toolResult 时 isRunning 为 true
      isRunning: toolResult ? true : prev.isRunning
    }));
  }, []);

  const addMessage = useCallback((role: 'user' | 'assistant' | 'system', content: string) => {
    setState((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          role,
          content,
          timestamp: Date.now(),
        },
      ],
    }));
  }, []);

  const addMessageWithDetails = useCallback((
    role: 'user' | 'assistant' | 'system',
    content: string,
    thinking?: string,
    toolCalls?: ToolCall[],
    toolResults?: ToolResult[]
  ) => {
    setState((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id: `msg-${Date.now()}`,
          role,
          content,
          timestamp: Date.now(),
          thinking,
          toolCalls,
          toolResults,
        },
      ],
    }));
  }, []);

  const setMessages = useCallback((messages: Message[]) => {
    setState((prev) => ({ ...prev, messages }));
  }, []);

  const setError = useCallback((error: string | null) => {
    setState((prev) => ({ ...prev, error, isRunning: false }));
  }, []);

  const setResult = useCallback((result: string | null) => {
    setState((prev) => ({ ...prev, result, isRunning: false }));
  }, []);

  const reset = useCallback(() => {
    setState({
      isRunning: false,
      currentStep: 0,
      maxSteps: 100,
      thinking: null,
      currentToolCall: null,
      currentToolResult: null,
      messages: [],
      error: null,
      result: null,
    });
  }, []);

  const clearRunningState = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isRunning: false,
      thinking: null,
      currentToolCall: null,
      currentToolResult: null,
    }));
  }, []);

  return {
    state,
    setRunning,
    setStep,
    setThinking,
    setToolCall,
    setToolResult,
    addMessage,
    addMessageWithDetails,
    setMessages,
    setError,
    setResult,
    reset,
    clearRunningState,
  };
}
