import React from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import type { Message } from '../../chat-types';
import { ToolCallBlock } from './ToolCallBlock.js';
import { ToolResultBlock } from './ToolResultBlock.js';
import { ThinkingBlock } from './ThinkingBlock.js';
import { MarkdownContent } from './MarkdownContent.js';
import { DownloadAttachmentBlock } from './DownloadAttachmentBlock.js';
import { collectDownloadAttachments, parseSendFileToUserResult } from './downloadAttachment.js';
import { DEFAULT_CHAT_DISPLAY_FILTERS, type ChatDisplayFilters } from './chat-display-filters.js';

interface MessageItemProps {
  message: Message;
  displayFilters?: ChatDisplayFilters;
}

function getAssistantModelLabel(message: Message): string {
  const model = String(message.metadata?.llmModel ?? '').trim();
  return model || 'LLM';
}

export function MessageItem({ message, displayFilters = DEFAULT_CHAT_DISPLAY_FILTERS }: MessageItemProps) {
  const theme = useThemeConfig();
  const isUser = message.role === 'user';
  const isRuntimeError = message.metadata?.runtimeEvent === 'run_error';
  const toolEventRows: React.ReactNode[] = [];
  const assistantModelLabel = getAssistantModelLabel(message);
  const downloadAttachments = collectDownloadAttachments(message.toolResults);
  const visibleThinking = displayFilters.showThinking ? message.thinking : undefined;

  const totalToolRows = Math.max(message.toolCalls?.length ?? 0, message.toolResults?.length ?? 0);
  for (let index = 0; index < totalToolRows; index += 1) {
    const toolCall = message.toolCalls?.[index];
    const toolResult = message.toolResults?.[index];
    if (toolCall && displayFilters.showToolCall) {
      toolEventRows.push(
        <ToolCallBlock key={`tool-call-${message.id}-${index}`} name={toolCall.name} args={toolCall.args} />
      );
    }
    if (toolResult && displayFilters.showToolResult && !parseSendFileToUserResult(toolResult)) {
      toolEventRows.push(
        <ToolResultBlock key={`tool-result-${message.id}-${index}`} name={toolResult.name} result={toolResult.result} />
      );
    }
  }

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div
          className="message-width-user px-5 py-3 rounded-3xl rounded-br-xl"
          style={{
            background: theme.colors.userMessage.bg,
            color: theme.colors.userMessage.text,
            boxShadow: theme.colors.userMessage.shadow,
          }}
        >
          <span className="text-sm leading-relaxed">{message.content}</span>
        </div>
      </div>
    );
  }

  if (!message.content && !visibleThinking && toolEventRows.length === 0 && downloadAttachments.length === 0) {
    return null;
  }

  if (isRuntimeError) {
    return (
      <div className="flex justify-start mb-6">
        <div className="message-width-assistant w-full">
          <div
            className="rounded-2xl border px-5 py-4"
            data-runtime-error-message="true"
            style={{
              backgroundColor: theme.colors.toolResult.error.bg,
              borderColor: theme.colors.toolResult.error.border,
              color: theme.colors.text.primary,
            }}
          >
            <div className="mb-2 flex items-center gap-2 font-semibold" style={{ color: theme.colors.toolResult.error.text }}>
              <span>!</span>
              <span>Error</span>
            </div>
            <div className="text-sm leading-relaxed">
              <MarkdownContent content={message.content} />
            </div>
            <div className="mt-3 text-xs opacity-50">
              {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-6">
      <div className="message-width-assistant w-full space-y-3">
        {visibleThinking && <ThinkingBlock thinking={visibleThinking} />}
        {toolEventRows.length > 0 && <div className="space-y-3">{toolEventRows}</div>}
        {message.content && (
          <div
            className="max-w-none px-5 py-4 rounded-2xl rounded-bl-xl border shadow-sm"
            style={{
              backgroundColor: theme.colors.assistantMessage.bg,
              borderColor: theme.colors.assistantMessage.border,
              color: theme.colors.assistantMessage.text,
            }}
          >
            <MarkdownContent content={message.content} />

            <div className="flex items-center gap-1 mt-3 pt-3 border-t border-white/10">
              <span className="text-xs opacity-50">{assistantModelLabel}</span>
              <span className="text-xs opacity-30">
                {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        )}
        {downloadAttachments.length > 0 && <DownloadAttachmentBlock attachments={downloadAttachments} />}
      </div>
    </div>
  );
}
