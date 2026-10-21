import { describe, expect, it, vi } from 'vitest';
import { dispatchTerminalAction, TERMINAL_ACTION_EVENT } from './terminalCommands';

describe('dispatchTerminalAction', () => {
  it('emits a custom event carrying the action', () => {
    const listener = vi.fn();
    window.addEventListener(TERMINAL_ACTION_EVENT, listener);

    dispatchTerminalAction('zoom-in');

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent<string>;
    expect(event.detail).toBe('zoom-in');

    window.removeEventListener(TERMINAL_ACTION_EVENT, listener);
  });
});
