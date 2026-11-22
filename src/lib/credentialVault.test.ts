import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  forgetSessionCredentials,
  rememberSessionCredentials,
  retryPendingVaultDeletions
} from './credentialVault';
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

  it('reports and tombstones vault deletions that fail while locked', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'vault_status') {
        return { initialized: true, unlocked: false, entry_count: 3 };
      }
      if (command === 'vault_delete') {
        throw new Error('credential vault is locked');
      }
      return undefined;
    });

    const result = await forgetSessionCredentials('s1');

    // Regression: this used to be swallowed, leaving credentials on disk
    // with no trace after the session was gone.
    expect(result.removed).toEqual([]);
    expect(result.failed.sort()).toEqual([
      'session:s1:authorized',
      'session:s1:passphrase',
      'session:s1:password'
    ]);
    expect(JSON.parse(localStorage.getItem('nexterm.pendingVaultDeletes.v1') ?? '[]')).toEqual(
      expect.arrayContaining(['session:s1:password', 'session:s1:passphrase'])
    );
  });

  it('reports nothing stored when the vault was never initialized', async () => {
    useCredentialStore.getState().setPassword('s1', 'p');
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'vault_status') {
        return { initialized: false, unlocked: false, entry_count: 0 };
      }
      return undefined;
    });

    const result = await forgetSessionCredentials('s1');

    expect(result.failed).toEqual([]);
    expect(result.removed).toHaveLength(3);
    expect(invokeMock).not.toHaveBeenCalledWith('vault_delete', expect.anything());
    expect(localStorage.getItem('nexterm.pendingVaultDeletes.v1')).toBeNull();
  });

  it('clears tombstones on success and merges them across forgets', async () => {
    // First forget fails (vault locked).
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'vault_status') {
        return { initialized: true, unlocked: false, entry_count: 3 };
      }
      if (command === 'vault_delete') {
        throw new Error('credential vault is locked');
      }
      return undefined;
    });
    await forgetSessionCredentials('s1');

    // Second forget succeeds once unlocked.
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'vault_status') {
        return { initialized: true, unlocked: true, entry_count: 0 };
      }
      return undefined;
    });
    const result = await forgetSessionCredentials('s1');

    expect(result.failed).toEqual([]);
    expect(localStorage.getItem('nexterm.pendingVaultDeletes.v1')).toBeNull();
  });

  it('retries tombstoned deletions after unlock, keeping persistent failures', async () => {
    localStorage.setItem(
      'nexterm.pendingVaultDeletes.v1',
      JSON.stringify(['session:gone:password', 'session:gone:passphrase'])
    );
    invokeMock.mockImplementation(async (command: string, payload: { name: string }) => {
      if (command === 'vault_delete' && payload.name === 'session:gone:passphrase') {
        throw new Error('disk error');
      }
      return undefined;
    });

    const cleared = await retryPendingVaultDeletions();

    expect(cleared).toBe(1);
    expect(JSON.parse(localStorage.getItem('nexterm.pendingVaultDeletes.v1') ?? '[]')).toEqual([
      'session:gone:passphrase'
    ]);
  });
});
