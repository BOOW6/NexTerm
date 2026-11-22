import { beforeEach, describe, expect, it } from 'vitest';
import { currentSshId, transportIds, useConnectionStore } from './connectionStore';

const set = useConnectionStore.setState;

beforeEach(() => {
  set({ connections: {} });
});

describe('setConnection', () => {
  it('registers the first connection of a session', () => {
    useConnectionStore.getState().setConnection('sess-1', {
      sshId: 'ssh-1',
      status: 'connected'
    });

    const entry = useConnectionStore.getState().connections['sess-1'];
    expect(entry).toMatchObject({ sshIds: ['ssh-1'], status: 'connected' });
    expect(currentSshId(entry)).toBe('ssh-1');
  });

  it('keeps sibling split-pane connections and points at the newest one', () => {
    useConnectionStore.getState().setConnection('sess-1', {
      sshId: 'ssh-1',
      status: 'connected'
    });
    useConnectionStore.getState().setConnection('sess-1', {
      sshId: 'ssh-2',
      status: 'connected'
    });

    const entry = useConnectionStore.getState().connections['sess-1'];
    expect(entry.sshIds).toEqual(['ssh-1', 'ssh-2']);
    expect(currentSshId(entry)).toBe('ssh-2');
  });

  it('does not duplicate a re-registered sshId', () => {
    useConnectionStore.getState().setConnection('sess-1', { sshId: 'ssh-1', status: 'connected' });
    useConnectionStore.getState().setConnection('sess-1', { sshId: 'ssh-1', status: 'connected' });

    expect(useConnectionStore.getState().connections['sess-1'].sshIds).toEqual(['ssh-1']);
  });
});

describe('removeConnection', () => {
  it('removes one pane connection and keeps the session connected', () => {
    useConnectionStore.getState().setConnection('sess-1', { sshId: 'ssh-1', status: 'connected' });
    useConnectionStore.getState().setConnection('sess-1', { sshId: 'ssh-2', status: 'connected' });

    useConnectionStore.getState().removeConnection('sess-1', 'ssh-2');

    const entry = useConnectionStore.getState().connections['sess-1'];
    expect(entry).toMatchObject({ sshIds: ['ssh-1'], status: 'connected' });
    expect(currentSshId(entry)).toBe('ssh-1');
  });

  it('drops the entry once the last connection is gone', () => {
    useConnectionStore.getState().setConnection('sess-1', { sshId: 'ssh-1', status: 'connected' });

    useConnectionStore.getState().removeConnection('sess-1', 'ssh-1');

    expect(useConnectionStore.getState().connections['sess-1']).toBeUndefined();
  });

  it('ignores unknown sshIds instead of nuking the entry', () => {
    useConnectionStore.getState().setConnection('sess-1', { sshId: 'ssh-1', status: 'connected' });

    useConnectionStore.getState().removeConnection('sess-1', 'ssh-other');

    expect(useConnectionStore.getState().connections['sess-1']).toMatchObject({
      sshIds: ['ssh-1']
    });
  });

  it('clears the whole session when no sshId is given', () => {
    useConnectionStore.getState().setConnection('sess-1', { sshId: 'ssh-1', status: 'connected' });
    useConnectionStore.getState().setConnection('sess-1', { sshId: 'ssh-2', status: 'connected' });

    useConnectionStore.getState().removeConnection('sess-1');

    expect(useConnectionStore.getState().connections['sess-1']).toBeUndefined();
  });
});

describe('currentSshId', () => {
  it('returns undefined for missing entries and non-connected sessions', () => {
    expect(currentSshId(undefined)).toBeUndefined();
    expect(currentSshId({ sshIds: ['ssh-1'], status: 'error' })).toBeUndefined();
    expect(currentSshId({ sshIds: [], status: 'connected' })).toBeUndefined();
  });
});

describe('transports', () => {
  it('drops the whole entry once the last transport is removed', () => {
    const { addTransport, removeTransport } = useConnectionStore.getState();
    addTransport('sess-1', 'pty', 'pty-1');
    expect(useConnectionStore.getState().connections['sess-1']).toBeDefined();

    removeTransport('sess-1', 'pty', 'pty-1');

    // An empty shell would make `connections[id] === undefined` closed-session
    // checks never fire, leaving the session stuck on its previous status.
    expect(useConnectionStore.getState().connections['sess-1']).toBeUndefined();
  });

  it('keeps the entry while sibling transports remain', () => {
    const { addTransport, removeTransport } = useConnectionStore.getState();
    addTransport('sess-1', 'pty', 'pty-1');
    addTransport('sess-1', 'pty', 'pty-2');

    removeTransport('sess-1', 'pty', 'pty-1');

    const entry = useConnectionStore.getState().connections['sess-1'];
    expect(transportIds(entry, 'pty')).toEqual(['pty-2']);
    expect(entry?.status).toBe('connected');
  });

  it('tracks serial transports alongside pty and telnet', () => {
    const { addTransport } = useConnectionStore.getState();
    addTransport('sess-1', 'pty', 'pty-1');
    addTransport('sess-1', 'telnet', 'tel-1');
    addTransport('sess-1', 'serial', 'ser-1');

    const entry = useConnectionStore.getState().connections['sess-1'];
    expect(transportIds(entry, 'serial')).toEqual(['ser-1']);
    expect(transportIds(entry, 'pty')).toEqual(['pty-1']);
    expect(transportIds(entry, 'telnet')).toEqual(['tel-1']);
  });

  it('removes only the requested kind and keeps the entry alive', () => {
    const { addTransport, removeTransport } = useConnectionStore.getState();
    addTransport('sess-1', 'pty', 'pty-1');
    addTransport('sess-1', 'telnet', 'tel-1');

    removeTransport('sess-1', 'telnet', 'tel-1');

    const entry = useConnectionStore.getState().connections['sess-1'];
    expect(entry).toBeDefined();
    expect(transportIds(entry, 'pty')).toEqual(['pty-1']);
    expect(entry?.transports?.some((item) => item.kind === 'telnet')).toBe(false);
  });

  it('ignores unknown transport ids instead of dropping the entry', () => {
    const { addTransport, removeTransport } = useConnectionStore.getState();
    addTransport('sess-1', 'pty', 'pty-1');

    removeTransport('sess-1', 'pty', 'pty-other');

    expect(transportIds(useConnectionStore.getState().connections['sess-1'], 'pty')).toEqual([
      'pty-1'
    ]);
  });

  it('keeps the entry when an SSH id is removed but transports remain', () => {
    const store = useConnectionStore.getState();
    store.setConnection('sess-1', { sshId: 'ssh-1', status: 'connected' });
    store.addTransport('sess-1', 'pty', 'pty-1');

    store.removeConnection('sess-1', 'ssh-1');

    const entry = useConnectionStore.getState().connections['sess-1'];
    expect(entry?.sshIds).toEqual([]);
    expect(transportIds(entry, 'pty')).toEqual(['pty-1']);

    store.removeTransport('sess-1', 'pty', 'pty-1');
    expect(useConnectionStore.getState().connections['sess-1']).toBeUndefined();
  });

  it('preserves transports when re-registering an SSH connection', () => {
    const store = useConnectionStore.getState();
    store.addTransport('sess-1', 'pty', 'pty-1');

    store.setConnection('sess-1', { sshId: 'ssh-1', status: 'connected' });

    const entry = useConnectionStore.getState().connections['sess-1'];
    expect(entry?.sshIds).toEqual(['ssh-1']);
    expect(transportIds(entry, 'pty')).toEqual(['pty-1']);
  });
});
