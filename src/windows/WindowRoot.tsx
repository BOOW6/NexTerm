import App from '../App';
import { currentWindowKind } from '../lib/appWindows';
import { useContextMenuPolicy } from '../hooks/useContextMenuPolicy';
import HostKeyWindow from './HostKeyWindow';
import PromptWindow from './PromptWindow';
import QuickConnectWindow from './QuickConnectWindow';
import SettingsWindow from './SettingsWindow';

export default function WindowRoot() {
  useContextMenuPolicy();

  switch (currentWindowKind()) {
    case 'settings':
      return <SettingsWindow />;
    case 'quick-connect':
      return <QuickConnectWindow />;
    case 'host-key':
      return <HostKeyWindow />;
    case 'prompt':
      return <PromptWindow />;
    default:
      return <App />;
  }
}
