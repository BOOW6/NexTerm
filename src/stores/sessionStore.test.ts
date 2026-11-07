import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GROUP, SESSION_KIND_LABEL, type Session } from '../types/session';
import { useSessionStore } from './sessionStore';

const STORAGE_KEY = 'nexterm.sessions.v1';

function resetStore(): void {
  useSessionStore.setState({ sessions: [] });
}

function storedSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'saved-1',
    kind: 'ssh',
    title: 'Saved',
    host: 'example.com',
    port: 22,
    username: 'root',
    authMethod: 'password',
    group: DEFAULT_GROUP,
    favorite: false,
    status: 'connected',
    createdAt: 1,
    lastUsed: 2,
    ...overrides
  };
}

beforeEach(resetStore);

describe('addSession', () => {
  it('creates a session with generated metadata', () => {
    const created = useSessionStore.getState().addSession({
      kind: 'ssh',
      title: '  Prod  ',
      host: '  example.com ',
      port: 2222,
      username: ' root ',
      group: ' Servers ',
      favorite: true
    });

    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created).toMatchObject({
      kind: 'ssh',
      title: 'Prod',
      host: 'example.com',
      port: 2222,
      username: 'root',
      authMethod: 'password',
      group: 'Servers',
      favorite: true,
      status: 'idle'
    });
    expect(created.createdAt).toBeGreaterThan(0);
    expect(useSessionStore.getState().sessions).toEqual([created]);
  });

  it('falls back to the kind label and default group', () => {
    const created = useSessionStore.getState().addSession({
      kind: 'sftp',
      title: '   ',
      host: '',
      group: ''
    });

    expect(created.title).toBe(SESSION_KIND_LABEL.sftp);
    expect(created.group).toBe(DEFAULT_GROUP);
    expect(created.host).toBeUndefined();
  });

  it('strips network fields from local sessions', () => {
    const created = useSessionStore.getState().addSession({
      kind: 'local',
      title: 'Shell',
      host: 'ignored',
      port: 22,
      username: 'ignored',
      authMethod: 'key',
      keyPath: 'ignored',
      group: 'Local'
    });

    expect(created.host).toBeUndefined();
    expect(created.port).toBeUndefined();
    expect(created.username).toBeUndefined();
    expect(created.authMethod).toBeUndefined();
    expect(created.keyPath).toBeUndefined();
  });
});

describe('updateSession', () => {
  it('merges patches and normalizes text fields', () => {
    const created = useSessionStore.getState().addSession({
      kind: 'ssh',
      title: 'Prod',
      host: 'old.example.com',
      username: 'root',
      group: 'Servers'
    });

    useSessionStore.getState().updateSession(created.id, {
      title: '  ',
      host: ' new.example.com ',
      username: '  ',
      keyPath: '  ~/.ssh/id_ed25519 '
    });

    const updated = useSessionStore.getState().getSession(created.id)!;
    expect(updated.title).toBe(SESSION_KIND_LABEL.ssh);
    expect(updated.host).toBe('new.example.com');
    // A whitespace-only username is an explicit clear, not a fallback.
    expect(updated.username).toBeUndefined();
    expect(updated.keyPath).toBe('~/.ssh/id_ed25519');

    // A patch that omits the field keeps the stored value.
    useSessionStore.getState().updateSession(created.id, { username: 'deploy' });
    useSessionStore.getState().updateSession(created.id, { host: 'third.example.com' });
    expect(useSessionStore.getState().getSession(created.id)!.username).toBe('deploy');
  });

  it('clears network fields when converting to a local session', () => {
    const created = useSessionStore.getState().addSession({
      kind: 'ssh',
      title: 'Prod',
      host: 'example.com',
      port: 22,
      username: 'root',
      group: 'Servers'
    });

    useSessionStore.getState().updateSession(created.id, { kind: 'local' });

    const updated = useSessionStore.getState().getSession(created.id)!;
    expect(updated.kind).toBe('local');
    expect(updated.host).toBeUndefined();
    expect(updated.port).toBeUndefined();
    expect(updated.username).toBeUndefined();
    expect(updated.authMethod).toBeUndefined();
  });

  it('leaves other sessions untouched', () => {
    const first = useSessionStore.getState().addSession({
      kind: 'local',
      title: 'One',
      group: 'G'
    });
    const second = useSessionStore.getState().addSession({
      kind: 'local',
      title: 'Two',
      group: 'G'
    });

    useSessionStore.getState().updateSession(first.id, { title: 'Renamed' });

    expect(useSessionStore.getState().getSession(second.id)?.title).toBe('Two');
  });
});

describe('session lifecycle helpers', () => {
  it('toggles favorites and marks sessions as used', () => {
    const created = useSessionStore.getState().addSession({
      kind: 'local',
      title: 'One',
      group: 'G'
    });
    const firstUsed = useSessionStore.getState().getSession(created.id)!.lastUsed;

    useSessionStore.getState().toggleFavorite(created.id);
    expect(useSessionStore.getState().getSession(created.id)?.favorite).toBe(true);
    useSessionStore.getState().toggleFavorite(created.id);
    expect(useSessionStore.getState().getSession(created.id)?.favorite).toBe(false);

    useSessionStore.getState().markUsed(created.id);
    expect(useSessionStore.getState().getSession(created.id)!.lastUsed).toBeGreaterThanOrEqual(
      firstUsed
    );
  });

  it('updates status and removes sessions', () => {
    const created = useSessionStore.getState().addSession({
      kind: 'local',
      title: 'One',
      group: 'G'
    });

    useSessionStore.getState().setStatus(created.id, 'connected');
    expect(useSessionStore.getState().getSession(created.id)?.status).toBe('connected');

    useSessionStore.getState().removeSession(created.id);
    expect(useSessionStore.getState().sessions).toHaveLength(0);
  });

  it('ensureDefaultSession reuses the first session or creates a local one', () => {
    const created = useSessionStore.getState().ensureDefaultSession();
    expect(created.kind).toBe('local');
    expect(useSessionStore.getState().sessions).toHaveLength(1);

    const again = useSessionStore.getState().ensureDefaultSession();
    expect(again.id).toBe(created.id);
    expect(useSessionStore.getState().sessions).toHaveLength(1);
  });
});

describe('jumpSessionId', () => {
  it('is stored on add and cleared with an empty string on update', () => {
    const jump = useSessionStore.getState().addSession({
      kind: 'ssh',
      title: 'Bastion',
      host: 'bastion.example.com',
      group: DEFAULT_GROUP
    });
    const created = useSessionStore.getState().addSession({
      kind: 'ssh',
      title: 'Target',
      host: 'target.example.com',
      jumpSessionId: jump.id,
      group: DEFAULT_GROUP
    });
    expect(created.jumpSessionId).toBe(jump.id);

    // Omitting the field keeps the old value.
    useSessionStore.getState().updateSession(created.id, { title: 'Target2' });
    expect(useSessionStore.getState().getSession(created.id)?.jumpSessionId).toBe(jump.id);

    // An explicit empty string clears it.
    useSessionStore.getState().updateSession(created.id, { jumpSessionId: '' });
    expect(useSessionStore.getState().getSession(created.id)?.jumpSessionId).toBeUndefined();
  });
});

describe('persistence', () => {
  it('resets transient connection status when rehydrating', async () => {
    useSessionStore.setState({ sessions: [] });
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { sessions: [storedSession()] },
        version: 1
      })
    );

    await useSessionStore.persist.rehydrate();

    const sessions = useSessionStore.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('idle');
    expect(sessions[0].host).toBe('example.com');
  });
});
