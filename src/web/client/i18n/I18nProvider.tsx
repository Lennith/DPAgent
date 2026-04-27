import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LOCALE,
  formatTranslation,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  TRANSLATIONS,
  type TranslationKey,
} from './translations.js';

interface I18nContextValue {
  locale: SupportedLocale;
  supportedLocales: readonly SupportedLocale[];
  setLocale: (locale: SupportedLocale) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function getInitialLocale(): SupportedLocale {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_LOCALE;
    }
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return normalizeLocale(stored);
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(getInitialLocale);

  useEffect(() => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore storage failures in restricted environments.
    }
    document.documentElement.lang = locale;
    document.documentElement.setAttribute('translate', 'no');
  }, [locale]);

  const setLocale = useCallback((nextLocale: SupportedLocale) => {
    setLocaleState(normalizeLocale(nextLocale));
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) => {
      const primary = TRANSLATIONS[locale][key];
      const fallback = TRANSLATIONS['en-US'][key];
      return formatTranslation(primary ?? fallback ?? key, params);
    },
    [locale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      supportedLocales: SUPPORTED_LOCALES,
      setLocale,
      t,
    }),
    [locale, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
