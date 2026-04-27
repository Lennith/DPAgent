import { Tool, errorResult, successResult } from './Tool.js';
import type { ToolResult } from '../types.js';

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  date?: string;
}

interface SearchServiceResponse {
  search_results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    content?: string;
    date?: string;
  }>;
}

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

function formatSearchResults(results: SearchResultItem[]): string {
  if (results.length === 0) {
    return 'No search results found.';
  }
  return results
    .map((item, idx) => {
      const lines = [
        `${idx + 1}. Title: ${item.title || '(no title)'}`,
        `Date: ${item.date || ''}`,
        `URL: ${item.url || ''}`,
        `Summary: ${item.snippet || ''}`,
      ];
      const content = String(item.content ?? '').trim();
      if (content.length > 0) {
        lines.push('', safeText(content, 6000));
      }
      return lines.join('\n');
    })
    .join('\n\n---\n\n');
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

async function searchViaService(
  query: string,
  limit: number,
  includeContent: boolean
): Promise<{ ok: true; results: SearchResultItem[] } | { ok: false; error: string }> {
  const endpoint = String(process.env.MINIMAX_WEB_SEARCH_URL ?? '').trim();
  const apiKey = String(process.env.MINIMAX_WEB_SEARCH_API_KEY ?? '').trim();
  if (!endpoint || !apiKey) {
    return { ok: false, error: 'search service is not configured' };
  }
  const timeoutMs = readInteger(process.env.MINIMAX_WEB_SEARCH_TIMEOUT_MS, 90000, 3000, 180000);
  const { controller, timer } = withTimeout(timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text_query: query,
        limit,
        enable_page_crawling: includeContent,
        timeout_seconds: 30,
      }),
    });
    if (!response.ok) {
      return { ok: false, error: `search service http ${response.status}` };
    }
    const data = (await response.json()) as SearchServiceResponse;
    const rows = Array.isArray(data.search_results) ? data.search_results : [];
    return {
      ok: true,
      results: rows.map((item) => ({
        title: String(item.title ?? ''),
        url: String(item.url ?? ''),
        snippet: String(item.snippet ?? ''),
        content: String(item.content ?? ''),
        date: String(item.date ?? ''),
      })),
    };
  } catch (err) {
    return { ok: false, error: `search service request failed: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function searchViaDuckDuckGo(query: string, limit: number): Promise<SearchResultItem[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`search request failed: HTTP ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const rows: SearchResultItem[] = [];
  const abstractText = typeof data.AbstractText === 'string' ? data.AbstractText : '';
  const abstractUrl = typeof data.AbstractURL === 'string' ? data.AbstractURL : '';
  if (abstractText || abstractUrl) {
    rows.push({
      title: 'Instant Answer',
      url: abstractUrl,
      snippet: abstractText,
      content: '',
      date: '',
    });
  }
  const relatedTopics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  for (const topic of relatedTopics) {
    if (rows.length >= limit) {
      break;
    }
    if (!topic || typeof topic !== 'object') {
      continue;
    }
    const row = topic as Record<string, unknown>;
    const text = typeof row.Text === 'string' ? row.Text : '';
    const firstUrl = typeof row.FirstURL === 'string' ? row.FirstURL : '';
    if (!text && !firstUrl) {
      continue;
    }
    rows.push({
      title: text.length > 80 ? `${text.slice(0, 80)}...` : text || 'Search Result',
      url: firstUrl,
      snippet: text,
      content: '',
      date: '',
    });
  }
  return rows.slice(0, limit);
}

class BaseSearchWebTool extends Tool {
  get name(): string {
    return 'web_search';
  }

  get description(): string {
    return 'Search the internet for current information such as news, docs, blogs, and release notes. Prefers the configured search service when available; otherwise falls back to a simplified DuckDuckGo result set that may omit full-page content.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Query text to search for.',
        },
        limit: {
          type: 'number',
          description: 'How many results to return. Default 5, range 1-20.',
          default: 5,
        },
        include_content: {
          type: 'boolean',
          description: 'Whether to include crawled page content when the configured search service supports it. Fallback search only returns simplified snippets.',
          default: false,
        },
      },
      required: ['query'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return errorResult('query is required');
    }
    const limit = readInteger(args.limit, 5, 1, 20);
    const includeContent = Boolean(args.include_content);

    const serviceResult = await searchViaService(query, limit, includeContent);
    if (serviceResult.ok) {
      return successResult(formatSearchResults(serviceResult.results));
    }

    try {
      const fallbackRows = await searchViaDuckDuckGo(query, limit);
      const fallbackContent = formatSearchResults(fallbackRows);
      return successResult(`${fallbackContent}\n\n[search_fallback] ${serviceResult.error}`);
    } catch (err) {
      return errorResult(`Failed to search web: ${serviceResult.error}; fallback failed: ${String(err)}`);
    }
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

export class WebSearchTool extends BaseSearchWebTool {
}

export class WebFetchTool extends BaseFetchURLTool {
}

export function createWebTools(): Tool[] {
  return [new WebSearchTool(), new WebFetchTool()];
}
