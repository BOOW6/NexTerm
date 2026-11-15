import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Contrast audit over the real token sheet.
 *
 * The themes are plain CSS, so this parses `src/theme/tokens.css` and checks
 * the pairings a user actually reads. Parsing the source (instead of importing
 * constants) keeps the test honest: a hand-tuned literal can never drift from
 * what ships. Thresholds follow WCAG AA: 4.5:1 for body text, 3:1 for large /
 * non-text UI.
 */

const CSS = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');

interface ThemeColors {
  [token: string]: string;
}

/** Collect `token: H S% L%` declarations per `[data-theme='id']` block. */
function parseThemes(css: string): Record<string, ThemeColors> {
  const themes: Record<string, ThemeColors> = {};
  const blockPattern = /\[data-theme='([a-z0-9-]+)'\]\s*\{([\s\S]*?)\n\}/g;
  for (const match of css.matchAll(blockPattern)) {
    const [, id, body] = match;
    const tokens: ThemeColors = {};
    for (const decl of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
      const value = decl[2].trim();
      if (/^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/.test(value)) {
        tokens[decl[1]] = value;
      }
    }
    themes[id] = tokens;
  }
  // `:root, [data-theme='day']` shares one block; the regex only captured the
  // theme selector, which is what we audit.
  return themes;
}

function tripletToRgb(triplet: string): [number, number, number] {
  const [h, s, l] = triplet.split(/\s+/).map((part) => Number.parseFloat(part));
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hue = ((h % 360) + 360) % 360;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  let rgb: [number, number, number];
  if (hue < 60) {
    rgb = [chroma, x, 0];
  } else if (hue < 120) {
    rgb = [x, chroma, 0];
  } else if (hue < 180) {
    rgb = [0, chroma, x];
  } else if (hue < 240) {
    rgb = [0, x, chroma];
  } else if (hue < 300) {
    rgb = [x, 0, chroma];
  } else {
    rgb = [chroma, 0, x];
  }
  return rgb.map((channel) => Math.round((channel + m) * 255)) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(tripletToRgb(a));
  const lb = relativeLuminance(tripletToRgb(b));
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

const THEMES = parseThemes(CSS);

/**
 * [label, foreground token, background token, minimum ratio].
 *
 * Pairings mirror what components actually render:
 * - primary buttons paint `--gradient-button-primary` (whose fallback family
 *   is the theme's `--accent-strong`) under `--accent-foreground`, and the
 *   Classic families keep that dark-enough shade, so the label is checked
 *   against `--accent-strong`. `--accent` itself is used for selection fills
 *   and focus rings, not as a text ground.
 * - `--muted-foreground` is only used for tertiary micro-labels, so it is held
 *   to the 3:1 non-text threshold.
 */
const PAIRINGS: Array<[string, string, string, number]> = [
  ['body text on background', '--foreground', '--background', 4.5],
  ['body text on surface', '--foreground', '--surface', 4.5],
  ['body text on elevated surface', '--foreground', '--surface-elevated', 4.5],
  ['body text on header surface', '--foreground', '--surface-header', 4.5],
  ['body text on hovered row', '--foreground', '--surface-hover', 4.5],
  ['body text on pressed row', '--foreground', '--surface-active', 4.5],
  ['secondary text on surface', '--muted', '--surface', 4.5],
  ['secondary text on background', '--muted', '--background', 4.5],
  ['tertiary micro-label on background', '--muted-foreground', '--background', 3],
  ['primary button label', '--accent-foreground', '--accent-strong', 3],
  ['secondary button label', '--foreground', '--surface', 4.5],
  ['link text on background', '--link', '--background', 3],
  ['success state on surface', '--success', '--surface', 3],
  ['warning state on surface', '--warning', '--surface', 3],
  ['error state on surface', '--error', '--surface', 3]
];

describe('theme contrast (WCAG AA)', () => {
  it('parses every built-in theme', () => {
    expect(Object.keys(THEMES).sort()).toEqual(
      [
        'aqua-dark',
        'aqua-light',
        'day',
        'dim',
        'graphite-dark',
        'graphite-light',
        'holo-dark',
        'holo-light',
        'sandstone-dark',
        'sandstone-light',
        'slate-dark',
        'slate-light',
        'tgreen-dark',
        'tgreen-light'
      ].sort()
    );
  });

  for (const [themeId, tokens] of Object.entries(THEMES)) {
    describe(themeId, () => {
      for (const [label, fg, bg, minimum] of PAIRINGS) {
        it(`${label} >= ${minimum}:1`, () => {
          const foreground = tokens[fg];
          const background = tokens[bg];
          expect(foreground, `${fg} missing`).toBeDefined();
          expect(background, `${bg} missing`).toBeDefined();
          const ratio = contrastRatio(foreground, background);
          expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum);
        });
      }
    });
  }
});
