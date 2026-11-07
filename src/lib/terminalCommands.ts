export type TerminalAction =
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'select-all' }
  | { type: 'find' }
  | { type: 'clear' }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'zoom-reset' }
  /** Inject text into the active terminal as if typed. */
  | { type: 'send-text'; text: string; execute: boolean };

export const TERMINAL_ACTION_EVENT = 'nexterm-terminal-action';

export function dispatchTerminalAction(action: TerminalAction): void {
  window.dispatchEvent(new CustomEvent<TerminalAction>(TERMINAL_ACTION_EVENT, { detail: action }));
}
