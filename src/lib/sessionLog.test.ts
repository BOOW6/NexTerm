import { describe, expect, it } from 'vitest';
import { sanitizeLogTitle, sessionLogFileName, sessionLogPath } from './sessionLog';

describe('sanitizeLogTitle', () => {
  it('replaces filesystem-illegal characters', () => {
    expect(sanitizeLogTitle('prod/web:8080')).toBe('prod_web_8080');
    expect(sanitizeLogTitle('a*b?c"d<e|f')).toBe('a_b_c_d_e_f');
  });

  it('falls back to "session" when everything is stripped', () => {
    expect(sanitizeLogTitle('///')).toBe('session');
    expect(sanitizeLogTitle('  ')).toBe('session');
  });
});

describe('sessionLogFileName', () => {
  it('embeds a sortable timestamp', () => {
    const name = sessionLogFileName('prod', new Date(2026, 0, 2, 3, 4, 5));
    expect(name).toBe('prod-20260102-030405.log');
  });
});

describe('sessionLogPath', () => {
  it('joins the directory without doubling separators', () => {
    const at = new Date(2026, 10, 8, 12, 0, 0);
    expect(sessionLogPath('C:\\logs', 'web', at)).toBe('C:\\logs\\web-20261108-120000.log');
    expect(sessionLogPath('C:\\logs\\', 'web', at)).toBe('C:\\logs\\web-20261108-120000.log');
  });

  it('returns empty when no directory is configured', () => {
    expect(sessionLogPath('', 'web')).toBe('');
    expect(sessionLogPath('   ', 'web')).toBe('');
  });
});
