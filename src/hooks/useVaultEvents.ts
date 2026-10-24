import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { hydrateCredentialsFromVault } from '../lib/credentialVault';
import { useCredentialStore } from '../stores/credentialStore';
import { useVaultStore } from '../stores/vaultStore';

/**
 * Keep the main window's in-memory credentials in sync when the vault is
 * unlocked/locked from the settings window (a separate JS context).
 */
export function useVaultEvents(): void {
  useEffect(() => {
    void useVaultStore.getState().refresh();

    const subscriptions = [
      listen('nexterm-vault-unlocked', () => {
        void hydrateCredentialsFromVault().then(() => useVaultStore.getState().refresh());
      }).catch(() => null),
      listen('nexterm-vault-locked', () => {
        void useVaultStore.getState().refresh();
      }).catch(() => null),
      listen('nexterm-vault-cleared', () => {
        useCredentialStore.getState().clearAllCredentials();
        void useVaultStore.getState().refresh();
      }).catch(() => null)
    ];

    return () => {
      subscriptions.forEach((subscription) => {
        void subscription.then((unlisten) => unlisten?.());
      });
    };
  }, []);
}
