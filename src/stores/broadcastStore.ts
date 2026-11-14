import { create } from 'zustand';
import { writeToSession } from '../lib/terminalWrite';
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
  for (const sessionId of ids) {
    if (sessionId !== selfSessionId) {
      writeToSession(sessionId, data);
    }
  }
}
