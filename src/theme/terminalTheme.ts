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
 * Terminal themes for the modern families, written as xterm `ITheme` objects
 * rather than read from CSS: the 16 ANSI colours have no CSS token to derive
 * from, and hand-picked palettes keep `ls` / `git` output legible on each
 * family's own ground.
 *
 * `follow theme` uses these when the active UI theme belongs to one of these
 * families; classic families keep the token-derived palette from
 * `getTerminalTheme`'s fallback branch.
 */
const FAMILY_TERMINAL_THEMES: Record<string, ITheme> = {
  'slate-light': {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selectionBackground: 'rgba(56, 139, 253, 0.35)',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc'
  },
  'slate-dark': {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selectionBackground: 'rgba(56, 139, 253, 0.35)',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc'
  },
  'graphite-light': {
    background: '#0e1013',
    foreground: '#e3e5ea',
    cursor: '#2dd4bf',
    cursorAccent: '#0e1013',
    selectionBackground: 'rgba(45, 212, 191, 0.26)',
    black: '#3a3f47',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#7aa2f7',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d6d9df',
    brightBlack: '#5b616b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93b4f8',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#f4f5f7'
  },
  'graphite-dark': {
    background: '#0b0c0e',
    foreground: '#e6e7ea',
    cursor: '#2dd4bf',
    cursorAccent: '#0b0c0e',
    selectionBackground: 'rgba(45, 212, 191, 0.26)',
    black: '#3a3f47',
    red: '#ff6b6b',
    green: '#5ee0a0',
    yellow: '#fbbf24',
    blue: '#7aa2f7',
    magenta: '#c084fc',
    cyan: '#2dd4bf',
    white: '#d6d9df',
    brightBlack: '#5b616b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93b4f8',
    brightMagenta: '#d8b4fe',
    brightCyan: '#5eead4',
    brightWhite: '#f4f5f7'
  },
  'tgreen-light': {
    background: '#0b110e',
    foreground: '#b9f0c9',
    cursor: '#48d597',
    cursorAccent: '#0b110e',
    selectionBackground: 'rgba(72, 213, 151, 0.28)',
    black: '#20302a',
    red: '#f0716f',
    green: '#5ee08f',
    yellow: '#e3b341',
    blue: '#5fb3d4',
    magenta: '#b48ee0',
    cyan: '#5ee0c8',
    white: '#cfe8d8',
    brightBlack: '#3f5a4c',
    brightRed: '#ff9c9a',
    brightGreen: '#86f0aa',
    brightYellow: '#f2cf6b',
    brightBlue: '#8fd0e8',
    brightMagenta: '#d0b0f0',
    brightCyan: '#8bf0dd',
    brightWhite: '#ecfff3'
  },
  'tgreen-dark': {
    background: '#070c09',
    foreground: '#c2f5d2',
    cursor: '#48d597',
    cursorAccent: '#070c09',
    selectionBackground: 'rgba(72, 213, 151, 0.24)',
    black: '#1c2a24',
    red: '#ff7b72',
    green: '#54e08a',
    yellow: '#e3b341',
    blue: '#63b3d8',
    magenta: '#b48ee0',
    cyan: '#5ee0c8',
    white: '#d3ecdb',
    brightBlack: '#3a5448',
    brightRed: '#ffa198',
    brightGreen: '#8bf0ac',
    brightYellow: '#f2d07a',
    brightBlue: '#93d3ec',
    brightMagenta: '#d2b0f2',
    brightCyan: '#93f2e2',
    brightWhite: '#f0fff5'
  },
  'sandstone-light': {
    background: '#002b36',
    foreground: '#93a1a1',
    cursor: '#cb4b16',
    cursorAccent: '#002b36',
    selectionBackground: 'rgba(203, 75, 22, 0.3)',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#93a1a1',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3'
  },
  'sandstone-dark': {
    background: '#1c1611',
    foreground: '#e8dccb',
    cursor: '#f5a544',
    cursorAccent: '#1c1611',
    selectionBackground: 'rgba(245, 165, 68, 0.28)',
    black: '#3a2e24',
    red: '#ec6a5e',
    green: '#8fbf6a',
    yellow: '#e3b341',
    blue: '#7aa9d8',
    magenta: '#c48cbf',
    cyan: '#6fc2b0',
    white: '#e8dccb',
    brightBlack: '#6b5a49',
    brightRed: '#f29c90',
    brightGreen: '#b3d98f',
    brightYellow: '#f2d07a',
    brightBlue: '#a3c6ec',
    brightMagenta: '#dcb0d8',
    brightCyan: '#9be0d0',
    brightWhite: '#faf3e8'
  }
};

/**
 * Terminal theme for a built-in family that ships its own palette, or
 * `undefined` for classic families / unknown ids (callers then fall back to
 * the CSS-token derivation).
 */
export function getFamilyTerminalTheme(themeId: string): ITheme | undefined {
  return FAMILY_TERMINAL_THEMES[themeId];
}

/**
 * Build an xterm theme. Resolution order:
 * 1. an explicit terminal scheme chosen in settings;
 * 2. `theme` (follow UI): the active modern family's own palette;
 * 3. `theme` on a classic family: derive from the CSS tokens so the terminal
 *    tracks light/dark (and custom themes) without hard-coded colors.
 *
 * `themeId` is the resolved UI theme id (see `useTheme().themeId`).
 */
/**
 * The ANSI slots an accent override re-hues (`--terminal-ansi-<n>`, written by
 * accent.ts). Classic families have no family palette, so they also read the
 * same slots here: an accent must not leave a blue terminal under a green UI.
 */
function applyAccentPalette(theme: ITheme): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const next = { ...theme } as Record<string, string>;
  for (let index = 0; index < 16; index += 1) {
    const value = styles.getPropertyValue(`--terminal-ansi-${index}`).trim();
    if (value) {
      next[ANSI_KEYS[index]] = value;
    }
  }
  const cursor = styles.getPropertyValue('--terminal-cursor').trim();
  if (cursor && parsedTriplet(cursor)) {
    next.cursor = `hsl(${cursor.replace(/\s+/g, ', ')})`;
  }
  return next as ITheme;
}

const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;

function parsedTriplet(value: string): boolean {
  return /^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/.test(value.trim());
}

export function getTerminalTheme(colorSchemeId = 'theme', themeId = ''): ITheme {
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

  const family = getFamilyTerminalTheme(themeId);
  if (family) {
    return applyAccentPalette(family);
  }

  const styles = getComputedStyle(document.documentElement);

  return applyAccentPalette({
    ...FALLBACK_TERMINAL_COLORS,
    background: readHsl(styles, '--terminal-background', FALLBACK_TERMINAL_BACKGROUND),
    foreground: readHsl(styles, '--terminal-foreground', FALLBACK_TERMINAL_FOREGROUND),
    cursor: readHsl(styles, '--terminal-cursor', '#5b9bd5'),
    cursorAccent: readHsl(styles, '--terminal-background', FALLBACK_TERMINAL_BACKGROUND),
    selectionBackground:
      styles.getPropertyValue('--terminal-selection').trim() || 'rgba(91,155,213,0.35)'
  });
}
