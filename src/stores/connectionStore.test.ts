import { beforeEach, describe, expect, it } from 'vitest';
import { currentSshId, useConnectionStore } from './connectionStore';

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
