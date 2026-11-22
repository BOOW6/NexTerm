import { invoke } from '@tauri-apps/api/core';
import { isSshBackedSession } from './sessionVisuals';
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

export async function resetVault(masterPassword: string): Promise<void> {
  await invoke('vault_reset', { masterPassword });
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

const PENDING_DELETES_KEY = 'nexterm.pendingVaultDeletes.v1';

function readPendingDeletes(): string[] {
  try {
    const raw = window.localStorage.getItem(PENDING_DELETES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function writePendingDeletes(names: string[]): void {
  try {
    if (names.length === 0) {
      window.localStorage.removeItem(PENDING_DELETES_KEY);
    } else {
      window.localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(names));
    }
  } catch {
    // Storage unavailable: the tombstone list stays best-effort.
  }
}

export interface ForgetResult {
  /** Vault keys that were removed (or never existed). */
  removed: string[];
  /** Vault keys that could not be removed because the vault was locked or
   * errored. They are tombstoned and retried after the next unlock, but the
   * caller must report them: the stored credentials still exist on disk. */
  failed: string[];
}

/**
 * Remove every stored credential of a session: the in-memory copies always,
 * the vault entries best-effort. Vault failures used to be swallowed here,
 * which left credentials on disk with no trace after the session was gone.
 * Failed keys are tombstoned (persisted) and retried by
 * `retryPendingVaultDeletions` after the next successful unlock, and the
 * returned `failed` list lets the caller tell the user.
 */
export async function forgetSessionCredentials(sessionId: string): Promise<ForgetResult> {
  useCredentialStore.getState().clearCredentials(sessionId);

  const names = (['password', 'passphrase', 'authorized'] as const).map((field) =>
    vaultKey(sessionId, field)
  );

  // A vault that was never initialized cannot hold any credential for this
  // session, so there is nothing left behind to report.
  let status: VaultStatus | undefined;
  try {
    status = await getVaultStatus();
  } catch {
    // Status probe failed: fall through and attempt the deletes anyway.
  }
  if (status && !status.initialized) {
    writePendingDeletes(readPendingDeletes().filter((name) => !names.includes(name)));
    return { removed: [...names], failed: [] };
  }

  const removed: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    names.map(async (name) => {
      try {
        await deleteVaultSecret(name);
        removed.push(name);
      } catch {
        failed.push(name);
      }
    })
  );

  // Tombstone only what still exists: a stale tombstone for a key that was
  // meanwhile deleted resolves on the next retry (deleting a missing key
  // succeeds).
  const pending = [...new Set([...readPendingDeletes(), ...failed])].filter(
    (name) => !removed.includes(name)
  );
  writePendingDeletes(pending);
  return { removed, failed };
}

/**
 * Retry tombstoned credential deletions after the vault was unlocked.
 * Returns how many pending keys were cleared. Safe to call from any window:
 * deletions are idempotent, and the tombstone list is shared localStorage.
 */
export async function retryPendingVaultDeletions(): Promise<number> {
  const pending = readPendingDeletes();
  if (pending.length === 0) {
    return 0;
  }
  const remaining: string[] = [];
  let cleared = 0;
  for (const name of pending) {
    try {
      await deleteVaultSecret(name);
      cleared += 1;
    } catch {
      remaining.push(name);
    }
  }
  writePendingDeletes(remaining);
  return cleared;
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
    // Strict SSH-backed check: telnet/serial never store vault entries,
    // so hydrating them would only produce guaranteed misses.
    if (!isSshBackedSession(session.kind)) {
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
