import {
  createManualLlmIntrospection,
  getResolvedProfileCapabilities,
} from './provider-profiles.js';
import type { DiscoveredModel, LlmProfileIntrospection, LlmProviderProfileConfig } from '../types.js';

interface CachedIntrospection {
  signature: string;
  result: LlmProfileIntrospection;
}

export class ProfileIntrospectionService {
  private cache = new Map<string, CachedIntrospection>();

  async discoverModels(profile: LlmProviderProfileConfig): Promise<LlmProfileIntrospection> {
    const signature = this.createProfileSignature(profile);
    const cached = this.cache.get(profile.id);

    try {
      const result =
        profile.provider === 'openai'
          ? await this.discoverOpenAiCompatibleModels(profile)
          : await this.discoverAnthropicCompatibleModels(profile);
      this.cache.set(profile.id, {
        signature,
        result,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cached && cached.signature === signature) {
        return {
          ...cached.result,
          source: 'cache',
          error: message,
        };
      }
      return createManualLlmIntrospection(profile, message);
    }
  }

  private createProfileSignature(profile: LlmProviderProfileConfig): string {
    return JSON.stringify({
      id: profile.id,
      provider: profile.provider,
      apiBase: profile.apiBase,
      apiKey: profile.apiKey,
      defaultModel: profile.defaultModel,
      maxOutputTokens: profile.maxOutputTokens,
      capabilities: profile.capabilities,
      updatedAt: profile.updatedAt,
    });
  }

  private async discoverOpenAiCompatibleModels(
    profile: LlmProviderProfileConfig
  ): Promise<LlmProfileIntrospection> {
    const models = await this.fetchModelsFromCandidates(profile, buildOpenAiModelUrls(profile.apiBase), {
      Authorization: `Bearer ${profile.apiKey}`,
    });
    const capabilities = getResolvedProfileCapabilities(profile);
    return {
      profileId: profile.id,
      source: 'live',
      fetchedAt: new Date().toISOString(),
      models: models.map((model) => ({
        ...model,
        provider: profile.provider,
        supportsReasoningEffort: capabilities.reasoningEffort,
        supportsThinkingBudget: capabilities.thinkingBudget,
      })),
      manualModelEntryAllowed: true,
      capabilities,
    };
  }

  private async discoverAnthropicCompatibleModels(
    profile: LlmProviderProfileConfig
  ): Promise<LlmProfileIntrospection> {
    const anthropicErrors: string[] = [];
    let models = await this.fetchModelsFromCandidates(
      profile,
      buildAnthropicModelUrls(profile.apiBase),
      {
        'x-api-key': profile.apiKey,
        'anthropic-version': '2023-06-01',
      },
      anthropicErrors
    ).catch(() => [] as DiscoveredModel[]);

    if (models.length === 0) {
      const openAiFallbackUrls = buildAnthropicCompatibleOpenAiModelUrls(profile.apiBase);
      if (openAiFallbackUrls.length > 0) {
        const fallbackErrors: string[] = [];
        models = await this.fetchModelsFromCandidates(
          profile,
          openAiFallbackUrls,
          {
            Authorization: `Bearer ${profile.apiKey}`,
          },
          fallbackErrors
        ).catch(() => [] as DiscoveredModel[]);
        anthropicErrors.push(...fallbackErrors);
      }
    }

    if (models.length === 0) {
      throw new Error(`Model discovery failed for ${profile.id}: ${anthropicErrors.join('; ')}`);
    }

    const capabilities = getResolvedProfileCapabilities(profile);
    return {
      profileId: profile.id,
      source: 'live',
      fetchedAt: new Date().toISOString(),
      models: models.map((model) => ({
        ...model,
        provider: profile.provider,
        supportsReasoningEffort: capabilities.reasoningEffort,
        supportsThinkingBudget: capabilities.thinkingBudget,
      })),
      manualModelEntryAllowed: true,
      capabilities,
    };
  }

  private async fetchModelsFromCandidates(
    profile: LlmProviderProfileConfig,
    urls: string[],
    headers: Record<string, string>,
    errors: string[] = []
  ): Promise<DiscoveredModel[]> {
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers,
        });
        if (!response.ok) {
          errors.push(`${url} -> ${response.status} ${response.statusText}`);
          continue;
        }
        const payload = (await response.json()) as unknown;
        const models = extractDiscoveredModels(payload, profile.provider);
        if (models.length > 0) {
          return models;
        }
        errors.push(`${url} -> empty model list`);
      } catch (error) {
        errors.push(`${url} -> ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`Model discovery failed for ${profile.id}: ${errors.join('; ')}`);
  }
}

function buildAnthropicCompatibleOpenAiModelUrls(apiBase: string): string[] {
  const normalized = trimTrailingSlash(apiBase);
  const candidates = new Set<string>();
  const withoutAnthropicSuffix = normalized.replace(/\/anthropic(?:\/v\d+)?$/u, '');
  if (withoutAnthropicSuffix !== normalized) {
    candidates.add(`${withoutAnthropicSuffix}/models`);
    candidates.add(`${withoutAnthropicSuffix}/v1/models`);
  }
  return [...candidates];
}

function buildOpenAiModelUrls(apiBase: string): string[] {
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

function buildAnthropicModelUrls(apiBase: string): string[] {
  const normalized = trimTrailingSlash(apiBase);
  const candidates = new Set<string>();
  if (normalized.endsWith('/v1/models')) {
    candidates.add(normalized);
  } else if (normalized.endsWith('/v1')) {
    candidates.add(`${normalized}/models`);
  } else if (normalized.endsWith('/anthropic/v1')) {
    candidates.add(`${normalized}/models`);
  } else {
    candidates.add(`${normalized}/v1/models`);
    if (!normalized.endsWith('/anthropic')) {
      candidates.add(`${normalized}/anthropic/v1/models`);
    }
  }
  return [...candidates];
}

function trimTrailingSlash(value: string): string {
  return String(value ?? '').trim().replace(/\/+$/u, '');
}

function extractDiscoveredModels(payload: unknown, provider: LlmProviderProfileConfig['provider']): DiscoveredModel[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const rawList = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];

  const models: DiscoveredModel[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const idCandidate =
      typeof entry.id === 'string'
        ? entry.id
        : typeof entry.name === 'string'
          ? entry.name
          : typeof entry.model === 'string'
            ? entry.model
            : '';
    const id = idCandidate.trim();
    if (!id) {
      continue;
    }
    const displayName =
      typeof entry.display_name === 'string'
        ? entry.display_name.trim()
        : typeof entry.displayName === 'string'
          ? entry.displayName.trim()
          : undefined;
    const ownedBy =
      typeof entry.owned_by === 'string'
        ? entry.owned_by.trim()
        : typeof entry.owner === 'string'
          ? entry.owner.trim()
          : undefined;

    models.push({
      id,
      ...(displayName ? { displayName } : {}),
      ...(ownedBy ? { ownedBy } : {}),
      provider,
    });
  }
  return models;
}
