import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settingsStore';

/** Push tray/close behavior and the global show/hide hotkey to the backend
 * whenever the settings change (mirrors useSessionLogRootSync). */
export function useWindowBehaviorSync(): void {
  const closeToTray = useSettingsStore((state) => state.closeToTray);
  const globalShowHotkey = useSettingsStore((state) => state.globalShowHotkey);

  useEffect(() => {
    void invoke('set_window_behavior', {
      closeToTray,
      globalShowHotkey: globalShowHotkey || null
    }).catch(() => undefined);
  }, [closeToTray, globalShowHotkey]);
}
