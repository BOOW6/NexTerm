import { describe, expect, it } from 'vitest';
import { formatBytes, formatSpeed } from './format';

describe('formatBytes', () => {
  it('formats bytes below 1 KiB without decimals', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats KiB, MiB and GiB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
  });
});

describe('formatSpeed', () => {
  it('appends a per-second suffix', () => {
    expect(formatSpeed(2048)).toBe('2.0 KB/s');
    expect(formatSpeed(500)).toBe('500 B/s');
  });
});
