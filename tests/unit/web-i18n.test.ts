import * as assert from 'node:assert/strict';
import {
  DEFAULT_LOCALE,
  formatTranslation,
  normalizeLocale,
  TRANSLATIONS,
  type TranslationKey,
} from '../../src/web/client/i18n/index.js';

function resolveTranslation(
  locale: 'zh-CN' | 'en-US',
  key: TranslationKey,
  params?: Record<string, string | number>
): string {
  const primary = TRANSLATIONS[locale][key];
  const fallback = TRANSLATIONS['en-US'][key];
  return formatTranslation(primary ?? fallback ?? key, params);
}

function testDefaultLocaleIsZhCN(): void {
  assert.equal(DEFAULT_LOCALE, 'zh-CN');
  assert.equal(normalizeLocale(undefined), 'zh-CN');
  assert.equal(normalizeLocale(null), 'zh-CN');
  assert.equal(normalizeLocale('fr-FR'), 'zh-CN');
}

function testLocaleSwitchNormalization(): void {
  assert.equal(normalizeLocale('en-US'), 'en-US');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
}

function testTranslationParamFormatting(): void {
  const zh = resolveTranslation('zh-CN', 'todo.openCount', { count: 3 });
  const en = resolveTranslation('en-US', 'todo.openCount', { count: 3 });
  assert.equal(zh, '3 \u4e2a\u672a\u5b8c\u6210');
  assert.equal(en, '3 open');
}

function testFallbackToEnUSWhenZhMissing(): void {
  const key: TranslationKey = 'common.saveReload';
  const zhDict = TRANSLATIONS['zh-CN'] as Record<string, string>;
  const original = zhDict[key];
  delete zhDict[key];
  try {
    const fallback = resolveTranslation('zh-CN', key);
    assert.equal(fallback, TRANSLATIONS['en-US'][key]);
  } finally {
    zhDict[key] = original;
  }
}

function testPendingPlanInputTranslations(): void {
  const zhTitle = resolveTranslation('zh-CN', 'app.pendingPlanInput.title', { count: 2 });
  const enTitle = resolveTranslation('en-US', 'app.pendingPlanInput.title', { count: 2 });
  assert.equal(zhTitle, '\u6709 2 \u4e2a\u4f1a\u8bdd\u6b63\u5728\u7b49\u5f85\u4f60\u7684\u8f93\u5165');
  assert.equal(enTitle, '2 session(s) still need your input');
}

function testCompletionMarkerSettingsTranslations(): void {
  const zhLabel = resolveTranslation('zh-CN', 'config.completionMarker.label');
  const enLabel = resolveTranslation('en-US', 'config.completionMarker.label');
  const zhDescription = resolveTranslation('zh-CN', 'config.completionMarker.description');
  const enDescription = resolveTranslation('en-US', 'config.completionMarker.description');
  const zhLoading = resolveTranslation('zh-CN', 'config.loadingSettings');
  const enLoading = resolveTranslation('en-US', 'config.loadingSettings');
  const zhLoadError = resolveTranslation('zh-CN', 'config.error.loadSettings');
  const enLoadError = resolveTranslation('en-US', 'config.error.loadSettings');

  assert.equal(zhLabel, '\u542f\u7528\u7ed3\u675f\u6807\u8bb0\u5f3a\u5236\u68c0\u6d4b');
  assert.equal(enLabel, 'Enable completion marker enforcement');
  assert.match(zhDescription, /\u3010\u5b8c\u6210\uff01\u3011/);
  assert.match(zhDescription, /\u3010\u6c47\u62a5\u7ed3\u675f\uff01\u3011/);
  assert.match(enDescription, /\u3010\u5b8c\u6210\uff01\u3011/);
  assert.match(enDescription, /\u3010\u6c47\u62a5\u7ed3\u675f\uff01\u3011/);
  assert.equal(zhLoading, '\u6b63\u5728\u52a0\u8f7d\u8bbe\u7f6e...');
  assert.equal(enLoading, 'Loading settings...');
  assert.equal(zhLoadError, '\u52a0\u8f7d\u8bbe\u7f6e\u5931\u8d25\uff0c\u8bf7\u5173\u95ed\u540e\u91cd\u8bd5\u3002');
  assert.equal(enLoadError, 'Failed to load settings. Close the dialog and try again.');
}

function runAll(): void {
  testDefaultLocaleIsZhCN();
  testLocaleSwitchNormalization();
  testTranslationParamFormatting();
  testFallbackToEnUSWhenZhMissing();
  testPendingPlanInputTranslations();
  testCompletionMarkerSettingsTranslations();
  console.log('web-i18n tests passed');
}

runAll();
