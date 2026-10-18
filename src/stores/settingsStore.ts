import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SessionAuthMethod } from '../types/session';

export type TerminalCursorStyle = 'block' | 'underline' | 'bar';

export type ShortcutAction = 'commandPalette' | 'newLocal' | 'newSsh' | 'openSettings';

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  commandPalette: 'Ctrl+K',
  newLocal: 'Ctrl+T',
  newSsh: 'Ctrl+Shift+N',
  openSettings: 'Ctrl+,'
};

export interface SettingsSnapshot {
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  terminalLineHeight: number;
  defaultAuthMethod: SessionAuthMethod;
  defaultPort: number;
  defaultUsername: string;
  shortcuts: Record<ShortcutAction, string>;
}

export const DEFAULT_SETTINGS: SettingsSnapshot = {
  terminalFontSize: 13,
  terminalFontFamily: 'Consolas, "Courier New", "Sarasa Mono SC", monospace',
  terminalCursorStyle: 'block',
  terminalCursorBlink: true,
  terminalScrollback: 10000,
  terminalLineHeight: 1,
  defaultAuthMethod: 'password',
  defaultPort: 22,
  defaultUsername: '',
  shortcuts: DEFAULT_SHORTCUTS
};

function normalizeSettings(input: SettingsSnapshot): SettingsSnapshot {
  return {
    terminalFontSize: Math.min(20, Math.max(10, Math.round(input.terminalFontSize) || 13)),
    terminalFontFamily:
      input.terminalFontFamily.trim() || DEFAULT_SETTINGS.terminalFontFamily,
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
    defaultAuthMethod: input.defaultAuthMethod === 'key' ? 'key' : 'password',
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
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      applySettings: (snapshot) => set(normalizeSettings(snapshot))
    }),
    {
      name: 'nexterm.settings.v1',
      merge: (persisted, current) => {
        const saved = (persisted as Partial<SettingsState> | undefined) ?? {};
        return {
          ...current,
          ...saved,
          shortcuts: {
            ...DEFAULT_SHORTCUTS,
            ...(saved.shortcuts ?? {})
          }
        };
      }
    }
  )
);
