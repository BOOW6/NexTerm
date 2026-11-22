import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergedDictionaries } from './index';

/**
 * Usage scan: every literal translation key referenced by components, hooks
 * and libraries must exist in the dictionaries. The key-alignment test only
 * proves zh/en agree with each other; a component referencing a key neither
 * dictionary defines would render the raw key to the user and pass that
 * gate. This test is the missing half.
 */

const ROOT = resolve(__dirname, '..');
const SCAN_DIRS = ['components', 'windows', 'hooks', 'lib', 'features', 'stores', 'theme', 'types'];

// Literal keys only: keys built from constants (SESSION_KIND_LABEL_KEY and
// friends) are single-sourced from the dictionaries themselves and cannot
// drift into raw-key rendering.
const KEY_PATTERNS = [/\bt\('([\w]+(?:\.[\w]+)+)'/g, /\btStatic\('([\w]+(?:\.[\w]+)+)'/g];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (
      /\.(tsx?|jsx?)$/.test(entry) &&
      !/\.test\.|\/i18n\/dictionaries\//.test(entry.replace(/\\/g, '/'))
    ) {
      out.push(full);
    }
  }
  return out;
}

function collectUsedKeys(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const dir of SCAN_DIRS) {
    for (const file of walk(resolve(ROOT, dir))) {
      const content = readFileSync(file, 'utf8');
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      for (const pattern of KEY_PATTERNS) {
        for (const match of content.matchAll(pattern)) {
          const key = match[1];
          const sites = usage.get(key) ?? [];
          sites.push(rel);
          usage.set(key, sites);
        }
      }
    }
  }
  return usage;
}

describe('i18n key usage', () => {
  it('resolves every referenced key in both locales', () => {
    const usage = collectUsedKeys();
    expect(usage.size).toBeGreaterThan(300);

    const missing: string[] = [];
    for (const [key, sites] of usage) {
      for (const [locale, dictionary] of Object.entries(mergedDictionaries)) {
        if (dictionary[key] === undefined) {
          missing.push(`${locale} missing "${key}" (used at ${sites[0]})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
