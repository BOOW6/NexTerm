import { hexToHslTriplet } from './applyCustomTheme';

/**
 * Accent override.
 *
 * Modern families expose an accent palette. The chosen accent is one hex value
 * in settings; everything tinted in the UI is derived from it so a family
 * never ends up half-accented (accent buttons in blue, focus rings in blue,
 * but links, state colours, the terminal's cursor and its 16-colour palette
 * still in the theme's original hue).
 *
 * Derived groups:
 * - accent ramp: accent / strong / soft / rgb / text-on-accent / hover mixes
 * - semantic hue: link, success, warning, error and the terminal cursor are
 *   re-hued onto the accent's hue, keeping their lightness (hue modulation,
 *   not a wash) so "everything follows the accent" while states stay distinct
 * - terminal palette: the 6 base ANSI slots (red, green, yellow, blue,
 *   magenta, cyan) plus the bright variants are re-hued from the family's own
 *   palette, preserving each slot's lightness
 * - neutrals: an optional `neutral` hex (low-saturation / black / white
 *   presets) re-tints the surfaces, borders and text, so an "all grey" or
 *   "all neutral black" accent does not leave a blue-tinted canvas behind
 *
 * Hue-modulated and neutral values depend on the *base theme*, which the
 * module cannot read in a unit test, so callers pass the base triplets they
 * resolved from `tokens.css` (`readBaseThemeColors` in ThemeProvider).
 */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function parseTriplet(triplet: string | undefined | null): Hsl | null {
  if (!triplet) {
    return null;
  }
  const parts = triplet.trim().split(/\s+/);
  if (parts.length !== 3) {
    return null;
  }
  const h = Number.parseFloat(parts[0]);
  const s = Number.parseFloat(parts[1]);
  const l = Number.parseFloat(parts[2]);
  if (![h, s, l].every(Number.isFinite)) {
    return null;
  }
  return { h, s, l };
}

function hslToString({ h, s, l }: Hsl): string {
  const hue = Math.round(((h % 360) + 360) % 360);
  return `${hue} ${clamp(Math.round(s), 0, 100)}% ${clamp(Math.round(l), 0, 100)}%`;
}

/** Signed distance from `from` to `to` on the hue circle, in (-180, 180]. */
function hueDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Re-hue a colour toward `accentHue`, keeping its lightness. */
function shiftToHue(color: Hsl, accentHue: number, saturationScale = 1): Hsl {
  return {
    h: (((color.h + hueDelta(color.h, accentHue)) % 360) + 360) % 360,
    s: clamp(color.s * saturationScale, 0, 100),
    l: color.l
  };
}

/**
 * Hue for a semantic slot (success / warning / error / cursor).
 *
 * The slot keeps its own hue but moves by the same amount as the theme's
 * primary colour did, scaled by how much of the ring it sits away from it:
 * colours near the old accent follow it fully, colours a third of the ring
 * away (a green success under a blue accent) move less. That keeps every
 * state "in the same family" as the new accent without collapsing success
 * and error onto one hue — the failure mode of the earlier fixed-offset ring,
 * which left both unchanged for any accent within 40° of a slot.
 */
function stateHue(originalHue: number, baseAccentHue: number, accentHue: number): number {
  const accentDelta = hueDelta(baseAccentHue, accentHue);
  const distanceFromAccent = Math.abs(hueDelta(baseAccentHue, originalHue));
  // A state moves by at least 60% of the accent's own hue shift, more when it
  // sits near the accent. Without the floor, a state 75-120 degrees away
  // (green success under a blue accent) would stay put and the UI would read
  // as half-recoloured — the exact complaint this mapping exists to fix.
  const influence = clamp(1 - distanceFromAccent / 200, 0.6, 1);
  return (((originalHue + accentDelta * influence) % 360) + 360) % 360;
}

/** `#rrggbb` → `r g b` for the alpha-mix token. */
function hexToRgbTriplet(hex: string): string | null {
  const body = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(body)) {
    return null;
  }
  return `${parseInt(body.slice(0, 2), 16)} ${parseInt(body.slice(2, 4), 16)} ${parseInt(body.slice(4, 6), 16)}`;
}

/** Base-theme triplets an accent override may re-tint. All optional. */
export interface BaseThemeColors {
  /** The theme's own accent: the reference point for semantic hue shifts. */
  accent?: string;
  background?: string;
  backgroundAlt?: string;
  surface?: string;
  surfaceElevated?: string;
  surfaceHeader?: string;
  surfaceHover?: string;
  surfaceActive?: string;
  border?: string;
  borderMuted?: string;
  borderStrong?: string;
  foreground?: string;
  muted?: string;
  mutedForeground?: string;
  tableHeader?: string;
  rowHover?: string;
  success?: string;
  warning?: string;
  error?: string;
  terminalCursor?: string;
}

export interface AccentVarsInput {
  accent: string;
  foreground?: string;
  /** Low-saturation / black / white presets re-tint the neutrals too. */
  neutral?: string;
  /** Which end of the luminance range "strong" moves toward. */
  variant?: 'light' | 'dark';
  /** Base-theme colours used for hue modulation; omitted = accent ramp only. */
  base?: BaseThemeColors;
  /** Base terminal palette to re-hue, in ANSI order (16 entries). */
  terminalPalette?: readonly string[];
}

/** ANSI slots that carry a hue and therefore follow the accent. */
const TERMINAL_HUE_SLOTS = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14];

/** `H S% L%` triplet or hex → HSL. Base colors pass triplets, palettes hex. */
function toTriplet(value: string | undefined): Hsl | null {
  if (!value) {
    return null;
  }
  return parseTriplet(value) ?? parseTriplet(hexToHslTriplet(value));
}

const NEUTRAL_SURFACE_KEYS: Array<keyof BaseThemeColors> = [
  'background',
  'backgroundAlt',
  'surface',
  'surfaceElevated',
  'surfaceHeader',
  'surfaceHover',
  'surfaceActive',
  'tableHeader',
  'rowHover'
];

const NEUTRAL_BORDER_KEYS: Array<keyof BaseThemeColors> = ['border', 'borderMuted', 'borderStrong'];

const NEUTRAL_TEXT_KEYS: Array<keyof BaseThemeColors> = ['foreground', 'muted', 'mutedForeground'];

function neutralGroup(
  keys: Array<keyof BaseThemeColors>,
  base: BaseThemeColors,
  neutral: Hsl
): string[] {
  return keys
    .map((key) => {
      const triplet = toTriplet(base[key]);
      // Tint the neutral family: adopt its saturation and lightness, let the
      // preset's hue drive it. A 0% preset (black / white) yields pure greys.
      return triplet ? hslToString({ h: neutral.h, s: neutral.s, l: triplet.l }) : null;
    })
    .filter((value): value is string => value !== null);
}

/**
 * CSS custom properties for an accent override. Colours are `H S% L%` triplets
 * exactly like tokens.css, so Tailwind's `hsl(var(--token) / α)` keeps working.
 * Returns an empty object for malformed input (the theme's own colours stay).
 */
export function accentVars({
  accent,
  foreground,
  neutral,
  variant = 'dark',
  base,
  terminalPalette
}: AccentVarsInput): Record<string, string> {
  const triplet = hexToHslTriplet(accent);
  const rgb = hexToRgbTriplet(accent);
  const baseAccent = parseTriplet(triplet);
  if (!triplet || !rgb || !baseAccent) {
    return {};
  }

  // Dark UI: the accent should read bright, so "strong" goes lighter. Light
  // UI: "strong" goes darker so white or light labels hold on the fill.
  const strong = hslToString({
    ...baseAccent,
    l: variant === 'dark' ? baseAccent.l + 8 : baseAccent.l - 12
  });
  const soft = hslToString({
    ...baseAccent,
    s: baseAccent.s * 0.7,
    l: baseAccent.l + (variant === 'dark' ? 10 : 34)
  });
  // Text on accent fills: the preset's foreground, else white or near-black by
  // the accent's lightness. Saturation is kept out of the neutral fallbacks so
  // a grey or black accent does not produce tinted labels.
  const text = foreground
    ? (hexToHslTriplet(foreground) ?? (variant === 'dark' ? '0 0% 6%' : '0 0% 100%'))
    : baseAccent.l > 62
      ? '0 0% 8%'
      : '0 0% 100%';

  const vars: Record<string, string> = {
    '--accent': triplet,
    '--accent-strong': strong,
    '--accent-soft': soft,
    '--accent-rgb': rgb,
    '--accent-foreground': text,
    '--accent-text': strong,
    '--focus-ring': soft,
    '--link': strong,
    '--link-hover': triplet,
    '--menu-hover-bg': triplet,
    '--nav-hover-bg': `rgb(${rgb} / 0.16)`,
    '--row-selected-bg': `rgb(${rgb} / 0.18)`
  };

  if (!base) {
    return vars;
  }

  // Semantic hue: links and state colours adopt the accent hue while keeping
  // their own lightness, so they remain recognisable states.
  // The theme's own accent is the reference point for the semantic hue shift:
  // without it, a state would move by (accent - accent) = 0 and stay put.
  const baseAccentColor = toTriplet(base.accent);
  const hue = baseAccentColor?.h ?? baseAccent.h;
  const stateColors: Array<[keyof BaseThemeColors, string]> = [
    ['success', '--success'],
    ['warning', '--warning'],
    ['error', '--error'],
    ['terminalCursor', '--terminal-cursor']
  ];
  for (const [key, cssVar] of stateColors) {
    const color = toTriplet(base[key]);
    if (color) {
      vars[cssVar] = hslToString({ ...color, h: stateHue(color.h, hue, baseAccent.h) });
    }
  }
  const linkBase = toTriplet(base.muted) ?? toTriplet(base.foreground);
  if (linkBase) {
    vars['--link'] = strong;
    vars['--link-hover'] = triplet;
  }

  // Terminal palette: re-hue the coloured ANSI slots, keep black/white.
  if (terminalPalette && terminalPalette.length >= 16) {
    terminalPalette.forEach((hexValue, index) => {
      if (!TERMINAL_HUE_SLOTS.includes(index)) {
        return;
      }
      const color = toTriplet(hexValue);
      if (color) {
        vars[`--terminal-ansi-${index}`] = hslToString(shiftToHue(color, hue, 0.85));
      }
    });
  }

  // Neutrals: only the low-saturation / black / white presets carry one.
  const neutralBase = toTriplet(neutral);
  if (neutralBase) {
    [
      '--background',
      '--background-alt',
      '--surface',
      '--surface-elevated',
      '--surface-header'
    ].forEach((cssVar, index) => {
      const value = neutralGroup([NEUTRAL_SURFACE_KEYS[index]], base, neutralBase)[0];
      if (value) {
        vars[cssVar] = value;
      }
    });
    ['--surface-hover', '--surface-active', '--table-header', '--row-hover'].forEach(
      (cssVar, index) => {
        const value = neutralGroup([NEUTRAL_SURFACE_KEYS[index + 5]], base, neutralBase)[0];
        if (value) {
          vars[cssVar] = value;
        }
      }
    );
    NEUTRAL_BORDER_KEYS.forEach((key, index) => {
      const value = neutralGroup([key], base, neutralBase)[0];
      if (value) {
        vars[['--border', '--border-muted', '--border-strong'][index]] = value;
      }
    });
    NEUTRAL_TEXT_KEYS.forEach((key, index) => {
      const value = neutralGroup([key], base, neutralBase)[0];
      if (value) {
        vars[['--foreground', '--muted', '--muted-foreground'][index]] = value;
      }
    });
    vars['--hairline-color'] = 'hsl(var(--foreground) / 0.1)';
    vars['--terminal-selection'] = `rgba(${rgb.split(' ').join(', ')}, 0.28)`;
  }

  return vars;
}

/** Every property `accentVars` may set; used to clear the override cleanly. */
export const ACCENT_VAR_NAMES = [
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-rgb',
  '--accent-foreground',
  '--accent-text',
  '--focus-ring',
  '--link',
  '--link-hover',
  '--menu-hover-bg',
  '--nav-hover-bg',
  '--row-selected-bg',
  '--success',
  '--warning',
  '--error',
  '--terminal-cursor',
  '--background',
  '--background-alt',
  '--surface',
  '--surface-elevated',
  '--surface-header',
  '--surface-hover',
  '--surface-active',
  '--table-header',
  '--row-hover',
  '--border',
  '--border-muted',
  '--border-strong',
  '--foreground',
  '--muted',
  '--muted-foreground',
  '--hairline-color',
  '--terminal-selection',
  ...Array.from({ length: 16 }, (_, index) => `--terminal-ansi-${index}`)
] as const;

/**
 * Read the resolved base-theme triplets from the document, i.e. after
 * ThemeProvider has written `data-theme` and the custom-theme overrides but
 * before the accent override is applied. Used to re-hue states and neutrals
 * against the family actually on screen.
 */
export function readBaseThemeColors(): BaseThemeColors {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string): string | undefined =>
    styles.getPropertyValue(name).trim() || undefined;
  return {
    accent: read('--accent'),
    background: read('--background'),
    backgroundAlt: read('--background-alt'),
    surface: read('--surface'),
    surfaceElevated: read('--surface-elevated'),
    surfaceHeader: read('--surface-header'),
    surfaceHover: read('--surface-hover'),
    surfaceActive: read('--surface-active'),
    border: read('--border'),
    borderMuted: read('--border-muted'),
    borderStrong: read('--border-strong'),
    foreground: read('--foreground'),
    muted: read('--muted'),
    mutedForeground: read('--muted-foreground'),
    tableHeader: read('--table-header'),
    rowHover: read('--row-hover'),
    success: read('--success'),
    warning: read('--warning'),
    error: read('--error'),
    terminalCursor: read('--terminal-cursor')
  };
}

/** Write (or clear with `null`) the accent override on the root element. */
export function applyAccentVars(root: HTMLElement, vars: Record<string, string> | null): void {
  for (const name of ACCENT_VAR_NAMES) {
    root.style.removeProperty(name);
  }
  if (!vars) {
    return;
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}
