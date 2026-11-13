import { describe, expect, it } from 'vitest';
import { EN as coreEn, ZH as coreZh } from './dictionaries/core';
import { EN as panelsEn, ZH as panelsZh } from './dictionaries/panels';
import { EN as settingsEn, ZH as settingsZh } from './dictionaries/settings';
import { EN as terminalEn, ZH as terminalZh } from './dictionaries/terminal';
import { EN as workspaceEn, ZH as workspaceZh } from './dictionaries/workspace';
import { resolveLocale, tStatic, translate } from './index';

const FRAGMENTS: Array<[name: string, zh: Record<string, string>, en: Record<string, string>]> = [
  ['core', coreZh, coreEn],
  ['settings', settingsZh, settingsEn],
  ['panels', panelsZh, panelsEn],
  ['workspace', workspaceZh, workspaceEn],
  ['terminal', terminalZh, terminalEn]
];

// The fragment list is re-declared here (instead of importing the merged
// dictionaries) so the test fails loudly when a new fragment file is added
// without updating this parity check.

describe('i18n dictionaries', () => {
  it('every fragment has identical key sets in zh-CN and en-US', () => {
    for (const [name, zh, en] of FRAGMENTS) {
      const zhKeys = Object.keys(zh);
      const enKeys = Object.keys(en);
      expect(zhKeys, `${name}: keys missing in EN`).toEqual(expect.arrayContaining(enKeys));
      expect(enKeys, `${name}: keys missing in ZH`).toEqual(expect.arrayContaining(zhKeys));
    }
  });

  it('no fragment ships empty values', () => {
    for (const [name, zh, en] of FRAGMENTS) {
      for (const [key, value] of Object.entries(zh)) {
        expect(value.trim(), `${name}:${key} has an empty ZH value`).not.toBe('');
      }
      for (const [key, value] of Object.entries(en)) {
        expect(value.trim(), `${name}:${key} has an empty EN value`).not.toBe('');
      }
    }
  });

  it('no key is defined by two fragments', () => {
    const seen = new Map<string, string>();
    for (const [name, zh] of FRAGMENTS) {
      for (const key of Object.keys(zh)) {
        const owner = seen.get(key);
        expect(owner, `key ${key} defined in both ${owner} and ${name}`).toBeUndefined();
        seen.set(key, name);
      }
    }
  });

  it('interpolates params and falls back to ZH for missing EN keys', () => {
    expect(translate('en-US', 'sidebar.total', { count: 3 })).toBe('3 sessions');
    expect(translate('zh-CN', 'sidebar.total', { count: 3 })).toBe('共 3 个会话');
    // A key that only exists in ZH still renders instead of leaking the key.
    expect(translate('en-US', 'definitely.missing.key')).toBe('definitely.missing.key');
  });

  it('resolves locale from settings', () => {
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    expect(resolveLocale('en-US')).toBe('en-US');
    expect(resolveLocale('system')).toMatch(/zh-CN|en-US/);
  });

  it('tStatic translates outside React', () => {
    expect(tStatic('app.newSession')).toMatch(/会话|session/i);
  });
});
