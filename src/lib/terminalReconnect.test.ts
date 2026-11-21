import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RECONNECT_ATTEMPTS,
  nextReconnectDelay,
  registerTerminalReconnect,
  requestTerminalReconnect,
  shouldResetBackoff
} from './terminalReconnect';

describe('terminalReconnect', () => {
  it('returns false when no terminal is mounted', () => {
    expect(requestTerminalReconnect('missing')).toBe(false);
  });

  it('reconnects every panel of a session and unregisters cleanly', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unregisterFirst = registerTerminalReconnect('session-1', first);
    const unregisterSecond = registerTerminalReconnect('session-1', second);

    expect(requestTerminalReconnect('session-1')).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unregisterFirst();
    unregisterSecond();
    expect(requestTerminalReconnect('session-1')).toBe(false);
  });

  it('reports false when a registered terminal is not ready yet', () => {
    const unregister = registerTerminalReconnect('session-2', () => false);
    expect(requestTerminalReconnect('session-2')).toBe(false);
    unregister();
  });
});

describe('reconnect backoff', () => {
  it('doubles per attempt and caps at 16s', () => {
    expect(nextReconnectDelay(1)).toBe(1_000);
    expect(nextReconnectDelay(2)).toBe(2_000);
    expect(nextReconnectDelay(3)).toBe(4_000);
    expect(nextReconnectDelay(5)).toBe(16_000);
    expect(nextReconnectDelay(9)).toBe(16_000);
  });

  it('only resets the backoff for connections that stayed healthy', () => {
    expect(shouldResetBackoff(10_000)).toBe(false);
    expect(shouldResetBackoff(10_001)).toBe(true);
  });

  it('exposes the attempt ceiling', () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(5);
  });
});
