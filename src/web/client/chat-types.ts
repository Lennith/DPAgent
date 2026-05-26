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
    runtimeEvent?: 'run_error';
    runId?: string;
  };
}
