import type { APIProvider, ResolvedLlmRuntimeConfig } from '../../types.js';
import type { LlmVendorDialectContext, LlmVendorDialectPolicy, LlmVendorDialectRuntime } from './types.js';

const BASE_POLICY = {
  endpoint: {
    normalizeAnthropicBaseUrl: 'none' as const,
  },
  anthropic: {
    allowUnsignedThinkingReplay: false,
    reasoningRequest: 'thinking_budget' as const,
  },
  openai: {
    enableThinkingRequest: false,
    replayAssistantThinkingAsReasoningContent: false,
    suppressReasoningEffort: false,
  },
};

const MINIMAX_OFFICIAL_HOSTS = ['api.minimax.io', 'api.minimaxi.com'];

const GENERIC_ANTHROPIC_COMPATIBLE: LlmVendorDialectPolicy = {
  ...BASE_POLICY,
  id: 'generic-anthropic-compatible',
  label: 'Generic Anthropic-Compatible',
  matches: (context) => context.provider === 'anthropic',
};

const GENERIC_OPENAI_COMPATIBLE: LlmVendorDialectPolicy = {
  ...BASE_POLICY,
  id: 'generic-openai-compatible',
  label: 'Generic OpenAI-Compatible',
  matches: (context) => context.provider === 'openai',
};

const DIALECTS: LlmVendorDialectPolicy[] = [
  {
    ...BASE_POLICY,
    id: 'xiaomi-mimo',
    label: 'Xiaomi MiMo',
    matches: (context) =>
      apiBaseHostMatchesDomain(context, ['xiaomimimo.com']) ||
      normalizedIdentityCandidates(context).some((value) => /^mimo-v[\w.-]*/u.test(value)),
    anthropic: {
      ...BASE_POLICY.anthropic,
      allowUnsignedThinkingReplay: true,
    },
    openai: {
      ...BASE_POLICY.openai,
      enableThinkingRequest: true,
      replayAssistantThinkingAsReasoningContent: true,
      suppressReasoningEffort: true,
    },
  },
  {
    ...BASE_POLICY,
    id: 'deepseek',
    label: 'DeepSeek',
    matches: (context) =>
      apiBaseHostMatchesDomain(context, ['deepseek.com']) ||
      normalizedIdentityCandidates(context).some((value) => value.includes('deepseek')),
    openai: {
      ...BASE_POLICY.openai,
      replayAssistantThinkingAsReasoningContent: true,
    },
  },
  {
    ...BASE_POLICY,
    id: 'minimax',
    label: 'MiniMax',
    matches: (context) =>
      apiBaseHostMatchesExact(context, MINIMAX_OFFICIAL_HOSTS) ||
      normalizedIdentityCandidates(context).some((value) => value.includes('minimax')),
    endpoint: {
      normalizeAnthropicBaseUrl: 'minimax-compatible',
    },
  },
  {
    ...BASE_POLICY,
    id: 'official-anthropic',
    label: 'Official Anthropic',
    matches: (context) =>
      context.provider === 'anthropic' &&
      (apiBaseHostMatchesDomain(context, ['anthropic.com']) ||
        normalizedIdentityCandidates(context).some((value) => value.startsWith('claude-'))),
    anthropic: {
      ...BASE_POLICY.anthropic,
      reasoningRequest: 'output_config_effort',
    },
  },
  {
    ...BASE_POLICY,
    id: 'official-openai',
    label: 'Official OpenAI',
    matches: (context) => context.provider === 'openai' && apiBaseHostMatchesExact(context, ['api.openai.com']),
  },
];

function normalizedIdentityCandidates(context: LlmVendorDialectContext): string[] {
  return [context.profileId, context.model]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
}

function normalizedApiBaseHost(context: LlmVendorDialectContext): string {
  const value = String(context.apiBase ?? '').trim().toLowerCase();
  if (!value) {
    return '';
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value;
  }
}

function apiBaseHostMatchesExact(context: LlmVendorDialectContext, hosts: string[]): boolean {
  const host = normalizedApiBaseHost(context);
  return Boolean(host) && hosts.some((candidate) => host === candidate.toLowerCase());
}

function apiBaseHostMatchesDomain(context: LlmVendorDialectContext, domains: string[]): boolean {
  const host = normalizedApiBaseHost(context);
  return (
    Boolean(host) &&
    domains.some((candidate) => {
      const domain = candidate.toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    })
  );
}

function isOfficialMiniMaxApiBase(apiBase: string): boolean {
  const context = { apiBase };
  return apiBaseHostMatchesExact(context, MINIMAX_OFFICIAL_HOSTS);
}

function normalizeContext(runtime: LlmVendorDialectRuntime): LlmVendorDialectContext {
  if (!runtime) {
    return {};
  }
  return {
    provider: runtime.provider,
    profileId: runtime.profileId,
    apiBase: runtime.apiBase,
    model: runtime.model,
  };
}

function fallbackDialect(provider: APIProvider | undefined): LlmVendorDialectPolicy {
  return provider === 'openai' ? GENERIC_OPENAI_COMPATIBLE : GENERIC_ANTHROPIC_COMPATIBLE;
}

function trimTrailingSlash(value: string): string {
  return String(value ?? '').trim().replace(/\/+$/u, '');
}

export function resolveLlmVendorDialect(runtime: LlmVendorDialectRuntime): LlmVendorDialectPolicy {
  const context = normalizeContext(runtime);
  return DIALECTS.find((dialect) => dialect.matches(context)) ?? fallbackDialect(context.provider);
}

export function resolveProviderRuntimeBaseUrlForDialect(
  provider: APIProvider,
  apiBase: string,
  runtime?: ResolvedLlmRuntimeConfig | LlmVendorDialectContext
): string {
  const normalized = trimTrailingSlash(apiBase);
  const dialect = resolveLlmVendorDialect(runtime ?? { provider, apiBase });
  const isOfficialMiniMaxGateway = isOfficialMiniMaxApiBase(normalized);
  const shouldNormalizeMiniMaxGateway =
    dialect.endpoint.normalizeAnthropicBaseUrl === 'minimax-compatible' || isOfficialMiniMaxGateway;
  if (
    provider !== 'anthropic' ||
    !shouldNormalizeMiniMaxGateway ||
    !isOfficialMiniMaxGateway
  ) {
    return normalized;
  }
  const withoutProtocolSuffix = normalized.replace('/anthropic', '').replace('/v1', '');
  return `${withoutProtocolSuffix}/anthropic`;
}

export function resolveOpenAiThinkingRequest(runtime: ResolvedLlmRuntimeConfig | undefined): Record<string, string> | undefined {
  const dialect = resolveLlmVendorDialect(runtime);
  if (!runtime || runtime.provider !== 'openai' || runtime.reasoningPreset === 'off' || !dialect.openai.enableThinkingRequest) {
    return undefined;
  }
  return { type: 'enabled' };
}
