import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guard for the derived-token layer.
 *
 * The accent ramp lives in `derived-tokens.css` as color-mix derivations of
 * `--primary`, and the per-theme gradient / terminal-selection tokens in
 * `tokens.css` must stay derived (var / hsl / color-mix) so they follow a
 * custom accent. A hardcoded hex or rgba() in either place silently breaks
 * that (see doc/de-slop/audit.md A1/A2).
 */

const TOKENS = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');
const DERIVED = readFileSync(resolve(__dirname, 'derived-tokens.css'), 'utf8');
const INDEX_CSS = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

const DERIVED_KEYS = [
  '--gradient-header',
  '--gradient-panel-title',
  '--gradient-button',
  '--gradient-button-hover',
  '--gradient-button-primary',
  '--terminal-selection'
];

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every declaration of the given keys across all theme blocks. */
function declarations(
  css: string,
  keys: string[]
): Array<{ theme: string; key: string; value: string }> {
  const out: Array<{ theme: string; key: string; value: string }> = [];
  for (const block of css.matchAll(/\[data-theme='([a-z0-9-]+)'\]\s*\{([\s\S]*?)\n\}/g)) {
    const [, theme, body] = block;
    for (const decl of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
      if (keys.includes(decl[1])) {
        out.push({ theme, key: decl[1], value: decl[2].trim() });
      }
    }
  }
  return out;
}

describe('derived token layer', () => {
  it('theme gradient and selection tokens contain no literal colors', () => {
    const decls = declarations(stripComments(TOKENS), DERIVED_KEYS);
    // 14 themes x 6 tokens
    expect(decls.length).toBe(14 * DERIVED_KEYS.length);
    for (const { theme, key, value } of decls) {
      expect(value, `${theme} ${key} must not contain hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(value, `${theme} ${key} must not contain rgb()/rgba()`).not.toMatch(/\brgba?\(/);
      expect(value, `${theme} ${key} must not contain hsl() with literal numbers`).not.toMatch(
        /\bhsla?\(\s*\d/
      );
    }
  });

  it('every theme block declares all six derived keys', () => {
    const decls = declarations(stripComments(TOKENS), DERIVED_KEYS);
    const perTheme = new Map<string, Set<string>>();
    for (const { theme, key } of decls) {
      if (!perTheme.has(theme)) {
        perTheme.set(theme, new Set());
      }
      perTheme.get(theme)!.add(key);
    }
    expect(perTheme.size).toBe(14);
    for (const [theme, keys] of perTheme) {
      expect(keys.size, `${theme} missing derived keys`).toBe(DERIVED_KEYS.length);
    }
  });

  it('derived-tokens.css is a single :root layer of color-mix ramp tokens', () => {
    const css = stripComments(DERIVED);
    const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    expect(blocks.length).toBe(1);
    expect(blocks[0][1].trim()).toBe(':root');

    const body = blocks[0][2];
    const declared = [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((d) => d[1]);
    expect(declared).toEqual([
      '--primary',
      '--primary-hover',
      '--primary-active',
      '--primary-strong',
      '--primary-soft',
      '--primary-muted',
      '--primary-border',
      '--primary-subtle',
      '--overlay-scrim'
    ]);

    // The base is the full-color view of the accent triplet...
    expect(body).toContain('--primary: hsl(var(--accent));');
    // ...and every accent-derived ramp token is a color-mix in oklch of
    // --primary. --overlay-scrim is deliberately excluded: it is a fixed
    // neutral scrim (black wash), not part of the accent ramp.
    for (const key of declared.slice(1, -1)) {
      const value = body.match(new RegExp(`${key}:\\s*([^;]+);`))![1];
      expect(value, `${key} must derive via color-mix(in oklch)`).toMatch(
        /^color-mix\(in oklch, var\(--primary\) \d+%,/
      );
    }
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('index.css imports the derived layer after the base tokens', () => {
    const tokensAt = INDEX_CSS.indexOf("@import './theme/tokens.css';");
    const derivedAt = INDEX_CSS.indexOf("@import './theme/derived-tokens.css';");
    const skinAt = INDEX_CSS.indexOf("@import './theme/skin-tokens.css';");
    expect(tokensAt).toBeGreaterThan(-1);
    expect(derivedAt).toBeGreaterThan(tokensAt);
    expect(skinAt).toBeGreaterThan(derivedAt);
  });
});
