import { useEffect } from 'react';
import { swallowListenError } from '../lib/eventListener';
import { listen } from '@tauri-apps/api/event';
import { useSnippetStore } from '../stores/snippetStore';

interface SnippetsChangedPayload {
  snippets: unknown;
}

/**
 * Mirror snippet edits made in the settings window into this window's store
 * instance (which otherwise never re-reads the shared localStorage key).
 */
export function useSnippetSync(): void {
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;

    listen<SnippetsChangedPayload>('nexterm-snippets-changed', (event) => {
      useSnippetStore.getState().replaceSnippets(event.payload.snippets);
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
