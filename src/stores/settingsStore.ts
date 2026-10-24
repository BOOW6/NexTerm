import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SessionAuthMethod } from '../types/session';
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  normalizeThemeId,
  normalizeThemeMode,
  type ThemeId,
  type ThemeMode
} from '../theme/themes';
import {
  DEFAULT_TERMINAL_COLOR_SCHEME,
  normalizeTerminalColorSchemeId
} from '../theme/terminalColorSchemes';

export type TerminalCursorStyle = 'block' | 'underline' | 'bar';

export type LanguageSetting = 'system' | 'zh-CN' | 'en-US';

export type ShortcutAction = 'commandPalette' | 'newLocal' | 'newSsh' | 'openSettings';

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  commandPalette: 'Ctrl+K',
  newLocal: 'Ctrl+T',
  newSsh: 'Ctrl+Shift+N',
  openSettings: 'Ctrl+,'
};

export interface SettingsSnapshot {
  language: LanguageSetting;
  themeMode: ThemeMode;
  lightTheme: ThemeId;
  darkTheme: ThemeId;
  uiFontFamily: string;
  uiFontLigatures: boolean;
  uiFontFeatureSettings: string;
  terminalFontFamily: string;
  terminalFontLigatures: boolean;
  terminalFontFeatureSettings: string;
  terminalColorScheme: string;
  terminalFontSize: number;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  terminalLineHeight: number;
  terminalCopyOnSelect: boolean;
  terminalRestoreScrollback: boolean;
  sshAutoReconnect: boolean;
  sshRememberCredentials: boolean;
  defaultAuthMethod: SessionAuthMethod;
  defaultPort: number;
  defaultUsername: string;
  shortcuts: Record<ShortcutAction, string>;
}

const DEFAULT_UI_FONT_FAMILY =
  "'Microsoft YaHei', '微软雅黑', Tahoma, Arial, 'PingFang SC', 'Hiragino Sans GB', sans-serif";

export const DEFAULT_SETTINGS: SettingsSnapshot = {
  language: 'system',
  themeMode: 'system',
  lightTheme: DEFAULT_LIGHT_THEME,
  darkTheme: DEFAULT_DARK_THEME,
  uiFontFamily: DEFAULT_UI_FONT_FAMILY,
  uiFontLigatures: true,
  uiFontFeatureSettings: '"liga" 1, "calt" 1',
  terminalFontFamily: 'Consolas, "Courier New", "Sarasa Mono SC", monospace',
  terminalFontLigatures: false,
  terminalFontFeatureSettings: '"calt" on',
  terminalColorScheme: DEFAULT_TERMINAL_COLOR_SCHEME,
  terminalFontSize: 13,
  terminalCursorStyle: 'block',
  terminalCursorBlink: true,
  terminalScrollback: 10000,
  terminalLineHeight: 1,
  terminalCopyOnSelect: false,
  terminalRestoreScrollback: true,
  sshAutoReconnect: true,
  sshRememberCredentials: false,
  defaultAuthMethod: 'password',
  defaultPort: 22,
  defaultUsername: '',
  shortcuts: DEFAULT_SHORTCUTS
};

const LEGACY_THEME_KEY = 'nexterm.theme';

function readLegacyThemeMode(): ThemeMode | null {
  try {
    const value = window.localStorage.getItem(LEGACY_THEME_KEY);
    return value === 'light' || value === 'dark' || value === 'system' ? value : null;
  } catch {
    return null;
  }
}

function normalizeLanguage(value: unknown): LanguageSetting {
  return value === 'zh-CN' || value === 'en-US' ? value : 'system';
}

function normalizeSettings(input: SettingsSnapshot): SettingsSnapshot {
  return {
    language: normalizeLanguage(input.language),
    themeMode: normalizeThemeMode(input.themeMode),
    lightTheme: normalizeThemeId(input.lightTheme, 'light'),
    darkTheme: normalizeThemeId(input.darkTheme, 'dark'),
    uiFontFamily: (input.uiFontFamily ?? '').trim() || DEFAULT_SETTINGS.uiFontFamily,
    uiFontLigatures: Boolean(input.uiFontLigatures),
    uiFontFeatureSettings:
      (input.uiFontFeatureSettings ?? '').trim() || DEFAULT_SETTINGS.uiFontFeatureSettings,
    terminalFontFamily: input.terminalFontFamily.trim() || DEFAULT_SETTINGS.terminalFontFamily,
    terminalFontLigatures: Boolean(input.terminalFontLigatures),
    terminalFontFeatureSettings:
      (input.terminalFontFeatureSettings ?? '').trim() ||
      DEFAULT_SETTINGS.terminalFontFeatureSettings,
    terminalColorScheme: normalizeTerminalColorSchemeId(input.terminalColorScheme),
    terminalFontSize: Math.min(20, Math.max(10, Math.round(input.terminalFontSize) || 13)),
    terminalCursorStyle: input.terminalCursorStyle,
    terminalCursorBlink: Boolean(input.terminalCursorBlink),
    terminalScrollback: Math.min(
      100000,
      Math.max(1000, Math.round(input.terminalScrollback) || 10000)
    ),
    terminalLineHeight: Math.min(
      1.6,
      Math.max(0.8, Math.round(input.terminalLineHeight * 10) / 10 || 1)
    ),
    terminalCopyOnSelect: Boolean(input.terminalCopyOnSelect),
    terminalRestoreScrollback:
      input.terminalRestoreScrollback === undefined
        ? DEFAULT_SETTINGS.terminalRestoreScrollback
        : Boolean(input.terminalRestoreScrollback),
    sshAutoReconnect:
      input.sshAutoReconnect === undefined
        ? DEFAULT_SETTINGS.sshAutoReconnect
        : Boolean(input.sshAutoReconnect),
    sshRememberCredentials: Boolean(input.sshRememberCredentials),
    defaultAuthMethod:
      input.defaultAuthMethod === 'key'
        ? 'key'
        : input.defaultAuthMethod === 'agent'
          ? 'agent'
          : 'password',
    defaultPort: Math.min(65535, Math.max(1, Math.round(input.defaultPort) || 22)),
    defaultUsername: input.defaultUsername.trim(),
    shortcuts: {
      ...DEFAULT_SHORTCUTS,
      ...input.shortcuts
    }
  };
}

interface SettingsState extends SettingsSnapshot {
  applySettings: (snapshot: SettingsSnapshot) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setLightTheme: (theme: ThemeId) => void;
  setDarkTheme: (theme: ThemeId) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      themeMode: readLegacyThemeMode() ?? DEFAULT_SETTINGS.themeMode,
      applySettings: (snapshot) => set(normalizeSettings(snapshot)),
      setThemeMode: (themeMode) => set({ themeMode: normalizeThemeMode(themeMode) }),
      setLightTheme: (lightTheme) => set({ lightTheme: normalizeThemeId(lightTheme, 'light') }),
      setDarkTheme: (darkTheme) => set({ darkTheme: normalizeThemeId(darkTheme, 'dark') })
    }),
    {
      name: 'nexterm.settings.v1',
      merge: (persisted, current) => {
        const saved = (persisted as Partial<SettingsState> | undefined) ?? {};
        const merged = {
          ...current,
          ...saved,
          themeMode:
            saved.themeMode === undefined
              ? (readLegacyThemeMode() ?? DEFAULT_SETTINGS.themeMode)
              : saved.themeMode,
          shortcuts: {
            ...DEFAULT_SHORTCUTS,
            ...(saved.shortcuts ?? {})
          }
        };
        return { ...merged, ...normalizeSettings(merged as SettingsSnapshot) };
      }
    }
  )
);
