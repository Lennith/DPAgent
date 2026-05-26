import * as assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigModal } from '../../src/web/client/components/ConfigModal.js';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../src/web/client/i18n/index.js';

class MemoryStorageStub {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key) ?? null : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

const localStorageStub = new MemoryStorageStub();
const sessionStorageStub = new MemoryStorageStub();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageStub,
  configurable: true,
});

Object.defineProperty(globalThis, 'sessionStorage', {
  value: sessionStorageStub,
  configurable: true,
});

const sampleProfiles = {
  defaultProfileId: 'kimi-main',
  profiles: [
    {
      id: 'kimi-main',
      name: 'Kimi',
      provider: 'anthropic' as const,
      apiBase: 'https://api.kimi.com/coding/',
      defaultModel: 'kimi-for-coding',
      availableModels: ['kimi-for-coding', 'kimi-agent-model'],
      maxOutputTokens: 32768,
      contextWindowTokens: 64000,
      enabled: true,
      hasApiKey: true,
      capabilities: {
        modelDiscovery: true,
        reasoningEffort: false,
        thinkingBudget: true,
      },
    },
  ],
};

const settingsResponse = {
  agent: {
    skillsDir: 'D:/skills',
    globalAgentsDir: 'D:/agents',
    completionMarkerEnforcementEnabled: true,
    maxSteps: 120,
    contextReplayMinRounds: 6,
    contextReplayMaxRounds: 12,
    contextReplayBudgetRatio: 0.55,
  },
  contextBudget: {
    defaultContextWindowTokens: 57500,
    compressionTriggerRatio: 0.9,
    compressionMaxChars: 6000,
    precompressKeepLlmRounds: 5,
    precompressChunkChars: 60000,
  },
  web: {
    sessionShareTtlHours: 72,
  },
  remoteAccessAuth: {
    enabled: true,
    configured: true,
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    trustProxy: true,
  },
};

function renderConfigModalStatic(isOpen: boolean, withProfiles = false): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(ConfigModal, {
          isOpen,
          onClose: () => undefined,
          llmProfiles: withProfiles ? sampleProfiles : null,
        })
      )
    )
  );
}

function renderLoadedConfigModal(
  locale: 'zh-CN' | 'en-US',
  initialActiveTab: 'providers' | 'skills' | 'agents' | 'governance' | 'other' = 'other'
): string {
  localStorageStub.clear();
  sessionStorageStub.clear();
  localStorageStub.setItem(LOCALE_STORAGE_KEY, locale);
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(ConfigModal, {
          isOpen: true,
          onClose: () => undefined,
          llmProfiles: sampleProfiles,
          initialSettings: settingsResponse,
          initialActiveTab,
          initialAgentItems:
            initialActiveTab === 'agents'
              ? [
                  {
                    name: 'Coder',
                    source: 'global',
                    description: 'Code changes',
                    path: 'D:/agents/Coder/AGENTS.md',
                    mtime: new Date(0).toISOString(),
                    config: {
                      description: 'Configured coder',
                      llmProfileId: 'kimi-main',
                      llmModel: 'kimi-agent-model',
                      reasoningPreset: 'high',
                      loadGlobalSkills: false,
                      exposeAsSubagent: true,
                      promptAppend: 'Append prompt',
                    },
                  },
                ]
              : [],
        })
      )
    )
  );
}

function testClosedModalDoesNotRender(): void {
  const html = renderConfigModalStatic(false);
  assert.doesNotMatch(html, /config-save-reload/);
  assert.doesNotMatch(html, /config-completion-marker-toggle/);
}

function testOpenModalDisablesServerBackedSaveUntilSettingsLoad(): void {
  localStorageStub.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderConfigModalStatic(true);

  assert.match(html, /config-settings-loading/);
  assert.match(html, /Loading settings\.\.\./);
  assert.match(html, /data-testid="config-modal-shell"/);
  assert.match(html, />Settings</);
  assert.doesNotMatch(html, /Manage reusable LLM provider profiles/);
  assert.match(html, /data-testid="config-tab-providers"/);
  assert.match(html, /data-testid="config-tab-skills"/);
  assert.match(html, /data-testid="config-tab-agents"/);
  assert.match(html, /data-testid="config-tab-governance"/);
  assert.match(html, /data-testid="config-tab-other"/);
  assert.match(html, />Other</);
  assert.doesNotMatch(html, /data-testid="config-completion-marker-toggle"/);
  assert.match(html, /data-testid="config-save-reload"[^>]*disabled/);
}

function testLoadedModalLocalizesZhCNAndUsesTokenFields(): void {
  const html = renderLoadedConfigModal('zh-CN');

  assert.match(html, /value="57500"/);
  assert.match(html, /value="72"/);
  assert.match(html, /分享会话有效期（小时）/);
  assert.match(html, /value="27000"/);
  assert.match(html, /value="2700"/);
  assert.doesNotMatch(html, /Remote Access Password/);
  assert.doesNotMatch(html, /Context Window &amp; Compression/);
  assert.doesNotMatch(html, /Session TTL/);
  assert.doesNotMatch(html, /Trust Proxy/);
  assert.doesNotMatch(html, /chars/);
}

function testLoadedModalKeepsEnglishReadableAndUsesTokenFields(): void {
  const html = renderLoadedConfigModal('en-US');

  assert.match(html, /Remote Access Password/);
  assert.match(html, /Enable remote access password/);
  assert.match(html, /Session TTL/);
  assert.match(html, /Trust Proxy/);
  assert.match(html, /Share link expiry \(hours\)/);
  assert.match(html, /Applies to newly created share links/);
  assert.match(html, /Context Window &amp; Compression/);
  assert.match(html, /Context window tokens/);
  assert.match(html, /Precompress chunk tokens/);
  assert.match(html, /Compression max tokens/);
  assert.match(html, /7 days/);
  assert.doesNotMatch(html, /Context window chars/);
  assert.doesNotMatch(html, /Precompress chunk chars/);
  assert.doesNotMatch(html, /Compression max chars/);
}

function testLoadedProviderTabShowsProfileOverrideAndFallbackHint(): void {
  const zhHtml = renderLoadedConfigModal('zh-CN', 'providers');
  const enHtml = renderLoadedConfigModal('en-US', 'providers');

  assert.match(zhHtml, /value="64000"/);
  assert.match(zhHtml, /placeholder="57500"/);
  assert.doesNotMatch(zhHtml, />Profiles</);

  assert.match(enHtml, /Advanced parameters/);
  assert.match(enHtml, /Context window tokens/);
  assert.match(enHtml, /Leave empty to use the default value from Other \(currently 57500\)\./);
  assert.match(enHtml, /value="64000"/);
  assert.match(enHtml, /Available Models/);
  assert.doesNotMatch(enHtml, /Chat and Agent settings can only choose models from this list/);
  assert.doesNotMatch(enHtml, /Default: kimi-for-coding/);
  assert.match(enHtml, /data-testid="config-provider-available-models"/);
  assert.match(enHtml, /data-testid="config-provider-manual-model-input"/);
  assert.doesNotMatch(enHtml, /<datalist/);
}

function testConfiguredProviderKeyRequiresExplicitReplace(): void {
  const html = renderLoadedConfigModal('en-US', 'providers');

  assert.match(html, /Configured/);
  assert.match(html, /Replace Stored Key/);
  assert.doesNotMatch(html, /name="llm-api-key-kimi-main"/);
}

function testAgentsTabShowsAgentYamlEditor(): void {
  const html = renderLoadedConfigModal('en-US', 'agents');

  assert.match(html, /External Agents/);
  assert.match(html, /Coder/);
  assert.match(html, /Configured coder/);
  assert.match(html, /value="kimi-main"/);
  assert.match(html, /value="kimi-agent-model"/);
  assert.match(html, /data-testid="config-agent-model-toggle"/);
  assert.doesNotMatch(html, />Toolset</);
  assert.doesNotMatch(html, />Allowed Tools</);
  assert.doesNotMatch(html, />Max Steps</);
  assert.doesNotMatch(html, />Timeout Ms</);
  assert.match(html, /Load global skills/);
  assert.match(html, /When off, this external agent ignores Settings global skills/);
  assert.match(html, /Expose as subagent/);
  assert.match(html, /When enabled, this external agent appears in subagent manager list_agents results/);
  assert.match(html, /Append prompt/);
  assert.match(html, /Save agent\.yaml/);
}

function runAll(): void {
  testClosedModalDoesNotRender();
  testOpenModalDisablesServerBackedSaveUntilSettingsLoad();
  testLoadedModalLocalizesZhCNAndUsesTokenFields();
  testLoadedModalKeepsEnglishReadableAndUsesTokenFields();
  testLoadedProviderTabShowsProfileOverrideAndFallbackHint();
  testConfiguredProviderKeyRequiresExplicitReplace();
  testAgentsTabShowsAgentYamlEditor();
  console.log('web-config-modal-ui tests passed');
}

runAll();
