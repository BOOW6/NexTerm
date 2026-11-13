import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { tStatic } from '../i18n';
import { toast } from '../components/ui/toastStore';

interface RemoteEditEvent {
  sessionId: string;
  remotePath: string;
  name: string;
  error?: string;
}

/** Toasts for the remote-edit watcher's automatic uploads. */
export function useRemoteEditEvents(): void {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void listen<RemoteEditEvent>('remote-edit-synced', (event) => {
      if (disposed) {
        return;
      }
      toast({
        title: tStatic('remoteEdit.syncedToast', { name: event.payload.name }),
        variant: 'success'
      });
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    void listen<RemoteEditEvent>('remote-edit-error', (event) => {
      if (disposed) {
        return;
      }
      toast({
        title: tStatic('remoteEdit.failedToast', { name: event.payload.name }),
        description: event.payload.error,
        variant: 'error'
      });
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    return () => {
      disposed = true;
      for (const unlisten of unlisteners.splice(0)) {
        unlisten();
      }
    };
  }, []);
}
