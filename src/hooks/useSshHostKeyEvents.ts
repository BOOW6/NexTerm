import { useEffect } from 'react';
import { openModalWindow } from '../lib/appWindows';
import { listenHostKeyMismatch, listenHostKeyPrompt, respondHostKey } from './useTauriSsh';

export function useSshHostKeyEvents(): void {
  useEffect(() => {
    let cancelled = false;
    let disposers: Array<() => void> = [];

    Promise.all([
      listenHostKeyPrompt((payload) => {
        void openModalWindow<boolean>('host-key', {
          title: '未知主机密钥',
          width: 520,
          height: 520,
          data: { mode: 'prompt', prompt: payload }
        }).then((accepted) => {
          void respondHostKey(payload.request_id, accepted === true).catch(() => undefined);
        });
      }),
      listenHostKeyMismatch((payload) => {
        void openModalWindow('host-key', {
          title: '主机密钥不匹配',
          width: 560,
          height: 540,
          data: { mode: 'mismatch', mismatch: payload }
        });
      })
    ])
      .then(([disposePrompt, disposeMismatch]) => {
        if (cancelled) {
          disposePrompt();
          disposeMismatch();
        } else {
          disposers = [disposePrompt, disposeMismatch];
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      disposers.forEach((dispose) => dispose());
    };
  }, []);
}
