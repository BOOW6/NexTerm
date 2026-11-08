import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_GROUP,
  SESSION_KIND_LABEL,
  type Session,
  type SessionDraft,
  type SessionStatus
} from '../types/session';

interface SessionState {
  sessions: Session[];
  addSession: (draft: SessionDraft) => Session;
  addSessions: (drafts: SessionDraft[]) => Session[];
  updateSession: (id: string, patch: Partial<SessionDraft>) => void;
  removeSession: (id: string) => void;
  toggleFavorite: (id: string) => void;
  markUsed: (id: string) => void;
  setStatus: (id: string, status: SessionStatus) => void;
  ensureDefaultSession: () => Session;
  getSession: (id: string) => Session | undefined;
}

function buildSession(draft: SessionDraft): Session {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    kind: draft.kind,
    title: draft.title.trim() || SESSION_KIND_LABEL[draft.kind],
    host: draft.kind === 'local' ? undefined : draft.host?.trim() || undefined,
    port: draft.kind === 'local' ? undefined : draft.port,
    username: draft.kind === 'local' ? undefined : draft.username?.trim() || undefined,
    authMethod: draft.kind === 'local' ? undefined : (draft.authMethod ?? 'password'),
    keyPath: draft.kind === 'local' ? undefined : draft.keyPath?.trim() || undefined,
    certPath: draft.kind === 'local' ? undefined : draft.certPath?.trim() || undefined,
    jumpSessionId: draft.kind === 'local' ? undefined : draft.jumpSessionId?.trim() || undefined,
    group: draft.group.trim() || DEFAULT_GROUP,
    favorite: draft.favorite ?? false,
    status: 'idle',
    createdAt: now,
    lastUsed: now
  };
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],

      addSession: (draft) => {
        const session = buildSession(draft);
        set((state) => ({ sessions: [...state.sessions, session] }));
        return session;
      },

      addSessions: (drafts) => {
        const sessions = drafts.map(buildSession);
        if (sessions.length > 0) {
          set((state) => ({ sessions: [...state.sessions, ...sessions] }));
        }
        return sessions;
      },

      updateSession: (id, patch) => {
        set((state) => ({
          sessions: state.sessions.map((session) => {
            if (session.id !== id) {
              return session;
            }
            const nextKind = patch.kind ?? session.kind;
            return {
              ...session,
              ...patch,
              kind: nextKind,
              title:
                patch.title !== undefined
                  ? patch.title.trim() || SESSION_KIND_LABEL[nextKind]
                  : session.title,
              host: nextKind === 'local' ? undefined : patch.host?.trim() || session.host,
              // An explicitly cleared username (empty string) must stick; the
              // old value is only kept when the patch omits the field.
              username:
                nextKind === 'local'
                  ? undefined
                  : patch.username !== undefined
                    ? patch.username.trim() || undefined
                    : session.username,
              port: nextKind === 'local' ? undefined : (patch.port ?? session.port),
              authMethod:
                nextKind === 'local'
                  ? undefined
                  : (patch.authMethod ?? session.authMethod ?? 'password'),
              keyPath:
                nextKind === 'local'
                  ? undefined
                  : patch.keyPath !== undefined
                    ? patch.keyPath.trim() || undefined
                    : session.keyPath,
              certPath:
                nextKind === 'local'
                  ? undefined
                  : patch.certPath !== undefined
                    ? patch.certPath.trim() || undefined
                    : session.certPath,
              // An empty string clears the jump host (same explicit-clear
              // semantics as username/keyPath); an omitted field keeps it.
              jumpSessionId:
                nextKind === 'local'
                  ? undefined
                  : patch.jumpSessionId !== undefined
                    ? patch.jumpSessionId.trim() || undefined
                    : session.jumpSessionId,
              group: patch.group !== undefined ? patch.group.trim() || DEFAULT_GROUP : session.group
            };
          })
        }));
      },

      removeSession: (id) => {
        set((state) => ({ sessions: state.sessions.filter((session) => session.id !== id) }));
      },

      toggleFavorite: (id) => {
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === id ? { ...session, favorite: !session.favorite } : session
          )
        }));
      },

      markUsed: (id) => {
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === id ? { ...session, lastUsed: Date.now() } : session
          )
        }));
      },

      setStatus: (id, status) => {
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === id ? { ...session, status } : session
          )
        }));
      },

      ensureDefaultSession: () => {
        const existing = get().sessions[0];
        if (existing) {
          return existing;
        }
        return get().addSession({
          kind: 'local',
          title: '本地终端',
          group: '本地'
        });
      },

      getSession: (id) => get().sessions.find((session) => session.id === id)
    }),
    {
      name: 'nexterm.sessions.v1',
      version: 1,
      merge: (persisted, current) => {
        const saved = (persisted as Partial<SessionState> | undefined)?.sessions ?? [];
        return {
          ...current,
          sessions: saved.map((session) => ({ ...session, status: 'idle' as const }))
        };
      }
    }
  )
);
