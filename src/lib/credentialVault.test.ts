import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { forgetSessionCredentials, rememberSessionCredentials } from './credentialVault';
import { useCredentialStore } from '../stores/credentialStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { Session } from '../types/session';

const SSH_SESSION: Session = {
  id: 's1',
  kind: 'ssh',
  title: 'prod',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  group: 'prod',
  favorite: false,
  status: 'idle',
  createdAt: 1,
  lastUsed: 2
};

describe('credentialVault', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
    const credentials = useCredentialStore.getState();
    credentials.clearCredentials('s1');
    useSettingsStore.setState({ sshRememberCredentials: true });
  });

  it('sends secrets only to the vault IPC, never into localStorage', async () => {
    const secret = 'sup3r-secret-!';
    useCredentialStore.getState().setPassword('s1', secret);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'vault_status') {
        return { initialized: true, unlocked: true, entry_count: 0 };
      }
      return undefined;
    });

    const results = await rememberSessionCredentials(SSH_SESSION);

    expect(results).toEqual(['saved']);
    expect(invokeMock).toHaveBeenCalledWith(
      'vault_set',
      expect.objectContaining({ name: 'session:s1:password' })
    );
    // Regression guard: password material must not leak into any persisted
    // window.localStorage value (session store, snapshots, …).
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key === null) {
        continue;
      }
      expect(localStorage.getItem(key)).not.toContain(secret);
    }
  });

  it('forget clears the in-memory store and deletes every vault field', async () => {
    const credentials = useCredentialStore.getState();
    credentials.setPassword('s1', 'p');
    credentials.setPassphrase('s1', 'q');
    credentials.authorize('s1');
    invokeMock.mockResolvedValue(undefined);

    await forgetSessionCredentials('s1');

    const next = useCredentialStore.getState();
    expect(next.passwords['s1']).toBeUndefined();
    expect(next.passphrases['s1']).toBeUndefined();
    expect(next.authorizations['s1']).toBeFalsy();

    const deleted = invokeMock.mock.calls
      .filter(([command]) => command === 'vault_delete')
      .map(([, payload]) => (payload as { name: string }).name);
    expect(deleted).toEqual(
      expect.arrayContaining([
        'session:s1:password',
        'session:s1:passphrase',
        'session:s1:authorized'
      ])
    );
  });

  it('skips saving when remembering credentials is disabled', async () => {
    useSettingsStore.setState({ sshRememberCredentials: false });
    useCredentialStore.getState().setPassword('s1', 'p');

    const results = await rememberSessionCredentials(SSH_SESSION);

    expect(results).toEqual(['disabled']);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
