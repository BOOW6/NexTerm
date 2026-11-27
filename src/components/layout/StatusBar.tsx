import { cn } from '../../lib/cn';
import { useSessionStore } from '../../stores/sessionStore';
import { useBroadcastStore } from '../../stores/broadcastStore';
import { useMacroRecorderStore } from '../../stores/macroStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { SESSION_KIND_LABEL_KEY, sessionSubtitle } from '../../types/session';
import { useI18n } from '../../i18n';
import { SESSION_STATUS_LABEL_KEY, sessionStatusDot } from '../../lib/sessionVisuals';

export default function StatusBar() {
  const { t } = useI18n();
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const broadcastIds = useBroadcastStore((state) => state.ids);
  const macroRecording = useMacroRecorderStore((state) => state.recording);
  const session = useSessionStore((state) =>
    state.sessions.find((item) => item.id === activeSessionId)
  );

  const sessions = useSessionStore((state) => state.sessions);
  const liveBroadcastCount = broadcastIds.filter((id) =>
    sessions.some((session) => session.id === id)
  ).length;

  return (
    <footer className="app-statusbar flex h-6 shrink-0 items-center justify-between border-t border-border bg-surface-header px-2 text-meta text-muted">
      <div className="flex min-w-0 items-center gap-1.5">
        {session ? (
          <>
            <span
              className={cn('h-1.5 w-1.5 rounded-full', sessionStatusDot(session.status, true))}
            />
            <span
              className="truncate font-medium text-foreground"
              title={`${t(SESSION_KIND_LABEL_KEY[session.kind])} - ${sessionSubtitle(session, t)}`}
            >
              {session.title}
            </span>
            <span className="text-muted-foreground">|</span>
            <span>{t(SESSION_STATUS_LABEL_KEY[session.status])}</span>
          </>
        ) : (
          <span>{t('status.noSession')}</span>
        )}
        {macroRecording ? (
          <span className="ml-2 shrink-0 rounded-sm bg-error/10 px-1.5 py-0.5 font-medium text-error">
            {t('status.recordingBadge')}
          </span>
        ) : null}
        {liveBroadcastCount >= 2 ? (
          <button
            type="button"
            onClick={() => useBroadcastStore.getState().clear()}
            className="ml-2 shrink-0 rounded-sm bg-accent/10 px-1.5 py-0.5 font-medium text-accent transition-colors hover:bg-accent/20"
            title={t('status.broadcastHint')}
          >
            {t('status.broadcast', { count: liveBroadcastCount })}
          </button>
        ) : null}
      </div>
    </footer>
  );
}
