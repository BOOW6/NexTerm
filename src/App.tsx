import TitleBar from './components/layout/TitleBar';
import DockLayout from './components/layout/DockLayout';
import StatusBar from './components/layout/StatusBar';
import SessionSidebar from './components/sessions/SessionSidebar';
import CommandPalette from './components/command/CommandPalette';
import { Toaster } from './components/ui/toast';
import { WorkspaceProvider } from './features/workspace/WorkspaceContext';
import { useSftpTransferEvents } from './hooks/useSftpTransferEvents';
import { useSshHostKeyEvents } from './hooks/useSshHostKeyEvents';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { useSettingsSync } from './hooks/useSettingsSync';
import { useWindowState } from './hooks/useWindowState';
import { useWindowTitle } from './hooks/useWindowTitle';
import { useWorkspaceStore } from './stores/workspaceStore';

function AppShell() {
  useSftpTransferEvents();
  useSshHostKeyEvents();
  useGlobalShortcuts();
  useSettingsSync();
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
