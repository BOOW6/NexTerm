import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { tStatic } from '../../i18n';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { requestTerminalReconnect } from '../../lib/terminalReconnect';
import type { Session, SessionDraft } from '../../types/session';

export type SplitDirection = 'right' | 'below';

/**
 * Every user-visible field a copy must carry over. Kept in one place so a new
 * Session field cannot silently drop out of duplication (the sessionActions
 * test asserts this mapping stays complete).
 */
export function toSessionDraft(session: Session): SessionDraft {
  return {
    kind: session.kind,
    title: session.title,
    host: session.host,
    port: session.port,
    username: session.username,
    authMethod: session.authMethod,
    keyPath: session.keyPath,
    certPath: session.certPath,
    jumpSessionId: session.jumpSessionId,
    group: session.group,
    favorite: session.favorite
  };
}

interface OpenSessionOptions {
  forceNew?: boolean;
  direction?: SplitDirection;
  referencePanelId?: string;
}

function newPanelId(): string {
  return `panel-${crypto.randomUUID()}`;
}

function sessionIdOf(panel: IDockviewPanel): string | undefined {
  return (panel.params as { sessionId?: string } | undefined)?.sessionId;
}

function isTerminalPanel(panel: IDockviewPanel): boolean {
  // Terminal panels get `panel-*` ids; SFTP/forward/transfer panels use their
  // own prefixes and must never be mistaken for a session's terminal.
  return panel.id.startsWith('panel-');
}

export function findPanelsForSession(api: DockviewApi, sessionId: string): IDockviewPanel[] {
  return api.panels.filter((panel) => sessionIdOf(panel) === sessionId);
}

export function findPanelForSession(
  api: DockviewApi,
  sessionId: string
): IDockviewPanel | undefined {
  return findPanelsForSession(api, sessionId)[0];
}

export function findTerminalPanelForSession(
  api: DockviewApi,
  sessionId: string
): IDockviewPanel | undefined {
  return api.panels.find((panel) => isTerminalPanel(panel) && sessionIdOf(panel) === sessionId);
}

export function openSessionPanel(
  api: DockviewApi,
  sessionId: string,
  options: OpenSessionOptions = {}
): IDockviewPanel | undefined {
  const store = useSessionStore.getState();
  const session = store.getSession(sessionId);
  if (!session) {
    return undefined;
  }

  if (!options.forceNew) {
    // Only a terminal panel counts as "the session is open": activating a
    // leftover SFTP panel instead of opening the terminal would make the
    // session impossible to open from the sidebar or palette.
    const existing = findTerminalPanelForSession(api, sessionId);
    if (existing) {
      existing.api.setActive();
      store.markUsed(sessionId);
      useWorkspaceStore.getState().setActiveSessionId(sessionId);
      return existing;
    }
  }

  const reference = options.referencePanelId ? api.getPanel(options.referencePanelId) : undefined;

  const panel = api.addPanel({
    id: newPanelId(),
    component: 'terminal',
    title: session.title,
    params: { sessionId },
    ...(reference && options.direction
      ? { position: { direction: options.direction, referencePanel: reference } }
      : {})
  });

  panel.api.setActive();
  store.markUsed(sessionId);
  store.setStatus(sessionId, session.kind === 'local' ? 'connected' : 'idle');
  useWorkspaceStore.getState().setActiveSessionId(sessionId);

  return panel;
}

export function splitSessionPanel(
  api: DockviewApi,
  sessionId: string,
  direction: SplitDirection,
  referencePanelId?: string
): IDockviewPanel | undefined {
  return openSessionPanel(api, sessionId, {
    forceNew: true,
    direction,
    referencePanelId
  });
}

export function duplicateSessionPanel(
  api: DockviewApi,
  sessionId: string,
  direction: SplitDirection = 'right',
  referencePanelId?: string
): IDockviewPanel | undefined {
  const store = useSessionStore.getState();
  const session = store.getSession(sessionId);
  if (!session) {
    return undefined;
  }

  const copy = store.addSession({
    ...toSessionDraft(session),
    title: tStatic('sessionAction.duplicateTitle', { name: session.title }),
    favorite: false
  });

  return openSessionPanel(api, copy.id, {
    forceNew: true,
    direction,
    referencePanelId
  });
}

export function reconnectSessionPanels(api: DockviewApi, sessionId: string): void {
  // Reconnect the terminal instance in place. Closing and recreating the
  // panel loses the live buffer and moves the tab to the end of the group.
  if (requestTerminalReconnect(sessionId)) {
    return;
  }

  const panels = findPanelsForSession(api, sessionId);
  if (panels.length > 0) {
    panels[0].api.setActive();
    return;
  }

  openSessionPanel(api, sessionId);
}

export function closeSessionPanels(api: DockviewApi, sessionId: string): void {
  findPanelsForSession(api, sessionId).forEach((panel) => panel.api.close());
}

export function closeOtherPanels(api: DockviewApi, keepPanelId: string): void {
  api.panels.filter((panel) => panel.id !== keepPanelId).forEach((panel) => panel.api.close());
}

export function openSftpPanel(api: DockviewApi, sessionId?: string): void {
  const targetSessionId = sessionId ?? useWorkspaceStore.getState().activeSessionId ?? undefined;
  const session = targetSessionId
    ? useSessionStore.getState().getSession(targetSessionId)
    : undefined;
  const panelId = targetSessionId ? `sftp-${targetSessionId}` : 'sftp-main';
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id: panelId,
    component: 'sftp',
    title: session ? tStatic('sessionAction.sftpPanelTitle', { name: session.title }) : 'SFTP',
    params: targetSessionId ? { sessionId: targetSessionId } : undefined
  });
}

export function openPortForwardPanel(api: DockviewApi, sessionId?: string): void {
  const targetSessionId = sessionId ?? useWorkspaceStore.getState().activeSessionId ?? undefined;
  const session = targetSessionId
    ? useSessionStore.getState().getSession(targetSessionId)
    : undefined;
  const panelId = targetSessionId ? `forwards-${targetSessionId}` : 'forwards-main';
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    return;
  }

  api.addPanel({
    id: panelId,
    component: 'forwards',
    title: session
      ? tStatic('sessionAction.portForwardPanelTitle', { name: session.title })
      : tStatic('sessionAction.portForwardPanel'),
    params: targetSessionId ? { sessionId: targetSessionId } : undefined
  });
}

export function openTransferPanel(api: DockviewApi): void {
  const panelId = 'transfers-main';
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id: panelId,
    component: 'transfers',
    title: tStatic('sessionAction.transferPanelTitle')
  });
}
