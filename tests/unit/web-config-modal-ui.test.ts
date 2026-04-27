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
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorageStub(),
  configurable: true,
});

Object.defineProperty(globalThis, 'sessionStorage', {
  value: new MemoryStorageStub(),
  configurable: true,
});

const sampleProfiles = {
  defaultProfileId: 'legacy-default',
  profiles: [
    {
      id: 'legacy-default',
      name: 'Kimi',
      provider: 'anthropic' as const,
      apiBase: 'https://api.kimi.com/coding/',
      defaultModel: 'kimi-for-coding',
      maxOutputTokens: 32768,
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

function renderConfigModal(isOpen: boolean, withProfiles = false): string {
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

function testClosedModalDoesNotRender(): void {
  const html = renderConfigModal(false);
  assert.doesNotMatch(html, /config-save-reload/);
  assert.doesNotMatch(html, /config-completion-marker-toggle/);
}

function testOpenModalDisablesServerBackedSaveUntilSettingsLoad(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderConfigModal(true);

  assert.match(html, /config-settings-loading/);
  assert.match(html, /Loading settings\.\.\./);
  assert.match(html, /data-testid="config-modal-shell"/);
  assert.match(html, />Settings</);
  assert.doesNotMatch(html, /Manage reusable LLM provider profiles/);
  assert.match(html, />Other</);
  assert.doesNotMatch(html, /data-testid="config-completion-marker-toggle"/);
  assert.match(html, /data-testid="config-save-reload"[^>]*disabled/);
}

function testProviderEditorUsesCompactUserFacingFields(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const html = renderConfigModal(true, true);

  assert.match(html, /data-testid="config-provider-profile-row"/);
  assert.match(html, /Kimi/);
  assert.match(html, /Anthropic compatible|Anthropic/);
  assert.match(html, /kimi-for-coding/);
  assert.doesNotMatch(html, /legacy-default/);
  assert.doesNotMatch(html, />Max Output Tokens</);
  assert.doesNotMatch(html, />Capabilities</);
  assert.match(html, /Advanced parameters/);
}

function runAll(): void {
  testClosedModalDoesNotRender();
  testOpenModalDisablesServerBackedSaveUntilSettingsLoad();
  testProviderEditorUsesCompactUserFacingFields();
  console.log('web-config-modal-ui tests passed');
}

runAll();
