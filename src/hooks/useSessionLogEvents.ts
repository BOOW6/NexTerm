import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { tStatic } from '../i18n';
import { toast } from '../components/ui/toastStore';

interface SessionLogErrorPayload {
  sessionId: string;
  error: string;
}

/**
 * The backend reports a session log that stopped recording (open or write
 * failure) exactly once per sink; without this toast the user would keep
 * believing their terminal output is being captured.
 */
export function useSessionLogEvents(): void {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void listen<SessionLogErrorPayload>('session-log-error', (event) => {
      if (disposed) {
        return;
      }
      toast({
        title: tStatic('terminal.sessionLogFailed'),
        description: event.payload.error,
        variant: 'error'
      });
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlisteners.push(unlisten);
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      for (const unlisten of unlisteners.splice(0)) {
        unlisten();
      }
    };
  }, []);
}
