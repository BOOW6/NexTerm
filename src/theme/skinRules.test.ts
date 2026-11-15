import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Button rules in the skin layer are source-ordered *before* the Tailwind
 * utilities (CSS drops an `@import` that follows any rule), so every family
 * rule must win by specificity. A rule that only qualifies as
 * `.app-button:hover` (two classes, one pseudo-class) loses to the
 * `hover:bg-button-hover` utility and the classic gradient repaints the
 * button on hover — the bug that made filled buttons lose their background
 * while keeping `--accent-foreground` text on top of a light gradient.
 */
const SKINS_DIR = resolve(__dirname, 'skins');
const SKIN_FILES = readdirSync(SKINS_DIR).filter((file) => file.endsWith('.css'));

/** Property assertions each filled variant must re-assert on hover. */
const HOVER_ASSERTIONS: Record<string, string[]> = {
  primary: ['background-image: none', 'background-color: var(--button-primary-bg)'],
  "data-variant='secondary'": ['background-color'],
  "data-variant='outline'": ['background-color']
};

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function familyFor(file: string): string {
  return file.replace(/\.css$/, '');
}

describe('skin button rules', () => {
  const familySkins = SKIN_FILES.filter((file) => familyFor(file) !== 'holo');

  it.each(familySkins)('%s qualifies rules by variant so utilities cannot win', (file) => {
    const css = stripComments(readFileSync(resolve(SKINS_DIR, file), 'utf8'));
    const family = familyFor(file);
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map(([, selector, body]) => ({ selector: selector.trim(), body }))
      .filter((rule) => rule.selector.includes(`[data-theme^='${family}']`));

    expect(rules.length).toBeGreaterThan(0);

    // No bare `.app-button:hover` / `.app-button { … :hover }` selectors: a
    // hover state must always be scoped to a variant.
    for (const rule of rules) {
      if (rule.selector.includes('.app-button') && rule.selector.includes(':hover')) {
        expect(rule.selector, `${file}: hover rule lacks a variant qualifier`).toMatch(
          /data-variant=/
        );
      }
    }

    // Every hover rule for a filled variant re-asserts its fill.
    for (const [variant, assertions] of Object.entries(HOVER_ASSERTIONS)) {
      const hoverRule = rules.find(
        (rule) => rule.selector.includes(variant) && rule.selector.includes(':hover')
      );
      for (const assertion of assertions) {
        expect(hoverRule?.body ?? '', `${file}: ${variant} hover misses "${assertion}"`).toContain(
          assertion
        );
      }
    }
  });
});
