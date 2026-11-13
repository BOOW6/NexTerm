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

const t = (key: string) => ({ 'session.subtitle.localShell': 'Local shell' })[key] ?? key;

describe('sessionSubtitle', () => {
  it('labels local sessions', () => {
    expect(sessionSubtitle(session({ kind: 'local' }), t)).toMatch(/shell$/);
    expect(sessionSubtitle(session({ kind: 'local', shellCommand: 'wsl.exe' }), t)).toBe('wsl');
    expect(sessionSubtitle(session({ kind: 'local', shellCommand: 'C:\\bin\\bash' }), t)).toBe(
      'bash'
    );
  });

  it('combines username, host and port for remote sessions', () => {
    expect(
      sessionSubtitle(session({ kind: 'ssh', username: 'root', host: 'example.com' }), t)
    ).toBe('root@example.com');
    expect(
      sessionSubtitle(
        session({ kind: 'sftp', username: 'root', host: 'example.com', port: 2222 }),
        t
      )
    ).toBe('root@example.com:2222');
  });

  it('handles a missing host', () => {
    expect(sessionSubtitle(session({ kind: 'ssh', username: 'root' }), t)).toBe('root@');
  });
});
