export type SessionKind = 'local' | 'ssh' | 'sftp';

export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export type SessionAuthMethod = 'password' | 'key' | 'agent';

export interface Session {
  id: string;
  kind: SessionKind;
  title: string;
  host?: string;
  port?: number;
  username?: string;
  authMethod?: SessionAuthMethod;
  keyPath?: string;
  group: string;
  favorite: boolean;
  status: SessionStatus;
  createdAt: number;
  lastUsed: number;
}

export interface SessionDraft {
  kind: SessionKind;
  title: string;
  host?: string;
  port?: number;
  username?: string;
  authMethod?: SessionAuthMethod;
  keyPath?: string;
  group: string;
  favorite?: boolean;
}

export const DEFAULT_GROUP = '会话';

export const SESSION_KIND_LABEL: Record<SessionKind, string> = {
  local: '本地终端',
  ssh: 'SSH',
  sftp: 'SFTP'
};

export function sessionSubtitle(session: Session): string {
  if (session.kind === 'local') {
    return '本地 Shell';
  }
  const target = session.username
    ? `${session.username}@${session.host ?? ''}`
    : (session.host ?? '');
  return session.port ? `${target}:${session.port}` : target;
}
