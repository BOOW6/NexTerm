import { describe, expect, it } from 'vitest';
import { getFamilyTerminalTheme, getTerminalTheme } from './terminalTheme';
import { DARK_THEMES, LIGHT_THEMES } from './themes';
import { TERMINAL_COLOR_SCHEMES } from './terminalColorSchemes';

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

describe('family terminal themes', () => {
  it('ships a complete palette for every built-in theme', () => {
    for (const theme of [...LIGHT_THEMES, ...DARK_THEMES]) {
      if (theme.group !== 'modern') {
        // Classic families keep the token-derived fallback.
        expect(getFamilyTerminalTheme(theme.id)).toBeUndefined();
        continue;
      }
      const palette = getFamilyTerminalTheme(theme.id);
      expect(palette, theme.id).toBeDefined();
      if (!palette) {
        continue;
      }
      for (const key of ['background', 'foreground', 'cursor', 'selectionBackground'] as const) {
        expect(palette[key], `${theme.id}.${key}`).toMatch(/^(#|rgba?\()/);
      }
      // All 16 ANSI slots present and distinct enough to keep `ls` legible.
      for (const key of ANSI_KEYS) {
        expect(palette[key], `${theme.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
      const distinct = new Set(ANSI_KEYS.map((key) => palette[key]));
      expect(distinct.size, `${theme.id} palette has repeated slots`).toBeGreaterThan(10);
    }
  });

  it('covers every modern theme', () => {
    const modern = [...LIGHT_THEMES, ...DARK_THEMES].filter((theme) => theme.group === 'modern');
    expect(modern).toHaveLength(8);
    for (const theme of modern) {
      expect(getFamilyTerminalTheme(theme.id), theme.id).toBeDefined();
    }
  });

  it('returns undefined for unknown ids so the token fallback applies', () => {
    expect(getFamilyTerminalTheme('not-a-theme')).toBeUndefined();
    expect(getFamilyTerminalTheme('my-custom-theme')).toBeUndefined();
  });
});

describe('getTerminalTheme', () => {
  it('prefers an explicit terminal scheme over the UI family', () => {
    const scheme = TERMINAL_COLOR_SCHEMES.find((entry) => entry.id === 'solarized');
    const theme = getTerminalTheme('solarized', 'slate-dark');
    expect(theme.background).toBe(scheme?.background);
    expect(theme.foreground).toBe(scheme?.foreground);
  });

  it('follows the active modern family when the scheme is "theme"', () => {
    const slate = getTerminalTheme('theme', 'slate-dark');
    const graphite = getTerminalTheme('theme', 'graphite-dark');
    expect(slate.background).not.toBe(graphite.background);
    expect(slate.background).toBe(getFamilyTerminalTheme('slate-dark')?.background);
    expect(graphite.cursor).toBe(getFamilyTerminalTheme('graphite-dark')?.cursor);
  });

  it('falls back to CSS tokens for classic families', () => {
    const day = getTerminalTheme('theme', 'day');
    // The token-derived fallback paints the 16-colour fallback palette.
    expect(day.background).toMatch(/^hsl\(|^#/);
    expect(day.black).toBeDefined();
    expect(day.blue).toBeDefined();
  });
});
