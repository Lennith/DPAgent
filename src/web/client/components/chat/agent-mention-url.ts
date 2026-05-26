import { appendShareToken } from '../../shared-access.js';

export function buildAgentMentionUrl(query: string, shareToken: string | null): string {
  const normalizedQuery = query.trim();
  const baseUrl = normalizedQuery.length > 0 ? `/api/agents?query=${encodeURIComponent(normalizedQuery)}` : '/api/agents';
  return appendShareToken(baseUrl, shareToken);
}
