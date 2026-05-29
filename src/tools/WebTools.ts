import { Tool, errorResult, successResult } from './Tool.js';
import type { ToolResult } from '../types.js';

function readInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(min, Math.min(max, Math.floor(value)));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(min, Math.min(max, Math.floor(parsed)));
    }
  }
  return fallback;
}

function withTimeout(timeoutMs: number): { controller: AbortController; timer: NodeJS.Timeout } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timer };
}

function safeText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTextFromHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const flattened = withoutScripts
    .replace(/<\/(p|div|section|article|h1|h2|h3|h4|h5|h6|li|tr|td|th|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decoded = decodeHtmlEntities(flattened);
  return decoded
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function fetchViaService(url: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const endpoint = String(process.env.MINIMAX_WEB_FETCH_URL ?? '').trim();
  const apiKey = String(process.env.MINIMAX_WEB_FETCH_API_KEY ?? '').trim();
  if (!endpoint || !apiKey) {
    return { ok: false, error: 'fetch service is not configured' };
  }
  const timeoutMs = readInteger(process.env.MINIMAX_WEB_FETCH_TIMEOUT_MS, 60000, 3000, 180000);
  const { controller, timer } = withTimeout(timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/markdown',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) {
      return { ok: false, error: `fetch service http ${response.status}` };
    }
    const content = await response.text();
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: `fetch service request failed: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

class BaseFetchURLTool extends Tool {
  get name(): string {
    return 'web_fetch';
  }

  get description(): string {
    return 'Fetch an http/https URL and return extracted text content. When a configured fetch service is unavailable, this falls back to direct fetch plus lightweight HTML text extraction. Output is truncated to stay within response limits.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The http/https URL to fetch content from.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional request timeout in milliseconds for the direct-fetch fallback path. Default 60000.',
        },
      },
      required: ['url'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = String(args.url ?? '').trim();
    if (!url) {
      return errorResult('url is required');
    }
    if (!/^https?:\/\//i.test(url)) {
      return errorResult('url must start with http:// or https://');
    }

    const serviceResult = await fetchViaService(url);
    if (serviceResult.ok) {
      return successResult(safeText(serviceResult.content, 16000));
    }

    const timeoutMs = readInteger(args.timeout_ms, 60000, 3000, 180000);
    const { controller, timer } = withTimeout(timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
      });
      if (response.status >= 400) {
        return errorResult(`Failed to fetch URL. Status: ${response.status}`);
      }
      const raw = await response.text();
      const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
      if (!raw.trim()) {
        return successResult('The response body is empty.');
      }
      if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
        return successResult(safeText(raw, 16000));
      }
      const extracted = extractTextFromHtml(raw);
      if (!extracted) {
        return errorResult('Failed to extract meaningful content from the page.');
      }
      return successResult(safeText(extracted, 16000));
    } catch (err) {
      return errorResult(`Failed to fetch URL: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class WebFetchTool extends BaseFetchURLTool {
}

export function createWebTools(): Tool[] {
  return [new WebFetchTool()];
}
