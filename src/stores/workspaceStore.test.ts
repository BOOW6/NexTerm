import { beforeEach, describe, expect, it } from 'vitest';
import { useConnectionStore } from './connectionStore';
import { useCredentialStore } from './credentialStore';
import { useUIStore } from './uiStore';
import { useWorkspaceStore } from './workspaceStore';

describe('workspace store', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeSessionId: null, sidebarVisible: true });
  });

  it('tracks the active session', () => {
    useWorkspaceStore.getState().setActiveSessionId('s1');
    expect(useWorkspaceStore.getState().activeSessionId).toBe('s1');
    useWorkspaceStore.getState().setActiveSessionId(null);
    expect(useWorkspaceStore.getState().activeSessionId).toBeNull();
  });

  it('toggles the sidebar', () => {
    useWorkspaceStore.getState().toggleSidebar();
    expect(useWorkspaceStore.getState().sidebarVisible).toBe(false);
    useWorkspaceStore.getState().toggleSidebar();
    expect(useWorkspaceStore.getState().sidebarVisible).toBe(true);
  });
});

describe('ui store', () => {
  beforeEach(() => {
    useUIStore.setState({ commandPaletteOpen: false });
  });

  it('opens and closes the command palette', () => {
    useUIStore.getState().openCommandPalette();
    expect(useUIStore.getState().commandPaletteOpen).toBe(true);
    useUIStore.getState().closeCommandPalette();
    expect(useUIStore.getState().commandPaletteOpen).toBe(false);
  });
});

describe('connection store', () => {
  beforeEach(() => {
    useConnectionStore.setState({ connections: {} });
  });

  it('accumulates connection entries per session and points at the newest', () => {
    useConnectionStore.getState().setConnection('s1', { sshId: 'a', status: 'connecting' });
    useConnectionStore.getState().setConnection('s1', { sshId: 'b', status: 'connected' });

    expect(useConnectionStore.getState().connections.s1).toEqual({
      sshIds: ['a', 'b'],
      status: 'connected'
    });
  });

  it('only removes an entry when the ssh id matches', () => {
    useConnectionStore.getState().setConnection('s1', { sshId: 'a', status: 'connected' });

    useConnectionStore.getState().removeConnection('s1', 'other');
    expect(useConnectionStore.getState().connections.s1).toBeDefined();

    useConnectionStore.getState().removeConnection('s1', 'a');
    expect(useConnectionStore.getState().connections.s1).toBeUndefined();
  });

  it('removes entries without requiring an ssh id', () => {
    useConnectionStore.getState().setConnection('s1', { sshId: 'a', status: 'error' });
    useConnectionStore.getState().removeConnection('s1');
    expect(useConnectionStore.getState().connections.s1).toBeUndefined();
  });
});

describe('credential store', () => {
  beforeEach(() => {
    useCredentialStore.setState({ passwords: {}, passphrases: {}, authorizations: {} });
  });

  it('stores passwords, passphrases and authorization flags', () => {
    useCredentialStore.getState().setPassword('s1', 'secret');
    useCredentialStore.getState().setPassphrase('s1', 'phrase');
    useCredentialStore.getState().authorize('s1');

    expect(useCredentialStore.getState().passwords.s1).toBe('secret');
    expect(useCredentialStore.getState().passphrases.s1).toBe('phrase');
    expect(useCredentialStore.getState().authorizations.s1).toBe(true);
  });

  it('clears every credential for a session', () => {
    useCredentialStore.getState().setPassword('s1', 'secret');
    useCredentialStore.getState().setPassphrase('s1', 'phrase');
    useCredentialStore.getState().authorize('s1');
    useCredentialStore.getState().setPassword('s2', 'other');

    useCredentialStore.getState().clearCredentials('s1');

    expect(useCredentialStore.getState().passwords).toEqual({ s2: 'other' });
    expect(useCredentialStore.getState().passphrases).toEqual({});
    expect(useCredentialStore.getState().authorizations).toEqual({});
  });
});
