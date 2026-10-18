import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useSettingsStore, type SettingsSnapshot } from '../stores/settingsStore';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';

interface SettingsAppliedPayload {
  settings: SettingsSnapshot;
  theme: ThemeMode;
}

export function useSettingsSync(): void {
  const { setMode } = useTheme();

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;

    listen<SettingsAppliedPayload>('nexterm-settings-applied', (event) => {
      useSettingsStore.getState().applySettings(event.payload.settings);
      setMode(event.payload.theme);
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          dispose = unlisten;
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [setMode]);
}
