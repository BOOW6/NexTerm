import { hexToHslTriplet } from './applyCustomTheme';

/**
 * Accent override.
 *
 * Modern families expose an accent palette. The chosen accent is stored as a
 * hex string in settings and written as the theme's accent tokens on the root
 * element, so a family keeps its neutral surfaces while the accent (buttons,
 * selection, focus rings, links) changes. Everything is derived from the one
 * hex value: strong = a darker/lighter shade of the same hue, soft = a muted
 * version, and `--accent-rgb` for the `rgb(var(--accent-rgb) / α)` mixes skins
 * use.
 */

/** Tokens an accent override may write, in apply order. */
const ACCENT_VARS = [
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-rgb',
  '--accent-text',
  '--focus-ring',
  '--link',
  '--link-hover',
  '--menu-hover-bg',
  '--nav-hover-bg',
  '--row-selected-bg'
] as const;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function parseTriplet(triplet: string): Hsl | null {
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

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function hslToString({ h, s, l }: Hsl): string {
  return `${h} ${clamp(Math.round(s), 0, 100)}% ${clamp(Math.round(l), 0, 100)}%`;
}

/** `#rrggbb` → `r g b` for the alpha-mix token. */
function hexToRgbTriplet(hex: string): string | null {
  const body = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(body)) {
    return null;
  }
  return `${parseInt(body.slice(0, 2), 16)} ${parseInt(body.slice(2, 4), 16)} ${parseInt(body.slice(4, 6), 16)}`;
}

export interface AccentVarsInput {
  accent: string;
  foreground?: string;
  /** Which end of the luminance range "strong" moves toward. */
  variant?: 'light' | 'dark';
}

/**
 * CSS custom properties for an accent override. Colors are `H S% L%` triplets
 * exactly like tokens.css, so Tailwind's `hsl(var(--token) / α)` keeps working.
 * Returns an empty object for malformed input (the theme's own accent stays).
 */
export function accentVars({
  accent,
  foreground,
  variant
}: AccentVarsInput): Record<string, string> {
  const triplet = hexToHslTriplet(accent);
  const rgb = hexToRgbTriplet(accent);
  const base = triplet ? parseTriplet(triplet) : null;
  if (!triplet || !rgb || !base) {
    return {};
  }

  // Dark UI: the accent should read bright, so "strong" goes lighter (hover /
  // pressed emphasis). Light UI: "strong" goes darker so white labels hold.
  const strong = hslToString({
    ...base,
    l: variant === 'dark' ? base.l + 8 : base.l - 12
  });
  const soft = hslToString({
    ...base,
    s: base.s * 0.7,
    l: base.l + (variant === 'dark' ? 10 : 34)
  });
  // Text on accent fills: the preset's foreground, else white or near-black
  // by relative luminance of the accent.
  const text = foreground
    ? (hexToHslTriplet(foreground) ?? (variant === 'dark' ? '0 0% 6%' : '0 0% 100%'))
    : base.l > 62
      ? '0 0% 8%'
      : '0 0% 100%';

  return {
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
}

/** Write (or clear with `null`) the accent override on the root element. */
export function applyAccentVars(root: HTMLElement, vars: Record<string, string> | null): void {
  for (const name of ACCENT_VARS) {
    root.style.removeProperty(name);
  }
  if (!vars) {
    return;
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}
