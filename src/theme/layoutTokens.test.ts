import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Layout is not theme.
 *
 * Sizes, weights, letter spacing and the geometry derived from spacing (tab
 * strip height, menu padding, header metrics) must come from exactly one
 * place — `layout-tokens.css` — and no theme, family skin or accent preset may
 * override them. A theme that could resize the tab strip or grow menu padding
 * would break hit targets and the horizontal budget every panel is laid out
 * against, and it would make density impossible to reason about.
 *
 * This test fails if layout comes back in through any door: a `[data-theme]`
 * block, a family skin, the accent override or a theme file's `structure`.
 */

const THEME_DIR = resolve(__dirname);
const LAYOUT_TOKENS = readFileSync(resolve(THEME_DIR, 'layout-tokens.css'), 'utf8');
const TOKENS = readFileSync(resolve(THEME_DIR, 'tokens.css'), 'utf8');

/** Layout-owned custom properties (the single source is layout-tokens.css). */
const LAYOUT_VARS = [
  '--text-micro',
  '--text-tiny',
  '--text-meta',
  '--text-body',
  '--text-body-lg',
  '--leading-tight',
  '--leading-normal',
  '--font-weight-normal',
  '--font-weight-medium',
  '--font-weight-emphasis',
  '--tracking-tight',
  '--tracking-wide',
  '--layout-tab-height',
  '--layout-menu-padding',
  '--layout-row-accent-bar',
  '--layout-tab-indicator',
  '--font-ui',
  '--font-mono'
];

function themeFiles(): string[] {
  const skins = readdirSync(resolve(THEME_DIR, 'skins'))
    .filter((file) => file.endsWith('.css'))
    .map((file) => resolve(THEME_DIR, 'skins', file));
  return [resolve(THEME_DIR, 'tokens.css'), ...skins];
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('layout tokens', () => {
  it('declares every layout variable exactly once, in :root', () => {
    const declarations = [...LAYOUT_TOKENS.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]);
    for (const name of LAYOUT_VARS) {
      expect(
        declarations.filter((value) => value === name),
        name
      ).toHaveLength(1);
    }
    // :root only — no theme selector may define them.
    const selectors = [...stripComments(LAYOUT_TOKENS).matchAll(/^([^@{][^{]*)\{/gm)].map((m) =>
      m[1].trim()
    );
    expect(selectors).toEqual([':root']);
  });

  it('is not redeclared by any theme or family skin', () => {
    for (const file of themeFiles()) {
      const css = stripComments(readFileSync(file, 'utf8'));
      for (const name of LAYOUT_VARS) {
        expect(css.includes(`${name}:`), `${file} redeclares ${name}`).toBe(false);
      }
    }
  });

  it('leaves no hard-coded font sizes in family skins', () => {
    for (const file of themeFiles()) {
      const css = stripComments(readFileSync(file, 'utf8'));
      // `font-size` itself is allowed only via a layout token.
      for (const match of css.matchAll(/font-size:\s*([^;]+);/g)) {
        expect(match[1].trim(), `${file}`).toContain('var(--text-');
      }
      expect(/font-weight:\s*\d/.test(css), `${file} hard-codes a weight`).toBe(false);
      for (const match of css.matchAll(/letter-spacing:\s*([^;]+);/g)) {
        const value = match[1].trim();
        expect(
          /^var\(--tracking-|^normal$/.test(value),
          `${file} hard-codes letter-spacing: ${value}`
        ).toBe(true);
      }
    }
  });

  it('does not let the accent override write layout properties', () => {
    // The accent derives colours; the only sizing it may touch is the
    // selection tint's alpha, never a metric the layout depends on.
    const accent = stripComments(readFileSync(resolve(THEME_DIR, 'accent.ts'), 'utf8'));
    for (const name of LAYOUT_VARS) {
      expect(accent.includes(`'${name}'`), `accent.ts writes ${name}`).toBe(false);
    }
    expect(accent.includes('--layout-')).toBe(false);
  });

  it('keeps theme tokens free of typography declarations', () => {
    // Color tokens only: an HSL triplet, or a gradient/shadow/color value.
    const declarations = [...stripComments(TOKENS).matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)];
    // `--accent-text` is a colour, not a text metric.
    const layoutish = declarations.filter(([, name]) =>
      /font|leading|tracking|spacing|layout|--text-/.test(name)
    );
    expect(layoutish.map(([, name]) => name)).toEqual([]);
  });
});
