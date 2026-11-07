import { describe, expect, it, vi } from 'vitest';
import { dispatchTerminalAction, TERMINAL_ACTION_EVENT } from './terminalCommands';

describe('dispatchTerminalAction', () => {
  it('emits a custom event carrying the action', () => {
    const listener = vi.fn();
    window.addEventListener(TERMINAL_ACTION_EVENT, listener);

    dispatchTerminalAction({ type: 'zoom-in' });

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent<{ type: string }>;
    expect(event.detail.type).toBe('zoom-in');

    window.removeEventListener(TERMINAL_ACTION_EVENT, listener);
  });

  it('carries send-text payloads', () => {
    const listener = vi.fn();
    window.addEventListener(TERMINAL_ACTION_EVENT, listener);

    dispatchTerminalAction({ type: 'send-text', text: 'ls -la', execute: true });

    const event = listener.mock.calls[0][0] as CustomEvent<{ type: string; text: string }>;
    expect(event.detail).toEqual({ type: 'send-text', text: 'ls -la', execute: true });

    window.removeEventListener(TERMINAL_ACTION_EVENT, listener);
  });
});
