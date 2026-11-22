import { beforeEach, describe, expect, it, vi } from 'vitest';

const writePtyMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const writeSshMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const writeTelnetMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const writeSerialMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../hooks/useTauriPty', () => ({ writePty: writePtyMock }));
vi.mock('../hooks/useTauriSsh', () => ({ writeSsh: writeSshMock }));
vi.mock('../hooks/useTauriTelnet', () => ({ writeTelnet: writeTelnetMock }));
vi.mock('../hooks/useTauriSerial', () => ({ writeSerial: writeSerialMock }));

import { replayMacro, writeToSession } from './terminalWrite';
import { useConnectionStore, type ConnectionEntry } from '../stores/connectionStore';
import { useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types/session';

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    kind: 'ssh',
    title: 'S1',
    group: 'g',
    favorite: false,
    status: 'connected',
    createdAt: 0,
    lastUsed: 0,
    ...overrides
  };
}

function setSessions(sessions: Session[]): void {
  useSessionStore.setState({ sessions });
}

function setConnection(sessionId: string, entry: Partial<ConnectionEntry>): void {
  useConnectionStore.setState((state) => ({
    connections: {
      ...state.connections,
      [sessionId]: { sshIds: [], status: 'connected', ...entry }
    }
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState({ sessions: [] });
  useConnectionStore.setState({ connections: {} });
});

describe('writeToSession', () => {
  it('routes SSH sessions to their most recent live ssh id', () => {
    setSessions([makeSession({ id: 'a', kind: 'ssh' })]);
    setConnection('a', { sshIds: ['conn-1', 'conn-2'] });

    expect(writeToSession('a', 'ls\r')).toBe(true);
    expect(writeSshMock).toHaveBeenCalledExactlyOnceWith('conn-2', 'ls\r');
    expect(writePtyMock).not.toHaveBeenCalled();
  });

  it('writes to every pty transport of a local session', () => {
    setSessions([makeSession({ id: 'a', kind: 'local' })]);
    setConnection('a', {
      transports: [
        { kind: 'pty', id: 'pty-1' },
        { kind: 'pty', id: 'pty-2' }
      ]
    });

    expect(writeToSession('a', 'x')).toBe(true);
    expect(writePtyMock).toHaveBeenCalledTimes(2);
    expect(writePtyMock).toHaveBeenCalledWith('pty-1', 'x');
    expect(writePtyMock).toHaveBeenCalledWith('pty-2', 'x');
  });

  it('writes to telnet transports', () => {
    setSessions([makeSession({ id: 'a', kind: 'telnet' })]);
    setConnection('a', { transports: [{ kind: 'telnet', id: 'tel-1' }] });

    expect(writeToSession('a', 'x')).toBe(true);
    expect(writeTelnetMock).toHaveBeenCalledExactlyOnceWith('tel-1', 'x');
  });

  it('writes to serial transports', () => {
    // Regression: serial sessions used to be absent here, so broadcast
    // input and macro replay silently did nothing for them.
    setSessions([makeSession({ id: 'a', kind: 'serial' })]);
    setConnection('a', { transports: [{ kind: 'serial', id: 'ser-1' }] });

    expect(writeToSession('a', 'x')).toBe(true);
    expect(writeSerialMock).toHaveBeenCalledExactlyOnceWith('ser-1', 'x');
  });

  it('returns false without writing for missing or non-connected sessions', () => {
    setSessions([makeSession({ id: 'a', kind: 'local', status: 'connecting' })]);
    expect(writeToSession('a', 'x')).toBe(false);
    expect(writeToSession('missing', 'x')).toBe(false);
    expect(writePtyMock).not.toHaveBeenCalled();
    expect(writeSshMock).not.toHaveBeenCalled();
  });

  it('returns false for an SSH session without a live ssh id', () => {
    setSessions([makeSession({ id: 'a', kind: 'ssh' })]);
    setConnection('a', { sshIds: [], status: 'connected' });

    expect(writeToSession('a', 'x')).toBe(false);
    expect(writeSshMock).not.toHaveBeenCalled();
  });

  it('swallows transport write failures and still reports a write', () => {
    setSessions([makeSession({ id: 'a', kind: 'serial' })]);
    setConnection('a', { transports: [{ kind: 'serial', id: 'ser-1' }] });
    writeSerialMock.mockReturnValueOnce(Promise.reject(new Error('gone')));

    expect(writeToSession('a', 'x')).toBe(true);
  });
});

describe('replayMacro', () => {
  it('writes steps in order, honoring per-step delays', async () => {
    vi.useFakeTimers();
    try {
      setSessions([makeSession({ id: 'a', kind: 'local' })]);
      setConnection('a', { transports: [{ kind: 'pty', id: 'pty-1' }] });

      const done = replayMacro('a', [
        { data: 'a', delayMs: 0 },
        { data: 'b', delayMs: 50 },
        { data: 'c', delayMs: 10 }
      ]);

      expect(writePtyMock).toHaveBeenNthCalledWith(1, 'pty-1', 'a');
      await vi.advanceTimersByTimeAsync(50);
      expect(writePtyMock).toHaveBeenNthCalledWith(2, 'pty-1', 'b');
      await vi.advanceTimersByTimeAsync(10);
      expect(writePtyMock).toHaveBeenNthCalledWith(3, 'pty-1', 'c');
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});
