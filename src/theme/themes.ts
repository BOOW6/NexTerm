import type { CustomThemeDefinition } from './customThemes';
import { useCustomThemesStore } from './customThemesStore';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemeVariant = 'light' | 'dark';

export type BuiltinThemeId =
  'day' | 'dim' | 'aqua-light' | 'aqua-dark' | 'holo-light' | 'holo-dark';
/**
 * Built-in ids plus user-defined theme ids from the themes folder. Custom ids
 * are `[a-z0-9-]` strings (enforced by the backend scanner); they are kept
 * even before the registry loads so persisted settings survive reloads.
 */
export type ThemeId = BuiltinThemeId | (string & {});

/** Any theme definition: built-in catalog entry or custom folder theme. */
export type AnyThemeDefinition = ThemeDefinition | CustomThemeDefinition;

const CUSTOM_THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  variant: ThemeVariant;
  descriptionKey: string;
  swatches: [string, string, string];
}

export const LIGHT_THEMES: ThemeDefinition[] = [
  {
    id: 'day',
    name: 'Day',
    variant: 'light',
    descriptionKey: 'theme.desc.day',
    swatches: ['#f4f7fb', '#ffffff', '#2e75b6']
  },
  {
    id: 'aqua-light',
    name: 'Aqua',
    variant: 'light',
    descriptionKey: 'theme.desc.aquaLight',
    swatches: ['#eef4fa', '#f9fbfd', '#1b6dbf']
  },
  {
    id: 'holo-light',
    name: 'Holo',
    variant: 'light',
    descriptionKey: 'theme.desc.holoLight',
    swatches: ['#f5f5f5', '#ffffff', '#33b5e5']
  }
];

export const DARK_THEMES: ThemeDefinition[] = [
  {
    id: 'dim',
    name: 'Dim',
    variant: 'dark',
    descriptionKey: 'theme.desc.dim',
    swatches: ['#16202b', '#1f2a36', '#7fb2e5']
  },
  {
    id: 'aqua-dark',
    name: 'Aqua',
    variant: 'dark',
    descriptionKey: 'theme.desc.aquaDark',
    swatches: ['#121a23', '#1f2a36', '#63b3e8']
  },
  {
    id: 'holo-dark',
    name: 'Holo',
    variant: 'dark',
    descriptionKey: 'theme.desc.holoDark',
    swatches: ['#000000', '#1a1a1a', '#33b5e5']
  }
];

export const THEMES: ThemeDefinition[] = [...LIGHT_THEMES, ...DARK_THEMES];

export interface ThemeFamily {
  id: string;
  name: string;
  descriptionKey: string;
  light: ThemeId;
  dark: ThemeId;
}

export const THEME_FAMILIES: ThemeFamily[] = [
  {
    id: 'day-dim',
    name: 'Day / Dim',
    descriptionKey: 'theme.family.dayDim',
    light: 'day',
    dark: 'dim'
  },
  {
    id: 'aqua',
    name: 'Aqua',
    // Same wording as the aqua-light theme description, so it shares its key.
    descriptionKey: 'theme.desc.aquaLight',
    light: 'aqua-light',
    dark: 'aqua-dark'
  },
  {
    id: 'holo',
    name: 'Holo',
    descriptionKey: 'theme.family.holo',
    light: 'holo-light',
    dark: 'holo-dark'
  }
];

export const DEFAULT_LIGHT_THEME: ThemeId = 'day';
export const DEFAULT_DARK_THEME: ThemeId = 'dim';

export function isBuiltinThemeId(id: string): boolean {
  return THEMES.some((theme) => theme.id === id);
}

export function getTheme(id: string): AnyThemeDefinition {
  const custom = useCustomThemesStore.getState().themes.find((theme) => theme.id === id);
  if (custom) {
    return custom;
  }
  return THEMES.find((theme) => theme.id === id) ?? LIGHT_THEMES[0];
}

export function normalizeThemeId(value: unknown, variant: ThemeVariant): ThemeId {
  if (typeof value === 'string' && value) {
    const themes = variant === 'light' ? LIGHT_THEMES : DARK_THEMES;
    if (themes.some((theme) => theme.id === value)) {
      return value as ThemeId;
    }
    // Custom theme ids are kept even when the registry has not loaded yet;
    // built-in ids of the other variant and malformed values fall back to
    // the variant default.
    if (!isBuiltinThemeId(value) && CUSTOM_THEME_ID_PATTERN.test(value)) {
      return value;
    }
  }
  return variant === 'light' ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME;
}

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}
