export type TerminalAction =
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'find'
  | 'clear'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export const TERMINAL_ACTION_EVENT = 'nexterm-terminal-action';

export function dispatchTerminalAction(action: TerminalAction): void {
  window.dispatchEvent(
    new CustomEvent<TerminalAction>(TERMINAL_ACTION_EVENT, { detail: action })
  );
}
