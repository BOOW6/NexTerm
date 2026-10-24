import { describe, expect, it, vi } from 'vitest';
import { registerTerminalReconnect, requestTerminalReconnect } from './terminalReconnect';

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
