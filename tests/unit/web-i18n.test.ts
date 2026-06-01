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

function testShareAndInterruptedTranslations(): void {
  assert.equal(resolveTranslation('zh-CN', 'app.share.button'), '\u5206\u4eab');
  assert.equal(resolveTranslation('zh-CN', 'app.share.revoke'), '\u64a4\u9500\u5206\u4eab\u94fe\u63a5');
  assert.equal(resolveTranslation('zh-CN', 'app.share.modalTitle'), '\u5206\u4eab\u5f53\u524d\u4f1a\u8bdd');
  assert.equal(resolveTranslation('zh-CN', 'app.share.copy'), '\u590d\u5236');
  assert.equal(resolveTranslation('en-US', 'app.share.button'), 'Share');
  assert.equal(resolveTranslation('en-US', 'app.share.revoke'), 'Revoke shared link');
  assert.equal(resolveTranslation('en-US', 'app.share.modalTitle'), 'Share current session');
  assert.equal(resolveTranslation('en-US', 'app.share.copy'), 'Copy');

  const zhCheckpoint = resolveTranslation('zh-CN', 'app.interrupted.savedThroughCheckpoint', {
    lastSafeStep: 12,
    maxSteps: 40,
  });
  const enCheckpoint = resolveTranslation('en-US', 'app.interrupted.savedThroughCheckpoint', {
    lastSafeStep: 12,
    maxSteps: 40,
  });

  assert.equal(zhCheckpoint, '\u5df2\u4fdd\u5b58\u5230\u7b2c 12/40 \u6b65\u3002\u8fd9\u90e8\u5206\u8fdb\u5ea6\u5df2\u7ecf\u5728\u672a\u6765\u4e0a\u4e0b\u6587\u4e2d\u3002');
  assert.equal(enCheckpoint, 'Saved through step 12/40. This saved progress is already part of future context.');
}

function testCompletionMarkerSettingsTranslations(): void {
  const zhLabel = resolveTranslation('zh-CN', 'config.completionMarker.label');
  const enLabel = resolveTranslation('en-US', 'config.completionMarker.label');
  const zhDescription = resolveTranslation('zh-CN', 'config.completionMarker.description');
  const enDescription = resolveTranslation('en-US', 'config.completionMarker.description');
  const zhTimeline = resolveTranslation('zh-CN', 'config.workspaceTimeline.label');
  const enTimeline = resolveTranslation('en-US', 'config.workspaceTimeline.label');
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
  assert.equal(zhTimeline, '\u542f\u7528 Workspace Timeline\uff08\u6d4b\u8bd5\uff09');
  assert.equal(enTimeline, 'Enable Workspace Timeline (test)');
  assert.equal(zhLoading, '\u6b63\u5728\u52a0\u8f7d\u8bbe\u7f6e...');
  assert.equal(enLoading, 'Loading settings...');
  assert.equal(zhLoadError, '\u52a0\u8f7d\u8bbe\u7f6e\u5931\u8d25\uff0c\u8bf7\u5173\u95ed\u540e\u91cd\u8bd5\u3002');
  assert.equal(enLoadError, 'Failed to load settings. Close the dialog and try again.');
}

function testSettingsLocalizationCoverage(): void {
  const zhRemoteTitle = resolveTranslation('zh-CN', 'config.remoteAccess.title');
  const enRemoteTitle = resolveTranslation('en-US', 'config.remoteAccess.title');
  const zhWindowTokens = resolveTranslation('zh-CN', 'config.contextBudget.windowTokens');
  const enWindowTokens = resolveTranslation('en-US', 'config.contextBudget.windowTokens');
  const zhProviderWindowTokens = resolveTranslation('zh-CN', 'config.providerCenter.contextWindowTokens');
  const enProviderWindowTokens = resolveTranslation('en-US', 'config.providerCenter.contextWindowTokens');
  const enProviderWindowHint = resolveTranslation('en-US', 'config.providerCenter.contextWindowTokensHint', {
    defaultValue: 57500,
  });
  const zhTtl = resolveTranslation('zh-CN', 'config.remoteAccess.ttl.7d');
  const enTtl = resolveTranslation('en-US', 'config.remoteAccess.ttl.7d');
  const zhGovernanceEmpty = resolveTranslation('zh-CN', 'config.governance.empty');
  const enGovernanceEmpty = resolveTranslation('en-US', 'config.governance.empty');
  const zhProviderProfiles = resolveTranslation('zh-CN', 'config.providerCenter.profiles');
  const zhProviderName = resolveTranslation('zh-CN', 'config.providerCenter.profileName');

  assert.equal(zhRemoteTitle, '\u8fdc\u7a0b\u8bbf\u95ee\u5bc6\u7801');
  assert.equal(enRemoteTitle, 'Remote Access Password');
  assert.equal(zhWindowTokens, '\u4e0a\u4e0b\u6587\u7a97\u53e3 token');
  assert.equal(enWindowTokens, 'Context window tokens');
  assert.equal(zhProviderWindowTokens, '\u4e0a\u4e0b\u6587\u7a97\u53e3 token');
  assert.equal(enProviderWindowTokens, 'Context window tokens');
  assert.equal(
    enProviderWindowHint,
    'Leave empty to use the default value from Other (currently 57500).'
  );
  assert.equal(zhTtl, '7 \u5929');
  assert.equal(enTtl, '7 days');
  assert.equal(zhGovernanceEmpty, '\u9009\u62e9\u4f1a\u8bdd\u540e\u53ef\u4f7f\u7528\u6cbb\u7406\u63a7\u4ef6\u3002');
  assert.equal(enGovernanceEmpty, 'Governance controls are available after a session is selected.');
  assert.equal(zhProviderProfiles, '\u914d\u7f6e\u5217\u8868');
  assert.equal(zhProviderName, '\u914d\u7f6e\u540d\u79f0');
}

function runAll(): void {
  testDefaultLocaleIsZhCN();
  testLocaleSwitchNormalization();
  testTranslationParamFormatting();
  testFallbackToEnUSWhenZhMissing();
  testPendingPlanInputTranslations();
  testShareAndInterruptedTranslations();
  testCompletionMarkerSettingsTranslations();
  testSettingsLocalizationCoverage();
  console.log('web-i18n tests passed');
}

runAll();
