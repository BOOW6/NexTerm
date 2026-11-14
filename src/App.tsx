import TitleBar from './components/layout/TitleBar';
import DockLayout from './components/layout/DockLayout';
import StatusBar from './components/layout/StatusBar';
import SessionSidebar from './components/sessions/SessionSidebar';
import CommandPalette from './components/command/CommandPalette';
import { Toaster } from './components/ui/toast';
import { WorkspaceProvider } from './features/workspace/WorkspaceContext';
import { useSftpConflictEvents } from './hooks/useSftpConflictEvents';
import { useSftpTransferEvents } from './hooks/useSftpTransferEvents';
import { useSshHostKeyEvents } from './hooks/useSshHostKeyEvents';
import { useRemoteEditEvents } from './hooks/useRemoteEditEvents';
import { useZmodemEvents } from './hooks/useZmodemEvents';
import { useWindowBehaviorSync } from './hooks/useWindowBehaviorSync';
import { useTrayActions } from './hooks/useTrayActions';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { useSettingsSync } from './hooks/useSettingsSync';
import { useSessionLogRootSync } from './hooks/useSessionLogRootSync';
import { useSnippetSync } from './hooks/useSnippetSync';
import { useWindowState } from './hooks/useWindowState';
import { useWindowTitle } from './hooks/useWindowTitle';
import { useVaultEvents } from './hooks/useVaultEvents';
import { useWorkspaceStore } from './stores/workspaceStore';

function AppShell() {
  useSftpTransferEvents();
  useSftpConflictEvents();
  useSshHostKeyEvents();
  useRemoteEditEvents();
  useZmodemEvents();
  useWindowBehaviorSync();
  useTrayActions();
  useGlobalShortcuts();
  useSettingsSync();
  useSnippetSync();
  useSessionLogRootSync();
  useVaultEvents();
  useWindowState();
  useWindowTitle();

  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible);

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {sidebarVisible ? <SessionSidebar /> : null}
        <main className="min-w-0 flex-1 overflow-hidden">
          <DockLayout />
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      <Toaster />
    </div>
  );
}

export default function App() {
  return (
    <WorkspaceProvider>
      <AppShell />
    </WorkspaceProvider>
  );
}
