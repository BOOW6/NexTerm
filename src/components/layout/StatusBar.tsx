import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { SESSION_KIND_LABEL_KEY, sessionSubtitle, type SessionStatus } from '../../types/session';
import { useI18n } from '../../i18n';
import { sessionStatusDot } from '../../lib/sessionVisuals';

const statusLabelKeys: Record<SessionStatus, string> = {
  idle: 'status.idle',
  connecting: 'status.connecting',
  connected: 'status.connected',
  error: 'status.error'
};

export default function StatusBar() {
  const { t } = useI18n();
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const session = useSessionStore((state) =>
    state.sessions.find((item) => item.id === activeSessionId)
  );

  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <footer className="app-statusbar flex h-6 shrink-0 items-center justify-between border-t border-border bg-surface-header px-2 text-[11px] text-muted">
      <div className="flex min-w-0 items-center gap-1.5">
        {session ? (
          <>
            <span
              className={cn('h-1.5 w-1.5 rounded-full', sessionStatusDot(session.status, true))}
            />
            <span className="truncate font-medium text-foreground">{session.title}</span>
            <span className="text-muted-foreground">·</span>
            <span>{t(SESSION_KIND_LABEL_KEY[session.kind])}</span>
            <span className="text-muted-foreground">·</span>
            <span className="truncate">{sessionSubtitle(session, t)}</span>
            <span className="text-muted-foreground">·</span>
            <span>{t(statusLabelKeys[session.status])}</span>
          </>
        ) : (
          <span>{t('status.noSession')}</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="tabular-nums">{clock.toLocaleTimeString('zh-CN', { hour12: false })}</span>
      </div>
    </footer>
  );
}
