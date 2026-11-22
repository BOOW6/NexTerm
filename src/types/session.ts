export type SessionKind = 'local' | 'ssh' | 'sftp' | 'telnet' | 'serial';

export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

/** How an SFTP transfer resolves an existing target file. */
export type SftpConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename' | 'newer';

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
  /** Serial sessions only. */
  serialPort?: string;
  serialBaud?: number;
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
  /** Serial sessions only. */
  serialPort?: string;
  serialBaud?: number;
  group: string;
  favorite?: boolean;
}

export const DEFAULT_GROUP = '会话';

export type SessionTranslate = (key: string, params?: Record<string, string | number>) => string;

export const SESSION_KIND_LABEL_KEY: Record<SessionKind, string> = {
  local: 'session.kind.local',
  ssh: 'session.kind.ssh',
  sftp: 'session.kind.sftp',
  telnet: 'session.kind.telnet',
  serial: 'session.kind.serial'
};

export function sessionSubtitle(session: Session, t: SessionTranslate): string {
  if (session.kind === 'serial') {
    const port = session.serialPort ?? '';
    return session.serialBaud ? `${port} @ ${session.serialBaud}` : port;
  }
  if (session.kind === 'local') {
    const shellName = session.shellCommand?.split(/[\\/]/).pop();
    return shellName ? shellName.replace(/\.exe$/i, '') : t('session.subtitle.localShell');
  }
  const target = session.username
    ? `${session.username}@${session.host ?? ''}`
    : (session.host ?? '');
  return session.port ? `${target}:${session.port}` : target;
}
