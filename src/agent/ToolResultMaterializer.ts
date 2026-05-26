import { messageTextContent } from '../llm/index.js';
import {
  buildAgentToolResultTruncatedContent,
  DEFAULT_ARTIFACT_PREVIEW_CHARS,
  redactToolCallArgumentsForCheckpoint,
  resolveAgentToolResultInlineChars,
  shouldMaterializeLiveToolResult,
} from '../runtime/tool-result-payload-policy.js';
import type { Message, ToolResultArtifactRef } from '../types.js';
import type { AgentOptions } from './agent-contracts.js';

export interface ToolResultMaterializerOptions {
  materializeToolResultArtifact?: AgentOptions['materializeToolResultArtifact'];
}

export class ToolResultMaterializer {
  constructor(private readonly options: ToolResultMaterializerOptions = {}) {}

  resolveCharLimit(toolName?: string): number {
    return resolveAgentToolResultInlineChars(toolName);
  }

  async materialize(input: {
    toolName: string;
    toolCallId: string;
    content: string;
  }): Promise<{ content: string; artifact?: ToolResultArtifactRef }> {
    if (!this.options.materializeToolResultArtifact) {
      return { content: input.content };
    }
    if (!shouldMaterializeLiveToolResult(input.toolName)) {
      return { content: input.content };
    }
    const charLimit = this.resolveCharLimit(input.toolName);
    return this.options.materializeToolResultArtifact({
      ...input,
      thresholdChars: charLimit,
      previewChars: Math.min(DEFAULT_ARTIFACT_PREVIEW_CHARS, charLimit),
    });
  }

  sanitize(message: Message): Message {
    if (message.role !== 'tool') {
      return message;
    }
    if (message.metadata?.toolResultArtifact) {
      return message;
    }
    const maxChars = this.resolveCharLimit(message.name);
    const original = messageTextContent(message.content);
    if (original.length <= maxChars) {
      return message;
    }
    return {
      ...message,
      content: buildAgentToolResultTruncatedContent(message.name, original, maxChars),
    };
  }

  redactToolCallArgumentsForCheckpoint(
    toolName: string | undefined,
    args: Record<string, unknown>
  ): Record<string, unknown> {
    return redactToolCallArgumentsForCheckpoint(toolName, args);
  }
}
