import { describe, expect, it } from 'vitest';
import { sessionStatusDot } from './sessionVisuals';

describe('sessionStatusDot', () => {
  it('maps each status to its color token', () => {
    expect(sessionStatusDot('idle')).toBe('bg-muted');
    expect(sessionStatusDot('connecting')).toBe('bg-warning');
    expect(sessionStatusDot('connected')).toBe('bg-success');
    expect(sessionStatusDot('disconnected')).toBe('bg-muted-foreground');
    expect(sessionStatusDot('error')).toBe('bg-error');
  });

  it('only pulses while connecting', () => {
    expect(sessionStatusDot('connecting', true)).toBe('bg-warning animate-pulse');
    expect(sessionStatusDot('connected', true)).toBe('bg-success');
    expect(sessionStatusDot('connecting', false)).toBe('bg-warning');
  });
});
