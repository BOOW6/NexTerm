import { useCallback, useLayoutEffect } from 'react';
import { useSettingsStore, type LanguageSetting } from '../stores/settingsStore';
import { EN as coreEn, ZH as coreZh } from './dictionaries/core';
import { EN as panelsEn, ZH as panelsZh } from './dictionaries/panels';
import { EN as settingsEn, ZH as settingsZh } from './dictionaries/settings';
import { EN as terminalEn, ZH as terminalZh } from './dictionaries/terminal';
import { EN as workspaceEn, ZH as workspaceZh } from './dictionaries/workspace';
import type { Dictionary } from './dictionaries/types';

export type Locale = 'zh-CN' | 'en-US';

type TranslationParams = Record<string, string | number>;

const ZH: Dictionary = {
  ...coreZh,
  ...settingsZh,
  ...panelsZh,
  ...workspaceZh,
  ...terminalZh
};

const EN: Dictionary = {
  ...coreEn,
  ...settingsEn,
  ...panelsEn,
  ...workspaceEn,
  ...terminalEn
};

const DICTIONARIES: Record<Locale, Dictionary> = {
  'zh-CN': ZH,
  'en-US': EN
};

/** The fully merged dictionaries, exposed so tooling (the key-usage scan
 * test) validates component keys against the real lookup source. */
export const mergedDictionaries = DICTIONARIES;

export function resolveLocale(setting: LanguageSetting): Locale {
  if (setting === 'zh-CN' || setting === 'en-US') {
    return setting;
  }
  const language = typeof navigator === 'undefined' ? 'zh-CN' : navigator.language || 'zh-CN';
  return language.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
}

export function translate(locale: Locale, key: string, params?: TranslationParams): string {
  let value = DICTIONARIES[locale][key] ?? ZH[key] ?? key;
  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.split(`{${name}}`).join(String(replacement));
    }
  }
  return value;
}

export interface I18n {
  locale: Locale;
  t: (key: string, params?: TranslationParams) => string;
}

export function useI18n(): I18n {
  const language = useSettingsStore((state) => state.language);
  const locale = resolveLocale(language);
  const t = useCallback(
    (key: string, params?: TranslationParams) => translate(locale, key, params),
    [locale]
  );
  return { locale, t };
}

/** Mirror the active locale onto the document so screen readers announce
 * the right language. `index.html` ships a static lang that never updates. */
export function useDocumentLang(): void {
  const language = useSettingsStore((state) => state.language);
  useLayoutEffect(() => {
    document.documentElement.lang = resolveLocale(language);
  }, [language]);
}

/**
 * Translate outside React (stores, plain modules, static label maps).
 * Reads the language from the settings store snapshot at call time, so
 * toasts fired right after a language switch use the new locale.
 */
export function tStatic(key: string, params?: TranslationParams): string {
  return translate(resolveLocale(useSettingsStore.getState().language), key, params);
}
