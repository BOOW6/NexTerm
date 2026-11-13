import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { Settings2, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useSessionStore } from '../../stores/sessionStore';
import {
  closeOtherPanels,
  duplicateSessionPanel,
  openPortForwardPanel,
  reconnectSessionPanels,
  splitSessionPanel
} from '../../features/workspace/sessionActions';
import { showNativeContextMenu } from '../../lib/appWindows';
import { useBroadcastStore, broadcastCount } from '../../stores/broadcastStore';
import { toast } from '../ui/toastStore';
import { SESSION_KIND_ICON, sessionStatusDot } from '../../lib/sessionVisuals';
import { useI18n } from '../../i18n';

export default function SessionTab({ api, params, containerApi }: IDockviewPanelHeaderProps) {
  const { t } = useI18n();
  const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
  const session = useSessionStore((state) =>
    sessionId ? state.sessions.find((item) => item.id === sessionId) : undefined
  );

  const title = session?.title ?? api.title ?? t('tab.panel');
  const Icon = session ? SESSION_KIND_ICON[session.kind] : Settings2;

  const handleContextMenu = () => {
    const actions: Array<{
      label: string;
      separatorBefore?: boolean;
      run?: () => void;
    }> = [];

    if (sessionId) {
      actions.push(
        {
          label: t('tab.splitRight'),
          run: () => splitSessionPanel(containerApi, sessionId, 'right', api.id)
        },
        {
          label: t('tab.splitBelow'),
          run: () => splitSessionPanel(containerApi, sessionId, 'below', api.id)
        },
        {
          label: t('tab.duplicateSession'),
          run: () => duplicateSessionPanel(containerApi, sessionId, 'right', api.id)
        }
      );

      if (session && session.kind !== 'local') {
        actions.push({
          label: t('tab.portForward'),
          run: () => openPortForwardPanel(containerApi, sessionId)
        });
      }

      actions.push({
        label: t('tab.reconnect'),
        run: () => reconnectSessionPanels(containerApi, sessionId)
      });

      if (session) {
        const joined = useBroadcastStore.getState().ids.includes(sessionId);
        actions.push({
          label: joined ? t('tab.broadcastLeave') : t('tab.broadcastJoin'),
          run: () => {
            const nowJoined = useBroadcastStore.getState().toggle(sessionId);
            const count = broadcastCount();
            toast({
              title: nowJoined ? t('broadcast.joinToast', { count }) : t('broadcast.leaveToast'),
              variant: 'success'
            });
          }
        });
      }
    }

    actions.push(
      {
        label: t('tab.closeOtherTabs'),
        separatorBefore: true,
        run: () => closeOtherPanels(containerApi, api.id)
      },
      { label: t('tab.closeTab'), run: () => api.close() }
    );

    void showNativeContextMenu(
      actions.map((item) => ({
        label: item.label,
        separatorBefore: item.separatorBefore
      }))
    ).then((index) => {
      if (index !== null) {
        actions[index]?.run?.();
      }
    });
  };

  return (
    <div
      data-native-context-menu
      onContextMenu={(event) => {
        event.preventDefault();
        handleContextMenu();
      }}
      className="group flex h-full w-full items-center gap-1.5 px-2"
    >
      {session ? (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', sessionStatusDot(session.status))}
        />
      ) : null}
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-xs">{title}</span>
      <button
        type="button"
        aria-label={t('tab.closeTab')}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          api.close();
        }}
        className="rounded-sm p-0.5 text-muted opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
