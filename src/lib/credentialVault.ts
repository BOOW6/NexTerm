import { invoke } from '@tauri-apps/api/core';
import { useCredentialStore } from '../stores/credentialStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { Session } from '../types/session';

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  entry_count: number;
}

export type VaultField = 'password' | 'passphrase' | 'authorized';

export type VaultSaveResult = 'disabled' | 'locked' | 'uninitialized' | 'saved' | 'failed';

function vaultKey(sessionId: string, field: VaultField): string {
  return `session:${sessionId}:${field}`;
}

export async function getVaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>('vault_status');
}

export async function initializeVault(masterPassword: string): Promise<VaultStatus> {
  return invoke<VaultStatus>('vault_initialize', { masterPassword });
}

export async function unlockVault(masterPassword: string): Promise<boolean> {
  return invoke<boolean>('vault_unlock', { masterPassword });
}

export async function lockVault(): Promise<void> {
  await invoke('vault_lock');
}

export async function setVaultSecret(name: string, secret: string): Promise<void> {
  await invoke('vault_set', { name, secret });
}

export async function getVaultSecret(name: string): Promise<string | null> {
  return invoke<string | null>('vault_get', { name });
}

export async function deleteVaultSecret(name: string): Promise<void> {
  await invoke('vault_delete', { name });
}

export async function clearVault(): Promise<void> {
  await invoke('vault_clear');
}

export async function changeVaultPassword(
  oldPassword: string,
  newPassword: string
): Promise<VaultStatus> {
  return invoke<VaultStatus>('vault_change_password', { oldPassword, newPassword });
}

export async function resetVault(): Promise<void> {
  await invoke('vault_reset');
}

/** Save a session secret when "remember credentials" is enabled and unlocked. */
export async function saveSessionSecret(
  sessionId: string,
  field: VaultField,
  secret: string
): Promise<VaultSaveResult> {
  if (!useSettingsStore.getState().sshRememberCredentials) {
    return 'disabled';
  }
  try {
    const status = await getVaultStatus();
    if (!status.initialized) {
      return 'uninitialized';
    }
    if (!status.unlocked) {
      return 'locked';
    }
    await setVaultSecret(vaultKey(sessionId, field), secret);
    return 'saved';
  } catch {
    return 'failed';
  }
}

export async function forgetSessionCredentials(sessionId: string): Promise<void> {
  useCredentialStore.getState().clearCredentials(sessionId);
  await Promise.all([
    deleteVaultSecret(vaultKey(sessionId, 'password')).catch(() => undefined),
    deleteVaultSecret(vaultKey(sessionId, 'passphrase')).catch(() => undefined),
    deleteVaultSecret(vaultKey(sessionId, 'authorized')).catch(() => undefined)
  ]);
}

export async function rememberSessionCredentials(session: Session): Promise<VaultSaveResult[]> {
  if (!useSettingsStore.getState().sshRememberCredentials) {
    return ['disabled'];
  }
  const credentials = useCredentialStore.getState();
  const results: VaultSaveResult[] = [];

  if (session.authMethod === 'password') {
    const password = credentials.passwords[session.id];
    if (password) {
      results.push(await saveSessionSecret(session.id, 'password', password));
    }
  } else if (session.authMethod === 'key' || session.authMethod === 'certificate') {
    results.push(
      await saveSessionSecret(session.id, 'passphrase', credentials.passphrases[session.id] ?? '')
    );
    results.push(await saveSessionSecret(session.id, 'authorized', '1'));
  } else if (session.authMethod === 'agent') {
    results.push(await saveSessionSecret(session.id, 'authorized', '1'));
  }

  return results;
}

/**
 * Load every remembered credential into the in-memory store. Call this after
 * unlocking the vault so open/restored SSH tabs can connect without prompting.
 */
export async function hydrateCredentialsFromVault(): Promise<number> {
  if (!useSettingsStore.getState().sshRememberCredentials) {
    return 0;
  }
  const sessions = useSessionStore.getState().sessions;
  let restored = 0;

  for (const session of sessions) {
    if (session.kind === 'local') {
      continue;
    }
    try {
      const password = await getVaultSecret(vaultKey(session.id, 'password'));
      if (password !== null && useCredentialStore.getState().passwords[session.id] === undefined) {
        useCredentialStore.getState().setPassword(session.id, password);
        restored += 1;
      }
      const passphrase = await getVaultSecret(vaultKey(session.id, 'passphrase'));
      if (passphrase !== null && !(session.id in useCredentialStore.getState().passphrases)) {
        useCredentialStore.getState().setPassphrase(session.id, passphrase);
        restored += 1;
      }
      const authorized = await getVaultSecret(vaultKey(session.id, 'authorized'));
      if (authorized !== null && !useCredentialStore.getState().authorizations[session.id]) {
        useCredentialStore.getState().authorize(session.id);
        restored += 1;
      }
    } catch {
      /* locked or entry missing */
    }
  }

  return restored;
}
