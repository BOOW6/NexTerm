import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accentVars } from './accent';
import type { BaseThemeColors } from './accent';
import { allAccentPresets } from './themes';

/**
 * Decision report for converging the JS accent ramp (accent.ts) onto the CSS
 * color-mix ramp (derived-tokens.css). Skipped by default; run with
 * `ACCENT_MIX_REPORT=1 npx vitest run src/theme/accentColorMixReport.test.ts`
 * to print, for every preset x base theme, the oklab Delta-E between what
 * accent.ts writes today and what the equivalent color-mix derivation would
 * produce, plus the AA contrast of accent-foreground on the mixed strong fill.
 */

const CSS = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');

// ---- color math (oklab / oklch, mirrors CSS color-mix(in oklch)) ----
type Lab = [number, number, number];

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r: number, g: number, b: number;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
};
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgbToOklab = (r: number, g: number, b: number): Lab => {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
};
const toLch = (lab: Lab): Lab => {
  const [L, a, b] = lab;
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
};
const mixOklch = (labA: Lab, labB: Lab, wA: number): Lab => {
  const [L1, C1, H1] = toLch(labA);
  const [L2, C2, H2] = toLch(labB);
  let H: number;
  if (C1 < 1e-5) H = H2;
  else if (C2 < 1e-5) H = H1;
  else {
    let d = H2 - H1;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    H = H1 + d * (1 - wA);
  }
  const L = wA * L1 + (1 - wA) * L2;
  const C = wA * C1 + (1 - wA) * C2;
  return [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
};
const deltaE = (a: Lab, b: Lab): number => 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const tripletLab = (triplet: string): Lab | null => {
  const parts = triplet
    .trim()
    .split(/\s+/)
    .map((p) => Number.parseFloat(p));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  const [h, s, l] = parts;
  return rgbToOklab(...hslToRgb(((h % 360) + 360) % 360, s, l));
};

// relative luminance + contrast from an HSL triplet
const tripletLuminance = (triplet: string): number => {
  const parts = triplet
    .trim()
    .split(/\s+/)
    .map((p) => Number.parseFloat(p));
  const [h, s, l] = parts;
  const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, s, l);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
};
const contrast = (a: string, b: string): number => {
  const la = tripletLuminance(a);
  const lb = tripletLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// ---- parse theme blocks ----
function block(id: string): Record<string, string> {
  const match = new RegExp(`\\[data-theme='${id}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(CSS);
  const out: Record<string, string> = {};
  if (!match) return out;
  for (const decl of match[1].matchAll(/(--[a-z0-9-]+):\s*([\d.]+\s+[\d.]+%\s+[\d.]+%)/g)) {
    out[decl[1]] = decl[2];
  }
  return out;
}

const THEME_IDS = [...CSS.matchAll(/\[data-theme='([a-z0-9-]+)'\]/g)].map((m) => m[1]);
const isDark = (id: string): boolean => id === 'dim' || id.endsWith('-dark');

function baseColors(t: Record<string, string>): BaseThemeColors {
  return {
    accent: t['--accent'],
    background: t['--background'],
    backgroundAlt: t['--background-alt'],
    surface: t['--surface'],
    surfaceElevated: t['--surface-elevated'],
    surfaceHeader: t['--surface-header'],
    surfaceHover: t['--surface-hover'],
    surfaceActive: t['--surface-active'],
    border: t['--border'],
    borderMuted: t['--border-muted'],
    borderStrong: t['--border-strong'],
    foreground: t['--foreground'],
    muted: t['--muted'],
    mutedForeground: t['--muted-foreground'],
    tableHeader: t['--table-header'],
    rowHover: t['--row-hover'],
    success: t['--success'],
    warning: t['--warning'],
    error: t['--error'],
    terminalCursor: t['--terminal-cursor']
  };
}

/** The color-mix candidates from derived-tokens.css, evaluated offline. */
function cssRamp(t: Record<string, string>) {
  const primary = tripletLab(t['--accent'])!;
  const foreground = tripletLab(t['--foreground'])!;
  const surface = tripletLab(t['--surface'])!;
  return {
    strong: mixOklch(primary, foreground, 0.82),
    soft: mixOklch(primary, surface, 0.6),
    subtle: primary // wash comparisons use the RGB part only; alpha matches by construction
  };
}

describe.skipIf(!process.env.ACCENT_MIX_REPORT)('accent ramp: JS vs color-mix report', () => {
  it('prints per-preset drift and contrast', () => {
    const presets = allAccentPresets();
    const rows: string[] = [];
    const perKey: Record<string, number[]> = { strong: [], soft: [], link: [], focusRing: [] };
    let contrastFailures = 0;
    let contrastChecked = 0;

    for (const themeId of THEME_IDS) {
      const t = block(themeId);
      const variant = isDark(themeId) ? 'dark' : 'light';
      const css = cssRamp(t);
      for (const preset of presets) {
        const vars = accentVars({
          accent: preset.accent,
          foreground: preset.foreground,
          neutral: preset.neutral,
          variant,
          base: baseColors(t)
        });
        const jsStrong = tripletLab(vars['--accent-strong'])!;
        const jsSoft = tripletLab(vars['--accent-soft'])!;
        const dStrong = deltaE(jsStrong, css.strong);
        const dSoft = deltaE(jsSoft, css.soft);
        perKey.strong.push(dStrong);
        perKey.soft.push(dSoft);
        perKey.link.push(dStrong); // JS --link === strong
        perKey.focusRing.push(dSoft); // JS --focus-ring === soft

        // AA check for the real button pairing: preset foreground text on the
        // mixed strong fill (approximated back to HSL lightness via the JS
        // accent-foreground triplet, which is pure grey or the preset fg).
        const fgTriplet = vars['--accent-foreground'];
        const strongAsTriplet = hslFromLab(css.strong);
        const ratio = contrast(fgTriplet, strongAsTriplet);
        contrastChecked++;
        if (ratio < 4.5) contrastFailures++;

        rows.push(
          [
            themeId,
            preset.id,
            preset.accent,
            dStrong.toFixed(2),
            dSoft.toFixed(2),
            ratio.toFixed(2)
          ].join(' | ')
        );
      }
    }

    console.log('theme | preset | accent | dE(strong) | dE(soft) | contrast(fg on mixed strong)');
    for (const row of rows) console.log(row);
    console.log('\n--- summary ---');
    for (const [key, values] of Object.entries(perKey)) {
      const max = Math.max(...values);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      console.log(
        `${key}: mean dE=${mean.toFixed(2)}, max dE=${max.toFixed(2)} (n=${values.length})`
      );
    }
    console.log(
      `contrast AA failures (fg on mixed strong): ${contrastFailures}/${contrastChecked}`
    );
  });
});

// oklab -> approximate HSL triplet string (for contrast math only)
function hslFromLab(lab: Lab): string {
  const l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]) ** 3;
  const m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]) ** 3;
  const s = (lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2]) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const fromLinear = (c: number): number =>
    c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  const [rr, gg, bb] = [fromLinear(r), fromLinear(g), fromLinear(b)].map((c) =>
    Math.min(1, Math.max(0, c))
  );
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const light = (max + min) / 2;
  const d = max - min;
  let sat = 0;
  if (d !== 0) sat = d / (1 - Math.abs(2 * light - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === rr) hue = 60 * (((gg - bb) / d) % 6);
    else if (max === gg) hue = 60 * ((bb - rr) / d + 2);
    else hue = 60 * ((rr - gg) / d + 4);
  }
  hue = ((hue % 360) + 360) % 360;
  return `${hue.toFixed(2)} ${(sat * 100).toFixed(2)}% ${(light * 100).toFixed(2)}%`;
}
