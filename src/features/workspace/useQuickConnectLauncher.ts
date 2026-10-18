import { useCallback } from 'react';
import { openModalWindow } from '../../lib/appWindows';
import { useCredentialStore } from '../../stores/credentialStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { toast } from '../../components/ui/toast';
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
        ? sessionState.sessions.find((item) => item.id === options.sessionId) ?? null
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
        sessionState.updateSession(session.id, result.draft);
        if (isRemote) {
          if (result.password?.trim()) {
            useCredentialStore.getState().setPassword(session.id, result.password);
          }
          if (result.draft.authMethod === 'key') {
            useCredentialStore.getState().setPassphrase(session.id, result.passphrase ?? '');
            useCredentialStore.getState().authorize(session.id);
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
        } else {
          useCredentialStore
            .getState()
            .setPassphrase(created.id, result.passphrase ?? '');
          useCredentialStore.getState().authorize(created.id);
        }
      }

      toast({
        title: `已创建「${created.title}」`,
        description: isRemote
          ? result.draft.authMethod === 'key'
            ? '正在使用私钥建立 SSH 连接…'
            : result.password?.trim()
              ? '正在建立 SSH 连接…'
              : '连接时请输入密码。'
          : undefined,
        variant: 'success'
      });
      openSession(created.id);
    },
    [openSession]
  );
}
