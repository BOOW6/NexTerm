import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { DockviewApi } from 'dockview-react';
import {
  closeSessionPanels,
  duplicateSessionPanel,
  findPanelForSession,
  openSessionPanel,
  openPortForwardPanel,
  openSftpPanel,
  openTransferPanel,
  reconnectSessionPanels,
  splitSessionPanel,
  type SplitDirection
} from './sessionActions';

interface WorkspaceContextValue {
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

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const apiRef = useRef<DockviewApi | null>(null);

  const setApi = useCallback((api: DockviewApi | null) => {
    apiRef.current = api;
  }, []);

  const getApi = useCallback(() => apiRef.current, []);

  const openSession = useCallback((sessionId: string) => {
    const api = apiRef.current;
    if (api) {
      openSessionPanel(api, sessionId);
    }
  }, []);

  const closeSessionPanel = useCallback((sessionId: string) => {
    const api = apiRef.current;
    if (api) {
      closeSessionPanels(api, sessionId);
    }
  }, []);

  const reconnectSession = useCallback((sessionId: string) => {
    const api = apiRef.current;
    if (api) {
      reconnectSessionPanels(api, sessionId);
    }
  }, []);

  const splitSession = useCallback(
    (sessionId: string, direction: SplitDirection, referencePanelId?: string) => {
      const api = apiRef.current;
      if (api) {
        splitSessionPanel(api, sessionId, direction, referencePanelId);
      }
    },
    []
  );

  const duplicateSession = useCallback((sessionId: string, referencePanelId?: string) => {
    const api = apiRef.current;
    if (api) {
      duplicateSessionPanel(api, sessionId, 'right', referencePanelId);
    }
  }, []);

  const openSftp = useCallback((sessionId?: string) => {
    const api = apiRef.current;
    if (api) {
      openSftpPanel(api, sessionId);
    }
  }, []);

  const openTransfers = useCallback(() => {
    const api = apiRef.current;
    if (api) {
      openTransferPanel(api);
    }
  }, []);

  const openForwards = useCallback((sessionId?: string) => {
    const api = apiRef.current;
    if (api) {
      openPortForwardPanel(api, sessionId);
    }
  }, []);

  const isSessionOpen = useCallback((sessionId: string) => {
    const api = apiRef.current;
    return api ? Boolean(findPanelForSession(api, sessionId)) : false;
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      setApi,
      getApi,
      openSession,
      closeSessionPanel,
      reconnectSession,
      splitSession,
      duplicateSession,
      openSftpPanel: openSftp,
      openPortForwardPanel: openForwards,
      openTransferPanel: openTransfers,
      isSessionOpen
    }),
    [
      setApi,
      getApi,
      openSession,
      closeSessionPanel,
      reconnectSession,
      splitSession,
      duplicateSession,
      openSftp,
      openForwards,
      openTransfers,
      isSessionOpen
    ]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}
