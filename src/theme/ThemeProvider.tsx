import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode
} from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { getTheme, type ThemeId, type ThemeMode, type ThemeVariant } from './themes';

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

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ThemeVariant;
  themeId: ThemeId;
  themeName: string;
  themeLabel: string;
  lightTheme: ThemeId;
  darkTheme: ThemeId;
  lightThemeName: string;
  darkThemeName: string;
  setMode: (mode: ThemeMode) => void;
  setLightTheme: (theme: ThemeId) => void;
  setDarkTheme: (theme: ThemeId) => void;
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
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

  const resolved: ThemeVariant = mode === 'system' ? systemTheme : mode;
  const themeId = resolved === 'light' ? lightTheme : darkTheme;
  const themeName = getTheme(themeId).name;
  const themeLabel = `${themeName} · ${resolved === 'light' ? '亮色' : '暗色'}`;
  const lightThemeName = getTheme(lightTheme).name;
  const darkThemeName = getTheme(darkTheme).name;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = themeId;
    root.dataset.colorScheme = resolved;
  }, [themeId, resolved]);

  const setMode = useCallback((next: ThemeMode) => setThemeMode(next), [setThemeMode]);

  const setLightTheme = useCallback(
    (next: ThemeId) => setLightThemeValue(next),
    [setLightThemeValue]
  );

  const setDarkTheme = useCallback((next: ThemeId) => setDarkThemeValue(next), [setDarkThemeValue]);

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
      setMode,
      setLightTheme,
      setDarkTheme,
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
      setMode,
      setLightTheme,
      setDarkTheme,
      cycle
    ]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
