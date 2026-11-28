import { Cable, FolderTree, Globe, Server, TerminalSquare, type LucideIcon } from 'lucide-react';
import type { SessionKind, SessionStatus } from '../types/session';

export const SESSION_KIND_ICON: Record<SessionKind, LucideIcon> = {
  local: TerminalSquare,
  ssh: Server,
  sftp: FolderTree,
  telnet: Globe,
  serial: Cable
};

const SESSION_STATUS_DOT_CLASS: Record<SessionStatus, string> = {
  idle: 'rounded-full border border-muted bg-transparent',
  connecting: 'rounded-full border-2 border-warning bg-transparent',
  connected: 'rounded-full bg-success',
  disconnected: 'rounded-none bg-muted-foreground',
  error: 'rotate-45 rounded-none bg-error'
};

/** Status color is redundant: each state also has a distinct shape, so the
 * dot remains distinguishable without relying on hue or a tooltip. The shape
 * classes live here, not at the call sites: Tailwind emits `rounded-full`
 * after `rounded-none`, so a component-level `rounded-full` base would
 * silently win the cascade and collapse square/diamond back to circles. */
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
  const color = SESSION_STATUS_DOT_CLASS[status];
  return pulse && status === 'connecting' ? `${color} animate-pulse` : color;
}
