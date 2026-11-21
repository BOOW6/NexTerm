import { describe, expect, it } from 'vitest';
import { localizeBackendError } from './backendErrors';

describe('localizeBackendError', () => {
  it('renders exact sentinel strings through i18n', () => {
    const localized = localizeBackendError('password required');
    // The active test locale resolves a real string, never the raw sentinel.
    expect(localized).not.toBe('password required');
    expect(localized.length).toBeGreaterThan(0);
  });

  it('keeps the remainder of a prefixed chain as the message parameter', () => {
    const localized = localizeBackendError('failed to connect to example.com:22: timeout');
    expect(localized).toContain('example.com:22: timeout');
    expect(localized).not.toContain('failed to connect to ');
  });

  it('returns unmatched diagnostics unchanged', () => {
    const raw = 'some future backend diagnostic: E_UNEXPECTED';
    expect(localizeBackendError(raw)).toBe(raw);
  });

  it('prefers the exact match over a prefix rule', () => {
    const exact = localizeBackendError('SSH agent authentication failed');
    const detailed = localizeBackendError('SSH agent authentication failed: no keys');
    expect(exact).not.toContain('no keys');
    expect(detailed).toContain('no keys');
  });
});
