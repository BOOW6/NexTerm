import { MAX_RECONNECT_ATTEMPTS } from './terminalReconnect';

/** What the end state is showing: a clean or user-initiated end, a lost
 * connection with no auto-reconnect coming, a scheduled reconnect (with a
 * live countdown), or a reconnect ladder that gave up. Terminal kinds render
 * an in-buffer block plus keyboard shortcuts; `reconnecting` renders the
 * floating countdown chip. */
export type SessionEndBarKind = 'ended' | 'dropped' | 'reconnecting' | 'exhausted';

export interface SessionEndBarState {
  kind: SessionEndBarKind;
  /** i18n key of the main message. */
  messageKey: string;
  /** i18n params for the message key. */
  messageParams?: Record<string, string | number>;
  /** Epoch ms at which the next reconnect fires; only for 'reconnecting'. */
  deadline?: number;
}

export type SessionEndAction =
  'reconnect' | 'reconnectNow' | 'cancelReconnect' | 'closeTab' | 'saveOutput';

const reconnectingActions: SessionEndAction[] = ['reconnectNow', 'cancelReconnect'];

/** Chip buttons only exist while the ladder is live; terminal states act
 * through the keyboard shortcuts and the tab menu instead. */
export function sessionEndActions(kind: SessionEndBarKind): SessionEndAction[] {
  return kind === 'reconnecting' ? reconnectingActions : [];
}

/** Keyboard actions while an end state is showing (MobaXterm-style single
 * keys): R reconnects, Enter closes the tab, S saves the output, Escape
 * cancels a live ladder. Letter keys match case-insensitively; callers must
 * reject modifier combos and IME composition before asking. */
export function sessionEndShortcutAction(
  kind: SessionEndBarKind,
  key: string
): SessionEndAction | null {
  if (key === 'Escape') {
    return kind === 'reconnecting' ? 'cancelReconnect' : null;
  }
  if (key === 'Enter') {
    // Closing during a live retry window on a stray Enter is too costly;
    // closing stays a terminal-state action.
    return kind === 'reconnecting' ? null : 'closeTab';
  }
  const lower = key.toLowerCase();
  if (lower === 'r') {
    return kind === 'reconnecting' ? 'reconnectNow' : 'reconnect';
  }
  if (lower === 's') {
    return kind === 'reconnecting' ? null : 'saveOutput';
  }
  return null;
}

/** Whole seconds left before the scheduled reconnect fires, never negative:
 * the timeout may already be due while the UI ticks. */
export function remainingSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Structural copies of the backend closed payloads, kept local so this
 * module stays decoupled from the hooks layer. */
export interface SshClosedLike {
  reason: 'exit' | 'dropped';
  exit_status?: number | null;
}

export interface RemoteClosedLike {
  reason: 'closed' | 'eof' | 'error';
  message?: string | null;
}

function ended(messageKey: string, params?: Record<string, string | number>): SessionEndBarState {
  return { kind: 'ended', messageKey, messageParams: params };
}

function dropped(messageKey: string, params?: Record<string, string | number>): SessionEndBarState {
  return { kind: 'dropped', messageKey, messageParams: params };
}

/** Live reconnect countdown: the chip ticks locally from the deadline instead
 * of writing one buffer line per attempt. */
export function endBarReconnecting(
  reason: string,
  attempt: number,
  delayMs: number,
  now = Date.now()
): SessionEndBarState {
  return {
    kind: 'reconnecting',
    messageKey: 'terminal.endBarReconnecting',
    messageParams: {
      reason,
      seconds: remainingSeconds(now + delayMs, now),
      attempt,
      max: MAX_RECONNECT_ATTEMPTS
    },
    deadline: now + delayMs
  };
}

export function endBarExhausted(): SessionEndBarState {
  return { kind: 'exhausted', messageKey: 'terminal.reconnectExhausted' };
}

export function endBarDropped(
  messageKey: string,
  params?: Record<string, string | number>
): SessionEndBarState {
  return dropped(messageKey, params);
}

export function localExitEndBar(exitStatus?: number | null): SessionEndBarState {
  if (typeof exitStatus === 'number') {
    return ended('terminal.endBarLocalExitedWithCode', { code: exitStatus });
  }
  return ended('terminal.localShellExited');
}

export function sshExitEndBar(closed: SshClosedLike): SessionEndBarState {
  if (typeof closed.exit_status === 'number') {
    return ended('terminal.sshSessionEndedWithCode', { code: closed.exit_status });
  }
  return ended('terminal.sshSessionEnded');
}

export function telnetCloseEndBar(closed: RemoteClosedLike): SessionEndBarState {
  if (closed.reason === 'error' && closed.message) {
    return dropped('terminal.telnetLost', { message: closed.message });
  }
  return closed.reason === 'closed'
    ? ended('terminal.telnetDisconnected')
    : dropped('terminal.telnetDisconnected');
}

export function serialCloseEndBar(closed: RemoteClosedLike): SessionEndBarState {
  if (closed.reason === 'error' && closed.message) {
    return dropped('terminal.serialLost', { message: closed.message });
  }
  // Serial has no reconnect ladder and the peer never says goodbye cleanly:
  // a vanished adapter is an error even when the reason is only 'eof'.
  return ended('terminal.serialDisconnected');
}

/**
 * The in-buffer end-state block, MobaXterm style: a dim separator, the
 * message, and dim keyboard hints. Pure formatting so tests can pin the
 * escape sequences. `tone` picks the message color: warn (yellow) for
 * losses, default for clean exits.
 */
export function endBlockText(
  message: string,
  hints: string,
  cols: number,
  tone: 'default' | 'warn'
): string {
  const width = Math.max(20, cols || 80);
  const separator = `\x1b[2m${'─'.repeat(width)}\x1b[22m`;
  const messageLine = tone === 'warn' ? `\x1b[33m${message}\x1b[39m` : message;
  return `${separator}\r\n${messageLine}\r\n\x1b[2m${hints}\x1b[22m`;
}
