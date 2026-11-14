import { useCallback } from 'react';
import { tStatic } from '../../i18n';
import { openModalWindow } from '../../lib/appWindows';
import { useCredentialStore } from '../../stores/credentialStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { toast } from '../../components/ui/toastStore';
import { forgetSessionCredentials, rememberSessionCredentials } from '../../lib/credentialVault';
import type { Session, SessionAuthMethod, SessionDraft, SessionKind } from '../../types/session';
import { useWorkspace } from './useWorkspace';

export interface QuickConnectOptions {
  sessionId?: string;
  kind?: SessionKind;
}

interface QuickConnectDefaults {
  kind: SessionKind;
  authMethod: SessionAuthMethod;
  port: number;
  username: string;
}

export interface QuickConnectPayload {
  defaults: QuickConnectDefaults;
  session: Session | null;
  /** Remote sessions the edited session may tunnel through (ProxyJump). */
  jumpCandidates: Array<{ id: string; title: string }>;
}

export interface QuickConnectResult {
  draft: SessionDraft;
  password?: string;
  passphrase?: string;
}

/** Whether the jump chain starting at `startId` reaches `targetId`
 * (which would make `targetId` its own jump host). */
function jumpChainReaches(
  startId: string,
  targetId: string | undefined,
  sessions: Session[]
): boolean {
  if (!targetId) {
    return false;
  }
  let currentId: string | undefined = startId;
  for (let hop = 0; hop < 8 && currentId; hop += 1) {
    if (currentId === targetId) {
      return true;
    }
    currentId = sessions.find((item) => item.id === currentId)?.jumpSessionId;
  }
  return false;
}

function buildJumpCandidates(
  sessions: Session[],
  editingId?: string
): Array<{ id: string; title: string }> {
  const candidates = sessions
    .filter((item) => (item.kind === 'ssh' || item.kind === 'sftp') && item.id !== editingId)
    .filter((item) => !jumpChainReaches(item.id, editingId, sessions))
    .map((item) => ({ id: item.id, title: item.title }));

  // Keep an already-selected jump host selectable even if its own chain was
  // edited into a cycle afterwards; saving the edit then reports the cycle.
  const current = editingId
    ? sessions.find((item) => item.id === editingId)?.jumpSessionId
    : undefined;
  if (current && !candidates.some((item) => item.id === current)) {
    const title = sessions.find((item) => item.id === current)?.title;
    if (title) {
      candidates.unshift({ id: current, title });
    }
  }
  return candidates;
}

export function useQuickConnectLauncher(): (options?: QuickConnectOptions) => Promise<void> {
  const { openSession } = useWorkspace();

  return useCallback(
    async (options?: QuickConnectOptions) => {
      const sessionState = useSessionStore.getState();
      const settings = useSettingsStore.getState();
      const session = options?.sessionId
        ? (sessionState.sessions.find((item) => item.id === options.sessionId) ?? null)
        : null;

      const result = await openModalWindow<QuickConnectResult>('quick-connect', {
        title: session
          ? tStatic('quickConnect.windowTitleEdit')
          : tStatic('quickConnect.windowTitleNew'),
        width: 500,
        height: session?.kind === 'local' ? 570 : session?.kind === 'serial' ? 560 : 620,
        data: {
          defaults: {
            kind: options?.kind ?? session?.kind ?? 'local',
            authMethod: session?.authMethod ?? settings.defaultAuthMethod,
            port: session?.port ?? settings.defaultPort,
            username: session?.username ?? settings.defaultUsername
          },
          session,
          jumpCandidates: buildJumpCandidates(sessionState.sessions, session?.id)
        } satisfies QuickConnectPayload
      });

      if (!result) {
        return;
      }

      const isRemote = result.draft.kind !== 'local';
      // Telnet authenticates in-band; only SSH/SFTP carry NexTerm credentials.
      const hasAuth = result.draft.kind === 'ssh' || result.draft.kind === 'sftp';

      if (hasAuth && result.draft.jumpSessionId) {
        const jumpId = result.draft.jumpSessionId;
        const selfReferenced = jumpId === session?.id;
        const cycled =
          !selfReferenced &&
          sessionState.sessions.some(
            (item) =>
              item.id === jumpId && jumpChainReaches(item.id, session?.id, sessionState.sessions)
          );
        if (selfReferenced || cycled) {
          toast({ title: tStatic('quickConnect.toastJumpCycle'), variant: 'error' });
          return;
        }
      }

      if (session) {
        const previousAuthMethod = session.authMethod ?? 'password';
        const previousKind = session.kind;
        sessionState.updateSession(session.id, result.draft);
        if (isRemote && previousAuthMethod !== result.draft.authMethod) {
          await forgetSessionCredentials(session.id);
        }
        if (previousKind !== 'local' && !isRemote) {
          // The session stopped being remote: leaving its stored credentials
          // behind would silently reconnect with them if it is switched back.
          await forgetSessionCredentials(session.id);
        }
        if (hasAuth) {
          if (result.password?.trim()) {
            useCredentialStore.getState().setPassword(session.id, result.password);
          }
          if (result.draft.authMethod === 'key' || result.draft.authMethod === 'certificate') {
            // An empty passphrase means "keep the stored one" (same guard as
            // the password field) — overwriting it with '' would lose the
            // vault entry for good.
            if (result.passphrase?.trim()) {
              useCredentialStore.getState().setPassphrase(session.id, result.passphrase);
            }
            useCredentialStore.getState().authorize(session.id);
          } else if (result.draft.authMethod === 'agent') {
            useCredentialStore.getState().authorize(session.id);
          }
          const updated = sessionState.getSession(session.id);
          if (updated) {
            await rememberSessionCredentials(updated);
          }
        }
        toast({ title: tStatic('quickConnect.toastUpdated'), variant: 'success' });
        openSession(session.id);
        return;
      }

      const created = sessionState.addSession(result.draft);
      if (hasAuth) {
        if (result.draft.authMethod === 'password') {
          if (result.password?.trim()) {
            useCredentialStore.getState().setPassword(created.id, result.password);
          }
        } else if (result.draft.authMethod === 'key' || result.draft.authMethod === 'certificate') {
          useCredentialStore.getState().setPassphrase(created.id, result.passphrase ?? '');
          useCredentialStore.getState().authorize(created.id);
        } else {
          useCredentialStore.getState().authorize(created.id);
        }
        const stored = sessionState.getSession(created.id);
        if (stored) {
          await rememberSessionCredentials(stored);
        }
      }

      toast({
        title: tStatic('quickConnect.toastCreated', { name: created.title }),
        description: isRemote
          ? result.draft.kind === 'telnet'
            ? tStatic('quickConnect.toastConnectingTelnet')
            : result.draft.authMethod === 'key'
              ? tStatic('quickConnect.toastConnectingKey')
              : result.draft.authMethod === 'certificate'
                ? tStatic('quickConnect.toastConnectingCert')
                : result.draft.authMethod === 'agent'
                  ? tStatic('quickConnect.toastConnectingAgent')
                  : result.password?.trim()
                    ? tStatic('quickConnect.toastConnectingPassword')
                    : tStatic('quickConnect.toastWillPromptPassword')
          : undefined,
        variant: 'success'
      });
      openSession(created.id);
    },
    [openSession]
  );
}
