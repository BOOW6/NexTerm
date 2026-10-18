import { FolderTree, Server, TerminalSquare, type LucideIcon } from 'lucide-react';
import type { SessionKind, SessionStatus } from '../types/session';

export const SESSION_KIND_ICON: Record<SessionKind, LucideIcon> = {
  local: TerminalSquare,
  ssh: Server,
  sftp: FolderTree
};

const SESSION_STATUS_COLOR: Record<SessionStatus, string> = {
  idle: 'bg-muted',
  connecting: 'bg-warning',
  connected: 'bg-success',
  error: 'bg-error'
};

export function sessionStatusDot(status: SessionStatus, pulse = false): string {
  const color = SESSION_STATUS_COLOR[status];
  return pulse && status === 'connecting' ? `${color} animate-pulse` : color;
}
