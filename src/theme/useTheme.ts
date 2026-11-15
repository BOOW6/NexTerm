import { createContext, useContext } from 'react';
import type { ThemeId, ThemeMode, ThemeVariant } from './themes';

export interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ThemeVariant;
  themeId: ThemeId;
  themeName: string;
  themeLabel: string;
  lightTheme: ThemeId;
  darkTheme: ThemeId;
  lightThemeName: string;
  darkThemeName: string;
  /** Hex accent override for modern families ('' = the theme's own accent). */
  themeAccent: string;
  setMode: (mode: ThemeMode) => void;
  setLightTheme: (theme: ThemeId) => void;
  setDarkTheme: (theme: ThemeId) => void;
  setThemeAccent: (accent: string) => void;
  cycle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
