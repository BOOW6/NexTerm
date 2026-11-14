import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { tStatic } from '../i18n';
import {
  DEFAULT_GROUP,
  SESSION_KIND_LABEL_KEY,
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
  // Serial sessions are "local-like": no host/auth fields, but they carry
  // their own port configuration.
  const localLike = draft.kind === 'local' || draft.kind === 'serial';
  return {
    id: crypto.randomUUID(),
    kind: draft.kind,
    title: draft.title.trim() || tStatic(SESSION_KIND_LABEL_KEY[draft.kind]),
    host: localLike ? undefined : draft.host?.trim() || undefined,
    port: localLike ? undefined : draft.port,
    username: localLike ? undefined : draft.username?.trim() || undefined,
    authMethod: localLike ? undefined : (draft.authMethod ?? 'password'),
    keyPath: localLike ? undefined : draft.keyPath?.trim() || undefined,
    certPath: localLike ? undefined : draft.certPath?.trim() || undefined,
    jumpSessionId: localLike ? undefined : draft.jumpSessionId?.trim() || undefined,
    shellCommand: draft.kind === 'local' ? draft.shellCommand?.trim() || undefined : undefined,
    shellArgs: draft.kind === 'local' && draft.shellArgs?.length ? draft.shellArgs : undefined,
    serialPort: draft.kind === 'serial' ? draft.serialPort?.trim() || undefined : undefined,
    serialBaud: draft.kind === 'serial' ? draft.serialBaud : undefined,
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
            const nextLocalLike = nextKind === 'local' || nextKind === 'serial';
            return {
              ...session,
              ...patch,
              kind: nextKind,
              title:
                patch.title !== undefined
                  ? patch.title.trim() || tStatic(SESSION_KIND_LABEL_KEY[nextKind])
                  : session.title,
              host: nextKind === 'local' ? undefined : patch.host?.trim() || session.host,
              // An explicitly cleared username (empty string) must stick; the
              // old value is only kept when the patch omits the field.
              username: nextLocalLike
                ? undefined
                : patch.username !== undefined
                  ? patch.username.trim() || undefined
                  : session.username,
              port: nextLocalLike ? undefined : (patch.port ?? session.port),
              authMethod: nextLocalLike
                ? undefined
                : (patch.authMethod ?? session.authMethod ?? 'password'),
              keyPath: nextLocalLike
                ? undefined
                : patch.keyPath !== undefined
                  ? patch.keyPath.trim() || undefined
                  : session.keyPath,
              certPath: nextLocalLike
                ? undefined
                : patch.certPath !== undefined
                  ? patch.certPath.trim() || undefined
                  : session.certPath,
              // An empty string clears the jump host (same explicit-clear
              // semantics as username/keyPath); an omitted field keeps it.
              jumpSessionId: nextLocalLike
                ? undefined
                : patch.jumpSessionId !== undefined
                  ? patch.jumpSessionId.trim() || undefined
                  : session.jumpSessionId,
              // Same explicit-clear semantics as keyPath: the local form always
              // sends a string ('' = platform default shell), an omitted field
              // keeps the previous override.
              shellCommand:
                nextKind === 'local'
                  ? (patch.shellCommand ?? session.shellCommand)?.trim() || undefined
                  : undefined,
              shellArgs:
                nextKind === 'local'
                  ? patch.shellArgs !== undefined
                    ? patch.shellArgs.length
                      ? patch.shellArgs
                      : undefined
                    : session.shellArgs
                  : undefined,
              serialPort:
                nextKind === 'serial'
                  ? patch.serialPort !== undefined
                    ? patch.serialPort.trim() || undefined
                    : session.serialPort
                  : undefined,
              serialBaud:
                nextKind === 'serial' ? (patch.serialBaud ?? session.serialBaud) : undefined,
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
          title: tStatic(SESSION_KIND_LABEL_KEY.local),
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
