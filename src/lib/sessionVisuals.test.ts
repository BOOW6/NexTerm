import { describe, expect, it } from 'vitest';
import { SESSION_STATUS_LABEL_KEY, sessionStatusDot } from './sessionVisuals';
import type { SessionStatus } from '../types/session';

const STATUSES: SessionStatus[] = ['idle', 'connecting', 'connected', 'disconnected', 'error'];

describe('sessionStatusDot', () => {
  it('combines color tokens with distinct shapes', () => {
    expect(sessionStatusDot('idle')).toBe('rounded-full border border-muted bg-transparent');
    expect(sessionStatusDot('connecting')).toBe(
      'rounded-full border-2 border-warning bg-transparent'
    );
    expect(sessionStatusDot('connected')).toBe('rounded-full bg-success');
    expect(sessionStatusDot('disconnected')).toBe('rounded-none bg-muted-foreground');
    expect(sessionStatusDot('error')).toBe('rotate-45 rounded-none bg-error');
  });

  it('pins the border radius per status so call-site classes cannot override the shape', () => {
    // Tailwind emits `rounded-full` after `rounded-none`, so any status whose
    // shape comes from a component base class silently collapses to a circle.
    for (const status of STATUSES) {
      expect(sessionStatusDot(status)).toMatch(/rounded-(full|none)/);
    }
    expect(sessionStatusDot('disconnected')).not.toContain('rounded-full');
    expect(sessionStatusDot('error')).not.toContain('rounded-full');
  });

  it('only pulses while connecting', () => {
    expect(sessionStatusDot('connecting', true)).toBe(
      'rounded-full border-2 border-warning bg-transparent animate-pulse'
    );
    expect(sessionStatusDot('connected', true)).toBe('rounded-full bg-success');
    expect(sessionStatusDot('connecting', false)).toBe(
      'rounded-full border-2 border-warning bg-transparent'
    );
  });

  it('maps every status to an i18n label key, never the raw enum', () => {
    expect(Object.keys(SESSION_STATUS_LABEL_KEY).sort()).toEqual([...STATUSES].sort());
    for (const key of Object.values(SESSION_STATUS_LABEL_KEY)) {
      expect(key).toMatch(/^status\./);
    }
  });
});
