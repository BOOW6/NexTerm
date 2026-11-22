import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'connected' | 'error';

/** Non-SSH transport kinds tracked alongside SSH connections. */
export type TransportKind = 'pty' | 'telnet' | 'serial';

export interface TransportRef {
  kind: TransportKind;
  id: string;
}

/** Invariant: an entry exists only while the session has at least one live
 * SSH connection or non-SSH transport. Both cleanup paths (removeConnection /
 * removeTransport) delete the entry once nothing remains, so
 * `connections[id] === undefined` reliably means "nothing is live" and
 * closed-session checks that test entry existence always fire. */
export interface ConnectionEntry {
  /** Every live backend connection of the session (each split pane opens
   * its own). The last id is the most recent connection. */
  sshIds: string[];
  status: ConnectionStatus;
  error?: string;
  /** Live PTY/Telnet/Serial transport ids of the session, for features that
   * write into terminals from outside their pane (e.g. broadcast input). */
  transports?: TransportRef[];
}

/** The sshId SFTP/forward panels should operate on: the most recent live
 * connection of the session, or undefined while nothing is connected. */
export function currentSshId(entry: ConnectionEntry | undefined): string | undefined {
  const sshId = entry?.sshIds[entry.sshIds.length - 1];
  return entry?.status === 'connected' && sshId ? sshId : undefined;
}

/** Every live transport id of the given kind. */
export function transportIds(entry: ConnectionEntry | undefined, kind: TransportKind): string[] {
  return entry?.transports?.filter((item) => item.kind === kind).map((item) => item.id) ?? [];
}

interface SetConnectionPayload {
  sshId: string;
  status: ConnectionStatus;
  error?: string;
}

interface ConnectionState {
  connections: Record<string, ConnectionEntry>;
  setConnection: (sessionId: string, payload: SetConnectionPayload) => void;
  removeConnection: (sessionId: string, sshId?: string) => void;
  addTransport: (sessionId: string, kind: TransportKind, id: string) => void;
  removeTransport: (sessionId: string, kind: TransportKind, id: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: {},
  setConnection: (sessionId, payload) =>
    set((state) => {
      const previous = state.connections[sessionId];
      const sshIds = previous ? previous.sshIds.filter((id) => id !== payload.sshId) : [];
      return {
        connections: {
          ...state.connections,
          [sessionId]: {
            ...previous,
            sshIds: [...sshIds, payload.sshId],
            status: payload.status,
            error: payload.error
          }
        }
      };
    }),
  removeConnection: (sessionId, sshId) =>
    set((state) => {
      const current = state.connections[sessionId];
      if (!current) {
        return state;
      }
      // Without an sshId this is a catch-all reset: drop the whole entry.
      if (!sshId) {
        const connections = { ...state.connections };
        delete connections[sessionId];
        return { connections };
      }
      if (!current.sshIds.includes(sshId)) {
        return state;
      }
      const sshIds = current.sshIds.filter((id) => id !== sshId);
      if (sshIds.length === 0 && (current.transports?.length ?? 0) === 0) {
        const connections = { ...state.connections };
        delete connections[sessionId];
        return { connections };
      }
      // Sibling panes keep their own live connections to the session.
      return {
        connections: {
          ...state.connections,
          [sessionId]: { ...current, sshIds, status: 'connected' }
        }
      };
    }),
  addTransport: (sessionId, kind, id) =>
    set((state) => {
      const current = state.connections[sessionId];
      if (current?.transports?.some((item) => item.id === id)) {
        return state;
      }
      const transports = [...(current?.transports ?? []), { kind, id }];
      return {
        connections: {
          ...state.connections,
          [sessionId]: { ...(current ?? { sshIds: [], status: 'connected' }), transports }
        }
      };
    }),
  removeTransport: (sessionId, kind, id) =>
    set((state) => {
      const current = state.connections[sessionId];
      if (!current?.transports?.some((item) => item.id === id && item.kind === kind)) {
        return state;
      }
      const transports = current.transports.filter((item) => item.id !== id);
      if (transports.length === 0 && current.sshIds.length === 0) {
        // Last transport gone and no SSH connection behind it: drop the
        // entry entirely. Keeping an empty shell would make closed-session
        // checks that test entry existence never fire, leaving the session
        // stuck on its previous status.
        const connections = { ...state.connections };
        delete connections[sessionId];
        return { connections };
      }
      const next: ConnectionEntry = { ...current, transports };
      if (transports.length === 0) {
        delete next.transports;
      }
      return { connections: { ...state.connections, [sessionId]: next } };
    })
}));
