export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemeVariant = 'light' | 'dark';

export type ThemeId = 'day' | 'dim' | 'aqua-light' | 'aqua-dark' | 'holo-light' | 'holo-dark';

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  variant: ThemeVariant;
  description: string;
  swatches: [string, string, string];
}

export const LIGHT_THEMES: ThemeDefinition[] = [
  {
    id: 'day',
    name: 'Day',
    variant: 'light',
    description: '经典 Web 2.0 明亮配色',
    swatches: ['#f4f7fb', '#ffffff', '#2e75b6']
  },
  {
    id: 'aqua-light',
    name: 'Aqua',
    variant: 'light',
    description: 'Mac OS X 10.6 Aqua 玻璃质感',
    swatches: ['#eef4fa', '#f9fbfd', '#1b6dbf']
  },
  {
    id: 'holo-light',
    name: 'Holo',
    variant: 'light',
    description: 'Android 4.4 Holo 亮色',
    swatches: ['#f5f5f5', '#ffffff', '#33b5e5']
  }
];

export const DARK_THEMES: ThemeDefinition[] = [
  {
    id: 'dim',
    name: 'Dim',
    variant: 'dark',
    description: '经典 Web 2.0 暗色配色',
    swatches: ['#16202b', '#1f2a36', '#7fb2e5']
  },
  {
    id: 'aqua-dark',
    name: 'Aqua',
    variant: 'dark',
    description: 'Mac OS X 10.6 Aqua 暗色玻璃',
    swatches: ['#121a23', '#1f2a36', '#63b3e8']
  },
  {
    id: 'holo-dark',
    name: 'Holo',
    variant: 'dark',
    description: 'Android 4.4 Holo 暗色',
    swatches: ['#000000', '#1a1a1a', '#33b5e5']
  }
];

export const THEMES: ThemeDefinition[] = [...LIGHT_THEMES, ...DARK_THEMES];

export interface ThemeFamily {
  id: string;
  name: string;
  description: string;
  light: ThemeId;
  dark: ThemeId;
}

export const THEME_FAMILIES: ThemeFamily[] = [
  {
    id: 'day-dim',
    name: 'Day / Dim',
    description: '经典 Web 2.0 明暗配色',
    light: 'day',
    dark: 'dim'
  },
  {
    id: 'aqua',
    name: 'Aqua',
    description: 'Mac OS X 10.6 Aqua 玻璃质感',
    light: 'aqua-light',
    dark: 'aqua-dark'
  },
  {
    id: 'holo',
    name: 'Holo',
    description: 'Android 4.4 Holo 扁平高对比',
    light: 'holo-light',
    dark: 'holo-dark'
  }
];

export const DEFAULT_LIGHT_THEME: ThemeId = 'day';
export const DEFAULT_DARK_THEME: ThemeId = 'dim';

export function getTheme(id: string): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? LIGHT_THEMES[0];
}

export function normalizeThemeId(value: unknown, variant: ThemeVariant): ThemeId {
  const themes = variant === 'light' ? LIGHT_THEMES : DARK_THEMES;
  return themes.some((theme) => theme.id === value)
    ? (value as ThemeId)
    : variant === 'light'
      ? DEFAULT_LIGHT_THEME
      : DEFAULT_DARK_THEME;
}

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}
