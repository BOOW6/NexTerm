import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { Plus } from 'lucide-react';
import TerminalTab from '../terminal/TerminalTab';
import SessionTab from './SessionTab';
import { useWorkspace } from '../../features/workspace/WorkspaceContext';
import { openSessionPanel } from '../../features/workspace/sessionActions';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Button } from '../ui/button';
import { useQuickConnectLauncher } from '../../features/workspace/useQuickConnectLauncher';
import { useI18n } from '../../i18n';

const LAYOUT_KEY = 'nexterm.workspace.layout.v1';

const SFTPPanel = lazy(() => import('../sftp/SFTPPanel'));
const TransferPanel = lazy(() => import('../transfers/TransferPanel'));
const PortForwardPanel = lazy(() => import('../forward/PortForwardPanel'));

function PanelFallback() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted">加载中...</div>
  );
}

const components = {
  terminal: (props: IDockviewPanelProps) => <TerminalTab {...props} />,
  sftp: (props: IDockviewPanelProps) => (
    <Suspense fallback={<PanelFallback />}>
      <SFTPPanel {...props} />
    </Suspense>
  ),
  transfers: () => (
    <Suspense fallback={<PanelFallback />}>
      <TransferPanel />
    </Suspense>
  ),
  forwards: (props: IDockviewPanelProps) => (
    <Suspense fallback={<PanelFallback />}>
      <PortForwardPanel {...props} />
    </Suspense>
  )
};

interface Disposable {
  dispose: () => void;
}

function EmptyWorkspace() {
  const openQuickConnect = useQuickConnectLauncher();
  const { t } = useI18n();

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background p-6">
      <div className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-sm border border-border-strong bg-surface-elevated shadow-panel">
        <div className="app-dialog-header border-b border-border bg-panel-title px-3 py-2 text-xs font-semibold text-foreground">
          <span className="app-dialog-title">{t('app.workspaceTitle')}</span>
        </div>
        <div className="flex flex-col items-center px-4 py-5 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-sm border border-border bg-background-alt">
            <Plus className="h-5 w-5 text-muted" />
          </div>
          <h2 className="mt-3 text-xs font-semibold text-foreground">{t('app.workspaceTitle')}</h2>
          <p className="mt-1 text-[11px] text-muted">{t('app.workspaceHint')}</p>
          <Button
            size="sm"
            variant="primary"
            className="mt-4"
            onClick={() => void openQuickConnect({ kind: 'local' })}
          >
            <Plus className="h-3 w-3" />
            {t('app.newSession')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function DockLayout() {
  const { setApi } = useWorkspace();
  const disposablesRef = useRef<Disposable[]>([]);
  const persistTimerRef = useRef<number | null>(null);
  const [panelCount, setPanelCount] = useState(0);

  useEffect(() => {
    return () => {
      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
    };
  }, []);

  const persist = useCallback((api: DockviewApi) => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
      } catch (error) {
        console.warn('failed to persist workspace layout', error);
      }
    }, 250);
  }, []);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      setApi(api);

      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];

      const fallback = useSessionStore.getState().ensureDefaultSession();

      let restored = false;
      const saved = window.localStorage.getItem(LAYOUT_KEY);
      if (saved) {
        try {
          api.fromJSON(JSON.parse(saved));
          restored = true;
        } catch (error) {
          console.warn('failed to restore workspace layout', error);
        }
      }

      if (!restored || api.totalPanels === 0) {
        const sessions = useSessionStore.getState().sessions;
        const target = [...sessions].sort((a, b) => b.lastUsed - a.lastUsed)[0] ?? fallback;
        openSessionPanel(api, target.id);
      }

      setPanelCount(api.totalPanels);

      disposablesRef.current.push(
        api.onDidActivePanelChange((panel) => {
          const sessionId = (panel?.params as { sessionId?: string } | undefined)?.sessionId;
          useWorkspaceStore.getState().setActiveSessionId(sessionId ?? null);
        })
      );

      disposablesRef.current.push(api.onDidAddPanel(() => setPanelCount(api.totalPanels)));

      disposablesRef.current.push(
        api.onDidRemovePanel((panel) => {
          const sessionId = (panel.params as { sessionId?: string } | undefined)?.sessionId;
          if (sessionId) {
            const stillOpen = api.panels.some(
              (item) =>
                item.id !== panel.id &&
                (item.params as { sessionId?: string } | undefined)?.sessionId === sessionId
            );
            if (!stillOpen) {
              useSessionStore.getState().setStatus(sessionId, 'idle');
            }
          }
          if (api.totalPanels === 0) {
            useWorkspaceStore.getState().setActiveSessionId(null);
          }
          setPanelCount(api.totalPanels);
        })
      );

      disposablesRef.current.push(api.onDidLayoutChange(() => persist(api)));

      const activeSessionId = (api.activePanel?.params as { sessionId?: string } | undefined)
        ?.sessionId;
      if (activeSessionId) {
        useWorkspaceStore.getState().setActiveSessionId(activeSessionId);
      }

      persist(api);
    },
    [persist, setApi]
  );

  return (
    <div className="relative h-full w-full bg-background">
      <DockviewReact
        className="dockview-theme-dark h-full w-full"
        components={components}
        defaultTabComponent={SessionTab}
        defaultRenderer="always"
        onReady={onReady}
      />
      {panelCount === 0 ? <EmptyWorkspace /> : null}
    </div>
  );
}
