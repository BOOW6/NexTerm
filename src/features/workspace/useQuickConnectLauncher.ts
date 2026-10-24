import { useCallback } from 'react';
import { openModalWindow } from '../../lib/appWindows';
import { useCredentialStore } from '../../stores/credentialStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { toast } from '../../components/ui/toast';
import { forgetSessionCredentials, rememberSessionCredentials } from '../../lib/credentialVault';
import type { Session, SessionAuthMethod, SessionDraft, SessionKind } from '../../types/session';
import { useWorkspace } from './WorkspaceContext';

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
}

export interface QuickConnectResult {
  draft: SessionDraft;
  password?: string;
  passphrase?: string;
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
        title: session ? '编辑会话' : '新建会话',
        width: 500,
        height: session?.kind === 'local' ? 470 : 620,
        data: {
          defaults: {
            kind: options?.kind ?? session?.kind ?? 'local',
            authMethod: session?.authMethod ?? settings.defaultAuthMethod,
            port: session?.port ?? settings.defaultPort,
            username: session?.username ?? settings.defaultUsername
          },
          session
        } satisfies QuickConnectPayload
      });

      if (!result) {
        return;
      }

      const isRemote = result.draft.kind !== 'local';

      if (session) {
        const previousAuthMethod = session.authMethod ?? 'password';
        sessionState.updateSession(session.id, result.draft);
        if (isRemote && previousAuthMethod !== result.draft.authMethod) {
          await forgetSessionCredentials(session.id);
        }
        if (isRemote) {
          if (result.password?.trim()) {
            useCredentialStore.getState().setPassword(session.id, result.password);
          }
          if (result.draft.authMethod === 'key') {
            useCredentialStore.getState().setPassphrase(session.id, result.passphrase ?? '');
            useCredentialStore.getState().authorize(session.id);
          } else if (result.draft.authMethod === 'agent') {
            useCredentialStore.getState().authorize(session.id);
          }
          const updated = sessionState.getSession(session.id);
          if (updated) {
            await rememberSessionCredentials(updated);
          }
        }
        toast({ title: '会话已更新', variant: 'success' });
        openSession(session.id);
        return;
      }

      const created = sessionState.addSession(result.draft);
      if (isRemote) {
        if (result.draft.authMethod === 'password') {
          if (result.password?.trim()) {
            useCredentialStore.getState().setPassword(created.id, result.password);
          }
        } else if (result.draft.authMethod === 'key') {
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
        title: `已创建「${created.title}」`,
        description: isRemote
          ? result.draft.authMethod === 'key'
            ? '正在使用私钥建立 SSH 连接。'
            : result.draft.authMethod === 'agent'
              ? '正在使用 SSH Agent 建立连接。'
              : result.password?.trim()
                ? '正在建立 SSH 连接。'
                : '连接时将请求输入密码。'
          : undefined,
        variant: 'success'
      });
      openSession(created.id);
    },
    [openSession]
  );
}
