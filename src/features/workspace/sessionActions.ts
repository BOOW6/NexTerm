import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

export type SplitDirection = 'right' | 'below';

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

export function findPanelsForSession(api: DockviewApi, sessionId: string): IDockviewPanel[] {
  return api.panels.filter((panel) => sessionIdOf(panel) === sessionId);
}

export function findPanelForSession(
  api: DockviewApi,
  sessionId: string
): IDockviewPanel | undefined {
  return findPanelsForSession(api, sessionId)[0];
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
    const existing = findPanelForSession(api, sessionId);
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
    kind: session.kind,
    title: `${session.title} 副本`,
    host: session.host,
    port: session.port,
    username: session.username,
    authMethod: session.authMethod,
    keyPath: session.keyPath,
    group: session.group,
    favorite: false
  });

  return openSessionPanel(api, copy.id, {
    forceNew: true,
    direction,
    referencePanelId
  });
}

export function reconnectSessionPanels(api: DockviewApi, sessionId: string): void {
  const panels = findPanelsForSession(api, sessionId);
  if (panels.length === 0) {
    openSessionPanel(api, sessionId);
    return;
  }

  panels.forEach((panel) => panel.api.close());
  window.setTimeout(() => {
    openSessionPanel(api, sessionId, { forceNew: true });
  }, 0);
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
    title: session ? `SFTP · ${session.title}` : 'SFTP',
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
    title: session ? `端口转发 · ${session.title}` : '端口转发',
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
    title: '传输队列'
  });
}
