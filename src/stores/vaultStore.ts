import { create } from 'zustand';
import {
  getVaultStatus,
  hydrateCredentialsFromVault,
  lockVault,
  unlockVault,
  type VaultStatus
} from '../lib/credentialVault';

interface VaultState {
  status: VaultStatus;
  loading: boolean;
  refresh: () => Promise<VaultStatus>;
  unlock: (masterPassword: string) => Promise<boolean>;
  lock: () => Promise<void>;
  setStatus: (status: VaultStatus) => void;
}

const EMPTY_STATUS: VaultStatus = { initialized: false, unlocked: false, entry_count: 0 };

export const useVaultStore = create<VaultState>((set) => ({
  status: EMPTY_STATUS,
  loading: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const status = await getVaultStatus();
      set({ status });
      return status;
    } catch {
      set({ status: EMPTY_STATUS });
      return EMPTY_STATUS;
    } finally {
      set({ loading: false });
    }
  },

  unlock: async (masterPassword) => {
    set({ loading: true });
    try {
      const ok = await unlockVault(masterPassword);
      if (ok) {
        await hydrateCredentialsFromVault();
      }
      const status = await getVaultStatus();
      set({ status });
      return ok;
    } finally {
      set({ loading: false });
    }
  },

  lock: async () => {
    await lockVault();
    // Keep credentials for already-open sessions in memory; the vault only
    // guards what is persisted to disk. Locking must not drop live terminals.
    const status = await getVaultStatus();
    set({ status });
  },

  setStatus: (status) => set({ status })
}));
