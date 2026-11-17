/**
 * Who owns the cursor line when the grid width changes?
 *
 * cmd.exe under ConPTY never repaints its prompt on SIGWINCH; the terminal has
 * to reflow the cursor line itself, otherwise the prompt prefix is truncated
 * and ConPTY's absolute cursor moves land on the wrong row. readline, zle,
 * fish and PSReadLine all repaint their prompt from the cursor position they
 * believe is current, so moving that cursor (parking it below the group, or
 * reflowing it) makes them draw the prompt twice or overwrite the line above.
 *
 * The decision therefore depends on the shell, not on whether the cursor line
 * happens to overflow the new width.
 */
export type CursorLineResizeMode = 'local-reflow' | 'shell-repaint';

export interface CursorLineResizeInput {
  transport: 'local' | 'ssh' | 'telnet' | 'serial';
  /** Local PTY shell executable; undefined means the platform default. */
  shellCommand?: string;
  /** `pty_platform_info().backend`; null on non-Windows. */
  backend?: 'conpty' | 'winpty' | null;
}

/** Lower-case executable name, without directories or a wrapping quote pair. */
export function commandBasename(command?: string): string {
  const raw = command?.trim() ?? '';
  if (!raw) {
    return '';
  }
  const unquoted = raw.replace(/^["']|["']$/g, '').trim();
  const separator = Math.max(unquoted.lastIndexOf('\\'), unquoted.lastIndexOf('/'));
  return (separator >= 0 ? unquoted.slice(separator + 1) : unquoted).toLowerCase();
}

export function resolveCursorLineResizeMode(input: CursorLineResizeInput): CursorLineResizeMode {
  if (input.transport !== 'local') {
    // Remote shells are readline/zle/fish far more often than cmd, and a
    // wrong local reflow duplicates the prompt. Remote Windows shells can get
    // an explicit per-session override later.
    return 'shell-repaint';
  }

  const command = commandBasename(input.shellCommand);
  if (command === 'cmd' || command === 'cmd.exe') {
    return 'local-reflow';
  }
  if (command) {
    return 'shell-repaint';
  }

  // The default Windows PTY shell is cmd.exe; a Unix platform default is a
  // readline-family shell. An unknown backend must not assume reflow.
  return input.backend === 'conpty' || input.backend === 'winpty'
    ? 'local-reflow'
    : 'shell-repaint';
}
