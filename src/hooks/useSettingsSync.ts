import { useEffect } from 'react';
import { swallowListenError } from '../lib/eventListener';
import { listen } from '@tauri-apps/api/event';
import { useSettingsStore, type SettingsSnapshot } from '../stores/settingsStore';

interface SettingsAppliedPayload {
  settings: SettingsSnapshot;
}

export function useSettingsSync(): void {
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;

    listen<SettingsAppliedPayload>('nexterm-settings-applied', (event) => {
      useSettingsStore.getState().applySettings(event.payload.settings);
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
