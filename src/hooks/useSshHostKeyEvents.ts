import { useEffect } from 'react';
import { openModalWindow } from '../lib/appWindows';
import { toast } from '../components/ui/toastStore';
import { tStatic } from '../i18n';
import {
  listenHostKeyMismatch,
  listenHostKeyPersistFailed,
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
      }),
      listenHostKeyPersistFailed((payload) => {
        // The accepted connection is fine; the user must know the next
        // connect will re-ask for this fingerprint instead of suspecting
        // a security problem.
        toast({
          title: tStatic('hostKey.persistFailedToastTitle', { host: payload.host }),
          description: tStatic('hostKey.persistFailedToastDesc'),
          variant: 'warning'
        });
      })
    ])
      .then(([disposePrompt, disposeMismatch, disposeTimeout, disposePersistFailed]) => {
        if (cancelled) {
          disposePrompt();
          disposeMismatch();
          disposeTimeout();
          disposePersistFailed();
        } else {
          disposers = [disposePrompt, disposeMismatch, disposeTimeout, disposePersistFailed];
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      disposers.forEach((dispose) => dispose());
    };
  }, []);
}
