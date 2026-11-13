import { create } from 'zustand';
import { writePty } from '../hooks/useTauriPty';
import { writeSsh } from '../hooks/useTauriSsh';
import { writeTelnet } from '../hooks/useTauriTelnet';
import {
  currentSshId,
  transportIds,
  useConnectionStore,
  type ConnectionEntry
} from './connectionStore';
import { useSessionStore } from './sessionStore';

interface BroadcastState {
  /** Sessions opted into broadcast input. Stale ids (removed sessions) are
   * filtered out dynamically everywhere; pruning happens on toggle. */
  ids: string[];
  toggle: (sessionId: string) => boolean;
  clear: () => void;
}

export const useBroadcastStore = create<BroadcastState>((set, get) => ({
  ids: [],

  /** Returns whether the session is now part of the group. */
  toggle: (sessionId) => {
    const live = new Set(useSessionStore.getState().sessions.map((session) => session.id));
    const current = get().ids.filter((id) => live.has(id) || id === sessionId);
    const joining = !current.includes(sessionId);
    const next = joining ? [...current, sessionId] : current.filter((id) => id !== sessionId);
    set({ ids: next });
    return joining;
  },

  clear: () => set({ ids: [] })
}));

/** Count of broadcast members that still exist as sessions. */
export function broadcastCount(): number {
  const ids = useBroadcastStore.getState().ids;
  const sessions = useSessionStore.getState().sessions;
  return ids.filter((id) => sessions.some((session) => session.id === id)).length;
}

/** Write `data` to every OTHER broadcast member's live transports.
 *
 * A session is only written when the store says it is connected; individual
 * write failures are swallowed (a pane that just dropped is handled by its
 * own reconnect flow — broadcast must never surface transport errors). */
export function broadcastInput(selfSessionId: string, data: string): void {
  const { ids } = useBroadcastStore.getState();
  if (ids.length < 2 || !ids.includes(selfSessionId)) {
    return;
  }
  const sessions = useSessionStore.getState().sessions;
  const connections = useConnectionStore.getState().connections;

  for (const sessionId of ids) {
    if (sessionId === selfSessionId) {
      continue;
    }
    const session = sessions.find((item) => item.id === sessionId);
    if (!session || session.status !== 'connected') {
      continue;
    }
    const entry: ConnectionEntry | undefined = connections[sessionId];
    if (session.kind === 'ssh' || session.kind === 'sftp') {
      const sshId = currentSshId(entry);
      if (sshId) {
        void writeSsh(sshId, data).catch(() => {});
      }
    } else if (session.kind === 'local') {
      for (const id of transportIds(entry, 'pty')) {
        void writePty(id, data).catch(() => {});
      }
    } else if (session.kind === 'telnet') {
      for (const id of transportIds(entry, 'telnet')) {
        void writeTelnet(id, data).catch(() => {});
      }
    }
  }
}
