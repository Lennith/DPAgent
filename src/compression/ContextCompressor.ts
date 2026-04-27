import type { LLMRuntime } from '../llm/index.js';
import { buildCompressionPrompt, buildCompressedHistoryPrompt } from './prompts.js';
import type { PersistedMessage } from '../types.js';

export interface CompressionResult {
  success: boolean;
  compressedContent?: string;
  originalSize: number;
  compressedSize?: number;
  error?: string;
}

export class ContextCompressor {
  private llmClient: LLMRuntime;
  private targetRatio: number;

  constructor(llmClient: LLMRuntime, targetRatio: number = 0.3) {
    this.llmClient = llmClient;
    this.targetRatio = targetRatio;
  }

  private async generateCompressedContent(prompt: string, maxTokens: number = 4000): Promise<string> {
    const response = await this.llmClient.generate([{ role: 'user', content: prompt }], undefined, undefined, {
      maxTokens,
    });
    return response.content;
  }

  async compress(messages: PersistedMessage[]): Promise<CompressionResult> {
    const messagesToCompress = messages.filter(m => m.role !== 'system');
    
    if (messagesToCompress.length === 0) {
      return {
        success: false,
        originalSize: 0,
        error: 'No messages to compress',
      };
    }

    const formattedMessages = messagesToCompress.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));

    const prompt = buildCompressionPrompt(formattedMessages);
    const originalSize = prompt.length;

    try {
      const compressedContent = await this.generateCompressedContent(prompt, 4000);
      const compressedSize = compressedContent.length;

      if (compressedSize > originalSize * 0.5) {
        console.warn(`Compression warning: result size ${compressedSize} is larger than 50% of original ${originalSize}`);
      }

      return {
        success: true,
        compressedContent,
        originalSize,
        compressedSize,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        originalSize,
        error: `Compression failed: ${errorMessage}`,
      };
    }
  }

  async compressCompressedHistory(
    messages: PersistedMessage[],
    previousSummary?: string,
    maxTokens: number = 3000
  ): Promise<CompressionResult> {
    const messagesToCompress = messages.filter((message) => message.role !== 'system');
    if (messagesToCompress.length === 0) {
      return {
        success: false,
        originalSize: 0,
        error: 'No messages to compress',
      };
    }

    const originalSize = messagesToCompress.reduce((sum, message) => sum + message.content.length, 0);
    const formattedMessages = messagesToCompress.map((message) => ({
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
    }));
    const prompt = buildCompressedHistoryPrompt(formattedMessages, previousSummary);

    try {
      const compressedContent = await this.generateCompressedContent(prompt, maxTokens);
      return {
        success: true,
        compressedContent,
        originalSize,
        compressedSize: compressedContent.length,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        originalSize,
        error: `Compressed history generation failed: ${errorMessage}`,
      };
    }
  }

  async compressIfNeeded(
    messages: PersistedMessage[],
    threshold: number
  ): Promise<CompressionResult> {
    const messagesToCompress = messages.filter(m => m.role !== 'system');
    const currentSize = messagesToCompress.reduce((sum, m) => sum + m.content.length, 0);

    if (currentSize < threshold) {
      return {
        success: true,
        compressedContent: undefined,
        originalSize: currentSize,
        compressedSize: currentSize,
      };
    }

    return this.compress(messages);
  }
}

export function createContextCompressor(llmClient: LLMRuntime, targetRatio?: number): ContextCompressor {
  return new ContextCompressor(llmClient, targetRatio);
}
