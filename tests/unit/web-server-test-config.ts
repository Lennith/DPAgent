import { createDefaultContextBudgetConfig } from '../../src/runtime/context-window-budget.js';

export function createWebServerTestConfig(overrides: Record<string, any> = {}): Record<string, any> {
  const contextBudget = createDefaultContextBudgetConfig();
  const base = {
    api: {
      apiKey: 'sk-test',
      apiBase: 'https://api.example.test',
      model: 'test-model',
      provider: 'anthropic',
      maxOutputTokens: 1024,
    },
    llmProfiles: {
      defaultProfileId: 'default',
      profiles: [],
    },
    agent: {
      maxSteps: 100,
      tokenLimit: 1000,
      workspaceDir: 'D:\\workspace',
      completionMarkerEnforcementEnabled: true,
    },
    tools: {
      enableFileTools: true,
      enableWeb: true,
      enableShell: true,
      shellType: 'powershell',
      shellTimeout: 60000,
    },
    mcp: {
      enabled: false,
      servers: [],
      connectTimeout: 10,
      executeTimeout: 60,
    },
    retry: {
      enabled: true,
      maxRetries: 3,
      initialDelay: 1,
      maxDelay: 60,
      exponentialBase: 2,
    },
    contextBudget,
  };

  return {
    ...base,
    ...overrides,
    api: { ...base.api, ...(overrides.api ?? {}) },
    llmProfiles: { ...base.llmProfiles, ...(overrides.llmProfiles ?? {}) },
    agent: { ...base.agent, ...(overrides.agent ?? {}) },
    tools: { ...base.tools, ...(overrides.tools ?? {}) },
    mcp: { ...base.mcp, ...(overrides.mcp ?? {}) },
    retry: { ...base.retry, ...(overrides.retry ?? {}) },
    contextBudget: overrides.contextBudget ?? base.contextBudget,
  };
}
