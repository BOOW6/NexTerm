import { lazy, Suspense } from 'react';
import { currentWindowKind } from '../lib/appWindows';
import { useContextMenuPolicy } from '../hooks/useContextMenuPolicy';

const App = lazy(() => import('../App'));
const HostKeyWindow = lazy(() => import('./HostKeyWindow'));
const PromptWindow = lazy(() => import('./PromptWindow'));
const QuickConnectWindow = lazy(() => import('./QuickConnectWindow'));
const SettingsWindow = lazy(() => import('./SettingsWindow'));

function WindowFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background text-xs text-muted">
      加载中...
    </div>
  );
}

export default function WindowRoot() {
  useContextMenuPolicy();

  const renderWindow = () => {
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
  };

  return <Suspense fallback={<WindowFallback />}>{renderWindow()}</Suspense>;
}
