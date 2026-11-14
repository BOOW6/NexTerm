import { afterEach, describe, expect, it } from 'vitest';
import {
  DARK_THEMES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  LIGHT_THEMES,
  THEMES,
  getTheme,
  isBuiltinThemeId,
  normalizeThemeId,
  normalizeThemeMode
} from './themes';
import { useCustomThemesStore } from './customThemesStore';
import type { CustomThemeDefinition } from './customThemes';

const NIGHTFALL: CustomThemeDefinition = {
  id: 'nightfall',
  name: 'Nightfall',
  variant: 'dark',
  description: 'a custom theme',
  extends: 'dim',
  source: 'json',
  colors: {},
  terminal: null
};

describe('theme catalog', () => {
  it('exposes matching light and dark variants', () => {
    expect(THEMES).toHaveLength(LIGHT_THEMES.length + DARK_THEMES.length);
    expect(LIGHT_THEMES.every((theme) => theme.variant === 'light')).toBe(true);
    expect(DARK_THEMES.every((theme) => theme.variant === 'dark')).toBe(true);
  });

  it('falls back to the first light theme for unknown ids', () => {
    expect(getTheme('unknown').id).toBe(LIGHT_THEMES[0].id);
    expect(getTheme('dim').id).toBe('dim');
  });
});

describe('normalizeThemeId', () => {
  it('keeps ids valid for the requested variant', () => {
    expect(normalizeThemeId('aqua-light', 'light')).toBe('aqua-light');
    expect(normalizeThemeId('aqua-dark', 'dark')).toBe('aqua-dark');
  });

  it('rejects ids from the other variant', () => {
    expect(normalizeThemeId('aqua-dark', 'light')).toBe(DEFAULT_LIGHT_THEME);
    expect(normalizeThemeId('aqua-light', 'dark')).toBe(DEFAULT_DARK_THEME);
    expect(normalizeThemeId(null, 'light')).toBe(DEFAULT_LIGHT_THEME);
  });

  it('keeps custom theme id shapes even before the registry loads', () => {
    expect(normalizeThemeId('nightfall', 'dark')).toBe('nightfall');
    expect(normalizeThemeId('my-theme-2', 'light')).toBe('my-theme-2');
  });

  it('rejects values that are not theme ids', () => {
    expect(normalizeThemeId('Not A Theme!', 'dark')).toBe(DEFAULT_DARK_THEME);
    expect(normalizeThemeId('dropped theme', 'dark')).toBe(DEFAULT_DARK_THEME);
  });
});

describe('custom theme registry', () => {
  afterEach(() => {
    useCustomThemesStore.setState({ themes: [], errors: [], loading: false, loaded: false });
  });

  it('getTheme resolves custom ids from the registry', () => {
    expect(getTheme('nightfall').id).toBe(DEFAULT_LIGHT_THEME);
    useCustomThemesStore.setState({ themes: [NIGHTFALL], loaded: true });
    const theme = getTheme('nightfall');
    expect(theme.id).toBe('nightfall');
    expect(theme.name).toBe('Nightfall');
    expect(isBuiltinThemeId('nightfall')).toBe(false);
    expect(isBuiltinThemeId('dim')).toBe(true);
  });
});

describe('normalizeThemeMode', () => {
  it('accepts known modes and falls back to system', () => {
    expect(normalizeThemeMode('light')).toBe('light');
    expect(normalizeThemeMode('dark')).toBe('dark');
    expect(normalizeThemeMode('system')).toBe('system');
    expect(normalizeThemeMode('sepia')).toBe('system');
    expect(normalizeThemeMode(undefined)).toBe('system');
  });
});
