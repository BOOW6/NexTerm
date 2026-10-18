import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSessionStore } from '../stores/sessionStore';
import { useWorkspaceStore } from '../stores/workspaceStore';

export function useWindowTitle(): void {
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const title = useSessionStore((state) =>
    state.sessions.find((session) => session.id === activeSessionId)?.title
  );

  useEffect(() => {
    void getCurrentWindow()
      .setTitle(title ? `${title} — NexTerm` : 'NexTerm')
      .catch(() => undefined);
  }, [title]);
}
