export { LLMClient } from './LLMClient.js';
export type { LLMRuntime, StreamCallbacks, LLMClientConfig, LLMRequestOptions, LLMStreamEvent } from './runtime-types.js';
export {
  sanitizeMessagesForToolProtocol,
  estimateMessageContentCharacters,
  estimateMessageCharacters,
  estimateMessagesCharacters,
  trimMessagesForContextWindow,
  prepareMessagesForModel,
  isMiniMaxToolResultIdNotFoundError,
  extractMissingToolCallId,
  isMiniMaxContextWindowExceededError,
  messageTextContent,
} from './message-preparation.js';
export { buildToolProtocolFrames } from './tool-protocol.js';

// Export types from types.ts
export type {
  ToolProtocolFrame,
  ToolProtocolMetrics,
  ToolProtocolBuildResult,
  ToolProtocolSanitizeResult,
  ContextWindowTrimOptions,
  ContextWindowTrimResult,
  PreparedMessagesSnapshot,
  PreparedMessagesResult
} from '../types.js';
