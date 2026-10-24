import { create } from 'zustand';

interface CredentialState {
  passwords: Record<string, string>;
  passphrases: Record<string, string>;
  authorizations: Record<string, boolean>;
  setPassword: (sessionId: string, password: string) => void;
  setPassphrase: (sessionId: string, passphrase: string) => void;
  authorize: (sessionId: string) => void;
  clearCredentials: (sessionId: string) => void;
  clearAllCredentials: () => void;
}

/**
 * Credentials live in memory only - never persisted to disk. Users are prompted
 * again after restarting the app.
 */
export const useCredentialStore = create<CredentialState>((set) => ({
  passwords: {},
  passphrases: {},
  authorizations: {},

  setPassword: (sessionId, password) =>
    set((state) => ({ passwords: { ...state.passwords, [sessionId]: password } })),

  setPassphrase: (sessionId, passphrase) =>
    set((state) => ({ passphrases: { ...state.passphrases, [sessionId]: passphrase } })),

  authorize: (sessionId) =>
    set((state) => ({
      authorizations: { ...state.authorizations, [sessionId]: true }
    })),

  clearCredentials: (sessionId) =>
    set((state) => {
      const passwords = { ...state.passwords };
      const passphrases = { ...state.passphrases };
      const authorizations = { ...state.authorizations };
      delete passwords[sessionId];
      delete passphrases[sessionId];
      delete authorizations[sessionId];
      return { passwords, passphrases, authorizations };
    }),

  clearAllCredentials: () => set({ passwords: {}, passphrases: {}, authorizations: {} })
}));
