import { describe, expect, it } from 'vitest';
import { accentVars } from './accent';

describe('accentVars', () => {
  it('derives every accent token from one hex value', () => {
    const vars = accentVars({ accent: '#3b82f6', variant: 'dark' });
    expect(vars['--accent']).toBe('217 91% 60%');
    expect(vars['--accent-rgb']).toBe('59 130 246');
    expect(vars['--accent-foreground']).toBe('0 0% 100%');
    // Dark UIs brighten the accent for strong emphasis.
    expect(vars['--accent-strong']).toBe('217 91% 68%');
    expect(vars['--nav-hover-bg']).toBe('rgb(59 130 246 / 0.16)');
    expect(vars['--row-selected-bg']).toBe('rgb(59 130 246 / 0.18)');
    expect(vars['--focus-ring']).toBe(vars['--accent-soft']);
  });

  it('darkens the accent for light variants so white labels hold', () => {
    const light = accentVars({ accent: '#3b82f6', variant: 'light' });
    const dark = accentVars({ accent: '#3b82f6', variant: 'dark' });
    const lightL = Number.parseFloat(light['--accent-strong'].split(' ')[2]);
    const baseL = 60;
    expect(lightL).toBeLessThan(baseL);
    expect(Number.parseFloat(dark['--accent-strong'].split(' ')[2])).toBeGreaterThan(baseL);
  });

  it('uses the preset foreground and flips text on bright accents', () => {
    const preset = accentVars({ accent: '#2dd4bf', foreground: '#06231f' });
    expect(preset['--accent-foreground']).toBe('172 71% 8%');
    // No preset foreground: a very light accent gets dark text.
    const bright = accentVars({ accent: '#fde047' });
    expect(bright['--accent-foreground']).toBe('0 0% 8%');
  });

  it('returns no overrides for malformed colors', () => {
    expect(accentVars({ accent: 'not-a-color' })).toEqual({});
    expect(accentVars({ accent: '#12345' })).toEqual({});
  });
});
