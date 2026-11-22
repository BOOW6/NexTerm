import { describe, expect, it } from 'vitest';
import {
  endBarDropped,
  endBarExhausted,
  endBarReconnecting,
  endBlockText,
  localExitEndBar,
  remainingSeconds,
  serialCloseEndBar,
  sessionEndActions,
  sessionEndShortcutAction,
  sshExitEndBar,
  telnetCloseEndBar
} from './terminalEndState';
import { MAX_RECONNECT_ATTEMPTS } from './terminalReconnect';

describe('terminalEndState', () => {
  it('shows the exit code for a local shell that reported one', () => {
    const bar = localExitEndBar(0);
    expect(bar.kind).toBe('ended');
    expect(bar.messageKey).toBe('terminal.endBarLocalExitedWithCode');
    expect(bar.messageParams).toEqual({ code: 0 });
    expect(localExitEndBar(3221225786).messageParams).toEqual({ code: 3221225786 });
  });

  it('falls back to a plain notice when the exit code is unknown', () => {
    const bar = localExitEndBar(null);
    expect(bar.kind).toBe('ended');
    expect(bar.messageKey).toBe('terminal.localShellExited');
    expect(bar.messageParams).toBeUndefined();
  });

  it('reports the remote exit code for SSH exit', () => {
    expect(sshExitEndBar({ reason: 'exit', exit_status: 1 }).messageKey).toBe(
      'terminal.sshSessionEndedWithCode'
    );
    expect(sshExitEndBar({ reason: 'exit', exit_status: null }).messageKey).toBe(
      'terminal.sshSessionEnded'
    );
    expect(sshExitEndBar({ reason: 'exit' }).kind).toBe('ended');
  });

  it('maps telnet closes: user close ends, errors carry the message', () => {
    expect(telnetCloseEndBar({ reason: 'closed' })).toMatchObject({
      kind: 'ended',
      messageKey: 'terminal.telnetDisconnected'
    });
    expect(telnetCloseEndBar({ reason: 'eof' })).toMatchObject({
      kind: 'dropped',
      messageKey: 'terminal.telnetDisconnected'
    });
    expect(telnetCloseEndBar({ reason: 'error', message: 'reset by peer' })).toMatchObject({
      kind: 'dropped',
      messageKey: 'terminal.telnetLost',
      messageParams: { message: 'reset by peer' }
    });
    expect(telnetCloseEndBar({ reason: 'error' }).messageKey).toBe('terminal.telnetDisconnected');
  });

  it('maps serial closes and never offers a reconnect ladder', () => {
    expect(serialCloseEndBar({ reason: 'closed' })).toMatchObject({
      kind: 'ended',
      messageKey: 'terminal.serialDisconnected'
    });
    expect(serialCloseEndBar({ reason: 'eof' }).kind).toBe('ended');
    expect(serialCloseEndBar({ reason: 'error', message: 'device removed' })).toMatchObject({
      kind: 'dropped',
      messageKey: 'terminal.serialLost',
      messageParams: { message: 'device removed' }
    });
    // Terminal states act through keyboard shortcuts, not chip buttons.
    for (const reason of ['closed', 'eof', 'error'] as const) {
      expect(sessionEndActions(serialCloseEndBar({ reason }).kind)).toEqual([]);
    }
  });

  it('builds the reconnecting countdown with the shared attempt ceiling', () => {
    const now = 1_000_000;
    const bar = endBarReconnecting('SSH 连接已断开', 2, 4_000, now);
    expect(bar.kind).toBe('reconnecting');
    expect(bar.messageKey).toBe('terminal.endBarReconnecting');
    expect(bar.messageParams).toEqual({
      reason: 'SSH 连接已断开',
      seconds: 4,
      attempt: 2,
      max: MAX_RECONNECT_ATTEMPTS
    });
    expect(bar.deadline).toBe(now + 4_000);
  });

  it('ticks the countdown down and never goes negative', () => {
    const deadline = 10_000;
    expect(remainingSeconds(deadline, 8_500)).toBe(2);
    expect(remainingSeconds(deadline, 9_999)).toBe(1);
    expect(remainingSeconds(deadline, deadline)).toBe(0);
    expect(remainingSeconds(deadline, deadline + 60_000)).toBe(0);
  });

  it('exposes the exhausted state with the generic message', () => {
    const bar = endBarExhausted();
    expect(bar.kind).toBe('exhausted');
    expect(bar.messageKey).toBe('terminal.reconnectExhausted');
    expect(sessionEndActions(bar.kind)).toEqual([]);
  });

  it('offers chip buttons only while the ladder is live', () => {
    for (const kind of ['ended', 'dropped', 'exhausted'] as const) {
      expect(sessionEndActions(kind)).toEqual([]);
    }
    expect(sessionEndActions('reconnecting')).toEqual(['reconnectNow', 'cancelReconnect']);
  });

  it('maps end-state keyboard shortcuts per kind', () => {
    // R reconnects everywhere; during a live ladder it skips the countdown.
    expect(sessionEndShortcutAction('ended', 'r')).toBe('reconnect');
    expect(sessionEndShortcutAction('dropped', 'R')).toBe('reconnect');
    expect(sessionEndShortcutAction('exhausted', 'r')).toBe('reconnect');
    expect(sessionEndShortcutAction('reconnecting', 'r')).toBe('reconnectNow');

    // Enter closes the tab, but never while a retry is scheduled.
    expect(sessionEndShortcutAction('ended', 'Enter')).toBe('closeTab');
    expect(sessionEndShortcutAction('dropped', 'Enter')).toBe('closeTab');
    expect(sessionEndShortcutAction('reconnecting', 'Enter')).toBeNull();

    // Escape cancels a live ladder and does nothing otherwise.
    expect(sessionEndShortcutAction('reconnecting', 'Escape')).toBe('cancelReconnect');
    expect(sessionEndShortcutAction('ended', 'Escape')).toBeNull();

    // S saves the output; it is a terminal-state action.
    expect(sessionEndShortcutAction('ended', 's')).toBe('saveOutput');
    expect(sessionEndShortcutAction('dropped', 'S')).toBe('saveOutput');
    expect(sessionEndShortcutAction('reconnecting', 's')).toBeNull();

    // Everything else passes through.
    expect(sessionEndShortcutAction('ended', 'x')).toBeNull();
    expect(sessionEndShortcutAction('ended', 'ArrowUp')).toBeNull();
    expect(sessionEndShortcutAction('reconnecting', 'ArrowUp')).toBeNull();
  });

  it('formats the in-buffer end block with dim separator, message and hints', () => {
    const block = endBlockText('本地 Shell 已退出', '按 R 重连', 40, 'default');
    expect(block).toBe(
      `\x1b[2m${'─'.repeat(40)}\x1b[22m\r\n本地 Shell 已退出\r\n\x1b[2m按 R 重连\x1b[22m`
    );
    // Losses paint the message yellow; the separator and hints stay dim.
    const warned = endBlockText('SSH 连接已断开', '提示', 80, 'warn');
    expect(warned).toContain('\x1b[33mSSH 连接已断开\x1b[39m');
    expect(warned.startsWith(`\x1b[2m${'─'.repeat(80)}\x1b[22m\r\n`)).toBe(true);
  });

  it('keeps a sane block width for tiny or missing grids', () => {
    expect(endBlockText('m', 'h', 0, 'default')).toContain('─'.repeat(80));
    expect(endBlockText('m', 'h', 5, 'default')).toContain('─'.repeat(20));
  });

  it('keeps the dropped factory honest about its kind', () => {
    const bar = endBarDropped('terminal.sshDisconnected');
    expect(bar.kind).toBe('dropped');
    expect(bar.messageKey).toBe('terminal.sshDisconnected');
  });
});
