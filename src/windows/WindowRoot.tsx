import { lazy, Suspense } from 'react';
import { useDocumentLang, useI18n } from '../i18n';
import { currentWindowKind } from '../lib/appWindows';
import { useContextMenuPolicy } from '../hooks/useContextMenuPolicy';
import { useUiFont } from '../hooks/useUiFont';

const App = lazy(() => import('../App'));
const HostKeyWindow = lazy(() => import('./HostKeyWindow'));
const PromptWindow = lazy(() => import('./PromptWindow'));
const QuickConnectWindow = lazy(() => import('./QuickConnectWindow'));
const SettingsWindow = lazy(() => import('./SettingsWindow'));
const SftpConflictWindow = lazy(() => import('./SftpConflictWindow'));

function WindowFallback() {
  const { t } = useI18n();
  return (
    <div className="flex h-full w-full items-center justify-center bg-background text-xs text-muted">
      {t('ui.loading')}
    </div>
  );
}

export default function WindowRoot() {
  useContextMenuPolicy();
  useUiFont();
  useDocumentLang();

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
      case 'sftp-conflict':
        return <SftpConflictWindow />;
      default:
        return <App />;
    }
  };

  return <Suspense fallback={<WindowFallback />}>{renderWindow()}</Suspense>;
}
