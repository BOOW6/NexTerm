import { useEffect } from 'react';
import { swallowListenError } from '../lib/eventListener';
import { listen } from '@tauri-apps/api/event';
import { useQuickConnectLauncher } from '../features/workspace/useQuickConnectLauncher';

/** Tray menu actions are forwarded here as events: the tray menu lives in
 * Rust, but session creation flows through the frontend launcher. */
export function useTrayActions(): void {
  const quickConnect = useQuickConnectLauncher();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen('tray-new-local', () => {
      void quickConnect({ kind: 'local' });
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch(swallowListenError);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [quickConnect]);
}
