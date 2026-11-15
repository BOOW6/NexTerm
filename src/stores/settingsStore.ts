import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { emit } from '@tauri-apps/api/event';
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
  /** Hex accent for themes that expose an accent palette ('' = theme default). */
  themeAccent: string;
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
  sessionLogEnabled: boolean;
  /** Directory for session output logs; empty disables path-based logging. */
  sessionLogDir: string;
  /** Hide to tray instead of quitting when the main window closes. */
  closeToTray: boolean;
  /** Global accelerator that toggles the main window (empty = disabled). */
  globalShowHotkey: string;
  shortcuts: Record<ShortcutAction, string>;
}

const DEFAULT_UI_FONT_FAMILY =
  "'Microsoft YaHei', '微软雅黑', Tahoma, Arial, 'PingFang SC', 'Hiragino Sans GB', sans-serif";

export const DEFAULT_SETTINGS: SettingsSnapshot = {
  language: 'system',
  themeMode: 'system',
  lightTheme: DEFAULT_LIGHT_THEME,
  darkTheme: DEFAULT_DARK_THEME,
  themeAccent: '',
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
  sessionLogEnabled: false,
  sessionLogDir: '',
  closeToTray: false,
  globalShowHotkey: '',
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

/** Accepts `#rgb` / `#rrggbb`; anything else clears the override. */
function normalizeThemeAccent(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const body = value.trim().toLowerCase().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(body)) {
    return `#${[...body].map((ch) => ch + ch).join('')}`;
  }
  return /^[0-9a-f]{6}$/.test(body) ? `#${body}` : '';
}

function normalizeSettings(input: SettingsSnapshot): SettingsSnapshot {
  return {
    language: normalizeLanguage(input.language),
    themeMode: normalizeThemeMode(input.themeMode),
    lightTheme: normalizeThemeId(input.lightTheme, 'light'),
    darkTheme: normalizeThemeId(input.darkTheme, 'dark'),
    themeAccent: normalizeThemeAccent(input.themeAccent),
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
    terminalCursorStyle:
      input.terminalCursorStyle === 'underline' || input.terminalCursorStyle === 'bar'
        ? input.terminalCursorStyle
        : 'block',
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
          : input.defaultAuthMethod === 'certificate'
            ? 'certificate'
            : 'password',
    defaultPort: Math.min(65535, Math.max(1, Math.round(input.defaultPort) || 22)),
    defaultUsername: input.defaultUsername.trim(),
    sessionLogEnabled: Boolean(input.sessionLogEnabled),
    closeToTray: Boolean(input.closeToTray),
    globalShowHotkey:
      typeof input.globalShowHotkey === 'string' ? input.globalShowHotkey.trim() : '',
    sessionLogDir: (input.sessionLogDir ?? '').trim(),
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
  setThemeAccent: (accent: string) => void;
}

/**
 * Broadcast a settings change so the settings window merges it into its draft
 * (AGENTS.md: every writer outside the settings window must announce itself).
 * Sinking the broadcast into the store setters means call sites (command
 * palette, title bar menu, …) cannot forget it.
 */
function broadcastSettingsApplied(): void {
  void emit('nexterm-settings-applied', { settings: settingsSnapshot() }).catch(() => undefined);
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      themeMode: readLegacyThemeMode() ?? DEFAULT_SETTINGS.themeMode,
      applySettings: (snapshot) => set(normalizeSettings(snapshot)),
      setThemeMode: (themeMode) => {
        set({ themeMode: normalizeThemeMode(themeMode) });
        broadcastSettingsApplied();
      },
      setLightTheme: (lightTheme) => {
        set({ lightTheme: normalizeThemeId(lightTheme, 'light') });
        broadcastSettingsApplied();
      },
      setDarkTheme: (darkTheme) => {
        set({ darkTheme: normalizeThemeId(darkTheme, 'dark') });
        broadcastSettingsApplied();
      },
      setThemeAccent: (themeAccent) => {
        set({ themeAccent: normalizeThemeAccent(themeAccent) });
        broadcastSettingsApplied();
      }
    }),
    {
      name: 'nexterm.settings.v1',
      version: 1,
      // Future schema changes go through this hook; normalizeSettings in the
      // merge below already repairs unknown/partial payloads.
      migrate: (persisted) => persisted as SettingsState,
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

/** A plain snapshot of the current settings, safe to pass over IPC events. */
export function settingsSnapshot(): SettingsSnapshot {
  const state = useSettingsStore.getState();
  return {
    language: state.language,
    themeMode: state.themeMode,
    lightTheme: state.lightTheme,
    darkTheme: state.darkTheme,
    themeAccent: state.themeAccent,
    uiFontFamily: state.uiFontFamily,
    uiFontLigatures: state.uiFontLigatures,
    uiFontFeatureSettings: state.uiFontFeatureSettings,
    terminalFontSize: state.terminalFontSize,
    terminalFontFamily: state.terminalFontFamily,
    terminalFontLigatures: state.terminalFontLigatures,
    terminalFontFeatureSettings: state.terminalFontFeatureSettings,
    terminalColorScheme: state.terminalColorScheme,
    terminalCursorStyle: state.terminalCursorStyle,
    terminalCursorBlink: state.terminalCursorBlink,
    terminalScrollback: state.terminalScrollback,
    terminalLineHeight: state.terminalLineHeight,
    terminalCopyOnSelect: state.terminalCopyOnSelect,
    terminalRestoreScrollback: state.terminalRestoreScrollback,
    sshAutoReconnect: state.sshAutoReconnect,
    sshRememberCredentials: state.sshRememberCredentials,
    defaultAuthMethod: state.defaultAuthMethod,
    defaultPort: state.defaultPort,
    defaultUsername: state.defaultUsername,
    sessionLogEnabled: state.sessionLogEnabled,
    sessionLogDir: state.sessionLogDir,
    closeToTray: state.closeToTray,
    globalShowHotkey: state.globalShowHotkey,
    shortcuts: { ...state.shortcuts }
  };
}
