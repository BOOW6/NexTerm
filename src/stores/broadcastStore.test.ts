import { beforeEach, describe, expect, it, vi } from 'vitest';

const writePtyMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const writeSshMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const writeTelnetMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../hooks/useTauriPty', () => ({ writePty: writePtyMock }));
vi.mock('../hooks/useTauriSsh', () => ({ writeSsh: writeSshMock }));
vi.mock('../hooks/useTauriTelnet', () => ({ writeTelnet: writeTelnetMock }));

import { broadcastCount, broadcastInput, useBroadcastStore } from './broadcastStore';
import { useConnectionStore, type ConnectionEntry } from './connectionStore';
import { useSessionStore } from './sessionStore';
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
  useBroadcastStore.setState({ ids: [] });
  useSessionStore.setState({ sessions: [] });
  useConnectionStore.setState({ connections: {} });
});

describe('broadcastStore.toggle', () => {
  it('joins and leaves; count only counts live sessions', () => {
    setSessions([makeSession({ id: 'a' }), makeSession({ id: 'b' })]);
    expect(useBroadcastStore.getState().toggle('a')).toBe(true);
    expect(useBroadcastStore.getState().toggle('b')).toBe(true);
    expect(broadcastCount()).toBe(2);

    useSessionStore.setState({
      sessions: [makeSession({ id: 'a' })] // b removed
    });
    expect(broadcastCount()).toBe(1);

    expect(useBroadcastStore.getState().toggle('a')).toBe(false);
    expect(useBroadcastStore.getState().ids).toEqual([]);
  });
});

describe('broadcastInput', () => {
  it('does nothing with fewer than two members', () => {
    setSessions([makeSession({ id: 'a' }), makeSession({ id: 'b' })]);
    useBroadcastStore.setState({ ids: ['a'] });
    broadcastInput('a', 'ls');
    expect(writeSshMock).not.toHaveBeenCalled();
  });

  it('does nothing when the source session is not a member', () => {
    setSessions([makeSession({ id: 'a' }), makeSession({ id: 'b' })]);
    useBroadcastStore.setState({ ids: ['a', 'b'] });
    broadcastInput('zzz', 'ls');
    expect(writeSshMock).not.toHaveBeenCalled();
  });

  it('writes to the other member via its latest live ssh id', () => {
    setSessions([makeSession({ id: 'a', kind: 'ssh' }), makeSession({ id: 'b', kind: 'ssh' })]);
    setConnection('b', { sshIds: ['conn-1', 'conn-2'] });
    useBroadcastStore.setState({ ids: ['a', 'b'] });
    broadcastInput('a', 'ls\r');
    expect(writeSshMock).toHaveBeenCalledExactlyOnceWith('conn-2', 'ls\r');
    expect(writePtyMock).not.toHaveBeenCalled();
  });

  it('skips disconnected and non-ssh targets appropriately', () => {
    setSessions([
      makeSession({ id: 'a', kind: 'ssh' }),
      makeSession({ id: 'b', kind: 'ssh', status: 'connecting' }),
      makeSession({ id: 'c', kind: 'local' }),
      makeSession({ id: 'd', kind: 'telnet' })
    ]);
    setConnection('c', { transports: [{ kind: 'pty', id: 'pty-1' }] });
    setConnection('d', { transports: [{ kind: 'telnet', id: 'tel-1' }] });
    useBroadcastStore.setState({ ids: ['a', 'b', 'c', 'd'] });

    broadcastInput('a', 'x');
    expect(writeSshMock).not.toHaveBeenCalled(); // b is connecting
    expect(writePtyMock).toHaveBeenCalledExactlyOnceWith('pty-1', 'x');
    expect(writeTelnetMock).toHaveBeenCalledExactlyOnceWith('tel-1', 'x');
  });

  it('never writes back to the source session', () => {
    setSessions([makeSession({ id: 'a', kind: 'local' }), makeSession({ id: 'b', kind: 'local' })]);
    setConnection('a', { transports: [{ kind: 'pty', id: 'pty-a' }] });
    setConnection('b', { transports: [{ kind: 'pty', id: 'pty-b' }] });
    useBroadcastStore.setState({ ids: ['a', 'b'] });

    broadcastInput('a', 'y');
    expect(writePtyMock).toHaveBeenCalledExactlyOnceWith('pty-b', 'y');
  });
});
