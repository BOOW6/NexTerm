import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settingsStore';
import { useCustomThemesStore } from './customThemesStore';
import { applyCustomThemeVars } from './applyCustomTheme';
import { accentVars, applyAccentVars } from './accent';
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  getTheme,
  isBuiltinThemeId,
  type ThemeId,
  type ThemeMode,
  type ThemeVariant
} from './themes';
import { ThemeContext, type ThemeContextValue } from './useTheme';

export type { ThemeId, ThemeMode, ThemeVariant } from './themes';
export type ResolvedTheme = ThemeVariant;

function getSystemTheme(): ThemeVariant {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function subscribeSystemTheme(callback: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const mode = useSettingsStore((state) => state.themeMode);
  const lightTheme = useSettingsStore((state) => state.lightTheme);
  const darkTheme = useSettingsStore((state) => state.darkTheme);
  const setThemeMode = useSettingsStore((state) => state.setThemeMode);
  const setLightThemeValue = useSettingsStore((state) => state.setLightTheme);
  const setDarkThemeValue = useSettingsStore((state) => state.setDarkTheme);
  const systemTheme = useSyncExternalStore<ThemeVariant>(
    subscribeSystemTheme,
    getSystemTheme,
    () => 'light'
  );
  const customThemes = useCustomThemesStore((state) => state.themes);
  const loadCustomThemes = useCustomThemesStore((state) => state.load);
  const themeAccent = useSettingsStore((state) => state.themeAccent);
  const setThemeAccentRaw = useSettingsStore((state) => state.setThemeAccent);

  // Load the custom theme folder once per window and follow backend changes
  // live (see the `themes-changed` watcher in themes.rs).
  useEffect(() => {
    void loadCustomThemes();
    let dispose: (() => void) | undefined;
    let cancelled = false;
    listen('themes-changed', () => {
      void useCustomThemesStore.getState().load();
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          dispose = unlisten;
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [loadCustomThemes]);

  const resolved: ThemeVariant = mode === 'system' ? systemTheme : mode;
  const themeId = resolved === 'light' ? lightTheme : darkTheme;
  const themeName = getTheme(themeId).name;
  const themeLabel = `${themeName} · ${resolved === 'light' ? t('theme.mode.light') : t('theme.mode.dark')}`;
  const lightThemeName = getTheme(lightTheme).name;
  const darkThemeName = getTheme(darkTheme).name;

  useLayoutEffect(() => {
    const root = document.documentElement;
    const custom = customThemes.find((theme) => theme.id === themeId);
    if (custom) {
      // Custom themes cascade on top of their built-in base: the base's
      // tokens.css block provides everything, inline overrides win.
      root.dataset.theme = custom.extends;
      applyCustomThemeVars(root, custom);
    } else {
      applyCustomThemeVars(root, null);
      root.dataset.theme = isBuiltinThemeId(themeId)
        ? themeId
        : // A custom id the registry has not loaded (or no longer has):
          // degrade to the variant default instead of unstyled vars.
          resolved === 'light'
          ? DEFAULT_LIGHT_THEME
          : DEFAULT_DARK_THEME;
    }
    // Accent override is layered on top of whichever base won above, so a
    // custom theme that extends a modern family keeps the chosen accent.
    applyAccentVars(
      root,
      themeAccent ? accentVars({ accent: themeAccent, variant: resolved }) : null
    );
    root.dataset.colorScheme = resolved;
  }, [themeId, resolved, customThemes, themeAccent]);

  const setMode = useCallback((next: ThemeMode) => setThemeMode(next), [setThemeMode]);

  const setLightTheme = useCallback(
    (next: ThemeId) => setLightThemeValue(next),
    [setLightThemeValue]
  );

  const setDarkTheme = useCallback((next: ThemeId) => setDarkThemeValue(next), [setDarkThemeValue]);

  const setThemeAccent = useCallback(
    (next: string) => setThemeAccentRaw(next),
    [setThemeAccentRaw]
  );

  const cycle = useCallback(() => {
    const current = useSettingsStore.getState().themeMode;
    // setThemeMode broadcasts nexterm-settings-applied itself (sunk into the
    // store), so the settings window merges this into its draft.
    setThemeMode(current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light');
  }, [setThemeMode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolved,
      themeId,
      themeName,
      themeLabel,
      lightTheme,
      darkTheme,
      lightThemeName,
      darkThemeName,
      themeAccent,
      setMode,
      setLightTheme,
      setDarkTheme,
      setThemeAccent,
      cycle
    }),
    [
      mode,
      resolved,
      themeId,
      themeName,
      themeLabel,
      lightTheme,
      darkTheme,
      lightThemeName,
      darkThemeName,
      themeAccent,
      setMode,
      setLightTheme,
      setDarkTheme,
      setThemeAccent,
      cycle
    ]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
