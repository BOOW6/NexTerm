import { createContext, useContext } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { SplitDirection } from './sessionActions';

export interface WorkspaceContextValue {
  setApi: (api: DockviewApi | null) => void;
  getApi: () => DockviewApi | null;
  openSession: (sessionId: string) => void;
  closeSessionPanel: (sessionId: string) => void;
  reconnectSession: (sessionId: string) => void;
  splitSession: (sessionId: string, direction: SplitDirection, referencePanelId?: string) => void;
  duplicateSession: (sessionId: string, referencePanelId?: string) => void;
  openSftpPanel: (sessionId?: string) => void;
  openPortForwardPanel: (sessionId?: string) => void;
  openTransferPanel: () => void;
  isSessionOpen: (sessionId: string) => boolean;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}
