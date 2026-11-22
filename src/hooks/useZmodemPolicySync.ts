import { useEffect } from 'react';
import { swallowListenError } from '../lib/eventListener';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Mirror the "ZMODEM auto receive" toggle into the backend: the SSH read
 * loops consult it live when a batch starts (auto receive vs. asking).
 */
export function useZmodemPolicySync(): void {
  const zmodemAutoReceive = useSettingsStore((state) => state.zmodemAutoReceive);

  useEffect(() => {
    void invoke('set_zmodem_auto_receive', { enabled: zmodemAutoReceive }).catch(
      swallowListenError
    );
  }, [zmodemAutoReceive]);
}
