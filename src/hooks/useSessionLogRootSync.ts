import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Mirror the configured session-log directory into the backend so it can
 * confine every log_path that crosses IPC (the backend rejects paths outside
 * this root).
 */
export function useSessionLogRootSync(): void {
  const sessionLogEnabled = useSettingsStore((state) => state.sessionLogEnabled);
  const sessionLogDir = useSettingsStore((state) => state.sessionLogDir);

  useEffect(() => {
    void invoke('set_session_log_root', {
      dir: sessionLogEnabled ? sessionLogDir : null
    }).catch(() => undefined);
  }, [sessionLogEnabled, sessionLogDir]);
}
