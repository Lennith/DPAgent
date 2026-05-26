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
      // Render escaped plain text if highlighting cannot parse the block.
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

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
