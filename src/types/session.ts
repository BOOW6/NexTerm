export type SessionKind = 'local' | 'ssh' | 'sftp' | 'telnet';

export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export type SessionAuthMethod = 'password' | 'key' | 'agent' | 'certificate';

export interface Session {
  id: string;
  kind: SessionKind;
  title: string;
  host?: string;
  port?: number;
  username?: string;
  authMethod?: SessionAuthMethod;
  keyPath?: string;
  /** OpenSSH user certificate (`*-cert.pub`) for certificate auth. */
  certPath?: string;
  /** Optional SSH/SFTP session whose connection tunnels this one (ProxyJump). */
  jumpSessionId?: string;
  /** Local sessions only: executable to spawn instead of the platform shell. */
  shellCommand?: string;
  shellArgs?: string[];
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
  certPath?: string;
  jumpSessionId?: string;
  /** Local sessions only. An empty string clears an existing override. */
  shellCommand?: string;
  shellArgs?: string[];
  group: string;
  favorite?: boolean;
}

export const DEFAULT_GROUP = '会话';

export const SESSION_KIND_LABEL: Record<SessionKind, string> = {
  local: '本地终端',
  ssh: 'SSH',
  sftp: 'SFTP',
  telnet: 'Telnet'
};

export function sessionSubtitle(session: Session): string {
  if (session.kind === 'local') {
    const shellName = session.shellCommand?.split(/[\\/]/).pop();
    return shellName ? shellName.replace(/\.exe$/i, '') : '本地 Shell';
  }
  const target = session.username
    ? `${session.username}@${session.host ?? ''}`
    : (session.host ?? '');
  return session.port ? `${target}:${session.port}` : target;
}
