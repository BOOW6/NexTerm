import { describe, expect, it } from 'vitest';
import { sessionSubtitle, type Session } from './session';

function session(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    kind: 'ssh',
    title: 'Demo',
    group: 'Sessions',
    favorite: false,
    status: 'idle',
    createdAt: 0,
    lastUsed: 0,
    ...overrides
  };
}

describe('sessionSubtitle', () => {
  it('labels local sessions', () => {
    expect(sessionSubtitle(session({ kind: 'local' }))).toMatch(/Shell$/);
  });

  it('combines username, host and port for remote sessions', () => {
    expect(sessionSubtitle(session({ kind: 'ssh', username: 'root', host: 'example.com' }))).toBe(
      'root@example.com'
    );
    expect(
      sessionSubtitle(session({ kind: 'sftp', username: 'root', host: 'example.com', port: 2222 }))
    ).toBe('root@example.com:2222');
  });

  it('handles a missing host', () => {
    expect(sessionSubtitle(session({ kind: 'ssh', username: 'root' }))).toBe('root@');
  });
});
