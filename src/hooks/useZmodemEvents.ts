import { useEffect } from 'react';
import { swallowListenError } from '../lib/eventListener';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { tStatic } from '../i18n';
import { toast } from '../components/ui/toastStore';
import { confirmAction } from '../lib/appWindows';

interface ZmodemStartPayload {
  sessionId: string;
  name: string;
  size: number;
}

interface ZmodemReceiveRequestPayload {
  requestId: string;
  sessionId: string;
}

/** Toast when a ZMODEM receive starts, so the frozen terminal is explained.
 * In receive-confirm mode this also answers the backend's prompt dialog:
 * requests are processed one at a time so the modal cannot stack. */
export function useZmodemEvents(): void {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    // Serializes confirm dialogs: the backend can have several pending
    // prompts (one per session), the modal handles one at a time.
    let respondChain: Promise<void> = Promise.resolve();

    const answerRequest = (payload: ZmodemReceiveRequestPayload): void => {
      respondChain = respondChain.then(async () => {
        const accept = await confirmAction(tStatic('zmodem.receiveConfirm'), {
          title: tStatic('zmodem.receiveConfirmTitle'),
          okLabel: tStatic('zmodem.receiveConfirmAccept')
        });
        if (disposed) {
          return;
        }
        await invoke('zmodem_receive_response', {
          requestId: payload.requestId,
          accept
        }).catch(swallowListenError);
      });
    };

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

    void listen<ZmodemReceiveRequestPayload>('zmodem-receive-request', (event) => {
      if (disposed) {
        return;
      }
      answerRequest(event.payload);
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
