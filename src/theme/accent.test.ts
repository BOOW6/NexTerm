import { describe, expect, it } from 'vitest';
import { accentVars } from './accent';

/** `H S% L%` → tuple for assertions. */
function parse(value: string): [number, number, number] {
  const [h, s, l] = value
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseFloat(part));
  return [h, s, l];
}

const BASE = {
  accent: '212 92% 60%',
  background: '215 21% 7%',
  backgroundAlt: '220 20% 10%',
  surface: '215 21% 11%',
  surfaceElevated: '215 21% 14%',
  surfaceHeader: '215 21% 9%',
  surfaceHover: '215 16% 16%',
  surfaceActive: '214 15% 20%',
  border: '215 14% 21%',
  borderMuted: '215 16% 16%',
  borderStrong: '215 12% 30%',
  foreground: '213 28% 92%',
  muted: '214 12% 66%',
  mutedForeground: '214 10% 52%',
  tableHeader: '215 21% 12%',
  rowHover: '215 16% 15%',
  success: '137 55% 53%',
  warning: '40 70% 58%',
  error: '355 65% 65%',
  terminalCursor: '212 90% 68%'
};

const PALETTE = [
  '#484f58',
  '#ff7b72',
  '#3fb950',
  '#d29922',
  '#58a6ff',
  '#bc8cff',
  '#39c5cf',
  '#b1bac4',
  '#6e7681',
  '#ffa198',
  '#56d364',
  '#e3b341',
  '#79c0ff',
  '#d2a8ff',
  '#56d4dd',
  '#f0f6fc'
];

describe('accentVars', () => {
  it('derives the accent ramp from one hex value', () => {
    const vars = accentVars({ accent: '#3b82f6', variant: 'dark' });
    expect(vars['--accent']).toBe('217 91% 60%');
    expect(vars['--accent-rgb']).toBe('59 130 246');
    expect(vars['--accent-foreground']).toBe('0 0% 100%');
    expect(vars['--accent-strong']).toBe('217 91% 68%');
    expect(vars['--nav-hover-bg']).toBe('rgb(59 130 246 / 0.16)');
  });

  it('brightens "strong" on dark UIs and darkens it on light ones', () => {
    const dark = accentVars({ accent: '#3b82f6', variant: 'dark' });
    const light = accentVars({ accent: '#3b82f6', variant: 'light' });
    expect(parse(dark['--accent-strong'])[2]).toBeGreaterThan(60);
    expect(parse(light['--accent-strong'])[2]).toBeLessThan(60);
  });

  it('uses the preset foreground for text on the accent fill', () => {
    const graphite = accentVars({ accent: '#2dd4bf', foreground: '#06231f' });
    expect(graphite['--accent-foreground']).toBe('172 71% 8%');
    expect(accentVars({ accent: '#fde047' })['--accent-foreground']).toBe('0 0% 8%');
  });

  it('re-hues links, state colors and the terminal cursor onto the accent hue', () => {
    const vars = accentVars({ accent: '#2dd4bf', variant: 'dark', base: BASE });
    const accentHue = parse(vars['--accent'])[0];
    for (const token of ['--success', '--warning', '--error', '--terminal-cursor']) {
      const [hue, , lightness] = parse(vars[token]);
      // The shift from the base hue is capped at 40 degrees, so a state keeps
      // its identity instead of being repainted in the accent colour.
      const baseHue: number = {
        '--success': parse(BASE.success)[0],
        '--warning': parse(BASE.warning)[0],
        '--error': parse(BASE.error)[0],
        '--terminal-cursor': parse(BASE.terminalCursor)[0]
      }[token] as number;
      expect(Math.abs(((hue - baseHue + 540) % 360) - 180)).toBeLessThanOrEqual(40);
      // Lightness is preserved: states keep their role, only the hue moves.
      expect(lightness).toBeGreaterThan(0);
    }
    expect(parse(vars['--success'])[2]).toBe(parse(BASE.success)[2]);
    expect(parse(vars['--error'])[2]).toBe(parse(BASE.error)[2]);
    // The accent itself follows the chosen hue.
    expect(Math.abs(((accentHue - 172 + 540) % 360) - 180)).toBeLessThan(2);
  });

  it('never collapses success and error onto the same hue', () => {
    const vars = accentVars({ accent: '#3b82f6', variant: 'dark', base: BASE });
    const success = parse(vars['--success'])[0];
    const error = parse(vars['--error'])[0];
    const distance = Math.abs(((success - error + 540) % 360) - 180);
    expect(distance).toBeGreaterThan(20);
  });

  it('uses the base theme accent, not the chosen one, as the shift reference', () => {
    // Regression: passing the new accent as the reference made the delta 0 and
    // left every semantic colour untouched.
    const shifted = accentVars({ accent: '#2dd4bf', variant: 'dark', base: BASE });
    const sameAsBase = accentVars({
      accent: '#3b82f6',
      variant: 'dark',
      base: { ...BASE, accent: '212 92% 60%' }
    });
    expect(shifted['--success']).not.toBe(BASE.success);
    expect(parse(sameAsBase['--success'])[0]).not.toBe(parse(BASE.success)[0]);
  });

  it('keeps semantic colours distinguishable from each other', () => {
    const vars = accentVars({ accent: '#3b82f6', variant: 'dark', base: BASE });
    expect(vars['--success']).not.toBe(vars['--error']);
    expect(vars['--warning']).not.toBe(vars['--error']);
  });

  it('re-hues only the coloured ANSI slots, keeping black and white', () => {
    const vars = accentVars({
      accent: '#2dd4bf',
      variant: 'dark',
      base: BASE,
      terminalPalette: PALETTE
    });
    // Slots 0, 7, 8 and 15 stay as they are.
    for (const index of [0, 7, 8, 15]) {
      expect(vars[`--terminal-ansi-${index}`]).toBeUndefined();
    }
    for (const index of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]) {
      expect(vars[`--terminal-ansi-${index}`], `slot ${index}`).toBeDefined();
    }
  });

  it('neutralizes surfaces, borders and text for a neutral preset', () => {
    const vars = accentVars({
      accent: '#64748b',
      neutral: '#94a3b8',
      variant: 'dark',
      base: BASE
    });
    // #94a3b8 → 215 20% 65%: every neutral adopts the preset's hue and
    // saturation …
    const [, saturation] = parse(vars['--surface']);
    expect(saturation).toBe(20);
    expect(parse(vars['--foreground'])[1]).toBe(20);
    // … while keeping the base lightness, so contrast relationships survive.
    expect(parse(vars['--surface'])[2]).toBe(parse(BASE.surface)[2]);
    expect(parse(vars['--foreground'])[2]).toBe(parse(BASE.foreground)[2]);
    expect(parse(vars['--border'])[2]).toBe(parse(BASE.border)[2]);
    expect(vars['--terminal-selection']).toMatch(/^rgba\(\d+, \d+, \d+, 0\.28\)$/);
  });

  it('produces pure greys when the accent itself is a pure neutral', () => {
    // #808080 → 0 0% 50%; the neutral group adopts that hue and 0% saturation.
    const vars = accentVars({
      accent: '#1f2937',
      neutral: '#808080',
      variant: 'dark',
      base: BASE
    });
    for (const token of ['--surface', '--foreground', '--border']) {
      expect(parse(vars[token])[1], `${token} saturation`).toBe(0);
    }
  });

  it('returns no overrides for malformed colors', () => {
    expect(accentVars({ accent: 'not-a-color' })).toEqual({});
    expect(accentVars({ accent: '#12345' })).toEqual({});
  });
});
