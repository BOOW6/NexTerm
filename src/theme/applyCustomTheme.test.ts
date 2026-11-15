import { describe, expect, it } from 'vitest';
import {
  applyCustomThemeVars,
  customThemeSpecimenStyle,
  expandHex,
  hexToHslTriplet,
  hexToRgba,
  resolveCustomThemeVars,
  UI_COLOR_VARS
} from './applyCustomTheme';
import type { CustomThemeDefinition } from './customThemes';

function customTheme(partial: Partial<CustomThemeDefinition>): CustomThemeDefinition {
  return {
    id: 'nightfall',
    name: 'Nightfall',
    variant: 'dark',
    description: '',
    extends: 'dim',
    source: 'json',
    colors: {},
    terminal: null,
    ...partial
  };
}

describe('expandHex', () => {
  it('expands shorthands and tolerates a missing hash', () => {
    expect(expandHex('#FFF')).toBe('#ffffff');
    expect(expandHex('abc')).toBe('#aabbcc');
    expect(expandHex('#1234')).toBe('#11223344');
    expect(expandHex('#11223344')).toBe('#11223344');
  });

  it('rejects malformed values', () => {
    expect(expandHex('#12345')).toBeNull();
    expect(expandHex('#zzzzzz')).toBeNull();
    expect(expandHex('')).toBeNull();
  });
});

describe('hexToHslTriplet', () => {
  it('converts hex to correct HSL triplets', () => {
    // tokens.css: --accent: 209 60% 45%
    expect(hexToHslTriplet('#2e75b6')).toBe('209 60% 45%');
    // tokens.css authors #33b5e5 as 196 78% 55%; exact math rounds 77.4% to
    // 77% — visually identical, only the authored value differs by <1%.
    expect(hexToHslTriplet('#33b5e5')).toBe('196 77% 55%');
    expect(hexToHslTriplet('#ffffff')).toBe('0 0% 100%');
    expect(hexToHslTriplet('#000000')).toBe('0 0% 0%');
  });

  it('returns null for invalid input', () => {
    expect(hexToHslTriplet('nope')).toBeNull();
  });
});

describe('hexToRgba', () => {
  it('honors alpha from #rrggbbaa', () => {
    expect(hexToRgba('#ffffff80')).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('falls back to the default selection alpha', () => {
    expect(hexToRgba('#112233')).toBe('rgba(17, 34, 51, 0.35)');
  });
});

describe('resolveCustomThemeVars', () => {
  it('maps colors onto tokens.css variables in their expected formats', () => {
    const vars = resolveCustomThemeVars(
      customTheme({
        colors: {
          background: '#ffffff',
          accent: '#2e75b6',
          terminalSelection: '#ff000066'
        },
        terminal: { background: '#000000' }
      })
    );
    expect(vars['--background']).toBe('0 0% 100%');
    expect(vars['--accent']).toBe('209 60% 45%');
    expect(vars['--terminal-selection']).toBe('rgba(255, 0, 0, 0.4)');
    expect(vars['--terminal-background']).toBe('0 0% 0%');
    expect(Object.keys(vars)).not.toContain('--terminal-cursor');
  });

  it('lets the terminal section override the colors map', () => {
    const vars = resolveCustomThemeVars(
      customTheme({
        colors: { terminalSelection: '#ff000066' },
        terminal: { selectionBackground: '#ffffff' }
      })
    );
    expect(vars['--terminal-selection']).toBe('rgba(255, 255, 255, 0.35)');
  });

  it('ignores unknown color keys', () => {
    const vars = resolveCustomThemeVars(customTheme({ colors: { notAColor: '#fff' } }));
    expect(Object.keys(vars)).toHaveLength(0);
  });

  it('maps structure overrides onto structure tokens', () => {
    const vars = resolveCustomThemeVars(
      customTheme({
        structure: {
          radiusSm: '4px',
          tabHeight: '32px',
          panelWeight: '600',
          letterSpacing: '-0.01em',
          hairlineColor: '#c9d1d9'
        }
      })
    );
    expect(vars['--radius-sm']).toBe('4px');
    expect(vars['--tab-height']).toBe('32px');
    expect(vars['--panel-header-weight']).toBe('600');
    expect(vars['--panel-header-tracking']).toBe('-0.01em');
    // Color keys arrive as hex and are converted to the tokens.css triplet.
    expect(vars['--hairline-color']).toBe(hexToHslTriplet('#c9d1d9'));
  });

  it('ignores unknown structure keys', () => {
    const vars = resolveCustomThemeVars(customTheme({ structure: { mystery: '1px' } }));
    expect(Object.keys(vars)).toHaveLength(0);
  });
});

describe('applyCustomThemeVars', () => {
  it('sets and clears inline overrides on the root element', () => {
    const root = document.documentElement;
    applyCustomThemeVars(root, customTheme({ colors: { background: '#ffffff' } }));
    expect(root.style.getPropertyValue('--background')).toBe('0 0% 100%');

    applyCustomThemeVars(root, null);
    expect(root.style.getPropertyValue('--background')).toBe('');
  });

  it('clears overrides from other custom themes when switching', () => {
    const root = document.documentElement;
    applyCustomThemeVars(root, customTheme({ id: 'a', colors: { background: '#ffffff' } }));
    applyCustomThemeVars(root, customTheme({ id: 'b', colors: { accent: '#2e75b6' } }));
    expect(root.style.getPropertyValue('--background')).toBe('');
    expect(root.style.getPropertyValue('--accent')).toBe('209 60% 45%');

    applyCustomThemeVars(root, null);
    expect(root.style.getPropertyValue('--accent')).toBe('');
  });

  it('clears structure overrides too', () => {
    const root = document.documentElement;
    applyCustomThemeVars(root, customTheme({ structure: { radiusSm: '4px' } }));
    expect(root.style.getPropertyValue('--radius-sm')).toBe('4px');
    applyCustomThemeVars(root, null);
    expect(root.style.getPropertyValue('--radius-sm')).toBe('');
  });
});

describe('customThemeSpecimenStyle', () => {
  it('provides inline CSS variables for preview specimens', () => {
    const style = customThemeSpecimenStyle(customTheme({ colors: { background: '#ffffff' } }));
    expect((style as Record<string, string>)[UI_COLOR_VARS.background]).toBe('0 0% 100%');
  });
});
