import type { APIProvider } from '../types.js';

const MINIMAX_DOMAINS = ['api.minimax.io', 'api.minimaxi.com'];

function trimTrailingSlash(value: string): string {
  return String(value ?? '').trim().replace(/\/+$/u, '');
}

export function resolveProviderRuntimeBaseUrl(provider: APIProvider, apiBase: string): string {
  const normalized = trimTrailingSlash(apiBase);
  if (provider !== 'anthropic') {
    return normalized;
  }
  const isMinimax = MINIMAX_DOMAINS.some((domain) => normalized.includes(domain));
  if (!isMinimax) {
    return normalized;
  }
  const withoutProtocolSuffix = normalized.replace('/anthropic', '').replace('/v1', '');
  return `${withoutProtocolSuffix}/anthropic`;
}

export function buildOpenAiModelDiscoveryUrls(apiBase: string): string[] {
  const normalized = trimTrailingSlash(apiBase);
  const candidates = new Set<string>();
  if (normalized.endsWith('/models')) {
    candidates.add(normalized);
  } else {
    candidates.add(`${normalized}/models`);
    if (!/\/v\d+$/u.test(normalized)) {
      candidates.add(`${normalized}/v1/models`);
    }
  }
  return [...candidates];
}

export function buildAnthropicModelDiscoveryUrls(apiBase: string): string[] {
  const normalized = trimTrailingSlash(apiBase);
  const candidates = new Set<string>();
  if (normalized.endsWith('/v1/models')) {
    candidates.add(normalized);
  } else if (normalized.endsWith('/v1') || normalized.endsWith('/anthropic/v1')) {
    candidates.add(`${normalized}/models`);
  } else {
    candidates.add(`${normalized}/v1/models`);
    if (!normalized.endsWith('/anthropic')) {
      candidates.add(`${normalized}/anthropic/v1/models`);
    }
  }
  return [...candidates];
}

export function buildAnthropicCompatibleOpenAiModelDiscoveryUrls(apiBase: string): string[] {
  const normalized = trimTrailingSlash(apiBase);
  const candidates = new Set<string>();
  const withoutAnthropicSuffix = normalized.replace(/\/anthropic(?:\/v\d+)?$/u, '');
  if (withoutAnthropicSuffix !== normalized) {
    candidates.add(`${withoutAnthropicSuffix}/models`);
    candidates.add(`${withoutAnthropicSuffix}/v1/models`);
  }
  return [...candidates];
}
