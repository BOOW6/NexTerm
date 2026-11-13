import { useEffect } from 'react';
import { openModalWindow } from '../lib/appWindows';
import { toast } from '../components/ui/toastStore';
import { tStatic } from '../i18n';
import {
  listenHostKeyMismatch,
  listenHostKeyPrompt,
  listenHostKeyTimeout,
  respondHostKey
} from './useTauriSsh';

export function useSshHostKeyEvents(): void {
  useEffect(() => {
    let cancelled = false;
    let disposers: Array<() => void> = [];

    Promise.all([
      listenHostKeyPrompt((payload) => {
        void openModalWindow<boolean>('host-key', {
          title: tStatic('hostKey.window.promptTitle'),
          width: 520,
          height: 520,
          data: { mode: 'prompt', prompt: payload }
        }).then((accepted) => {
          void respondHostKey(payload.request_id, accepted === true).catch(() => undefined);
        });
      }),
      listenHostKeyMismatch((payload) => {
        void openModalWindow('host-key', {
          title: tStatic('hostKey.window.mismatchTitle'),
          width: 560,
          height: 540,
          data: { mode: 'mismatch', mismatch: payload }
        });
      }),
      listenHostKeyTimeout((payload) => {
        toast({
          title: tStatic('hostKey.timeoutToastTitle', { host: payload.host, port: payload.port }),
          description: tStatic('hostKey.timeoutToastDesc'),
          variant: 'warning'
        });
      })
    ])
      .then(([disposePrompt, disposeMismatch, disposeTimeout]) => {
        if (cancelled) {
          disposePrompt();
          disposeMismatch();
          disposeTimeout();
        } else {
          disposers = [disposePrompt, disposeMismatch, disposeTimeout];
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      disposers.forEach((dispose) => dispose());
    };
  }, []);
}
