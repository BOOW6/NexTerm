import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { swallowListenError } from '../lib/eventListener';
import { useMacroStore } from '../stores/macroStore';

interface MacrosChangedPayload {
  macros: unknown;
}

/**
 * Mirror macro edits made in the other window into this window's store
 * instance (which otherwise never re-reads the shared localStorage key).
 * Mounted in both the main window and the settings window: macros are
 * recorded from the command palette and removed from settings.
 */
export function useMacroSync(): void {
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;

    listen<MacrosChangedPayload>('nexterm-macros-changed', (event) => {
      useMacroStore.getState().replaceMacros(event.payload.macros);
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          dispose = unlisten;
        }
      })
      .catch(swallowListenError);

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
}
