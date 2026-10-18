import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'connected' | 'error';

export interface ConnectionEntry {
  sshId: string;
  status: ConnectionStatus;
  error?: string;
}

interface ConnectionState {
  connections: Record<string, ConnectionEntry>;
  setConnection: (sessionId: string, entry: ConnectionEntry) => void;
  removeConnection: (sessionId: string, sshId?: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: {},
  setConnection: (sessionId, entry) =>
    set((state) => ({
      connections: { ...state.connections, [sessionId]: entry }
    })),
  removeConnection: (sessionId, sshId) =>
    set((state) => {
      const current = state.connections[sessionId];
      if (!current || (sshId && current.sshId !== sshId)) {
        return state;
      }
      const connections = { ...state.connections };
      delete connections[sessionId];
      return { connections };
    })
}));
