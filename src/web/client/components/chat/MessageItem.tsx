import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import type { Message } from '../../hooks/useAgent';
import { ToolCallBlock } from './ToolCallBlock.js';
import { ToolResultBlock } from './ToolResultBlock.js';
import { ThinkingBlock } from './ThinkingBlock.js';

interface MessageItemProps {
  message: Message;
}

const registeredLanguages = [
  ['bash', bash],
  ['diff', diff],
  ['javascript', javascript],
  ['json', json],
  ['markdown', markdown],
  ['powershell', powershell],
  ['python', python],
  ['sql', sql],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
] as const;

for (const [name, grammar] of registeredLanguages) {
  if (!hljs.getLanguage(name)) {
    hljs.registerLanguage(name, grammar);
  }
}

const autoDetectLanguages = registeredLanguages.map(([name]) => name);

function getAssistantModelLabel(message: Message): string {
  const model = String(message.metadata?.llmModel ?? '').trim();
  return model || 'LLM';
}

function normalizeLanguageName(value: string): string {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'yml':
      return 'yaml';
    case 'html':
      return 'xml';
    case 'sh':
    case 'shell':
    case 'zsh':
    case 'console':
      return 'bash';
    case 'ps1':
    case 'pwsh':
      return 'powershell';
    default:
      return normalized;
  }
}

const markdownComponents: Components = {
  a({ href, children, ...props }) {
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener" className="md-link">
        {children}
      </a>
    );
  },
  code({ className, children, ...props }) {
    const text = String(children ?? '').replace(/\n$/, '');
    const nodeType = String((props as { node?: { type?: string } }).node?.type ?? '');
    const inline = nodeType === 'inlineCode' || (!className && !text.includes('\n'));
    if (inline) {
      return <code className="md-inline-code">{children}</code>;
    }

    const languageMatch = /language-([\w-]+)/i.exec(className ?? '');
    const language = languageMatch ? normalizeLanguageName(languageMatch[1]) : '';
    let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    try {
      if (language && hljs.getLanguage(language)) {
        html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      } else {
        html = hljs.highlightAuto(text, autoDetectLanguages).value;
      }
    } catch {
      // fallback to escaped plain text
    }

    return (
      <pre className="md-code-block">
        <code className={language ? `hljs language-${language}` : 'hljs'} dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    );
  },
  blockquote({ children }) {
    return <blockquote className="md-quote">{children}</blockquote>;
  },
  table({ children }) {
    return (
      <div className="md-table-wrap">
        <table className="md-table">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="md-th">{children}</th>;
  },
  td({ children }) {
    return <td className="md-td">{children}</td>;
  },
  hr() {
    return <hr className="md-hr" />;
  },
};

export function MessageItem({ message }: MessageItemProps) {
  const theme = useThemeConfig();
  const isUser = message.role === 'user';
  const toolEventRows: React.ReactNode[] = [];
  const assistantModelLabel = getAssistantModelLabel(message);

  const totalToolRows = Math.max(message.toolCalls?.length ?? 0, message.toolResults?.length ?? 0);
  for (let index = 0; index < totalToolRows; index += 1) {
    const toolCall = message.toolCalls?.[index];
    const toolResult = message.toolResults?.[index];
    if (toolCall) {
      toolEventRows.push(
        <ToolCallBlock key={`tool-call-${message.id}-${index}`} name={toolCall.name} args={toolCall.args} />
      );
    }
    if (toolResult) {
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

  if (!message.content && !message.thinking && toolEventRows.length === 0) {
    return null;
  }

  return (
    <div className="flex justify-start mb-6">
      <div className="message-width-assistant w-full space-y-3">
        {message.thinking && <ThinkingBlock thinking={message.thinking} />}
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
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {message.content}
              </ReactMarkdown>
            </div>

            <div className="flex items-center gap-1 mt-3 pt-3 border-t border-white/10">
              <span className="text-xs opacity-50">{assistantModelLabel}</span>
              <span className="text-xs opacity-30">
                {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
