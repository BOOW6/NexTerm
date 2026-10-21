import { describe, expect, it } from 'vitest';
import { firstFontFamily, fontFamilyStack, quoteFontFamily } from './fontFamily';

describe('font family helpers', () => {
  it('extracts the first family from a CSS font stack', () => {
    expect(firstFontFamily('"Fira Code", monospace')).toBe('Fira Code');
    expect(firstFontFamily("'Microsoft YaHei', sans-serif")).toBe('Microsoft YaHei');
    expect(firstFontFamily('system-ui, -apple-system, sans-serif')).toBe('system-ui');
    expect(firstFontFamily('Consolas')).toBe('Consolas');
  });

  it('quotes family names safely', () => {
    expect(quoteFontFamily('Cascadia Code')).toBe('"Cascadia Code"');
    expect(quoteFontFamily('A "Quoted" Font')).toBe('"A \\"Quoted\\" Font"');
  });

  it('builds terminal and UI stacks', () => {
    expect(fontFamilyStack('Fira Code', 'terminal')).toBe('"Fira Code", monospace');
    expect(fontFamilyStack('Cascadia Code', 'ui')).toContain('"Cascadia Code"');
    expect(fontFamilyStack('Cascadia Code', 'ui')).toContain('sans-serif');
  });
});
