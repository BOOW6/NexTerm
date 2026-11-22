import { create } from 'zustand';
import type { SftpConflictPolicy } from '../types/session';
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
  /** Whether a dropped Telnet connection retries with the shared backoff. */
  telnetAutoReconnect: boolean;
  sshRememberCredentials: boolean;
  defaultAuthMethod: SessionAuthMethod;
  /** How SFTP transfers resolve an existing target file (panel toolbar + settings). */
  sftpConflictPolicy: SftpConflictPolicy;
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
  telnetAutoReconnect: true,
  sshRememberCredentials: false,
  defaultAuthMethod: 'password',
  sftpConflictPolicy: 'ask',
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

/** Trimmed string or the fallback; persisted inputs may predate a field or
 * carry the wrong type, and normalization must be total (never throw). */
function asTrimmed(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** Clamped integer from a possibly-missing persisted number. */
function asClampedInt(value: unknown, fallback: number, min: number, max: number): number {
  const rounded = Math.round(typeof value === 'number' ? value : NaN);
  return Math.min(max, Math.max(min, rounded || fallback));
}

/** Line height, rounded to one decimal and clamped. */
function asLineHeight(value: unknown): number {
  const rounded = Math.round((typeof value === 'number' ? value : NaN) * 10) / 10;
  return Math.min(1.6, Math.max(0.8, rounded || 1));
}

function normalizeSettings(input: Partial<SettingsSnapshot>): SettingsSnapshot {
  return {
    language: normalizeLanguage(input.language),
    themeMode: normalizeThemeMode(input.themeMode),
    lightTheme: normalizeThemeId(input.lightTheme, 'light'),
    darkTheme: normalizeThemeId(input.darkTheme, 'dark'),
    themeAccent: normalizeThemeAccent(input.themeAccent),
    uiFontFamily: asTrimmed(input.uiFontFamily, DEFAULT_SETTINGS.uiFontFamily),
    uiFontLigatures: Boolean(input.uiFontLigatures),
    uiFontFeatureSettings: asTrimmed(
      input.uiFontFeatureSettings,
      DEFAULT_SETTINGS.uiFontFeatureSettings
    ),
    terminalFontFamily: asTrimmed(input.terminalFontFamily, DEFAULT_SETTINGS.terminalFontFamily),
    terminalFontLigatures: Boolean(input.terminalFontLigatures),
    terminalFontFeatureSettings: asTrimmed(
      input.terminalFontFeatureSettings,
      DEFAULT_SETTINGS.terminalFontFeatureSettings
    ),
    terminalColorScheme: normalizeTerminalColorSchemeId(input.terminalColorScheme),
    terminalFontSize: asClampedInt(input.terminalFontSize, 13, 10, 20),
    terminalCursorStyle:
      input.terminalCursorStyle === 'underline' || input.terminalCursorStyle === 'bar'
        ? input.terminalCursorStyle
        : 'block',
    terminalCursorBlink: Boolean(input.terminalCursorBlink),
    terminalScrollback: asClampedInt(input.terminalScrollback, 10000, 1000, 100000),
    terminalLineHeight: asLineHeight(input.terminalLineHeight),
    terminalCopyOnSelect: Boolean(input.terminalCopyOnSelect),
    terminalRestoreScrollback:
      input.terminalRestoreScrollback === undefined
        ? DEFAULT_SETTINGS.terminalRestoreScrollback
        : Boolean(input.terminalRestoreScrollback),
    sshAutoReconnect:
      input.sshAutoReconnect === undefined
        ? DEFAULT_SETTINGS.sshAutoReconnect
        : Boolean(input.sshAutoReconnect),
    telnetAutoReconnect:
      input.telnetAutoReconnect === undefined
        ? DEFAULT_SETTINGS.telnetAutoReconnect
        : Boolean(input.telnetAutoReconnect),
    sshRememberCredentials: Boolean(input.sshRememberCredentials),
    defaultAuthMethod:
      input.defaultAuthMethod === 'key'
        ? 'key'
        : input.defaultAuthMethod === 'agent'
          ? 'agent'
          : input.defaultAuthMethod === 'certificate'
            ? 'certificate'
            : 'password',
    sftpConflictPolicy:
      input.sftpConflictPolicy === 'overwrite' ||
      input.sftpConflictPolicy === 'skip' ||
      input.sftpConflictPolicy === 'rename' ||
      input.sftpConflictPolicy === 'newer'
        ? input.sftpConflictPolicy
        : 'ask',
    defaultPort: asClampedInt(input.defaultPort, 22, 1, 65535),
    defaultUsername: asTrimmed(input.defaultUsername, ''),
    sessionLogEnabled: Boolean(input.sessionLogEnabled),
    closeToTray: Boolean(input.closeToTray),
    globalShowHotkey:
      typeof input.globalShowHotkey === 'string' ? input.globalShowHotkey.trim() : '',
    sessionLogDir: asTrimmed(input.sessionLogDir, ''),
    shortcuts: {
      ...DEFAULT_SHORTCUTS,
      ...input.shortcuts
    }
  };
}

export const SETTINGS_VERSION = 1;

/**
 * Bridge a persisted payload of an older (or unknown) version into the
 * current schema. A newer version than this build understands must reset to
 * defaults: feeding forward-incompatible data into normalizeSettings would
 * repair it into a half-valid state the user never chose.
 */
export function migratePersistedSettings(persisted: unknown, fromVersion: number): unknown {
  if (fromVersion > SETTINGS_VERSION) {
    console.warn(
      `[settings] persisted settings version ${fromVersion} is newer than ${SETTINGS_VERSION}; resetting to defaults`
    );
    return {};
  }
  return persisted;
}

interface SettingsState extends SettingsSnapshot {
  applySettings: (snapshot: SettingsSnapshot) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setLightTheme: (theme: ThemeId) => void;
  setDarkTheme: (theme: ThemeId) => void;
  setThemeAccent: (accent: string) => void;
  setSftpConflictPolicy: (policy: SftpConflictPolicy) => void;
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
      },
      setSftpConflictPolicy: (sftpConflictPolicy) => {
        set({
          sftpConflictPolicy: normalizeSettings({ ...DEFAULT_SETTINGS, sftpConflictPolicy })
            .sftpConflictPolicy
        });
        broadcastSettingsApplied();
      }
    }),
    {
      name: 'nexterm.settings.v1',
      version: SETTINGS_VERSION,
      migrate: migratePersistedSettings,
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
        return { ...merged, ...normalizeSettings(merged) };
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
    telnetAutoReconnect: state.telnetAutoReconnect,
    sshRememberCredentials: state.sshRememberCredentials,
    defaultAuthMethod: state.defaultAuthMethod,
    sftpConflictPolicy: state.sftpConflictPolicy,
    defaultPort: state.defaultPort,
    defaultUsername: state.defaultUsername,
    sessionLogEnabled: state.sessionLogEnabled,
    sessionLogDir: state.sessionLogDir,
    closeToTray: state.closeToTray,
    globalShowHotkey: state.globalShowHotkey,
    shortcuts: { ...state.shortcuts }
  };
}
