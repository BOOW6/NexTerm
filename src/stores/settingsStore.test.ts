import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SHORTCUTS,
  useSettingsStore,
  type SettingsSnapshot
} from './settingsStore';

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

beforeEach(() => {
  useSettingsStore.setState({ ...DEFAULT_SETTINGS });
});

describe('applySettings', () => {
  it('clamps numeric values to supported ranges', () => {
    useSettingsStore.getState().applySettings(
      snapshot({
        terminalFontSize: 99,
        terminalScrollback: 10,
        terminalLineHeight: 9,
        defaultPort: 70000
      })
    );
    expect(useSettingsStore.getState().terminalFontSize).toBe(20);
    expect(useSettingsStore.getState().terminalScrollback).toBe(1000);
    expect(useSettingsStore.getState().terminalLineHeight).toBe(1.6);
    expect(useSettingsStore.getState().defaultPort).toBe(65535);

    useSettingsStore.getState().applySettings(
      snapshot({
        terminalFontSize: 3,
        terminalScrollback: 10_000_000,
        terminalLineHeight: -2,
        defaultPort: -1
      })
    );
    expect(useSettingsStore.getState().terminalFontSize).toBe(10);
    expect(useSettingsStore.getState().terminalScrollback).toBe(100_000);
    expect(useSettingsStore.getState().terminalLineHeight).toBe(0.8);
    expect(useSettingsStore.getState().defaultPort).toBe(1);
  });

  it('normalizes text fields', () => {
    useSettingsStore.getState().applySettings(
      snapshot({
        terminalFontFamily: '   ',
        defaultUsername: '  root  ',
        themeMode: 'sepia' as never,
        lightTheme: 'dim' as never,
        darkTheme: 'day' as never
      })
    );

    const state = useSettingsStore.getState();
    expect(state.terminalFontFamily).toBe(DEFAULT_SETTINGS.terminalFontFamily);
    expect(state.defaultUsername).toBe('root');
    expect(state.themeMode).toBe('system');
    expect(state.lightTheme).toBe(DEFAULT_SETTINGS.lightTheme);
    expect(state.darkTheme).toBe(DEFAULT_SETTINGS.darkTheme);
  });

  it('normalizes font and terminal color preferences', () => {
    useSettingsStore.getState().applySettings(
      snapshot({
        uiFontFamily: '   ',
        uiFontLigatures: false,
        terminalFontLigatures: true,
        terminalColorScheme: 'dark-pastels'
      })
    );
    expect(useSettingsStore.getState().uiFontFamily).toBe(DEFAULT_SETTINGS.uiFontFamily);
    expect(useSettingsStore.getState().uiFontLigatures).toBe(false);
    expect(useSettingsStore.getState().terminalFontLigatures).toBe(true);
    expect(useSettingsStore.getState().terminalColorScheme).toBe('dark-pastels');

    useSettingsStore.getState().applySettings(
      snapshot({
        terminalColorScheme: 'not-a-scheme'
      })
    );
    expect(useSettingsStore.getState().terminalColorScheme).toBe(
      DEFAULT_SETTINGS.terminalColorScheme
    );
  });

  it('fills missing shortcut overrides with defaults', () => {
    useSettingsStore.getState().applySettings(
      snapshot({
        shortcuts: { commandPalette: 'Ctrl+P' } as SettingsSnapshot['shortcuts']
      })
    );

    expect(useSettingsStore.getState().shortcuts).toEqual({
      ...DEFAULT_SHORTCUTS,
      commandPalette: 'Ctrl+P'
    });
  });

  it('keeps supported auth methods and coerces unknown ones to password', () => {
    useSettingsStore.getState().applySettings(snapshot({ defaultAuthMethod: 'agent' }));
    expect(useSettingsStore.getState().defaultAuthMethod).toBe('agent');

    useSettingsStore.getState().applySettings(snapshot({ defaultAuthMethod: 'gssapi' as never }));
    expect(useSettingsStore.getState().defaultAuthMethod).toBe('password');
  });

  it('rounds line height to one decimal place', () => {
    useSettingsStore.getState().applySettings(snapshot({ terminalLineHeight: 1.234 }));
    expect(useSettingsStore.getState().terminalLineHeight).toBe(1.2);
  });
});

describe('theme setters', () => {
  it('normalizes invalid assignments', () => {
    useSettingsStore.getState().setThemeMode('light');
    expect(useSettingsStore.getState().themeMode).toBe('light');
    useSettingsStore.getState().setThemeMode('sepia' as never);
    expect(useSettingsStore.getState().themeMode).toBe('system');

    useSettingsStore.getState().setLightTheme('aqua-light');
    expect(useSettingsStore.getState().lightTheme).toBe('aqua-light');
    useSettingsStore.getState().setLightTheme('aqua-dark');
    expect(useSettingsStore.getState().lightTheme).toBe(DEFAULT_SETTINGS.lightTheme);

    useSettingsStore.getState().setDarkTheme('eclair-dark');
    expect(useSettingsStore.getState().darkTheme).toBe('eclair-dark');
    useSettingsStore.getState().setDarkTheme('day');
    expect(useSettingsStore.getState().darkTheme).toBe(DEFAULT_SETTINGS.darkTheme);
  });
});
