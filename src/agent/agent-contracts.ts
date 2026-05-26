import type {
  AgentCallback,
  ContextUsageEstimate,
  MaxTokensRecoveryEvent,
  Message,
  PersistedMessage,
  ResolvedContextBudget,
  TokenUsage,
  ToolResultArtifactRef,
} from '../types.js';
import type { LLMRuntime } from '../llm/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { ContextUsageCalibrationStore } from '../runtime/context-usage-calibration-store.js';
import type { PreparedInputUsageSnapshot } from '../runtime/context-window-budget.js';

export interface AgentRunResult {
  content: string;
  finishReason?: string;
  step: number;
  usage?: TokenUsage;
  recoveredFromMaxTokens?: boolean;
  maxTokensRecoveryAttempt?: number;
  maxTokensEvents?: MaxTokensRecoveryEvent[];
}

export interface CompressionChunk {
  messages: Message[];
  preparedMessages: PersistedMessage[];
  chars: number;
}

export interface PreparedInputUsageEstimateResult {
  snapshot: PreparedInputUsageSnapshot;
  staticEstimate: ContextUsageEstimate;
  calibratedEstimate: ContextUsageEstimate;
  effectiveEstimate: ContextUsageEstimate;
  calibrationMultiplier: number;
  anchorPromptTokens?: number;
  deltaEstimatedTokens?: number;
}

export interface AgentOptions {
  llmClient: LLMRuntime;
  toolRegistry: ToolRegistry;
  systemPrompt: string;
  maxSteps?: number;
  tokenLimit?: number;
  contextBudget: ResolvedContextBudget;
  workspaceDir?: string;
  callback?: AgentCallback;
  mcpToolDescriptions?: string;
  materializeToolResultArtifact?: (input: {
    toolName: string;
    toolCallId: string;
    content: string;
    thresholdChars?: number;
    previewChars?: number;
  }) => Promise<{ content: string; artifact?: ToolResultArtifactRef }> | { content: string; artifact?: ToolResultArtifactRef };
  contextOverflowMaxErrorsBeforeTrim?: number;
  maxTokensRecoveryMaxAttempts?: number;
  progressOnlyRecoveryEnabled?: boolean;
  contextUsageCalibrationStore?: ContextUsageCalibrationStore;
}
