import type { ITheme } from '@xterm/xterm';
import {
  FALLBACK_TERMINAL_BACKGROUND,
  FALLBACK_TERMINAL_COLORS,
  FALLBACK_TERMINAL_FOREGROUND,
  getTerminalColorScheme
} from './terminalColorSchemes';

function readHsl(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const raw = styles.getPropertyValue(name).trim();
  if (!raw) {
    return fallback;
  }
  const parts = raw.split(/\s+/);
  return parts.length === 3 ? `hsl(${parts[0]}, ${parts[1]}, ${parts[2]})` : raw;
}

/**
 * Build an xterm theme from the active CSS variables so the terminal follows
 * light/dark (and future custom themes) without hard-coded colors.
 */
export function getTerminalTheme(colorSchemeId = 'theme'): ITheme {
  const scheme = getTerminalColorScheme(colorSchemeId);
  if (scheme) {
    return {
      background: scheme.background,
      foreground: scheme.foreground,
      cursor: scheme.cursor,
      cursorAccent: scheme.background,
      selectionBackground: scheme.selectionBackground,
      ...scheme.colors
    };
  }

  const styles = getComputedStyle(document.documentElement);

  return {
    background: readHsl(styles, '--terminal-background', FALLBACK_TERMINAL_BACKGROUND),
    foreground: readHsl(styles, '--terminal-foreground', FALLBACK_TERMINAL_FOREGROUND),
    cursor: readHsl(styles, '--terminal-cursor', '#5b9bd5'),
    cursorAccent: readHsl(styles, '--terminal-background', FALLBACK_TERMINAL_BACKGROUND),
    selectionBackground:
      styles.getPropertyValue('--terminal-selection').trim() || 'rgba(91,155,213,0.35)',
    ...FALLBACK_TERMINAL_COLORS
  };
}
