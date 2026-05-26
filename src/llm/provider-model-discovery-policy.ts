import type { LlmProviderProfileConfig } from '../types.js';
import {
  buildAnthropicCompatibleOpenAiModelDiscoveryUrls,
  buildAnthropicModelDiscoveryUrls,
  buildOpenAiModelDiscoveryUrls,
} from './provider-endpoints.js';

export interface ModelDiscoveryCandidate {
  urls: string[];
  headers: Record<string, string>;
}

export function buildModelDiscoveryCandidates(
  profile: LlmProviderProfileConfig
): ModelDiscoveryCandidate[] {
  if (profile.provider === 'openai') {
    return [
      {
        urls: buildOpenAiModelDiscoveryUrls(profile.apiBase),
        headers: { Authorization: `Bearer ${profile.apiKey}` },
      },
    ];
  }

  const candidates: ModelDiscoveryCandidate[] = [
    {
      urls: buildAnthropicModelDiscoveryUrls(profile.apiBase),
      headers: {
        'x-api-key': profile.apiKey,
        'anthropic-version': '2023-06-01',
      },
    },
  ];
  const compatibleOpenAiUrls = buildAnthropicCompatibleOpenAiModelDiscoveryUrls(profile.apiBase);
  if (compatibleOpenAiUrls.length > 0) {
    candidates.push({
      urls: compatibleOpenAiUrls,
      headers: { Authorization: `Bearer ${profile.apiKey}` },
    });
  }
  return candidates;
}
