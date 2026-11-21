import { useEffect } from 'react';
import { swallowListenError } from '../lib/eventListener';
import { listenSftpProgress, listenSftpTransferDone } from './useTauriSsh';
import { useTransferStore } from '../stores/transferStore';

/**
 * Subscribes to global SFTP transfer events once and feeds the transfer store.
 * Safe to mount in the browser (listen rejects without Tauri and is ignored).
 */
export function useSftpTransferEvents(): void {
  useEffect(() => {
    let cancelled = false;
    let disposers: Array<() => void> = [];

    Promise.all([
      listenSftpProgress((payload) => useTransferStore.getState().applyProgress(payload)),
      listenSftpTransferDone((payload) => useTransferStore.getState().finish(payload))
    ])
      .then(([disposeProgress, disposeDone]) => {
        if (cancelled) {
          disposeProgress();
          disposeDone();
        } else {
          disposers = [disposeProgress, disposeDone];
        }
      })
      .catch(swallowListenError);

    return () => {
      cancelled = true;
      disposers.forEach((dispose) => dispose());
    };
  }, []);
}
