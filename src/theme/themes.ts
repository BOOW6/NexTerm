import type { CustomThemeDefinition } from './customThemes';
import { useCustomThemesStore } from './customThemesStore';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemeVariant = 'light' | 'dark';

export type BuiltinThemeId =
  | 'day'
  | 'dim'
  | 'aqua-light'
  | 'aqua-dark'
  | 'holo-light'
  | 'holo-dark'
  | 'slate-light'
  | 'slate-dark';
/**
 * Built-in ids plus user-defined theme ids from the themes folder. Custom ids
 * are `[a-z0-9-]` strings (enforced by the backend scanner); they are kept
 * even before the registry loads so persisted settings survive reloads.
 */
export type ThemeId = BuiltinThemeId | (string & {});

/** Any theme definition: built-in catalog entry or custom folder theme. */
export type AnyThemeDefinition = ThemeDefinition | CustomThemeDefinition;

/** Catalog grouping shown in the settings window (newest first). */
export type ThemeGroup = 'modern' | 'classic';

const CUSTOM_THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  variant: ThemeVariant;
  descriptionKey: string;
  swatches: [string, string, string];
  group: ThemeGroup;
}

export const LIGHT_THEMES: ThemeDefinition[] = [
  {
    id: 'slate-light',
    name: 'Slate',
    variant: 'light',
    descriptionKey: 'theme.desc.slateLight',
    swatches: ['#f6f8fa', '#ffffff', '#0969da'],
    group: 'modern'
  },
  {
    id: 'day',
    name: 'Day',
    variant: 'light',
    descriptionKey: 'theme.desc.day',
    swatches: ['#f4f7fb', '#ffffff', '#2e75b6'],
    group: 'classic'
  },
  {
    id: 'aqua-light',
    name: 'Aqua',
    variant: 'light',
    descriptionKey: 'theme.desc.aquaLight',
    swatches: ['#eef4fa', '#f9fbfd', '#1b6dbf'],
    group: 'classic'
  },
  {
    id: 'holo-light',
    name: 'Holo',
    variant: 'light',
    descriptionKey: 'theme.desc.holoLight',
    swatches: ['#f5f5f5', '#ffffff', '#33b5e5'],
    group: 'classic'
  }
];

export const DARK_THEMES: ThemeDefinition[] = [
  {
    id: 'slate-dark',
    name: 'Slate',
    variant: 'dark',
    descriptionKey: 'theme.desc.slateDark',
    swatches: ['#0d1117', '#161b22', '#2f81f7'],
    group: 'modern'
  },
  {
    id: 'dim',
    name: 'Dim',
    variant: 'dark',
    descriptionKey: 'theme.desc.dim',
    swatches: ['#16202b', '#1f2a36', '#7fb2e5'],
    group: 'classic'
  },
  {
    id: 'aqua-dark',
    name: 'Aqua',
    variant: 'dark',
    descriptionKey: 'theme.desc.aquaDark',
    swatches: ['#121a23', '#1f2a36', '#63b3e8'],
    group: 'classic'
  },
  {
    id: 'holo-dark',
    name: 'Holo',
    variant: 'dark',
    descriptionKey: 'theme.desc.holoDark',
    swatches: ['#000000', '#1a1a1a', '#33b5e5'],
    group: 'classic'
  }
];

export const THEMES: ThemeDefinition[] = [...LIGHT_THEMES, ...DARK_THEMES];

export interface ThemeFamily {
  id: string;
  name: string;
  descriptionKey: string;
  light: ThemeId;
  dark: ThemeId;
  group: ThemeGroup;
}

export const THEME_FAMILIES: ThemeFamily[] = [
  {
    id: 'slate',
    name: 'Slate',
    descriptionKey: 'theme.family.slate',
    light: 'slate-light',
    dark: 'slate-dark',
    group: 'modern'
  },
  {
    id: 'day-dim',
    name: 'Day / Dim',
    descriptionKey: 'theme.family.dayDim',
    light: 'day',
    dark: 'dim',
    group: 'classic'
  },
  {
    id: 'aqua',
    name: 'Aqua',
    // Same wording as the aqua-light theme description, so it shares its key.
    descriptionKey: 'theme.desc.aquaLight',
    light: 'aqua-light',
    dark: 'aqua-dark',
    group: 'classic'
  },
  {
    id: 'holo',
    name: 'Holo',
    descriptionKey: 'theme.family.holo',
    light: 'holo-light',
    dark: 'holo-dark',
    group: 'classic'
  }
];

/** Families of one catalog group, in display order. */
export function themeFamiliesIn(group: ThemeGroup): ThemeFamily[] {
  return THEME_FAMILIES.filter((family) => family.group === group);
}

/**
 * Built-in themes by default: the modern Slate pair, so a fresh install no
 * longer opens on the Web 2.0 palette. Persisted choices are untouched, and
 * custom theme ids still resolve normally.
 */
export const DEFAULT_LIGHT_THEME: ThemeId = 'slate-light';
export const DEFAULT_DARK_THEME: ThemeId = 'slate-dark';

/** Accent presets offered under each modern family (`accent` is hex). */
export interface ThemeAccent {
  id: string;
  accent: string;
  /** Text/icon color placed on top of the accent (buttons, chips). */
  foreground: string;
}

export const MODERN_THEME_ACCENTS: Record<'slate' | 'graphite', ThemeAccent[]> = {
  slate: [
    { id: 'blue', accent: '#3b82f6', foreground: '#ffffff' },
    { id: 'violet', accent: '#8250df', foreground: '#ffffff' },
    { id: 'green', accent: '#1a7f37', foreground: '#ffffff' },
    { id: 'amber', accent: '#bf8700', foreground: '#ffffff' },
    { id: 'rose', accent: '#bf3989', foreground: '#ffffff' }
  ],
  graphite: [
    { id: 'teal', accent: '#2dd4bf', foreground: '#06231f' },
    { id: 'violet', accent: '#a78bfa', foreground: '#1b1033' },
    { id: 'amber', accent: '#fbbf24', foreground: '#261a02' },
    { id: 'blue', accent: '#60a5fa', foreground: '#06182f' }
  ]
};

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
