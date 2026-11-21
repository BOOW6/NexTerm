import { useEffect } from 'react';
import { swallowListenError } from '../lib/eventListener';
import { listen } from '@tauri-apps/api/event';
import { tStatic } from '../i18n';
import { toast } from '../components/ui/toastStore';

interface ZmodemStartPayload {
  sessionId: string;
  name: string;
  size: number;
}

/** Toast when a ZMODEM receive starts, so the frozen terminal is explained. */
export function useZmodemEvents(): void {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void listen<ZmodemStartPayload>('zmodem-start', (event) => {
      if (disposed) {
        return;
      }
      toast({
        title: tStatic('zmodem.startToast', { name: event.payload.name }),
        variant: 'success'
      });
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlisteners.push(unlisten);
        }
      })
      .catch(swallowListenError);

    return () => {
      disposed = true;
      for (const unlisten of unlisteners.splice(0)) {
        unlisten();
      }
    };
  }, []);
}
