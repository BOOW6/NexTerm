import type { CSSProperties } from 'react';
import type { CustomThemeDefinition } from './customThemes';

/**
 * Semantic color keys from a theme file's `colors` section mapped onto the
 * CSS custom properties from tokens.css. UI tokens are stored as `H S% L%`
 * triplets (Tailwind consumes `hsl(var(--token) / alpha)`), so hex values
 * from theme files are converted below; `--terminal-selection` is a full
 * color value and keeps its alpha.
 */
export const UI_COLOR_VARS: Record<string, string> = {
  background: '--background',
  backgroundAlt: '--background-alt',
  surface: '--surface',
  surfaceElevated: '--surface-elevated',
  surfaceHeader: '--surface-header',
  surfaceHover: '--surface-hover',
  surfaceActive: '--surface-active',
  border: '--border',
  borderMuted: '--border-muted',
  borderStrong: '--border-strong',
  foreground: '--foreground',
  muted: '--muted',
  mutedForeground: '--muted-foreground',
  accent: '--accent',
  accentStrong: '--accent-strong',
  accentSoft: '--accent-soft',
  accentForeground: '--accent-foreground',
  link: '--link',
  linkHover: '--link-hover',
  success: '--success',
  warning: '--warning',
  error: '--error',
  focusRing: '--focus-ring',
  tableHeader: '--table-header',
  rowHover: '--row-hover',
  rowSelected: '--row-selected',
  headerForeground: '--header-foreground',
  headerMuted: '--header-muted',
  terminalBackground: '--terminal-background',
  terminalForeground: '--terminal-foreground',
  terminalCursor: '--terminal-cursor',
  terminalSelection: '--terminal-selection'
};

/** Theme-file `structure` key -> CSS custom property. */
export const STRUCTURE_VARS: Record<string, string> = {
  radius: '--radius',
  radiusSm: '--radius-sm',
  radiusMd: '--radius-md',
  radiusLg: '--radius-lg',
  menuRadius: '--menu-radius',
  buttonRadius: '--button-radius',
  hairlineColor: '--hairline-color',
  panelHeaderBg: '--panel-header-bg',
  surfaceBackdrop: '--surface-backdrop',
  rowSelectedBg: '--row-selected-bg',
  groupHeaderBg: '--group-header-bg',
  menuHoverBg: '--menu-hover-bg',
  navHoverBg: '--nav-hover-bg',
  tabActiveBg: '--tab-active-bg',
  tabHiddenBg: '--tab-hidden-bg'
};
/** Structure keys whose values reach the theme as hex colors. */
const STRUCTURE_COLOR_KEYS = new Set([
  'hairlineColor',
  'panelHeaderBg',
  'surfaceBackdrop',
  'rowSelectedBg',
  'groupHeaderBg',
  'menuHoverBg',
  'navHoverBg',
  'tabActiveBg',
  'tabHiddenBg'
]);

/** Normalize `#rgb/#rgba/#rrggbb/#rrggbbaa` (case-insensitive) to `#rrggbb[aa]`. */ export function expandHex(
  value: string
): string | null {
  let body = value.trim().toLowerCase().replace(/^#/, '');
  if (!/^[0-9a-f]+$/.test(body)) {
    return null;
  }
  if (body.length === 3 || body.length === 4) {
    body = [...body].map((ch) => ch + ch).join('');
  }
  if (body.length !== 6 && body.length !== 8) {
    return null;
  }
  return `#${body}`;
}

/** Convert hex to the `H S% L%` triplet format used by tokens.css. */
export function hexToHslTriplet(value: string): string | null {
  const hex = expandHex(value);
  if (!hex) {
    return null;
  }
  const red = parseInt(hex.slice(1, 3), 16) / 255;
  const green = parseInt(hex.slice(3, 5), 16) / 255;
  const blue = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  if (max !== min) {
    const delta = max - min;
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hueRatio: number;
    if (max === red) {
      hueRatio = ((green - blue) / delta) % 6;
    } else if (max === green) {
      hueRatio = (blue - red) / delta + 2;
    } else {
      hueRatio = (red - green) / delta + 4;
    }
    hue = Math.round(hueRatio * 60);
    if (hue < 0) {
      hue += 360;
    }
  }
  return `${hue} ${Math.round(saturation * 100)}% ${Math.round(lightness * 100)}%`;
}

/** Convert hex (with optional alpha) to a `rgba()` value. */
export function hexToRgba(value: string, fallbackAlpha = 0.35): string | null {
  const hex = expandHex(value);
  if (!hex) {
    return null;
  }
  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);
  const alpha =
    hex.length === 9
      ? Math.round((parseInt(hex.slice(7, 9), 16) / 255) * 100) / 100
      : fallbackAlpha;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * CSS variable overrides for a custom theme. Values are converted to the
 * formats tokens.css expects; when the `terminal` section is present its
 * colors also feed the terminal CSS variables so the "follow theme" terminal
 * scheme matches.
 */
export function resolveCustomThemeVars(theme: CustomThemeDefinition): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    const cssVar = UI_COLOR_VARS[key];
    if (!cssVar) {
      continue;
    }
    vars[cssVar] =
      key === 'terminalSelection' ? (hexToRgba(value) ?? value) : (hexToHslTriplet(value) ?? value);
  }
  const terminal = theme.terminal;
  if (terminal) {
    if (terminal.background) {
      vars['--terminal-background'] = hexToHslTriplet(terminal.background) ?? terminal.background;
    }
    if (terminal.foreground) {
      vars['--terminal-foreground'] = hexToHslTriplet(terminal.foreground) ?? terminal.foreground;
    }
    if (terminal.cursor) {
      vars['--terminal-cursor'] = hexToHslTriplet(terminal.cursor) ?? terminal.cursor;
    }
    if (terminal.selectionBackground) {
      vars['--terminal-selection'] =
        hexToRgba(terminal.selectionBackground) ?? terminal.selectionBackground;
    }
  }
  for (const [key, value] of Object.entries(theme.structure ?? {})) {
    const cssVar = STRUCTURE_VARS[key];
    if (!cssVar) {
      continue;
    }
    // Color keys arrive as hex and must become the `H S% L%` triplet (or
    // rgba() for opaque fills) tokens.css expects; numbers are already CSS.
    vars[cssVar] = STRUCTURE_COLOR_KEYS.has(key) ? (hexToHslTriplet(value) ?? value) : value;
  }
  return vars;
}

/** Clear previous overrides, then apply the theme's (or none for built-ins). */
export function applyCustomThemeVars(root: HTMLElement, theme: CustomThemeDefinition | null): void {
  for (const cssVar of [...Object.values(UI_COLOR_VARS), ...Object.values(STRUCTURE_VARS)]) {
    root.style.removeProperty(cssVar);
  }
  if (!theme) {
    return;
  }
  for (const [cssVar, value] of Object.entries(resolveCustomThemeVars(theme))) {
    root.style.setProperty(cssVar, value);
  }
}

/** Inline style for preview specimens of custom themes. */
export function customThemeSpecimenStyle(theme: CustomThemeDefinition): CSSProperties {
  const style: Record<string, string> = {};
  for (const [cssVar, value] of Object.entries(resolveCustomThemeVars(theme))) {
    style[cssVar] = value;
  }
  return style as CSSProperties;
}
