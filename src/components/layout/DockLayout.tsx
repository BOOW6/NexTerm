import { useCallback } from 'react';
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import TerminalTab from '../terminal/TerminalTab';
import SFTPPanel from '../sftp/SFTPPanel';

const components = {
  terminal: (props: IDockviewPanelProps) => <TerminalTab {...props} />,
  sftp: () => <SFTPPanel />
};

export default function DockLayout() {
  const onReady = useCallback((event: DockviewReadyEvent) => {
    const terminalPanel = event.api.addPanel({
      id: 'terminal-main',
      component: 'terminal',
      title: 'Terminal'
    });

    event.api.addPanel({
      id: 'sftp-sidebar',
      component: 'sftp',
      title: 'SFTP',
      position: {
        direction: 'left',
        referencePanel: terminalPanel
      }
    });
  }, []);

  return <DockviewReact className="h-full w-full" components={components} onReady={onReady} />;
}
