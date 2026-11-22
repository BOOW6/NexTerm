import { Cable, FolderTree, Globe, Server, TerminalSquare, type LucideIcon } from 'lucide-react';
import type { SessionKind, SessionStatus } from '../types/session';

export const SESSION_KIND_ICON: Record<SessionKind, LucideIcon> = {
  local: TerminalSquare,
  ssh: Server,
  sftp: FolderTree,
  telnet: Globe,
  serial: Cable
};

const SESSION_STATUS_COLOR: Record<SessionStatus, string> = {
  idle: 'bg-muted',
  connecting: 'bg-warning',
  connected: 'bg-success',
  disconnected: 'bg-muted-foreground',
  error: 'bg-error'
};

/** Shared with the sidebar rows and the status bar so a status label never
 * falls back to the raw enum string. */
export const SESSION_STATUS_LABEL_KEY: Record<SessionStatus, string> = {
  idle: 'status.idle',
  connecting: 'status.connecting',
  connected: 'status.connected',
  disconnected: 'status.disconnected',
  error: 'status.error'
};

/** Sessions whose transport is backed by the SSH connection manager: SSH
 * and SFTP share one backend connection per session, which the port-forward
 * entry, SFTP panel and credential vault all key off. */
export function isSshBackedSession(kind: SessionKind): boolean {
  return kind === 'ssh' || kind === 'sftp';
}

export function sessionStatusDot(status: SessionStatus, pulse = false): string {
  const color = SESSION_STATUS_COLOR[status];
  return pulse && status === 'connecting' ? `${color} animate-pulse` : color;
}
